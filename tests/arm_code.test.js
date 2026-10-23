// 手臂姿態播放程式：產生 → 驗證限制條件 →（有工具鏈時）真實編譯 → 在虛擬 Uno 上量測三個腳位的伺服脈寬
const test = require('node:test'); const assert = require('node:assert');
const { execFileSync } = require('child_process'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { DL, solved } = require('./helpers'); const { VirtualUno } = require('./avr/avrsim');
let hasCli = true; try { execFileSync('arduino-cli', ['version']); } catch (e) { hasCli = false; }

function armProject(board) {
  const p = DL.experiments.solved('arm-3dof', board).project; const cfg = p.arm.config; const a = DL.netlist.analyze(p);
  assert.ok(a.ok, a.issues.filter(i => i.level === 'error').map(i => i.msg).join('；'));
  const pose = (name, t) => { const s = DL.arm.ik(cfg, t, [0, 90, 90]); assert.ok(s.ok, name + ' ' + s.msg); return { name, t, q: s.q }; };
  p.arm.poses = [pose('右前方', { x: 10, y: 6, z: -6 }), pose('左前方', { x: 10, y: 6, z: 6 })];
  p.arm.confirmed = { hash: DL.hash({ cfg, b: cfg.joints.map(j => a.bindings[j.servo].pin), board: p.board.type }), at: 'test' };
  return p;
}

test('手臂程式：沒確認或沒姿態時拒絕；確認後產生，含限速與姿態的伺服角度', () => {
  const p = armProject('uno'); const conf = p.arm.confirmed; p.arm.confirmed = null;
  assert.ok(DL.codegen.generate(p).blockers.some(b => /確認/.test(b)));
  p.arm.confirmed = conf; const g = DL.codegen.generate(p); assert.ok(g.ok, (g.blockers || []).join());
  const s0 = DL.arm.toServo(p.arm.config, p.arm.poses[0].q);
  assert.ok(g.code.includes(`{${s0.join(', ')}}`)); assert.match(g.code, /MAX_SPEED = 90\.0/);
  p.arm.config.L1 = 9; assert.ok(DL.codegen.generate(p).blockers.some(b => /確認/.test(b)), '改尺寸後確認失效');
  const py = DL.codegen.generate(armProject('pi4b')); assert.ok(py.ok); assert.match(py.code, /AngularServo/);
});

test('手臂程式的腳位比對：J1_PIN～J3_PIN 對應到各關節的伺服，手改腳位會被抓到', () => {
  for (const board of ['uno', 'esp32', 'pi4b']) {
    const p = armProject(board); const code = DL.codegen.generate(p).code;
    const items = DL.codegen.scanPins(p, code);
    assert.strictEqual(items.filter(i => i.level === 'ok').length, 3, board + '：' + items.map(i => i.msg).join('；'));
    assert.ok(!items.some(i => /沒有元件/.test(i.msg)), board);
  }
  const p = armProject('uno'); const code = DL.codegen.generate(p).code.replace('const int J2_PIN = 10;', 'const int J2_PIN = 6;');
  const mm = DL.codegen.scanPins(p, code).filter(i => i.level === 'mismatch');
  assert.strictEqual(mm.length, 1); assert.strictEqual(mm[0].comp, 'SERVO2'); assert.match(mm[0].msg, /J2（SERVO2）/);
});

test('手臂程式在虛擬 Uno 上：三個腳位輸出伺服脈波，並以限速移到第二個姿態', { skip: !hasCli && '沒有 arduino-cli', timeout: 240000 }, () => {
  const p = armProject('uno'); const code = DL.codegen.generate(p).code;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-arm-')); fs.mkdirSync(path.join(dir, 's')); fs.writeFileSync(path.join(dir, 's', 's.ino'), code);
  const props = (process.env.DOFLAB_ARDUINO_PROPS || '').split(';').filter(Boolean).flatMap(x => ['--build-property', x]);
  execFileSync('arduino-cli', ['compile', '--fqbn', 'arduino:avr:uno', ...props, '--output-dir', path.join(dir, 'out'), path.join(dir, 's')], { stdio: 'pipe' });
  const u = new VirtualUno(path.join(dir, 'out', 's.ino.hex'));
  const pins = [9, 10, 11]; const rise = {}, last = {};
  u.pinWatchers.push(() => { for (const n of pins) { const h = u.isHigh(n); if (h && rise[n] == null) rise[n] = u.cpu.cycles; else if (!h && rise[n] != null) { last[n] = (u.cpu.cycles - rise[n]) / 16; rise[n] = null; } } });
  const us = a => 544 + (2400 - 544) * a / 180;   // Servo 函式庫預設脈寬換算
  // 預測：同一份序列規則（DL.arm.seqStep）逐毫秒推算伺服命令角
  const plan = DL.arm.seqPlan(p.arm); const st = DL.arm.seqStart(plan, 0); const pred = [];
  for (let t = 0; t <= 9000; t++) { DL.arm.seqStep(plan, st, t); pred.push(DL.arm.seqWritten(st)); }
  let now = 0; const at = ms => { u.runMs(ms - now); now = ms; };
  // 開機在預備姿態 → 移到「右前方」→ 停 1 秒 → 「左前方」→ 停 → 預備姿態（每個時間點都和預測比對；虛擬晶片的 millis 與真實時間可能差幾毫秒，容許 ±2°）
  for (const t of [300, 1200, 2600, 3400, 5200, 7000, 8800]) {
    at(t); pins.forEach((n, i) => assert.ok(Math.abs(last[n] - us(pred[t][i])) < 45, `t=${t} ms：D${n} 脈寬 ${last[n].toFixed(0)} µs，預測 ${us(pred[t][i]).toFixed(0)}（${pred[t][i]}°）`));
  }
  const s0 = DL.arm.toServo(p.arm.config, p.arm.poses[0].q), s1 = DL.arm.toServo(p.arm.config, p.arm.poses[1].q);
  assert.ok(pred.some(r => r.join() === s0.join()) && pred.some(r => r.join() === s1.join()), '序列確實經過兩個姿態');
});
