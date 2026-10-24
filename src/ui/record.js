/* DofLab — 連線紀錄的錄製、匯出與重播（雲端虛擬硬體第 5 階段）
 * 錄製：每次連上設備（實體或虛擬）就開始一份新的紀錄，記下量測、模擬算出的輸出、命令與回讀、模式、執行／暫停；中斷後保留。
 * 匯出：下載成 JSON（DL.session 的格式）。
 * 時間有兩種：t＝從連線開始的實際時間（ms）；st＝模擬時間（ms，只在「▶ 執行」時前進）。
 *       畫面很慢時（一幀超過 1 秒）模擬時間會被截斷、和實際時間對不上，所以重播用 st：紀錄「這一毫秒引擎實際收到的輸入」（input），
 *       重播時在同一個模擬毫秒送進同一個值，算出的輸出應該逐毫秒相同。
 * 重播：在模擬模式下照紀錄的模擬時間重送輸入，重新算出的輸出和紀錄比對，結果寫進事件紀錄。重播不連設備、不送任何命令。手臂專案本版不支援重播。
 */
(function (root) {
  const DL = root.DL; const P = DL.ui.App.prototype;
  const $ = id => document.getElementById(id);
  const SUF = { BTN: '.pressed', BOOT: '.pressed', TOUCH: '.pressed', LDR: '.level', LED: '.state', OBLED: '.state', SERVO: '.angle', US: '.distance' };   // 與 observe.js 的訊號名稱相同
  const sigOf = c => SUF[c.type] ? c.id + SUF[c.type] : null;

  /* ---------- 錄製 ---------- */
  P.recStart = function (r) {
    const p = this.p; const now = performance.now();
    const rec = DL.session.create({ project: { name: p.name, board: p.board.type }, device: { deviceId: this.twin.conn.deviceId, info: this.twin.conn.info, virtual: !!this.twin.conn.virtual } });
    rec.simAtStart = this.sim.time;   // 連線前模擬已經跑過：引擎的狀態（例如切換過的 LED）不是初始狀態，重播從初始狀態開始
    this.hw.rec = rec; this.hw.recWall0 = now; this.hw.recSim0 = this.sim.time; this.hw.recLast = {}; this.hw.recLastIn = {};
    DL.session.push(rec, { t: 0, type: 'run', v: !!this.sim.running });
    this.renderRec();
  };
  const recT = (app, wall) => Math.round(((wall === undefined ? performance.now() : wall) - app.hw.recWall0) * 10) / 10;
  P.recActive = function () { return !!(this.hw.rec && this.hw.rec.live !== false && this.twin.conn.state === 'connected'); };
  // 孿生事件：量測、命令、回讀、模式、重新開機、中斷
  P.recTwin = function (e) {
    const rec = this.hw.rec; if (!rec || rec.live === false) return;
    const t = recT(this);
    if (e.type === 'measure') DL.session.push(rec, { t, type: 'measure', name: e.name, v: e.v });
    else if (e.type === 'command') DL.session.push(rec, { t, type: 'command', name: e.name, v: e.v, id: e.id });
    else if (e.type === 'ack') DL.session.push(rec, { t, type: 'ack', name: e.name, v: e.v, id: e.id });
    else if (e.type === 'mode') DL.session.push(rec, { t, type: 'mode', from: e.from, to: e.to, why: e.why });
    else if (e.type === 'reboot') DL.session.push(rec, { t, type: 'reboot', why: e.reason });
    else if (e.type === 'disconnected') { DL.session.push(rec, { t, type: 'disconnected', why: e.reason }); rec.live = false; rec.durationMs = t; this.renderRec(); }
  };
  P.recRun = function () { if (this.recActive()) DL.session.push(this.hw.rec, { t: recT(this), type: 'run', v: !!this.sim.running }); };
  // 引擎在模擬時間 st 實際收到的輸入（只記變化）；raw：光敏的 ADC 原始值（重播時原樣送進引擎）
  P.recIn = function (name, v, raw, st, wall) {
    if (!this.recActive()) return;
    const k = this.hw.recLastIn[name]; if (k && k.v === v && k.raw === raw) return; this.hw.recLastIn[name] = { v, raw };
    const e = { t: recT(this, wall), st: st - this.hw.recSim0, type: 'input', name, v }; if (raw !== undefined) e.raw = raw;
    DL.session.push(this.hw.rec, e);
  };
  // 模擬算出的輸出（真機模式下每一毫秒都算；只記變化）。wall：這一毫秒對應的實際時間；st：模擬時間
  P.recOut = function (name, v, wall, st) {
    if (this.replay) { const rp = this.replay; if (rp.last[name] !== v) { rp.last[name] = v; rp.events.push({ t: Math.round((wall - rp.wall0) * 10) / 10, st, type: 'sim', name, v }); } return; }
    if (!this.recActive() || this.twin.mode === 'sim') return;
    if (this.hw.recLast[name] === v) return; this.hw.recLast[name] = v;
    DL.session.push(this.hw.rec, { t: recT(this, wall), st: st - this.hw.recSim0, type: 'sim', name, v });
  };

  /* ---------- 匯出 ---------- */
  P.recExport = function () {
    const rec = this.hw.rec; if (!rec) { this.toast('還沒有連線紀錄：連上設備（實體或虛擬）之後才會開始記錄。', 'e'); return; }
    // 依實際時間排序（模擬的輸入與輸出記的是那一毫秒對應的時間，可能比同一幀稍晚記下的命令早）
    const out = Object.assign({}, rec, { events: rec.events.slice().sort((a, b) => a.t - b.t), exportedAt: new Date().toISOString(), log: (this.events || []).slice(0, 300) }); delete out.live;
    const text = JSON.stringify(out, null, 1);
    this.lastRecJson = text;
    try {
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      a.download = `doflab-紀錄-${(rec.project && rec.project.name || 'project').replace(/[\\/:*?"<>|\s]+/g, '_')}-${rec.startedAt.slice(0, 19).replace(/[:T]/g, '')}.json`;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      this.log('s', `已匯出連線紀錄（${rec.events.length} 筆事件${rec.device && rec.device.virtual ? '；虛擬設備' : ''}）`);
    } catch (e) { this.toast('下載失敗（預覽中可能不允許下載）：' + e.message, 'e'); }
  };

  /* ---------- 重播 ---------- */
  P.replayStart = function (rec) {
    if (this.twin.mode !== 'sim' || this.twin.conn.state === 'connected') { this.toast('重播只能在模擬模式：請先中斷真機連線。', 'e'); return false; }
    if (this.p.arm) { this.toast('手臂專案的重播本版未包含。', 'e'); return false; }
    const known = this.p.components.map(sigOf).filter(Boolean);
    const issues = DL.session.check(rec, this.p, known);
    const err = issues.find(i => i.level === 'error'); if (err) { this.toast(err.msg, 'e'); return false; }
    for (const i of issues) this.log('w', '重播：' + i.msg);
    const inputs = rec.events.filter(e => e.type === 'input' && typeof e.st === 'number').sort((a, b) => a.st - b.st);
    if (!inputs.length) { this.toast('紀錄裡沒有引擎的輸入（可能整段都沒有按「▶ 執行」），無法重播。', 'e'); return false; }
    if (this.sim.running) this.toggleRun();
    this.resetSim(); this.sim.speed = 1; const sp = $('simSpeed'); if (sp) sp.value = '1';
    const lastSt = Math.max(...rec.events.filter(e => typeof e.st === 'number').map(e => e.st));
    this.replay = { rec, inputs, i: 0, cur: {}, wall0: performance.now(), events: [], last: {}, end: lastSt + 500 };
    this.log('s', `開始重播連線紀錄（${rec.startedAt.slice(0, 19).replace('T', ' ')}，${rec.device && rec.device.virtual ? '虛擬設備' : '實體設備'}，模擬時間 ${(lastSt / 1000).toFixed(1)} 秒，${inputs.length} 次輸入變化）：只在模擬中重算，不連設備、不送命令`);
    this.toggleRun();
    if (!this.sim.running) { this.replay = null; return false; }
    this.renderRec(); return true;
  };
  // 模擬的每一毫秒：把到時間的輸入放進目前的值（advance 呼叫）
  P.replayApply = function (st) {
    const rp = this.replay; const ins = rp.inputs;
    while (rp.i < ins.length && ins[rp.i].st <= st) { const e = ins[rp.i++]; rp.cur[e.name] = { v: e.v, raw: e.raw }; }
    return rp.cur;
  };
  // 每一幀：進度與結束（模擬時間超過紀錄的最後一筆＋0.5 秒）
  P.replayFrame = function (now) {
    const rp = this.replay;
    if (this.sim.time > rp.end) { this.replayFinish(); return; }
    if (!this._lastRp || now - this._lastRp > 250) { this._lastRp = now; const st = $('recStatus'); if (st) st.textContent = `重播中：模擬時間 ${(Math.min(this.sim.time, rp.end - 500) / 1000).toFixed(1)}／${((rp.end - 500) / 1000).toFixed(1)} 秒（不連設備、不送命令）`; }
  };
  P.replayFinish = function (why) {
    const rp = this.replay; if (!rp) return;
    this.replay = null; if (this.sim.running) this.toggleRun();
    if (why) { this.log('w', '重播已停止：' + why); this.renderRec(); return; }
    const r = DL.session.compare(rp.rec, rp.events); this.replayResult = r;
    const msg = '重播完成：' + DL.session.summary(r);
    this.log(r.ok ? 's' : 'e', msg); this.toast(msg, r.ok ? undefined : 'e');
    this.renderRec();
  };
  P.replayFile = function (file) {
    const fr = new FileReader();
    fr.onload = () => { const x = DL.session.parse(String(fr.result)); if (!x.ok) { this.toast('無法重播：' + x.msg, 'e'); this.log('e', '無法重播：' + x.msg); return; } this.replayStart(x.rec); };
    fr.readAsText(file);
  };

  P.renderRec = function () {
    const ex = $('recExport'), rp = $('recReplay'), st = $('recStatus'); if (!ex) return;
    const rec = this.hw && this.hw.rec; const live = this.recActive();
    ex.disabled = !rec; rp.textContent = this.replay ? '停止重播' : '重播剛才的紀錄'; rp.disabled = !this.replay && (!rec || live);
    if (st && !this.replay) st.textContent = rec ? `${live ? '記錄中' : '上次連線的紀錄'}：${rec.events.length} 筆事件${rec.device && rec.device.virtual ? '（虛擬設備）' : ''}${this.replayResult ? ' · 上次重播：' + (this.replayResult.ok ? '一致' : '有差異') : ''}` : '連上設備後會自動記錄這次連線（量測、輸出、命令、回讀），之後可以匯出或重播。';
  };
  P.bindRec = function () {
    const ex = $('recExport'), rp = $('recReplay'), fi = $('recFile'), fo = $('recOpen'); if (!ex) return;
    ex.onclick = () => this.recExport();
    rp.onclick = () => { if (this.replay) this.replayFinish('使用者停止'); else if (this.hw.rec) this.replayStart(this.hw.rec); };
    fo.onclick = () => fi.click();
    fi.onchange = () => { if (fi.files && fi.files[0]) this.replayFile(fi.files[0]); fi.value = ''; };
    this.renderRec();
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
