// 雲端虛擬硬體第 5 階段：多人與控制權。一台虛擬設備、好幾個 DofLab 連線（老師、學生）：
// 都能唯讀觀看；「授權受控寫入」要先取得唯一的控制權；沒有控制權的寫入在虛擬設備主機就被擋下、不會到晶片；
// 撤銷、中斷或逾時都會釋放控制權。這些都是「已在虛擬設備驗證」，不是實體設備驗證。
const test = require('node:test'); const assert = require('node:assert');
const { DL } = require('./helpers'); require('../src/drivers/drivers.js');
const { startServer } = require('../tools/vdev/server.js');
const { Framer, LOCK_IDLE_MS } = require('../tools/vdev/hub.js');
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 6000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(25); } return null; }

async function server() {
  const s = await startServer({ port: 0 }); const api = `http://127.0.0.1:${s.port}/api/devices/uno-1`;
  return Object.assign(s, { url: `ws://127.0.0.1:${s.port}/dev/uno-1`, state: async () => (await fetch(api)).json(), bench: (part, action) => fetch(api + '/bench', { method: 'POST', body: JSON.stringify({ part, action }) }).then(r => r.json()) });
}
// 一個 DofLab：孿生＋驅動；記下 presence、紀錄、收到的回讀（F0 6E）與重新開機
function user(name) {
  const twin = DL.createTwin(); const u = { name, twin, logs: [], presence: [], reboots: [], acks6E: 0, events: [] };
  u.drv = new DL.drivers.FirmataDriver(twin, { log: m => u.logs.push(m), onLost: w => twin.disconnected(w), onReboot: w => u.reboots.push(w), onPresence: m => u.presence.push(m) }, 'uno');
  const sys0 = u.drv.onSysex.bind(u.drv); u.drv.onSysex = d => { if (d[0] === 0x6E) u.acks6E++; return sys0(d); };
  twin.define('BTN1.pressed', {}); twin.define('LED1.state', { feedback: false });
  twin.on && twin.on(e => u.events.push(e));
  u.connect = async url => { const r = await u.drv.connect({ url, name }); twin.connected(r.deviceId, r.info, { virtual: true }); await u.drv.watch([{ signal: 'BTN1.pressed', num: 2, kind: 'button' }]); return r; };
  u.last = () => u.presence[u.presence.length - 1];
  return u;
}
const LED = [{ signal: 'LED1.state', num: 13, kind: 'digital' }];
async function authorize(u) { await u.drv.authorize(LED); const r = u.twin.authorize(['LED1.state'], { ok: true }); assert.ok(r.ok, JSON.stringify(r)); }

test('Firmata 訊息切割：介面送的版本查詢是 1 個位元組，設備回的版本是 3 個；sysex 跨訊框也能組回', () => {
  const up = new Framer(); up.dir = 'up';
  assert.deepStrictEqual(up.feed([0xF9, 0xF0, 0x79]), [[0xF9]]);
  assert.deepStrictEqual(up.feed([0xF7, 0xF5, 13]), [[0xF0, 0x79, 0xF7]]);
  assert.deepStrictEqual(up.feed([1, 0xD0, 1]), [[0xF5, 13, 1], [0xD0, 1]]);
  const down = new Framer(); assert.deepStrictEqual(down.feed([0xF9, 2, 5, 0x90, 4]), [[0xF9, 2, 5]]); assert.deepStrictEqual(down.feed([0]), [[0x90, 4, 0]]);
});

test('兩個連線同時唯讀觀看：都看得到工作台的按鈕；後連的人交握不會讓先連的人誤判「設備重新開機」', { timeout: 30000 }, async () => {
  const s = await server();
  try {
    const B = user('學生'); await B.connect(s.url);
    await wait(1700);   // 過了「交握後 1.5 秒」：之後收到沒問過的韌體名稱就會判定為重新開機
    const A = user('老師'); const ra = await A.connect(s.url); assert.ok(ra.identity.ok && ra.virtual);
    await wait(800);
    assert.deepStrictEqual(B.reboots, [], '老師交握時問的韌體名稱只回給老師');
    const p = await until(() => { const x = B.last(); return x && x.links.length === 2 && x; });
    assert.ok(p, '學生看到兩個連線'); assert.deepStrictEqual(p.links.map(l => l.name).sort(), ['學生', '老師'].sort()); assert.strictEqual(p.holder, null);
    await s.bench('BTN1', 'press');
    assert.ok(await until(() => A.twin.view('BTN1.pressed').measured?.v === true && B.twin.view('BTN1.pressed').measured?.v === true), '兩個人的量測層都顯示按下');
    await s.bench('BTN1', 'release');
    assert.ok(await until(() => A.twin.view('BTN1.pressed').measured?.v === false && B.twin.view('BTN1.pressed').measured?.v === false));
    const st = await s.state(); assert.strictEqual(st.traffic.writeCount, 0, '唯讀觀看：設備沒有收到任何寫入'); assert.strictEqual(st.hub.links.length, 2);
    await A.drv.disconnect(); await B.drv.disconnect();
  } finally { await s.close(); }
});

test('只有一個能寫入：老師取得控制權後學生看到「控制中：老師」；學生授權被拒絕，硬送的寫入在主機被擋下、晶片不變；回讀只回給老師', { timeout: 30000 }, async () => {
  const s = await server();
  try {
    const A = user('老師'), B = user('學生'); await A.connect(s.url); await B.connect(s.url);
    await authorize(A);
    assert.ok(await until(() => B.last()?.holder?.name === '老師'), '學生看到控制中：老師');
    assert.strictEqual(A.drv.holding, true);
    const c = A.twin.command('LED1.state', 1); assert.ok(c.ok); await A.drv.write(c.cmd, A.drv.outPins[13]);
    assert.ok(await until(async () => (await s.state()).pins['13'] === 'high'), '老師的命令讓晶片 D13 變成 HIGH');
    assert.ok(await until(() => A.twin.view('LED1.state').ack?.matches), '老師收到回讀確認');
    await wait(300); assert.strictEqual(B.acks6E, 0, '老師的回讀查詢只回給老師');
    // 學生：授權被拒絕
    await assert.rejects(B.drv.authorize(LED), e => e.code === 'not_holder' && /控制權在「老師」手上/.test(e.message));
    assert.strictEqual(B.twin.mode, 'hw-read');
    // 學生硬送寫入（繞過介面）：主機擋下，晶片不變，設備端沒有多收到寫入
    const before = (await s.state()).traffic.writeCount;
    await B.drv.send([0xF5, 13, 0]); await B.drv.send([0xF4, 13, 0x00]); await B.drv.send([0x91, 0, 0]); await B.drv.send([0xFF]);
    await B.drv.resetBoard();
    assert.ok(await until(() => B.logs.some(l => /你沒有控制權/.test(l))), '學生收到「寫入已被擋下」');
    await wait(400);
    const st = await s.state();
    assert.strictEqual(st.pins['13'], 'high', 'D13 仍是 HIGH（學生的寫入、改成輸入、系統重置都沒有到晶片）');
    assert.strictEqual(st.traffic.writeCount, before, '設備端沒有多收到寫入'); assert.strictEqual(st.resets, 0, 'DTR 重新啟動也被擋下');
    assert.ok(st.hub.links.find(l => l.name === '學生').blocked >= 4);
    // 老師撤銷授權 → 交出控制權；學生這時可以取得
    await A.drv.revoke(); A.twin.revoke('測試');
    assert.ok(await until(() => B.last()?.holder === null), '撤銷後控制權釋放');
    assert.ok(await until(async () => (await s.state()).pins['13'] === 'input'), '撤銷時 D13 回到輸入');
    await authorize(B); assert.strictEqual(B.drv.holding, true);
    assert.ok(await until(() => A.last()?.holder?.name === '學生'));
    await A.drv.disconnect(); await B.drv.disconnect();
  } finally { await s.close(); }
});

test('中斷後控制權釋放：控制者中斷連線 → 別人看到控制權釋放、可以取得；控制者的網路斷了但沒關閉 → 逾時釋放', { timeout: 40000 }, async () => {
  const s = await server();
  try {
    const A = user('老師'), B = user('學生'); await A.connect(s.url); await B.connect(s.url);
    await authorize(B);
    assert.ok(await until(() => A.last()?.holder?.name === '學生'));
    await B.drv.disconnect(true);   // 不先撤銷（像關掉分頁）：由主機在連線關閉時釋放
    assert.ok(await until(() => A.last()?.holder === null && A.last().links.length === 1), '學生中斷 → 控制權釋放');
    assert.strictEqual(A.last().why, 'holder-left');
    await authorize(A); assert.strictEqual(A.drv.holding, true);
    await A.drv.revoke(); A.twin.revoke('測試');
    // 網路斷了但沒有關閉（不再送任何訊息）：用最小的客戶端取得控制權後保持沉默
    const ws = new WebSocket(s.url); const msgs = [];
    await new Promise(res => { ws.onopen = () => ws.send(JSON.stringify({ op: 'hello', proto: 2, name: '斷線的人' })); ws.onmessage = e => { if (typeof e.data === 'string') { const m = JSON.parse(e.data); msgs.push(m); if (m.op === 'hello') { ws.send(JSON.stringify({ op: 'lock', want: 'control' })); res(); } } }; });
    assert.ok(await until(() => msgs.some(m => m.op === 'lock' && m.ok && m.you)));
    assert.ok(await until(() => A.last()?.holder?.name === '斷線的人'));
    const t0 = Date.now();
    assert.ok(await until(() => A.last()?.holder === null, LOCK_IDLE_MS + 5000), '逾時釋放');
    assert.strictEqual(A.last().why, 'timeout'); assert.ok(Date.now() - t0 >= LOCK_IDLE_MS - 3000);
    ws.close(); await A.drv.disconnect();
  } finally { await s.close(); }
});

test('控制者的輸出不會被觀看者改掉；觀看者中斷時不會關掉別人還在用的回報', { timeout: 30000 }, async () => {
  const s = await server();
  try {
    const A = user('老師'), B = user('學生'); await A.connect(s.url); await B.connect(s.url);
    await authorize(A);
    const c = A.twin.command('LED1.state', 1); await A.drv.write(c.cmd, A.drv.outPins[13]);
    assert.ok(await until(async () => (await s.state()).pins['13'] === 'high'));
    // 學生的專案把 D13 當成按鈕（接線不同）：設成上拉輸入的要求被擋下
    await B.drv.watch([{ signal: 'X.pressed', num: 13, kind: 'button' }]);
    await wait(300); assert.strictEqual((await s.state()).pins['13'], 'high', '老師的 LED 腳位沒有被改成輸入');
    // 學生關掉 D2 的回報（老師也在看）：不關
    await B.drv.send([0xD0, 0]); await wait(200);
    await s.bench('BTN1', 'press');
    assert.ok(await until(() => A.twin.view('BTN1.pressed').measured?.v === true), '老師仍收到 D2 的回報');
    await A.drv.disconnect(); await B.drv.disconnect();
  } finally { await s.close(); }
});

test('關掉一個連線後馬上重新連線（例如關掉序列埠監看後立刻連觀測頁）：主機還沒處理完關閉也不會回「忙碌」；新的控制者可以改前一個控制者留下的輸出腳位', { timeout: 30000 }, async () => {
  const s = await server();
  try {
    for (let i = 0; i < 5; i++) {
      const port = DL.transport.wsSerialPort(s.url); await port.open(); await port.close();
      const U = user('觀看者'); const r = await U.connect(s.url); assert.ok(r.identity.ok, '第 ' + (i + 1) + ' 次'); await U.drv.disconnect();
      const p2 = DL.transport.wsSerialPort(s.url); await p2.open(); await p2.close();
    }
    // 前一個控制者關掉分頁、沒有撤銷：D13 還是輸出；新的控制者可以把它改回輸入
    const A = user('老師'); await A.connect(s.url); await authorize(A);
    const c = A.twin.command('LED1.state', 1); await A.drv.write(c.cmd, A.drv.outPins[13]);
    assert.ok(await until(async () => (await s.state()).pins['13'] === 'high'));
    await A.drv.disconnect(true);
    const B = user('學生'); await B.connect(s.url); await authorize(B); await B.drv.revoke();
    assert.ok(await until(async () => (await s.state()).pins['13'] === 'input'), '新的控制者撤銷時把 D13 改回輸入');
    await B.drv.disconnect();
  } finally { await s.close(); }
});

test('設備重新開機（按 RESET）：控制者的授權撤銷時也交出控制權，別人可以取得', { timeout: 30000 }, async () => {
  const s = await server();
  try {
    const A = user('老師'), B = user('學生'); await A.connect(s.url); await B.connect(s.url);
    await wait(1700);   // 過了交握後的 1.5 秒，才會判斷重新開機
    await authorize(A); assert.ok(await until(() => B.last()?.holder?.name === '老師'));
    await fetch(`http://127.0.0.1:${s.port}/api/devices/uno-1/fault`, { method: 'POST', body: JSON.stringify({ fault: 'reset' }) });
    assert.ok(await until(() => A.reboots.length > 0, 8000), '老師偵測到重新開機');
    assert.ok(await until(() => B.last()?.holder === null && A.drv.holding === false), '控制權已交出');
    await authorize(B); assert.strictEqual(B.drv.holding, true);
    await A.drv.disconnect(); await B.drv.disconnect();
  } finally { await s.close(); }
});

test('斷線保護（主機）：控制者沒有撤銷就斷線，別人還連著 → 主機立刻關掉他的輸出（LED 熄滅、D13 回到輸入）；伺服只改成輸入、不寫角度', { timeout: 30000 }, async () => {
  const s = await server();
  try {
    const A = user('老師'), B = user('學生'); await A.connect(s.url); await B.connect(s.url);
    await authorize(B);
    const c = B.twin.command('LED1.state', 1).cmd; await B.drv.write(c, LED[0]);
    assert.ok(await until(async () => (await s.state()).bench.parts.find(p => p.id === 'LED1').on), 'LED 亮');
    const w0 = (await s.state()).trafficTotal.writeCount;
    await B.drv.disconnect(true);   // 像關掉分頁：沒有撤銷
    assert.ok(await until(async () => { const st = await s.state(); return !st.bench.parts.find(p => p.id === 'LED1').on && st.pins['13'] === 'input'; }, 2000), '主機關掉輸出：LED 熄滅、D13 回到輸入（老師的心跳還在，韌體自己的斷線保護不會觸發）');
    const st = await s.state(); const ws = st.trafficTotal.writes.slice(-2);
    assert.ok(st.trafficTotal.writeCount - w0 >= 1 && ws.some(w => w.kind === 'digital' && w.pin === 13 && w.v === 0), '主機送出 D13 = 0：' + JSON.stringify(ws));
    assert.strictEqual(A.last().why, 'holder-left');
    assert.deepStrictEqual(st.hub.outputs, [], '主機不再記得學生的輸出腳位');
    await A.drv.disconnect(true);
  } finally { await s.close(); }
});

test('斷線保護（主機）：控制者斷線或逾時時送給晶片的位元組——數位輸出 F5 腳位 0 再 F4 腳位 0；伺服只有 F4 腳位 0（寫 0 會轉到 0°）', () => {
  const { Hub } = require('../tools/vdev/hub.js');
  const dev = []; const h = new Hub({ send: () => { }, notify: () => { }, toDevice: b => dev.push([...b]) });
  try {
    const { link: A } = h.join({ readyState: 1 }, { name: '控制者' }); h.join({ readyState: 1 }, { name: '觀看者' });
    assert.ok(h.lock(A, 'control').ok);
    h.fromLink(A, Uint8Array.from([0xF4, 13, 1, 0xF4, 9, 4, 0xF4, 2, 0x0B])); dev.length = 0;
    h.leave(A);
    assert.deepStrictEqual(dev, [[0xF5, 13, 0, 0xF4, 13, 0, 0xF4, 9, 0]], '只關掉控制者設成輸出的 D13、D9；D2 是輸入，不動');
  } finally { h.stop(); }
});
