// 序列埠被占住的處理（V2.6.1，依實測回饋「連線有時候會失敗，好像前一次連線被佔住」）
// 虛擬連接埠的行為與 Chrome Web Serial 相同：重複開啟 → InvalidStateError；串流鎖著時 close() 失敗；被其他程式占用 → NetworkError。
const test = require('node:test'); const assert = require('node:assert'); const path = require('path');
const { DL } = require('./helpers'); require('../src/drivers/drivers.js');
const { VirtualUno } = require('../tools/vdev/avrsim');
const HEX = path.join(__dirname, 'fixtures', 'DofLabFirmata-uno.hex');
const wait = ms => new Promise(r => setTimeout(r, ms));

function rig(board) {
  const uno = new VirtualUno(HEX); uno.setInput(2, true);
  const port = uno.webSerialPort();
  Object.defineProperty(globalThis.navigator, 'serial', { configurable: true, value: { requestPort: async () => port } });
  const mk = () => { const logs = []; const twin = DL.createTwin(); const lost = []; const drv = new DL.drivers.FirmataDriver(twin, { log: (m, k) => logs.push(m), onLost: w => lost.push(w) }, board || 'uno'); return { drv, logs, lost }; };
  return { uno, port, mk };
}

test('中斷連線後連接埠真的關閉（讀取迴圈先放開串流），可以馬上再連', { timeout: 30000 }, async () => {
  const { port, mk } = rig();
  const a = mk(); await a.drv.connect(); assert.ok(port.opened);
  await a.drv.disconnect(); assert.strictEqual(port.opened, false, 'close() 不能因為串流還鎖著而失敗');
  const b = mk(); const r = await b.drv.connect(); assert.ok(r.identity.ok); assert.strictEqual(port.opens, 2);
  await b.drv.disconnect(); assert.strictEqual(DL.serial.owners.size, 0);
});

test('本頁上一次的連線沒有關（直接再按連線）：自動關閉舊連線後重新開啟', { timeout: 30000 }, async () => {
  const { port, mk } = rig();
  const a = mk(); await a.drv.connect();
  const b = mk(); const r = await b.drv.connect();
  assert.ok(r.identity.ok); assert.ok(b.logs.some(l => /還開著/.test(l)), b.logs.join('\n'));
  assert.ok(a.drv.closing, '舊連線已關閉'); assert.strictEqual(port.opens, 2);
  await b.drv.disconnect(); assert.strictEqual(port.opened, false);
});

test('被其他程式暫時占用：稍候自動重試成功；一直被占用：明確說明可能的占用者', { timeout: 30000 }, async () => {
  const { port, mk } = rig();
  port.externalBusy = 2; const a = mk(); const r = await a.drv.connect();
  assert.ok(r.identity.ok); assert.ok(a.logs.some(l => /稍候自動重試/.test(l)));
  await a.drv.disconnect();
  port.externalBusy = 99; const b = mk();
  await assert.rejects(b.drv.connect(), e => e.code === 'port_busy' && /Arduino IDE/.test(e.message) && /另一個開著 DofLab 的分頁/.test(e.message));
  assert.strictEqual(port.opened, false);
});

test('拔線（讀取串流出錯）：通知中斷並關閉連接埠，之後可以重新連線', { timeout: 30000 }, async () => {
  const { port, mk } = rig();
  const a = mk(); await a.drv.connect();
  port.unplug(); for (let i = 0; i < 50 && port.opened; i++) await wait(20);
  assert.deepStrictEqual(a.lost.length, 1); assert.strictEqual(port.opened, false, '中斷後要把連接埠關掉');
  const b = mk(); const r = await b.drv.connect(); assert.ok(r.identity.ok);
  await b.drv.disconnect();
});

for (const board of ['uno', 'esp32doit'])
test(`板子沒有回應（${board}）：用 DTR／RTS 重新啟動板子後再等一次`, { timeout: 40000 }, async () => {
  const { port, mk } = rig(board);
  // 板子「不聽」：重新啟動之前送去的查詢全部丟掉
  let awake = false; const sigs = []; const setSig = port.setSignals;
  port.setSignals = async s => { sigs.push(s); awake = true; return setSig(s); };
  const desc = Object.getOwnPropertyDescriptor(port, 'writable');
  Object.defineProperty(port, 'writable', { get() { const w = desc.get(); if (!w) return w; if (!port._drop) port._drop = new WritableStream({ write(c) { if (awake) { const wr = w.getWriter(); return wr.write(c).finally(() => wr.releaseLock()); } } }); return port._drop; } });
  const a = mk(); const t0 = Date.now(); const r = await a.drv.connect();
  assert.ok(a.logs.some(l => /重新啟動板子後再等一次/.test(l)), a.logs.join('\n'));
  assert.ok(r.info.startsWith('DofLabFirmata')); assert.ok(Date.now() - t0 > 6000);
  if (board === 'uno') assert.deepStrictEqual(sigs, [{ dataTerminalReady: false }, { dataTerminalReady: true }]);
  else assert.deepStrictEqual(sigs, [{ dataTerminalReady: false, requestToSend: true }, { dataTerminalReady: false, requestToSend: false }], 'ESP32：RTS 拉一下 EN（重置），DTR 不動（GPIO0 保持高電位，不進下載模式）');
  await a.drv.disconnect();
});
