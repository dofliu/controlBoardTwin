// 虛擬 ESP32（雲端虛擬硬體第 6 階段）：**協定模型，不是實際韌體**。
// 這是一段 JS 程式，照 tools/firmware/DofLabFirmata/DofLabFirmata.ino（ESP32 分支）逐段寫出相同的行為：
// 腳位表（pinValid、只能輸入的 GPIO34–39、類比通道 32/33/34/35/36/39）、訊息解析、能力／類比對應／腳位狀態回覆、
// 數位回報（有變化才送）、類比回報（每 50 ms、12 位元）、伺服（544–2400 µs）、超音波（F0 62／F0 63，每 60 ms、逾時 30 ms、最多 400 cm）、
// 斷線保護（1.2 起：有輸出時 3 秒沒收到位元組就關掉輸出，送出 F0 64 F7）。
// 和虛擬 Uno 不同：虛擬 Uno 跑的是編譯好的 .hex（真的機器碼）；這裡沒有 Xtensa 模擬，韌體的錯誤**不會**在這裡出現。
// 在這裡通過只能寫「已在虛擬設備（協定模型）驗證，未以實體設備驗證」。
// 介面與虛擬 Uno 的 VirtualUno 相容（工作台 bench.js 用的那幾個方法）：時間單位也一樣是 1/16 µs（cycle），工作台不用改時序。
// 模型假設（實物不一定如此，未驗證）：
//   - 開機到送出版本約 BOOT_MS（實物依開機程式與 Flash 設定而定）；開機中收到的位元組丟掉。
//   - 序列埠收到的位元組立刻處理（不模擬 57600 bps 的傳輸時間；ESP32 的 loop 很快，通常在 1 ms 內處理）。
//   - 伺服脈寬 = Arduino map() 的整數微秒（ESP32Servo 實際以 LEDC 計時器量化，誤差小於 1 µs）；附加後、還沒寫角度前輸出 1500 µs。
//     附加後在下一個 20 ms 週期才開始輸出脈衝（和虛擬 Uno 上真韌體的 Servo 函式庫相同）；實體 ESP32 的 LEDC 會不會在附加當下先送一個 1500 µs 的脈衝，未驗證。
//   - ADC 線性：0–3.3 V → 0–4095（實際 ESP32 的 ADC 在兩端非線性）；沒有接東西的類比腳讀 0。
//   - 沒有上拉、沒有接東西的輸入腳讀 LOW（實物會浮動）。
//   - DTR／RTS 不會重新啟動（DevKit 的自動重置電路依時序而定；這裡不模擬）。只有故障注入的 RESET 會重新啟動。
const { PinState } = require('avr8js');

const TICKS_PER_MS = 16000;   // 與虛擬 Uno 相同：1 cycle = 1/16 µs
const BOOT_MS = 300;
const ANALOG_CHANNELS = 6;
const M = { INPUT: 0, OUTPUT: 1, ANALOG: 2, SERVO: 4, PULLUP: 0x0B, SONAR: 0x0C, UNSET: 0x7F };
const MAX_SONARS = 2, SONAR_PERIOD_MS = 60, SONAR_TIMEOUT_US = 30000, SONAR_MAX_CM = 400;
const OUTPUT_GUARD_MS = 3000;   // 斷線保護（和韌體相同）
const SERVO_MIN_US = 544, SERVO_MAX_US = 2400, SERVO_PERIOD_US = 20000, SERVO_DEFAULT_US = 1500;
const ADC_PINS = [32, 33, 34, 35, 36, 39];
const RESET = { PORF: 1, EXTRF: 2, BORF: 4, WDRF: 8 };

const pinValid = p => p <= 5 || (p >= 12 && p <= 19) || (p >= 21 && p <= 23) || (p >= 25 && p <= 27) || (p >= 32 && p <= 36) || p === 39;
// 腳位表（和韌體的 #if 兩個分支相同）。uno 只用來驗證這個模型：同一段 Firmata 訊息送給「Uno 腳位表的模型」與「虛擬 Uno 上的真韌體」，回覆要逐位元組相同
const PROFILES = {
  esp32: { total: 40, valid: pinValid, inputOnly: p => p >= 34, toAnalog: p => ADC_PINS.indexOf(p), adcPin: ch => ADC_PINS[ch], adcBits: 12, vref: 3.3, maxServos: 8, analogKey: p => p },
  uno: { total: 20, valid: p => p < 20, inputOnly: () => false, toAnalog: p => p >= 14 ? p - 14 : -1, adcPin: ch => 14 + ch, adcBits: 10, vref: 5, maxServos: 6, analogKey: p => p - 14 }
};
const arduinoMap = (x, a, b, c, d) => Math.trunc((x - a) * (d - c) / (b - a)) + c;

class VirtualEsp32 {
  // opts.board：'esp32'（預設）或 'esp32doit'（同一顆晶片、同一份韌體）；opts.profile：腳位表（'uno' 只給驗證測試用）
  constructor(opts) {
    opts = opts || {};
    this.board = opts.board || 'esp32'; this.P = PROFILES[opts.profile || 'esp32'];
    this.cycle = 0; this.sched = []; this.pinWatchers = []; this.inputs = {}; this.analog = {};
    this.onSerial = null; this.resets = []; this.spmLog = { erase: 0, write: 0 };
    this.boot(RESET.PORF);
  }
  get timeMs() { return this.cycle / TICKS_PER_MS; }
  get us() { return this.cycle / 16; }
  // ---------- 時間與排程（工作台也用） ----------
  at(cycle, fn) { const e = { at: cycle, fn }; let i = this.sched.length; while (i > 0 && this.sched[i - 1].at > cycle) i--; this.sched.splice(i, 0, e); }
  later(us, fn) { const g = this.gen; this.at(this.cycle + Math.max(1, Math.ceil(us * 16)), () => { if (g === this.gen) fn(); }); }   // 韌體自己的排程：重新開機後作廢；進位，才不會比預定時間早一點點
  runMs(ms) {
    const end = this.cycle + Math.round(ms * TICKS_PER_MS);
    while (this.sched.length && this.sched[0].at <= end) { const e = this.sched.shift(); this.cycle = Math.max(this.cycle, e.at); e.fn(); }
    this.cycle = end;
  }
  // ---------- 開機與重置 ----------
  boot(flags) {
    this.gen = (this.gen || 0) + 1; this.running = false;
    this.mode = new Array(this.P.total).fill(M.UNSET); this.state = new Array(this.P.total).fill(0);
    this.hw = new Array(this.P.total).fill('input'); this.out = new Array(this.P.total).fill(false);
    this.servoOf = new Array(this.P.total).fill(-1); this.servoUs = {}; this.servoTrain = {};
    this.sonar = Array.from({ length: MAX_SONARS }, () => ({ on: false }));
    const ports = Math.ceil(this.P.total / 8); this.reportPort = new Array(ports).fill(0); this.lastPort = new Array(ports).fill(0);
    this.reportAnalog = 0; this.lastAnalog = 0; this.analogTimer = false;
    this.buf = []; this.sysex = false; this.cmd = 0; this.need = 0; this.lastRx = 0;
    this.resets.push({ flags, at: this.cycle });
    this.notify();
    this.later(BOOT_MS * 1000, () => {   // setup()
      for (let p = 0; p < this.P.total; p++) { this.mode[p] = this.P.valid(p) ? M.INPUT : M.UNSET; this.state[p] = 0; this.servoOf[p] = -1; }
      this.running = true; this.sendVersion(); this.sendFirmware();
    });
  }
  reset(flags) { this.boot(flags || RESET.EXTRF); }
  // ---------- 腳位（工作台用） ----------
  setInput(pin, high) { this.inputs[pin] = !!high; this.notify(); this.react(); }
  release(pin) { delete this.inputs[pin]; this.notify(); this.react(); }
  setAnalog(key, volts) { this.analog[key] = volts; }   // ESP32 以 GPIO 編號指定；Uno 腳位表以類比通道編號（和 VirtualUno 相同）
  pinState(pin) {
    if (this.hw[pin] === 'output') return this.out[pin] ? PinState.High : PinState.Low;
    return this.hw[pin] === 'pullup' ? PinState.InputPullUp : PinState.Input;
  }
  isHigh(pin) { return this.pinState(pin) === PinState.High; }
  notify() { for (const w of this.pinWatchers) w(); }
  digitalRead(p) {
    if (this.hw[p] === 'output') return this.out[p];
    if (this.inputs[p] !== undefined) return this.inputs[p];
    return this.hw[p] === 'pullup';
  }
  analogRead(p) { const max = (1 << this.P.adcBits) - 1, v = this.analog[this.P.analogKey(p)] || 0; return Math.max(0, Math.min(max, Math.round(v / this.P.vref * max))); }
  drive(p, high) { if (this.hw[p] === 'output' && this.out[p] === high) return; this.hw[p] = 'output'; this.out[p] = high; this.notify(); }
  setHw(p, m) { if (this.hw[p] === m) return; this.hw[p] = m; if (m !== 'output') this.out[p] = false; this.notify(); }
  // 腳位變化後，韌體的 loop() 會看到的事：超音波的 ECHO、有變化的數位埠
  react() { if (!this.running) return; this.sonarPoll(); this.scanPorts(); }
  // ---------- 序列埠 ----------
  write(...bytes) { for (const b of bytes) this.onSerial && this.onSerial(b & 0xFF); }
  sendBytes(bytes) {
    if (!this.running || !bytes.length) return;   // 開機中收到的位元組丟掉；沒有位元組就不算收到（斷線保護看的是最後收到位元組的時間）
    for (const b of bytes) this.parse(b);
    const at = this.lastRx = this.timeMs; this.later(OUTPUT_GUARD_MS * 1000, () => { if (this.lastRx === at) this.outputGuard(); });
  }
  // 斷線保護（韌體 1.2）：有輸出時 OUTPUT_GUARD_MS 內沒收到位元組 → 數位輸出寫 LOW 再改成輸入、伺服停止並改成輸入；有關掉東西才送 F0 64 F7
  outputGuard() {
    if (this.timeMs - this.lastRx < OUTPUT_GUARD_MS) return;
    let any = false;
    for (let p = 0; p < this.P.total; p++) {
      if (this.mode[p] !== M.OUTPUT && this.mode[p] !== M.SERVO) continue;
      any = true;
      if (this.mode[p] === M.OUTPUT) this.drive(p, false);
      this.detachServo(p); this.setHw(p, 'input'); this.mode[p] = M.INPUT; this.state[p] = 0;
    }
    if (any) { this.write(0xF0, 0x64, 0xF7); this.react(); }
  }
  sendVersion() { this.write(0xF9, 2, 6); }
  sendFirmware() { this.write(0xF0, 0x79, 1, 2); for (const c of 'DofLabFirmata') this.write(c.charCodeAt(0) & 0x7F, 0); this.write(0xF7); }
  readPort(port) {
    let v = 0;
    for (let i = 0; i < 8; i++) {
      const p = port * 8 + i; if (p >= this.P.total || !this.P.valid(p)) continue;
      if (this.mode[p] === M.INPUT || this.mode[p] === M.PULLUP) { if (this.digitalRead(p)) v |= 1 << i; }
      else if (this.mode[p] === M.OUTPUT && this.state[p]) v |= 1 << i;
    }
    return v;
  }
  sendPort(port) { const v = this.readPort(port); this.write(0x90 | port, v & 0x7F, v >> 7); this.lastPort[port] = v; }
  scanPorts() { for (let port = 0; port < this.reportPort.length; port++) if (this.reportPort[port] && this.readPort(port) !== this.lastPort[port]) this.sendPort(port); }
  // ---------- 伺服：附加後每 20 ms 一個脈衝 ----------
  detachServo(p) { if (this.servoOf[p] >= 0) { this.servoOf[p] = -1; delete this.servoUs[p]; this.drive(p, false); } }
  servoPulse(p, train) {
    if (train === undefined) train = this.servoTrain[p] = (this.servoTrain[p] || 0) + 1;   // 重新附加時舊的脈衝序列作廢
    if (this.servoOf[p] < 0 || train !== this.servoTrain[p]) return;
    this.drive(p, true);
    const w = this.servoUs[p];
    this.later(w, () => { if (this.servoOf[p] >= 0 && train === this.servoTrain[p]) this.drive(p, false); });
    this.later(SERVO_PERIOD_US, () => this.servoPulse(p, train));
  }
  // ---------- Firmata 訊息 ----------
  setMode(p, m) {
    if (p >= this.P.total || !this.P.valid(p)) return;
    if (this.P.inputOnly(p) && (m === M.OUTPUT || m === M.SERVO || m === M.PULLUP)) return;
    if (m !== M.SERVO) this.detachServo(p);
    if (m === M.INPUT) this.setHw(p, 'input');
    else if (m === M.PULLUP) this.setHw(p, 'pullup');
    else if (m === M.OUTPUT) { this.drive(p, false); this.state[p] = 0; }
    else if (m === M.ANALOG) { if (this.P.toAnalog(p) < 0) return; this.setHw(p, 'input'); }
    else if (m === M.SERVO) {
      if (this.servoOf[p] < 0) { for (let i = 0; i < this.P.maxServos; i++) if (!this.servoOf.includes(i)) { this.servoOf[p] = i; break; } }
      if (this.servoOf[p] < 0) return;
      if (this.servoUs[p] === undefined) {   // 剛附加：下一個 20 ms 週期才開始輸出（模型假設，見檔案開頭），同一批訊息裡的角度先生效
        this.servoUs[p] = SERVO_DEFAULT_US; this.mode[p] = m;
        const train = this.servoTrain[p] = (this.servoTrain[p] || 0) + 1; this.later(SERVO_PERIOD_US, () => this.servoPulse(p, train)); return;
      }
    } else return;
    this.mode[p] = m;
    this.react();
  }
  setValue(p, v) {
    if (p >= this.P.total) return;
    if (this.mode[p] === M.OUTPUT) { this.state[p] = v ? 1 : 0; this.drive(p, !!v); this.react(); }
    else if (this.mode[p] === M.SERVO && this.servoOf[p] >= 0) { if (v > 180) v = 180; this.state[p] = v; this.servoUs[p] = arduinoMap(v, 0, 180, SERVO_MIN_US, SERVO_MAX_US); }
  }
  // ---------- 超音波：和韌體相同的狀態機（0 等待、1 觸發後等 ECHO 變高、2 量 ECHO 寬度） ----------
  sendSonar(i, cm) { this.write(0xF0, 0x63, this.sonar[i].trig, cm & 0x7F, (cm >> 7) & 0x7F, 0xF7); }
  sonarStop() { for (const s of this.sonar) if (s.on) { s.on = false; this.setHw(s.trig, 'input'); this.mode[s.trig] = M.INPUT; this.mode[s.echo] = M.INPUT; } }
  sonarConfig(trig, echo) {
    if (trig === 0x7F) { this.sonarStop(); return; }
    if (trig >= this.P.total || echo >= this.P.total || !this.P.valid(trig) || !this.P.valid(echo) || trig === echo || this.P.inputOnly(trig)) return;
    let slot = this.sonar.findIndex(s => s.on && s.trig === trig);
    if (slot < 0) slot = this.sonar.findIndex(s => !s.on);
    if (slot < 0) return;
    this.detachServo(trig); this.detachServo(echo);
    this.drive(trig, false); this.setHw(echo, 'input');
    this.mode[trig] = M.SONAR; this.mode[echo] = M.SONAR;
    Object.assign(this.sonar[slot], { on: true, trig, echo, state: 0, due: this.timeMs, t0: 0, n: (this.sonar[slot].n || 0) + 1 });
    this.sonarPoll();
  }
  sonarPoll() {
    for (let i = 0; i < MAX_SONARS; i++) {
      const s = this.sonar[i]; if (!s.on) continue;
      const echo = this.digitalRead(s.echo);
      if (s.state === 1) { if (echo) { s.t0 = this.us; s.state = 2; this.sonarTimeout(i); } }
      else if (s.state === 2 && !echo) { const cm = Math.floor((this.us - s.t0) / 58); this.sendSonar(i, Math.min(cm, SONAR_MAX_CM)); s.state = 0; }
      if (s.state === 0 && !echo) {
        if (this.timeMs >= s.due) this.sonarFire(i);
        else if (s.wake !== s.due) { s.wake = s.due; const due = s.due; this.later((due - this.timeMs) * 1000, () => { if (s.wake === due) s.wake = null; if (s.on && s.due === due) this.sonarPoll(); }); }
      }
    }
  }
  sonarFire(i) {
    const s = this.sonar[i]; s.due = this.timeMs + SONAR_PERIOD_MS; s.state = -1;
    this.drive(s.trig, true);
    this.later(10, () => {
      if (!s.on) return;
      this.drive(s.trig, false); s.t0 = this.us; s.state = 1; this.sonarTimeout(i);
      this.sonarPoll();
    });
  }
  // 逾時：state 1 或 2 持續超過 30 ms → 回報 400 cm
  sonarTimeout(i) {
    const s = this.sonar[i], t0 = s.t0, st = s.state;
    this.later(SONAR_TIMEOUT_US + 1, () => { if (s.on && s.state === st && s.t0 === t0) { this.sendSonar(i, SONAR_MAX_CM); s.state = 0; this.sonarPoll(); } });
  }
  // ---------- 類比回報：每 50 ms ----------
  analogTick() {
    if (!this.reportAnalog) { this.analogTimer = false; return; }
    const now = this.timeMs;
    if (now - this.lastAnalog >= 50) {
      this.lastAnalog = now;
      for (let ch = 0; ch < ANALOG_CHANNELS; ch++) if (this.reportAnalog & (1 << ch)) { const v = this.analogRead(this.P.adcPin(ch)); this.write(0xE0 | ch, v & 0x7F, v >> 7); }
    }
    this.analogTimer = true; this.later((this.lastAnalog + 50 - this.timeMs) * 1000, () => this.analogTick());
  }
  resetAll() {
    this.sonarStop();
    for (let p = 0; p < this.P.total; p++) {
      if (this.mode[p] === M.SERVO) this.detachServo(p);
      if (this.P.valid(p) && this.mode[p] !== M.UNSET && p > 1) this.setHw(p, 'input');
      this.mode[p] = this.P.valid(p) ? M.INPUT : M.UNSET; this.state[p] = 0; this.servoOf[p] = -1;
    }
    this.reportPort.fill(0); this.lastPort.fill(0); this.reportAnalog = 0;
  }
  handleSysex() {
    const b = this.buf, c = b[0];
    if (c === 0x79) this.sendFirmware();
    else if (c === 0x6B) {
      const o = [0xF0, 0x6C];
      for (let p = 0; p < this.P.total; p++) {
        if (this.P.valid(p) && p > 1) {
          o.push(M.INPUT, 1);
          if (!this.P.inputOnly(p)) o.push(M.OUTPUT, 1, M.PULLUP, 1, M.SERVO, 14);
          if (this.P.toAnalog(p) >= 0) o.push(M.ANALOG, this.P.adcBits);
        }
        o.push(0x7F);
      }
      this.write(...o, 0xF7);
    } else if (c === 0x69) { this.write(0xF0, 0x6A); for (let p = 0; p < this.P.total; p++) { const a = this.P.toAnalog(p); this.write(a >= 0 ? a : 0x7F); } this.write(0xF7); }
    else if (c === 0x6D && b.length >= 2) {
      const p = b[1]; if (p >= this.P.total) return;
      let st = this.mode[p] === M.OUTPUT ? (this.digitalRead(p) ? 1 : 0) : this.state[p];
      if (this.mode[p] === M.INPUT || this.mode[p] === M.PULLUP) st = this.digitalRead(p) ? 1 : 0;
      const o = [0xF0, 0x6E, p, this.mode[p], st & 0x7F]; if (st > 127) o.push(st >> 7); this.write(...o, 0xF7);
    } else if (c === 0x62 && b.length >= 2) this.sonarConfig(b[1], b.length >= 3 ? b[2] : 0x7F);
    else if (c === 0x6F && b.length >= 3) this.setValue(b[1], b[2] | (b.length > 3 ? b[3] << 7 : 0));
  }
  handleMsg() {
    const cmd = this.cmd, hi = cmd & 0xF0, lo = cmd & 0x0F, b = this.buf;
    if (cmd === 0xF4) this.setMode(b[0], b[1]);
    else if (cmd === 0xF5) this.setValue(b[0], b[1]);
    else if (hi === 0xD0) { if (lo < this.reportPort.length) { this.reportPort[lo] = b[0]; if (b[0]) this.sendPort(lo); } }
    else if (hi === 0xC0) { if (lo < ANALOG_CHANNELS) { if (b[0]) this.reportAnalog |= 1 << lo; else this.reportAnalog &= ~(1 << lo); if (this.reportAnalog && !this.analogTimer) this.analogTick(); } }
    else if (hi === 0xE0) this.setValue(lo, b[0] | (b[1] << 7));
    else if (hi === 0x90) { for (let i = 0; i < 8; i++) { const p = lo * 8 + i; if (p < this.P.total && this.mode[p] === M.OUTPUT) this.setValue(p, ((b[0] | b[1] << 7) >> i) & 1); } }
  }
  parse(x) {
    if (this.sysex) { if (x === 0xF7) { this.sysex = false; this.handleSysex(); } else if (this.buf.length < 32) this.buf.push(x); return; }
    if (x === 0xF0) { this.sysex = true; this.buf = []; return; }
    if (x & 0x80) {
      this.cmd = x; this.buf = [];
      if (x === 0xF9) { this.sendVersion(); this.need = 0; return; }
      if (x === 0xFF) { this.resetAll(); this.need = 0; return; }
      const hi = x & 0xF0;
      this.need = (x === 0xF4 || x === 0xF5 || hi === 0xE0 || hi === 0x90) ? 2 : (hi === 0xC0 || hi === 0xD0) ? 1 : 0;
      return;
    }
    if (!this.need) return;
    this.buf.push(x);
    if (this.buf.length >= this.need) { this.handleMsg(); this.need = 0; this.buf = []; }
  }
}

module.exports = { VirtualEsp32, pinValid, ADC_PINS, BOOT_MS, RESET, PROFILES };
