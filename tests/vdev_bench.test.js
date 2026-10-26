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
  // 每個預設接在它的板型上（樹莓派的工作台是 Python，在 vdev_pi.test.js 驗）
  const { VirtualEsp32 } = require('../tools/vdev/esp32model');
  const byBoard = b => presets().filter(n => (loadSpec(n).board || 'uno') === b);
  assert.ok(byBoard('uno').length >= 5 && byBoard('esp32').length >= 2, presets().join('、'));
  for (const name of byBoard('uno')) new Bench(new VirtualUno(), name);
  for (const name of byBoard('esp32')) new Bench(new VirtualEsp32(), name);
  assert.throws(() => new Bench(new VirtualUno(), 'esp32-hold-blink'), /是 esp32 用的，不能接在 uno 上/);
  assert.throws(() => new Bench(new VirtualEsp32(), { board: 'esp32', parts: [{ id: 'A', type: 'button', pin: 6 }] }), /不是 ESP32 的/);
  assert.throws(() => new Bench(new VirtualEsp32(), { board: 'esp32', parts: [{ id: 'L', type: 'led', pin: 34 }] }), /GPIO34 只能輸入/);
  assert.throws(() => new Bench(new VirtualEsp32(), { board: 'esp32', parts: [{ id: 'R', type: 'ldr', pin: 4 }] }), /GPIO32–36、39/);
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

test('授權時先送伺服目前的角度（V2.13）：真韌體在虛擬 Uno 上的第一個脈衝就是那個角度；只設成伺服模式時會先輸出 Servo 函式庫預設的 1500 µs', { timeout: 30000 }, async () => {
  for (const [initial, angle] of [[true, 20], [true, 160], [false, 20]]) {   /* 20° = 750 µs、160° = 2193 µs */
    const R = await rig('dist-gauge');
    try {
      R.twin.define('SERVO1.angle', { feedback: false }); R.twin.authorize(['SERVO1.angle']);
      const c = R.twin.command('SERVO1.angle', angle).cmd;
      R.dev.bench.trace.length = 0;
      const out = { signal: 'SERVO1.angle', num: 9, kind: 'servo' };
      if (initial) await R.drv.authorize([Object.assign({ initial: c }, out)]);
      else { await R.drv.authorize([out]); await wait(120); await R.drv.write(c, out); }
      assert.ok(await until(() => R.twin.view('SERVO1.angle').ack && R.twin.view('SERVO1.angle').ack.id === c.id, 3000), '收到回讀確認');
      await wait(100);
      const us = R.dev.bench.trace.filter(e => e.part === 'SERVO1').map(e => e.us); const want = Math.trunc(angle * 1856 / 180) + 544;
      if (initial) assert.ok(us.length >= 1 && Math.abs(us[0] - want) <= 2, `授權時送 ${angle}°：第一個脈衝應該是 ${want} µs，工作台記到 ${JSON.stringify(us)}`);
      else assert.ok(Math.abs(us[0] - 1500) <= 4 && Math.abs(us[us.length - 1] - want) <= 2, `只設成伺服模式：先 1500 µs、命令到了才 ${want} µs，工作台記到 ${JSON.stringify(us)}`);
    } finally { await R.close(); }
  }
});

test('斷線保護（DofLabFirmata 1.2 起，真韌體）：有心跳時輸出一直維持；心跳停了 3 秒 → LED 熄滅、D13 回到輸入、DofLab 收到通知；伺服停止送脈衝但不會轉到 0°', { timeout: 60000 }, async () => {
  let R = await rig('hold-blink');
  try {
    const guards = []; R.drv.hooks.onGuard = w => guards.push(w);
    assert.deepStrictEqual(R.drv.fwVersion, [1, 3]);
    R.twin.define('LED1.state', { feedback: false }); R.twin.authorize(['LED1.state']);
    const out = { signal: 'LED1.state', num: 13, kind: 'digital' };
    await R.drv.authorize([out]); const c = R.twin.command('LED1.state', 1).cmd; await R.drv.write(c, out);
    assert.ok(await until(() => R.part('LED1').on, 2000), 'LED 亮');
    await wait(4500);
    assert.ok(R.part('LED1').on && guards.length === 0, '有心跳（每秒一次）時不會觸發：4.5 秒後 LED 仍亮');
    clearInterval(R.drv.hb);   // 像分頁當掉、電腦睡眠：DofLab 不再送任何位元組
    const t0 = Date.now();
    assert.ok(await until(() => !R.part('LED1').on, 5000), '心跳停了：LED 熄滅');
    const dt = Date.now() - t0; assert.ok(dt >= 1800 && dt <= 4500, `約 3 秒後關掉（實測 ${dt} ms；心跳停的時候上一次心跳可能已經過了 0–1 秒）`);
    assert.strictEqual(R.dev.uno.pinState(13), 2, 'D13 回到輸入（avr8js PinState.Input）');
    assert.ok(await until(() => guards.length === 1, 2000), 'DofLab 收到斷線保護的通知（F0 64 F7）：' + JSON.stringify(guards));
    assert.deepStrictEqual(R.drv.outPins, {}, '驅動忘記已授權的輸出');
  } finally { await R.close(); }
  R = await rig('dist-gauge');
  try {
    R.twin.define('SERVO1.angle', { feedback: false }); R.twin.authorize(['SERVO1.angle']);
    const out = { signal: 'SERVO1.angle', num: 9, kind: 'servo' };
    await R.drv.authorize([Object.assign({ initial: R.twin.command('SERVO1.angle', 120).cmd }, out)]);
    assert.ok(await until(() => R.part('SERVO1').powered && Math.abs(R.part('SERVO1').angle - 120) <= 1.5, 3000), '伺服在 120°');
    clearInterval(R.drv.hb);
    assert.ok(await until(() => !R.part('SERVO1').powered, 5000), '心跳停了：伺服不再收到脈衝');
    const sv = R.part('SERVO1'); assert.ok(Math.abs(sv.angle - 120) <= 1.5 && Math.abs(sv.cmd - 120) <= 1.5, '停在原地，沒有轉到 0°：' + JSON.stringify(sv));
  } finally { await R.close(); }
});

test('連到舊版 DofLabFirmata 1.1（沒有斷線保護）：DofLab 提醒更新（到 1.3）；1.1 的輸出在心跳停了之後仍停在最後的命令', { timeout: 30000 }, async () => {
  const path = require('path');
  const dev = new VirtualDevice({ bench: 'hold-blink', hex: path.join(__dirname, 'fixtures', 'DofLabFirmata-1.1-uno.hex') });
  const port = dev.uno.webSerialPort();
  Object.defineProperty(globalThis.navigator, 'serial', { configurable: true, value: { requestPort: async () => port } });
  const twin = DL.createTwin(); const logs = [];
  const drv = new DL.drivers.FirmataDriver(twin, { log: (m, k) => logs.push([k, m]) }, 'uno');
  try {
    const r = await drv.connect(); twin.connected(r.deviceId, r.info, { virtual: true });
    assert.deepStrictEqual(drv.fwVersion, [1, 1]);
    assert.match(r.info, /DofLabFirmata 1\.1 · Firmata 協定 2\.6/, '連線資訊寫出韌體版本 1.1（不是協定版本 2.6）：' + r.info);
    assert.ok(logs.some(([k, m]) => k === 'w' && /1\.1 沒有斷線保護/.test(m) && /更新到 1\.3/.test(m)), JSON.stringify(logs));
    twin.define('LED1.state', { feedback: false }); twin.authorize(['LED1.state']);
    const out = { signal: 'LED1.state', num: 13, kind: 'digital' };
    await drv.authorize([out]); await drv.write(twin.command('LED1.state', 1).cmd, out);
    assert.ok(await until(() => dev.bench.partState(dev.bench.parts.LED1).on, 2000));
    clearInterval(drv.hb); await wait(4000);
    assert.ok(dev.bench.partState(dev.bench.parts.LED1).on, '1.1 沒有斷線保護：LED 仍亮（這就是要更新的原因）');
  } finally { await drv.disconnect(true); port.stop(); }
});

test('PWM（DofLabFirmata 1.3，真韌體，V2.14）：驅動授權成 PWM、寫工作週期、回讀 ACK；工作台從腳位波形量到頻率與工作週期；改回數位輸出、斷線保護都會停掉 PWM', { timeout: 60000 }, async () => {
  const spec = { id: 'pwm-led', name: 'PWM LED', parts: [{ id: 'LED1', type: 'led', pin: 6 }, { id: 'LED2', type: 'led', pin: 13 }] };
  const R = await rig(spec);
  try {
    assert.deepStrictEqual(R.drv.fwVersion, [1, 3]);
    assert.ok(R.drv.pwmSupport(6).ok, 'D6 可以 PWM'); assert.ok(!R.drv.pwmSupport(13).ok && /不能 PWM/.test(R.drv.pwmSupport(13).msg), 'D13 不能 PWM');
    R.twin.define('LED1.pwm', { feedback: false }); R.twin.authorize(['LED1.pwm']);
    const out = { signal: 'LED1.pwm', num: 6, kind: 'pwm' }; await R.drv.authorize([out]);
    for (const [duty, hz] of [[64, 977], [191, 977], [128, 977]]) {
      const c = R.twin.command('LED1.pwm', duty).cmd; await R.drv.write(c, out);
      assert.ok(await until(() => { const v = R.twin.view('LED1.pwm'); return v.ack && v.ack.id === c.id; }, 3000), `工作週期 ${duty} 收到回讀 ACK`);
      assert.strictEqual(R.twin.view('LED1.pwm').ack.v, duty, '回讀是寫入的工作週期');
      assert.ok(await until(() => { const l = R.part('LED1'); return l.duty !== null && Math.abs(l.duty - duty / 255) < 0.02; }, 3000), `工作台量到工作週期 ${duty}/255：${JSON.stringify(R.part('LED1'))}`);
      assert.ok(Math.abs(R.part('LED1').pwmHz - hz) <= 5, `D6 是 Timer0 的 977 Hz：${R.part('LED1').pwmHz}`);
    }
    const tr = R.dev.bench.trace.filter(e => e.part === 'LED1');
    assert.ok(tr.length < 30 && tr.every(e => e.duty !== undefined || e.on !== undefined || e.pwm), `軌跡只記工作週期的變化（不是每一次亮滅）：${tr.length} 筆`);
    // 改回數位輸出：PWM 停止、寫 LOW
    await R.drv.setKind(out, 'digital');
    assert.ok(await until(() => { const l = R.part('LED1'); return l.duty === null && !l.on; }, 2000), '改回數位輸出：PWM 停止、LED 熄滅');
    await R.drv.setKind(out, 'pwm'); const c2 = R.twin.command('LED1.pwm', 200).cmd; await R.drv.write(c2, Object.assign({}, out, { kind: 'pwm' }));
    assert.ok(await until(() => { const l = R.part('LED1'); return l.duty !== null && Math.abs(l.duty - 200 / 255) < 0.02; }, 3000), '再改回 PWM 可以繼續');
    // 斷線保護：PWM 的腳位也會關掉
    clearInterval(R.drv.hb);
    assert.ok(await until(() => { const l = R.part('LED1'); return l.duty === null && !l.on; }, 6000), '心跳停了：PWM 停止、LED 熄滅');
    assert.strictEqual(R.dev.uno.pinState(6), 2, 'D6 回到輸入');
  } finally { await R.close(); }
});

test('PWM：連到 DofLabFirmata 1.2 時說明要更新（1.3 起才有 PWM）', { timeout: 30000 }, async () => {
  const path = require('path');
  const dev = new VirtualDevice({ bench: 'hold-blink', hex: path.join(__dirname, 'fixtures', 'DofLabFirmata-1.2-uno.hex') });
  const port = dev.uno.webSerialPort();
  Object.defineProperty(globalThis.navigator, 'serial', { configurable: true, value: { requestPort: async () => port } });
  const drv = new DL.drivers.FirmataDriver(DL.createTwin(), {}, 'uno');
  try {
    await drv.connect(); assert.deepStrictEqual(drv.fwVersion, [1, 2]);
    const r = drv.pwmSupport(6); assert.ok(!r.ok && /1\.3 起才有/.test(r.msg) && /上傳 DofLabFirmata/.test(r.msg), r.msg);
  } finally { await drv.disconnect(true); port.stop(); }
});
