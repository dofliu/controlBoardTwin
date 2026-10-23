// V2.7 手臂動作序列：開始 → 預備姿態 → A → B → C →（預備姿態）→ 反覆。
// 驗證：序列規則、產生的 C++（g++ 主機替身）與模擬用的序列規則逐毫秒一致、選項（不回預備姿態、只跑一輪、停留時間）。
const test = require('node:test'); const assert = require('node:assert');
const { execFileSync } = require('child_process'); const fs = require('fs'); const path = require('path'); const os = require('os');
const { DL } = require('./helpers');
const HOST = path.join(__dirname, 'host'); const A = DL.arm;

function armProject(board, poses, seq) {
  const p = DL.experiments.solved('arm-3dof', board).project; const cfg = p.arm.config; const a = DL.netlist.analyze(p);
  p.arm.poses = poses.map(([name, t, holdMs]) => { const s = A.ik(cfg, t, [0, 90, 90]); assert.ok(s.ok, name); const ps = { name, t, q: s.q }; if (holdMs !== undefined) ps.holdMs = holdMs; return ps; });
  if (seq) p.arm.seq = seq;
  p.arm.confirmed = { hash: DL.hash({ cfg, b: cfg.joints.map(j => a.bindings[j.servo].pin), board: p.board.type }), at: 'test' };
  return p;
}
const ABC = [['A', { x: 10, y: 6, z: -6 }, 300], ['B', { x: 12, y: 10, z: 0 }, 0], ['C', { x: 8, y: 5, z: 7 }, 700]];

function runCpp(p, T) {
  const g = DL.codegen.generate(p); assert.ok(g.ok, (g.blockers || []).join('\n'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-seq-'));
  fs.writeFileSync(path.join(dir, 'sketch.inc'), g.code);
  for (const f of ['Arduino.h', 'Servo.h', 'ESP32Servo.h', 'harness.cpp']) fs.copyFileSync(path.join(HOST, f), path.join(dir, f));
  execFileSync('g++', ['-std=gnu++11', '-O1', '-I', dir, '-o', path.join(dir, 'h'), path.join(dir, 'harness.cpp')], { cwd: dir });
  const a = DL.netlist.analyze(p).bindings; const board = DL.boards[p.board.type];
  const pins = p.arm.config.joints.map(j => board.pinById[a[j.servo].pin].num);
  const input = `${T} 0\n3\n${pins.map(n => 's ' + n).join('\n')}\n`;
  return { rows: execFileSync(path.join(dir, 'h'), { input, maxBuffer: 64 << 20 }).toString().trim().split('\n').map(l => l.split(' ').map(Number)), code: g.code };
}
function runSeq(p, T) { const plan = A.seqPlan(p.arm); const st = A.seqStart(plan, 0); const out = []; for (let t = 0; t <= T; t++) { A.seqStep(plan, st, t); out.push(A.seqWritten(st)); } return { out, st, plan }; }

test('序列規則：A、B、C 之後回到預備姿態；停留時間、選項與摘要', () => {
  const p = armProject('uno', ABC);
  const plan = A.seqPlan(p.arm);
  assert.deepStrictEqual(plan.way.map(w => w.name), ['A', 'B', 'C', '預備姿態']);
  assert.deepStrictEqual(plan.way.map(w => w.hold), [300, 0, 700, 1000]);
  assert.deepStrictEqual(plan.home, A.toServo(p.arm.config, A.homeQ(p.arm.config)));
  assert.match(DL.codegen.armSeqText(plan), /預備姿態 → A（停 0\.3 秒） → B（停 0\.0 秒） → C（停 0\.7 秒） → 預備姿態（停 1\.0 秒），反覆執行/);
  p.arm.seq = { returnHome: false, loop: false };
  assert.deepStrictEqual(A.seqPlan(p.arm).way.map(w => w.name), ['A', 'B', 'C']);
  assert.match(DL.codegen.armSeqText(A.seqPlan(p.arm)), /走完一輪後停住/);
  assert.strictEqual(A.holdOf(-5), 0); assert.strictEqual(A.holdOf(99999), 60000); assert.strictEqual(A.holdOf('x'), 1000);
});

for (const [name, seq] of [['回到預備姿態、反覆', null], ['不回預備姿態、只跑一輪', { returnHome: false, loop: false }]])
test(`產生的 C++ 與模擬的序列逐毫秒一致（${name}）`, { timeout: 60000 }, () => {
  const p = armProject('uno', ABC, seq); const T = 16000;
  const cpp = runCpp(p, T).rows; const js = runSeq(p, T);
  assert.strictEqual(cpp.length, js.out.length);
  for (let t = 0; t <= T; t++) assert.deepStrictEqual(cpp[t], js.out[t], `t=${t} ms：C++=${cpp[t]} 模擬=${js.out[t]}`);
  // 確實走過每個姿態
  for (const w of js.plan.way) assert.ok(js.out.some(r => r.join() === w.s.join()), '經過 ' + w.name);
  if (seq) { assert.ok(js.st.done); assert.deepStrictEqual(js.out[T], js.plan.way[2].s, '只跑一輪：停在 C'); }
  else assert.ok(js.st.loops >= 2, '16 秒內至少走完兩輪');
});

test('ESP32 與樹莓派也產生同一個序列', () => {
  for (const b of ['esp32', 'esp32doit', 'pi4b']) {
    const p = armProject(b, ABC); const g = DL.codegen.generate(p); assert.ok(g.ok, b + (g.blockers || []).join());
    const plan = A.seqPlan(p.arm);
    for (const w of plan.way) assert.ok(g.code.includes(w.s.join(', ')), `${b}：${w.name}`);
    assert.match(g.code, b === 'pi4b' ? /LOOP = True/ : /LOOP = true/);
  }
});

test('改了序列（停留時間、選項、順序），程式會變成過期', () => {
  const p = armProject('uno', ABC); const h0 = DL.project.inputsHash(p, 'x');
  p.arm.poses[0].holdMs = 500; const h1 = DL.project.inputsHash(p, 'x'); assert.notStrictEqual(h0, h1);
  p.arm.seq = { returnHome: false }; assert.notStrictEqual(DL.project.inputsHash(p, 'x'), h1);
  const h2 = DL.project.inputsHash(p, 'x'); p.arm.poses.reverse(); assert.notStrictEqual(DL.project.inputsHash(p, 'x'), h2);
});
