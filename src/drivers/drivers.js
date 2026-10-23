/* DofLab — 硬體驅動
 * 共同介面：
 *   connect(opts)            → { deviceId, info, identity:{ok, msg} }
 *   watch(inputs)            唯讀：設定輸入腳位與回報（只碰輸入腳位，不改變任何輸出）
 *   authorize(outputs)       受控寫入：把授權的輸出腳位設為輸出模式
 *   write(cmd)               送出命令；設備回覆後呼叫 twin.ack
 *   revoke() / disconnect()
 * Uno 與 ESP32 走 Firmata（StandardFirmata 或 DofLabFirmata）；樹莓派走 pi_bridge.py。缺實作的板型一律明確拒絕。
 */
(function (root) {
  const DL = (root.DL = root.DL || {});
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ======================= 序列埠的開啟與釋放 =======================
   * 同一個連接埠同時只能被一個程式（或同一頁的一個連線）開啟。常見的卡住原因：
   *   1. 本頁上一次的連線沒有關乾淨（讀取迴圈還鎖著串流，close() 失敗）→ 再開會得到 InvalidStateError
   *   2. 別的程式還開著（Arduino IDE 的序列埠監控視窗、另一個 DofLab 分頁、剛結束的上傳工具還沒放開）→ NetworkError
   * 第 1 種由這裡自動關閉後重開；第 2 種稍候重試，仍失敗就明確說明可能的占用者。 */
  const owners = new Map();   // 連接埠 → 本頁哪個連線開著它（關閉函式）
  const isOpen = port => !!(port && (port.readable || port.writable));
  async function releasePort(port) {
    const own = owners.get(port); owners.delete(port);
    if (own) { try { await own(); } catch (e) { } }
    if (isOpen(port)) { try { await port.close(); } catch (e) { } }
    return !isOpen(port);
  }
  function busyError(e) {
    return Object.assign(new Error(`序列埠被占用，打不開（${(e && (e.name + '：' + e.message)) || e}）。請關閉可能正在使用它的程式：Arduino IDE 的「序列埠監控視窗」或「序列繪圖家」、另一個開著 DofLab 的分頁、還在進行的上傳；仍然不行就拔插 USB 線再試。`), { code: 'port_busy', cause: e });
  }
  async function openPort(port, baudRate, log) {
    log = log || (() => { });
    if (isOpen(port)) { log('這個序列埠還開著（本頁上一次的連線沒有關乾淨），先關閉再重新開啟…', 'w'); await releasePort(port); }
    let last = null;
    for (let i = 0; i < 4; i++) {
      try { await port.open({ baudRate }); return; }
      catch (e) {
        last = e;
        if ((e && e.name === 'InvalidStateError') || isOpen(port)) { log('連接埠仍在開啟狀態，先關閉後重試…', 'w'); await releasePort(port); }
        else { if (i === 0) log('序列埠暫時打不開（可能剛被其他程式放開），稍候自動重試…', 'w'); await sleep(700); }
      }
    }
    throw busyError(last);
  }
  async function releaseAll() { for (const p of [...owners.keys()]) await releasePort(p); }
  DL.serial = { open: openPort, release: releasePort, claim: (port, closer) => owners.set(port, closer), unclaim: port => owners.delete(port), releaseAll, isOpen, owners };
  if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('pagehide', () => { releaseAll(); });

  /* ======================= Arduino：Firmata over Web Serial ======================= */
  class FirmataDriver {
    constructor(twin, hooks, boardId) { this.twin = twin; this.hooks = hooks || {}; this.board = DL.boards[boardId || 'uno']; this.kind = 'firmata'; this.buf = []; this.sysex = null; this.version = null; this.caps = null; this.firmware = null; this.fwVersion = null; this.analogMap = null; this.seq = 0; this.pinSignals = {}; this.sonarSignals = {}; this.outPins = {}; this.lastCmdByPin = {}; }
    // 超音波需要 DofLabFirmata 1.1 以上（StandardFirmata 沒有這個功能）
    sonarSupport() {
      if (this.firmware !== 'DofLabFirmata') return { ok: false, msg: `${this.firmware || '目前的韌體'} 不支援超音波測距：請在「觀測」頁按「上傳 DofLabFirmata」，再重新連線。超音波的距離會一直顯示「未知」。` };
      const v = this.fwVersion || [1, 0]; if (v[0] < 1 || (v[0] === 1 && v[1] < 1)) return { ok: false, msg: `DofLabFirmata ${v.join('.')} 太舊，1.1 起才支援超音波：請重新上傳 DofLabFirmata。` };
      return { ok: true };
    }
    static available() { return typeof navigator !== 'undefined' && 'serial' in navigator; }
    // 送出查詢，等 Firmata 回應版本與腳位能力
    async handshake(ms) {
      const t0 = Date.now(); let asked = 0;
      while ((!this.version || !this.caps) && Date.now() - t0 < ms) {
        if (Date.now() - t0 > asked * 1500) { asked++; await this.send([0xF9]); await this.send([0xF0, 0x79, 0xF7]); await this.send([0xF0, 0x6B, 0xF7]); await this.send([0xF0, 0x69, 0xF7]); }
        await sleep(100);
      }
      return !!(this.version && this.caps);   // 板子開機時自己會送版本；要連腳位能力也回應了，才算真的在聽
    }
    // 用 USB 晶片的 DTR／RTS 線重新啟動板子（與 Arduino IDE、esptool 的做法相同；不會進入下載模式）
    async resetBoard() {
      if (!this.port.setSignals) return false;
      try {
        if ((this.board.family || this.board.id) === 'esp32') { await this.port.setSignals({ dataTerminalReady: false, requestToSend: true }); await sleep(120); await this.port.setSignals({ dataTerminalReady: false, requestToSend: false }); }
        else { await this.port.setSignals({ dataTerminalReady: false }); await sleep(120); await this.port.setSignals({ dataTerminalReady: true }); }
        return true;
      } catch (e) { return false; }
    }
    async connect(opts) {
      if (!FirmataDriver.available()) throw new Error('這個瀏覽器不支援 Web Serial：請用電腦版 Chrome 或 Edge，並從 https 或 http://localhost 開啟本頁。');
      this.port = (opts && opts.port) || await navigator.serial.requestPort();
      await openPort(this.port, 57600, (m, k) => this.log(m, k));
      this.closing = false; owners.set(this.port, () => this.disconnect(true));
      this.writer = this.port.writable.getWriter();
      this.reading = this.readLoop();
      this.log('序列埠已開啟（57600 bps），等待板子重新啟動並回應 Firmata…');
      if (!await this.handshake(6000) && !this.closing && await this.resetBoard()) {
        this.log('6 秒內沒有回應：重新啟動板子後再等一次…', 'w'); this.buf = []; this.sysex = null;
        await this.handshake(7000);
      }
      if (!this.version) { await this.disconnect(true); throw new Error(`沒有收到 Firmata 回應（已重新啟動板子再等一次）。請確認板子已上傳 ${(this.board.family || this.board.id) === 'esp32' ? 'DofLabFirmata' : 'DofLabFirmata 或 StandardFirmata'}（57600 bps），而且沒有其他程式占用序列埠。`); }
      const pinCount = this.caps ? this.caps.length : null; const want = this.board.firmataPins;
      const fw = `${this.firmware || 'Firmata'} ${this.version}`;
      const identity = pinCount === want ? { ok: true, msg: `${fw}，回報 ${pinCount} 個腳位，與 ${this.board.name} 相符。` } : { ok: false, msg: `${fw}，回報 ${pinCount ?? '未知'} 個腳位，與 ${this.board.name}（${want} 個）不符。` };
      if (this.firmware === 'StandardFirmata') this.log('注意：StandardFirmata 開機時會自行把數位腳設為 OUTPUT LOW（韌體預設，不是 DofLab 送出）。建議改用 DofLabFirmata，開機時腳位維持輸入。', 'w');
      this.hb = setInterval(() => this.send([0xF9]), 1000);
      return { deviceId: 'firmata:' + (this.port.getInfo ? JSON.stringify(this.port.getInfo()) : 'serial'), info: fw, identity };
    }
    async readLoop() {
      const reader = this.reader = this.port.readable.getReader();
      try { while (true) { const { value, done } = await reader.read(); if (done) break; for (const b of value) this.parse(b); } }
      catch (e) { if (!this.closing) this.log('序列埠中斷：' + e.message, 'e'); }
      finally { try { reader.releaseLock(); } catch (e) { } if (!this.closing) this.lost('序列埠中斷'); }
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
        const id = this.lastCmdByPin[pin];
        if (id) { delete this.lastCmdByPin[pin]; const o = this.outPins[pin]; this.twin.ack(id, o && o.kind === 'servo' ? state : state ? 1 : 0); }
      } else if (cmd === 0x79) { // REPORT_FIRMWARE：主次版本＋名稱（每字 2 個 7 位元）
        let name = ''; for (let i = 3; i + 1 < d.length; i += 2) name += String.fromCharCode(d[i] | (d[i + 1] << 7));
        this.firmware = name.replace(/\.ino$/, '') || null; this.fwVersion = [d[1], d[2]];
      } else if (cmd === 0x63) { // DofLab 擴充：超音波距離（trig、cm 兩個 7 位元）
        const s = this.sonarSignals[d[1]]; if (s) { this.twin.measure(s, d[2] | (d[3] << 7), { seq: ++this.seq }); this.twin.heard(); }
      } else if (cmd === 0x6A) { // ANALOG_MAPPING_RESPONSE：每個腳位對應的類比通道（0x7F = 無）
        this.analogMap = {}; for (let i = 1; i < d.length; i++) if (d[i] !== 0x7F) this.analogMap[i - 1] = d[i];
      }
    }
    send(bytes) { if (!this.writer) return Promise.resolve(); return this.writer.write(new Uint8Array(bytes)).catch(e => this.log('寫入失敗：' + e.message, 'e')); }
    // 唯讀：只設定輸入腳位（上拉／類比）並開啟回報
    async watch(inputs) {
      let res = {};
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
    async authorize(outputs) {
      for (const o of outputs) { this.outPins[o.num] = o; await this.send([0xF4, o.num, o.kind === 'servo' ? 0x04 : 0x01]); }
    }
    async write(cmd, out) {
      const pin = out.num;
      if (!this.outPins[pin]) { this.log(`${cmd.name} 的腳位沒有授權，命令未送出。`, 'e'); return; }
      if (out.kind === 'servo') { const a = Math.round(cmd.v); await this.send(pin < 16 ? [0xE0 | pin, a & 0x7F, (a >> 7) & 0x7F] : [0xF0, 0x6F, pin, a & 0x7F, (a >> 7) & 0x7F, 0xF7]); }
      else await this.send([0xF5, pin, cmd.v ? 1 : 0]);
      this.lastCmdByPin[pin] = cmd.id;
      await this.send([0xF0, 0x6D, pin, 0xF7]);   // 回讀暫存值作為 ACK（不證明 LED 真的亮或伺服到位）
    }
    async revoke() {
      for (const o of Object.values(this.outPins)) { if (o.kind !== 'servo') await this.send([0xF5, o.num, 0]); await this.send([0xF4, o.num, 0x00]); }
      this.outPins = {};
    }
    disconnect(silent) { if (!this._closingP) this._closingP = this._disconnect(silent); return this._closingP; }
    async _disconnect(silent) {
      this.closing = true; clearInterval(this.hb);
      try { if (!silent) { if (Object.keys(this.sonarSignals).length) await this.send([0xF0, 0x62, 0x7F, 0xF7]); await this.revoke(); await sleep(150); } } catch (e) { }   // 先停止超音波（TRIG 回到輸入）；撤銷後稍等，讓設備處理完再關閉連接埠
      if (this.reader) { try { await this.reader.cancel(); } catch (e) { } }   // 必須 await，否則 reader 已釋放時的拒絕會變成未處理錯誤
      if (this.reading) { try { await this.reading; } catch (e) { } }   // 等讀取迴圈真的放開串流：否則 close() 會因為串流還鎖著而失敗，連接埠一直被本頁占住
      try { this.writer && this.writer.releaseLock(); } catch (e) { }
      this.writer = null;
      if (this.port) {
        if (owners.get(this.port)) owners.delete(this.port);
        try { await this.port.close(); } catch (e) { this.log('關閉序列埠失敗：' + e.message + '（下次連線時會再試著關閉）', 'w'); }
      }
    }
    // 序列埠意外中斷（拔線、板子重置）：通知上層，並把連接埠關掉，下次才能重新開啟
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
    async authorize(outputs) { for (const o of outputs) this.outPins[o.num] = o; this.send({ op: 'authorize', outputs: outputs.map(o => ({ pin: o.num, kind: o.kind })) }); }
    async write(cmd, out) {
      if (!this.outPins[out.num]) { this.log(`${cmd.name} 的腳位沒有授權，命令未送出。`, 'e'); return; }
      this.send(out.kind === 'servo' ? { op: 'servo', id: cmd.id, pin: out.num, angle: cmd.v } : { op: 'write', id: cmd.id, pin: out.num, value: cmd.v ? 1 : 0 });
    }
    async revoke() { this.outPins = {}; this.send({ op: 'revoke' }); }
    async disconnect() { this.closing = true; clearInterval(this.hb); try { await this.revoke(); } catch (e) { } try { this.ws.close(); } catch (e) { } }
    log(m, k) { this.hooks.log && this.hooks.log(m, k); }
  }

  function driverFor(boardId) {
    const b = DL.boards[boardId];
    if (b.driver === 'firmata') return { cls: FirmataDriver, label: 'USB 序列埠（Firmata）', status: b.id === 'uno' ? '已在虛擬 Uno（真實韌體）驗證，未以實體板驗證' : '韌體可編譯、協定在虛擬 Uno 驗證，未以實體 ESP32 驗證' };
    if (b.driver === 'pibridge') return { cls: PiBridgeDriver, label: '網路閘道（pi_bridge.py）', status: '已實作，僅以 --mock 模擬腳位測試' };
    return { cls: null, label: '無', status: `${b.short} 的真機驅動尚未實作：可以模擬與產生程式，但不能連線同步。` };
  }

  DL.drivers = { FirmataDriver, PiBridgeDriver, driverFor };
  if (typeof module !== 'undefined') module.exports = DL;
})(typeof globalThis !== 'undefined' ? globalThis : this);
