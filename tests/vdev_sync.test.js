// 雲端虛擬硬體第 6 階段驗收：引導實驗在虛擬樹莓派（pi_bridge.py＋gpiozero 模擬腳位＋工作台）與
// 虛擬 ESP32（協定模型：行為和 DofLabFirmata 相同的 JS 程式，不是實際韌體）上「同步」。
// 同步＝介面的引擎在瀏覽器裡跑行為：輸入用設備回報的量測，輸出變成命令經網路送到設備（和「觀測」頁的真機模式相同的步驟）。
// 驗收比的是兩件事：
//   1. 輸入：工作台上的每個操作（按鈕、距離、亮度），介面的引擎都收到了、順序相同
//   2. 輸出：介面送出的每個命令都有回讀 ACK；設備上的 LED 亮滅次序和命令相同；伺服的脈寬換回角度都是送過的命令、最後停在最後一個命令
// 都是「已在虛擬設備驗證，未以實體設備驗證」（ESP32 另外是「協定模型，不是實際韌體」）。
const test = require('node:test'); const assert = require('node:assert'); const { execFileSync } = require('child_process');
const { DL, solved } = require('./helpers'); require('../src/drivers/drivers.js');
const { startServer } = require('../tools/vdev/server.js');
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 5000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(20); } return null; }
const hasPi = (() => { try { execFileSync(process.env.DOFLAB_PYTHON || 'python3', ['-c', 'import gpiozero, aiohttp'], { stdio: 'ignore' }); return true; } catch (e) { return false; } })();

const SIG = { BTN: '.pressed', BOOT: '.pressed', LDR: '.level', LED: '.state', OBLED: '.state', SERVO: '.angle', US: '.distance' };
const INPUTS = ['BTN', 'BOOT', 'LDR', 'US'];
const sigOf = c => SIG[c.type] ? c.id + SIG[c.type] : null;
const fam = b => DL.boardFamily(b) === 'esp32' ? 'esp32' : b;
// 伺服脈寬 → 角度：Uno／ESP32 是 Servo 函式庫的 544–2400 µs；樹莓派是 pi_bridge 設定的 gpiozero AngularServo 500–2400 µs
const usToDeg = (board, us) => board === 'pi4b' ? (us - 500) * 180 / 1900 : (us - 544) * 180 / 1856;

// 工作台照專案的接線擺（按鈕不彈跳、光敏沒有雜訊、超音波不掉回波：這裡比的是同步，彈跳與雜訊另有測試）
function benchFor(p, board) {
  const B = DL.netlist.analyze(p).bindings; const parts = [];
  for (const c of p.components) {
    const b = B[c.id]; if (!b) continue;
    if (DL.behavior.BUTTONS.includes(c.type)) parts.push({ id: c.id, type: 'button', pin: b.num, bounceMs: 0 });
    else if (DL.behavior.LEDS.includes(c.type)) parts.push({ id: c.id, type: 'led', pin: b.num });
    else if (c.type === 'LDR') parts.push({ id: c.id, type: 'ldr', pin: b.num, light: 50, noise: 0 });
    else if (c.type === 'US') parts.push({ id: c.id, type: 'ultrasonic', trig: b.num, echo: b.echoNum, cm: 100, drop: 0 });
    else if (c.type === 'SERVO') parts.push({ id: c.id, type: 'servo', pin: b.num });
  }
  return { id: 'sync-' + p.name, name: '同步驗收：' + p.name, board, seed: 1, parts };
}
// 輸入情境（開始同步後的毫秒）：和第 4 階段驗收相同的操作
const SCEN = {
  BTN1: [[315, 'press'], [1815, 'release'], [2335, 'press'], [2495, 'release'], [3025, 'press'], [3625, 'release']],
  BTN2: [[835, 'press'], [1035, 'release'], [2635, 'press'], [2755, 'release']],
  BOOT1: [[315, 'press'], [815, 'release'], [1535, 'press'], [1735, 'release']],
  LDR1: [[525, 10], [1525, 85], [2545, 50], [3035, 90], [3625, 20]],
  US1: [[435, 30], [1035, 12], [1735, 5], [2425, 25], [3025, null], [3505, 8]]
};
const RUN_MS = 4300;
const ABC = [['A', { x: 10, y: 6, z: -6 }, 300], ['B', { x: 12, y: 10, z: 0 }, 0], ['C', { x: 8, y: 5, z: 7 }, 700]];
function armProject(board) {
  const p = solved('arm-3dof', board); const cfg = p.arm.config; const a = DL.netlist.analyze(p);
  p.arm.poses = ABC.map(([name, t, holdMs]) => { const s = DL.arm.ik(cfg, t, [0, 90, 90]); return { name, t, q: s.q, holdMs }; });
  p.arm.confirmed = { hash: DL.hash({ cfg, b: cfg.joints.map(j => a.bindings[j.servo].pin), board: p.board.type }), at: 'test' };
  return p;
}

// 一個實驗的同步：設備主機（只有這一台設備）＋驅動＋Twin＋引擎（每 1 ms 一輪，跟著實際時間）
async function syncRun(board, p) {
  const id = fam(board) === 'pi4b' ? 'pi-1' : 'esp32-1';
  const s = await startServer({ port: 0, devices: [{ id, board: fam(board), bench: benchFor(p, fam(board)) }] });
  const api = `http://127.0.0.1:${s.port}/api/devices/${id}`;
  const act = q => fetch(api + '/bench', { method: 'POST', body: JSON.stringify(q) }).then(r => r.json());
  const twin = DL.createTwin(); const logs = [];
  const info = DL.drivers.driverFor(board, 'virtual');
  const drv = new info.cls(twin, { log: (m, k) => logs.push([k || '', m]), onLost: w => twin.disconnected(w) }, board);
  const timers = [];
  try {
    const r = await drv.connect({ url: `ws://127.0.0.1:${s.port}/dev/${id}`, name: '驗收' });
    assert.ok(r.virtual && r.identity.ok && r.identity.virtual, '連線結果標示虛擬且板卡相符：' + JSON.stringify(r));
    twin.connected(r.deviceId, r.info, { virtual: true });
    const B = DL.netlist.analyze(p).bindings;
    for (const c of p.components) { const sg = sigOf(c); if (sg) twin.define(sg, { kind: INPUTS.includes(c.type) ? 'input' : 'output', comp: c.id, ctype: c.type, feedback: INPUTS.includes(c.type), periodic: c.type === 'LDR' || c.type === 'US' }); }
    const ins = Object.values(B).filter(b => b.role === 'button' || b.role === 'analog' || b.role === 'ultrasonic').map(b => b.role === 'ultrasonic' ? { signal: b.comp + '.distance', num: b.trigNum, echo: b.echoNum, kind: 'sonar' } : { signal: b.comp + (b.role === 'button' ? '.pressed' : '.level'), num: b.num, kind: b.role === 'button' ? 'button' : 'analog' });
    // 介面的按鈕量測依收到的時刻排隊（和 observe.js 的 noteButtonEvent／feedButtons 相同）
    const meas = []; twin.on(e => { if (e.type === 'measure' && !/\.pressed$/.test(e.name)) meas.push([Math.round(performance.now()), e.name, e.v]); });
    const btnQ = []; twin.on(e => { if (e.type === 'measure' && /\.pressed$/.test(e.name)) btnQ.push({ name: e.name, v: !!e.v, at: performance.now() }); });
    await drv.watch(ins);
    assert.ok(await until(() => ins.every(i => twin.view(i.signal).measured), 5000), '每個輸入都有第一筆量測：' + ins.map(i => i.signal + '=' + JSON.stringify(twin.view(i.signal).measured)).join('、'));
    const outs = Object.values(B).filter(b => ['LED', 'OBLED', 'SERVO'].includes(DL.project.findComp(p, b.comp).type)).map(b => ({ comp: b.comp, signal: sigOf(DL.project.findComp(p, b.comp)), num: b.num, kind: DL.project.findComp(p, b.comp).type === 'SERVO' ? 'servo' : 'digital' }));
    if (drv.acquire) { const g = await drv.acquire(); assert.ok(g.ok, '取得控制權：' + JSON.stringify(g)); }
    assert.ok(twin.authorize(outs.map(o => o.signal), { ok: true }).ok); await drv.authorize(outs);
    await fetch(api + '/trace?clear=1');
    // 輸入情境：依實際時間排定
    const scen = [];
    for (const [part, steps] of Object.entries(SCEN)) {
      if (!benchFor(p, fam(board)).parts.some(x => x.id === part)) continue;
      for (const [t, v] of steps) scen.push({ t, q: part.startsWith('BTN') || part.startsWith('BOOT') ? { part, action: v } : part.startsWith('LDR') ? { part, action: 'set', light: v } : { part, action: 'set', cm: v } });
    }
    const e = DL.createEngine(p); const cmds = []; const seen = {}; const fed = {};
    const arm = p.arm && p.arm.poses && p.arm.poses.length ? { plan: DL.arm.seqPlan(p.arm), ids: p.arm.config.joints.map(j => j.servo), last: [], at: [] } : null;
    if (arm) arm.st = DL.arm.seqStart(arm.plan, 0);
    const w0 = performance.now(); let t = 0;
    for (const x of scen) timers.push(setTimeout(() => act(x.q).catch(() => { }), x.t));
    const send = (c, sg, v, num, kind, wall) => { twin.target(sg, v, 'behavior'); const res = twin.command(sg, v, 'behavior'); if (res.ok && res.cmd) { drv.write(res.cmd, { num, kind }); cmds.push({ t, wall, comp: c, v: typeof v === 'boolean' ? (v ? 1 : 0) : v }); return true; } assert.ok(res.ok, res.msg); return false; };
    while (t < RUN_MS) {
      await wait(4);
      const now = performance.now() - w0;
      while (t < Math.min(Math.floor(now), RUN_MS)) {
        t++;
        while (btnQ.length && btnQ[0].at - w0 <= t) { const x = btnQ.shift(); fed[x.name] = x.v; }
        if (arm) DL.arm.seqStep(arm.plan, arm.st, t);
        for (const c of p.components) {
          const sg = sigOf(c); if (!sg || !INPUTS.includes(c.type)) continue;
          const v = twin.view(sg); let x;
          if (c.type === 'BTN' || c.type === 'BOOT') { x = v.quality === 'ok' ? (fed[sg] !== undefined ? fed[sg] : !!(v.measured && v.measured.v)) : false; e.setButton(c.id, x); }
          else if (c.type === 'LDR') { if (v.quality === 'ok' && v.measured) { x = v.measured.v; e.setAdcRaw(c.id, v.measured.raw !== undefined ? v.measured.raw : v.measured.v); } }
          else { x = v.quality === 'ok' && v.measured ? v.measured.v : 400; e.setDistance(c.id, x); }
          const h = seen[c.id] = seen[c.id] || []; if (x !== undefined && (!h.length || h[h.length - 1][1] !== x)) h.push([t, x]);
        }
        const r = e.tick(t);
        for (const c of p.components) {
          const sg = sigOf(c); if (!sg || !(c.id in r.out) || (arm && arm.ids.includes(c.id)) || !B[c.id]) continue;
          send(c.id, sg, r.out[c.id], B[c.id].num, c.type === 'SERVO' ? 'servo' : 'digital', now);
        }
      }
      // 手臂（和 arm.js 的 armTick 相同）：每一幀把序列的姿勢換成伺服角度，角度改變且距上次送出 ≥ 25 ms 才送
      if (arm) {
        const cfg = p.arm.config; const sv = DL.arm.toServo(cfg, DL.arm.fromServo(cfg, arm.st.cur));
        arm.ids.forEach((sid, i) => { if (sv[i] !== arm.last[i] && !(now - arm.at[i] < 25) && send(sid, sid + '.angle', sv[i], B[sid].num, 'servo', now)) { arm.last[i] = sv[i]; arm.at[i] = now; } });
      }
    }
    // 最後一個命令都確認了才看設備
    const pendingAck = () => outs.filter(o => { const v = twin.view(o.signal); return v.commanded && !(v.ack && v.ack.id === v.commanded.id); }).map(o => o.signal);
    assert.ok(await until(() => !pendingAck().length, 4000), '最後的命令沒有回讀 ACK：' + pendingAck().join('、'));
    await wait(150);
    const tr = await (await fetch(api + '/trace')).json();
    if (process.env.DOFLAB_SYNC_DEBUG) { const st = await (await fetch(api)).json(); console.log(JSON.stringify({ parts: st.bench.parts, pins: st.pins, meas: meas.slice(0, 40), traffic: st.traffic })); }
    return { cmds, seen, trace: tr.trace, logs, dropped: twin.dropped.slice(), scen, meas };
  } finally {
    timers.forEach(clearTimeout);
    try { await drv.disconnect(true); } catch (e) { }
    await s.close();
  }
}
// 比對（說明見檔案開頭）
function check(board, p, R) {
  const out = {};
  assert.deepStrictEqual(R.dropped, [], '沒有作廢的命令');
  const errs = R.logs.filter(([k]) => k === 'e'); assert.deepStrictEqual(errs, [], '驅動沒有錯誤訊息');
  // 1. 輸入
  for (const [part, steps] of Object.entries(SCEN)) {
    const c = p.components.find(x => x.id === part); if (!c || !R.seen[part]) continue;
    const got = R.seen[part].map(x => x[1]);
    if (c.type === 'BTN' || c.type === 'BOOT') assert.deepStrictEqual(got, [false, ...steps.map(s => s[1] === 'press')], `${part}：引擎收到的按鈕狀態`);
    else if (c.type === 'US') { for (const [, cm] of steps) assert.ok(got.some(v => Math.abs(v - (cm === null ? 400 : cm)) <= 1), `${part}：工作台設 ${cm} cm，引擎沒有收到（收到 ${got.join('、')}）`); }
    else if (c.type === 'LDR') { const pc = R.seen[part].map(x => x[1]); for (const [, L] of steps) assert.ok(pc.some(v => Math.abs(v - L) <= 2), `${part}：工作台設亮度 ${L}%，引擎沒有收到（收到 ${pc.join('、')}）`); }
    out[part] = got.length;
  }
  // 2. 輸出
  for (const c of p.components) {
    const cs = R.cmds.filter(x => x.comp === c.id);
    if (DL.behavior.LEDS.includes(c.type)) {
      const want = [], wall = []; let pv = 0; for (const x of cs) if (x.v !== pv) { want.push(x.v); wall.push(x.wall); pv = x.v; }
      const tr = R.trace.filter(x => x.part === c.id && 'on' in x), got = tr.map(x => x.on ? 1 : 0);
      assert.deepStrictEqual(got, want, `${c.id}：設備上的 LED 亮滅（${got.length} 次）和介面的命令（${want.length} 次）`);
      // 延遲的一致性：設備時鐘和介面時鐘的起點不同，只看「設備時間 − 送出時間」的變動範圍（同一台電腦上，主要是排程與畫面迴圈的 4 ms 間隔）
      const d = tr.map((x, i) => x.devMs - wall[i]); const spread = d.length ? Math.max(...d) - Math.min(...d) : 0;
      assert.ok(spread <= 250, `${c.id}：命令到設備的延遲變動 ${spread.toFixed(1)} ms`);
      out[c.id] = `${got.length} 次（延遲變動 ${spread.toFixed(1)} ms）`;
    } else if (c.type === 'SERVO') {
      // Uno／ESP32 的 Servo 函式庫：授權（attach）後、第一個角度命令到達前輸出預設的 1500 µs（約 93°）。
      // 虛擬 Uno 上的真韌體也是 1502 µs（已在虛擬 Uno 確認）；這是韌體的行為，不是同步錯誤，所以開頭的這一段不比
      const us = R.trace.filter(x => x.part === c.id && 'us' in x).map(x => x.us);
      if (board !== 'pi4b') while (us.length > 1 && Math.abs(us[0] - 1500) <= 4) us.shift();
      const got = us.map(x => usToDeg(board, x));
      assert.ok(cs.length && got.length, `${c.id}：有命令 ${cs.length} 個、設備脈寬 ${got.length} 次`);
      let k = 0;
      for (const d of got) { while (k < cs.length && Math.abs(cs[k].v - d) > 1) k++; assert.ok(k < cs.length, `${c.id}：設備的 ${d.toFixed(1)}° 不是依序送過的命令（命令 ${cs.map(x => x.v).join('、')}）`); }
      assert.ok(Math.abs(got[got.length - 1] - cs[cs.length - 1].v) <= 1, `${c.id}：設備最後 ${got[got.length - 1].toFixed(1)}°，最後的命令 ${cs[cs.length - 1].v}°`);
      out[c.id] = `${cs.length} 個命令、${got.length} 種脈寬`;
    }
  }
  return out;
}

// DOFLAB_SYNC_ONLY=dist-alarm,arm-3dof：只跑這幾個實驗（除錯用；數量檢查也跟著略過）
const ONLY = process.env.DOFLAB_SYNC_ONLY ? process.env.DOFLAB_SYNC_ONLY.split(',') : null;
const EXPS = b => DL.experiments.list.filter(e => DL.experiments.supports(e, b) && (!ONLY || ONLY.includes(e.id))).map(e => e.id);
const projectFor = (id, board) => id === 'arm-3dof' ? armProject(board) : solved(id, board);

test('驗收（虛擬樹莓派）：所有支援樹莓派的引導實驗，經虛擬設備主機轉接的 pi_bridge.py（模擬腳位＋工作台）同步：輸入都收到、命令都有 ACK、設備輸出和命令相同', { skip: !hasPi && '沒有 python3 的 gpiozero 與 aiohttp', timeout: 600000 }, async t => {
  const ids = EXPS('pi4b'); if (!ONLY) assert.strictEqual(ids.length, 12, '支援樹莓派的引導實驗：' + ids.join('、'));
  for (const id of ids) await t.test(id, async () => { const p = projectFor(id, 'pi4b'); const R = await syncRun('pi4b', p); const o = check('pi4b', p, R); t.diagnostic(`${id}：${JSON.stringify(o)}`); });
});

test('驗收（虛擬 ESP32，協定模型）：所有支援 ESP32-DevKitC 的引導實驗同步：輸入都收到、命令都有 ACK、設備輸出和命令相同', { timeout: 600000 }, async t => {
  const ids = EXPS('esp32'); if (!ONLY) assert.ok(ids.length >= 15, '支援 ESP32 的引導實驗：' + ids.join('、'));
  for (const id of ids) await t.test(id, async () => { const p = projectFor(id, 'esp32'); const R = await syncRun('esp32', p); const o = check('esp32', p, R); t.diagnostic(`${id}：${JSON.stringify(o)}`); });
});

test('驗收（虛擬 ESP32，協定模型）：ESP32 DevKit V1 的「BOOT 鍵切換藍燈」（GPIO0、GPIO2）同步；觸控實驗不支援同步（介面明確告知）', { timeout: 60000 }, async () => {
  const p = solved('board-boot-toggle', 'esp32doit'); const R = await syncRun('esp32doit', p); check('esp32doit', p, R);
  assert.ok(R.cmds.filter(c => c.comp === 'OBLED1').length >= 2, '按 BOOT 會切換藍燈：' + JSON.stringify(R.cmds));
  const touch = DL.experiments.list.filter(e => DL.experiments.supports(e, 'esp32doit') && /touch/.test(e.id)).map(e => e.id);
  assert.ok(touch.length >= 1);
  for (const id of touch) assert.ok(Object.values(DL.netlist.analyze(solved(id, 'esp32doit')).bindings).some(b => b.role === 'touch'), id + ' 用到觸控腳（observe.js 會顯示「觸控腳的真機同步本版未支援」）');
});
