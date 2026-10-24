/* DofLab — 連線紀錄（雲端虛擬硬體第 5 階段）：一次真機或虛擬設備連線的結構化紀錄，可以匯出成 JSON、之後重播。
 * 紀錄的內容：量測、引擎實際收到的輸入（input）、模擬算出的輸出（sim）、送出的命令與回讀、模式變化、執行／暫停、重新開機與中斷。
 * 時間：t＝從連線開始的實際時間（ms）；input 與 sim 另有 st＝模擬時間（ms）。畫面很慢時兩者會對不上，重播與比對用 st。
 * 重播：把紀錄裡的輸入照原本的模擬時間送進模擬，重新算一次輸出，和紀錄裡的輸出、命令比對（不連任何設備、不送任何命令）。
 * 這個檔案只處理資料格式與比對，瀏覽器與 Node 共用；錄製與重播的畫面在 src/ui/record.js。
 */
(function (root) {
  const DL = root.DL = root.DL || {};
  const FORMAT = 'doflab-session', VERSION = 1, MAX_EVENTS = 50000;
  const TYPES = ['measure', 'input', 'sim', 'command', 'ack', 'mode', 'run', 'reboot', 'disconnected', 'presence'];

  function create(meta) {
    meta = meta || {};
    return { format: FORMAT, version: VERSION, startedAt: meta.startedAt || new Date().toISOString(), project: meta.project || null, device: meta.device || null, events: [], truncated: false };
  }
  function push(rec, e) { if (rec.events.length >= MAX_EVENTS) { rec.truncated = true; return; } rec.events.push(e); }

  // 讀入 JSON：格式、版本、事件都要對；錯誤給看得懂的說明
  function parse(text) {
    let rec; try { rec = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) { return { ok: false, msg: '不是 JSON 檔：' + e.message }; }
    if (!rec || rec.format !== FORMAT) return { ok: false, msg: '這不是 DofLab 的連線紀錄（format 不是 doflab-session）。' };
    if (rec.version !== VERSION) return { ok: false, msg: `連線紀錄的版本 ${rec.version} 不支援（需要 ${VERSION}）。` };
    if (!Array.isArray(rec.events)) return { ok: false, msg: '連線紀錄沒有事件清單。' };
    let last = -Infinity;
    for (const [i, e] of rec.events.entries()) {
      if (!e || typeof e.t !== 'number' || !Number.isFinite(e.t) || !TYPES.includes(e.type)) return { ok: false, msg: `第 ${i + 1} 筆事件格式不正確。` };
      if (e.t < last) return { ok: false, msg: `第 ${i + 1} 筆事件的時間比前一筆早（紀錄損壞）。` };
      last = e.t;
    }
    return { ok: true, rec };
  }
  // 和目前的專案比較：板型不同不能重播；紀錄裡的訊號不在專案裡只是警告
  function check(rec, project, signals) {
    const issues = [];
    if (rec.project && rec.project.board && project && rec.project.board !== project.board.type) issues.push({ level: 'error', msg: `紀錄是 ${rec.project.board} 的，目前的專案是 ${project.board.type}，不能重播。` });
    const names = new Set(rec.events.filter(e => e.type === 'measure' || e.type === 'sim').map(e => e.name));
    const missing = [...names].filter(n => signals && !signals.includes(n));
    if (missing.length) issues.push({ level: 'warn', msg: `紀錄裡有目前專案沒有的訊號：${missing.join('、')}（重播時略過）。` });
    if (rec.truncated) issues.push({ level: 'warn', msg: `紀錄超過 ${MAX_EVENTS} 筆，後面的事件沒有記下來。` });
    if (rec.simAtStart > 0) issues.push({ level: 'warn', msg: `連線前模擬已經執行過 ${(rec.simAtStart / 1000).toFixed(1)} 秒，當時的狀態（例如切換過的 LED）沒有記下來；重播從初始狀態開始，結果可能不同。` });
    if (!rec.events.some(e => e.type === 'measure')) issues.push({ level: 'warn', msg: '紀錄裡沒有量測，重播時模擬不會收到任何輸入。' });
    return issues;
  }
  // 依訊號整理成「值的序列」：連續相同的值合併（只看變化）
  function series(events, type) {
    const out = {};
    for (const e of events) { if (e.type !== type) continue; const a = out[e.name] = out[e.name] || []; if (!a.length || a[a.length - 1].v !== e.v) a.push({ t: e.t, st: e.st, v: e.v }); }
    return out;
  }
  // 比對：紀錄裡模擬算出的輸出 vs 重播時算出的輸出（值的序列要完全相同），以及紀錄裡送出的命令是否依序出現在重播的輸出中
  // 時刻的比較：兩邊都有模擬時間（st）時必須逐毫秒相同（引擎是確定的：同樣的輸入、同樣的毫秒，就是同樣的輸出）；
  // 只有實際時間時（例如別的工具產生的紀錄）容許 tolMs
  function compare(rec, replayEvents, tolMs) {
    tolMs = tolMs === undefined ? 150 : tolMs;
    const a = series(rec.events, 'sim'), b = series(replayEvents, 'sim');
    const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    const signals = names.map(name => {
      const x = a[name] || [], y = b[name] || [];
      let worstMs = 0, firstDiff = -1;
      for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if (!x[i] || !y[i] || x[i].v !== y[i].v) { firstDiff = i; break; }
        const sim = typeof x[i].st === 'number' && typeof y[i].st === 'number';
        const d = sim ? Math.abs(x[i].st - y[i].st) : Math.abs(x[i].t - y[i].t); worstMs = Math.max(worstMs, d);
        if (d > (sim ? 0 : tolMs)) { firstDiff = i; break; }
      }
      const sim = x.length > 0 && x.every(p => typeof p.st === 'number') && y.every(p => typeof p.st === 'number');
      return { name, recorded: x.length, replayed: y.length, same: firstDiff < 0, worstMs: Math.round(worstMs), firstDiff, tolMs: sim ? 0 : tolMs, basis: sim ? 'sim' : 'wall' };
    });
    const cmds = rec.events.filter(e => e.type === 'command');
    let matched = 0;
    const byName = {}; for (const c of cmds) (byName[c.name] = byName[c.name] || []).push(c);
    for (const [name, list] of Object.entries(byName)) {
      const ys = (b[name] || []).map(p => p.v); let k = 0;
      for (const c of list) { while (k < ys.length && ys[k] !== c.v) k++; if (k < ys.length) { matched++; k++; } }
    }
    return { ok: signals.every(s => s.same) && matched === cmds.length, signals, commands: { total: cmds.length, matched } };
  }
  function summary(r) {
    if (!r.signals.length) return '紀錄裡沒有模擬的輸出（可能整段都沒有按「▶ 執行」）。';
    const bad = r.signals.filter(s => !s.same);
    const head = bad.length ? `有 ${bad.length} 個輸出和紀錄不同：${bad.map(s => `${s.name}（紀錄 ${s.recorded} 次變化、重播 ${s.replayed} 次，第 ${s.firstDiff + 1} 次起值或時刻（容許 ${s.tolMs} ms）不同）`).join('、')}` : `${r.signals.length} 個輸出的變化和紀錄完全相同（${r.signals.map(s => `${s.name} ${s.recorded} 次`).join('、')}；${r.signals.every(s => s.basis === 'sim') ? '逐毫秒相同（模擬時間）' : `時刻最大相差 ${Math.max(...r.signals.map(s => s.worstMs))} ms`}）`;
    return head + `；紀錄中送出的 ${r.commands.total} 個命令，${r.commands.matched} 個依序出現在重播的輸出中。`;
  }

  DL.session = { FORMAT, VERSION, MAX_EVENTS, create, push, parse, check, series, compare, summary };
  if (typeof module !== 'undefined') module.exports = DL;
})(typeof globalThis !== 'undefined' ? globalThis : this);
