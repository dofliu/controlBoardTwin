// Firmata 驅動 × 真實 StandardFirmata 2.5.9 韌體（arduino-cli 編譯成 hex，在 avr8js 虛擬 ATmega328P 上執行）
// 驗證：辨識、唯讀輸入回報、授權後寫入、PIN_STATE 回讀 ACK、伺服脈寬、斷線不重播。
const test = require('node:test'); const assert = require('node:assert'); const path = require('path');
const { DL } = require('./helpers'); require('../src/drivers/drivers.js');
const { VirtualUno } = require('./avr/avrsim');
const FIX = f => path.join(__dirname, 'fixtures', f);
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 5000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await wait(20); } return false; }

function rig(hex) {
  const uno = new VirtualUno(hex);
  uno.setInput(2, true);                       // 按鈕放開：外部沒有拉低
  const port = uno.webSerialPort();
  Object.defineProperty(globalThis.navigator, 'serial', { configurable: true, value: { requestPort: async () => port } });
  const twin = DL.createTwin(); const logs = [];
  const drv = new DL.drivers.FirmataDriver(twin, { log: m => logs.push(m), onLost: () => logs.push('LOST') }, 'uno');
  twin.define('BTN1.pressed', {}); twin.define('LED1.state', { feedback: false }); twin.define('SERVO1.angle', { feedback: false });
  return { uno, port, twin, drv, logs };
}

for (const [fw, hex, name] of [['StandardFirmata 2.5.9', 'StandardFirmata-2.5.9-uno.hex', 'StandardFirmata'], ['DofLabFirmata', 'DofLabFirmata-uno.hex', 'DofLabFirmata']])
test(`虛擬 Uno＋${fw}：辨識、唯讀、授權寫入、ACK、伺服、斷線`, { timeout: 60000 }, async () => {
  const { uno, port, twin, drv, logs } = rig(FIX(hex));
  const sent = []; const w0 = port.writable; const origW = drv.send.bind(drv); drv.send = b => { sent.push(...b); return origW(b); };
  try {
  const r = await drv.connect();
  assert.ok(r.identity.ok, r.identity.msg); assert.ok(r.info.startsWith(name), r.info);
  twin.connected(r.deviceId, r.info);

  // 唯讀：設定 D2 為上拉輸入並開啟回報；D13 不應被改成輸出
  await drv.watch([{ signal: 'BTN1.pressed', num: 2, kind: 'button' }]);
  await until(() => twin.view('BTN1.pressed').measured);
  assert.strictEqual(twin.view('BTN1.pressed').measured.v, false, '放開 → 未按下');
  uno.setInput(2, false);                      // 實體按鈕按下（接到 GND）
  assert.ok(await until(() => twin.view('BTN1.pressed').measured && twin.view('BTN1.pressed').measured.v === true), '按下應被韌體回報');
  uno.setInput(2, true);
  assert.ok(await until(() => twin.view('BTN1.pressed').measured.v === false));
  // 唯讀期間驅動送出的每個位元組：只能有查詢、INPUT_PULLUP(0x0B) 與開啟回報，不能有輸出模式或寫值
  const modes = []; for (let i = 0; i < sent.length; i++) if (sent[i] === 0xF4) modes.push([sent[i + 1], sent[i + 2]]);
  assert.deepStrictEqual(modes, [[2, 0x0B]], '唯讀只設定 D2 為上拉輸入'); sent.length = 0;
  assert.ok(!sent.some((b, i) => b === 0xF5 || (b & 0xF0) === 0x90 || (b & 0xF0) === 0xE0), '唯讀期間沒有任何寫入命令');
  if (name === 'StandardFirmata') {
    // 已知韌體行為：StandardFirmata 開機（systemReset）會自行把數位腳設為 OUTPUT LOW；驅動會提出警告
    assert.strictEqual(uno.cpu.data[0x24] & 0x20, 0x20); assert.ok(logs.some(l => /OUTPUT LOW/.test(l)));
  } else {
    assert.strictEqual(uno.cpu.data[0x24] & 0x20, 0, 'DofLabFirmata：開機後 D13 仍是輸入');
    assert.strictEqual(uno.cpu.data[0x2A] & 0xFC, 0, 'DofLabFirmata：PORTD 沒有任何腳位被設為輸出');
    // 類比：A0 經類比對應表（不是寫死換算）
    twin.define('LDR1.level', {}); await drv.watch([{ signal: 'LDR1.level', num: 14, kind: 'analog' }]);
    uno.setAnalog(0, 1.25);                    // 5V 參考下約 25 %
    assert.ok(await until(() => twin.view('LDR1.level').measured && Math.abs(twin.view('LDR1.level').measured.v - 25) <= 1), JSON.stringify(twin.view('LDR1.level').measured));
    uno.setAnalog(0, 4.0);
    assert.ok(await until(() => Math.abs(twin.view('LDR1.level').measured.v - 80) <= 1));
  }

  // 未授權不能寫
  assert.strictEqual(twin.command('LED1.state', 1).ok, false);
  // 授權後寫入 → 真的改變 MCU 腳位 → PIN_STATE 回讀成為 ACK
  twin.authorize(['LED1.state', 'SERVO1.angle']);
  await drv.authorize([{ signal: 'LED1.state', num: 13, kind: 'digital' }, { signal: 'SERVO1.angle', num: 9, kind: 'servo' }]);
  const c = twin.command('LED1.state', 1).cmd; await drv.write(c, { num: 13, kind: 'digital' });
  assert.ok(await until(() => twin.view('LED1.state').ack), '應收到 PIN_STATE 回讀');
  assert.strictEqual(twin.view('LED1.state').ack.v, 1); assert.ok(uno.isHigh(13), '虛擬 MCU 的 D13 實際為 HIGH');
  const c2 = twin.command('LED1.state', 0).cmd; await drv.write(c2, { num: 13, kind: 'digital' });
  assert.ok(await until(() => twin.view('LED1.state').ack && twin.view('LED1.state').ack.id === c2.id));
  assert.ok(!uno.isHigh(13));

  // 伺服：量測 D9 的脈寬（Servo 函式庫用 Timer1 中斷產生）
  const pulses = []; let rise = null;
  uno.pinWatchers.push(() => { const h = uno.isHigh(9); const t = uno.cpu.cycles; if (h && rise === null) rise = t; else if (!h && rise !== null) { pulses.push((t - rise) / 16); rise = null; } });
  for (const [ang, lo, hi] of [[0, 500, 620], [90, 1400, 1580], [180, 2300, 2500]]) {
    const cs = twin.command('SERVO1.angle', ang).cmd; await drv.write(cs, { num: 9, kind: 'servo' });
    assert.ok(await until(() => twin.view('SERVO1.angle').ack && twin.view('SERVO1.angle').ack.id === cs.id), '伺服 ACK ' + ang + ' ' + JSON.stringify([twin.view('SERVO1.angle').ack, twin.pending.map(x => x.id), cs.id, drv.lastCmdByPin]));
    pulses.length = 0; await until(() => pulses.length >= 4, 3000);
    const w = pulses[pulses.length - 1];
    assert.ok(w >= lo && w <= hi, `${ang}° 的脈寬 ${w} µs 應在 ${lo}–${hi}`);
  }

  // 斷線：未確認的命令作廢、不重送
  const pend = twin.command('LED1.state', 1).cmd;
  port.stop();                                 // 模擬拔線：MCU 停止回應
  const res = twin.disconnected('拔線');
  assert.deepStrictEqual(res.dropped.map(x => x.id), [pend.id]);
  assert.strictEqual(twin.mode, 'sim'); assert.strictEqual(twin.pending.length, 0);
  await drv.disconnect(true);
  } catch (e) { console.log('# 失敗步驟：', e.message); throw e; } finally { port.stop(); clearInterval(drv.hb); try { await drv.disconnect(true); } catch (e) { } }
});
