// 雲端虛擬硬體第 6 階段：虛擬 ESP32 的協定模型（tools/vdev/esp32model.js）。它是 JS 程式，不是實際韌體，所以要先驗證「模型的協定行為和韌體相同」：
//   1. 同一段 Firmata 訊息，送給「Uno 腳位表的模型」和「虛擬 Uno 上的真 DofLabFirmata 機器碼」，回覆逐位元組相同（超音波的距離容許 ±1 cm；含 1.2 的斷線保護）
//   2. ESP32 腳位表：能力回報、類比對應、只能輸入的腳位、類比 12 位元，和韌體原始碼的 ESP32 分支相同
// 這驗證的是模型，不是 ESP32 晶片：ESP32 的韌體機器碼沒有在任何地方執行過（「協定模型，不是實際韌體」）。
const test = require('node:test'); const assert = require('node:assert'); const path = require('path');
const { VirtualUno } = require('../tools/vdev/avrsim');
const { VirtualEsp32, pinValid } = require('../tools/vdev/esp32model');
const { Bench } = require('../tools/vdev/bench');
const HEX = path.join(__dirname, 'fixtures', 'DofLabFirmata-uno.hex');

// 把位元組流切成 Firmata 訊息（sysex 一則；其他依命令長度）
function frames(bytes) {
  const out = []; let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b === 0xF0) { const j = bytes.indexOf(0xF7, i); if (j < 0) { out.push(bytes.slice(i)); break; } out.push(bytes.slice(i, j + 1)); i = j + 1; }
    else if (b === 0xF9) { out.push(bytes.slice(i, i + 3)); i += 3; }
    else if ((b & 0xF0) === 0x90 || (b & 0xF0) === 0xE0) { out.push(bytes.slice(i, i + 3)); i += 3; }
    else { out.push([b]); i++; }
  }
  return out;
}
const hex = a => a.map(x => x.toString(16).padStart(2, '0')).join(' ');
function rig(chip) {
  const rx = []; chip.onSerial = b => rx.push(b);
  const bench = new Bench(chip, { id: 'cmp', board: 'uno', seed: 1, parts: [{ id: 'BTN1', type: 'button', pin: 2, bounceMs: 0 }, { id: 'US1', type: 'ultrasonic', trig: 7, echo: 8, cm: 100 }, { id: 'SERVO1', type: 'servo', pin: 9 }, { id: 'LDR1', type: 'ldr', pin: 14, light: 50, noise: 0 }] });
  let t = 0; while (!rx.includes(0x79) && t < 2000) { chip.runMs(5); t += 5; }   // 等開機訊息（版本＋韌體名稱）
  chip.runMs(20);
  return { chip, bench, take: () => frames(rx.splice(0)) };
}

test('協定模型（Uno 腳位表）和虛擬 Uno 上的真 DofLabFirmata：同一段訊息的回覆逐位元組相同', () => {
  const real = rig(new VirtualUno(HEX)), model = rig(new VirtualEsp32({ board: 'uno', profile: 'uno' }));
  assert.deepStrictEqual(model.take().map(hex), real.take().map(hex), '開機訊息（版本、韌體名稱）');
  // 每一步：送出訊息（或操作工作台），兩邊各跑 ms 毫秒，回覆要相同
  const steps = [
    ['查版本', [0xF9]], ['查韌體名稱', [0xF0, 0x79, 0xF7]], ['能力', [0xF0, 0x6B, 0xF7]], ['類比對應', [0xF0, 0x69, 0xF7]],
    ['D2 上拉＋數位回報', [0xF4, 2, 0x0B, 0xD0, 1]], ['按下按鈕', b => b.act({ part: 'BTN1', action: 'press' })], ['放開按鈕', b => b.act({ part: 'BTN1', action: 'release' })],
    ['D13 輸出＋埠 1 回報', [0xF4, 13, 1, 0xD1, 1]], ['D13 = 1（F5）', [0xF5, 13, 1]], ['回讀 D13', [0xF0, 0x6D, 13, 0xF7]],
    ['埠寫入（91）D13 = 0', [0x91, 0x00, 0x00]], ['回讀 D13', [0xF0, 0x6D, 13, 0xF7]], ['回讀 D2（輸入）', [0xF0, 0x6D, 2, 0xF7]],
    ['D9 伺服 90°', [0xF4, 9, 4, 0xE9, 90, 0]], ['回讀 D9', [0xF0, 0x6D, 9, 0xF7]], ['擴充類比 D9 = 180°', [0xF0, 0x6F, 9, 0x34, 0x01, 0xF7]], ['回讀 D9（兩個位元組）', [0xF0, 0x6D, 9, 0xF7]],
    ['伺服 200° 限制為 180°', [0xE9, 0x48, 0x01, 0xF0, 0x6D, 9, 0xF7]],
    ['不存在的腳位', [0xF4, 25, 1, 0xF0, 0x6D, 30, 0xF7, 0xF5, 40, 1]],
    ['A0 類比＋回報', [0xF4, 14, 2, 0xC0, 1], 45], ['關掉類比回報', [0xC0, 0]],
    ['超音波 D7／D8', [0xF0, 0x62, 7, 8, 0xF7], 130], ['回讀 D7（超音波）', [0xF0, 0x6D, 7, 0xF7]], ['停止超音波', [0xF0, 0x62, 0x7F, 0xF7], 80], ['回讀 D7', [0xF0, 0x6D, 7, 0xF7]],
    // PWM（韌體 1.3）：設成 PWM、寫入工作週期、回讀；超過 255 限制為 255；不是 PWM 腳位、或 Uno 有伺服時的 D10（Timer1）拒絕；離開 PWM 寫 LOW
    ['D6 PWM＋工作週期 128', [0xF4, 6, 3, 0xE6, 0x00, 0x01], 30], ['回讀 D6（兩個位元組）', [0xF0, 0x6D, 6, 0xF7]],
    ['PWM 300 限制為 255', [0xE6, 0x2C, 0x02, 0xF0, 0x6D, 6, 0xF7]], ['擴充類比 D6 = 64', [0xF0, 0x6F, 6, 64, 0, 0xF7, 0xF0, 0x6D, 6, 0xF7]],
    ['D7 不是 PWM 腳位（拒絕）', [0xF4, 7, 3, 0xF0, 0x6D, 7, 0xF7]], ['D10 PWM：有伺服時拒絕（Timer1）', [0xF4, 10, 3, 0xF0, 0x6D, 10, 0xF7]],
    ['D6 離開 PWM（改成輸出）', [0xF4, 6, 1, 0xF0, 0x6D, 6, 0xF7]], ['D6 再設成 PWM＝100', [0xF4, 6, 3, 0xE6, 100, 0, 0xF0, 0x6D, 6, 0xF7]],
    ['斷線保護：3.2 秒沒有收到位元組（D13 輸出、D9 伺服、D6 PWM → 關掉並送 F0 64 F7）', [], 3200], ['斷線保護之後回讀 D13、D9、D6', [0xF0, 0x6D, 13, 0xF7, 0xF0, 0x6D, 9, 0xF7, 0xF0, 0x6D, 6, 0xF7]],
    ['沒有輸出時不再通知', [], 3200],
        ['系統重設', [0xFF]], ['重設後回讀 D13、D9', [0xF0, 0x6D, 13, 0xF7, 0xF0, 0x6D, 9, 0xF7]], ['重設後不再回報', b => b.act({ part: 'BTN1', action: 'press' })]
  ];
  let n = 0, ns = 0;
  for (const [name, what, ms] of steps) {
    for (const r of [real, model]) { if (typeof what === 'function') what(r.bench); else r.chip.sendBytes(what); r.chip.runMs(ms || 80); }   // 真晶片的序列埠 57600 bps：能力回覆（約 200 位元組）要 35 ms 才送完
    let a = real.take(), b = model.take();
    // 超音波距離：真韌體每一輪 loop 才看一次 ECHO，量到的寬度可能少一輪（約 1 cm）；模型是理想值。其餘位元組必須相同
    const sonar = f => f[0] === 0xF0 && f[1] === 0x63;
    const cm = f => f[3] | f[4] << 7;
    const sa = a.filter(sonar), sb = b.filter(sonar);
    if (sa.length || sb.length) {
      assert.ok(sa.length >= 1 && Math.abs(sa.length - sb.length) <= 1, `${name}：超音波回報 ${sa.length}／${sb.length} 則`);
      for (let i = 0; i < Math.min(sa.length, sb.length); i++) assert.ok(sa[i][2] === sb[i][2] && Math.abs(cm(sa[i]) - cm(sb[i])) <= 1, `${name}：${hex(sa[i])} vs ${hex(sb[i])}`);
      ns += sa.length; a = a.filter(f => !sonar(f)); b = b.filter(f => !sonar(f));
    }
    if (name.startsWith('斷線保護：')) assert.ok(a.map(hex).includes('f0 64 f7'), `${name}：真韌體應該送出 F0 64 F7，收到 ${a.map(hex).join('｜')}`);
    if (name === '沒有輸出時不再通知') assert.ok(!a.map(hex).includes('f0 64 f7'), name);
    assert.deepStrictEqual(b.map(hex), a.map(hex), `${name}：模型的回覆和真韌體不同`); n += a.length;
  }
  assert.ok(n >= 20 && ns >= 2, `比對了 ${n} 則訊息、${ns} 則超音波回報`);
});

test('PWM 波形（韌體 1.3）：虛擬 Uno 上的真韌體和協定模型（Uno 腳位表）的頻率與工作週期相同；ESP32 腳位表 1 kHz', () => {
  // 量 100 ms 的上升緣與高電位時間：真韌體是 avr8js 的計時器硬體 PWM（D6 Timer0 977 Hz、D3 Timer2 490 Hz），模型是照韌體寫的波形
  const measure = (chip, pin, duty, warm) => {
    let last = chip.isHigh(pin), rises = [], hiMs = 0, t = null;
    chip.pinWatchers.push(() => { const h = chip.isHigh(pin); if (h === last) return; last = h; if (h) { rises.push(chip.timeMs); t = chip.timeMs; } else if (t !== null) { hiMs += chip.timeMs - t; t = null; } });
    chip.sendBytes([0xF4, pin, 3]); chip.sendBytes(pin < 16 ? [0xE0 | pin, duty & 0x7F, duty >> 7] : [0xF0, 0x6F, pin, duty & 0x7F, duty >> 7, 0xF7]); chip.runMs(warm);
    rises = []; hiMs = 0; t = chip.isHigh(pin) ? chip.timeMs : null; const t0 = chip.timeMs; chip.runMs(100);
    if (t !== null) hiMs += chip.timeMs - t;
    const n = rises.length; return { hz: n > 1 ? (n - 1) / (rises[n - 1] - rises[0]) * 1000 : 0, duty: hiMs / (chip.timeMs - t0), high: chip.isHigh(pin) };
  };
  for (const [pin, duty, hz] of [[6, 64, 976.5625], [3, 191, 490.196], [6, 255, 0], [3, 0, 0]]) {
    const real = new VirtualUno(HEX); real.runMs(600); const model = new VirtualEsp32({ board: 'uno', profile: 'uno' }); model.runMs(600);
    const a = measure(real, pin, duty, 20), b = measure(model, pin, duty, 20);
    if (hz) {
      assert.ok(Math.abs(a.hz - hz) / hz < 0.01 && Math.abs(b.hz - hz) / hz < 0.01, `D${pin} 頻率：真韌體 ${a.hz.toFixed(1)}、模型 ${b.hz.toFixed(1)}，應該約 ${hz} Hz`);
      assert.ok(Math.abs(a.duty - b.duty) < 0.02 && Math.abs(b.duty - duty / 255) < 0.01, `D${pin} 工作週期：真韌體 ${a.duty.toFixed(3)}、模型 ${b.duty.toFixed(3)}，寫入 ${duty}/255`);
    } else assert.ok(a.hz === 0 && b.hz === 0 && a.high === (duty === 255) && b.high === (duty === 255), `D${pin} = ${duty}：兩邊都是固定的${duty === 255 ? '高' : '低'}電位：${JSON.stringify([a, b])}`);
  }
  const e = new VirtualEsp32(); e.runMs(400); const m = measure(e, 18, 128, 5);
  assert.ok(Math.abs(m.hz - 1000) < 5 && Math.abs(m.duty - 128 / 255) < 0.01, `ESP32 GPIO18：${JSON.stringify(m)}`);
  for (const pin of [0, 1, 3, 34]) { const x = new VirtualEsp32(); x.runMs(400); x.sendBytes([0xF4, pin, 3]); assert.notStrictEqual(x.mode[pin], 3, `GPIO${pin} 不能 PWM`); }
});

test('ESP32 腳位表：能力、類比對應、只能輸入的腳位（GPIO34–39）、12 位元類比，和韌體原始碼的 ESP32 分支相同', () => {
  const m = new VirtualEsp32(); const rx = []; m.onSerial = b => rx.push(b);
  m.runMs(400);
  assert.deepStrictEqual(frames(rx.splice(0)).map(hex)[0], 'f9 02 06', '開機先送版本');
  m.sendBytes([0xF0, 0x6B, 0xF7]); const cap = frames(rx.splice(0))[0];
  const pins = []; let cur = []; for (const b of cap.slice(2, -1)) { if (b === 0x7F) { pins.push(cur); cur = []; } else cur.push(b); }
  assert.strictEqual(pins.length, 40);
  const modes = p => { const o = {}; for (let i = 0; i < pins[p].length; i += 2) o[pins[p][i]] = pins[p][i + 1]; return o; };
  assert.deepStrictEqual(modes(0), {}, 'GPIO0、1 不列能力（和韌體的 p > 1 相同）'); assert.deepStrictEqual(modes(6), {}, 'GPIO6–11 接 Flash，不能用');
  assert.deepStrictEqual(modes(23), { 0: 1, 1: 1, 0x0B: 1, 4: 14, 3: 8 }, 'GPIO23：輸入、輸出、上拉、伺服、8 位元 PWM（1.3）');
  assert.deepStrictEqual(modes(34), { 0: 1, 2: 12 }, 'GPIO34：只能輸入＋12 位元類比');
  assert.deepStrictEqual(modes(32), { 0: 1, 1: 1, 0x0B: 1, 4: 14, 3: 8, 2: 12 });
  assert.ok(modes(2)[3] === 8 && modes(3)[3] === undefined, 'GPIO2（DevKit V1 的藍燈）可以 PWM；GPIO3（RX）不行');
  m.sendBytes([0xF0, 0x69, 0xF7]); const am = frames(rx.splice(0))[0].slice(2, -1);
  assert.deepStrictEqual([32, 33, 34, 35, 36, 39].map(p => am[p]), [0, 1, 2, 3, 4, 5]); assert.strictEqual(am.filter(x => x !== 0x7F).length, 6);
  // 只能輸入的腳位拒絕輸出與伺服；有效腳位清單和韌體相同
  m.sendBytes([0xF4, 34, 1, 0xF0, 0x6D, 34, 0xF7]); assert.deepStrictEqual(frames(rx.splice(0)).map(hex), ['f0 6e 22 00 00 f7'], 'GPIO34 設輸出被拒絕，仍是輸入');
  assert.deepStrictEqual([...Array(40).keys()].filter(pinValid), [0, 1, 2, 3, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33, 34, 35, 36, 39]);
  // 類比：3.3 V × 50 % → 12 位元的 2048（線性假設）
  const b = new Bench(m, 'esp32-night-light'); b.parts.LDR1.noise = 0; b.act({ part: 'LDR1', action: 'set', light: 50 });
  m.sendBytes([0xF4, 34, 2, 0xC2, 1]); m.runMs(120);
  const an = frames(rx.splice(0)).filter(f => f[0] === 0xE2); assert.ok(an.length >= 2, '每 50 ms 一則'); assert.strictEqual(an[0][1] | an[0][2] << 7, 2048);
});

test('ESP32 協定模型：伺服脈寬（544–2400 µs）、超音波每 60 ms、按鈕與 LED 經工作台；重新開機（RESET）後腳位回到輸入、要重新交握', () => {
  const m = new VirtualEsp32(); const rx = []; m.onSerial = x => rx.push(x);
  const b = new Bench(m, 'esp32-dist-gauge'); m.runMs(400); rx.length = 0;
  m.sendBytes([0xF4, 18, 4, 0xE2, 0, 0]); m.runMs(100);   // GPIO18 伺服 0°（E2 只能到 15 號腳位 → 這則不會動，和韌體相同）
  m.sendBytes([0xF0, 0x6F, 18, 0, 0, 0xF7]); m.runMs(100); assert.strictEqual(b.partState(b.parts.SERVO1).pulseUs, 544);
  m.sendBytes([0xF0, 0x6F, 18, 90, 0, 0xF7]); m.runMs(100); assert.strictEqual(b.partState(b.parts.SERVO1).pulseUs, 1472);
  m.sendBytes([0xF0, 0x6F, 18, 0x34, 0x01, 0xF7]); m.runMs(100); assert.strictEqual(b.partState(b.parts.SERVO1).pulseUs, 2400);
  rx.length = 0; b.act({ part: 'US1', action: 'set', cm: 42 });
  m.sendBytes([0xF0, 0x62, 26, 27, 0xF7]); m.runMs(605);
  const so = frames(rx.splice(0)).filter(f => f[1] === 0x63);
  assert.ok(so.length >= 10 && so.length <= 11, '600 ms 內 10–11 則：' + so.length); assert.ok(so.every(f => f[2] === 26 && (f[3] | f[4] << 7) === 42));
  b.act({ part: 'US1', action: 'stuck' }); m.runMs(30); rx.length = 0; m.runMs(300);
  assert.strictEqual(frames(rx.splice(0)).filter(f => f[1] === 0x63).length, 0, 'ECHO 卡在高電位：韌體不再觸發、不再回報（和虛擬 Uno 相同）');
  m.reset(); m.runMs(10); assert.strictEqual(m.pinState(18), 2, '重新開機：腳位回到輸入'); assert.strictEqual(m.running, false);
  m.sendBytes([0xF9]); m.runMs(10); assert.deepStrictEqual(rx.splice(0), [], '開機中收到的位元組丟掉');
  m.runMs(400); assert.deepStrictEqual(frames(rx.splice(0)).map(hex)[0], 'f9 02 06', '開機完成後主動送出版本（驅動據此判斷重新開機）');
});

test('斷線保護的時間判斷（協定模型）：最後一個位元組之後剛好 3 秒，每一次都會觸發（300 次，隨機時刻）', () => {
  // V2.13 發現：用毫秒（浮點數）相減，剛好 3000 ms 有時算成 2999.9999…，判斷成還沒到、保護就不觸發（約五分之一）。改成用時間單位比較
  let rnd = 5; const rand = () => (rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648;
  const miss = [];
  for (let i = 0; i < 300; i++) {
    const d = new VirtualEsp32(); let prev = -1, n = null; d.onSerial = b => { if (prev === 0xF0 && b === 0x64 && n === null) n = d.timeMs; prev = b; };
    d.runMs(400 + rand() * 100); d.sendBytes([0xF4, 23, 1, 0x92, 0, 1]); let t = d.timeMs;
    for (let k = 0, K = 1 + Math.floor(rand() * 4); k < K; k++) { d.runMs(900 + rand() * 200); d.sendBytes([0xF9]); t = d.timeMs; }
    d.runMs(4000);
    if (n === null || d.pinState(23) !== 2 || Math.abs(n - t - 3000) > 0.01) miss.push({ i, t, n, pin: d.pinState(23) });
  }
  assert.deepStrictEqual(miss, [], '每一次都應該在最後一個位元組之後 3000 ms 關掉 GPIO23 並送出 F0 64 F7');
});

test('伺服停止時不會送出被截短的脈衝（真韌體 1.2，Uno）：撤銷授權與斷線保護都等這個脈衝送完', () => {
  // V2.13 發現：停在脈衝中間，伺服會收到一個長度不定（實測 43–1763 µs）的脈衝，可能抖一下。韌體改成先等腳位變 LOW
  let rnd = 9; const rand = () => (rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648;
  const u = new VirtualUno(HEX); const edges = []; let hi = false;
  u.pinWatchers.push(() => { const h = u.isHigh(9); if (h !== hi) { edges.push([u.timeMs, h]); hi = h; } });
  u.runMs(600);
  for (let i = 0; i < 60; i++) { u.sendBytes([0xF4, 9, 4, 0xE9, 120 & 0x7F, 120 >> 7]); u.runMs(100 + rand() * 40); u.sendBytes([0xF4, 9, 0]); u.runMs(40); }   // 撤銷授權：F4 9 0
  u.sendBytes([0xF4, 9, 4, 0xE9, 120 & 0x7F, 120 >> 7]); u.runMs(3300 + rand() * 20);   // 斷線保護：3 秒沒有位元組
  const w = []; for (let i = 0; i < edges.length - 1; i++) if (edges[i][1] && !edges[i + 1][1]) w.push(Math.round((edges[i + 1][0] - edges[i][0]) * 1000));
  assert.ok(w.length > 300, `脈衝數 ${w.length}`);
  assert.deepStrictEqual(w.filter(x => x < 1777 || x > 1790), [], '120° 的脈衝都是 1780 µs（544 + 120 × 1856 / 180；收序列埠的中斷會讓它晚幾 µs 結束），沒有被截短的');
  assert.strictEqual(u.pinState(9), 2, '最後 D9 是輸入');
});

test('伺服停止時不會送出被截短的脈衝（協定模型，ESP32 腳位表）：正在送的脈衝照常送完再停', () => {
  // 韌體 1.2 的 ESP32 分支：先把 LEDC 工作週期寫 0（從下一個週期生效），等一個週期再拆下腳位。模型照做：脈衝送完、腳位才變
  let rnd = 13; const rand = () => (rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648;
  const d = new VirtualEsp32(); const edges = []; let hi = false;
  d.pinWatchers.push(() => { const h = d.isHigh(18); if (h !== hi) { edges.push([d.timeMs, h]); hi = h; } });
  d.runMs(400);
  const attach = [0xF4, 18, 4, 0xF0, 0x6F, 18, 120 & 0x7F, 120 >> 7, 0xF7];   // GPIO18 伺服 120°（擴充類比）
  for (let i = 0; i < 60; i++) { d.sendBytes(attach); d.runMs(100 + rand() * 40); d.sendBytes([0xF4, 18, 0]); d.runMs(40); }   // 撤銷授權：F4 18 0
  d.sendBytes(attach); d.runMs(3300 + rand() * 20);   // 斷線保護
  const w = []; for (let i = 0; i < edges.length - 1; i++) if (edges[i][1] && !edges[i + 1][1]) w.push(Math.round((edges[i + 1][0] - edges[i][0]) * 1000));
  assert.ok(w.length > 300, `脈衝數 ${w.length}`);
  assert.deepStrictEqual(w.filter(x => x < 1777 || x > 1785), [], '120° 的脈衝都是約 1780 µs（模型 1781，進位到時間單位），沒有被截短的');
  assert.strictEqual(d.pinState(18), 2, '最後 GPIO18 是輸入'); assert.ok(!d.isHigh(18));
});

test('PWM（協定模型＋工作台）：GPIO2（DevKit V1 的藍燈）工作週期 128 → 工作台量到 1 kHz、約 50 %；0 與 255 是固定的亮滅', () => {
  const m = new VirtualEsp32(); const b = new Bench(m, { board: 'esp32', parts: [{ id: 'OBLED', type: 'led', pin: 2 }] }); m.runMs(400);
  const led = () => b.partState(b.parts.OBLED);
  m.sendBytes([0xF4, 2, 3, 0xE2, 0x00, 0x01]); m.runMs(30);
  assert.ok(led().pwmHz === 1000 && Math.abs(led().duty - 128 / 255) < 0.01 && led().on, JSON.stringify(led()));
  m.sendBytes([0xE2, 0x7F, 0x01]); m.runMs(60); assert.ok(led().duty === null && led().on, `255：固定亮 ${JSON.stringify(led())}`);
  m.sendBytes([0xE2, 0x00, 0x00]); m.runMs(60); assert.ok(led().duty === null && !led().on, `0：固定滅 ${JSON.stringify(led())}`);
});
