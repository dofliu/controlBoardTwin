/* DofLab — 上傳燒錄（「程式」頁的「上傳到板子」，以及「觀測」頁的「上傳 DofLabFirmata」）
 * Uno：瀏覽器直接透過 Web Serial 以 STK500 協定寫入（stk500.js），或由編譯服務呼叫 arduino-cli upload（avrdude）。
 * ESP32：由編譯服務呼叫 arduino-cli upload（esptool）。
 * Raspberry Pi：透過 pi_bridge 部署 main.py 並執行，可以停止。
 * 上傳會覆蓋板上的程式：一律先列出條件與後果，使用者逐項勾選後才執行。
 */
(function (root) {
  const DL = root.DL; const P = DL.ui.App.prototype;
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // 工具輸出太長：只取看起來是錯誤的最後幾行
  function rawTail(raw) { const all = String(raw || '').split('\n'); const bad = all.filter(l => /error|錯誤|failed|not found|無法|timeout|timed out/i.test(l)); return (bad.length ? bad.slice(-3) : all.slice(-3)).join(' ／ ').slice(0, 400); }
  P.upInit = function () { this.up = { busy: false, log: [], prog: null, ports: null, port: '', confirm: null, checks: {}, last: null, pi: { ws: null, running: null, lines: [] } }; };

  // 可以用哪些方式上傳
  P.upMethods = function () {
    const b = this.p.board.type;
    if (b === 'pi4b') return [{ id: 'pi', label: '部署到樹莓派（pi_bridge）' }];
    const m = [];
    if (b === 'uno') m.push({ id: 'browser', label: '用瀏覽器上傳（USB）', avail: !!(navigator.serial), why: '這個瀏覽器不支援 Web Serial（請用電腦版 Chrome 或 Edge）' });
    m.push({ id: 'server', label: '用編譯服務上傳（arduino-cli）' });
    return m;
  };

  // 上傳前的條件：程式存在、與目前配置一致、編譯成功、沒有其他連線佔用板子
  P.upRequirements = function (method) {
    const p = this.p; const cs = this.codeState(); const bs = this.buildState(); const code = p.code.text || '';
    const req = [];
    req.push({ ok: !!code.trim(), text: '已經產生（或貼上）程式' });
    req.push({ ok: cs.state !== 'stale', text: cs.state === 'stale' ? '程式是依照舊的配置或行為產生的：請重新產生' : cs.state === 'manual' ? '程式有手動修改（會照目前的內容上傳）' : '程式與目前的配置、行為一致' });
    req.push({ ok: bs.state === 'ok', text: bs.state === 'ok' ? '目前的程式編譯成功' : '目前的程式還沒有編譯成功：請先按「編譯」' });
    if (method === 'browser') { const a = this.lastArtifacts; req.push({ ok: !!(a && a.codeHash === DL.hash(code) && a.board === p.board.type && a.artifacts && a.artifacts.kind === 'hex'), text: '有這份程式編譯出的 .hex（重新整理頁面後需要再編譯一次）' }); }
    req.push({ ok: this.twin.conn.state !== 'connected', text: this.twin.conn.state === 'connected' ? '「觀測」頁正連著這塊板子：請先中斷連線（同一個連接埠不能同時使用）' : '「觀測」頁沒有佔用這塊板子' });
    return { req, ok: req.every(r => r.ok) };
  };

  P.upConfirmItems = function (method, what) {
    const p = this.p; const board = DL.boards[p.board.type]; const items = [];
    if (method === 'pi') items.push({ id: 'over', text: '程式會在樹莓派上直接控制 GPIO，直到按「停止」；關掉這個網頁後它仍會繼續執行。' });
    else items.push({ id: 'over', text: what === 'firmata' ? `會把 ${board.short} 上原本的程式換成 DofLabFirmata（觀測頁同步用的韌體）。` : `上傳會覆蓋 ${board.short} 上原本的程式（包括 DofLabFirmata）；之後要在「觀測」頁同步，需要重新上傳 DofLabFirmata。` });
    items.push({ id: 'board', text: `接上的確實是 ${board.name}，實體接線已依畫面核對（包括共地）。` });
    if (p.components.some(c => c.type === 'SERVO')) items.push({ id: 'power', text: '伺服由合適的電源供電，機構周圍沒有手或障礙物；程式一開始執行就可能轉動。' });
    return items;
  };

  P.upLog = function (msg, kind) { this.up.log.push({ t: new Date().toLocaleTimeString(), msg, kind: kind || '' }); if (this.up.log.length > 60) this.up.log.shift(); this.renderUpload(); };

  P.renderUpload = function () {
    const el = $('uploadBody'); if (!el || !this.p) return;
    if (!this.up) this.upInit();
    const p = this.p; const board = DL.boards[p.board.type]; const up = this.up; const methods = this.upMethods();
    if (!up.method || !methods.some(m => m.id === up.method)) up.method = methods.find(m => m.avail !== false).id;
    const R = this.upRequirements(up.method);
    const mSel = methods.length > 1 ? `<div class="grp seg" role="group" aria-label="上傳方式">${methods.map(m => `<button data-upm="${m.id}" aria-pressed="${up.method === m.id}" ${m.avail === false ? `disabled title="${esc(m.why)}"` : ''}>${esc(m.label)}</button>`).join('')}</div>` : `<p class="hint">${esc(methods[0].label)}</p>`;
    let target = '';
    if (up.method === 'server') {
      const ports = up.ports;
      target = `<div class="row"><select class="inp mono" id="upPort" aria-label="序列埠" style="flex:1 1 180px">${ports && ports.length ? ports.map(x => `<option value="${esc(x.address)}" ${x.address === up.port ? 'selected' : ''}>${esc(x.address)}${x.boards && x.boards.length ? '（' + esc(x.boards.map(b => b.name).join('、')) + '）' : x.label ? '（' + esc(x.label) + '）' : ''}</option>`).join('') : `<option value="">${ports ? '找不到序列埠：請接上板子後重新整理' : '按「重新整理」列出序列埠'}</option>`}</select><button class="btn" id="upPorts" ${up.busy ? 'disabled' : ''}>重新整理</button></div>
        <p class="hint">由編譯服務所在的電腦上傳：${p.board.type === 'esp32' ? 'ESP32 用 esptool；若沒有自動進入下載模式，上傳開始時按住板子上的 BOOT 鍵。' : 'Uno 用 avrdude。'}</p>`;
    } else if (up.method === 'browser') target = '<p class="hint">按下後選擇 Uno 的連接埠。瀏覽器會讓板子重置進入開機程式（Optiboot），寫入後逐頁讀回比對。</p>';
    else target = `<div class="row"><input class="inp mono" id="upWs" value="${esc(this.upWsUrl())}" aria-label="樹莓派閘道網址" style="flex:1 1 200px"></div><p class="hint">程式存成樹莓派上的 ~/doflab-deploy/main.py 並執行；輸出會顯示在下面。</p>`;
    const reqHtml = `<ul class="issues">${R.req.map(r => `<li class="${r.ok ? 'info' : 'warn'}"><span class="lv ${r.ok ? 'ok' : 'warn'}">${r.ok ? '已符合' : '未符合'}</span><span>${esc(r.text)}</span></li>`).join('')}</ul>`;
    let action;
    if (up.confirm) {
      const items = this.upConfirmItems(up.confirm.method, up.confirm.what);
      const all = items.every(i => up.checks[i.id]);
      action = `<div class="inline-confirm" role="alertdialog" aria-label="上傳前確認"><b>${up.confirm.what === 'firmata' ? '上傳 DofLabFirmata' : up.confirm.method === 'pi' ? '部署到樹莓派' : '上傳到 ' + esc(board.short)}前請逐項確認</b>${items.map(i => `<label class="check"><input type="checkbox" data-upchk="${i.id}" ${up.checks[i.id] ? 'checked' : ''}><span>${esc(i.text)}</span></label>`).join('')}
        <div class="row"><button class="btn primary" id="upGo" ${all ? '' : 'disabled'}>${up.confirm.method === 'pi' ? '部署並執行' : '開始上傳'}</button><button class="btn" id="upCancel">取消</button></div></div>`;
    } else if (up.method === 'pi' && up.pi.running) action = `<div class="row"><span class="badge ok">執行中 · PID ${up.pi.running.pid}</span><button class="btn danger" id="upStop">停止</button></div>`;
    else action = `<div class="row"><button class="btn primary" id="upStart" ${R.ok && !up.busy ? '' : 'disabled'}>${up.busy ? '進行中…' : up.method === 'pi' ? '部署到樹莓派' : '上傳到板子'}</button></div>`;
    const pr = up.prog ? `<div class="upprog" role="progressbar" aria-valuemin="0" aria-valuemax="${up.prog.total}" aria-valuenow="${up.prog.done}"><i style="width:${(100 * up.prog.done / up.prog.total).toFixed(1)}%"></i><span>${up.prog.phase === 'verify' ? '讀回比對' : '寫入'} ${up.prog.done}／${up.prog.total} 頁</span></div>` : '';
    const lines = up.method === 'pi' && up.pi.lines.length ? `<pre class="raw" id="upOut">${esc(up.pi.lines.slice(-30).join('\n'))}</pre>` : '';
    const log = up.log.length ? `<ul class="uplog">${up.log.slice(-8).map(l => `<li class="${l.kind}"><span class="mono">${esc(l.t)}</span> ${esc(l.msg)}</li>`).join('')}</ul>` : '';
    const last = up.last ? `<p class="hint" style="color:var(--ok)">${esc(up.last)}</p>` : '';
    el.innerHTML = mSel + target + reqHtml + action + pr + last + log + lines;
    el.querySelectorAll('[data-upm]').forEach(b => b.onclick = () => { up.method = b.dataset.upm; up.confirm = null; this.renderUpload(); });
    const bp = $('upPorts'); if (bp) bp.onclick = () => this.upListPorts();
    const ps = $('upPort'); if (ps) ps.onchange = () => { up.port = ps.value; };
    const ws = $('upWs'); if (ws) ws.onchange = () => { try { localStorage.setItem('doflab.wsUrl', ws.value.trim()); } catch (e) { } };
    const st = $('upStart'); if (st) st.onclick = () => { up.confirm = { method: up.method, what: 'program' }; up.checks = {}; this.renderUpload(); };
    el.querySelectorAll('[data-upchk]').forEach(cb => cb.onchange = () => { up.checks[cb.dataset.upchk] = cb.checked; this.renderUpload(); });
    const cc = $('upCancel'); if (cc) cc.onclick = () => { up.confirm = null; this.renderUpload(); };
    const go = $('upGo'); if (go) go.onclick = () => { const c = up.confirm; up.confirm = null; this.upRun(c.method, c.what); };
    const sp = $('upStop'); if (sp) sp.onclick = () => this.piStop();
  };

  P.upWsUrl = function () { try { const s = localStorage.getItem('doflab.wsUrl'); if (s) return s; } catch (e) { } return location.protocol === 'http:' && location.host && location.port !== '8766' ? `ws://${location.host}/ws` : 'ws://raspberrypi.local:8765/ws'; };
  P.compileBase = function () { const el = $('compileUrl'); return ((el && el.value.trim()) || this.defaultCompileUrl()).replace(/\/$/, ''); };

  P.upListPorts = async function () {
    const up = this.up;
    try { const r = await (await fetch(this.compileBase() + '/api/ports')).json(); up.ports = r.ports || []; if (!up.port && up.ports[0]) up.port = up.ports[0].address; if (!r.ok && r.raw) this.upLog('列出序列埠失敗：' + r.raw.slice(0, 200), 'e'); }
    catch (e) { up.ports = []; this.upLog(`連不到編譯服務：${e.message}`, 'e'); }
    this.renderUpload();
  };

  // 執行上傳；what = 'program'（目前的程式）或 'firmata'（觀測頁用的韌體）
  P.upRun = async function (method, what) {
    const p = this.p; const up = this.up; const board = DL.boards[p.board.type];
    if (up.busy) return;
    if (what !== 'firmata') { const R = this.upRequirements(method); if (!R.ok) { this.toast(R.req.find(r => !r.ok).text, 'e'); return; } }
    up.busy = true; up.prog = null; up.last = null; this.renderUpload(); if (what === 'firmata') this.renderHw();
    const code = what === 'firmata' ? DL.firmware.ino : p.code.text;
    try {
      if (method === 'browser') {
        const hex = what === 'firmata' ? DL.firmware.unoHex : this.lastArtifacts.artifacts.hex;
        let port;
        try { port = await navigator.serial.requestPort({}); } catch (e) { throw new Error('沒有選擇連接埠，已取消。'); }
        this.upLog('開始上傳（瀏覽器，STK500）');
        const r = await DL.stk500.flash(port, hex, { log: m => this.upLog(m), onProgress: pr => { up.prog = pr; this.renderUpload(); } });
        up.last = `已上傳到 ${board.short}：${r.bytes} 位元組，${r.verified ? '讀回比對一致' : '未比對'}，${(r.ms / 1000).toFixed(1)} 秒。`;
      } else if (method === 'server') {
        if (!up.port) await this.upListPorts();
        if (!up.port) throw new Error('沒有可用的序列埠。');
        this.upLog(`開始上傳（編譯服務，${up.port}）：先編譯再上傳，可能需要一分鐘`);
        const r = await (await fetch(this.compileBase() + '/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ board: p.board.type, code, port: up.port, confirm: true }) })).json();
        if (!r.ok) { up.lastRaw = r.raw; const stage = r.stage === 'compile' ? '編譯失敗' : r.stage === 'port' ? '連接埠不正確' : '上傳失敗'; throw new Error(stage + '（結束碼 ' + r.exitCode + '）：' + rawTail(r.raw)); }
        up.last = `已由編譯服務上傳到 ${up.port}（${r.fqbn}，${(r.durationMs / 1000).toFixed(1)} 秒，含讀回比對）。`;
      } else if (method === 'pi') await this.piDeploy(code);
      if (up.last) { this.upLog(up.last, 'ok'); this.log('s', up.last); this.toast(up.last); }
      if (what === 'firmata' && method !== 'pi') this.hw.firmataFlashed = true;
    } catch (e) {
      this.upLog(e.message, 'e'); this.log('e', '上傳失敗：' + e.message); this.toast(e.message, 'e');
    } finally { up.busy = false; up.prog = null; this.renderUpload(); if (what === 'firmata') this.renderHw(); }
  };

  /* ---------- 樹莓派部署 ---------- */
  P.piDeploy = function (code) {
    const up = this.up; const url = ($('upWs') && $('upWs').value.trim()) || this.upWsUrl();
    const pins = Object.values(this.analysis.bindings).map(b => b.num).filter(n => n != null);
    return new Promise((resolve, reject) => {
      let ws; try { ws = new WebSocket(url); } catch (e) { reject(new Error('閘道網址不正確：' + e.message)); return; }
      const t = setTimeout(() => { try { ws.close(); } catch (e) { } reject(new Error(`連不到樹莓派閘道 ${url}`)); }, 6000);
      ws.onopen = () => { ws.send(JSON.stringify({ op: 'hello', client: 'doflab-deploy', proto: 2 })); };
      ws.onerror = () => { };
      ws.onclose = () => { if (up.pi.ws === ws) { up.pi.ws = null; this.renderUpload(); } };
      ws.onmessage = ev => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.op === 'hello') {
          if (!m.deploy) { clearTimeout(t); ws.close(); reject(new Error('這個 pi_bridge 版本不支援部署，請更新 pi_bridge.py')); return; }
          ws.send(JSON.stringify({ op: 'deploy', id: 'd' + Date.now(), code, pins, confirm: true }));
        } else if (m.op === 'deployed') { clearTimeout(t); up.pi.ws = ws; up.pi.running = m; up.pi.lines = [`$ python3 ${m.path}`]; up.last = `已部署到樹莓派並開始執行（${m.bytes} 位元組，PID ${m.pid}）。`; resolve(m); }
        else if (m.op === 'error') { clearTimeout(t); if (!up.pi.running) { ws.close(); reject(new Error(m.message)); } else { up.pi.lines.push('錯誤：' + m.message); this.renderUpload(); } }
        else if (m.op === 'proc') { up.pi.lines.push((m.stream === 'err' ? '! ' : '') + m.line); if (up.pi.lines.length > 200) up.pi.lines.shift(); this.renderUpload(); }
        else if (m.op === 'proc_exit') { up.pi.lines.push(`（程式結束：${m.reason === 'stopped' ? '已停止' : '結束碼 ' + m.code}）`); up.pi.running = null; this.upLog(m.reason === 'stopped' ? '樹莓派上的程式已停止' : `樹莓派上的程式結束（結束碼 ${m.code}）`, m.reason === 'stopped' || m.code === 0 ? '' : 'e'); try { ws.close(); } catch (e) { } }
      };
    });
  };
  P.piStop = function () { const ws = this.up.pi.ws; if (ws && ws.readyState === 1) ws.send(JSON.stringify({ op: 'stop' })); else { this.up.pi.running = null; this.renderUpload(); } };

  /* ---------- 觀測頁：上傳 DofLabFirmata ---------- */
  P.firmataFlashHtml = function () {
    const t = this.p.board.type; if (t === 'pi4b') return '';
    if (!this.up) this.upInit();
    const up = this.up;
    if (up.confirm && up.confirm.what === 'firmata') {
      const items = this.upConfirmItems(up.confirm.method, 'firmata'); const all = items.every(i => up.checks[i.id]);
      return `<div class="inline-confirm" role="alertdialog">${items.map(i => `<label class="check"><input type="checkbox" data-fwchk="${i.id}" ${up.checks[i.id] ? 'checked' : ''}><span>${esc(i.text)}</span></label>`).join('')}<div class="row"><button class="btn primary" id="fwGo" ${all ? '' : 'disabled'}>上傳 DofLabFirmata</button><button class="btn" id="fwCancel">取消</button></div></div>`;
    }
    const m = t === 'uno' && navigator.serial ? 'browser' : 'server';
    return `<div class="row"><button class="btn" id="fwFlash" data-m="${m}" ${up.busy ? 'disabled' : ''}>${up.busy ? '上傳中…' : `上傳 DofLabFirmata${m === 'server' ? '（用編譯服務）' : '（USB）'}`}</button>${up.prog ? `<span class="muted">${up.prog.phase === 'verify' ? '比對' : '寫入'} ${up.prog.done}／${up.prog.total}</span>` : ''}</div>${this.hw.firmataFlashed ? '<span class="hint" style="color:var(--ok)">DofLabFirmata 已上傳，可以連線了。</span>' : ''}`;
  };
  P.bindFirmataFlash = function () {
    const up = this.up; if (!up) return;
    const b = $('fwFlash'); if (b) b.onclick = () => { if (this.p.board.type !== 'uno' && b.dataset.m === 'server' && !up.port) this.upListPorts(); up.confirm = { method: b.dataset.m, what: 'firmata' }; up.checks = {}; this.renderHw(); };
    document.querySelectorAll('[data-fwchk]').forEach(cb => cb.onchange = () => { up.checks[cb.dataset.fwchk] = cb.checked; this.renderHw(); });
    const c = $('fwCancel'); if (c) c.onclick = () => { up.confirm = null; this.renderHw(); };
    const g = $('fwGo'); if (g) g.onclick = async () => { const cf = up.confirm; up.confirm = null; if (cf.method === 'server' && !up.port) await this.upListPorts(); this.upRun(cf.method, 'firmata'); };
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
