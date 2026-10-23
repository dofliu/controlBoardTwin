// V2.6：只用板子就能做的實驗——ESP32 DevKit V1（DOIT，30 腳）的板載 LED（GPIO2）、BOOT 鍵（GPIO0）、觸控腳與序列埠
// 板型與板載元件、電路檢查、接線助手、行為驗證、引擎、產生的 C++ 與引擎逐毫秒一致（含序列埠訊息的時刻與內容）
const test = require('node:test'); const assert = require('node:assert');
const { execFileSync } = require('child_process'); const fs = require('fs'); const path = require('path'); const os = require('os');
const { DL, solved, runEngine } = require('./helpers');
const HOST = path.join(__dirname, 'host'); const P = DL.project;
const BOARD_ONLY = ['board-boot-toggle', 'board-touch-lamp', 'board-two-inputs'];
const errors = p => DL.netlist.analyze(p).issues.filter(i => i.level === 'error');

test('板型：ESP32 DevKit V1 是 30 腳、兩排相距 0.9 吋；GPIO0 只接 BOOT 鍵（不在排針上）；與 DevKitC 同一個晶片家族', () => {
  const b = DL.boards.esp32doit;
  assert.strictEqual(Object.keys(b.layout).length, 30);
  assert.ok(b.pinById.GPIO0 && b.pinById.GPIO0.internal && !b.layout.GPIO0);
  assert.strictEqual(Math.abs(b.layout.GPIO23.z - b.layout.EN.z).toFixed(3), '2.286');
  assert.deepStrictEqual(b.onboard, { led: 'GPIO2', boot: 'GPIO0' });
  assert.strictEqual(DL.boardFamily('esp32doit'), 'esp32'); assert.strictEqual(b.fqbn, 'esp32:esp32:esp32doit-devkit-v1');
  assert.ok(['GPIO4', 'GPIO15', 'GPIO13', 'GPIO14', 'GPIO27', 'GPIO33', 'GPIO32'].every(id => b.pinById[id].caps.includes('touch')));
  // 原本的 ESP32 實驗也能直接用在 DevKit V1（同一個晶片）
  assert.ok(DL.experiments.instantiate('hold-blink', 'esp32doit').ok && DL.experiments.instantiate('dist-gauge', 'esp32doit').ok);
});

test('板載元件只能加在有這個功能的板子上，而且板載 LED／BOOT 鍵只有一個', () => {
  const doit = P.create('esp32doit'), kitc = P.create('esp32'), uno = P.create('uno');
  assert.ok(P.addComponent(doit, 'OBLED', { x: 0, z: 0 }, 0).ok);
  assert.match(P.addComponent(doit, 'OBLED', { x: 0, z: 0 }, 0).msg, /只有一個/);
  assert.match(P.addComponent(kitc, 'OBLED', { x: 0, z: 0 }, 0).msg, /沒有板載 LED/);
  assert.ok(P.addComponent(kitc, 'BOOT', { x: 0, z: 0 }, 0).ok, 'DevKitC 也有 BOOT 鍵');
  assert.match(P.addComponent(uno, 'TOUCH', { x: 0, z: 0 }, 0).msg, /沒有觸控腳/);
  assert.match(P.addComponent(uno, 'BOOT', { x: 0, z: 0 }, 0).msg, /沒有BOOT 鍵/);
  const u = P.addComponent(uno, 'OBLED', { x: 0, z: 0 }, 0); assert.ok(u.ok);
  assert.strictEqual(DL.netlist.analyze(uno).bindings.OBLED1.pin, 'D13', 'Uno 的板載 LED 是 L 燈（D13）');
});

test('電路檢查：板載元件不需要接線；藍燈占用 GPIO2（外接元件不能再用）；觸控腳要是觸控腳；換到沒有藍燈的板子會報錯', () => {
  for (const id of BOARD_ONLY) {
    const p = solved(id, 'esp32doit'); const a = DL.netlist.analyze(p);
    assert.ok(a.ok, id + '：' + errors(p).map(i => i.msg).join()); assert.strictEqual(p.connections.length, 0, '沒有任何導線');
    assert.strictEqual(a.counts.warn, 0, `${id}：沒有注意事項（開機模式腳的提醒改由元件說明）` + JSON.stringify(a.issues.filter(i => i.level === 'warn').map(i => i.msg)));
  }
  let p = solved('board-boot-toggle', 'esp32doit'); let a = DL.netlist.analyze(p);
  assert.deepStrictEqual([a.bindings.OBLED1.pin, a.bindings.BOOT1.pin, a.bindings.BOOT1.activeLow], ['GPIO2', 'GPIO0', true]);
  // 外接 LED 也接 GPIO2：腳位衝突
  p = P.clone(p, { lock: { components: false, behavior: false, board: false } }); P.addComponent(p, 'RES', { x: 8, z: 0 }, 0); P.addComponent(p, 'LED', { x: 10, z: 0 }, 0);
  P.addConnection(p, { comp: 'board', term: 'GPIO2' }, { comp: 'R1', term: '1' }); P.addConnection(p, { comp: 'R1', term: '2' }, { comp: 'LED1', term: 'A' }); P.addConnection(p, { comp: 'LED1', term: 'K' }, { comp: 'board', term: 'GND1' });
  assert.ok(errors(p).some(i => i.code === 'pin_conflict' && /OBLED1/.test(i.msg)));
  // 觸控腳選到不是觸控的腳位
  const q = P.create('esp32doit'); const t = P.addComponent(q, 'TOUCH', { x: 0, z: 0 }, 0).comp; t.params.pin = 'GPIO5';
  assert.ok(errors(q).some(i => i.code === 'no_touch'));
  // 換成 DevKitC：沒有藍燈
  const r = solved('board-touch-lamp', 'esp32doit'); r.board = Object.assign({}, r.board, { type: 'esp32' });
  assert.ok(errors(r).some(i => i.code === 'no_onboard' && /OBLED1|板載 LED/.test(i.msg)));
});

test('接線助手：DevKit V1 上不會把外接元件接到只接 BOOT 鍵的 GPIO0，也避開已被藍燈占用的 GPIO2', () => {
  const p = P.create('esp32doit'); P.addComponent(p, 'OBLED', { x: 0, z: 0 }, 0);
  for (let i = 0; i < 8; i++) P.addComponent(p, 'BTN', { x: 8, z: -6 + i * 1.6 }, 0);
  for (let i = 0; i < 6; i++) { P.addComponent(p, 'RES', { x: 12, z: -6 + i * 2 }, 0); P.addComponent(p, 'LED', { x: 14, z: -6 + i * 2 }, 0); }
  DL.autowire.apply(p, {}); const a = DL.netlist.analyze(p);
  const pins = Object.values(a.bindings).map(b => b.pin);
  assert.ok(!Object.values(a.bindings).some(b => !b.onboard && (b.pin === 'GPIO0' || b.pin === 'GPIO2')), JSON.stringify(pins));
  assert.ok(p.connections.every(w => [w.a, w.b].every(e => e.comp !== 'board' || DL.boards.esp32doit.layout[e.term])), '每條線都接在排針上');
  assert.deepStrictEqual(errors(p), []);
});

test('行為：序列埠訊息只能放在開始或事件規則、不能空白或超過 60 字；觸控的摘要寫「被碰到」；兩條持續規則搶同一顆燈時提醒', () => {
  const p = solved('board-touch-lamp', 'esp32doit'); const a = DL.netlist.analyze(p);
  const bad = (rules, re) => { const q = P.clone(p); q.behavior.ir = { rules }; const v = DL.behavior.validate(q, a); assert.ok(v.issues.some(i => i.level === 'error' && re.test(i.msg)), JSON.stringify(v.issues)); };
  bad([{ type: 'while', cond: { type: 'pressed', comp: 'TOUCH1' }, actions: [{ type: 'print', text: 'x' }], onEnd: 'off', restart: 'restart' }], /單次動作/);
  bad([{ type: 'start', actions: [{ type: 'print', text: '  ' }] }], /不能是空的/);
  bad([{ type: 'start', actions: [{ type: 'print', text: 'x'.repeat(61) }] }], /60/);
  bad([{ type: 'start', actions: [{ type: 'print', text: 'a\nb' }] }], /換行/);
  bad([{ type: 'event', event: 'press', comp: 'OBLED1', actions: [] }], /按鈕或BOOT 鍵或觸控腳/);
  const s = DL.behavior.summarize(p).lines.map(l => l.text).join(' ');
  assert.match(s, /TOUCH1 被手指碰著/); assert.match(s, /每當 TOUCH1 被碰到/); assert.match(s, /序列埠印出「碰到了」/);
  const two = solved('board-two-inputs', 'esp32doit'); const v = DL.behavior.validate(two, DL.netlist.analyze(two));
  assert.ok(v.ok && v.issues.some(i => i.level === 'warn' && /OBLED1 被規則 2、3 同時控制/.test(i.msg)));
});

test('引擎：BOOT 切換藍燈並印出訊息；觸控檯燈；兩種輸入時觸控（排在後面）優先', () => {
  let p = solved('board-boot-toggle', 'esp32doit'); let e = DL.createEngine(p); const serial = []; let out;
  const step = (t0, t1, set) => { for (let t = t0; t < t1; t++) { set && set(t); const r = e.tick(t); out = r.out; for (const ev of r.events) if (ev.kind === 'serial') serial.push([t, ev.text]); } };
  step(0, 100); e.setButton('BOOT1', true); step(100, 200); e.setButton('BOOT1', false); step(200, 300);
  assert.strictEqual(out.OBLED1, 1); e.setButton('BOOT1', true); step(300, 400); assert.strictEqual(out.OBLED1, 0);
  assert.deepStrictEqual(serial, [[0, 'DofLab：準備好了，按 BOOT 切換藍燈'], [120, 'BOOT 按下：切換藍燈'], [320, 'BOOT 按下：切換藍燈']]);
  p = solved('board-two-inputs', 'esp32doit'); e = DL.createEngine(p);
  const flips = (a, b) => { let n = 0, last = null; for (let t = a; t < b; t++) { const v = e.tick(t).out.OBLED1; if (last !== null && v !== last) n++; last = v; } return n; };
  e.setButton('BOOT1', true); flips(0, 100); assert.strictEqual(flips(100, 2100), 4, 'BOOT：1 Hz，2 秒 4 次轉換');
  e.setButton('TOUCH1', true); flips(2100, 2200); assert.strictEqual(flips(2200, 3200), 10, '再碰觸控：5 Hz 優先');
});

/* ---------- 產生的 C++ 與引擎逐毫秒一致（主機替身：touchRead、Serial、delay） ---------- */
function runCpp(p, T, schedule, outs) {
  const g = DL.codegen.generate(p); assert.ok(g.ok, (g.blockers || []).join('\n'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-ob-'));
  fs.writeFileSync(path.join(dir, 'sketch.inc'), g.code);
  for (const f of ['Arduino.h', 'Servo.h', 'ESP32Servo.h', 'harness.cpp']) fs.copyFileSync(path.join(HOST, f), path.join(dir, f));
  execFileSync('g++', ['-std=gnu++11', '-O1', '-I', dir, '-o', path.join(dir, 'h'), path.join(dir, 'harness.cpp')], { cwd: dir, stdio: 'pipe' });
  const a = DL.netlist.analyze(p).bindings; const board = DL.boards[p.board.type]; const num = id => board.pinById[a[id].pin].num;
  // 觸控：沒碰約 60、碰到約 15（開機基準 60 → 門檻 36）
  const ev = schedule.map(s => P.findComp(p, s.comp).type === 'TOUCH' ? `${s.t} t ${num(s.comp)} ${s.pressed ? 15 : 60}` : `${s.t} d ${num(s.comp)} ${s.pressed ? 0 : 1}`);
  const input = `${T} ${ev.length}\n${ev.join('\n')}\n${outs.length}\n${outs.map(id => 'd ' + num(id)).join('\n')}\n`;
  const r = require('child_process').spawnSync(path.join(dir, 'h'), { input, maxBuffer: 1 << 26 });
  const rows = r.stdout.toString().trim().split('\n').map(l => l.split(' ').map(Number));
  const serial = r.stderr.toString().trim().split('\n').filter(Boolean).map(l => { const m = /^SERIAL (\d+) (.*)$/.exec(l); return [+m[1], m[2]]; });
  return { rows, serial, code: g.code };
}

test('產生的 C++ 與引擎逐毫秒一致：三個只用板子的實驗（BOOT、觸控、序列埠訊息的時刻與內容）', () => {
  const SCH = [{ t: 100, comp: 'BOOT1', pressed: true }, { t: 260, comp: 'BOOT1', pressed: false }, { t: 600, comp: 'TOUCH1', pressed: true }, { t: 1700, comp: 'BOOT1', pressed: true }, { t: 2400, comp: 'TOUCH1', pressed: false }, { t: 2900, comp: 'BOOT1', pressed: false }, { t: 3200, comp: 'BOOT1', pressed: true }, { t: 3300, comp: 'BOOT1', pressed: false }];
  for (const id of BOARD_ONLY) {
    const p = solved(id, 'esp32doit'); const comps = new Set(p.components.map(c => c.id));
    const sch = SCH.filter(s => comps.has(s.comp));
    // 引擎
    const e = DL.createEngine(p); const eng = []; const eSerial = []; let k = 0;
    for (let t = 0; t <= 3600; t++) { while (k < sch.length && sch[k].t <= t) { e.setButton(sch[k].comp, sch[k].pressed); k++; } const r = e.tick(t); eng.push(Number(r.out.OBLED1)); for (const x of r.events) if (x.kind === 'serial') eSerial.push([t, x.text]); }
    const { rows, serial, code } = runCpp(p, 3600, sch, ['OBLED1']);
    assert.strictEqual(rows.length, eng.length);
    for (let t = 0; t < eng.length; t++) assert.strictEqual(rows[t][0], eng[t], `${id} t=${t} ms：C++=${rows[t][0]} 引擎=${eng[t]}`);
    // 開始規則在 setup() 裡印出（setup 的觸控校正需要約 80 ms），其餘訊息的時刻要相同
    const cs = serial.map(([t, s], i) => eSerial[i] && eSerial[i][0] === 0 ? [0, s] : [t, s]);
    assert.deepStrictEqual(cs, eSerial, id);
    assert.ok(/Serial\.begin\(115200\)/.test(code) && /pinMode\(OBLED1_PIN, OUTPUT\)/.test(code));
    if (id !== 'board-boot-toggle') assert.ok(/touchRead\(TOUCH1_PIN\)/.test(code) && /TOUCH1_DROP_PCT = 40/.test(code));
  }
});
