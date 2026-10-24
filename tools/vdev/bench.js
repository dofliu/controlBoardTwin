// 虛擬工作台（bench）：虛擬板子「外面的世界」——實際接了哪些元件、元件怎麼影響腳位。
// 刻意不使用 src/core/engine.js（也不用 src/core 的任何模組）：如果工作台和介面共用同一份模擬，兩邊一定一致，等於自己驗證自己。
// 介面看不到工作台：介面只看得到 Firmata 回報的東西（量測、回讀）。工作台的狀態只給工作台頁、測試與老師看。
// 元件模型都是教學假設，參數寫在工作台規格裡（tools/vdev/benches/*.json），可以調整：
//   button      按下拉到 GND；放開時視為高電位（假設韌體開了內部上拉）。按下與放開各有 0–bounceMs 的隨機彈跳。
//   led         依腳位的實際電位（不是介面的 ACK）判斷亮滅；以 5 V、順向電壓 2.0 V、限流電阻估算電流，超過 20 mA 標示警告。
//   ldr         光敏分壓模組：AO ≈ 5 V × 亮度比例（inverted 時相反），加上 ±noise 的隨機雜訊；10 位元量化由 avr8js 的 ADC 做。
//   ultrasonic  HC-SR04 時序：TRIG ≥ 10 µs 後 460 µs ECHO 變高，寬度 = 距離 × 58 µs；沒有物體或掉回波時 ECHO 維持高電位 38 ms。
//   servo       SG90：從腳位高電位寬度算命令角（544 µs = 0°、2400 µs = 180°，與 Arduino Servo 函式庫預設相同），
//               再以有限速度（預設 600°/s，約 SG90 規格 0.1 s／60°）轉到該角度。**只在工作台顯示，不回報給介面**（SG90 沒有回授）。
//   arm         三軸手臂：三顆 servo 的實際角度 →（各自的零位與方向）→ 關節角，並算出關節位置（只用來畫圖與比對）。
// 故障（第 3 階段）：每個元件都可以「拔線／接回」（unplug／plug）；超音波可以「卡住」（stuck：ECHO 一直是高電位，韌體就不再量測、不再回報）。
const avr = require('avr8js');
const path = require('path'); const fs = require('fs');

const VCC = 5, LED_VF = 2.0;
const PRESET_DIR = path.join(__dirname, 'benches');
const DEFAULT_BENCH = 'hold-blink';
const TYPES = ['button', 'led', 'ldr', 'ultrasonic', 'servo', 'arm'];
const SERVO_MIN_US = 544, SERVO_MAX_US = 2400;

// 可重現的亂數（工作台規格的 seed 一樣，彈跳與雜訊就一樣）
function rng(seed) { let a = (seed >>> 0) || 1; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function presets() { return fs.readdirSync(PRESET_DIR).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort(); }
// 名稱（benches/ 裡的預設）、檔案路徑或規格物件 → 規格物件
function loadSpec(x) {
  if (x && typeof x === 'object') return JSON.parse(JSON.stringify(x));
  const name = x || DEFAULT_BENCH;
  const file = /[\\/]|\.json$/.test(name) ? path.resolve(name) : path.join(PRESET_DIR, name + '.json');
  if (!fs.existsSync(file)) throw new Error(`找不到工作台「${name}」。可用的預設：${presets().join('、')}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
const isPin = n => Number.isInteger(n) && n >= 0 && n <= 19;
const pinName = n => n < 14 ? 'D' + n : 'A' + (n - 14);

class Bench {
  constructor(uno, spec) {
    this.uno = uno; this.spec = loadSpec(spec);
    this.rand = rng(this.spec.seed || 1);
    this.parts = {}; this.log = []; this.watchers = [];
    const used = {};
    const claim = (p, n, what) => {
      if (!isPin(n)) throw new Error(`${p.id} 的${what}腳位 ${n} 不是 Uno 的 D0–D13／A0–A5（14–19）`);
      if (used[n]) throw new Error(`${pinName(n)} 同時接了 ${used[n]} 與 ${p.id}`);
      used[n] = p.id;
    };
    for (const p of this.spec.parts) {
      if (!TYPES.includes(p.type)) throw new Error(`工作台不支援元件類型 ${p.type}（${p.id}）`);
      if (p.type === 'ultrasonic') { claim(p, p.trig, ' TRIG '); claim(p, p.echo, ' ECHO '); }
      else if (p.type === 'ldr') { claim(p, p.pin, '類比'); if (p.pin < 14) throw new Error(`${p.id} 必須接在 A0–A5`); }
      else if (p.type !== 'arm') claim(p, p.pin, '');
      this.parts[p.id] = Object.assign({}, p);
    }
    for (const p of Object.values(this.parts)) this.init(p);
    for (const p of Object.values(this.parts)) if (p.type === 'arm') for (const j of p.joints) if (!this.parts[j.servo] || this.parts[j.servo].type !== 'servo') throw new Error(`${p.id} 的關節用到 ${j.servo}，但工作台上沒有這顆伺服`);
    this.watch(() => this.sense());
    this.tickMs = 2; if (Object.values(this.parts).some(p => p.type === 'ldr')) this.schedTick();   // 只有光敏的雜訊需要定時更新；伺服的轉動用經過的時間算（不排定時，模擬比較快）
    this.sense();
  }
  watch(fn) { this.uno.pinWatchers.push(fn); this.watchers.push(fn); }
  at(ms, fn) { this.uno.at(this.uno.cycle + Math.max(1, Math.round(ms * 16000)), fn); }
  schedTick() { this.at(this.tickMs, () => { this.tick(); this.schedTick(); }); }
  note(part, action, extra) { this.log.push(Object.assign({ devMs: Math.round(this.uno.timeMs * 10) / 10, part, action }, extra || {})); if (this.log.length > 100) this.log.shift(); }

  init(p) {
    if (p.type === 'button') { p.bounceMs = p.bounceMs ?? 8; p.pressed = false; p.level = true; p.edges = 0; p.gen = 0; this.uno.setInput(p.pin, true); }
    else if (p.type === 'led') { p.ohm = p.ohm || 220; p.on = false; p.toggles = 0; p.lastChangeMs = null; }
    else if (p.type === 'ldr') { p.light = p.light ?? 60; p.noise = p.noise ?? 0.01; p.volts = null; this.refreshLdr(p); }
    else if (p.type === 'ultrasonic') { p.cm = p.cm === undefined ? 100 : p.cm; p.drop = p.drop || 0; p.pulses = 0; p.echoes = 0; p.dropped = 0; p.short = 0; this.initSonar(p); }
    else if (p.type === 'servo') { p.speed = p.speed || 600; p.cmd = null; p.angle = p.start ?? null; p.lastPulseMs = null; p.lastMoveMs = null; p.pulseUs = null; p.pulses = 0; p.rise = null; this.initServo(p); }
    else if (p.type === 'arm') { p.H = p.H ?? 7; p.L1 = p.L1 ?? 8; p.L2 = p.L2 ?? 8; }
  }
  // ---------- 光敏模組 ----------
  refreshLdr(p) {
    if (p.unplugged) { p.volts = 0; this.uno.setAnalog(p.pin - 14, 0); return; }   // AO 拔掉：類比腳空接，這裡當成 0 V
    const ratio = Math.max(0, Math.min(100, p.light)) / 100;
    const v = VCC * (p.inverted ? 1 - ratio : ratio) * (1 + (this.rand() * 2 - 1) * p.noise);
    p.volts = Math.max(0, Math.min(VCC, v)); this.uno.setAnalog(p.pin - 14, p.volts);
  }
  // ---------- 超音波 ----------
  initSonar(p) {
    this.uno.setInput(p.echo, false);
    let last = this.uno.isHigh(p.trig), hi = null;
    this.watch(() => {
      const h = this.uno.isHigh(p.trig); if (h === last) return; last = h;
      if (p.unplugged || p.stuck) return;   // 拔線或模組卡住：不回應觸發
      if (h) { hi = this.uno.cycle; return; }
      if (hi === null) return;
      if (this.uno.cycle - hi < 160) { p.short++; return; }   // 觸發脈衝短於 10 µs：模組不動作
      p.pulses++;
      const lost = p.cm === null || this.rand() < p.drop; if (lost && p.cm !== null) p.dropped++; if (!lost) p.echoes++;
      const width = lost ? 38000 : Math.round(p.cm * 58 + 29);
      this.at(0.46, () => this.uno.setInput(p.echo, true)); this.at(0.46 + width / 1000, () => this.uno.setInput(p.echo, false));
    });
  }
  // ---------- 伺服 ----------
  initServo(p) {
    let last = this.uno.isHigh(p.pin);
    this.watch(() => {
      const h = this.uno.isHigh(p.pin); if (h === last) return; last = h;
      if (p.unplugged) { p.rise = null; return; }   // 訊號線拔掉：收不到脈衝
      if (h) { p.rise = this.uno.cycle; return; }
      if (p.rise === null) return;
      const us = (this.uno.cycle - p.rise) / 16; p.rise = null;
      if (us < 400 || us > 2600) return;   // 不是伺服脈衝（例如一般的數位輸出）
      this.moveServo(p);   // 先轉到現在，再換新的命令
      p.pulseUs = Math.round(us); p.pulses++; p.lastPulseMs = this.uno.timeMs; p.lastMoveMs = p.lastPulseMs;
      p.cmd = Math.max(0, Math.min(180, (us - SERVO_MIN_US) / (SERVO_MAX_US - SERVO_MIN_US) * 180));
      if (p.angle === null) p.angle = p.cmd;   // 開機第一個脈衝：假設伺服原本就在那裡（實物會猛轉過去）
    });
  }
  // 每 2 ms（晶片時間）：光敏雜訊
  tick() { for (const p of Object.values(this.parts)) if (p.type === 'ldr') this.refreshLdr(p); }
  // 伺服以有限速度轉向命令角：算到現在為止轉了多少（最後一個脈衝之後 60 ms 不再出力）
  moveServo(p) {
    if (p.cmd === null || p.angle === null || p.lastMoveMs === null) return;
    const until = Math.min(this.uno.timeMs, p.lastPulseMs + 60), dt = until - p.lastMoveMs;
    if (dt > 0) { const step = p.speed * dt / 1000, d = p.cmd - p.angle; p.angle = Math.abs(d) <= step ? p.cmd : p.angle + Math.sign(d) * step; p.lastMoveMs = until; }
  }
  servoPowered(p) { return p.lastPulseMs !== null && this.uno.timeMs - p.lastPulseMs < 60; }   // 超過 60 ms 沒有脈衝：SG90 不再出力，停在原地
  // ---------- 讀晶片腳位（LED） ----------
  sense() {
    for (const p of Object.values(this.parts)) {
      if (p.type !== 'led') continue;
      const on = !p.unplugged && this.uno.pinState(p.pin) === avr.PinState.High;
      if (on !== p.on) { p.on = on; p.toggles++; p.lastChangeMs = this.uno.timeMs; }
    }
  }
  // ---------- 工作台操作 ----------
  // {part, action:'press'|'release'}、{part, action:'set', light}、{part, action:'set', cm（null = 移走物體）}
  act(q) {
    const p = this.parts[q && q.part];
    if (!p) throw new Error(`工作台上沒有元件 ${q && q.part}`);
    if (p.type === 'button' && ['press', 'release'].includes(q.action)) this.press(p, q.action === 'press');
    else if (p.type === 'ldr' && q.action === 'set' && Number.isFinite(+q.light)) { p.light = Math.max(0, Math.min(100, +q.light)); this.refreshLdr(p); this.note(p.id, 'set', { light: p.light }); }
    else if (p.type === 'ultrasonic' && q.action === 'set' && (q.cm === null || Number.isFinite(+q.cm))) { p.cm = q.cm === null ? null : Math.max(2, Math.min(400, +q.cm)); this.note(p.id, 'set', { cm: p.cm }); }
    else if (p.type !== 'arm' && (q.action === 'unplug' || q.action === 'plug')) this.wire(p, q.action === 'plug');
    else if (p.type === 'ultrasonic' && (q.action === 'stuck' || q.action === 'unstuck')) { p.stuck = q.action === 'stuck'; if (p.stuck) this.uno.setInput(p.echo, true); else if (!p.unplugged) this.uno.setInput(p.echo, false); this.note(p.id, q.action); }
    else throw new Error(`${p.id}（${p.type}）不能做「${q.action}」`);
    return this.partState(p);
  }
  // 拔線／接回：元件和晶片之間的線斷了，元件怎麼動都影響不到腳位（腳位也驅動不了元件）
  wire(p, on) {
    if (!p.unplugged === on) return;
    p.unplugged = !on; this.note(p.id, on ? 'plug' : 'unplug');
    if (p.type === 'button') { p.gen++; if (on) { p.level = !p.pressed; this.uno.setInput(p.pin, p.level); } else this.uno.release(p.pin); }
    else if (p.type === 'ultrasonic') { if (on) this.uno.setInput(p.echo, !!p.stuck); else this.uno.release(p.echo); }
    else if (p.type === 'ldr') this.refreshLdr(p);
    else if (p.type === 'servo') { this.moveServo(p); p.lastPulseMs = p.lastPulseMs === null ? null : -1e9; }   // 沒有訊號：停在原地
    this.sense();
  }
  // 按鈕：電位先在高低之間彈跳幾次，最後停在新的狀態（拔線時只記住按住與否，不影響腳位）
  press(p, down) {
    if (p.pressed === down) return;
    if (p.unplugged) { p.pressed = down; this.note(p.id, down ? 'press' : 'release', { unplugged: true }); return; }
    p.pressed = down; const gen = ++p.gen; const target = !down;
    const n = p.bounceMs > 0 ? 1 + Math.floor(this.rand() * 3) : 0;   // 1–3 次來回
    const times = Array.from({ length: n * 2 }, () => this.rand() * p.bounceMs).sort((a, b) => a - b);
    const set = lv => { if (gen !== p.gen || p.level === lv) return; p.level = lv; p.edges++; this.uno.setInput(p.pin, lv); };
    set(target);
    times.forEach((t, i) => this.at(t, () => set(i % 2 === 0 ? !target : target)));
    this.at(p.bounceMs + 0.01, () => set(target));
    this.note(p.id, down ? 'press' : 'release', { bounces: n });
  }
  armState(p) {
    for (const j of p.joints) this.moveServo(this.parts[j.servo]);
    const q = p.joints.map(j => { const s = this.parts[j.servo]; return s.angle === null ? null : (s.angle - j.zero) / j.dir; });
    const cmd = p.joints.map(j => { const s = this.parts[j.servo]; return s.cmd === null ? null : (s.cmd - j.zero) / j.dir; });
    let pos = null;
    if (q.every(a => a !== null)) {
      const r = a => a * Math.PI / 180, [q1, q2, q3] = q.map(r);
      const er = p.L1 * Math.cos(q2), ey = p.H + p.L1 * Math.sin(q2), tr = er + p.L2 * Math.cos(q2 - q3), ty = ey + p.L2 * Math.sin(q2 - q3);
      pos = { yaw: q[0], elbow: { r: er, y: ey }, tip: { r: tr, y: ty, x: tr * Math.cos(q1), z: -tr * Math.sin(q1) } };
    }
    return { id: p.id, type: 'arm', H: p.H, L1: p.L1, L2: p.L2, joints: p.joints.map((j, i) => ({ servo: j.servo, name: j.name, q: q[i] === null ? null : Math.round(q[i] * 10) / 10, cmd: cmd[i] === null ? null : Math.round(cmd[i] * 10) / 10 })), pos };
  }
  partState(p) {
    const st = this.partState0(p);
    if (p.type !== 'arm') { st.unplugged = !!p.unplugged; if (p.type === 'ultrasonic') st.stuck = !!p.stuck; }
    return st;
  }
  partState0(p) {
    const r1 = x => x === null || x === undefined ? null : Math.round(x * 10) / 10;
    if (p.type === 'button') return { id: p.id, type: p.type, pin: p.pin, pressed: p.pressed, level: p.level ? 'high' : 'low', edges: p.edges, bounceMs: p.bounceMs };
    if (p.type === 'led') { const mA = p.on ? Math.round((VCC - LED_VF) / p.ohm * 1000 * 10) / 10 : 0; return { id: p.id, type: p.type, pin: p.pin, ohm: p.ohm, on: p.on, mA, overCurrent: mA > 20, toggles: p.toggles, lastChangeMs: p.lastChangeMs }; }
    if (p.type === 'ldr') return { id: p.id, type: p.type, pin: p.pin, light: p.light, volts: Math.round(p.volts * 1000) / 1000, noise: p.noise, inverted: !!p.inverted };
    if (p.type === 'ultrasonic') return { id: p.id, type: p.type, trig: p.trig, echo: p.echo, cm: p.cm, drop: p.drop, pulses: p.pulses, echoes: p.echoes, dropped: p.dropped };
    if (p.type === 'servo') this.moveServo(p);
    if (p.type === 'servo') return { id: p.id, type: p.type, pin: p.pin, pulseUs: p.pulseUs, cmd: r1(p.cmd), angle: r1(p.angle), moving: p.cmd !== null && p.angle !== null && Math.abs(p.cmd - p.angle) > 0.5 && this.servoPowered(p), powered: this.servoPowered(p), pulses: p.pulses, speed: p.speed };
    return this.armState(p);
  }
  state() { return { id: this.spec.id, name: this.spec.name, note: this.spec.note || null, parts: Object.values(this.parts).map(p => this.partState(p)), log: this.log.slice(-20) }; }
}

module.exports = { Bench, DEFAULT_BENCH, loadSpec, presets, SERVO_MIN_US, SERVO_MAX_US };
