// 實測 demo（V2.5 超音波＋SG90）：在虛擬 Uno（avr8js 執行 arduino-cli 編譯的真實機器碼，外接 HC-SR04 時序模型）上量測
// 輸出 JSON：距離指針的角度精度、距離警示燈的反應時間、觸發脈衝時序、DofLabFirmata 1.1 讀值
// 用法：node tests/demo_measure.js <輸出.json>
const { execFileSync } = require('child_process'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { DL, solved } = require('./helpers'); require('../src/drivers/drivers.js'); const { VirtualUno, FREQ } = require('../tools/vdev/avrsim');
function build(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-demo-')); const sk = path.join(dir, 'sketch'); fs.mkdirSync(sk);
  fs.writeFileSync(path.join(sk, 'sketch.ino'), code);
  const props = (process.env.DOFLAB_ARDUINO_PROPS || '').split(';').filter(Boolean).flatMap(p => ['--build-property', p]);
  const out = execFileSync('arduino-cli', ['compile', '--fqbn', 'arduino:avr:uno', ...props, '--output-dir', path.join(dir, 'out'), sk], { stdio: 'pipe' }).toString();
  const m = /使用了 (\d+) 位元組|uses (\d+) bytes/.exec(out);
  return { hex: path.join(dir, 'out', 'sketch.ino.hex'), bytes: m ? +(m[1] || m[2]) : null };
}
const R = { at: new Date().toISOString(), env: { avr8js: require('avr8js/package.json').version } };
const angleOf = w => (w - 544) * 180 / (2400 - 544);

// 1. 超音波距離指針：距離 → 伺服脈寬 → 角度
{
  const b = build(DL.codegen.generate(solved('dist-gauge', 'uno')).code); R.gaugeFlash = b.bytes;
  const u = new VirtualUno(b.hex); const s = u.attachSonar(7, 8, 100); u.runMs(50);
  const pulses = []; let rise = null; u.pinWatchers.push(() => { const h = u.isHigh(9); if (h && rise === null) rise = u.cycle; else if (!h && rise !== null) { pulses.push((u.cycle - rise) / 16); rise = null; } });
  R.gauge = [];
  for (const cm of [3, 5, 8, 10, 13, 15, 18, 20, 23, 25, 28, 30, 33, 35, 38, 40, 43, 45, 48, 50, 55]) {
    s.cm = cm; pulses.length = 0; u.runMs(300);
    const w = pulses[pulses.length - 1]; const exp = Math.trunc((Math.min(50, Math.max(5, cm)) - 5) * (0 - 180) / 45) + 180;
    R.gauge.push({ cm, width: Math.round(w), angle: +angleOf(w).toFixed(1), expected: exp });
  }
}
// 2. 距離警示燈：物體在任意時刻靠近（100 → 12 cm），到 D13 亮起的時間；離開（12 → 100 cm）到熄滅的時間
{
  const b = build(DL.codegen.generate(solved('dist-alarm', 'uno')).code); R.alarmFlash = b.bytes;
  const u = new VirtualUno(b.hex); const s = u.attachSonar(7, 8, 100); u.runMs(200);
  // 觸發脈衝：每次 TRIG 高電位的寬度與間隔
  const trig = []; let hi = null; u.pinWatchers.push(() => { const h = u.isHigh(7); if (h && hi === null) hi = u.cycle; else if (!h && hi !== null) { trig.push({ at: hi, w: (u.cycle - hi) / 16 }); hi = null; } });
  u.runMs(1200);
  const gaps = trig.slice(1).map((t, i) => (t.at - trig[i].at) / FREQ * 1000);
  R.trigger = { count: trig.length, windowMs: 1200, widthUs: [Math.min(...trig.map(t => t.w)), Math.max(...trig.map(t => t.w))].map(x => +x.toFixed(2)), periodMs: [Math.min(...gaps), Math.max(...gaps)].map(x => +x.toFixed(2)), meanPeriodMs: +(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(2) };
  const onLat = [], offLat = [];
  let rnd = 12345; const rand = () => (rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let k = 0; k < 30; k++) {
    u.runMs(40 + rand() * 60);
    s.cm = 12; let t = 0; while (!u.isHigh(13) && t < 400) { u.runMs(0.5); t += 0.5; } onLat.push(t);
    u.runMs(40 + rand() * 60);
    s.cm = 100; t = 0; while (u.isHigh(13) && t < 400) { u.runMs(0.5); t += 0.5; } offLat.push(t);
  }
  const st = a => ({ min: Math.min(...a), max: Math.max(...a), mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1), n: a.length, all: a });
  R.latency = { on: st(onLat), off: st(offLat) };
  // 閾值附近：19 cm 亮、20 cm 不亮、21 cm 不亮（條件「小於 20 cm」）
  R.threshold = [];
  for (const cm of [17, 18, 19, 20, 21, 22]) { s.cm = cm; u.runMs(250); R.threshold.push({ cm, led: u.isHigh(13) ? 1 : 0 }); }
}
// 3. 倒車雷達：30 cm 時黃燈閃爍頻率
{
  const b = build(DL.codegen.generate(solved('parking-radar', 'uno')).code);
  const u = new VirtualUno(b.hex); const s = u.attachSonar(7, 8, 30); u.runMs(300);
  let edges = 0, last = u.isHigh(13); for (let i = 0; i < 2000; i++) { u.runMs(1); const h = u.isHigh(13); if (h !== last) { edges++; last = h; } }
  R.radar = { cm30: { edges2s: edges, hz: edges / 2 / 2, red: u.isHigh(12) ? 1 : 0 } };
  s.cm = 10; u.runMs(300); R.radar.cm10 = { red: u.isHigh(12) ? 1 : 0 };
}
// 4. DofLabFirmata 1.1（真機同步用的韌體）讀值
(async () => {
  const uno = new VirtualUno(path.join(__dirname, 'fixtures', 'DofLabFirmata-uno.hex')); const s = uno.attachSonar(7, 8, 37);
  const port = uno.webSerialPort();
  Object.defineProperty(globalThis.navigator, 'serial', { configurable: true, value: { requestPort: async () => port } });
  const twin = DL.createTwin(); twin.define('US1.distance', {});
  const drv = new DL.drivers.FirmataDriver(twin, {}, 'uno');
  const r = await drv.connect(); twin.connected(r.deviceId, r.info); await drv.watch([{ signal: 'US1.distance', num: 7, echo: 8, kind: 'sonar' }]);
  const wait = ms => new Promise(f => setTimeout(f, ms));
  R.firmata = { info: r.info, version: drv.fwVersion, rows: [] };
  for (const cm of [3, 8, 12, 25, 37, 80, 150, 250, 380, null]) {
    s.cm = cm; await wait(500); const seq0 = twin.view('US1.distance').measured.seq; await wait(400);
    const m = twin.view('US1.distance').measured; R.firmata.rows.push({ set: cm, read: m.v, reports: m.seq - seq0 });
  }
  await drv.disconnect();
  fs.writeFileSync(process.argv[2] || '/tmp/demo.json', JSON.stringify(R, null, 1));
  console.log(JSON.stringify({ gauge: R.gauge.map(g => [g.cm, g.angle, g.expected]), trigger: R.trigger, latency: { on: R.latency.on.min + '–' + R.latency.on.max + ' mean ' + R.latency.on.mean, off: R.latency.off.min + '–' + R.latency.off.max + ' mean ' + R.latency.off.mean }, threshold: R.threshold, radar: R.radar, firmata: R.firmata.rows }));
  process.exit(0);
})();
