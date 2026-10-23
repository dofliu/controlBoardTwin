// V2.5：超音波測距模組（HC-SR04／HC-SR04P）＋SG90 的引導實驗
// 電路檢查、接線助手、行為驗證、引擎時序、產生的 C++ 與引擎逐毫秒等價（g++ 主機替身＋HC-SR04 時序替身），
// 以及 arduino-cli 編譯的真實機器碼在虛擬 Uno（avr8js＋HC-SR04 時序模型）上執行。
const test = require('node:test'); const assert = require('node:assert');
const { execFileSync } = require('child_process'); const fs = require('fs'); const path = require('path'); const os = require('os');
const { DL, solved, runEngine, confirm } = require('./helpers'); const { VirtualUno } = require('../tools/vdev/avrsim');
const HOST = path.join(__dirname, 'host'); const P = DL.project;
let hasCli = true; try { execFileSync('arduino-cli', ['version']); } catch (e) { hasCli = false; }
const US_EXPS = ['dist-alarm', 'smart-bin', 'parking-gate', 'dist-gauge', 'parking-radar'];
const errors = p => DL.netlist.analyze(p).issues.filter(i => i.level === 'error');
const B = t => ({ comp: 'board', term: t }); const E = (c, t) => ({ comp: c, term: t });

// 手動接一顆超音波模組
function wired(board, model, vcc, trig, echo) {
  const p = P.create(board); const c = P.addComponent(p, 'US', { x: 8, z: 2 }, 90).comp; if (model) c.params.model = model;
  const gnd = DL.boards[board].pins.find(x => x.kind === 'gnd').id;
  P.addConnection(p, E('US1', 'VCC'), B(vcc)); P.addConnection(p, E('US1', 'GND'), B(gnd));
  P.addConnection(p, E('US1', 'TRIG'), B(trig)); P.addConnection(p, E('US1', 'ECHO'), B(echo));
  return p;
}

test('電路檢查：HC-SR04 要 5 V；3.3 V 板子的 ECHO 不能收 5 V；TRIG 不能接只能輸入的腳位；正確時綁定兩個腳位', () => {
  let a = DL.netlist.analyze(wired('uno', null, '5V', 'D7', 'D8'));
  assert.ok(a.ok); assert.deepStrictEqual([a.bindings.US1.trig, a.bindings.US1.echo, a.bindings.US1.role], ['D7', 'D8', 'ultrasonic']);
  assert.deepStrictEqual(a.pinUse.D7, ['US1']); assert.deepStrictEqual(a.pinUse.D8, ['US1']);
  // ESP32：HC-SR04 接 5V → ECHO 5 V 超過 3.3 V
  let e = errors(wired('esp32', 'HC-SR04', '5V', 'GPIO26', 'GPIO27'));
  assert.ok(e.some(i => i.code === 'overvoltage' && /ECHO/.test(i.msg) && /HC-SR04P/.test(i.msg)), JSON.stringify(e));
  // ESP32：HC-SR04 接 3V3 → 量不到
  e = errors(wired('esp32', 'HC-SR04', '3V3', 'GPIO26', 'GPIO27'));
  assert.ok(e.some(i => i.code === 'us_low_v'));
  // ESP32：3.3 V 版接 3V3 → 沒問題；ECHO 可以接只能輸入的 GPIO35，TRIG 不行
  assert.deepStrictEqual(errors(wired('esp32', 'HC-SR04P', '3V3', 'GPIO26', 'GPIO35')), []);
  e = errors(wired('esp32', 'HC-SR04P', '3V3', 'GPIO35', 'GPIO26'));
  assert.ok(e.some(i => i.code === 'pin_cap' && /TRIG/.test(i.msg)));
  // 樹莓派：同樣不能接 5 V 的 HC-SR04
  e = errors(wired('pi4b', 'HC-SR04', '5V_1', 'GPIO5', 'GPIO6'));
  assert.ok(e.some(i => i.code === 'overvoltage'));
  assert.deepStrictEqual(errors(wired('pi4b', 'HC-SR04P', '3V3_1', 'GPIO5', 'GPIO6')), []);
  // TRIG 與 ECHO 接在一起 → 元件被短路；GND 沒接 GND
  let p = wired('uno', null, '5V', 'D7', 'D7');
  assert.ok(errors(p).some(i => i.code === 'comp_shorted'));
  p = wired('uno', null, '5V', 'D7', 'D8'); p.connections = p.connections.filter(w => !(w.a.term === 'GND' && w.a.comp === 'US1')); P.addConnection(p, E('US1', 'GND'), B('A3'));
  assert.ok(errors(p).some(i => i.code === 'us_gnd' || i.code === 'gpio_gnd' || /GND/.test(i.msg)));
  // 同一個腳位被兩個元件使用
  p = wired('uno', null, '5V', 'D7', 'D8'); P.addComponent(p, 'BTN', { x: 6, z: 4 }, 0); P.addConnection(p, E('BTN1', '1'), B('D8')); P.addConnection(p, E('BTN1', '2'), B('GND2'));
  assert.ok(errors(p).some(i => i.code === 'pin_conflict'));
});

test('行為驗證：距離門檻、伺服跟著距離只能放在持續條件、範圍檢查；行為摘要寫出量測延遲', () => {
  const p = solved('dist-gauge', 'uno'); const a = DL.netlist.analyze(p);
  assert.ok(DL.behavior.validate(p, a).ok);
  const bad = (rules, re) => { const q = P.clone(p); q.behavior.ir = { rules }; const v = DL.behavior.validate(q, a); assert.ok(v.issues.some(i => i.level === 'error' && re.test(i.msg)), JSON.stringify(v.issues)); };
  const map = { type: 'servoMap', comp: 'SERVO1', src: 'US1', inMin: 5, inMax: 50, outMin: 180, outMax: 0 };
  bad([{ type: 'start', actions: [map] }], /持續成立/);
  bad([{ type: 'while', cond: { type: 'distance', comp: 'US1', op: 'lt', value: 1 }, actions: [], onEnd: 'off', restart: 'restart' }], /2–400 cm/);
  bad([{ type: 'while', cond: { type: 'distance', comp: 'US1', op: 'lt', value: 50 }, actions: [Object.assign({}, map, { inMax: 5 })], onEnd: 'off', restart: 'restart' }], /不能相同/);
  bad([{ type: 'while', cond: { type: 'distance', comp: 'US1', op: 'lt', value: 50 }, actions: [Object.assign({}, map, { outMax: 200 })], onEnd: 'off', restart: 'restart' }], /0–180/);
  bad([{ type: 'while', cond: { type: 'distance', comp: 'SERVO1', op: 'lt', value: 50 }, actions: [], onEnd: 'off', restart: 'restart' }], /超音波測距/);
  const s = DL.behavior.summarize(p);
  assert.match(s.lines[0].text, /5 cm → 180°、50 cm → 0°/); assert.ok(s.notes.some(n => /60 ms/.test(n) && /400 cm/.test(n)));
});

test('引擎時序：每 60 ms 量一次、規則用上一次的結果（反應慢 60–120 ms）；超出量程當成 400 cm；伺服跟著距離與 Arduino map() 相同', () => {
  const p = solved('dist-alarm', 'uno');
  const rows = runEngine(p, 600, [{ t: 0, comp: 'US1', cm: 100 }, { t: 130, comp: 'US1', cm: 10 }, { t: 400, comp: 'US1', cm: null }]).map(o => o.LED1);
  const first = rows.indexOf(1);
  assert.strictEqual(first, 240, '130 ms 變近 → 180 ms 那次量到 → 240 ms 才採用');
  assert.strictEqual(rows[239], 0); assert.strictEqual(rows[400], 1);
  assert.strictEqual(rows.indexOf(0, first), 480, '400 ms 沒有回波 → 420 ms 量到 400 cm → 480 ms 熄滅');
  const g = solved('dist-gauge', 'uno'); const e = DL.createEngine(g); let tt = 0; const angleAt = cm => { e.setDistance('US1', cm); let o; for (let i = 0; i < 200; i++) o = e.tick(tt++).out; return o.SERVO1; };
  const arduinoMap = (x, a, b, c, d) => Math.trunc((x - a) * (d - c) / (b - a)) + c;
  for (const cm of [3, 5, 6, 17, 27, 33, 49, 50, 55]) assert.strictEqual(angleAt(cm), arduinoMap(Math.min(50, Math.max(5, cm)), 5, 50, 180, 0), `${cm} cm`);
  assert.strictEqual(angleAt(80), arduinoMap(50, 5, 50, 180, 0), '超出 60 cm：保持最後的角度');
});

test('五個超音波實驗 × 三種板型：建立、鎖定、接線助手從零接完沒有錯誤、腳位依建議；3.3 V 板子用 3.3 V 版模組接 3V3', () => {
  for (const id of US_EXPS) for (const b of DL.boardList) {
    const r = DL.experiments.instantiate(id, b); assert.ok(r.ok, id + b);
    assert.strictEqual(r.project.connections.filter(w => w.kind !== 'insert').length, 0);
    const us = P.findComp(r.project, 'US1'); assert.strictEqual(us.params.model, b === 'uno' ? 'HC-SR04' : 'HC-SR04P');
    const p = solved(id, b); const a = DL.netlist.analyze(p);
    assert.ok(a.ok, `${id}/${b}：` + errors(p).map(i => i.msg).join('；'));
    assert.ok(DL.behavior.validate(p, a).ok);
    const sg = DL.experiments.suggestFor(r.experiment, b);
    assert.strictEqual(a.bindings.US1.trig, sg.US1); assert.strictEqual(a.bindings.US1.echo, sg['US1.ECHO']);
    assert.strictEqual(a.bindings.US1.vcc, b === 'uno' ? 5 : 3.3);
    const ctx = { confirmedCurrent: true, minDist: 3, farAfterNear: true, nearMin: 5, nearMax: 55, presses: 0, maxHoldMs: 0 };
    assert.ok(r.experiment.tasks.every(t => t.check(p, a, ctx)), `${id}/${b} 任務都能完成`);
    for (const lang of [DL.codegen.generate(p)]) assert.ok(lang.ok && /US1_TRIG_PIN/.test(lang.code) && /US1_ECHO_PIN/.test(lang.code));
  }
  // 麵包板版：超音波模組四支腳插在同一列相鄰四孔，GND 走 − 電源排
  const p = solved('parking-radar', 'uno'); const m = DL.breadboard.mountOf(p, 'US1');
  assert.deepStrictEqual(m.holes.map(h => h.hole).sort(), ['h10', 'h11', 'h12', 'h9']);
  assert.ok(DL.netlist.analyze(p).nets.some(n => n.gnd.length && (n.bb || []).some(x => x.bus === 'BN')));
});

test('接線助手：只能 5 V 的 HC-SR04 放在 ESP32 上不會自動接（說明原因）；老師可以分別指定 TRIG 與 ECHO 腳位；接錯的 ECHO 指出來', () => {
  const p = P.create('esp32'); P.addComponent(p, 'US', { x: 8, z: 2 }, 90);
  const pl = DL.autowire.plan(p, {});
  assert.ok(pl.issues.some(i => i.level === 'error' && /HC-SR04P/.test(i.msg)));
  assert.ok(!pl.steps.some(s => s.kind === 'wire' && (s.a.comp === 'US1' || s.b.comp === 'US1')), '不接會損壞腳位的線');
  P.findComp(p, 'US1').params.model = 'HC-SR04P'; P.findComp(p, 'US1').prefPin = 'GPIO32'; P.findComp(p, 'US1').prefPinEcho = 'GPIO39';
  DL.autowire.apply(p, {}); const a = DL.netlist.analyze(p);
  assert.ok(a.ok, errors(p).map(i => i.msg).join()); assert.deepStrictEqual([a.bindings.US1.trig, a.bindings.US1.echo], ['GPIO32', 'GPIO39']);
  assert.ok(p.connections.some(w => [w.a, w.b].some(e => e.comp === 'board' && e.term === '3V3')), 'VCC 接 3V3');
  // 指定 TRIG 到只能輸入的腳位：改用建議腳位並說明
  const q = P.create('esp32'); const c = P.addComponent(q, 'US', { x: 8, z: 2 }, 90).comp; c.params.model = 'HC-SR04P'; c.prefPin = 'GPIO34';
  const pq = DL.autowire.plan(q, {}); assert.ok(pq.issues.some(i => /US1 TRIG/.test(i.msg) && /GPIO34|IO34/.test(i.msg)));
  // Uno：學生把 ECHO 接到 5V（錯）→ 指出那條線
  const r = P.create('uno'); P.addComponent(r, 'US', { x: 8, z: 2 }, 90); P.addConnection(r, E('US1', 'ECHO'), B('5V'));
  const pr = DL.autowire.plan(r, {}); assert.strictEqual(pr.wrong.length, 1);
});

test('程式比對：US1_TRIG_PIN／US1_ECHO_PIN 與接線比對；ECHO 改錯會指出，並可以同步 ECHO 那條虛擬接線', () => {
  const p = solved('smart-bin', 'uno'); const code = DL.codegen.generate(p).code;
  let items = DL.codegen.scanPins(p, code);
  assert.ok(items.some(i => i.level === 'ok' && /US1 TRIG/.test(i.msg))); assert.ok(items.some(i => i.level === 'ok' && /US1 ECHO/.test(i.msg)));
  items = DL.codegen.scanPins(p, code.replace('const int US1_ECHO_PIN = 8;', 'const int US1_ECHO_PIN = 4;'));
  const mm = items.find(i => i.level === 'mismatch'); assert.ok(mm && mm.part === 'ECHO' && mm.codePin === 'D4' && mm.netPin === 'D8', JSON.stringify(items));
  const r = DL.netlist.tryRewire(p, 'US1', 'D4', 'ECHO'); assert.ok(r.ok, r.msg);
  P.rewireBoardEnd(p, r.wire, 'D4'); const a = DL.netlist.analyze(p); assert.deepStrictEqual([a.bindings.US1.trig, a.bindings.US1.echo], ['D7', 'D4']);
});

/* ---------- 產生的 C++ 與引擎逐毫秒等價（主機替身裡有 HC-SR04 的時序模型） ---------- */
function runCpp(p, T, schedule, outs) {
  const g = DL.codegen.generate(p); assert.ok(g.ok, (g.blockers || []).join('\n'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-us-'));
  fs.writeFileSync(path.join(dir, 'sketch.inc'), g.code);
  for (const f of ['Arduino.h', 'Servo.h', 'ESP32Servo.h', 'harness.cpp']) fs.copyFileSync(path.join(HOST, f), path.join(dir, f));
  execFileSync('g++', ['-std=gnu++11', '-O1', '-I', dir, '-o', path.join(dir, 'h'), path.join(dir, 'harness.cpp')], { cwd: dir });
  const a = DL.netlist.analyze(p).bindings; const board = DL.boards[p.board.type]; const num = id => board.pinById[id].num;
  const ev = schedule.map(s => `${s.t} u ${num(a[s.comp].trig)} ${s.cm === null ? 400 : s.cm}`);
  const input = `${T} ${ev.length}\n${ev.join('\n')}\n${outs.length}\n${outs.map(id => (P.findComp(p, id).type === 'SERVO' ? 's ' : 'd ') + num(a[id].pin)).join('\n')}\n1\n${num(a.US1.trig)} ${num(a.US1.echo)}\n`;
  return execFileSync(path.join(dir, 'h'), { input, maxBuffer: 1 << 26 }).toString().trim().split('\n').map(l => l.split(' ').map(Number));
}
function compare(p, T, schedule, outs) {
  const eng = runEngine(p, T, schedule).map(o => outs.map(id => Number(o[id])));
  const cpp = runCpp(p, T, schedule, outs);
  assert.strictEqual(cpp.length, eng.length);
  for (let t = 0; t < eng.length; t++) assert.deepStrictEqual(cpp[t], eng[t], `${p.name} t=${t} ms：C++=${cpp[t]} 引擎=${eng[t]}`);
  return eng;
}
const SCH = [{ t: 0, comp: 'US1', cm: 120 }, { t: 205, comp: 'US1', cm: 35 }, { t: 470, comp: 'US1', cm: 12 }, { t: 733, comp: 'US1', cm: 8 }, { t: 1010, comp: 'US1', cm: 4 }, { t: 1300, comp: 'US1', cm: 27 }, { t: 1555, comp: 'US1', cm: 49 }, { t: 1800, comp: 'US1', cm: null }, { t: 2100, comp: 'US1', cm: 18 }];
const OUTS = { 'dist-alarm': ['LED1'], 'smart-bin': ['SERVO1'], 'parking-gate': ['SERVO1', 'LED1'], 'dist-gauge': ['SERVO1'], 'parking-radar': ['LED1', 'LED2'] };

test('產生的 Arduino C++（Uno 與 ESP32）與模擬引擎逐毫秒一致：五個實驗、距離來回變化、沒有回波', () => {
  for (const id of US_EXPS) for (const b of ['uno', 'esp32']) {
    const rows = compare(solved(id, b), 2400, SCH, OUTS[id]);
    const at = t => rows[t];
    if (id === 'dist-alarm') { assert.deepStrictEqual(at(400), [0]); assert.deepStrictEqual(at(700), [1]); assert.deepStrictEqual(at(1950), [0]); }
    if (id === 'smart-bin') { assert.deepStrictEqual(at(500), [10]); assert.deepStrictEqual(at(700), [100]); assert.deepStrictEqual(at(1500), [10]); }
    if (id === 'parking-gate') { assert.deepStrictEqual(at(700), [0, 0]); assert.deepStrictEqual(at(900), [90, 1]); assert.deepStrictEqual(at(1500), [0, 0]); }
    if (id === 'dist-gauge') { assert.deepStrictEqual(at(150), [0]); assert.deepStrictEqual(at(400), [60]); assert.deepStrictEqual(at(1200), [180]); assert.deepStrictEqual(at(1500), [92]); assert.deepStrictEqual(at(2000), [4], '沒有回波（400 cm）：指針停在最後的位置（49 cm → 4°）'); }
    if (id === 'parking-radar') { assert.deepStrictEqual(at(150), [0, 0]); const blinkFlips = [...Array(200).keys()].filter(k => rows[400 + k][0] !== rows[399 + k][0]).length; assert.ok(blinkFlips >= 1, '35 cm：黃燈閃爍'); assert.strictEqual(at(700)[1], 1, '12 cm：紅燈亮'); }
  }
});

/* ---------- 真實機器碼在虛擬 Uno 上：HC-SR04 時序模型產生真正的回波脈衝 ---------- */
function build(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-usa-')); const sk = path.join(dir, 'sketch'); fs.mkdirSync(sk);
  fs.writeFileSync(path.join(sk, 'sketch.ino'), code);
  const props = (process.env.DOFLAB_ARDUINO_PROPS || '').split(';').filter(Boolean).flatMap(p => ['--build-property', p]);
  execFileSync('arduino-cli', ['compile', '--fqbn', 'arduino:avr:uno', ...props, '--output-dir', path.join(dir, 'out'), sk], { stdio: 'pipe' });
  return path.join(dir, 'out', 'sketch.ino.hex');
}
const unoWith = id => { const u = new VirtualUno(build(DL.codegen.generate(solved(id, 'uno')).code)); const s = u.attachSonar(7, 8, 150); u.runMs(30); return { u, s }; };
const servoWidth = (u, pin) => { const pulses = []; let rise = null; u.pinWatchers.push(() => { const h = u.isHigh(pin); if (h && rise === null) rise = u.cycle; else if (!h && rise !== null) { pulses.push((u.cycle - rise) / 16); rise = null; } }); return pulses; };
const angleOf = w => (w - 544) * 180 / (2400 - 544);

test('虛擬 Uno 執行真實機器碼：每 60 ms 一個 10 µs 觸發脈衝；距離警示燈、倒車雷達的 LED 依距離動作', { skip: !hasCli && '沒有 arduino-cli', timeout: 400000 }, () => {
  let { u, s } = unoWith('dist-alarm');
  const p0 = s.pulses; u.runMs(600); const n = s.pulses - p0;
  assert.ok(n >= 9 && n <= 11, `600 ms 內觸發 ${n} 次（每 60 ms 一次）`); assert.strictEqual(s.short, 0, '觸發脈衝都至少 10 µs');
  assert.strictEqual(u.isHigh(13), false, '150 cm：不亮');
  s.cm = 12; u.runMs(150); assert.strictEqual(u.isHigh(13), true, '12 cm：150 ms 內亮');
  s.cm = 25; u.runMs(150); assert.strictEqual(u.isHigh(13), false, '25 cm：熄滅');
  s.cm = 18; u.runMs(150); assert.strictEqual(u.isHigh(13), true, '18 cm（門檻 20 cm 附近）：亮');
  s.cm = null; u.runMs(200); assert.strictEqual(u.isHigh(13), false, '沒有回波：當成 400 cm，熄滅');
  ({ u, s } = unoWith('parking-radar'));
  s.cm = 30; u.runMs(150); let edges = 0, last = u.isHigh(13);
  for (let i = 0; i < 1000; i++) { u.runMs(1); const h = u.isHigh(13); if (h !== last) { edges++; last = h; } }
  assert.ok(edges >= 4 && edges <= 6, `30 cm：黃燈 1 秒轉換 ${edges} 次（2.5 Hz）`); assert.strictEqual(u.isHigh(12), false, '紅燈不亮');
  s.cm = 10; u.runMs(150); assert.strictEqual(u.isHigh(12), true, '10 cm：紅燈亮');
});

test('虛擬 Uno 執行真實機器碼：感應垃圾桶蓋、停車場柵欄、距離指針的伺服脈寬（量測精度約 1 cm）', { skip: !hasCli && '沒有 arduino-cli', timeout: 400000 }, () => {
  let { u, s } = unoWith('smart-bin'); let pulses = servoWidth(u, 9);
  const angle = (cm, ms) => { s.cm = cm; pulses.length = 0; u.runMs(ms || 300); return angleOf(pulses[pulses.length - 1]); };
  assert.ok(Math.abs(angle(80) - 10) < 3, '80 cm：蓋子關著（10°）'); assert.ok(Math.abs(angle(9) - 100) < 3, '9 cm：打開（100°）'); assert.ok(Math.abs(angle(40) - 10) < 3, '手離開：關上');
  ({ u, s } = unoWith('parking-gate')); pulses = servoWidth(u, 9);
  assert.ok(Math.abs(angle(60) - 0) < 3); assert.strictEqual(u.isHigh(13), false);
  assert.ok(Math.abs(angle(6) - 90) < 3, '6 cm：柵欄抬到 90°'); assert.strictEqual(u.isHigh(13), true, '綠燈亮');
  ({ u, s } = unoWith('dist-gauge')); pulses = servoWidth(u, 9);
  const worst = [];
  for (const cm of [5, 10, 17, 25, 33, 41, 50]) { const want = Math.trunc((cm - 5) * (0 - 180) / 45) + 180; const got = angle(cm); worst.push(Math.abs(got - want)); assert.ok(Math.abs(got - want) <= 6, `${cm} cm：指針 ${got.toFixed(1)}°（應為 ${want}°）`); }
  console.log(`# 距離指針：7 個距離的最大角度誤差 ${Math.max(...worst).toFixed(1)}°（含伺服脈寬量化；1 cm ≈ 4°）`);
});
