// V2.14 訊號測試的數值（鋸齒、三角、方波；兩端都會寫到）與波形紀錄、擷取、存檔格式（src/core/testsig.js）
const test = require('node:test'); const assert = require('node:assert');
const { DL } = require('./helpers');
const T = DL.testsig, W = DL.wave;

test('訊號測試的數值：鋸齒到頂先寫終點再回起點、三角兩端都寫到、方波從終點開始；序號從 1 開始', () => {
  assert.deepStrictEqual(T.sequence({ kind: 'servo', pattern: 'ramp', min: 0, max: 180, step: 50 }, 7), [0, 50, 100, 150, 180, 0, 50]);
  assert.deepStrictEqual(T.sequence({ kind: 'servo', pattern: 'triangle', min: 0, max: 180, step: 50 }, 10), [0, 50, 100, 150, 180, 130, 80, 30, 0, 50]);
  assert.deepStrictEqual(T.sequence({ kind: 'pwm', pattern: 'ramp', min: 0, max: 255, step: 51 }, 7), [0, 51, 102, 153, 204, 255, 0]);
  assert.deepStrictEqual(T.sequence({ kind: 'pwm', pattern: 'square', min: 10, max: 200, step: 1 }, 4), [200, 10, 200, 10]);
  assert.deepStrictEqual(T.sequence({ kind: 'digital', pattern: 'square', min: 0, max: 1, step: 1 }, 4), [1, 0, 1, 0]);
  const g = T.create(Object.assign({ kind: 'servo' }, T.KINDS.servo.def));
  assert.deepStrictEqual([g.next(), g.next()], [{ seq: 1, v: 0 }, { seq: 2, v: 10 }]);
});

test('訊號測試的設定檢查：範圍、起點小於終點、每次變化大於 0、數位輸出只有方波', () => {
  for (const k of Object.keys(T.KINDS)) assert.ok(T.validate(Object.assign({ kind: k }, T.KINDS[k].def)).ok, k + ' 的預設值要能用');
  assert.match(T.validate({ kind: 'servo', pattern: 'ramp', min: 0, max: 200, step: 10 }).msg, /0–180/);
  assert.match(T.validate({ kind: 'pwm', pattern: 'ramp', min: 100, max: 100, step: 10 }).msg, /起點小於終點/);
  assert.match(T.validate({ kind: 'pwm', pattern: 'ramp', min: 0, max: 255, step: 0 }).msg, /大於 0/);
  assert.match(T.validate({ kind: 'digital', pattern: 'ramp', min: 0, max: 1, step: 1 }).msg, /只能用方波/);
  assert.match(T.validate({ kind: 'servo', pattern: 'ramp', min: NaN, max: 180, step: 10 }).msg, /數字/);
  assert.strictEqual(T.validate({ kind: 'x' }).ok, false);
});

test('和虛擬工作台的自動產生輸入同一套規則（鋸齒、三角、方波）', async () => {
  const { Bench } = require('../tools/vdev/bench.js');
  // 工作台的 autoStep 只靠 this.at 排程：用假的時鐘逐步推進
  const q = []; const B = Bench.prototype;
  const fake = { parts: {}, log: [], at: (ms, fn) => q.push(fn), note: () => { }, refreshLdr: () => { }, autoStep: B.autoStep, autoStop: B.autoStop, partState: p => p };
  for (const pattern of ['ramp', 'triangle', 'square']) {
    const p = { id: 'US1', type: 'ultrasonic', cm: 100 }; q.length = 0;
    Bench.prototype.autoStart.call(fake, p, { pattern, min: 10, max: 40, step: 10, everyMs: 100 });
    const got = [p.cm]; for (let i = 0; i < 8; i++) { q.shift()(); got.push(p.cm); }
    const want = pattern === 'square' ? [10, 40, 10, 40, 10, 40, 10, 40, 10] : T.sequence({ kind: 'pwm', pattern, min: 10, max: 40, step: 10 }, 9);
    assert.deepStrictEqual(got, want, pattern);   // 方波：工作台從起點開始（輸入）；測試寫入從終點開始（第一次寫入看得到）
  }
});

test('波形紀錄：換算成 0–1、擷取某段時間（含開始時的值）、存檔格式可以讀回，版本太新或格式不對要拒絕', () => {
  assert.strictEqual(W.norm('LED', 'pwm', 51), 0.2); assert.strictEqual(W.norm('SERVO', 'angle', 90), 0.5);
  assert.strictEqual(W.norm('US', 'distance', 400), 1); assert.strictEqual(W.norm('LED', 'state', true), 1); assert.strictEqual(W.norm('LED', 'state', null), null);
  const rec = { evs: [{ t: 100, k: 'LED1|sim', v: 1 }, { t: 200, k: 'LED1|sim', v: 0 }, { t: 300, k: 'LED1|cmd', v: 1 }, { t: 900, k: 'LED1|sim', v: 1 }], marks: [{ t: 150, seq: 1, comp: 'LED1' }, { t: 250, seq: 2, comp: 'LED1' }] };
  const c = W.capture(rec, 220, 800, { rows: [{ id: 'LED1', ctype: 'LED' }], mode: '模擬' });
  assert.deepStrictEqual(c.init, { 'LED1|sim': 0 }); assert.deepStrictEqual(c.evs.map(e => e.t), [300]); assert.deepStrictEqual(c.marks.map(m => m.seq), [2]);
  assert.strictEqual(c.span, 580);
  const f = JSON.parse(JSON.stringify(W.toFile({ A: c }, { project: 'x' })));
  const r = W.fromFile(f); assert.ok(r.ok); assert.deepStrictEqual(r.captures.A, c);
  assert.strictEqual(W.fromFile({ format: 'other' }).ok, false);
  assert.match(W.fromFile(Object.assign({}, f, { version: 99 })).msg, /更新 DofLab/);
  assert.match(W.fromFile(Object.assign({}, f, { captures: {} })).msg, /沒有擷取/);
});
