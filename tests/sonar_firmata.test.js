// 超音波真機同步：Firmata 驅動 × DofLabFirmata 1.1（真實 hex 在虛擬 Uno 上執行），外接 HC-SR04 時序模型。
// StandardFirmata 沒有超音波功能：驅動要明確回報「不支援」，不送出任何設定。
const test = require('node:test'); const assert = require('node:assert'); const path = require('path');
const { DL } = require('./helpers'); require('../src/drivers/drivers.js');
const { VirtualUno } = require('./avr/avrsim');
const FIX = f => path.join(__dirname, 'fixtures', f);
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 6000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await wait(20); } return false; }

function rig(hex) {
  const uno = new VirtualUno(hex); const sonar = uno.attachSonar(7, 8, 37);
  const port = uno.webSerialPort();
  Object.defineProperty(globalThis.navigator, 'serial', { configurable: true, value: { requestPort: async () => port } });
  const twin = DL.createTwin(); const logs = [];
  const drv = new DL.drivers.FirmataDriver(twin, { log: m => logs.push(m), onLost: () => logs.push('LOST') }, 'uno');
  twin.define('US1.distance', {});
  const sent = []; const orig = drv.send.bind(drv); drv.send = b => { sent.push(...b); return orig(b); };
  return { uno, sonar, port, twin, drv, logs, sent };
}
const SONAR = [{ signal: 'US1.distance', num: 7, echo: 8, kind: 'sonar' }];

test('虛擬 Uno＋DofLabFirmata 1.1：唯讀時讀到超音波距離（誤差 ≤ 1 cm）、沒有回波回報 400、斷線後 TRIG 回到輸入', { timeout: 90000 }, async () => {
  const { uno, sonar, twin, drv, sent } = rig(FIX('DofLabFirmata-uno.hex'));
  try {
    const r = await drv.connect(); twin.connected(r.deviceId, r.info);
    assert.deepStrictEqual(drv.fwVersion, [1, 1]);
    const w = await drv.watch(SONAR); assert.ok(!w.sonarUnsupported);
    assert.ok(!sent.some((b, i) => b === 0xF5 || b === 0xF4), '唯讀：沒有設定輸出模式或寫值（只有超音波設定）');
    assert.ok(await until(() => twin.view('US1.distance').measured), '收到距離回報');
    const near = v => async () => (await until(() => { const m = twin.view('US1.distance').measured; return m && Math.abs(m.v - v) <= 1; })) || twin.view('US1.distance').measured.v;
    assert.strictEqual(await near(37)(), true, '37 cm');
    sonar.cm = 12; assert.strictEqual(await near(12)(), true, '12 cm');
    sonar.cm = 150; assert.strictEqual(await near(150)(), true, '150 cm');
    sonar.cm = null; assert.ok(await until(() => twin.view('US1.distance').measured.v === 400), '沒有回波：400');
    assert.strictEqual(sonar.short, 0, '觸發脈衝都至少 10 µs');
    assert.ok(uno.cpu.data[0x2A] & 0x80, '量測期間 D7（TRIG）是輸出');
    const seq0 = twin.view('US1.distance').measured.seq; await wait(600);
    const n = twin.view('US1.distance').measured.seq - seq0; assert.ok(n >= 5, `約每 60 ms 回報一次（0.6 秒 ${n} 次）`);
  } finally { await drv.disconnect(); }
  uno.runMs(20);
  assert.strictEqual(uno.cpu.data[0x2A] & 0x80, 0, '斷線：D7 回到輸入，不再送出觸發脈衝');
  const p0 = sonar.pulses; uno.runMs(300); assert.strictEqual(sonar.pulses, p0);
});

test('虛擬 Uno＋StandardFirmata：超音波明確回報不支援、不送出任何設定，距離維持未知', { timeout: 60000 }, async () => {
  const { twin, drv, sent, sonar } = rig(FIX('StandardFirmata-2.5.9-uno.hex'));
  try {
    const r = await drv.connect(); twin.connected(r.deviceId, r.info);
    sent.length = 0;
    const w = await drv.watch(SONAR);
    assert.match(w.sonarUnsupported, /StandardFirmata 不支援超音波/);
    assert.ok(!sent.includes(0x62), '沒有送出超音波設定');
    await wait(500); assert.strictEqual(twin.view('US1.distance').measured, null); assert.strictEqual(sonar.pulses, 0);
  } finally { await drv.disconnect(); }
});
