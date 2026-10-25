// 雲端虛擬硬體第 6 階段：同一台虛擬設備主機上的三種虛擬設備（虛擬 Uno、虛擬 ESP32 協定模型、虛擬樹莓派），
// 以及虛擬樹莓派經主機轉接時的標示、故障注入（網路延遲、中斷）與限制（沒有 RESET；ESP32 不能上傳）。
// 都是「已在虛擬設備驗證，未以實體設備驗證」。
const test = require('node:test'); const assert = require('node:assert'); const { execFileSync } = require('child_process');
const { DL } = require('./helpers'); require('../src/drivers/drivers.js');
const { startServer } = require('../tools/vdev/server.js');
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 5000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(20); } return null; }
const hasPi = (() => { try { execFileSync(process.env.DOFLAB_PYTHON || 'python3', ['-c', 'import gpiozero, aiohttp'], { stdio: 'ignore' }); return true; } catch (e) { return false; } })();
const json = (url, body) => fetch(url, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());

test('一台主機三種虛擬設備：各自標示（avr8js／協定模型／pi_bridge＋模擬腳位），三個介面同時連線、按鈕同時同步', { skip: !hasPi && '沒有 python3 的 gpiozero 與 aiohttp', timeout: 60000 }, async () => {
  const s = await startServer({ port: 0, devices: [{ id: 'uno-1' }, { id: 'esp32-1', board: 'esp32', bench: 'esp32-hold-blink' }, { id: 'pi-1', board: 'pi4b', bench: 'pi-hold-blink' }] });
  const base = `http://127.0.0.1:${s.port}`;
  const drvs = [];
  try {
    const list = await json(base + '/api/devices');
    assert.deepStrictEqual(list.map(d => [d.id, d.board]), [['uno-1', 'uno'], ['esp32-1', 'esp32'], ['pi-1', 'pi4b']]);
    assert.strictEqual(list.find(d => d.id === 'esp32-1').model, 'protocol');
    assert.ok((await json(base + '/api/benches')).some(b => b.board === 'pi4b'));
    const st = await json(base + '/api/devices/esp32-1'); assert.strictEqual(st.model, 'protocol'); assert.match(st.note, /不是實際韌體/);
    // 三個介面：各自的驅動（Uno、ESP32 用 Firmata；樹莓派用 pi_bridge 協定）
    const rigs = [['uno', 'uno-1', 2], ['esp32', 'esp32-1', 4], ['pi4b', 'pi-1', 27]].map(([board, id, pin]) => {
      const twin = DL.createTwin(); const info = DL.drivers.driverFor(board, 'virtual'); const drv = new info.cls(twin, {}, board); drvs.push(drv);
      return { board, id, pin, twin, drv, info };
    });
    for (const r of rigs) {
      const c = await r.drv.connect({ url: `ws://127.0.0.1:${s.port}/dev/${r.id}`, name: r.board });
      assert.ok(c.virtual && c.identity.ok && c.identity.virtual, JSON.stringify(c));
      if (r.board === 'esp32') { assert.ok(c.protocol && /協定模型/.test(c.info) && /不是實際韌體/.test(c.identity.msg), JSON.stringify(c)); assert.match(r.info.status, /協定模型/); }
      if (r.board === 'pi4b') { assert.match(c.identity.msg, /不是實體樹莓派/); assert.strictEqual(r.drv.deploy.ok, false); assert.match(r.drv.deploy.why, /不支援部署/); }
      if (r.board === 'uno') assert.ok(!c.protocol && /avr8js/.test(c.identity.msg));
      r.twin.connected(c.deviceId, c.info, { virtual: true }); r.twin.define('BTN1.pressed', {});
      await r.drv.watch([{ signal: 'BTN1.pressed', num: r.pin, kind: 'button' }]);
    }
    assert.ok(await until(() => rigs.every(r => r.twin.view('BTN1.pressed').measured && r.twin.view('BTN1.pressed').measured.v === false)), '三台都讀到「沒按」');
    await Promise.all(rigs.map(r => json(`${base}/api/devices/${r.id}/bench`, { part: 'BTN1', action: 'press' })));
    assert.ok(await until(() => rigs.every(r => r.twin.view('BTN1.pressed').measured.v === true)), '三台的按下都同步：' + rigs.map(r => r.board + '=' + r.twin.view('BTN1.pressed').measured.v).join('、'));
  } finally { for (const d of drvs) try { await d.disconnect(true); } catch (e) { } await s.close(); }
});

test('虛擬樹莓派經主機轉接：網路延遲注入會延後量測；「中斷網路連線」讓介面斷線；沒有 RESET 故障；工作台操作錯誤回 400', { skip: !hasPi && '沒有 python3 的 gpiozero 與 aiohttp', timeout: 60000 }, async () => {
  const s = await startServer({ port: 0, devices: [{ id: 'pi-1', board: 'pi4b', bench: 'pi-hold-blink' }] });
  const api = `http://127.0.0.1:${s.port}/api/devices/pi-1`;
  const twin = DL.createTwin(); const lost = [];
  const drv = new DL.drivers.PiBridgeDriver(twin, { onLost: w => { lost.push(w); twin.disconnected(w); } });
  try {
    const c = await drv.connect({ url: `ws://127.0.0.1:${s.port}/dev/pi-1` }); twin.connected(c.deviceId, c.info, { virtual: true });
    twin.define('BTN1.pressed', {}); await drv.watch([{ signal: 'BTN1.pressed', num: 27, kind: 'button' }]);
    assert.ok(await until(() => twin.view('BTN1.pressed').measured));
    const lag = async (cfg, action) => {
      await json(api + '/fault', { net: cfg });
      const t0 = Date.now(); await json(api + '/bench', { part: 'BTN1', action });
      assert.ok(await until(() => twin.view('BTN1.pressed').measured.v === (action === 'press'), 4000)); return Date.now() - t0;
    };
    const fast = await lag(null, 'press'), slow = await lag({ delayMs: 400, jitterMs: 0, loss: 0, dir: 'down' }, 'release');
    assert.ok(slow >= 380 && slow > fast + 300, `延遲注入：${fast} ms → ${slow} ms`);
    const st = await json(api); assert.strictEqual(st.faults.net.delayMs, 400); assert.strictEqual(st.board, 'pi4b'); assert.strictEqual(st.kind, 'virtual');
    await json(api + '/fault', { net: null });
    const r = await json(api + '/fault', { fault: 'reset' }); assert.match(r.error, /沒有「RESET」/);
    const b = await json(api + '/bench', { part: 'NOPE', action: 'press' }); assert.match(b.error, /NOPE/);
    await json(api + '/fault', { fault: 'disconnect' });
    assert.ok(await until(() => lost.length > 0, 3000), '中斷網路連線：介面知道斷線');
    assert.strictEqual(twin.conn.state, 'lost');
  } finally { try { await drv.disconnect(); } catch (e) { } await s.close(); }
});

test('虛擬 ESP32 不能上傳、不能開序列埠監看（只有虛擬 Uno 有開機程式）：主機明確拒絕', { timeout: 30000 }, async () => {
  const s = await startServer({ port: 0, devices: [{ id: 'esp32-1', board: 'esp32' }] });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/dev/esp32-1`); const msgs = []; let closed = null;
    ws.onmessage = e => { try { msgs.push(JSON.parse(e.data)); } catch (x) { } }; ws.onclose = e => { closed = e.code; };
    await new Promise(r => { ws.onopen = r; });
    ws.send(JSON.stringify({ op: 'hello', client: 'test', proto: 2, mode: 'raw' }));
    assert.ok(await until(() => closed !== null, 3000));
    const e = msgs.find(m => m.op === 'error'); assert.strictEqual(e.code, 'unsupported'); assert.match(e.message, /只有虛擬 Uno 有開機程式/); assert.strictEqual(closed, 4003);
  } finally { await s.close(); }
});
