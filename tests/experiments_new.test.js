// V2.4 新增的五個引導實驗：解答、程式產生、與模擬引擎逐毫秒等價（g++ 主機替身），以及在虛擬 Uno 上執行真實機器碼
const test = require('node:test'); const assert = require('node:assert');
const { execFileSync } = require('child_process'); const fs = require('fs'); const path = require('path'); const os = require('os');
const { DL, solved, runEngine } = require('./helpers'); const { VirtualUno } = require('./avr/avrsim');
const HOST = path.join(__dirname, 'host');
let hasCli = true; try { execFileSync('arduino-cli', ['version']); } catch (e) { hasCli = false; }
const NEW = ['toggle-led', 'ped-light', 'bright-alarm', 'sun-shade', 'bb-two-toggles'];

function runCpp(p, T, schedule, outs) {
  const g = DL.codegen.generate(p); assert.ok(g.ok, (g.blockers || []).join('\n'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-nx-'));
  fs.writeFileSync(path.join(dir, 'sketch.inc'), g.code);
  for (const f of ['Arduino.h', 'Servo.h', 'ESP32Servo.h', 'harness.cpp']) fs.copyFileSync(path.join(HOST, f), path.join(dir, f));
  execFileSync('g++', ['-std=gnu++11', '-O1', '-I', dir, '-o', path.join(dir, 'h'), path.join(dir, 'harness.cpp')], { cwd: dir });
  const a = DL.netlist.analyze(p).bindings; const board = DL.boards[p.board.type];
  const numOf = id => board.pinById[a[id].pin].num;
  const ev = schedule.map(s => 'pressed' in s ? `${s.t} d ${numOf(s.comp)} ${s.pressed ? 0 : 1}` : `${s.t} a ${numOf(s.comp)} ${s.raw}`);
  const input = `${T} ${ev.length}\n${ev.join('\n')}\n${outs.length}\n${outs.map(id => (DL.project.findComp(p, id).type === 'SERVO' ? 's ' : 'd ') + numOf(id)).join('\n')}\n`;
  return execFileSync(path.join(dir, 'h'), { input }).toString().trim().split('\n').map(l => l.split(' ').map(Number));
}
function compare(p, T, schedule, outs) {
  const eng = runEngine(p, T, schedule).map(o => outs.map(id => Number(o[id])));
  const cpp = runCpp(p, T, schedule, outs);
  assert.strictEqual(cpp.length, eng.length);
  for (let t = 0; t < eng.length; t++) assert.deepStrictEqual(cpp[t], eng[t], `t=${t} ms：C++=${cpp[t]} 引擎=${eng[t]}`);
  return eng;
}
const flips = (rows, i, a, b) => { let n = 0; for (let t = a + 1; t < b; t++) if (rows[t][i] !== rows[t - 1][i]) n++; return n; };

test('五個新實驗：可建立、元件與行為鎖定；解答（接線助手）沒有錯誤；行為驗證通過；三種語言都能產生程式；Pi 不支援光感實驗', () => {
  for (const id of NEW) for (const b of DL.boardList) {
    const r = DL.experiments.instantiate(id, b); const e = DL.experiments.list.find(x => x.id === id);
    if (!DL.experiments.supports(e, b)) { assert.strictEqual(r.ok, false); assert.match(r.msg, /ADC/); continue; }
    assert.ok(r.project.lock.components && r.project.lock.behavior);
    assert.strictEqual(r.project.connections.filter(w => w.kind !== 'insert').length, 0, '學生從沒有接線開始');
    const p = solved(id, b); const a = DL.netlist.analyze(p);
    assert.ok(a.ok, `${id}/${b}：` + a.issues.filter(i => i.level === 'error').map(i => i.msg).join('；'));
    assert.ok(DL.behavior.validate(p, a).ok, `${id}/${b} 行為`);
    for (const [comp, pin] of Object.entries(DL.experiments.suggestFor(e, b))) assert.strictEqual(a.bindings[comp].pin, pin, `${id}/${b} ${comp}`);
    for (const c of p.components.filter(c => c.type === 'LED')) assert.strictEqual(a.bindings[c.id].via.length, 1, `${c.id} 有自己的限流電阻`);
    const g = DL.codegen.generate(p); assert.ok(g.ok, (g.blockers || []).join());
    const ctx = { confirmedCurrent: true, maxHoldMs: 2000, presses: 3, minLight: 10, maxLight: 90, armConfirmed: true };
    assert.ok(e.tasks.every(t => t.check(p, a, ctx)), `${id}/${b}：解答應該讓所有任務打勾`);
  }
});

test('按一下切換：每次按下切換一次，按住不會連續切換（Uno、ESP32 逐毫秒等價）', () => {
  for (const b of ['uno', 'esp32']) {
    const p = solved('toggle-led', b);
    const rows = compare(p, 2400, [{ t: 100, comp: 'BTN1', pressed: true }, { t: 300, comp: 'BTN1', pressed: false }, { t: 600, comp: 'BTN1', pressed: true }, { t: 800, comp: 'BTN1', pressed: false }, { t: 1000, comp: 'BTN1', pressed: true }, { t: 2000, comp: 'BTN1', pressed: false }], ['LED1']);
    assert.strictEqual(rows[110][0], 0); assert.strictEqual(rows[130][0], 1, '去彈跳後切換為亮'); assert.strictEqual(rows[700][0], 0, '第二次按下熄滅');
    assert.strictEqual(rows[1100][0], 1); assert.strictEqual(flips(rows, 0, 1030, 2400), 0, '按住 1 秒不會連續切換');
  }
});

test('行人按鈕紅綠燈：開始綠燈；按住紅燈、綠燈滅；放開恢復（Uno、ESP32 逐毫秒等價）', () => {
  for (const b of ['uno', 'esp32']) {
    const p = solved('ped-light', b);
    const rows = compare(p, 1500, [{ t: 200, comp: 'BTN1', pressed: true }, { t: 700, comp: 'BTN1', pressed: false }], ['LED1', 'LED2']);
    assert.deepStrictEqual(rows[5], [0, 1], '開始時綠燈'); assert.deepStrictEqual(rows[300], [1, 0], '按住：紅燈'); assert.deepStrictEqual(rows[900], [0, 1], '放開：綠燈');
  }
});

test('太亮警示：高於 70 % 時 5 Hz 閃爍，降到門檻以下立即熄滅（Uno 10 位元、ESP32 12 位元）', () => {
  for (const [b, max] of [['uno', 1023], ['esp32', 4095]]) {
    const p = solved('bright-alarm', b);
    const rows = compare(p, 1600, [{ t: 0, comp: 'LDR1', raw: Math.round(max * 0.5) }, { t: 200, comp: 'LDR1', raw: Math.round(max * 0.85) }, { t: 1200, comp: 'LDR1', raw: Math.round(max * 0.69) }], ['LED1']);
    assert.strictEqual(rows[100][0], 0); assert.strictEqual(rows[205][0], 1, '超過門檻先亮');
    const n = flips(rows, 0, 200, 1200); assert.ok(n >= 9 && n <= 11, `1 秒內約 10 次轉換（5 Hz），實際 ${n}`);
    assert.strictEqual(rows[1300][0], 0, '低於門檻熄滅');
  }
});

test('光控遮陽板：亮度高於 60 % 命令 150°，回到門檻以下回到初始 30°（Uno、ESP32）', () => {
  for (const [b, max] of [['uno', 1023], ['esp32', 4095]]) {
    const p = solved('sun-shade', b);
    const rows = compare(p, 900, [{ t: 0, comp: 'LDR1', raw: Math.round(max * 0.3) }, { t: 300, comp: 'LDR1', raw: Math.round(max * 0.75) }, { t: 600, comp: 'LDR1', raw: Math.round(max * 0.4) }], ['SERVO1']);
    assert.strictEqual(rows[100][0], 30); assert.strictEqual(rows[400][0], 150); assert.strictEqual(rows[700][0], 30);
  }
});

test('雙按鈕雙燈（麵包板）：兩組各自切換、互不影響（Uno、ESP32）', () => {
  for (const b of ['uno', 'esp32']) {
    const p = solved('bb-two-toggles', b);
    const rows = compare(p, 1500, [{ t: 100, comp: 'BTN1', pressed: true }, { t: 250, comp: 'BTN1', pressed: false }, { t: 500, comp: 'BTN2', pressed: true }, { t: 650, comp: 'BTN2', pressed: false }, { t: 900, comp: 'BTN1', pressed: true }, { t: 1050, comp: 'BTN1', pressed: false }], ['LED1', 'LED2']);
    assert.deepStrictEqual(rows[200], [1, 0]); assert.deepStrictEqual(rows[600], [1, 1]); assert.deepStrictEqual(rows[1000], [0, 1]);
  }
});

/* ---------- 在虛擬 Uno 上執行 arduino-cli 編譯出來的機器碼 ---------- */
function build(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-nxa-')); const sk = path.join(dir, 'sketch'); fs.mkdirSync(sk);
  fs.writeFileSync(path.join(sk, 'sketch.ino'), code);
  const props = (process.env.DOFLAB_ARDUINO_PROPS || '').split(';').filter(Boolean).flatMap(p => ['--build-property', p]);
  execFileSync('arduino-cli', ['compile', '--fqbn', 'arduino:avr:uno', ...props, '--output-dir', path.join(dir, 'out'), sk], { stdio: 'pipe' });
  return path.join(dir, 'out', 'sketch.ino.hex');
}
const uno = id => { const u = new VirtualUno(build(DL.codegen.generate(solved(id, 'uno')).code)); for (const n of [2, 3]) u.setInput(n, true); u.runMs(20); return u; };
const press = (u, pin, ms) => { u.setInput(pin, false); u.runMs(ms || 80); u.setInput(pin, true); u.runMs(80); };

test('虛擬 Uno 執行真實機器碼：按一下切換、紅綠燈、雙按鈕雙燈', { skip: !hasCli && '沒有 arduino-cli', timeout: 300000 }, () => {
  let u = uno('toggle-led');
  assert.strictEqual(u.isHigh(13), false); press(u, 2); assert.strictEqual(u.isHigh(13), true); press(u, 2); assert.strictEqual(u.isHigh(13), false);
  press(u, 2, 1500); assert.strictEqual(u.isHigh(13), true, '按住 1.5 秒只切換一次');
  u = uno('ped-light');
  assert.deepStrictEqual([u.isHigh(13), u.isHigh(12)], [false, true], '開始：綠燈 D12');
  u.setInput(2, false); u.runMs(80); assert.deepStrictEqual([u.isHigh(13), u.isHigh(12)], [true, false], '按住：紅燈 D13');
  u.setInput(2, true); u.runMs(80); assert.deepStrictEqual([u.isHigh(13), u.isHigh(12)], [false, true]);
  u = uno('bb-two-toggles');
  press(u, 2); assert.deepStrictEqual([u.isHigh(13), u.isHigh(12)], [true, false]);
  press(u, 3); assert.deepStrictEqual([u.isHigh(13), u.isHigh(12)], [true, true]);
  press(u, 2); assert.deepStrictEqual([u.isHigh(13), u.isHigh(12)], [false, true]);
});

test('虛擬 Uno 執行真實機器碼：太亮警示（A0 類比電壓 → D13 約 5 Hz）、光控遮陽板（D9 伺服脈寬）', { skip: !hasCli && '沒有 arduino-cli', timeout: 300000 }, () => {
  let u = uno('bright-alarm');
  u.setAnalog(0, 2.5); u.runMs(200); assert.strictEqual(u.isHigh(13), false, '50 %：不亮');
  u.setAnalog(0, 4.25); let edges = 0, last = u.isHigh(13);
  for (let i = 0; i < 1000; i++) { u.runMs(1); const h = u.isHigh(13); if (h !== last) { edges++; last = h; } }
  assert.ok(edges >= 9 && edges <= 11, `85 %：1 秒 ${edges} 次轉換（約 5 Hz）`);
  u.setAnalog(0, 3.4); u.runMs(50); assert.strictEqual(u.isHigh(13), false, '68 %：熄滅');
  u = uno('sun-shade');
  const pulses = []; let rise = null;
  u.pinWatchers.push(() => { const h = u.isHigh(9); if (h && rise === null) rise = u.cpu.cycles; else if (!h && rise !== null) { pulses.push(Math.round((u.cpu.cycles - rise) / 16)); rise = null; } });
  const width = (v, ms) => { u.setAnalog(0, v); pulses.length = 0; u.runMs(ms); return pulses[pulses.length - 1]; };
  const us = a => 544 + (2400 - 544) * a / 180;
  const w30 = width(1.5, 300), w150 = width(3.75, 300), back = width(2.0, 300);
  assert.ok(Math.abs(w30 - us(30)) < 30, `30°：${w30} µs`); assert.ok(Math.abs(w150 - us(150)) < 30, `150°：${w150} µs`); assert.ok(Math.abs(back - us(30)) < 30, `回到 30°：${back} µs`);
});
