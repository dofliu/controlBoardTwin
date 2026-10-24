// 一台虛擬設備：avr8js 虛擬 Uno（跑真的 .hex）＋工作台＋即時時鐘＋收到的 Firmata 位元組紀錄。
// 由 server.js 放在自己的 worker thread 裡執行（每台設備一個），晶片模擬不會卡住網路。
// 時間：晶片時間以 1 倍速對齊實際時間；CPU 跟不上時晶片時間會落後（state().realtime 顯示比例），不會跳過指令。
const fs = require('fs'); const path = require('path');
const { VirtualUno, RESET } = require('./avrsim');
const { Bench, DEFAULT_BENCH } = require('./bench');

const DEFAULT_HEX = path.join(__dirname, '..', '..', 'tests', 'fixtures', 'DofLabFirmata-uno.hex');

// 解析「介面送給設備」的 Firmata 位元組，只用來記錄與驗收（例如「唯讀期間沒有任何寫入」），不改變傳送內容
class FirmataSniffer {
  constructor() { this.reset(); }
  reset() { this.cur = null; this.sysex = null; this.c = { bytes: 0, modes: [], writes: [], queries: 0, reports: 0, sysex: 0 }; }
  feed(bytes) {
    for (const b of bytes) {
      this.c.bytes++;
      if (this.sysex) { if (b === 0xF7) { this.onSysex(this.sysex); this.sysex = null; } else this.sysex.push(b); continue; }
      if (b === 0xF0) { this.sysex = []; continue; }
      if (b & 0x80) {
        this.cur = { cmd: b, d: [] };
        if (b === 0xF9 || b === 0xFF) { this.c.queries++; this.cur = null; }
        continue;
      }
      if (!this.cur) continue;
      this.cur.d.push(b); const c = this.cur.cmd, d = this.cur.d;
      const need = (c & 0xF0) === 0xC0 || (c & 0xF0) === 0xD0 ? 1 : 2;
      if (d.length < need) continue;
      if (c === 0xF4) this.c.modes.push([d[0], d[1]]);
      else if (c === 0xF5) this.write('digital', d[0], d[1]);
      else if ((c & 0xF0) === 0x90) this.write('port', c & 0x0F, d[0] | (d[1] << 7));
      else if ((c & 0xF0) === 0xE0) this.write('analog', c & 0x0F, d[0] | (d[1] << 7));
      else this.c.reports++;
      this.cur = null;
    }
  }
  onSysex(d) {
    this.c.sysex++;
    if (d[0] === 0x6F) this.write('extended-analog', d[1], d[2] | (d[3] << 7));
    else if (d[0] === 0x62 && d[1] !== 0x7F) this.c.modes.push([d[1], 'sonar-trig']);
  }
  write(kind, pin, v) { this.c.writes.push({ kind, pin, v }); if (this.c.writes.length > 200) this.c.writes.shift(); this.c.writeCount = (this.c.writeCount || 0) + 1; }
  // 輸出模式：OUTPUT(1)、PWM(3)、SERVO(4)
  summary() { const c = this.c; return { bytes: c.bytes, queries: c.queries, reports: c.reports, sysex: c.sysex, modes: c.modes.slice(-50), outputModes: c.modes.filter(m => [1, 3, 4].includes(m[1])).length, writeCount: c.writeCount || 0, writes: c.writes.slice(-20) }; }
}

class VirtualDevice {
  // opts：{ id, hex（路徑或 hex 文字）, bench（工作台規格）, speed（1 = 即時） }
  constructor(opts) {
    opts = opts || {};
    this.id = opts.id || 'uno-1'; this.board = 'uno';
    const hexPath = opts.hex || DEFAULT_HEX;
    this.hexText = String(hexPath).startsWith(':') ? hexPath : fs.readFileSync(hexPath, 'utf8');
    this.firmware = { name: opts.firmwareName || (/DofLabFirmata/.test(hexPath) ? 'DofLabFirmata' : path.basename(String(hexPath)).replace(/\.hex$/, '')), sha256: require('crypto').createHash('sha256').update(this.hexText).digest('hex') };
    this.uno = new VirtualUno(this.hexText);
    this.bench = new Bench(this.uno, opts.bench || DEFAULT_BENCH);
    this.speed = opts.speed || 1;
    this.sniff = new FirmataSniffer(); this.total = new FirmataSniffer();
    this.tx = []; this.onTx = null; this.onEvent = null;
    this.uno.onSerial = b => this.tx.push(b);
    this.dtr = null; this.links = 0; this.linked = false; this.resets = 0;
  }
  // 介面送來的位元組（序列埠的 RX）
  rx(bytes) { this.sniff.feed(bytes); this.total.feed(bytes); this.uno.sendBytes(bytes); }
  // USB 晶片的控制線：DTR 由「未啟用」變成「啟用」時，Uno 的 RESET 腳經電容收到脈衝 → 晶片重置（與實體 Uno 相同）
  signals(s) {
    if (s && typeof s.dtr === 'boolean') { if (s.dtr && this.dtr === false) this.reset('DTR 觸發重置（與 Arduino IDE 開啟序列埠相同）'); this.dtr = s.dtr; }
  }
  reset(why, flags) { this.uno.reset(flags); this.resets++; this.event({ kind: 'reset', text: '虛擬晶片重新啟動：' + why }); }
  event(e) { e.devMs = Math.round(this.uno.timeMs); this.onEvent && this.onEvent(e); }
  link() { this.links++; this.linked = true; this.sniff.reset(); this.dtr = null; }
  unlink() { this.linked = false; }
  flush() { if (this.tx.length && this.onTx) { const b = Uint8Array.from(this.tx); this.tx.length = 0; this.onTx(b); } else if (!this.onTx) this.tx.length = 0; }
  // 即時時鐘：每 4 ms 補上落後的晶片時間（一次最多 50 ms）；落後太多時從現在重新對齊並記錄
  start() {
    const now = () => Number(process.hrtime.bigint()) / 1e6;
    this.wall0 = now(); this.chip0 = this.uno.timeMs; this.lagResets = 0; this.window = [];
    this.timer = setInterval(() => {
      const wall = now();
      let behind = (wall - this.wall0) * this.speed - (this.uno.timeMs - this.chip0);
      if (behind > 1000) { this.lagResets++; this.wall0 = wall; this.chip0 = this.uno.timeMs; behind = 0; }
      if (behind >= 1) this.uno.runMs(Math.min(behind, 50));
      this.flush();
      this.window.push([wall, this.uno.timeMs]); while (this.window.length > 2 && wall - this.window[0][0] > 3000) this.window.shift();
    }, 4);
  }
  stop() { clearInterval(this.timer); }
  realtime() { const w = this.window || []; if (w.length < 2) return null; const a = w[0], b = w[w.length - 1]; return b[0] > a[0] ? Math.round((b[1] - a[1]) / (b[0] - a[0]) * 100) / 100 : null; }
  pins() { const out = {}; for (let n = 0; n < 20; n++) { const s = this.uno.pinState(n); out[n] = ['low', 'high', 'input', 'input-pullup'][s] || String(s); } return out; }
  state() {
    return { id: this.id, kind: 'virtual', board: this.board, firmware: this.firmware, devMs: Math.round(this.uno.timeMs), realtime: this.realtime(), lagResets: this.lagResets || 0, resets: this.resets, linked: this.linked, links: this.links, pins: this.pins(), bench: this.bench.state(), traffic: this.sniff.summary(), trafficTotal: this.total.summary() };
  }
  // 主執行緒的查詢與工作台操作
  handle(q) {
    if (q.op === 'state') return this.state();
    if (q.op === 'time') return { devMs: Math.round(this.uno.timeMs) };
    if (q.op === 'bench') { this.bench.act(q); return this.state(); }
    if (q.op === 'link') { this.link(); return this.hello(); }
    if (q.op === 'unlink') { this.unlink(); return {}; }
    if (q.op === 'signals') { this.signals(q); return {}; }
    // 故障注入（第 3 階段）：按 RESET 鍵、電壓瞬間掉太低（brown-out）。晶片重新開機，快閃記憶體裡的韌體不變
    if (q.op === 'fault' && q.fault === 'reset') { this.reset('有人按了 RESET 鍵（故障注入）', RESET.EXTRF); return this.state(); }
    if (q.op === 'fault' && q.fault === 'brownout') { this.reset('電壓瞬間掉太低（brown-out，故障注入）', RESET.BORF); return this.state(); }
    throw new Error('未知的查詢 ' + q.op);
  }
  hello() { return { kind: 'virtual', board: this.board, device: this.id, firmware: this.firmware, bench: this.bench.spec.id, benchName: this.bench.spec.name, clock: 'virtual', speed: this.speed, mcu: 'ATmega328P（avr8js 模擬）' }; }
}

// 在 worker thread 裡執行：與 server.js 以訊息溝通
const wt = require('worker_threads');
if (!wt.isMainThread && wt.workerData && wt.workerData.vdev) {
  const port = wt.parentPort;
  let dev;
  try { dev = new VirtualDevice(wt.workerData.vdev); }
  catch (e) { port.postMessage({ t: 'fatal', error: e.message }); process.exit(1); }
  dev.onTx = bytes => port.postMessage({ t: 'tx', bytes }, [bytes.buffer]);
  dev.onEvent = e => port.postMessage({ t: 'event', e });
  port.on('message', m => {
    if (m.t === 'rx') dev.rx(m.bytes);
    else if (m.t === 'req') { let r; try { r = { ok: true, v: dev.handle(m.q) }; } catch (e) { r = { ok: false, error: e.message }; } port.postMessage(Object.assign({ t: 'reply', id: m.id }, r)); }
  });
  dev.start();
  port.postMessage({ t: 'ready', hello: dev.hello() });
}

module.exports = { VirtualDevice, FirmataSniffer, DEFAULT_HEX };
