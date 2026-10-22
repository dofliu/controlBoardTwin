// 虛擬 Arduino Uno：用 avr8js（開源 ATmega328P 模擬器）執行「真正編譯出來的 .hex」
// 用途：在沒有實體板子時，驗證 Firmata 驅動與產生程式在真實韌體上的行為。
// 限制：模擬的是 MCU 指令與周邊（計時器、USART、GPIO、ADC），不模擬電氣特性、USB 晶片或燒錄流程。
const avr = require('avr8js');

const FREQ = 16e6;

function loadHex(text, into) {
  const prog = into ? new Uint8Array(into.buffer) : new Uint8Array(0x8000).fill(0xff);
  let base = 0;
  for (const line of text.split('\n')) {
    if (line[0] !== ':') continue;
    const n = parseInt(line.substr(1, 2), 16), addr = parseInt(line.substr(3, 4), 16), type = parseInt(line.substr(7, 2), 16);
    if (type === 2) { base = parseInt(line.substr(9, 4), 16) << 4; continue; }
    if (type !== 0) continue;
    for (let i = 0; i < n; i++) prog[base + addr + i] = parseInt(line.substr(9 + i * 2, 2), 16);
  }
  return into || new Uint16Array(prog.buffer);
}
const BOOT_WORD = 0x3F00;   // Optiboot 位於 0x7E00（BOOTRST 熔絲：重置後從這裡開始執行）
const MCUSR = 0x54, SPMCSR = 0x57;
const RESET = { PORF: 0x01, EXTRF: 0x02, WDRF: 0x08 };

// Uno 腳位 → (port, bit)
const PIN = n => n < 8 ? ['D', n] : n < 14 ? ['B', n - 8] : ['C', n - 14];

class VirtualUno {
  // hex：應用程式（檔案路徑或 hex 文字，可省略）；opts.bootloader：Optiboot 的 hex 文字（有的話模擬「有燒錄器的 Uno」）
  constructor(hexPath, opts) {
    opts = opts || {};
    this.flash = new Uint16Array(0x4000).fill(0xffff);
    if (hexPath) { const text = String(hexPath).startsWith(':') ? hexPath : require('fs').readFileSync(hexPath, 'utf8'); loadHex(text, this.flash); }   // 可直接給 hex 內容（瀏覽器測試用）
    this.bootloader = !!opts.bootloader;
    if (opts.bootloader) loadHex(opts.bootloader, this.flash);
    this.onSerial = null; this.rxQueue = []; this.pinWatchers = []; this.inputs = {}; this.analog = {};
    this.millisAddr = opts.millisAddr || null;
    this.resets = []; this.spmBuf = new Uint16Array(64).fill(0xffff); this.spmLog = { erase: 0, write: 0 };
    this.boot(RESET.PORF);
  }
  // 上電或重置：重建 CPU 與周邊（暫存器回到預設值），快閃記憶體內容保留
  boot(flags) {
    const cpu = this.cpu = new avr.CPU(this.flash);
    const clock = new avr.AVRClock(cpu, FREQ, avr.clockConfig);
    this.timers = [avr.timer0Config, avr.timer1Config, avr.timer2Config].map(c => new avr.AVRTimer(cpu, c));
    this.port = { B: new avr.AVRIOPort(cpu, avr.portBConfig), C: new avr.AVRIOPort(cpu, avr.portCConfig), D: new avr.AVRIOPort(cpu, avr.portDConfig) };
    this.adc = new avr.AVRADC(cpu, avr.adcConfig); Object.assign(this.adc.channelValues, this.analog);
    this.usart = new avr.AVRUSART(cpu, avr.usart0Config, FREQ);
    this.watchdog = new avr.AVRWatchdog(cpu, avr.watchdogConfig, clock);
    this.usart.onByteTransmit = b => this.onSerial && this.onSerial(b);
    this.usart.onRxComplete = () => this.feed();
    for (const [name, p] of Object.entries(this.port)) p.addListener(() => { for (const w of this.pinWatchers) w(name); });
    for (const [pin, high] of Object.entries(this.inputs)) { const [pp, b] = PIN(+pin); this.port[pp].setPin(b, high); }
    const r0 = cpu.reset.bind(cpu);
    cpu.reset = () => { r0(); this.pendingReset = RESET.WDRF; };   // 看門狗逾時：下一步重建（與實體晶片相同，暫存器回到預設值）
    if (this.bootloader) cpu.pc = BOOT_WORD;
    cpu.data[MCUSR] = flags;
    this.resets.push({ flags, at: this.cycleBase || 0 });
    for (const w of this.pinWatchers) for (const n of ['B', 'C', 'D']) w(n);
  }
  // 外部重置（RESET 腳拉低，例如 USB 轉序列晶片的 DTR 經電容觸發）
  reset() { this.cycleBase = (this.cycleBase || 0) + this.cpu.cycles; this.rxQueue = []; this.boot(RESET.EXTRF); }
  // SPM：自我燒錄指令（avr8js 沒有實作；Optiboot 用它寫入快閃記憶體）
  spm() {
    const d = this.cpu.data; const ctl = d[SPMCSR] & 0x3f; const z = d[30] | (d[31] << 8);
    if (ctl === 0x01) this.spmBuf[(z >> 1) & 63] = d[0] | (d[1] << 8);                                   // 填入暫存頁
    else if (ctl === 0x03) { const w = (z & ~0x7f) >> 1; if (w < BOOT_WORD) this.flash.fill(0xffff, w, w + 64); this.spmLog.erase++; }   // 抹除頁（不能抹掉開機程式區）
    else if (ctl === 0x05) { const w = (z & ~0x7f) >> 1; if (w < BOOT_WORD) this.flash.set(this.spmBuf, w); this.spmBuf.fill(0xffff); this.spmLog.write++; }   // 寫入頁
    d[SPMCSR] &= ~0x1f; this.cpu.pc += 1; this.cpu.cycles += 4;
  }
  get timeMs() { return ((this.cycleBase || 0) + this.cpu.cycles) / FREQ * 1000; }
  // 送下一個位元組前，等韌體讀走上一個（UCSR0A 的 RXC0 清除）。
  // 真實 ATmega328P 的接收端有 2 級緩衝，可容忍中斷稍有延遲；avr8js 只有 1 級，不等待會造成溢位遺失。
  feed() { if (this.rxQueue.length && this.usart.rxBusy === false && !(this.cpu.data[0xC0] & 0x80)) { this.usart.writeByte(this.rxQueue.shift()); } }
  sendBytes(bytes) { for (const b of bytes) this.rxQueue.push(b); this.feed(); }
  step(cycles) {
    let left = cycles; let k = 0;
    while (left > 0) {
      const cpu = this.cpu; const c0 = cpu.cycles;
      if (this.bootloader && cpu.progMem[cpu.pc] === 0x95e8) this.spm(); else avr.avrInstruction(cpu);
      cpu.tick(); left -= cpu.cycles - c0;
      if (this.pendingReset) { const f = this.pendingReset; this.pendingReset = 0; this.cycleBase = (this.cycleBase || 0) + this.cpu.cycles; this.boot(f); }
      if (this.rxQueue.length && (++k & 63) === 0) this.feed();
    }
    this.feed();
  }
  runMs(ms) { this.step(Math.round(ms / 1000 * FREQ)); }
  // 外部電路：設定輸入腳位的電位（例如按鈕接 GND 時按下 = LOW）
  setInput(pin, high) { this.inputs[pin] = !!high; const [p, b] = PIN(pin); this.port[p].setPin(b, !!high); }
  pinState(pin) { const [p, b] = PIN(pin); return this.port[p].pinState(b); }
  isHigh(pin) { return this.pinState(pin) === avr.PinState.High; }
  setAnalog(ch, volts) { this.analog[ch] = volts; this.adc.channelValues[ch] = volts; }
  millis() { if (this.millisAddr == null) return null; const d = this.cpu.data, a = this.millisAddr; return (d[a] | d[a + 1] << 8 | d[a + 2] << 16 | d[a + 3] << 24) >>> 0; }

  // 偽 Web Serial 連接埠：讓瀏覽器用的 Firmata 驅動直接接到這顆虛擬 MCU
  webSerialPort(realtimeFactor) {
    const self = this; let ctrl = null; let timer = null; let readable = null, writable = null;
    // 每次 open 都建立新的讀寫串流（與實體 Web Serial 一樣，關閉後可以再開）
    const mk = () => {
      readable = new ReadableStream({ start(c) { ctrl = c; } });
      writable = new WritableStream({ write(chunk) { self.sendBytes([...chunk]); } });
      self.onSerial = b => { try { ctrl.enqueue(new Uint8Array([b])); } catch (e) { } };
    };
    mk();
    const port = {
      getInfo: () => ({ usbVendorId: 0x2341, usbProductId: 0x0043, virtual: 'avr8js' }),
      // DTR 由「未啟用」變成「啟用」時，Uno 的 RESET 腳經電容收到一個脈衝 → 晶片重置（上傳程式就是靠這個進入 Optiboot）
      async setSignals(sig) { if (sig && 'dataTerminalReady' in sig) { if (sig.dataTerminalReady && self._dtr === false) self.reset(); self._dtr = !!sig.dataTerminalReady; } },
      get readable() { return readable; }, get writable() { return writable; },
      async open() { if (port.opened) throw new Error('連接埠已經開啟'); if (port.closed) mk(); port.opened = true; port.closed = false; if (port.tick) port.tick(true); else { const k = realtimeFactor || 1; timer = setInterval(() => self.runMs(10 * k), 10); } },
      async close() { clearInterval(timer); if (port.tick) port.tick(false); let n = 0; while (self.rxQueue.length && n++ < 200) self.runMs(1); self.runMs(5); try { ctrl.close(); } catch (e) { } self.onSerial = null; port.opened = false; port.closed = true; },   // 已寫出的位元組會先送完（如同作業系統的序列埠緩衝）
      stop() { clearInterval(timer); if (port.tick) port.tick(false); }
    };
    return port;
  }
}

module.exports = { VirtualUno, loadHex, FREQ, RESET };
