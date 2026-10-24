// 雲端虛擬硬體第 1 階段：介面（FirmataDriver＋Twin Core）經 WebSocket 連到「另一個程序」裡的虛擬 Uno（tools/vdev/server.js）
// 驗證：位元組往返與 Web Serial 版相同；辨識標示虛擬；唯讀時設備端沒有收到任何寫入；授權後 LED 命令有 ACK、晶片 D13 真的 HIGH；
// 設備停住時命令未確認 → 主機結束 → 回到模擬、命令作廢；重新連線從唯讀開始、設備端沒有收到重送的命令。
// 這些都是「已在虛擬設備驗證」，不是實體設備驗證。
const test = require('node:test'); const assert = require('node:assert'); const path = require('path'); const { spawn } = require('child_process');
const { DL } = require('./helpers'); require('../src/drivers/drivers.js');
const { VirtualUno } = require('../tools/vdev/avrsim');
const { startServer } = require('../tools/vdev/server.js');
const { FirmataSniffer } = require('../tools/vdev/device.js');
const HEX = path.join(__dirname, 'fixtures', 'DofLabFirmata-uno.hex');
const SERVER = path.join(__dirname, '..', 'tools', 'vdev', 'server.js');
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 5000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await wait(20); } return false; }

// 另一個程序：node tools/vdev/server.js --port 0（由系統分配連接埠）
function spawnServer() {
  const p = spawn(process.execPath, [SERVER, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((res, rej) => {
    let out = ''; const t = setTimeout(() => rej(new Error('虛擬設備主機沒有啟動：' + out)), 15000);
    p.stdout.on('data', d => { out += d; const m = out.match(/VDEV_READY port=(\d+)/); if (m) { clearTimeout(t); const port = +m[1]; res({ p, port, url: `ws://127.0.0.1:${port}/dev/uno-1`, api: `http://127.0.0.1:${port}/api/devices/uno-1` }); } });
    p.stderr.on('data', d => { out += d; });
    p.on('exit', c => rej(new Error('虛擬設備主機結束 ' + c + '：' + out)));
  });
}
const state = async s => (await fetch(s.api)).json();
const bench = (s, part, action) => fetch(s.api + '/bench', { method: 'POST', body: JSON.stringify({ part, action }) }).then(r => r.json());
function mkDriver(twin) {
  twin = twin || DL.createTwin(); const logs = []; const lost = [];
  const drv = new DL.drivers.FirmataDriver(twin, { log: m => logs.push(m), onLost: w => { lost.push(w); twin.disconnected(w); } }, 'uno');
  twin.define('BTN1.pressed', {}); twin.define('LED1.state', { feedback: false });
  return { twin, drv, logs, lost };
}

// 同一段操作分別走 USB（虛擬 Web Serial 連接埠）與網路（WebSocket），記錄驅動送出的位元組與設備回應
async function session(connectOpts, press) {
  const { twin, drv } = mkDriver();
  const tx = []; const send0 = drv.send.bind(drv); drv.send = b => { if (!(b.length === 1 && b[0] === 0xF9)) tx.push([...b]); return send0(b); };   // 心跳（每秒查版本）的次數依時間而定，不比較
  const rx = { pinState: [] }; const sys0 = drv.onSysex.bind(drv);
  drv.onSysex = d => { if (d[0] === 0x6E) rx.pinState.push([...d]); else rx[d[0].toString(16)] = [...d]; return sys0(d); };
  const r = await drv.connect(connectOpts);
  twin.connected(r.deviceId, r.info, { virtual: !!r.virtual });
  await drv.watch([{ signal: 'BTN1.pressed', num: 2, kind: 'button' }]);
  await until(() => twin.view('BTN1.pressed').measured);
  await press(true); assert.ok(await until(() => twin.view('BTN1.pressed').measured.v === true), '按下');
  await press(false); assert.ok(await until(() => twin.view('BTN1.pressed').measured.v === false), '放開');
  twin.authorize(['LED1.state']); await drv.authorize([{ signal: 'LED1.state', num: 13, kind: 'digital' }]);
  for (const v of [1, 0, 1]) { const c = twin.command('LED1.state', v).cmd; await drv.write(c, { num: 13, kind: 'digital' }); assert.ok(await until(() => twin.view('LED1.state').ack && twin.view('LED1.state').ack.id === c.id), 'ACK ' + v); }
  await drv.disconnect();
  return { tx, rx, r };
}

test('位元組往返：USB（Web Serial）與網路（WebSocket，另一個程序）送出與收到的 Firmata 位元組相同', { timeout: 60000 }, async () => {
  const uno = new VirtualUno(HEX); uno.setInput(2, true); const port = uno.webSerialPort();
  Object.defineProperty(globalThis.navigator, 'serial', { configurable: true, value: { requestPort: async () => port } });
  const usb = await session({ port }, async down => uno.setInput(2, !down));
  port.stop();
  const s = await spawnServer();
  try {
    const net = await session({ url: s.url }, async down => bench(s, 'BTN1', down ? 'press' : 'release'));
    assert.ok(net.r.virtual && net.r.identity.ok && net.r.identity.virtual, JSON.stringify(net.r));
    assert.ok(usb.tx.length > 10);
    assert.deepStrictEqual(net.tx, usb.tx, '驅動送出的位元組（不含心跳）完全相同');
    for (const k of ['6c', '6a', '79']) assert.deepStrictEqual(net.rx[k], usb.rx[k], `回應 0x${k}（腳位能力、類比對應、韌體名稱）相同`);
    assert.deepStrictEqual(net.rx.pinState, usb.rx.pinState, 'PIN_STATE 回讀（ACK）相同');
    assert.strictEqual(net.rx.pinState.length, 3);
    const st = await state(s);
    assert.strictEqual(st.traffic.bytes, net.tx.flat().length + st.traffic.queries, '設備端收到的位元組數與驅動送出的一致（版本查詢與心跳另計）');
  } finally { s.p.kill('SIGKILL'); }
});

test('數位孿生整條路徑：辨識（虛擬）→ 唯讀 → 授權 → ACK → 設備停住 → 主機結束 → 不重送 → 重連從唯讀開始', { timeout: 60000 }, async () => {
  let s = await spawnServer(); let s2 = null;
  try {
    const A = mkDriver(); const { twin, drv } = A;
    const r = await drv.connect({ url: s.url });
    assert.ok(r.identity.ok && r.identity.virtual && /虛擬設備/.test(r.identity.msg) && /不是實體板子/.test(r.identity.msg), r.identity.msg);
    assert.ok(r.deviceId.startsWith('vdev:uno-1@127.0.0.1:'), r.deviceId);
    twin.connected(r.deviceId, r.info, { virtual: true });
    assert.strictEqual(twin.conn.virtual, true); assert.strictEqual(DL.modeLabel(twin.mode, twin.conn.virtual), '虛擬設備 · 唯讀');

    // 唯讀：工作台按鈕的變化出現在量測層；設備端沒有收到任何輸出模式或寫入
    await drv.watch([{ signal: 'BTN1.pressed', num: 2, kind: 'button' }]);
    await until(() => twin.view('BTN1.pressed').measured);
    await bench(s, 'BTN1', 'press');
    assert.ok(await until(() => twin.view('BTN1.pressed').measured.v === true && twin.quality('BTN1.pressed') === 'ok'));
    assert.ok(twin.view('BTN1.pressed').measured.src.startsWith('vdev:'), '量測的來源標示為虛擬設備');
    await bench(s, 'BTN1', 'release'); assert.ok(await until(() => twin.view('BTN1.pressed').measured.v === false));
    let st = await state(s);
    assert.deepStrictEqual(st.traffic.modes, [[2, 0x0B]], '唯讀只把 D2 設為上拉輸入');
    assert.strictEqual(st.traffic.writeCount, 0, '唯讀期間設備端沒有收到任何寫入'); assert.strictEqual(st.pins[13], 'input');
    assert.strictEqual(twin.command('LED1.state', 1).ok, false, '未授權不能送命令');

    // 授權：LED 命令得到 ACK，虛擬晶片的 D13 真的變成 HIGH，工作台上的 LED 亮
    twin.authorize(['LED1.state']); assert.strictEqual(DL.modeLabel(twin.mode, true), '虛擬設備 · 受控寫入');
    await drv.authorize([{ signal: 'LED1.state', num: 13, kind: 'digital' }]);
    const c1 = twin.command('LED1.state', 1).cmd; await drv.write(c1, { num: 13, kind: 'digital' });
    assert.ok(await until(() => twin.view('LED1.state').ack && twin.view('LED1.state').ack.id === c1.id));
    st = await state(s);
    assert.strictEqual(st.pins[13], 'high', '虛擬晶片 D13 為 HIGH');
    assert.ok(st.bench.parts.find(p => p.id === 'LED1').on, '工作台的 LED 依晶片腳位亮起');

    // 設備停住（主機程序暫停）：命令送出但沒有 ACK
    s.p.kill('SIGSTOP');
    const c2 = twin.command('LED1.state', 0).cmd; await drv.write(c2, { num: 13, kind: 'digital' });
    await wait(400);
    assert.deepStrictEqual(twin.pending.map(c => c.id), [c2.id], '命令未確認');
    // 主機結束：介面回到模擬，未確認的命令作廢、不重送
    s.p.kill('SIGKILL'); s.p.kill('SIGCONT');
    assert.ok(await until(() => A.lost.length === 1, 8000), '偵測到網路連線中斷');
    assert.strictEqual(twin.mode, 'sim'); assert.deepStrictEqual(twin.dropped.map(c => c.id), [c2.id]); assert.strictEqual(twin.pending.length, 0);
    assert.strictEqual(twin.quality('BTN1.pressed'), 'stale', '量測標為過期');
    await drv.disconnect(true);

    // 重新啟動主機、重新連線（和介面一樣用新的驅動、同一個 Twin）：從唯讀開始，設備端沒有收到任何寫入（舊命令沒有被重送）
    s2 = await spawnServer();
    const D2 = mkDriver(twin); const B = await D2.drv.connect({ url: s2.url });
    assert.ok(B.identity.ok && B.virtual, B.identity.msg);
    twin.connected(B.deviceId, B.info, { virtual: true });
    assert.strictEqual(twin.mode, 'hw-read');
    await D2.drv.watch([{ signal: 'BTN1.pressed', num: 2, kind: 'button' }]);
    assert.ok(await until(() => twin.view('BTN1.pressed').measured && twin.quality('BTN1.pressed') === 'ok'), '新連線的量測有效');
    await wait(1000);
    st = await state(s2);
    assert.strictEqual(st.traffic.writeCount, 0, JSON.stringify(st.traffic)); assert.strictEqual(st.traffic.outputModes, 0); assert.strictEqual(st.pins[13], 'input');
    assert.strictEqual(twin.command('LED1.state', 0).ok, false, '重連後需要重新授權');
    await D2.drv.disconnect();
  } finally { s.p.kill('SIGKILL'); s.p.kill('SIGCONT'); if (s2) s2.p.kill('SIGKILL'); }
});

test('虛擬設備主機：只聽本機、第二個連線可以唯讀觀看、上傳需要獨占、DTR 重新啟動晶片、協定版本不符拒絕', { timeout: 30000 }, async () => {
  await assert.rejects(startServer({ port: 0, host: '0.0.0.0' }), /只允許在本機/);
  const s = await startServer({ port: 0 }); const url = `ws://127.0.0.1:${s.port}/dev/uno-1`;
  try {
    const A = mkDriver(); await A.drv.connect({ url });
    const B = mkDriver(); const rb = await B.drv.connect({ url }); assert.ok(rb.identity.ok, '第二個連線（第 5 階段）可以連上、辨識正確');
    await assert.rejects(DL.transport.wsSerialPort(url).open(), /需要獨占/, '有人連著時不能上傳或開序列埠監看');
    await B.drv.disconnect(); await until(async () => (await (await fetch(`http://127.0.0.1:${s.port}/api/devices/uno-1`)).json()).hub.links.length === 1);
    assert.ok(await A.drv.resetBoard(), 'DTR／RTS 經網路送到虛擬設備');
    assert.ok(await until(() => A.logs.some(l => /虛擬晶片重新啟動/.test(l) && /不是量測/.test(l))), A.logs.join('\n'));
    const st = await (await fetch(`http://127.0.0.1:${s.port}/api/devices/uno-1`)).json(); assert.strictEqual(st.resets, 1);
    await A.drv.disconnect();
    assert.ok(await until(async () => !(await (await fetch(`http://127.0.0.1:${s.port}/api/devices`)).json())[0].linked), '中斷後設備可以再被連線');
    const C = mkDriver(); const r = await C.drv.connect({ url }); assert.ok(r.identity.ok); await C.drv.disconnect();
    await until(async () => !(await (await fetch(`http://127.0.0.1:${s.port}/api/devices`)).json())[0].linked);
    const ws = new WebSocket(url); const msgs = [];
    await new Promise(res => { ws.onopen = () => ws.send(JSON.stringify({ op: 'hello', proto: 99 })); ws.onmessage = e => msgs.push(JSON.parse(e.data)); ws.onclose = res; });
    assert.strictEqual(msgs[0].code, 'proto');
    const D = mkDriver(); await assert.rejects(D.drv.connect({ url: `ws://127.0.0.1:${s.port}/dev/nope` }), /無法連到虛擬設備|關閉了連線/);
    await assert.rejects(D.drv.connect({ url: 'http://127.0.0.1/' }), /ws:\/\//);
    const bad = await fetch(`http://127.0.0.1:${s.port}/api/devices/uno-1/bench`, { method: 'POST', body: JSON.stringify({ part: 'LED1', action: 'press' }) });
    assert.strictEqual(bad.status, 400);
  } finally { await s.close(); }
});

test('設備端的 Firmata 紀錄：分辨查詢、輸入設定與寫入', () => {
  const f = new FirmataSniffer();
  f.feed([0xF9, 0xF0, 0x6B, 0xF7, 0xF4, 2, 0x0B, 0xD0, 1, 0xF4, 13, 1, 0xF5, 13, 1, 0xE9, 90, 0, 0x92, 0x7F, 0x01, 0xF0, 0x6F, 20, 10, 0, 0xF7]);
  const s = f.summary();
  assert.deepStrictEqual(s.modes, [[2, 0x0B], [13, 1]]); assert.strictEqual(s.outputModes, 1); assert.strictEqual(s.reports, 1);
  assert.deepStrictEqual(s.writes.map(w => [w.kind, w.pin, w.v]), [['digital', 13, 1], ['analog', 9, 90], ['port', 2, 255], ['extended-analog', 20, 10]]);
});
