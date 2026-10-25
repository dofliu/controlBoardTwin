/* DofLab — 傳輸層：Firmata 的位元組怎麼送到設備（V2.8，雲端虛擬硬體第 1 階段）
 * 協定和實體一樣，只換傳輸層：FirmataDriver 送出與解讀的位元組不論走 USB 或網路都完全相同。
 * 共同介面（FirmataDriver 只用這些）：
 *   open()                       開啟；失敗丟出錯誤
 *   onBytes(cb) / onLost(cb)     收到位元組／意外中斷（拔線、網路斷）
 *   write(bytes)                 送出位元組（Promise）
 *   setSignals({dataTerminalReady, requestToSend})  控制線（重新啟動板子）；canSignal 為 false 時不支援
 *   close()                      關閉（Promise；等讀取結束、連接埠真的放開）
 *   info()                       { kind: 'serial' | 'virtual', … }
 *   writable                     目前能不能寫
 *   WebSerialTransport  USB 序列埠（Web Serial），含 V2.6.1 的連接埠占用處理（DL.serial）
 *   WebSocketTransport  虛擬設備主機（tools/vdev/server.js）：二進位訊框＝序列埠位元組；文字訊框＝控制訊息（JSON）
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

  /* ======================= USB 序列埠（Web Serial） ======================= */
  class WebSerialTransport {
    // opts.port：已授權的連接埠（省略時跳出選擇視窗）；opts.evict：本頁另一個連線要開同一個連接埠時，怎麼關掉這個連線
    constructor(opts) { this.opts = opts || {}; this.kind = 'serial'; this.canSignal = true; this.port = null; this.writer = null; this._bytes = () => { }; this._lost = () => { }; }
    static available() { return typeof navigator !== 'undefined' && 'serial' in navigator; }
    onBytes(cb) { this._bytes = cb; } onLost(cb) { this._lost = cb; }
    log(m, k) { this.opts.log && this.opts.log(m, k); }
    async open() {
      this.port = this.opts.port || await navigator.serial.requestPort();
      await openPort(this.port, this.opts.baudRate || 57600, (m, k) => this.log(m, k));
      this.closing = false; this._closer = this.opts.evict || (() => this.close()); owners.set(this.port, this._closer);
      this.writer = this.port.writable.getWriter();
      this.reading = this.readLoop();
    }
    async readLoop() {
      const reader = this.reader = this.port.readable.getReader();
      try { while (true) { const { value, done } = await reader.read(); if (done) break; this._bytes(value); } }
      catch (e) { if (!this.closing) this.log('序列埠中斷：' + e.message, 'e'); }
      finally { try { reader.releaseLock(); } catch (e) { } if (!this.closing) this._lost('序列埠中斷'); }
    }
    get writable() { return !!this.writer; }
    write(bytes) { return this.writer ? this.writer.write(new Uint8Array(bytes)) : Promise.resolve(); }
    async setSignals(sig) { if (!this.port || !this.port.setSignals) return false; await this.port.setSignals(sig); return true; }
    info() { return { kind: 'serial', usb: this.port && this.port.getInfo ? this.port.getInfo() : null }; }
    async close() {
      this.closing = true;
      if (this.reader) { try { await this.reader.cancel(); } catch (e) { } }   // 必須 await，否則 reader 已釋放時的拒絕會變成未處理錯誤
      if (this.reading) { try { await this.reading; } catch (e) { } }   // 等讀取迴圈真的放開串流：否則 close() 會因為串流還鎖著而失敗，連接埠一直被本頁占住
      try { this.writer && this.writer.releaseLock(); } catch (e) { }
      this.writer = null;
      if (this.port) {
        if (owners.get(this.port)) owners.delete(this.port);
        try { await this.port.close(); } catch (e) { this.log('關閉序列埠失敗：' + e.message + '（下次連線時會再試著關閉）', 'w'); }
      }
    }
  }

  /* ======================= 虛擬設備主機（WebSocket） =======================
   * 控制訊息（文字訊框，JSON）：
   *   → {op:'hello', client:'doflab', proto:2, name, mode:'firmata'|'raw'}
   *                                                  ← {op:'hello', proto:2, kind:'virtual', board, device, firmware, bench, clock, host, you, name, mode}
   *   → {op:'signals', dtr, rts}                     對應 USB 晶片的 DTR／RTS（重新啟動板子）；需要控制權（或只有自己一個連線）
   *   → {op:'ping', t}                               ← {op:'pong', t, devMs}：量網路來回時間
   *   → {op:'lock', want:'control'|'release'}        ← {op:'lock', ok, you, holder:{id,name}, message}：控制權（第 5 階段）
   *   ← {op:'presence', you, links:[{id,name,mode,control}], holder, why, by}：誰連著、誰有控制權
   *   ← {op:'event', kind:'reset', …}                設備事件：只寫進紀錄，不當作量測
   *   ← {op:'error', code, message}                  busy（上傳中或要獨占時有別人連著）、not_holder（沒有控制權，寫入被擋下）、proto */
  const PROTO = 2;   // 2（第 5 階段）：多個連線、控制權（lock）、presence
  class WebSocketTransport {
    constructor(opts) { this.opts = opts || {}; this.url = this.opts.url; this.kind = 'virtual'; this.canSignal = true; this.ws = null; this.hello = null; this.rtt = null; this.presence = null; this.lockWait = []; this._bytes = () => { }; this._lost = () => { }; }
    static available() { return typeof WebSocket !== 'undefined'; }
    onBytes(cb) { this._bytes = cb; } onLost(cb) { this._lost = cb; }
    log(m, k) { this.opts.log && this.opts.log(m, k); }
    open() {
      const url = this.url; const ms = this.opts.timeoutMs || 5000;
      return new Promise((resolve, reject) => {
        let opened = false, settled = false, timer = null;
        const done = (err, v) => { if (settled) return; settled = true; clearTimeout(timer); if (err) { this.closing = true; try { this.ws.close(); } catch (e) { } reject(err); } else resolve(v); };
        if (!/^wss?:\/\//.test(url || '')) { done(new Error(`虛擬設備網址要以 ws:// 或 wss:// 開頭：${url || '（空白）'}`)); return; }
        try { this.ws = new WebSocket(url); } catch (e) { done(new Error('虛擬設備網址格式不正確：' + url)); return; }
        timer = setTimeout(() => done(new Error(opened ? '已連上，但沒有收到虛擬設備的識別回應（協定不符？請更新 tools/vdev/server.js）。' : `連線逾時：請確認虛擬設備主機正在執行（node tools/vdev/server.js），網址是 ${url}。`)), ms);
        this.ws.binaryType = 'arraybuffer';
        this.ws.onopen = () => { opened = true; this.sendJson({ op: 'hello', client: 'doflab', proto: PROTO, name: this.opts.name || '', mode: this.opts.mode || 'firmata' }); };
        this.ws.onerror = () => { if (!opened) done(new Error(`無法連到虛擬設備 ${url}：請先在電腦上執行 node tools/vdev/server.js。若本頁是 https 網址，請改從 http://localhost 開啟。`)); };
        this.ws.onclose = ev => {
          clearInterval(this.pinger);
          if (!settled) { done(new Error(`虛擬設備關閉了連線${ev && ev.reason ? '：' + ev.reason : ''}。`)); return; }
          if (!this.closing) this._lost('虛擬設備的網路連線中斷');
          if (this._closed) this._closed();
        };
        this.ws.onmessage = ev => {
          if (typeof ev.data !== 'string') { if (this.hello) this._bytes(new Uint8Array(ev.data)); return; }
          let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
          if (m.op === 'hello') {
            if (m.proto !== PROTO) { done(new Error(`虛擬設備協定版本 ${m.proto} 不符（需要 ${PROTO}）。`)); return; }
            if (m.kind !== 'virtual') { done(new Error('對方沒有標示為虛擬設備（kind 不是 virtual），拒絕連線。')); return; }
            this.hello = m; this.pinger = setInterval(() => this.sendJson({ op: 'ping', t: Date.now() }), 2000); this.sendJson({ op: 'ping', t: Date.now() });
            done(null, m);
          } else if (m.op === 'pong') { if (typeof m.t === 'number') this.rtt = Date.now() - m.t; }
          else if (m.op === 'presence') { this.presence = m; if (this.opts.onPresence) this.opts.onPresence(m); }
          else if (m.op === 'lock') { const w = this.lockWait.shift(); if (w) w(m); }
          else if (m.op === 'error' && m.code === 'not_holder') { this.log('虛擬設備：' + m.message, 'w'); if (this.opts.onBlocked) this.opts.onBlocked(m); }
          else if (m.op === 'event') this.log(`虛擬設備事件：${m.text || m.kind}（設備時間 ${m.devMs !== undefined ? (m.devMs / 1000).toFixed(3) + ' s' : '未知'}；只是紀錄，不是量測）`, 'w');
          else if (m.op === 'error') { if (!settled) done(new Error(m.message || m.code)); else this.log('虛擬設備：' + (m.message || m.code), 'e'); }
        };
      });
    }
    sendJson(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }
    // 控制權（第 5 階段）：want 'control' 取得、'release' 釋放；回傳 {ok, you, holder, message}
    lock(want) {
      if (!this.writable) return Promise.resolve({ ok: false, message: '虛擬設備沒有連線。' });
      return new Promise(res => {
        const t = setTimeout(() => { const i = this.lockWait.indexOf(f); if (i >= 0) this.lockWait.splice(i, 1); res({ ok: false, message: '虛擬設備主機沒有回應控制權要求（逾時）。' }); }, 5000);
        const f = m => { clearTimeout(t); res(m); }; this.lockWait.push(f); this.sendJson({ op: 'lock', want });
      });
    }
    get writable() { return !!(this.ws && this.ws.readyState === 1 && this.hello); }
    write(bytes) { if (this.writable) this.ws.send(new Uint8Array(bytes)); return Promise.resolve(); }
    async setSignals(sig) { if (!this.writable) return false; const o = { op: 'signals' }; if ('dataTerminalReady' in sig) o.dtr = !!sig.dataTerminalReady; if ('requestToSend' in sig) o.rts = !!sig.requestToSend; this.sendJson(o); return true; }
    info() { const h = this.hello || {}; let host = ''; try { host = new URL(this.url).host; } catch (e) { } return { kind: 'virtual', url: this.url, host, device: h.device, board: h.board, model: h.model || 'avr8js', note: h.note, mcu: h.mcu, firmware: h.firmware, bench: h.bench, clock: h.clock, rtt: this.rtt, you: h.you, name: h.name, presence: this.presence }; }
    close() {
      this.closing = true; clearInterval(this.pinger);
      if (!this.ws || this.ws.readyState === 3) return Promise.resolve();
      return new Promise(r => { const t = setTimeout(r, 1000); this._closed = () => { clearTimeout(t); r(); }; try { this.ws.close(); } catch (e) { r(); } });
    }
  }

  // 虛擬設備的「序列埠」（第 4 階段）：把 WebSocketTransport 包成 Web Serial 的連接埠介面（open／readable／writable／setSignals／close），
  // 讓瀏覽器的 STK500 上傳（stk500.js）與序列埠監看不用改就能用在虛擬 Uno 上。DTR 經網路送到虛擬晶片，和 USB 一樣會讓晶片重置進入 Optiboot。
  function wsSerialPort(url, opts) {
    opts = opts || {}; let t = null, ctrl = null, rs = null, wr = null;
    const port = {
      virtual: true, url, hello: null,
      getInfo: () => ({ virtual: 'vdev', url }),
      get readable() { return rs; }, get writable() { return wr; },
      get rtt() { return t ? t.rtt : null; },
      async open() {
        if (t) throw Object.assign(new Error('The port is already open.'), { name: 'InvalidStateError' });
        t = new WebSocketTransport({ url, log: opts.log, timeoutMs: opts.timeoutMs, mode: 'raw', name: opts.name || '上傳／序列埠監看' });   // raw：不是 Firmata，需要獨占整台設備
        rs = new ReadableStream({ start(c) { ctrl = c; }, cancel() { ctrl = null; } });
        t.onBytes(b => { try { ctrl && ctrl.enqueue(b); } catch (e) { } });
        t.onLost(why => { try { ctrl && ctrl.error(new Error(why)); } catch (e) { } ctrl = null; if (opts.onLost) opts.onLost(why); });
        try { port.hello = await t.open(); } catch (e) { t = null; rs = null; throw e; }
        const tr = t; wr = new WritableStream({ write: chunk => tr.write(chunk) });
      },
      async setSignals(sig) { if (t) await t.setSignals(sig); },
      async close() { const x = t; t = null; try { ctrl && ctrl.close(); } catch (e) { } ctrl = null; rs = wr = null; if (x) await x.close(); }
    };
    return port;
  }

  DL.transport = { WebSerialTransport, WebSocketTransport, wsSerialPort, PROTO };
  if (typeof module !== 'undefined') module.exports = DL;
})(typeof globalThis !== 'undefined' ? globalThis : this);
