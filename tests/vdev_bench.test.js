// 雲端虛擬硬體第 2 階段：工作台（tools/vdev/bench.js）的元件模型，經 FirmataDriver＋Twin Core 讀寫虛擬 Uno（DofLabFirmata 機器碼）
// 驗證：按鈕彈跳、光敏雜訊、超音波（含掉回波）、SG90 命令角與有限速度（只在工作台，介面仍是無回授）、三軸手臂、接錯線。
// 都是「已在虛擬設備驗證」，不是實體設備驗證。
const test = require('node:test'); const assert = require('node:assert');
const { DL } = require('./helpers'); require('../src/drivers/drivers.js');
const { VirtualDevice } = require('../tools/vdev/device.js');
const { loadSpec, presets } = require('../tools/vdev/bench.js');
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 5000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await wait(10); } return false; }

// 一台虛擬設備（同一個程序，用虛擬 Web Serial 連接埠；網路那一段在 vdev.test.js 驗過）＋驅動＋Twin
async function rig(bench) {
  const dev = new VirtualDevice({ bench });
  const port = dev.uno.webSerialPort();
  Object.defineProperty(globalThis.navigator, 'serial', { configurable: true, value: { requestPort: async () => port } });
  const twin = DL.createTwin(); const events = [];
  twin.on(e => { if (e.type === 'measure') events.push(e); });
  const drv = new DL.drivers.FirmataDriver(twin, {}, 'uno');
  const r = await drv.connect(); twin.connected(r.deviceId, r.info, { virtual: true });
  const part = id => dev.bench.partState(dev.bench.parts[id]);
  return { dev, port, twin, drv, events, part, close: async () => { await drv.disconnect(true); port.stop(); } };
}

test('工作台規格：每個預設都能載入；接錯腳位、重複腳位、未知元件都明確拒絕', () => {
  const { VirtualUno } = require('../tools/vdev/avrsim'); const { Bench } = require('../tools/vdev/bench.js');
  assert.ok(presets().includes('arm-3dof') && presets().includes('hold-blink-miswired'));
  for (const name of presets()) new Bench(new VirtualUno(), name);
  assert.throws(() => new Bench(new VirtualUno(), { parts: [{ id: 'A', type: 'button', pin: 2 }, { id: 'B', type: 'led', pin: 2 }] }), /D2 同時接了 A 與 B/);
  assert.throws(() => new Bench(new VirtualUno(), { parts: [{ id: 'A', type: 'button', pin: 25 }] }), /不是 Uno/);
  assert.throws(() => new Bench(new VirtualUno(), { parts: [{ id: 'A', type: 'motor', pin: 3 }] }), /不支援/);
  assert.throws(() => new Bench(new VirtualUno(), 'nope'), /找不到工作台/);
});

test('按鈕彈跳：按下與放開各彈跳 1–3 次、8 ms 內停在新狀態；同一個 seed 結果相同；DofLab 收到彈跳造成的多筆量測', { timeout: 30000 }, async () => {
  const R = await rig('hold-blink');
  try {
    R.twin.define('BTN1.pressed', {}); await R.drv.watch([{ signal: 'BTN1.pressed', num: 2, kind: 'button' }]);
    assert.ok(await until(() => R.twin.view('BTN1.pressed').measured));
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const e0 = R.part('BTN1').edges, m0 = R.events.length, t0 = R.dev.uno.timeMs;
      R.dev.bench.act({ part: 'BTN1', action: 'press' });
      R.dev.uno.runMs(12);
      const edges = R.part('BTN1').edges - e0;
      assert.ok(edges >= 3 && edges % 2 === 1, `按下應有 1 + 2n 次電位變化，實際 ${edges}`);
      assert.strictEqual(R.part('BTN1').level, 'low'); assert.ok(R.dev.uno.timeMs - t0 < 13);
      assert.ok(await until(() => R.twin.view('BTN1.pressed').measured.v === true));
      runs.push([edges, R.events.length - m0]);
      R.dev.bench.act({ part: 'BTN1', action: 'release' }); R.dev.uno.runMs(12);
      assert.ok(await until(() => R.twin.view('BTN1.pressed').measured.v === false));
    }
    assert.ok(runs.some(([, m]) => m > 1), '至少有一次按下時，DofLab 收到不只一筆量測（看得到彈跳）：' + JSON.stringify(runs));
    // 同一個 seed：彈跳次數完全一樣
    const { VirtualUno } = require('../tools/vdev/avrsim'); const { Bench } = require('../tools/vdev/bench.js');
    const seq = () => { const u = new VirtualUno(); const b = new Bench(u, 'hold-blink'); const out = []; for (let i = 0; i < 4; i++) { const e = b.parts.BTN1.edges; b.act({ part: 'BTN1', action: i % 2 ? 'release' : 'press' }); u.runMs(10); out.push(b.parts.BTN1.edges - e); } return out; };
    assert.deepStrictEqual(seq(), seq());
  } finally { await R.close(); }
});

test('光敏模組：亮度 → 電壓（±1 % 雜訊）→ 10 位元 ADC → DofLab 量測的百分比；雜訊讓讀值會跳動', { timeout: 30000 }, async () => {
  const R = await rig('night-light');
  try {
    R.twin.define('LDR1.level', {}); await R.drv.watch([{ signal: 'LDR1.level', num: 14, kind: 'analog' }]);
    for (const L of [25, 80, 5]) {
      R.dev.bench.act({ part: 'LDR1', action: 'set', light: L });
      assert.ok(await until(() => { const m = R.twin.view('LDR1.level').measured; return m && Math.abs(m.v - L) <= 2; }), `亮度 ${L}% → 量測 ${JSON.stringify(R.twin.view('LDR1.level').measured)}`);
    }
    R.dev.bench.act({ part: 'LDR1', action: 'set', light: 50 });
    await wait(300); const n0 = R.events.length; await wait(800);
    const raws = new Set(R.events.slice(n0).filter(e => e.name === 'LDR1.level').map(e => R.twin.view('LDR1.level').measured.raw));
    const vals = R.events.slice(n0).filter(e => e.name === 'LDR1.level').map(e => e.v);
    assert.ok(new Set(vals).size >= 2 || raws.size >= 2, '有雜訊時讀值不會一直相同：' + JSON.stringify(vals.slice(0, 20)));
    assert.ok(vals.every(v => Math.abs(v - 50) <= 2), JSON.stringify(vals.slice(0, 20)));
  } finally { await R.close(); }
});

test('超音波：工作台的距離經 DofLabFirmata 量回來；移走物體與掉回波都回報 400 cm（沒有回波）', { timeout: 30000 }, async () => {
  const spec = loadSpec('dist-gauge'); spec.parts[0].drop = 0.5;
  const R = await rig(spec);
  try {
    R.twin.define('US1.distance', {}); await R.drv.watch([{ signal: 'US1.distance', num: 7, echo: 8, kind: 'sonar' }]);
    R.dev.bench.act({ part: 'US1', action: 'set', cm: 30 });
    const vals = []; R.twin.on(e => { if (e.type === 'measure' && e.name === 'US1.distance') vals.push(e.v); });
    assert.ok(await until(() => vals.filter(v => Math.abs(v - 30) <= 1).length >= 3 && vals.filter(v => v === 400).length >= 2, 8000), '掉回波一半：應同時看到 30 cm 與 400 cm：' + JSON.stringify(vals.slice(-20)));
    assert.ok(vals.every(v => Math.abs(v - 30) <= 1 || v === 400), JSON.stringify(vals));
    const st = R.part('US1'); assert.ok(st.dropped > 0 && st.echoes > 0, JSON.stringify(st));
    R.dev.bench.parts.US1.drop = 0; R.dev.bench.act({ part: 'US1', action: 'set', cm: null });
    vals.length = 0; assert.ok(await until(() => vals.length >= 3 && vals.slice(-3).every(v => v === 400), 5000), JSON.stringify(vals));
  } finally { await R.close(); }
});

test('SG90：工作台從脈寬算出命令角，再以有限速度轉過去；DofLab 只有命令與回讀 ACK，量測仍是「無回授」', { timeout: 30000 }, async () => {
  const R = await rig('dist-gauge');
  try {
    R.twin.define('SERVO1.angle', { feedback: false });
    R.twin.authorize(['SERVO1.angle']); await R.drv.authorize([{ signal: 'SERVO1.angle', num: 9, kind: 'servo' }]);
    const go = async a => { const c = R.twin.command('SERVO1.angle', a).cmd; await R.drv.write(c, { num: 9, kind: 'servo' }); assert.ok(await until(() => R.twin.view('SERVO1.angle').ack && R.twin.view('SERVO1.angle').ack.id === c.id)); };
    await go(0); assert.ok(await until(() => R.part('SERVO1').angle !== null && Math.abs(R.part('SERVO1').angle) <= 1.5, 3000), JSON.stringify(R.part('SERVO1')));
    await go(180);
    assert.ok(await until(() => R.part('SERVO1').cmd > 178, 1000));
    const mid = R.part('SERVO1');
    assert.ok(mid.angle < 170 && mid.moving, '命令剛改變時伺服還在轉（有限速度）：' + JSON.stringify(mid));
    assert.ok(await until(() => Math.abs(R.part('SERVO1').angle - 180) <= 1.5, 2000), JSON.stringify(R.part('SERVO1')));
    assert.ok(R.part('SERVO1').pulseUs >= 2350 && R.part('SERVO1').pulseUs <= 2450, JSON.stringify(R.part('SERVO1')));
    const v = R.twin.view('SERVO1.angle');
    assert.strictEqual(v.measured, null); assert.strictEqual(v.quality, 'none', 'SG90 沒有回授：工作台的角度不會進到量測層');
  } finally { await R.close(); }
});

test('三軸手臂：DofLab 送出的關節命令 → 三個腳位的脈寬 → 工作台的關節角與手臂末端位置，和 DofLab 的命令姿態一致', { timeout: 40000 }, async () => {
  const R = await rig('arm-3dof');
  try {
    const cfg = DL.arm.defaultConfig(); const sig = ['SERVO1.angle', 'SERVO2.angle', 'SERVO3.angle'];
    sig.forEach(s => R.twin.define(s, { feedback: false })); R.twin.authorize(sig);
    await R.drv.authorize([9, 10, 11].map((num, i) => ({ signal: sig[i], num, kind: 'servo' })));
    for (const q of [[0, 90, 80], [30, 60, 40], [-45, 120, 100]]) {
      const s = DL.arm.toServo(cfg, q);
      for (let i = 0; i < 3; i++) { const c = R.twin.command(sig[i], s[i]).cmd; if (c) await R.drv.write(c, { num: [9, 10, 11][i], kind: 'servo' }); }
      assert.ok(await until(() => { const a = R.part('ARM'); return a.joints.every((j, i) => j.q !== null && Math.abs(j.q - q[i]) <= 1.5); }, 3000), `姿態 ${q}：工作台 ${JSON.stringify(R.part('ARM').joints)}`);
      const tip = R.part('ARM').pos.tip, ref = DL.arm.fk(cfg, q);
      assert.ok(Math.hypot(tip.x - ref.x, tip.y - ref.y, tip.z - ref.z) < 0.4, `末端位置 ${JSON.stringify(tip)} vs DofLab ${JSON.stringify(ref)}`);
    }
    assert.ok(sig.every(s => R.twin.view(s).quality === 'none'));
  } finally { await R.close(); }
});

test('接錯線（按鈕接 D3、LED 接 D12）：按按鈕 DofLab 的 D2 沒有變化；LED 命令有 ACK，但工作台上的 LED 不亮', { timeout: 30000 }, async () => {
  const R = await rig('hold-blink-miswired');
  try {
    R.twin.define('BTN1.pressed', {}); R.twin.define('LED1.state', { feedback: false });
    await R.drv.watch([{ signal: 'BTN1.pressed', num: 2, kind: 'button' }]);
    assert.ok(await until(() => R.twin.view('BTN1.pressed').measured));
    assert.strictEqual(R.twin.view('BTN1.pressed').measured.v, false, '空接的 D2 開了內部上拉：和實體晶片一樣讀到 HIGH（沒按）');
    const n0 = R.events.filter(e => e.name === 'BTN1.pressed' && e.v === true).length;
    R.dev.bench.act({ part: 'BTN1', action: 'press' }); await wait(400); R.dev.bench.act({ part: 'BTN1', action: 'release' }); await wait(300);
    assert.strictEqual(R.events.filter(e => e.name === 'BTN1.pressed' && e.v === true).length, n0, 'D2 沒有接按鈕：按下不會出現在量測');
    R.twin.authorize(['LED1.state']); await R.drv.authorize([{ signal: 'LED1.state', num: 13, kind: 'digital' }]);
    const c = R.twin.command('LED1.state', 1).cmd; await R.drv.write(c, { num: 13, kind: 'digital' });
    assert.ok(await until(() => R.twin.view('LED1.state').ack && R.twin.view('LED1.state').ack.matches), 'D13 的回讀 ACK 一樣是 1');
    assert.ok(R.dev.uno.isHigh(13), '晶片的 D13 確實是 HIGH');
    assert.strictEqual(R.part('LED1').on, false, '但工作台的 LED 接在 D12，沒有亮');
  } finally { await R.close(); }
});
