// 等價測試：產生的 Arduino C++（以 g++ 搭配主機替身編譯）與模擬引擎逐毫秒比較。
// 這驗證「程式邏輯」一致，不驗證真實板子的時序、電氣或燒錄。
const test = require('node:test'); const assert = require('node:assert');
const { execFileSync } = require('child_process'); const fs = require('fs'); const path = require('path'); const os = require('os');
const { DL, confirm, solved, runEngine } = require('./helpers');
const HOST = path.join(__dirname, 'host');

function runCpp(p, T, schedule, outs) {
  const g = DL.codegen.generate(p); assert.ok(g.ok, (g.blockers || []).join('\n'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-eq-'));
  fs.writeFileSync(path.join(dir, 'sketch.inc'), g.code);
  for (const f of ['Arduino.h', 'Servo.h', 'ESP32Servo.h', 'harness.cpp']) fs.copyFileSync(path.join(HOST, f), path.join(dir, f));
  execFileSync('g++', ['-std=gnu++11', '-O1', '-I', dir, '-o', path.join(dir, 'h'), path.join(dir, 'harness.cpp')], { cwd: dir });
  const a = DL.netlist.analyze(p).bindings; const board = DL.boards[p.board.type];
  const numOf = id => board.pinById[a[id].pin].num;
  const ev = schedule.map(s => 'pressed' in s ? `${s.t} d ${numOf(s.comp)} ${s.pressed ? 0 : 1}` : `${s.t} a ${numOf(s.comp)} ${s.raw}`);
  const input = `${T} ${ev.length}\n${ev.join('\n')}\n${outs.length}\n${outs.map(id => (DL.project.findComp(p, id).type === 'SERVO' ? 's ' : 'd ') + numOf(id)).join('\n')}\n`;
  const out = execFileSync(path.join(dir, 'h'), { input }).toString().trim().split('\n').map(l => l.split(' ').map(Number));
  return { rows: out, code: g.code };
}
function compare(p, T, schedule, outs) {
  const eng = runEngine(p, T, schedule).map(o => outs.map(id => Number(o[id])));
  const cpp = runCpp(p, T, schedule, outs).rows;
  assert.strictEqual(cpp.length, eng.length);
  for (let t = 0; t < eng.length; t++) assert.deepStrictEqual(cpp[t], eng[t], `t=${t} ms：C++=${cpp[t]} 引擎=${eng[t]}`);
  return eng;
}

test('文件範例：按住 BTN1 → LED1 1 Hz 閃爍、放開立即熄滅、再按從亮開始（Uno，逐毫秒等價）', () => {
  const p = solved('hold-blink', 'uno');
  const sch = [{ t: 100, comp: 'BTN1', pressed: true }, { t: 1700, comp: 'BTN1', pressed: false }, { t: 2300, comp: 'BTN1', pressed: true }, { t: 2900, comp: 'BTN1', pressed: false }];
  const rows = compare(p, 3500, sch, ['LED1']);
  const led = t => rows[t][0];
  // 去彈跳 20 ms：按下於 100 → 120 判定 → 120–619 亮、620–1119 暗、1120 亮 …
  assert.strictEqual(led(119), 0); assert.strictEqual(led(120), 1); assert.strictEqual(led(619), 1); assert.strictEqual(led(620), 0);
  assert.strictEqual(led(1119), 0); assert.strictEqual(led(1120), 1);
  // 放開於 1700 → 1720 判定後立即熄滅
  assert.strictEqual(led(1719), 0 + (((1719 - 120) % 1000) < 500 ? 1 : 0)); assert.strictEqual(led(1720), 0);
  // 再次按下 2300 → 2320 從亮開始
  assert.strictEqual(led(2319), 0); assert.strictEqual(led(2320), 1);
  // 1 Hz：完整週期 1000 ms
  const on = rows.slice(120, 1120).filter(r => r[0]).length; assert.strictEqual(on, 500);
});

test('彈跳雜訊：短於去彈跳時間的抖動不觸發（Uno，等價）', () => {
  const p = solved('hold-blink', 'uno');
  const sch = [{ t: 50, comp: 'BTN1', pressed: true }, { t: 55, comp: 'BTN1', pressed: false }, { t: 58, comp: 'BTN1', pressed: true }, { t: 61, comp: 'BTN1', pressed: false }, { t: 300, comp: 'BTN1', pressed: true }, { t: 900, comp: 'BTN1', pressed: false }];
  const rows = compare(p, 1200, sch, ['LED1']);
  assert.ok(rows.slice(0, 320).every(r => r[0] === 0), '抖動期間不應亮');
  assert.strictEqual(rows[320][0], 1);
});

test('ESP32 產生的程式與引擎等價（同樣以主機替身編譯）', () => {
  const p = solved('hold-blink', 'esp32');
  compare(p, 2500, [{ t: 10, comp: 'BTN1', pressed: true }, { t: 1333, comp: 'BTN1', pressed: false }, { t: 1500, comp: 'BTN1', pressed: true }], ['LED1']);
});

test('接續相位（resume）與保持最後狀態（keep）', () => {
  const p = solved('hold-blink', 'uno');
  p.lock.behavior = false;
  p.behavior.ir.rules[0].restart = 'resume'; p.behavior.ir.rules[0].onEnd = 'keep';
  confirm(p);
  const rows = compare(p, 3000, [{ t: 0, comp: 'BTN1', pressed: true }, { t: 730, comp: 'BTN1', pressed: false }, { t: 1500, comp: 'BTN1', pressed: true }, { t: 2600, comp: 'BTN1', pressed: false }], ['LED1']);
  assert.strictEqual(rows[1000][0], 0, 'keep：在暗的相位結束 → 保持暗');
});

test('事件規則：按一下切換（toggle）', () => {
  const p = solved('hold-blink', 'uno'); p.lock.behavior = false;
  p.behavior.ir.rules = [{ type: 'event', event: 'press', comp: 'BTN1', actions: [{ type: 'toggle', comp: 'LED1' }] }];
  confirm(p);
  const rows = compare(p, 1500, [{ t: 100, comp: 'BTN1', pressed: true }, { t: 300, comp: 'BTN1', pressed: false }, { t: 600, comp: 'BTN1', pressed: true }, { t: 800, comp: 'BTN1', pressed: false }], ['LED1']);
  assert.strictEqual(rows[200][0], 1); assert.strictEqual(rows[700][0], 0);
});

test('伺服事件命令（Uno 與 ESP32）', () => {
  for (const b of ['uno', 'esp32']) {
    const p = solved('servo-cmd', b);
    const rows = compare(p, 800, [{ t: 100, comp: 'BTN1', pressed: true }, { t: 400, comp: 'BTN1', pressed: false }], ['SERVO1']);
    assert.strictEqual(rows[50][0], 90); assert.strictEqual(rows[200][0], 150); assert.strictEqual(rows[600][0], 30);
  }
});

test('光控夜燈：ADC 門檻（Uno 10 位元、ESP32 12 位元）', () => {
  for (const [b, max] of [['uno', 1023], ['esp32', 4095]]) {
    const p = solved('night-light', b);
    const rows = compare(p, 600, [{ t: 0, comp: 'LDR1', raw: Math.round(max * 0.6) }, { t: 200, comp: 'LDR1', raw: Math.round(max * 0.2) }, { t: 400, comp: 'LDR1', raw: Math.round(max * 0.31) }], ['LED1']);
    assert.strictEqual(rows[100][0], 0); assert.strictEqual(rows[300][0], 1); assert.strictEqual(rows[500][0], 0);
  }
});

test('多條規則：開始規則＋持續規則優先順序', () => {
  const p = solved('hold-blink', 'uno'); p.lock.behavior = false;
  p.behavior.ir.rules = [{ type: 'start', actions: [{ type: 'led', comp: 'LED1', on: true }] }, ...DL.experiments.HOLD_BLINK];
  confirm(p);
  const rows = compare(p, 2000, [{ t: 300, comp: 'BTN1', pressed: true }, { t: 900, comp: 'BTN1', pressed: false }], ['LED1']);
  assert.strictEqual(rows[100][0], 1, '開始時亮'); assert.strictEqual(rows[1000][0], 0, '持續規則結束 onEnd=off → 熄滅');
});
module.exports = { runCpp };
