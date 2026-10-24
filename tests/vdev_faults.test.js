// 雲端虛擬硬體第 3 階段：故障與網路注入（規劃文件 §4.4，每一列一個測試）
// 虛擬設備主機（真的 WebSocket）＋FirmataDriver＋Twin Core；驅動的 hooks 和介面做的事相同（斷線 → disconnected；重新開機 → rebooted＋恢復唯讀）。
// 都是「已在虛擬設備驗證」，不是實體設備驗證。
const test = require('node:test'); const assert = require('node:assert');
const { DL } = require('./helpers'); require('../src/drivers/drivers.js');
const { startServer } = require('../tools/vdev/server.js');
const { Lane } = require('../tools/vdev/netfault.js');
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 5000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await wait(10); } return false; }

async function rig(bench, opts) {
  opts = opts || {};
  const srv = await startServer({ port: 0, bench });
  const api = `http://127.0.0.1:${srv.port}/api/devices/uno-1`;
  const post = (path, body) => fetch(api + path, { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
  const R = {
    srv, state: () => fetch(api).then(r => r.json()),
    fault: body => post('/fault', body), bench: (part, action, extra) => post('/bench', Object.assign({ part, action }, extra || {})),
    events: [], lost: [], reboots: [], writes: []
  };
  R.connect = async () => {
    const twin = R.twin = R.twin || DL.createTwin({ staleMs: opts.staleMs || 2500 });
    if (!R.subscribed) { R.subscribed = true; twin.on(e => R.events.push(e)); }
    const drv = R.drv = new DL.drivers.FirmataDriver(twin, {
      onLost: w => { R.lost.push(w); twin.disconnected(w); },
      onReboot: w => { R.reboots.push(w); twin.rebooted(w); drv.rewatch(); }
    }, 'uno');
    const w0 = drv.write.bind(drv); drv.write = (c, o) => { R.writes.push([c.id, o.num, c.v]); return w0(c, o); };   // 驅動實際送出的每一筆命令
    const r = await drv.connect({ url: `ws://127.0.0.1:${srv.port}/dev/uno-1` });
    twin.connected(r.deviceId, r.info, { virtual: true });
    return r;
  };
  R.cmd = async (sig, v, num, kind) => { const r = R.twin.command(sig, v); if (r.cmd) await R.drv.write(r.cmd, { num, kind: kind || 'digital' }); return r.cmd; };
  R.close = async () => { try { if (R.drv) await R.drv.disconnect(true); } catch (e) { } await srv.close(); };
  return R;
}
const digitalWrites = (st, pin) => st.traffic.writes.filter(w => w.kind === 'digital' && w.pin === pin);

test('Twin Core：定期回報的訊號超過 staleMs 沒有新讀值就過期；設備重新開機時未確認命令作廢、撤銷授權、開機前的量測過期', () => {
  let now = 0; const twin = DL.createTwin({ now: () => now, staleMs: 1000 });
  twin.define('US1.distance', { periodic: true }); twin.define('BTN1.pressed', {}); twin.define('LED1.state', { feedback: false });
  twin.connected('dev', 'x');
  twin.measure('US1.distance', 30); twin.measure('BTN1.pressed', false);
  now = 1500; twin.heard();   // 連線還有回應（心跳），但超音波沒有新讀值
  assert.strictEqual(twin.quality('US1.distance'), 'stale'); assert.strictEqual(twin.quality('BTN1.pressed'), 'ok', '按鈕只在變化時回報，不算卡住');
  twin.measure('US1.distance', 31); assert.strictEqual(twin.quality('US1.distance'), 'ok');
  twin.authorize(['LED1.state']); const c = twin.command('LED1.state', 1).cmd;
  const r = twin.rebooted('測試');
  assert.deepStrictEqual(r.dropped.map(x => x.id), [c.id]); assert.strictEqual(twin.mode, 'hw-read'); assert.strictEqual(twin.auth, null);
  assert.strictEqual(twin.pending.length, 0); assert.strictEqual(twin.quality('BTN1.pressed'), 'stale', '開機前的量測不能當成現在的值');
  assert.strictEqual(twin.ack(c.id, 1).ok, false, '開機前命令的確認晚到：忽略');
  assert.strictEqual(twin.command('LED1.state', 1).ok, false, '要重新授權');
  assert.ok(twin.log.some(e => e.type === 'reboot') && twin.log.some(e => e.type === 'mode' && e.to === 'hw-read' && /重新開機/.test(e.why)));
});

test('網路佇列：延遲加抖動仍保持先後順序；掉包只丟資料訊框', async () => {
  const got = []; let k = 0; const rand = () => [0.9, 0.1, 0.5, 0.0, 0.99, 0.3][k++ % 6];
  const L = new Lane(x => got.push(x), rand); L.set({ delayMs: 50, jitterMs: 40 });
  for (let i = 0; i < 6; i++) L.push(i, true);
  await until(() => got.length === 6, 2000); assert.deepStrictEqual(got, [0, 1, 2, 3, 4, 5]);
  const g2 = []; const L2 = new Lane(x => g2.push(x), () => 0.01); L2.set({ loss: 0.5 });
  L2.push('資料', true); L2.push('控制', false); assert.deepStrictEqual(g2, ['控制']); assert.strictEqual(L2.stats.dropped, 1);
});

test('§4.4 延遲 200 ms ± 100 ms：量測與 ACK 延後但順序正確；同一腳位連續命令的回讀不會張冠李戴', { timeout: 60000 }, async () => {
  const R = await rig('hold-blink');
  try {
    await R.fault({ net: { delayMs: 200, jitterMs: 100 } });
    const r = await R.connect(); assert.ok(r.identity.ok, '延遲下仍能完成交握');
    R.twin.define('BTN1.pressed', {}); R.twin.define('LED1.state', { feedback: false });
    await R.drv.watch([{ signal: 'BTN1.pressed', num: 2, kind: 'button' }]);
    assert.ok(await until(() => R.twin.view('BTN1.pressed').measured));
    await until(() => R.drv.transport.rtt !== null, 3000);
    assert.ok(R.drv.transport.rtt >= 200, '網路來回時間反映延遲：' + R.drv.transport.rtt);
    const m0 = R.events.filter(e => e.type === 'measure').length;
    for (let i = 0; i < 3; i++) { await R.bench('BTN1', 'press'); await wait(150); await R.bench('BTN1', 'release'); await wait(150); }
    assert.ok(await until(() => R.events.filter(e => e.type === 'measure' && e.name === 'BTN1.pressed').length - m0 >= 6 && R.twin.view('BTN1.pressed').measured.v === false, 4000));
    const seq = R.events.slice(m0).filter(e => e.type === 'measure' && e.name === 'BTN1.pressed');
    assert.ok(seq.every((e, i) => i === 0 || e.seq > seq[i - 1].seq), '序號遞增（順序正確）');
    assert.strictEqual(seq[seq.length - 1].v, false, '最後一筆是放開');
    // 同一個腳位連續 3 個命令都在途：最後一個要得到正確的回讀（以前會把第一個的回讀算到後面的命令）
    R.twin.authorize(['LED1.state']); await R.drv.authorize([{ signal: 'LED1.state', num: 13, kind: 'digital' }]);
    // 亮、滅兩個命令都在途：第一個回讀（亮）不能被算成第二個命令（滅）的確認
    const t0 = Date.now(); await R.cmd('LED1.state', 1, 13); const c2 = await R.cmd('LED1.state', 0, 13);
    assert.ok(await until(() => R.twin.view('LED1.state').ack && R.twin.view('LED1.state').ack.id === c2.id, 5000));
    const ack = R.twin.view('LED1.state').ack;
    assert.ok(ack.matches && ack.v === 0, '回讀一致：' + JSON.stringify(ack)); assert.ok(Date.now() - t0 >= 200, 'ACK 至少延後一個來回');
    assert.strictEqual((await R.state()).pins['13'], 'low');
    assert.ok(R.events.some(e => e.type === 'superseded'), '第一個命令被新命令取代，不會再算數');
    assert.ok(!R.events.some(e => e.type === 'ack' && e.id === c2.id && e.v !== 0), '沒有把錯的回讀算給第二個命令');
  } finally { await R.close(); }
});

test('§4.4 掉包：命令或回讀遺失時標示為未確認、不自動重送；5 % 隨機掉包時每個命令只送一次', { timeout: 90000 }, async () => {
  const R = await rig('hold-blink');
  try {
    await R.connect(); R.twin.define('LED1.state', { feedback: false });
    R.twin.authorize(['LED1.state']); await R.drv.authorize([{ signal: 'LED1.state', num: 13, kind: 'digital' }]);
    // 1. 介面 → 設備全部掉：命令沒送到，一直未確認；網路恢復後也不會補送
    await R.fault({ net: { loss: 1, dir: 'up' } });
    const c1 = await R.cmd('LED1.state', 1, 13); await wait(1300);
    assert.deepStrictEqual(R.twin.pending.map(c => c.id), [c1.id], '逾時未確認');
    await R.fault({ net: null }); await wait(1500);
    let st = await R.state();
    assert.strictEqual(digitalWrites(st, 13).length, 0, '設備端沒有收到、之後也沒有被補送'); assert.strictEqual(st.pins['13'], 'low', '授權時設成輸出（LOW），命令沒到所以沒有變 HIGH');
    assert.strictEqual(R.writes.filter(w => w[0] === c1.id).length, 1, '驅動只送過一次');
    // 2. 設備 → 介面全部掉：命令有執行（D13 HIGH），但回讀遺失，一直未確認；不重送
    R.twin.revoke('test'); R.twin.authorize(['LED1.state']);
    await R.fault({ net: { loss: 1, dir: 'down' } });
    const c2 = await R.cmd('LED1.state', 0, 13); const c2b = await R.cmd('LED1.state', 1, 13); await wait(1300);
    st = await R.state();
    assert.strictEqual(st.pins['13'], 'high', '命令到了設備');
    assert.ok(R.twin.pending.some(c => c.id === c2b.id) && !R.twin.view('LED1.state').ack, '回讀遺失：未確認');
    await R.fault({ net: null }); await wait(1200);
    assert.strictEqual(digitalWrites(await R.state(), 13).length, 2, '設備端只收到這兩筆，沒有補送');
    // 3. 5 % 隨機掉包（兩個方向）：送 40 個命令，每個都只送一次；設備收到的不會比送出的多
    await R.fault({ net: { loss: 0.05 } });
    const n0 = R.writes.length, w0 = digitalWrites(await R.state(), 13).length;
    for (let i = 0; i < 40; i++) { await R.cmd('LED1.state', i % 2, 13); await wait(60); }
    await wait(1500);
    st = await R.state(); const sent = R.writes.slice(n0);
    assert.strictEqual(sent.length, 40); assert.strictEqual(new Set(sent.map(w => w[0])).size, 40, '沒有任何命令被送兩次');
    const got = digitalWrites(st, 13).length - w0;
    assert.ok(got <= 40, `設備收到 ${got} 筆`); assert.ok(st.faults.up.dropped + st.faults.down.dropped > 0, '確實有掉包：' + JSON.stringify(st.faults));
  } finally { await R.close(); }
});

test('§4.4 連線中斷：回到模擬、未確認命令作廢不重送、量測過期；重新連線從唯讀開始', { timeout: 60000 }, async () => {
  const R = await rig('hold-blink');
  try {
    await R.connect(); R.twin.define('BTN1.pressed', {}); R.twin.define('LED1.state', { feedback: false });
    await R.drv.watch([{ signal: 'BTN1.pressed', num: 2, kind: 'button' }]); assert.ok(await until(() => R.twin.view('BTN1.pressed').measured));
    R.twin.authorize(['LED1.state']); await R.drv.authorize([{ signal: 'LED1.state', num: 13, kind: 'digital' }]);
    await R.fault({ net: { delayMs: 800 } }); const c = await R.cmd('LED1.state', 1, 13);   // 命令還在路上
    await R.fault({ fault: 'disconnect' });
    assert.ok(await until(() => R.lost.length === 1, 4000), '偵測到中斷');
    assert.strictEqual(R.twin.mode, 'sim'); assert.deepStrictEqual(R.twin.dropped.map(x => x.id), [c.id]); assert.strictEqual(R.twin.quality('BTN1.pressed'), 'stale');
    await R.fault({ net: null }); await R.drv.disconnect(true);
    const st0 = await R.state(); assert.strictEqual(st0.linked, false);
    await R.connect(); assert.strictEqual(R.twin.mode, 'hw-read');
    await R.drv.watch([{ signal: 'BTN1.pressed', num: 2, kind: 'button' }]); await wait(1200);
    const st = await R.state(); assert.strictEqual(st.traffic.writeCount, 0, '新連線沒有任何寫入（舊命令沒有重送）');
  } finally { await R.close(); }
});

for (const fault of ['reset', 'brownout'])
test(`§4.4 設備${fault === 'reset' ? '重置（按 RESET）' : '瞬間斷電（brown-out）'}：偵測到重新開機 → 撤銷寫入授權回到唯讀、未確認命令不重送、恢復唯讀觀測`, { timeout: 60000 }, async () => {
  const R = await rig('hold-blink');
  try {
    await R.connect(); R.twin.define('BTN1.pressed', {}); R.twin.define('LED1.state', { feedback: false });
    await R.drv.watch([{ signal: 'BTN1.pressed', num: 2, kind: 'button' }]); assert.ok(await until(() => R.twin.view('BTN1.pressed').measured));
    R.twin.authorize(['LED1.state']); await R.drv.authorize([{ signal: 'LED1.state', num: 13, kind: 'digital' }]);
    const c1 = await R.cmd('LED1.state', 1, 13); assert.ok(await until(() => R.twin.view('LED1.state').ack && R.twin.view('LED1.state').ack.id === c1.id));
    await wait(2500); assert.strictEqual(R.reboots.length, 0, '正常運作時不會誤判成重新開機');
    await R.fault({ net: { loss: 1, dir: 'down' } }); const c2 = await R.cmd('LED1.state', 0, 13); await wait(200); await R.fault({ net: null });   // c2 的回讀遺失：還沒確認
    assert.ok(R.twin.pending.some(c => c.id === c2.id));
    const w0 = (await R.state()).traffic.writeCount;
    await R.fault({ fault });
    assert.ok(await until(() => R.reboots.length === 1, 4000), '從韌體的開機訊息偵測到重新開機');
    assert.strictEqual(R.twin.mode, 'hw-read'); assert.strictEqual(R.twin.auth, null);
    assert.ok(R.twin.dropped.some(c => c.id === c2.id), '未確認的命令作廢'); assert.strictEqual(R.twin.pending.length, 0);
    assert.strictEqual(R.twin.command('LED1.state', 1).ok, false, '要重新授權才能寫');
    const st = await R.state(); assert.strictEqual(st.pins['13'], 'input', '晶片重新開機，D13 回到輸入'); assert.strictEqual(st.bench.parts.find(p => p.id === 'LED1').on, false);
    assert.strictEqual(st.traffic.writeCount, w0, '重新開機後沒有任何寫入（不重送）');
    // 恢復唯讀觀測：重新設定上拉輸入後，按鈕又能量到
    await R.bench('BTN1', 'press');
    assert.ok(await until(() => R.twin.view('BTN1.pressed').measured.v === true && R.twin.quality('BTN1.pressed') === 'ok', 4000), '重新開機後按鈕仍可觀測');
    assert.ok(R.events.some(e => e.type === 'reboot' && e.dropped.includes(c2.id)));
  } finally { await R.close(); }
});

test('§4.4 感測器卡住（超音波 ECHO 一直是高電位，韌體不再回報）：超過 staleMs 標為過期；恢復後又有效', { timeout: 60000 }, async () => {
  const R = await rig('dist-gauge', { staleMs: 1000 });
  try {
    await R.connect(); R.twin.define('US1.distance', { periodic: true });
    await R.drv.watch([{ signal: 'US1.distance', num: 7, echo: 8, kind: 'sonar' }]);
    await R.bench('US1', 'set', { cm: 30 });
    assert.ok(await until(() => { const v = R.twin.view('US1.distance'); return v.measured && Math.abs(v.measured.v - 30) <= 1 && v.quality === 'ok'; }));
    await R.bench('US1', 'stuck');
    assert.ok(await until(() => R.twin.quality('US1.distance') === 'stale', 3000), '卡住後過期');
    assert.strictEqual(R.twin.conn.state, 'connected', '連線本身正常（心跳還在）');
    assert.ok(Date.now() - R.twin.conn.lastHeard < 1000);
    await R.bench('US1', 'unstuck');
    assert.ok(await until(() => R.twin.quality('US1.distance') === 'ok', 3000), '恢復後又有新讀值');
  } finally { await R.close(); }
});

test('§4.4 工作台拔掉一條線：拔掉按鈕線後按了沒有變化（核對接線會失敗）；拔掉 LED 線時命令有 ACK 但 LED 不亮；接回後恢復', { timeout: 60000 }, async () => {
  const R = await rig('hold-blink');
  try {
    await R.connect(); R.twin.define('BTN1.pressed', {}); R.twin.define('LED1.state', { feedback: false });
    await R.drv.watch([{ signal: 'BTN1.pressed', num: 2, kind: 'button' }]); assert.ok(await until(() => R.twin.view('BTN1.pressed').measured));
    await R.bench('BTN1', 'unplug');
    const n0 = R.events.filter(e => e.type === 'measure' && e.name === 'BTN1.pressed' && e.v === true).length;
    await R.bench('BTN1', 'press'); await wait(400); await R.bench('BTN1', 'release'); await wait(300);
    assert.strictEqual(R.events.filter(e => e.type === 'measure' && e.name === 'BTN1.pressed' && e.v === true).length, n0, '拔線時按下不會出現在量測');
    assert.strictEqual(R.twin.view('BTN1.pressed').measured.v, false, '空接的腳開了上拉：讀到放開');
    await R.bench('BTN1', 'plug'); await R.bench('BTN1', 'press');
    assert.ok(await until(() => R.twin.view('BTN1.pressed').measured.v === true), '接回後按下又量得到');
    await R.bench('BTN1', 'release');
    await R.bench('LED1', 'unplug');
    R.twin.authorize(['LED1.state']); await R.drv.authorize([{ signal: 'LED1.state', num: 13, kind: 'digital' }]);
    const c = await R.cmd('LED1.state', 1, 13);
    assert.ok(await until(() => R.twin.view('LED1.state').ack && R.twin.view('LED1.state').ack.id === c.id && R.twin.view('LED1.state').ack.matches));
    let st = await R.state(); assert.strictEqual(st.pins['13'], 'high'); assert.strictEqual(st.bench.parts.find(p => p.id === 'LED1').on, false, 'LED 線拔掉：不亮');
    await R.bench('LED1', 'plug'); st = await R.state(); assert.strictEqual(st.bench.parts.find(p => p.id === 'LED1').on, true, '接回就亮（腳位一直是 HIGH）');
  } finally { await R.close(); }
});
