/* DofLab — 上傳燒錄（「程式」頁的「上傳到板子」，以及「觀測」頁的「上傳 DofLabFirmata」）
 * Uno：瀏覽器直接透過 Web Serial 以 STK500 協定寫入（stk500.js），或由編譯服務呼叫 arduino-cli upload（avrdude）。
 * 虛擬 Uno（第 4 階段）：同一個 STK500 上傳經 WebSocket 送到虛擬設備主機的虛擬 Optiboot；上傳後開序列埠監看，Serial.println 的文字經網路送回。
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
  P.upInit = function () { this.up = { busy: false, log: [], prog: null, ports: null, port: '', confirm: null, checks: {}, last: null, pi: { ws: null, running: null, lines: [] }, vmon: null }; };

  // 可以用哪些方式上傳
  P.upMethods = function () {
    const b = this.p.board.type;
    if (b === 'pi4b') return [{ id: 'pi', label: '部署到樹莓派（pi_bridge）' }];
    const m = [];
    if (b === 'uno') m.push({ id: 'browser', label: '用瀏覽器上傳（USB）', avail: !!(navigator.serial), why: '這個瀏覽器不支援 Web Serial（請用電腦版 Chrome 或 Edge）' });
    m.push({ id: 'server', label: '用編譯服務上傳（arduino-cli）' });
    if (b === 'uno') m.push({ id: 'virtual', label: '上傳到虛擬 Uno（網路）', avail: typeof WebSocket !== 'undefined', why: '這個環境沒有 WebSocket' });
    return m;
  };

  // 上傳前的條件：程式存在、與目前配置一致、編譯成功、沒有其他連線佔用板子
  P.upRequirements = function (method) {
    const p = this.p; const cs = this.codeState(); const bs = this.buildState(); const code = p.code.text || '';
    const req = [];
    req.push({ ok: !!code.trim(), text: '已經產生（或貼上）程式' });
    req.push({ ok: cs.state !== 'stale', text: cs.state === 'stale' ? '程式是依照舊的配置或行為產生的：請重新產生' : cs.state === 'manual' ? '程式有手動修改（會照目前的內容上傳）' : '程式與目前的配置、行為一致' });
    req.push({ ok: bs.state === 'ok', text: bs.state === 'ok' ? '目前的程式編譯成功' : '目前的程式還沒有編譯成功：請先按「編譯」' });
    if (method === 'browser' || method === 'virtual') { const a = this.lastArtifacts; req.push({ ok: !!(a && a.codeHash === DL.hash(code) && a.board === p.board.type && a.artifacts && a.artifacts.kind === 'hex'), text: '有這份程式編譯出的 .hex（重新整理頁面後需要再編譯一次）' }); }
    req.push({ ok: true, text: this.twin.conn.state === 'connected' && method !== 'pi' ? '「觀測」頁正連著這塊板子：上傳前會自動中斷連線（同一個連接埠不能同時使用）' : '「觀測」頁沒有佔用這塊板子' });
    if (method === 'virtual') req.push({ ok: true, text: '虛擬設備主機要在執行（npm run vdev）；這是虛擬設備，不是實體板子' });
    return { req, ok: req.every(r => r.ok) };
  };

  P.upConfirmItems = function (method, what) {
    const p = this.p; const board = DL.boards[p.board.type]; const items = [];
    if (method === 'pi') items.push({ id: 'over', text: '程式會在樹莓派上直接控制 GPIO，直到按「停止」；關掉這個網頁後它仍會繼續執行。' });
    else if (method === 'virtual') {
      items.push({ id: 'over', text: what === 'firmata' ? '會把虛擬 Uno 上原本的程式換成 DofLabFirmata（觀測頁同步用的韌體）。' : '上傳會覆蓋虛擬 Uno 上原本的程式（包括 DofLabFirmata）；之後要在「觀測」頁同步，需要重新上傳 DofLabFirmata。' });
      items.push({ id: 'board', text: '目標是虛擬設備（avr8js 模擬的 ATmega328P），不是實體板子；在這裡正常不代表實體板子也正常。' });
      return items;
    }
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
        <p class="hint">由編譯服務所在的電腦上傳：${DL.boardFamily(p.board.type) === 'esp32' ? 'ESP32 用 esptool；若沒有自動進入下載模式，上傳開始時按住板子上的 BOOT 鍵。' : 'Uno 用 avrdude。'}</p>`;
    } else if (up.method === 'virtual') target = `<div class="row"><input class="inp mono" id="upVdev" value="${esc(this.vdevUrl())}" aria-label="虛擬設備網址" style="flex:1 1 200px"></div><p class="hint">經網路把 STK500 位元組送到虛擬設備主機；虛擬晶片跑 Arduino 官方的 Optiboot，和實體 Uno 一樣先重置、逐頁寫入、讀回比對。<b>虛擬設備，不是實體板子。</b></p>`;
    else if (up.method === 'browser') target = '<p class="hint">按下後選擇 Uno 的連接埠。瀏覽器會讓板子重置進入開機程式（Optiboot），寫入後逐頁讀回比對。</p>';
    else target = `<div class="row"><input class="inp mono" id="upWs" value="${esc(this.upWsUrl())}" aria-label="樹莓派閘道網址" style="flex:1 1 200px"></div><p class="hint">程式存成樹莓派上的 ~/doflab-deploy/main.py 並執行；輸出會顯示在下面。</p>`;
    const reqHtml = `<ul class="issues">${R.req.map(r => `<li class="${r.ok ? 'info' : 'warn'}"><span class="lv ${r.ok ? 'ok' : 'warn'}">${r.ok ? '已符合' : '未符合'}</span><span>${esc(r.text)}</span></li>`).join('')}</ul>`;
    let action;
    if (up.confirm) {
      const items = this.upConfirmItems(up.confirm.method, up.confirm.what);
      const all = items.every(i => up.checks[i.id]);
      action = `<div class="inline-confirm" role="alertdialog" aria-label="上傳前確認"><b>${up.confirm.what === 'firmata' ? '上傳 DofLabFirmata' : up.confirm.method === 'pi' ? '部署到樹莓派' : '上傳到 ' + esc(board.short)}前請逐項確認</b>${items.map(i => `<label class="check"><input type="checkbox" data-upchk="${i.id}" ${up.checks[i.id] ? 'checked' : ''}><span>${esc(i.text)}</span></label>`).join('')}
        <div class="row"><button class="btn primary" id="upGo" ${all ? '' : 'disabled'}>${up.confirm.method === 'pi' ? '部署並執行' : '開始上傳'}</button><button class="btn" id="upCancel">取消</button></div></div>`;
    } else if (up.method === 'pi' && up.pi.running) action = `<div class="row"><span class="badge ok">執行中 · PID ${up.pi.running.pid}</span><button class="btn danger" id="upStop">停止</button></div>`;
    else action = `<div class="row"><button class="btn primary" id="upStart" ${R.ok && !up.busy ? '' : 'disabled'}>${up.busy ? '進行中…' : up.method === 'pi' ? '部署到樹莓派' : up.method === 'virtual' ? '上傳到虛擬 Uno' : '上傳到板子'}</button></div>`;
    const pr = up.prog ? `<div class="upprog" role="progressbar" aria-valuemin="0" aria-valuemax="${up.prog.total}" aria-valuenow="${up.prog.done}"><i style="width:${(100 * up.prog.done / up.prog.total).toFixed(1)}%"></i><span>${up.prog.phase === 'verify' ? '讀回比對' : '寫入'} ${up.prog.done}／${up.prog.total} 頁</span></div>` : '';
    const lines = up.method === 'pi' && up.pi.lines.length ? `<pre class="raw" id="upOut">${esc(up.pi.lines.slice(-30).join('\n'))}</pre>` : '';
    const log = up.log.length ? `<ul class="uplog">${up.log.slice(-8).map(l => `<li class="${l.kind}"><span class="mono">${esc(l.t)}</span> ${esc(l.msg)}</li>`).join('')}</ul>` : '';
    const last = up.last ? `<p class="hint" style="color:var(--ok)">${esc(up.last)}</p>` : '';
    // 沒有編譯服務時：複製程式到 Arduino IDE 上傳（Arduino IDE 的板子名稱）
    const ideBoard = { uno: 'Arduino Uno', esp32: 'ESP32 Dev Module', esp32doit: 'DOIT ESP32 DEVKIT V1' }[p.board.type];
    const ide = ideBoard ? `<details class="hint" style="margin-top:8px"><summary>沒有編譯服務？用 Arduino IDE 上傳</summary><ol style="margin:6px 0 0 18px;padding:0"><li>按「複製程式」，在 Arduino IDE 開新檔案貼上。</li><li>工具 → 開發板選「${esc(ideBoard)}」${DL.boardFamily(p.board.type) === 'esp32' ? '（需先在開發板管理員安裝 esp32）' : ''}，選擇序列埠，按「上傳」。${DL.boardFamily(p.board.type) === 'esp32' ? '一直停在 Connecting… 時，按住 BOOT 鍵直到開始寫入。' : ''}</li><li>程式有序列埠訊息時，開「序列埠監控視窗」並選 115200 bps。</li></ol><div class="row" style="margin-top:6px"><button class="btn sm" id="upCopyCode" ${(p.code.text || '').trim() ? '' : 'disabled'}>複製程式</button></div></details>` : '';
    const vm = up.vmon;
    const mon = up.method === 'virtual' && board.id === 'uno' ? `<div class="vmon"><div class="row"><b>序列埠監看</b><span class="pill virt">虛擬設備</span>${vm ? `<span class="muted" id="upMonState">${vm.open ? `已連線 · 收到 ${vm.bytes} 位元組` : esc(vm.state || '已關閉')}</span><button class="btn sm" id="upMonClose" ${vm.open ? '' : 'disabled'}>關閉</button>` : ''}<button class="btn sm" id="upMonOpen" ${up.busy || (vm && vm.open) ? 'disabled' : ''} title="和 Arduino IDE 的序列埠監控視窗一樣，開啟時虛擬 Uno 會重新啟動（Optiboot 等約 1 秒後執行程式）">${vm ? '重新開啟' : '開啟'}</button></div>
      <pre class="raw" id="upSerial" aria-live="polite">${vm ? esc(vm.lines.slice(-40).join('\n') + (vm.part ? '\n' + vm.part : '')) || '（還沒有收到文字）' : '（上傳後會自動開啟；程式用 Serial.println 印出的文字會顯示在這裡）'}</pre></div>` : '';
    el.innerHTML = mSel + target + reqHtml + action + pr + last + log + lines + mon + ide;
    const cpc = $('upCopyCode'); if (cpc) cpc.onclick = () => this.copy(p.code.text || '', $('code'));
    el.querySelectorAll('[data-upm]').forEach(b => b.onclick = () => { up.method = b.dataset.upm; up.confirm = null; this.renderUpload(); });
    const bp = $('upPorts'); if (bp) bp.onclick = () => this.upListPorts();
    const ps = $('upPort'); if (ps) ps.onchange = () => { up.port = ps.value; };
    const vu = $('upVdev'); if (vu) vu.onchange = () => this.setVdevUrl(vu.value.trim());
    const mo = $('upMonOpen'); if (mo) mo.onclick = () => this.vmonOpen();
    const mc = $('upMonClose'); if (mc) mc.onclick = () => this.vmonClose('已關閉');
    const us = $('upSerial'); if (us) us.scrollTop = us.scrollHeight;
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
  // 編譯服務上傳失敗時，從工具輸出判斷常見原因（給學生看得懂的下一步）
  function uploadHint(raw) {
    raw = String(raw || '');
    if (/could not open port|Access is denied|Resource busy|Permission denied|PermissionError|port is busy|being used by another/i.test(raw)) return '連接埠被占用或沒有權限：關掉 Arduino IDE 的序列埠監控視窗與其他 DofLab 分頁後再試（Linux 需要把使用者加入 dialout 群組）。';
    if (/Failed to connect to ESP32|Wrong boot mode|Timed out waiting for packet header|No serial data received/i.test(raw)) return 'ESP32 沒有進入下載模式：上傳出現「Connecting…」時按住板子上的 BOOT 鍵，開始寫入後再放開。';
    if (/not in sync|stk500_recv|stk500_getsync/i.test(raw)) return '沒有和 Uno 的開機程式同步：確認板型與連接埠，或在上傳開始時按一下 RESET。';
    return '';
  }
  P.upRun = async function (method, what) {
    const p = this.p; const up = this.up; const board = DL.boards[p.board.type];
    if (up.busy) return;
    if (what !== 'firmata') { const R = this.upRequirements(method); if (!R.ok) { this.toast(R.req.find(r => !r.ok).text, 'e'); return; } }
    up.busy = true; up.prog = null; up.last = null; this.renderUpload(); if (what === 'firmata') this.renderHw();
    const code = what === 'firmata' ? DL.firmware.ino : p.code.text;
    try {
      // 同一個序列埠不能同時給兩個程式用：觀測頁還連著的話，先中斷再上傳
      if (method === 'virtual' && up.vmon && up.vmon.open) await this.vmonClose('上傳前關閉');   // 上傳與序列埠監看都需要獨占虛擬設備
      // 只中斷會衝突的連線：上傳到虛擬 Uno 只需要放開虛擬設備的連線，上傳到實體板子只需要放開 USB
      if (method !== 'pi' && this.hw && this.hw.driver && this.hw.driver.kind === 'firmata' && (method === 'virtual') === !!this.hw.driver.virtual) {
        this.upLog('上傳前先中斷「觀測」頁的真機連線（同一個序列埠不能同時給兩個程式用）', 'w');
        await this.hwDisconnect('上傳程式前中斷'); await new Promise(r => setTimeout(r, 300));
      }
      if (method === 'browser') {
        const hex = what === 'firmata' ? DL.firmware.unoHex : this.lastArtifacts.artifacts.hex;
        let port;
        try { port = await navigator.serial.requestPort({}); } catch (e) { throw new Error('沒有選擇連接埠，已取消。'); }
        this.upLog('開始上傳（瀏覽器，STK500）');
        const r = await DL.stk500.flash(port, hex, { open: (pt, baud) => DL.serial.open(pt, baud, m => this.upLog(m)), log: m => this.upLog(m), onProgress: pr => { up.prog = pr; this.renderUpload(); } });
        up.last = `已上傳到 ${board.short}：${r.bytes} 位元組，${r.verified ? '讀回比對一致' : '未比對'}，${(r.ms / 1000).toFixed(1)} 秒。`;
      } else if (method === 'virtual') {
        const hex = what === 'firmata' ? DL.firmware.unoHex : this.lastArtifacts.artifacts.hex;
        const ue = $('upVdev') || $('vdevUrl'); const url = (ue && ue.value.trim()) || this.vdevUrl(); this.setVdevUrl(url);
        this.upLog(`開始上傳到虛擬 Uno（${url}，STK500 經網路；虛擬設備，不是實體板子）`);
        const port = DL.transport.wsSerialPort(url, { log: m => this.upLog(m) });
        const r = await DL.stk500.flash(port, hex, { log: m => this.upLog(m), onProgress: pr => { up.prog = pr; this.renderUpload(); } });
        up.last = `已上傳到虛擬 Uno（虛擬設備，不是實體板子）：${r.bytes} 位元組，${r.verified ? '讀回比對一致' : '未比對'}，${(r.ms / 1000).toFixed(1)} 秒。`;
        if (what !== 'firmata') up.monAfter = true;
      } else if (method === 'server') {
        if (!up.port) await this.upListPorts();
        if (!up.port) throw new Error('沒有可用的序列埠。');
        this.upLog(`開始上傳（編譯服務，${up.port}）：先編譯再上傳，可能需要一分鐘`);
        const r = await (await fetch(this.compileBase() + '/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ board: p.board.type, code, port: up.port, confirm: true }) })).json();
        if (!r.ok) { up.lastRaw = r.raw; const stage = r.stage === 'compile' ? '編譯失敗' : r.stage === 'port' ? '連接埠不正確' : '上傳失敗'; const hint = r.stage === 'upload' ? uploadHint(r.raw) : ''; throw new Error(stage + '（結束碼 ' + r.exitCode + '）：' + (hint ? hint + '　原始訊息：' : '') + rawTail(r.raw)); }
        up.last = `已由編譯服務上傳到 ${up.port}（${r.fqbn}，${(r.durationMs / 1000).toFixed(1)} 秒，含讀回比對）。`;
      } else if (method === 'pi') await this.piDeploy(code);
      if (up.last) { this.upLog(up.last, 'ok'); this.log('s', up.last); this.toast(up.last); }
      if (up.monAfter) { up.monAfter = false; setTimeout(() => this.vmonOpen(), 50); }
      if (what === 'firmata' && method !== 'pi') { this.hw.firmataFlashed = true; if (this.hw.lastPort) this.log('s', '韌體已上傳：在「真機連線」按「用上次的連接埠重新連線」即可，不用再選連接埠。'); }
    } catch (e) {
      this.upLog(e.message, 'e'); this.log('e', '上傳失敗：' + e.message); this.toast(e.message, 'e');
    } finally { up.busy = false; up.prog = null; this.renderUpload(); if (what === 'firmata') this.renderHw(); }
  };

  /* ---------- 樹莓派部署 ---------- */
  P.piDeploy = function (code) {
    const up = this.up; const url = ($('upWs') && $('upWs').value.trim()) || this.upWsUrl();
    const pins = Object.values(this.analysis.bindings).flatMap(b => [b.num, b.echoNum]).filter(n => n != null);   // 超音波有 TRIG 與 ECHO 兩個腳位
    return new Promise((resolve, reject) => {
      let ws; try { ws = new WebSocket(url); } catch (e) { reject(new Error('閘道網址不正確：' + e.message)); return; }
      const t = setTimeout(() => { try { ws.close(); } catch (e) { } reject(new Error(`連不到樹莓派閘道 ${url}`)); }, 6000);
      ws.onopen = () => { ws.send(JSON.stringify({ op: 'hello', client: 'doflab-deploy', proto: 2 })); };
      ws.onerror = () => { };
      ws.onclose = () => { if (up.pi.ws === ws) { up.pi.ws = null; this.renderUpload(); } };
      ws.onmessage = ev => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.op === 'hello') {
          if (!m.deploy) { clearTimeout(t); ws.close(); reject(new Error(m.deployWhy || '這個 pi_bridge 版本不支援部署，請更新 pi_bridge.py')); return; }   // 虛擬樹莓派：說明為什麼不能部署
          ws.send(JSON.stringify({ op: 'deploy', id: 'd' + Date.now(), code, pins, confirm: true }));
        } else if (m.op === 'deployed') { clearTimeout(t); up.pi.ws = ws; up.pi.running = m; up.pi.lines = [`$ python3 ${m.path}`]; up.last = `已部署到樹莓派並開始執行（${m.bytes} 位元組，PID ${m.pid}）。`; resolve(m); }
        else if (m.op === 'error') { clearTimeout(t); if (!up.pi.running) { ws.close(); reject(new Error(m.message)); } else { up.pi.lines.push('錯誤：' + m.message); this.renderUpload(); } }
        else if (m.op === 'proc') { up.pi.lines.push((m.stream === 'err' ? '! ' : '') + m.line); if (up.pi.lines.length > 200) up.pi.lines.shift(); this.renderUpload(); }
        else if (m.op === 'proc_exit') { up.pi.lines.push(`（程式結束：${m.reason === 'stopped' ? '已停止' : '結束碼 ' + m.code}）`); up.pi.running = null; this.upLog(m.reason === 'stopped' ? '樹莓派上的程式已停止' : `樹莓派上的程式結束（結束碼 ${m.code}）`, m.reason === 'stopped' || m.code === 0 ? '' : 'e'); try { ws.close(); } catch (e) { } }
      };
    });
  };
  P.piStop = function () { const ws = this.up.pi.ws; if (ws && ws.readyState === 1) ws.send(JSON.stringify({ op: 'stop' })); else { this.up.pi.running = null; this.renderUpload(); } };

  /* ---------- 虛擬 Uno 的序列埠監看（第 4 階段） ---------- */
  // 和 Arduino IDE 的序列埠監控視窗一樣：開啟時 DTR 讓板子重新啟動，所以看得到 setup() 印出的文字。收到的位元組以 UTF-8 解碼、依換行分行。
  P.vmonOpen = async function () {
    const up = this.up; if (up.vmon && up.vmon.open) return;
    if (this.hw && this.hw.driver && this.twin.conn.state === 'connected' && this.hw.driver.virtual) { this.toast('「觀測」頁正連著虛擬設備：先中斷連線再開序列埠監看（序列埠監看需要獨占虛擬設備）。', 'e'); return; }
    const url = this.vdevUrl(); const vm = up.vmon = { open: false, lines: [], part: '', bytes: 0, state: '連線中…', port: null }; this.renderUpload();
    const dec = new TextDecoder('utf-8');
    const port = DL.transport.wsSerialPort(url, { log: (m, k) => this.upLog(m, k === 'e' ? 'e' : ''), onLost: why => { if (up.vmon === vm) { vm.open = false; vm.state = '連線中斷：' + why; this.renderUpload(); } } });
    try { await port.open(); } catch (e) { vm.state = '無法連線'; this.upLog('序列埠監看：' + e.message, 'e'); this.renderUpload(); return; }
    vm.port = port; vm.open = true; vm.state = '';
    await port.setSignals({ dataTerminalReady: false, requestToSend: false }); await port.setSignals({ dataTerminalReady: true, requestToSend: true });
    this.log('s', '序列埠監看：已連到虛擬 Uno，虛擬晶片重新啟動（和 Arduino IDE 開啟序列埠監控視窗相同）', undefined);
    const rd = vm.reader = port.readable.getReader();
    (async () => {
      for (;;) {
        let x; try { x = await rd.read(); } catch (e) { break; } if (x.done) break;
        vm.bytes += x.value.length; const txt = vm.part + dec.decode(x.value, { stream: true }); const parts = txt.split(/\r?\n/); vm.part = parts.pop();
        for (const l of parts) { vm.lines.push(l); this.log('s', '虛擬 Uno 序列埠：' + l); }
        if (vm.lines.length > 300) vm.lines.splice(0, vm.lines.length - 300);
        if (!vm.dirty) { vm.dirty = true; setTimeout(() => { vm.dirty = false; if (up.vmon === vm) this.renderUpload(); }, 120); }
      }
    })();
    this.renderUpload();
  };
  P.vmonClose = async function (why) {
    const vm = this.up && this.up.vmon; if (!vm || !vm.open) return;
    vm.open = false; vm.state = why || '已關閉';
    try { await vm.reader.cancel(); } catch (e) { } try { vm.reader.releaseLock(); } catch (e) { }
    try { await vm.port.close(); } catch (e) { }
    this.renderUpload();
  };

  /* ---------- 觀測頁：上傳 DofLabFirmata ---------- */
  P.firmataFlashHtml = function () {
    const t = this.p.board.type; if (t === 'pi4b') return '';
    if (!this.up) this.upInit();
    const up = this.up;
    if (up.confirm && up.confirm.what === 'firmata') {
      const items = this.upConfirmItems(up.confirm.method, 'firmata'); const all = items.every(i => up.checks[i.id]);
      return `<div class="inline-confirm" role="alertdialog">${items.map(i => `<label class="check"><input type="checkbox" data-fwchk="${i.id}" ${up.checks[i.id] ? 'checked' : ''}><span>${esc(i.text)}</span></label>`).join('')}<div class="row"><button class="btn primary" id="fwGo" ${all ? '' : 'disabled'}>上傳 DofLabFirmata</button><button class="btn" id="fwCancel">取消</button></div></div>`;
    }
    const m = t === 'uno' && this.hwSource() === 'virtual' ? 'virtual' : t === 'uno' && navigator.serial ? 'browser' : 'server';
    return `<div class="row"><button class="btn" id="fwFlash" data-m="${m}" ${up.busy ? 'disabled' : ''}>${up.busy ? '上傳中…' : `上傳 DofLabFirmata${m === 'server' ? '（用編譯服務）' : m === 'virtual' ? '（虛擬 Uno）' : '（USB）'}`}</button>${up.prog ? `<span class="muted">${up.prog.phase === 'verify' ? '比對' : '寫入'} ${up.prog.done}／${up.prog.total}</span>` : ''}</div>${this.hw.firmataFlashed ? '<span class="hint" style="color:var(--ok)">DofLabFirmata 已上傳，可以連線了。</span>' : ''}`;
  };
  P.bindFirmataFlash = function () {
    const up = this.up; if (!up) return;
    const b = $('fwFlash'); if (b) b.onclick = () => { if (this.p.board.type !== 'uno' && b.dataset.m === 'server' && !up.port) this.upListPorts(); up.confirm = { method: b.dataset.m, what: 'firmata' }; up.checks = {}; this.renderHw(); };
    document.querySelectorAll('[data-fwchk]').forEach(cb => cb.onchange = () => { up.checks[cb.dataset.fwchk] = cb.checked; this.renderHw(); });
    const c = $('fwCancel'); if (c) c.onclick = () => { up.confirm = null; this.renderHw(); };
    const g = $('fwGo'); if (g) g.onclick = async () => { const cf = up.confirm; up.confirm = null; if (cf.method === 'server' && !up.port) await this.upListPorts(); this.upRun(cf.method, 'firmata'); };
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
