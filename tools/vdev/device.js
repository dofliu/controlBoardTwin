// 一台虛擬設備：avr8js 虛擬 Uno（跑真的 .hex）＋工作台＋即時時鐘＋收到的 Firmata 位元組紀錄。
// 第 6 階段：board 為 esp32 時改用 ESP32 協定模型（esp32model.js：行為和 DofLabFirmata 相同的 JS 程式，不是實際韌體；沒有開機程式、不能上傳）。
// 由 server.js 放在自己的 worker thread 裡執行（每台設備一個），晶片模擬不會卡住網路。
// 時間：晶片時間以 1 倍速對齊實際時間；CPU 跟不上時晶片時間會落後（state().realtime 顯示比例），不會跳過指令。
const fs = require('fs'); const path = require('path');
const { VirtualUno, RESET, loadHex, FREQ } = require('./avrsim');
const { Bench, DEFAULT_BENCH } = require('./bench');
const { VirtualEsp32, pinValid: esp32PinValid } = require('./esp32model');
const ESP32_NOTE = '虛擬設備：ESP32 協定模型（行為和 DofLabFirmata 相同的 JS 程式），不是實際韌體，也不是實體板子';

const FIXTURES = path.join(__dirname, '..', '..', 'tests', 'fixtures');
const DEFAULT_HEX = path.join(FIXTURES, 'DofLabFirmata-uno.hex');
// Arduino 官方 Optiboot（與實體 Uno 出廠的開機程式相同）：DTR 重置後等待約 1 秒接收 STK500 上傳，沒有就執行應用程式（第 4 階段）
const OPTIBOOT_HEX = path.join(FIXTURES, 'optiboot_atmega328.hex');
const APP_WORDS = 0x3F00;   // 應用程式區（開機程式區之前）
const sha = buf => require('crypto').createHash('sha256').update(buf).digest('hex');
// 快閃記憶體應用程式區的雜湊（不認得的程式用它識別）
const appHash = flash => sha(Buffer.from(flash.buffer, flash.byteOffset, APP_WORDS * 2));
// hex → 快閃記憶體映像（補滿到整頁 128 位元組）。Optiboot 只寫上傳的那幾頁、不會整片抹除，後面可能留著舊程式，所以比對時只比映像的長度
function image(hexText) { const f = new Uint16Array(0x4000).fill(0xffff); loadHex(hexText, f); const b = new Uint8Array(f.buffer); let n = APP_WORDS * 2; while (n > 0 && b[n - 1] === 0xff) n--; return b.slice(0, Math.ceil(n / 128) * 128); }

// 解析「介面送給設備」的 Firmata 位元組，只用來記錄與驗收（例如「唯讀期間沒有任何寫入」），不改變傳送內容
class FirmataSniffer {
  constructor(clock) { this.clock = clock || null; this.reset(); }   // clock：設備時間（ms），寫入紀錄附上收到的時刻
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
  write(kind, pin, v) { const w = { kind, pin, v }; if (this.clock) w.devMs = Math.round(this.clock() * 10) / 10; this.c.writes.push(w); if (this.c.writes.length > 200) this.c.writes.shift(); this.c.writeCount = (this.c.writeCount || 0) + 1; }
  // 輸出模式：OUTPUT(1)、PWM(3)、SERVO(4)
  summary() { const c = this.c; return { bytes: c.bytes, queries: c.queries, reports: c.reports, sysex: c.sysex, modes: c.modes.slice(-50), outputModes: c.modes.filter(m => [1, 3, 4].includes(m[1])).length, writeCount: c.writeCount || 0, writes: c.writes.slice(-20) }; }
}

class VirtualDevice {
  // opts：{ id, hex（路徑或 hex 文字）, bench（工作台規格）, speed（1 = 即時） }
  constructor(opts) {
    opts = opts || {};
    this.id = opts.id || 'uno-1'; this.board = opts.board || 'uno';
    this.uploads = 0; this.seenResets = 0; this.seenSpm = 0; this.resetLog = [];
    if (this.board === 'esp32' || this.board === 'esp32doit') {
      this.uno = new VirtualEsp32({ board: this.board }); this.known = [];
      this.firmware = { name: 'DofLabFirmata', model: '協定模型', note: '協定模型（JS），不是實際韌體', uploaded: false, bootloader: null };
    } else if (this.board === 'uno') this.initUno(opts);
    else throw new Error(`虛擬設備不支援板型 ${this.board}（樹莓派由 pihost.js 啟動 pi_bridge）`);
    this.bench = new Bench(this.uno, opts.bench || (this.board === 'uno' ? DEFAULT_BENCH : 'esp32-hold-blink'));
    this.speed = opts.speed || 1;
    const clock = () => this.uno.timeMs; this.sniff = new FirmataSniffer(clock); this.total = new FirmataSniffer(clock);
    this.tx = []; this.onTx = null; this.onEvent = null;
    this.uno.onSerial = b => this.tx.push(b);
    this.dtr = null; this.links = 0; this.linked = false; this.resets = 0;
  }
  initUno(opts) {
    const hexPath = opts.hex || DEFAULT_HEX;
    this.hexText = String(hexPath).startsWith(':') ? hexPath : fs.readFileSync(hexPath, 'utf8');
    const name0 = opts.firmwareName || (/DofLabFirmata/.test(hexPath) ? 'DofLabFirmata' : path.basename(String(hexPath)).replace(/\.hex$/, ''));
    // 認得的程式（依快閃記憶體內容）：開機時的韌體、DofLabFirmata；其他都是「上傳的程式」
    this.known = [{ name: 'DofLabFirmata', img: image(fs.readFileSync(DEFAULT_HEX, 'utf8')) }, { name: name0, img: image(this.hexText) }];
    const boot = opts.bootloader === false ? null : fs.readFileSync(opts.bootloader || OPTIBOOT_HEX, 'utf8');
    this.uno = new VirtualUno(this.hexText, { bootloader: boot });
    this.firmware = this.identify();
  }
  // 介面送來的位元組（序列埠的 RX）
  rx(bytes) { this.sniff.feed(bytes); this.total.feed(bytes); this.uno.sendBytes(bytes); }
  // USB 晶片的控制線：DTR 由「未啟用」變成「啟用」時，Uno 的 RESET 腳經電容收到脈衝 → 晶片重置（與實體 Uno 相同）
  // ESP32 協定模型不模擬 DevKit 的自動重置電路：DTR／RTS 只記錄，不重新啟動
  signals(s) {
    if (this.board !== 'uno') { if (s && typeof s.dtr === 'boolean') this.dtr = s.dtr; return; }
    if (s && typeof s.dtr === 'boolean') { if (s.dtr && this.dtr === false) this.reset('DTR 觸發重置（與 Arduino IDE 開啟序列埠相同）'); this.dtr = s.dtr; }
  }
  // 現在快閃記憶體裡的程式：{ name, sha256（應用程式區）, uploaded（是否經 STK500 上傳）}
  identify() {
    if (this.board !== 'uno') return this.firmware;
    const f = new Uint8Array(this.uno.flash.buffer); const same = img => img.every((v, i) => f[i] === v);
    const k = this.known.find(x => same(x.img));
    return { name: k ? k.name : '上傳的程式', sha256: k ? sha(k.img) : appHash(this.uno.flash), uploaded: this.uploads > 0, bootloader: this.uno.bootloader ? 'Optiboot' : null };
  }
  // 檢查晶片的重置紀錄：Optiboot 寫入快閃記憶體後以看門狗重置離開 → 視為「上傳完成」，更新韌體識別並發出事件
  checkResets() {
    const r = this.uno.resets; if (r.length === this.seenResets) return;
    for (let i = this.seenResets; i < r.length; i++) { this.resetLog.push({ devMs: Math.round(r[i].at / FREQ * 1e4) / 10, flags: r[i].flags }); if (this.resetLog.length > 50) this.resetLog.shift(); }
    this.seenResets = r.length; this.bench.onReset();
    const spm = this.uno.spmLog.write;
    if (spm !== this.seenSpm && r[r.length - 1].flags === RESET.WDRF) {
      const pages = spm - this.seenSpm; this.seenSpm = spm; this.uploads++; this.firmware = this.identify();
      this.bench.note('chip', 'upload', { pages, firmware: this.firmware.name });
      this.event({ kind: 'upload', text: `收到新程式（Optiboot 寫入 ${pages} 頁）：${this.firmware.name}，已重新啟動執行`, firmware: this.firmware });
    }
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
      this.checkResets(); this.flush();
      this.window.push([wall, this.uno.timeMs]); while (this.window.length > 2 && wall - this.window[0][0] > 3000) this.window.shift();
    }, 4);
  }
  stop() { clearInterval(this.timer); }
  realtime() { const w = this.window || []; if (w.length < 2) return null; const a = w[0], b = w[w.length - 1]; return b[0] > a[0] ? Math.round((b[1] - a[1]) / (b[0] - a[0]) * 100) / 100 : null; }
  pins() { const out = {}; for (let n = 0; n < (this.board === 'uno' ? 20 : 40); n++) { if (this.board !== 'uno' && !esp32PinValid(n)) continue; const s = this.uno.pinState(n); out[n] = ['low', 'high', 'input', 'input-pullup'][s] || String(s); } return out; }
  state() {
    return { id: this.id, kind: 'virtual', board: this.board, model: this.board === 'uno' ? 'avr8js' : 'protocol', note: this.board === 'uno' ? null : ESP32_NOTE, firmware: this.firmware, uploads: this.uploads, devMs: Math.round(this.uno.timeMs), realtime: this.realtime(), lagResets: this.lagResets || 0, resets: this.resets, linked: this.linked, links: this.links, pins: this.pins(), bench: this.bench.state(), traffic: this.sniff.summary(), trafficTotal: this.total.summary() };
  }
  // 主執行緒的查詢與工作台操作
  handle(q) {
    if (q.op === 'state') return this.state();
    if (q.op === 'time') return { devMs: Math.round(this.uno.timeMs) };
    if (q.op === 'bench') { const r = this.bench.act(q); const st = this.state(); if (r && r.scheduled !== undefined) st.scheduled = r.scheduled; return st; }
    if (q.op === 'link') { this.link(); return this.hello(); }
    if (q.op === 'hello') return this.hello();   // 第二個以後的連線：只要識別資料，不重設紀錄
    if (q.op === 'unlink') { this.unlink(); return {}; }
    if (q.op === 'signals') { this.signals(q); return {}; }
    // 輸出軌跡（第 4 階段驗收用）：工作台記下的輸入操作與 LED／伺服變化（設備時間），以及晶片重置紀錄
    if (q.op === 'trace') { const t = { trace: this.bench.trace.slice(), resets: this.resetLog.slice(), firmware: this.firmware, devMs: Math.round(this.uno.timeMs) }; if (q.clear) this.bench.trace.length = 0; return t; }
    // 故障注入（第 3 階段）：按 RESET 鍵、電壓瞬間掉太低（brown-out）。晶片重新開機，快閃記憶體裡的韌體不變
    if (q.op === 'fault' && q.fault === 'reset') { this.reset('有人按了 RESET 鍵（故障注入）', RESET.EXTRF); return this.state(); }
    if (q.op === 'fault' && q.fault === 'brownout') { this.reset('電壓瞬間掉太低（brown-out，故障注入）', RESET.BORF); return this.state(); }
    throw new Error('未知的查詢 ' + q.op);
  }
  hello() {
    const h = { kind: 'virtual', board: this.board, device: this.id, firmware: this.firmware, bench: this.bench.spec.id, benchName: this.bench.spec.name, clock: 'virtual', speed: this.speed, mcu: 'ATmega328P（avr8js 模擬）' };
    if (this.board !== 'uno') Object.assign(h, { mcu: 'ESP32（協定模型，不模擬 Xtensa 指令）', model: 'protocol', note: ESP32_NOTE });
    return h;
  }
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

module.exports = { VirtualDevice, FirmataSniffer, DEFAULT_HEX, OPTIBOOT_HEX };
