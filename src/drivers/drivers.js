/* DofLab — 硬體驅動
 * 共同介面：
 *   connect(opts)            → { deviceId, info, identity:{ok, msg} }
 *   watch(inputs)            唯讀：設定輸入腳位與回報（只碰輸入腳位，不改變任何輸出）
 *   authorize(outputs)       受控寫入：把授權的輸出腳位設為輸出模式
 *   write(cmd)               送出命令；設備回覆後呼叫 twin.ack
 *   revoke() / disconnect()
 * Uno 與 ESP32 走 Firmata（StandardFirmata 或 DofLabFirmata），經 USB 序列埠；Uno 也可以經網路連到虛擬設備主機（tools/vdev/server.js）。樹莓派走 pi_bridge.py。缺實作的板型一律明確拒絕。
 */
(function (root) {
  const DL = (root.DL = root.DL || {});
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // 序列埠的開啟與釋放（DL.serial）、USB 與虛擬設備的傳輸層在 transport.js
  if (!DL.transport && typeof require === 'function') require('./transport.js');
  const { WebSerialTransport, WebSocketTransport } = DL.transport;

  /* ======================= Arduino／ESP32：Firmata（USB 序列埠或虛擬設備的 WebSocket） ======================= */
  class FirmataDriver {
    constructor(twin, hooks, boardId) { this.twin = twin; this.hooks = hooks || {}; this.board = DL.boards[boardId || 'uno']; this.kind = 'firmata'; this.buf = []; this.sysex = null; this.version = null; this.caps = null; this.firmware = null; this.fwVersion = null; this.analogMap = null; this.seq = 0; this.pinSignals = {}; this.sonarSignals = {}; this.outPins = {}; this.lastCmdByPin = {}; }
    // 超音波需要 DofLabFirmata 1.1 以上（StandardFirmata 沒有這個功能）
    sonarSupport() {
      if (this.firmware !== 'DofLabFirmata') return { ok: false, msg: `${this.firmware || '目前的韌體'} 不支援超音波測距：請在「觀測」頁按「上傳 DofLabFirmata」，再重新連線。超音波的距離會一直顯示「未知」。` };
      const v = this.fwVersion || [1, 0]; if (v[0] < 1 || (v[0] === 1 && v[1] < 1)) return { ok: false, msg: `DofLabFirmata ${v.join('.')} 太舊，1.1 起才支援超音波：請重新上傳 DofLabFirmata。` };
      return { ok: true };
    }
    static available() { return WebSerialTransport.available(); }
    get port() { return this.transport && this.transport.port; }   // USB 連接埠（虛擬設備沒有）：介面記住它，下次不用再選
    get virtual() { return !!(this.transport && this.transport.kind === 'virtual'); }
    // 送出查詢，等 Firmata 回應版本與腳位能力
    async handshake(ms) {
      const t0 = Date.now(); let asked = 0;
      while ((!this.version || !this.caps) && Date.now() - t0 < ms && !this.closing) {
        if (Date.now() - t0 > asked * 1500) { asked++; await this.send([0xF9]); this.fwAsked = (this.fwAsked || 0) + 1; await this.send([0xF0, 0x79, 0xF7]); await this.send([0xF0, 0x6B, 0xF7]); await this.send([0xF0, 0x69, 0xF7]); }
        await sleep(100);
      }
      return !!(this.version && this.caps);   // 板子開機時自己會送版本；要連腳位能力也回應了，才算真的在聽
    }
    // 用 USB 晶片的 DTR／RTS 線重新啟動板子（與 Arduino IDE、esptool 的做法相同；不會進入下載模式）。虛擬設備收到同樣的控制線訊號
    async resetBoard() {
      const t = this.transport; if (!t || !t.canSignal) return false;
      try {
        if ((this.board.family || this.board.id) === 'esp32') { if (!await t.setSignals({ dataTerminalReady: false, requestToSend: true })) return false; await sleep(120); await t.setSignals({ dataTerminalReady: false, requestToSend: false }); }
        else { if (!await t.setSignals({ dataTerminalReady: false })) return false; await sleep(120); await t.setSignals({ dataTerminalReady: true }); }
        return true;
      } catch (e) { return false; }
    }
    // opts.port：USB 連接埠（省略時跳出選擇視窗）；opts.url：虛擬設備網址（ws://…/dev/uno-1），有網址就走網路
    async connect(opts) {
      opts = opts || {};
      const virtual = !!opts.url;
      if (virtual && !WebSocketTransport.available()) throw new Error('這個環境沒有 WebSocket，不能連虛擬設備。');
      if (!virtual && !FirmataDriver.available()) throw new Error('這個瀏覽器不支援 Web Serial：請用電腦版 Chrome 或 Edge，並從 https 或 http://localhost 開啟本頁。（沒有實體板子時，可以改連「虛擬設備」）');
      const log = (m, k) => this.log(m, k);
      const onPresence = m => { if (this.holding && (!m.holder || m.holder.id !== m.you)) this.holding = false; if (this.hooks.onPresence) this.hooks.onPresence(m); };
      const t = this.transport = virtual ? new WebSocketTransport({ url: opts.url, log, name: opts.name, onPresence }) : new WebSerialTransport({ port: opts.port, log, evict: () => this.disconnect(true) });
      t.onBytes(bytes => { for (const b of bytes) this.parse(b); });
      t.onLost(why => this.lost(why));
      this.closing = false;
      await t.open();
      const vi = virtual ? t.info() : null;
      // 虛擬 Uno：avr8js 跑真的韌體機器碼；虛擬 ESP32：協定模型（行為和韌體相同的 JS 程式，不是實際韌體，第 6 階段）
      const what = vi && vi.model === 'protocol' ? '協定模型：行為和 DofLabFirmata 相同的 JS 程式，不是實際韌體，也不是實體板子' : 'avr8js 模擬的晶片，不是實體板子';
      this.log(virtual ? `已經由網路連到虛擬設備 ${vi.device}（${vi.host}；${what}），等待 Firmata 回應…` : '序列埠已開啟（57600 bps），等待板子重新啟動並回應 Firmata…');
      // 虛擬 Uno 上傳過別的程式（第 4 階段）：主機知道快閃記憶體裡是什麼，不是 DofLabFirmata 時先提醒，沒回應就直接說明（重新啟動也只是再跑同一個程式）
      const otherFw = virtual && vi.firmware && vi.firmware.name && vi.firmware.name !== 'DofLabFirmata' ? vi.firmware.name : null;
      if (otherFw) this.log(`虛擬 Uno 現在跑的是「${otherFw}」，不是 DofLabFirmata；如果不是 Firmata，就不會回應。`, 'w');
      if (!await this.handshake(otherFw ? 3000 : 6000) && !this.closing && !otherFw && await this.resetBoard()) {
        this.log('6 秒內沒有回應：重新啟動板子後再等一次…', 'w'); this.buf = []; this.sysex = null;
        await this.handshake(7000);
      }
      if (!this.version && otherFw) { await this.disconnect(true); throw new Error(`虛擬 Uno 現在跑的是上傳的程式（${otherFw}），不是 Firmata，所以不能同步。要同步請先按「上傳 DofLabFirmata」（和實體板子一樣）；想看程式的輸出，請用「程式」頁上傳後的序列埠監看。`); }
      if (!this.version) { await this.disconnect(true); throw new Error(virtual ? `虛擬設備 ${vi.device} 沒有回應 Firmata（已重新啟動再等一次）。請確認虛擬設備主機執行的是 DofLabFirmata 或 StandardFirmata。` : `沒有收到 Firmata 回應（已重新啟動板子再等一次）。請確認板子已上傳 ${(this.board.family || this.board.id) === 'esp32' ? 'DofLabFirmata' : 'DofLabFirmata 或 StandardFirmata'}（57600 bps），而且沒有其他程式占用序列埠。`); }
      const pinCount = this.caps ? this.caps.length : null; const want = this.board.firmataPins;
      const fw = `${this.firmware || 'Firmata'} ${this.version}`;
      const boardOk = !virtual || DL.boardFamily(vi.board) === DL.boardFamily(this.board.id);   // ESP32 DevKitC／DevKit V1 是同一顆晶片、同一份韌體（USB 也分不出來）
      const who = virtual ? `虛擬設備 ${vi.device}（${vi.board}，${vi.model === 'protocol' ? '另一個程序裡的協定模型，不是實際韌體，也不是實體板子' : '另一個程序以 avr8js 模擬，不是實體板子'}）：` : '';
      const identity = pinCount === want && boardOk ? { ok: true, msg: `${who}${fw}，回報 ${pinCount} 個腳位，與 ${this.board.name} 相符。` } : { ok: false, msg: `${who}${fw}，回報 ${pinCount ?? '未知'} 個腳位，與 ${this.board.name}（${want} 個）不符。` };
      if (virtual) { identity.virtual = true; if (vi.model === 'protocol') identity.protocol = true; }
      if (this.firmware === 'StandardFirmata') this.log('注意：StandardFirmata 開機時會自行把數位腳設為 OUTPUT LOW（韌體預設，不是 DofLab 送出）。建議改用 DofLabFirmata，開機時腳位維持輸入。', 'w');
      // 斷線保護（DofLabFirmata 1.2 起）：有輸出時 3 秒沒收到任何位元組，板子自己關掉輸出。舊版沒有，提醒更新
      if (this.firmware === 'DofLabFirmata' && this.fwVersion && (this.fwVersion[0] < 1 || (this.fwVersion[0] === 1 && this.fwVersion[1] < 2))) this.log(`DofLabFirmata ${this.fwVersion.join('.')} 沒有斷線保護（斷線時輸出會停在最後的命令）：請用「上傳 DofLabFirmata」更新到 1.2。`, 'w');
      this.hb = setInterval(() => this.send([0xF9]), 1000);   // 心跳：也讓板子知道連線還在（斷線保護）
      this.readyAt = Date.now() + 1500;   // 之後才開始判斷「設備重新開機」：交握時重問的查詢可能晚一點才回來
      if (virtual) return { deviceId: `vdev:${vi.device}@${vi.host}`, info: `虛擬設備 ${vi.device} · ${fw}${vi.model === 'protocol' ? '（協定模型）' : ''}`, identity, virtual: true, protocol: vi.model === 'protocol' };
      return { deviceId: 'firmata:' + (this.port.getInfo ? JSON.stringify(this.port.getInfo()) : 'serial'), info: fw, identity };
    }
    parse(b) {
      if (this.sysex) { if (b === 0xF7) { this.onSysex(this.sysex); this.sysex = null; } else this.sysex.push(b); return; }
      if (b === 0xF0) { this.sysex = []; return; }
      if (b & 0x80) { this.buf = [b]; return; }
      if (!this.buf.length) return;
      this.buf.push(b);
      const c = this.buf[0];
      if (this.buf.length === 3) {
        if ((c & 0xF0) === 0x90) {
          const port = c & 0x0F, mask = this.buf[1] | (this.buf[2] << 7);
          for (let i = 0; i < 8; i++) { const pin = port * 8 + i; const s = this.pinSignals[pin]; if (s && s.kind === 'button') this.twin.measure(s.name, ((mask >> i) & 1) === 0, { seq: ++this.seq }); }
          this.twin.heard();
        } else if ((c & 0xF0) === 0xE0) {
          const ch = c & 0x0F, val = this.buf[1] | (this.buf[2] << 7);
          const s = Object.values(this.pinSignals).find(x => x.kind === 'analog' && x.ch === ch);
          const max = (1 << this.board.adcBits) - 1;
          if (s) this.twin.measure(s.name, Math.floor(val * 100 / max), { seq: ++this.seq, raw: val });
          this.twin.heard();
        } else if (c === 0xF9) { this.version = `${this.buf[1]}.${this.buf[2]}`; this.twin.heard(); }
        this.buf = [];
      }
    }
    onSysex(d) {
      const cmd = d[0];
      if (cmd === 0x6C) { // CAPABILITY_RESPONSE
        const pins = []; let cur = [];
        for (let i = 1; i < d.length; i++) { if (d[i] === 0x7F) { pins.push(cur); cur = []; } else { cur.push([d[i], d[i + 1]]); i++; } }
        this.caps = pins;
      } else if (cmd === 0x6E) { // PIN_STATE_RESPONSE：pin, mode, state(7 位元一組)
        const pin = d[1]; let state = 0; for (let i = 3; i < d.length; i++) state |= d[i] << (7 * (i - 3));
        // 每個腳位一條在途命令的佇列（網路慢時同一個腳位可能同時有好幾個命令在途）。Firmata 依序回答，回讀是腳位當下的值：
        // 給最早一個「值相同」的命令（更早的視為回讀遺失）；都不相同就給最早的命令，顯示「回讀不一致」（命令沒有生效）
        const q = this.lastCmdByPin[pin];
        if (q && q.length) {
          const o = this.outPins[pin]; const v = o && o.kind === 'servo' ? state : state ? 1 : 0;
          const k = Math.max(0, q.findIndex(e => e.v === v)); const e = q[k]; q.splice(0, k + 1);
          if (!q.length) delete this.lastCmdByPin[pin];
          this.twin.ack(e.id, v);
        }
      } else if (cmd === 0x79) { // REPORT_FIRMWARE：主次版本＋名稱（每字 2 個 7 位元）
        let name = ''; for (let i = 3; i + 1 < d.length; i += 2) name += String.fromCharCode(d[i] | (d[i + 1] << 7));
        this.firmware = name.replace(/\.ino$/, '') || null; this.fwVersion = [d[1], d[2]];
        // 韌體名稱只有兩種時候會來：回應我們的查詢（只在交握時問），或是設備剛開機（Firmata 開機時自己送）
        if (this.fwAsked > 0) this.fwAsked--;
        else if (this.readyAt && Date.now() > this.readyAt && !this.closing) this.rebooted('收到韌體的開機訊息');
      } else if (cmd === 0x63) { // DofLab 擴充：超音波距離（trig、cm 兩個 7 位元）
        const s = this.sonarSignals[d[1]]; if (s) { this.twin.measure(s, d[2] | (d[3] << 7), { seq: ++this.seq }); this.twin.heard(); }
      } else if (cmd === 0x64) { // DofLab 擴充（1.2）：板子太久沒收到訊息，自己把輸出關掉了（斷線保護）
        this.outPins = {}; this.lastCmdByPin = {};
        const why = '設備端 3 秒沒有收到 DofLab 的訊息，已自己關掉輸出（斷線保護）';
        this.log(why + '。', 'w'); if (this.hooks.onGuard) this.hooks.onGuard(why);
      } else if (cmd === 0x6A) { // ANALOG_MAPPING_RESPONSE：每個腳位對應的類比通道（0x7F = 無）
        this.analogMap = {}; for (let i = 1; i < d.length; i++) if (d[i] !== 0x7F) this.analogMap[i - 1] = d[i];
      }
    }
    // 設備重新開機（RESET、瞬間斷電、看門狗）：板子上的腳位設定都回到開機狀態，剛才的授權與在途命令都不算數
    rebooted(why) {
      this.outPins = {}; this.lastCmdByPin = {}; this.buf = []; this.sysex = null;
      this.log(`設備重新開機（${why}）。`, 'w');
      this.release().catch(() => { });   // 虛擬設備：授權已撤銷，控制權也交出去（否則別人一直拿不到）
      if (this.hooks.onReboot) this.hooks.onReboot(why);
    }
    // 重新開機後恢復唯讀觀測：再送一次輸入腳位的設定與回報（只碰輸入，不改變任何輸出）
    rewatch() { return this.watched ? this.watch(this.watched) : Promise.resolve({}); }
    send(bytes) { const t = this.transport; if (!t || !t.writable) return Promise.resolve(); return t.write(bytes).catch(e => this.log('寫入失敗：' + e.message, 'e')); }
    // 唯讀：只設定輸入腳位（上拉／類比）並開啟回報
    async watch(inputs) {
      let res = {}; this.watched = (this.watched || []).filter(w => !inputs.some(i => i.signal === w.signal)).concat(inputs);   // 記住所有唯讀設定，重新開機後才能全部恢復
      for (const i of inputs.filter(x => x.kind === 'sonar')) {
        const ok = this.sonarSupport(); if (!ok.ok) { res.sonarUnsupported = ok.msg; continue; }
        this.sonarSignals[i.num] = i.signal; await this.send([0xF0, 0x62, i.num, i.echo, 0xF7]);
      }
      for (const i of inputs) {
        if (i.kind === 'button') { this.pinSignals[i.num] = { kind: 'button', name: i.signal }; await this.send([0xF4, i.num, 0x0B]); await this.send([0xD0 | (i.num >> 3), 1]); }
        if (i.kind === 'analog') { const ch = this.analogMap && i.num in this.analogMap ? this.analogMap[i.num] : i.num - 14; this.pinSignals[i.num] = { kind: 'analog', name: i.signal, ch }; await this.send([0xF4, i.num, 0x02]); await this.send([0xC0 | ch, 1]); }
      }
      return res;
    }
    // 控制權（虛擬設備，第 5 階段）：同一台設備可以有好幾個人連著，只有拿到控制權的人能寫入。實體 USB 本來就是獨占的，不需要
    async acquire() {
      const t = this.transport; if (!t || !t.lock) return { ok: true };
      const r = await t.lock('control'); this.holding = !!(r && r.ok && r.you);
      return r && r.ok ? r : { ok: false, holder: r && r.holder, message: (r && r.message) || '沒有取得控制權。' };
    }
    async release() { const t = this.transport; if (this.holding && t && t.lock) { this.holding = false; await t.lock('release'); } }
    // o.initial：授權時先送的命令（伺服的目前角度，V2.13）。韌體的 Servo 函式庫在 attach 後、第一個角度到達前會輸出預設的 1500 µs（約 93°），
    // 所以「設成伺服模式」和「寫入角度」放在同一次傳送，韌體同一輪 loop 就處理完，伺服不會先往中間轉
    async authorize(outputs) {
      if (this.virtual && !this.holding) { const r = await this.acquire(); if (!r.ok) throw Object.assign(new Error(r.message), { code: 'not_holder', holder: r.holder }); }
      for (const o of outputs) {
        this.outPins[o.num] = o;
        const mode = [0xF4, o.num, o.kind === 'servo' ? 0x04 : 0x01];
        if (o.initial) await this.write(o.initial, o, mode); else await this.send(mode);
      }
    }
    valueBytes(pin, kind, v) {
      if (kind !== 'servo') return [0xF5, pin, v ? 1 : 0];
      const a = Math.round(v); return pin < 16 ? [0xE0 | pin, a & 0x7F, (a >> 7) & 0x7F] : [0xF0, 0x6F, pin, a & 0x7F, (a >> 7) & 0x7F, 0xF7];
    }
    // before：要和這個命令一起送的位元組（授權時的「設成伺服模式」）
    async write(cmd, out, before) {
      const pin = out.num;
      if (!this.outPins[pin]) { this.log(`${cmd.name} 的腳位沒有授權，命令未送出。`, 'e'); return; }
      await this.send((before || []).concat(this.valueBytes(pin, out.kind, cmd.v)));
      (this.lastCmdByPin[pin] = this.lastCmdByPin[pin] || []).push({ id: cmd.id, v: out.kind === 'servo' ? Math.round(cmd.v) : cmd.v ? 1 : 0 });
      await this.send([0xF0, 0x6D, pin, 0xF7]);   // 回讀暫存值作為 ACK（不證明 LED 真的亮或伺服到位）
    }
    async revoke() {
      if (!this.virtual || this.holding) for (const o of Object.values(this.outPins))   /* 控制權已經不在手上（例如逾時）：寫入會被主機擋下，不必送 */ { if (o.kind !== 'servo') await this.send([0xF5, o.num, 0]); await this.send([0xF4, o.num, 0x00]); }
      this.outPins = {};
      await this.release();   // 虛擬設備：撤銷授權時交出控制權，別人才能取得
    }
    disconnect(silent) { if (!this._closingP) this._closingP = this._disconnect(silent); return this._closingP; }
    async _disconnect(silent) {
      this.closing = true; clearInterval(this.hb);
      try { if (!silent) { if (Object.keys(this.sonarSignals).length) await this.send([0xF0, 0x62, 0x7F, 0xF7]); await this.revoke(); await sleep(150); } } catch (e) { }   // 先停止超音波（TRIG 回到輸入）；撤銷後稍等，讓設備處理完再關閉連接埠
      if (this.transport) await this.transport.close();   // USB：等讀取迴圈放開串流再關閉連接埠（否則會一直被本頁占住）
    }
    // 意外中斷（拔線、板子重置、虛擬設備的網路斷了）：通知上層，並把連接埠關掉，下次才能重新開啟
    lost(why) { clearInterval(this.hb); this.hooks.onLost && this.hooks.onLost(why); this.disconnect(true); }
    log(m, k) { this.hooks.log && this.hooks.log(m, k); }
  }

  /* ======================= Raspberry Pi：WebSocket 閘道（pi_bridge.py 協定 v2） ======================= */
  class PiBridgeDriver {
    constructor(twin, hooks) { this.twin = twin; this.hooks = hooks || {}; this.kind = 'pibridge'; this.pinSignals = {}; this.outPins = {}; }
    connect(opts) {
      const url = opts.url;
      return new Promise((resolve, reject) => {
        let opened = false, hello = null;
        try { this.ws = new WebSocket(url); } catch (e) { reject(new Error('連線網址格式不正確：' + url)); return; }
        const fail = setTimeout(() => { try { this.ws.close(); } catch (e) { } reject(new Error(opened ? '已連上但沒有收到樹莓派的識別回應（協定不符？請更新 pi_bridge.py）。' : '連線逾時：請確認樹莓派上的 pi_bridge.py 正在執行，且電腦與樹莓派在同一個網路。')); }, 5000);
        this.ws.onopen = () => { opened = true; this.send({ op: 'hello', client: 'doflab', proto: 2 }); };
        this.ws.onerror = () => { if (!opened) { clearTimeout(fail); reject(new Error(`無法連到 ${url}。若本頁是 https 網址，瀏覽器會擋下 ws:// 連線：請改從樹莓派開啟 http://<樹莓派IP>:8765。`)); } };
        this.ws.onclose = () => { clearInterval(this.hb); if (hello && !this.closing) this.hooks.onLost && this.hooks.onLost('WebSocket 關閉'); };
        this.ws.onmessage = ev => {
          let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
          if (m.op === 'hello') {
            hello = m; clearTimeout(fail);
            if (m.proto !== 2) { reject(new Error(`pi_bridge 協定版本 ${m.proto} 不符（需要 2）。`)); return; }
            const isPi4 = /Raspberry Pi 4/i.test(m.model || '');
            // 虛擬樹莓派（第 6 階段）：虛擬設備主機啟動的 pi_bridge.py --bench（gpiozero 模擬腳位＋工作台），一律標示虛擬
            if (m.virtual) {
              this.virtual = true; let host = ''; try { host = new URL(url).host; } catch (e) { }
              this.deploy = { ok: m.deploy !== false, why: m.deployWhy || '' };
              this.hb = setInterval(() => this.send({ op: 'ping', t: Date.now() }), 1000);
              resolve({ deviceId: `vdev:${m.device || 'pi'}@${host}`, info: `虛擬設備 ${m.device || ''} · pi_bridge（模擬腳位）`, identity: { ok: true, virtual: true, msg: `虛擬設備 ${m.device || ''}（pi4b，虛擬設備主機上的 pi_bridge.py＋gpiozero 模擬腳位＋工作台，不是實體樹莓派）：${m.model}` }, virtual: true });
              return;
            }
            const identity = m.mock ? { ok: true, mock: true, msg: `模擬腳位（--mock），不是實體樹莓派：${m.model}` } : isPi4 ? { ok: true, msg: `${m.model}（${m.host}）` } : { ok: false, msg: `回報型號為「${m.model || '未知'}」，與 Raspberry Pi 4 Model B 不符。` };
            this.hb = setInterval(() => this.send({ op: 'ping', t: Date.now() }), 1000);
            resolve({ deviceId: 'pi:' + (m.host || url), info: m.model, identity });
          } else if (m.op === 'input') {
            const s = this.pinSignals[m.pin]; if (s) this.twin.measure(s.name, m.value === 0, { seq: m.seq, src: 'pi:' + (hello && hello.host) });
          } else if (m.op === 'distance') { const s = this.sonarSignals && this.sonarSignals[m.trig]; if (s) this.twin.measure(s, m.cm, { seq: m.seq, src: 'pi:' + (hello && hello.host) }); }
          else if (m.op === 'pong') this.twin.heard();
          else if (m.op === 'ack') this.twin.ack(m.id, m.kind === 'servo' ? m.value : m.value ? 1 : 0);
          else if (m.op === 'authorized') this.log(`樹莓派已允許寫入：${m.outputs.map(o => 'GPIO' + o.pin).join('、')}`, 's');
          else if (m.op === 'error') this.log('樹莓派：' + m.message, 'e');
          else if (m.op === 'guard') { this.outPins = {}; this.log('樹莓派：' + m.message, 'w'); if (this.hooks.onGuard) this.hooks.onGuard(m.message); }   // 斷線保護：閘道自己關掉了輸出
        };
      });
    }
    send(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }
    async watch(inputs) {
      this.sonarSignals = {};
      for (const i of inputs) { if (i.kind === 'sonar') this.sonarSignals[i.num] = i.signal; else this.pinSignals[i.num] = { kind: i.kind, name: i.signal }; }
      this.send({ op: 'watch', pins: inputs.filter(i => i.kind === 'button').map(i => ({ pin: i.num, pull: 'up' })) });
      const so = inputs.filter(i => i.kind === 'sonar'); if (so.length) this.send({ op: 'sonar', sensors: so.map(i => ({ trig: i.num, echo: i.echo })) });
      return {};
    }
    // o.initial：授權時先送的命令（伺服的目前角度）。pi_bridge 的伺服沒有預設脈寬（initial_angle=None），送了只是讓伺服馬上到目前的角度，和 Firmata 一致
    async authorize(outputs) { for (const o of outputs) this.outPins[o.num] = o; this.send({ op: 'authorize', outputs: outputs.map(o => ({ pin: o.num, kind: o.kind })) }); for (const o of outputs) if (o.initial) await this.write(o.initial, o); }
    async write(cmd, out) {
      if (!this.outPins[out.num]) { this.log(`${cmd.name} 的腳位沒有授權，命令未送出。`, 'e'); return; }
      this.send(out.kind === 'servo' ? { op: 'servo', id: cmd.id, pin: out.num, angle: cmd.v } : { op: 'write', id: cmd.id, pin: out.num, value: cmd.v ? 1 : 0 });
    }
    async revoke() { this.outPins = {}; this.send({ op: 'revoke' }); }
    async disconnect() { this.closing = true; clearInterval(this.hb); try { await this.revoke(); } catch (e) { } try { this.ws.close(); } catch (e) { } }
    log(m, k) { this.hooks.log && this.hooks.log(m, k); }
  }

  // source：'usb'（預設）、'pibridge'（樹莓派閘道）或 'virtual'（虛擬設備主機）；sources 列出這個板型可選的來源
  // 虛擬設備（第 6 階段起三種板子都有）：Uno＝avr8js 跑真的韌體；ESP32＝協定模型（不是實際韌體）；樹莓派＝pi_bridge.py＋gpiozero 模擬腳位
  function driverFor(boardId, source) {
    const b = DL.boards[boardId];
    if (b.driver === 'firmata') {
      const sources = ['usb', 'virtual'];
      if (source === 'virtual' && b.id !== 'uno') return { cls: FirmataDriver, source: 'virtual', sources, label: '虛擬設備（ESP32 協定模型，WebSocket＋Firmata）', tag: '已在協定模型驗證', status: '已在虛擬設備（協定模型）驗證：另一個程序裡行為和 DofLabFirmata 相同的 JS 程式，不是實際韌體，也不是實體板子' };
      if (source === 'virtual') return { cls: FirmataDriver, source: 'virtual', sources, label: '虛擬設備（WebSocket＋Firmata）', tag: '已在虛擬設備驗證', status: '已在虛擬設備驗證：另一個程序以 avr8js 執行 DofLabFirmata 機器碼，資料經網路交換；不是實體板子' };
      return { cls: FirmataDriver, source: 'usb', sources, label: 'USB 序列埠（Firmata）', tag: b.id === 'uno' ? '已在虛擬 Uno 驗證，未接實體板' : '虛擬 Uno 驗證＋使用者實測', status: b.id === 'uno' ? '已在虛擬 Uno（真實韌體）驗證，未以實體板驗證' : '協定在虛擬 Uno 驗證；使用者已在實體 ESP32 DevKit V1 實測連線、BOOT 同步與藍燈（2026-10-23）' };
    }
    if (b.driver === 'pibridge') {
      const sources = ['pibridge', 'virtual'];
      if (source === 'virtual') return { cls: PiBridgeDriver, source: 'virtual', sources, label: '虛擬設備（虛擬樹莓派：pi_bridge＋模擬腳位）', tag: '已在虛擬設備驗證', status: '已在虛擬設備驗證：虛擬設備主機執行真的 pi_bridge.py，GPIO 是 gpiozero 的模擬腳位，外面接工作台；不是實體樹莓派' };
      return { cls: PiBridgeDriver, source: 'pibridge', sources, label: '網路閘道（pi_bridge.py）', status: '已實作，僅以 --mock 模擬腳位與虛擬樹莓派測試，未以實體樹莓派驗證' };
    }
    return { cls: null, source: null, sources: [], label: '無', status: `${b.short} 的真機驅動尚未實作：可以模擬與產生程式，但不能連線同步。` };
  }

  // 虛擬設備主機上各板型預設的設備名稱（npm run vdev -- --pi --esp32）
  const VDEV_DEVICE = { uno: 'uno-1', esp32: 'esp32-1', esp32doit: 'esp32-1', pi4b: 'pi-1' };
  const vdevUrl = boardId => 'ws://127.0.0.1:8770/dev/' + (VDEV_DEVICE[boardId] || 'uno-1');
  DL.drivers = { FirmataDriver, PiBridgeDriver, driverFor, VDEV_URL: vdevUrl('uno'), VDEV_DEVICE, vdevUrl };
  if (typeof module !== 'undefined') module.exports = DL;
})(typeof globalThis !== 'undefined' ? globalThis : this);
