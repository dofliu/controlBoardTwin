// 雲端虛擬硬體第 4 階段：上傳與序列埠。
// 瀏覽器用的 STK500 上傳程式（src/drivers/stk500.js）經 WebSocket（DL.transport.wsSerialPort）上傳到虛擬設備主機裡的虛擬 Uno；
// 虛擬晶片跑 Arduino 官方 Optiboot：DTR 重置進入開機程式 → 逐頁寫入（SPM）→ 讀回比對 → 看門狗重置後執行新程式。
// 驗收：所有支援 Uno 的引導實驗，產生的程式（arduino-cli 編譯）上傳後，在虛擬設備上的輸出（工作台記錄的 LED、伺服脈寬）和介面模擬一致；
// Serial.println 的文字經序列埠監看送回。這些都是「已在虛擬設備驗證，未以實體設備驗證」。
const test = require('node:test'); const assert = require('node:assert');
const { execFile, execFileSync } = require('child_process'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { DL, solved, confirm } = require('./helpers'); require('../src/drivers/drivers.js'); require('../src/drivers/stk500.js');
const { startServer } = require('../tools/vdev/server.js');
let hasCli = true; try { execFileSync('arduino-cli', ['version']); } catch (e) { hasCli = false; }
const FIX = path.join(__dirname, 'fixtures');
const FIRMATA = fs.readFileSync(path.join(FIX, 'DofLabFirmata-uno.hex'), 'utf8');
const STANDARD = fs.readFileSync(path.join(FIX, 'StandardFirmata-2.5.9-uno.hex'), 'utf8');
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(25); } return null; }

async function server(bench) {
  const s = await startServer({ port: 0, devices: [{ id: 'uno-1', bench: bench || 'hold-blink' }] });
  const api = `http://127.0.0.1:${s.port}/api/devices/uno-1`;
  return Object.assign(s, { url: `ws://127.0.0.1:${s.port}/dev/uno-1`, api, state: async () => (await fetch(api)).json(), trace: async clear => (await fetch(api + '/trace' + (clear ? '?clear=1' : ''))).json(), act: q => fetch(api + '/bench', { method: 'POST', body: JSON.stringify(q) }).then(r => r.json()) });
}
// 上傳：和瀏覽器完全相同的 stk500.flash，只是連接埠換成 WebSocket 版
async function upload(s, hex) {
  const logs = [], prog = []; const port = DL.transport.wsSerialPort(s.url, { log: m => logs.push(m) });
  const r = await DL.stk500.flash(port, hex, { log: m => logs.push(m), onProgress: p => prog.push(p) });
  return { r, logs, prog };
}
// 序列埠監看：和 Arduino IDE 一樣，開啟時 DTR 讓板子重新啟動（Optiboot 等約 1 秒沒有上傳 → 執行程式），收到的位元組全部保留
async function monitor(s) {
  const port = DL.transport.wsSerialPort(s.url); await port.open();
  await port.setSignals({ dataTerminalReady: false, requestToSend: false }); await port.setSignals({ dataTerminalReady: true, requestToSend: true });
  const rd = port.readable.getReader(); const bytes = [];
  const loop = (async () => { for (;;) { let x; try { x = await rd.read(); } catch (e) { break; } if (x.done) break; for (const b of x.value) bytes.push(b); } })();
  return { port, bytes, text: () => Buffer.from(bytes).toString('utf8'), async close() { try { await rd.cancel(); } catch (e) { } await loop; await port.close(); } };
}
// 程式開始執行的設備時間：最後一次看門狗重置（Optiboot 逾時或上傳完成後離開，都以看門狗重置跳到應用程式）
async function appStart(s, after) { const t = await until(async () => { const x = await s.trace(); const r = x.resets.filter(r => r.flags === 8 && r.devMs > after); return r.length ? r[r.length - 1].devMs : null; }, 8000); assert.ok(t !== null, '程式沒有開始執行'); return t; }

test('經網路上傳（不需要 arduino-cli）：StandardFirmata 寫入虛擬 Uno、讀回一致，設備識別改成「上傳的程式」；再上傳 DofLabFirmata，DofLab 可以照常連線同步', { timeout: 120000 }, async () => {
  const s = await server();
  try {
    let st = await s.state(); assert.strictEqual(st.firmware.name, 'DofLabFirmata'); assert.strictEqual(st.firmware.bootloader, 'Optiboot'); assert.strictEqual(st.uploads, 0);
    const a = await upload(s, STANDARD);
    assert.ok(a.r.ok && a.r.verified, JSON.stringify(a.r)); assert.strictEqual(a.r.device, 'ATmega328P');
    assert.ok(a.logs.some(l => /1e 95 0f/.test(l)), '經網路讀到 ATmega328P 簽章');
    assert.strictEqual(a.prog.filter(p => p.phase === 'verify').length, a.r.pages, '每一頁都讀回比對');
    st = await until(async () => { const x = await s.state(); return x.uploads === 1 && x; });
    assert.ok(st, '設備偵測到上傳完成'); assert.strictEqual(st.firmware.name, '上傳的程式'); assert.strictEqual(st.firmware.uploaded, true);
    const tr = await s.trace(); assert.ok(tr.trace.some(e => e.part === 'chip' && e.action === 'upload'), '工作台紀錄有上傳事件');
    const flags = tr.resets.map(r => r.flags); assert.ok(flags.includes(2) && flags[flags.length - 1] === 8, 'DTR（外部重置）進入開機程式，看門狗重置離開：' + flags.join(','));
    // StandardFirmata 也回答 Firmata：DofLab 會連上，但辨識出不是 DofLabFirmata（不是假裝成功）
    const twin = DL.createTwin(); const drv = new DL.drivers.FirmataDriver(twin, { log: () => { }, onLost: w => twin.disconnected(w) }, 'uno');
    let r = await drv.connect({ url: s.url }).catch(e => ({ error: e.message }));
    assert.ok(r.error || !/DofLabFirmata/.test(r.info), '連線結果沒有把 StandardFirmata 當成 DofLabFirmata：' + JSON.stringify(r).slice(0, 300));
    await drv.disconnect().catch(() => { }); await wait(200);
    // 想同步：把 DofLabFirmata 上傳回去（和實體板子的操作一樣）
    const b = await upload(s, FIRMATA); assert.ok(b.r.ok && b.r.verified);
    st = await until(async () => { const x = await s.state(); return x.uploads === 2 && x; }); assert.strictEqual(st.firmware.name, 'DofLabFirmata'); assert.strictEqual(st.firmware.uploaded, true);
    const twin2 = DL.createTwin(); const drv2 = new DL.drivers.FirmataDriver(twin2, { log: () => { }, onLost: w => twin2.disconnected(w) }, 'uno');
    r = await drv2.connect({ url: s.url }); assert.ok(r.virtual && /DofLabFirmata/.test(r.info), JSON.stringify(r));
    await drv2.disconnect();
  } finally { await s.close(); }
});

// 從收到的位元組找出完整的韌體名稱訊息（F0 79 主版 次版 名稱… F7）；被打斷的（中途出現別的命令位元組）不算
function firmwareNames(bytes) {
  const out = [];
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] !== 0xF0 || bytes[i + 1] !== 0x79) continue;
    let k = i + 4, cut = false; const name = [];
    for (; k + 1 < bytes.length && bytes[k] !== 0xF7; k += 2) { if (bytes[k] & 0x80 || bytes[k + 1] & 0x80) { cut = true; break; } name.push(bytes[k] | (bytes[k + 1] << 7)); }
    if (!cut && bytes[k] === 0xF7) out.push(String.fromCharCode(...name));
  }
  return out;
}
test('韌體名稱的解析：上電開機訊息被 DTR 重置打斷時，只取完整的那一則（GitHub CI 實際收到的位元組）', () => {
  const name = 'DofLabFirmata'; const enc = [...name].flatMap(c => [c.charCodeAt(0), 0]);
  const full = [0xF9, 2, 6, 0xF0, 0x79, 1, 1, ...enc, 0xF7];
  const cut = [0xF9, 2, 6, 0xF0, 0x79, 1, 1, ...enc.slice(0, 16)];   // 「DofLabFi」之後被打斷
  assert.deepStrictEqual(firmwareNames(cut.concat(full)), [name]);
  assert.deepStrictEqual(firmwareNames(cut), []);
});

test('序列埠監看（不需要 arduino-cli）：開啟時 DTR 讓虛擬 Uno 重新啟動，等 Optiboot 逾時後程式開機輸出的位元組經網路送回', { timeout: 60000 }, async () => {
  const s = await server();
  try {
    const m = await monitor(s);
    // DofLabFirmata 開機會主動送出版本（F9）與韌體名稱（F0 79 … F7）。連線得很早時，可能先收到上電開機訊息的前半段、
    // 接著 DTR 重置把它打斷（和實體 Uno 一樣），所以只看完整的韌體名稱訊息
    const ok = await until(() => firmwareNames(m.bytes).some(n => /DofLabFirmata/.test(n)), 6000);
    const hex = m.bytes.slice(0, 40).map(b => b.toString(16)).join(' ');
    assert.ok(ok, '收到完整的開機訊息（韌體名稱 DofLabFirmata）：' + hex);
    const tr = await s.trace(); const fl = tr.resets.map(r => r.flags); const why = '重置紀錄：' + JSON.stringify(tr.resets) + '；收到的位元組：' + hex;
    assert.deepStrictEqual(fl.slice(-2), [2, 8], 'DTR 重置（EXTRF）→ Optiboot 等待逾時 → 看門狗重置（WDRF）執行程式。' + why);
    assert.ok(tr.resets[tr.resets.length - 1].devMs - tr.resets[tr.resets.length - 2].devMs > 500, 'Optiboot 等了約 1 秒才執行程式（和實體 Uno 一樣）。' + why);
    await m.close();
  } finally { await s.close(); }
});

test('排定在設備時間的工作台操作：時間已過時拒絕；排定的操作在那個設備時間執行', { timeout: 30000 }, async () => {
  const s = await server();
  try {
    const now = (await s.state()).devMs;
    assert.match((await s.act({ part: 'BTN1', action: 'press', atDevMs: now - 100 })).error || '', /已經過了/);
    const at = now + 400.5; const r = await s.act({ part: 'BTN1', action: 'press', atDevMs: at }); assert.strictEqual(r.scheduled, at);
    const e = await until(async () => (await s.trace()).trace.find(x => x.part === 'BTN1' && x.action === 'press'), 4000);
    assert.ok(e && e.devMs >= at && e.devMs < at + 0.1, JSON.stringify(e));
  } finally { await s.close(); }
});

/* ---------- 驗收：所有支援 Uno 的引導實驗 ---------- */
function buildAsync(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-vup-')); const sk = path.join(dir, 'sketch'); fs.mkdirSync(sk);
  fs.writeFileSync(path.join(sk, 'sketch.ino'), code);
  const props = (process.env.DOFLAB_ARDUINO_PROPS || '').split(';').filter(Boolean).flatMap(p => ['--build-property', p]);
  return new Promise((res, rej) => execFile('arduino-cli', ['compile', '--fqbn', 'arduino:avr:uno', ...props, '--output-dir', path.join(dir, 'out'), sk], { maxBuffer: 16 << 20 }, (e, so, se) => e ? rej(new Error(se || e.message)) : res(fs.readFileSync(path.join(dir, 'out', 'sketch.ino.hex'), 'utf8'))));
}
// 工作台照專案的接線擺（按鈕不彈跳、光敏沒有雜訊、超音波不掉回波：這裡比的是程式行為，彈跳與雜訊另有測試）
function benchFor(p) {
  const B = DL.netlist.analyze(p).bindings; const parts = [];
  for (const c of p.components) {
    const b = B[c.id]; if (!b) continue;
    if (DL.behavior.BUTTONS.includes(c.type)) parts.push({ id: c.id, type: 'button', pin: b.num, bounceMs: 0 });
    else if (DL.behavior.LEDS.includes(c.type)) parts.push({ id: c.id, type: 'led', pin: b.num });
    else if (c.type === 'LDR') parts.push({ id: c.id, type: 'ldr', pin: b.num, light: 50, noise: 0 });
    else if (c.type === 'US') parts.push({ id: c.id, type: 'ultrasonic', trig: b.num, echo: b.echoNum, cm: 100, drop: 0 });
    else if (c.type === 'SERVO') parts.push({ id: c.id, type: 'servo', pin: b.num });
  }
  return { id: 'accept-' + p.name, name: '驗收：' + p.name, seed: 1, parts };
}
// 輸入情境（程式開始後的毫秒；都避開超音波每 60 ms 量一次的邊界，見 §4.6 時間）
const SCEN = {
  BTN1: [[315, 'press'], [1815, 'release'], [2335, 'press'], [2495, 'release'], [3025, 'press'], [3625, 'release']],
  BTN2: [[835, 'press'], [1035, 'release'], [2635, 'press'], [2755, 'release']],
  LDR1: [[525, 10], [1525, 85], [2545, 50], [3035, 90], [3625, 20]],
  US1: [[435, 30], [1035, 12], [1735, 5], [2425, 25], [3025, null], [3505, 8]]
};
const RUN_MS = 4300;
const ABC = [['A', { x: 10, y: 6, z: -6 }, 300], ['B', { x: 12, y: 10, z: 0 }, 0], ['C', { x: 8, y: 5, z: 7 }, 700]];
function armProject() {
  const p = DL.experiments.solved('arm-3dof', 'uno').project; const cfg = p.arm.config; const a = DL.netlist.analyze(p);
  p.arm.poses = ABC.map(([name, t, holdMs]) => { const s = DL.arm.ik(cfg, t, [0, 90, 90]); return { name, t, q: s.q, holdMs }; });
  p.arm.confirmed = { hash: DL.hash({ cfg, b: cfg.joints.map(j => a.bindings[j.servo].pin), board: p.board.type }), at: 'test' };
  return p;
}
const usToDeg = us => Math.round((us - 544) * 180 / 1856);   // Servo.write(角度)：544–2400 µs（Arduino Servo 函式庫的預設）
// 介面模擬（引擎；手臂用動作序列規則）：輸入照設備上實際發生的時刻（程式開始後的毫秒，進位到下一個 1 ms 輪）
function simulate(p, inputs, T) {
  const outs = {}; const ser = [];
  if (p.arm && p.arm.poses && p.arm.poses.length) {
    const plan = DL.arm.seqPlan(p.arm); const st = DL.arm.seqStart(plan, 0); const ids = p.arm.config.joints.map(j => j.servo);
    for (let t = 0; t <= T; t++) { DL.arm.seqStep(plan, st, t); DL.arm.seqWritten(st).forEach((v, i) => (outs[ids[i]] = outs[ids[i]] || []).push(v)); }
    return { outs, ser };
  }
  const e = DL.createEngine(p); let k = 0;
  for (let t = 0; t <= T; t++) {
    while (k < inputs.length && Math.ceil(inputs[k].t) <= t) { const x = inputs[k++]; if (x.action === 'press' || x.action === 'release') e.setButton(x.part, x.action === 'press'); else if ('light' in x) e.setLightPercent(x.part, x.light); else if ('cm' in x) e.setDistance(x.part, x.cm); }
    const r = e.tick(t); for (const [id, v] of Object.entries(r.out)) (outs[id] = outs[id] || []).push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
    for (const ev of r.events || []) if (ev.kind === 'serial') ser.push({ t, text: ev.text });
  }
  return { outs, ser };
}
// LED：亮滅轉換的次數、方向都相同，時刻相差 ≤ 3 ms
function compareLed(id, dev, sim) {
  const st = []; let pv = sim[0]; for (let t = 1; t < sim.length; t++) if (sim[t] !== pv) { st.push([t, sim[t]]); pv = sim[t]; }
  if (sim[0]) st.unshift([0, 1]);
  assert.strictEqual(dev.length, st.length, `${id} 轉換次數：設備 ${dev.length}（${dev.map(x => x[0].toFixed(1) + (x[1] ? '↑' : '↓')).join(' ')}）、模擬 ${st.length}（${st.map(x => x[0] + (x[1] ? '↑' : '↓')).join(' ')}）`);
  let worst = 0; dev.forEach((d, i) => { assert.strictEqual(d[1], st[i][1], `${id} 第 ${i + 1} 次轉換方向`); worst = Math.max(worst, Math.abs(d[0] - st[i][0])); });
  assert.ok(worst <= 3, `${id} 最大時刻差 ${worst.toFixed(1)} ms`);
  return { n: dev.length, worst };
}
// 伺服：設備每 20 ms 一個脈衝，脈寬換回角度；每個脈衝的角度要等於模擬在前 22 ms 內出現過的命令角（相差 ≤ tol）；
// 模擬中維持 ≥ 40 ms 的每個角度，設備都要出現
function compareServo(id, dev, sim, tol) {
  tol = tol || 1;
  assert.ok(dev.length > 0, `${id} 沒有收到伺服脈衝`);
  for (const [t, deg] of dev) {
    const lo = Math.max(0, Math.floor(t) - 22), hi = Math.min(sim.length - 1, Math.ceil(t) + 2);
    let ok = false; for (let k = lo; k <= hi && !ok; k++) ok = Math.abs(Math.round(sim[k]) - deg) <= tol;
    assert.ok(ok, `${id} 在 ${t.toFixed(1)} ms 的脈衝是 ${deg}°，模擬在 ${lo}–${hi} ms 是 ${[...new Set(sim.slice(lo, hi + 1).map(Math.round))].join('／')}°`);
  }
  let runStart = 0;
  for (let t = 1; t <= sim.length; t++) {
    if (t < sim.length && Math.round(sim[t]) === Math.round(sim[runStart])) continue;
    const v = Math.round(sim[runStart]);
    if (t - runStart >= 40 && t < sim.length - 30) assert.ok(dev.some(([dt, d]) => Math.abs(d - v) <= tol && dt >= runStart - 3 && dt <= t + 22), `${id} 模擬在 ${runStart}–${t} ms 維持 ${v}°，設備沒有出現`);
    runStart = t;
  }
  return { n: dev.length, tol };
}
// 已知差異（設計提案，未修改產生器）：產生的 Uno 程式每一輪迴圈才看一次 ECHO（不用 pulseIn，避免整個程式停住），
// 在真實時序的晶片上回波寬度會量短或量長一輪迴圈，距離約有一半的機率少 1 cm；模擬是理想值。
// 門檻規則用的距離都離門檻 ≥ 2 cm，不受影響；「距離 → 角度」的連續對應（servoMap）容許 1 cm 對應的角度。
function servoTol(p, id) {
  let tol = 1;
  for (const r of p.behavior.ir.rules || []) for (const a of r.actions || []) if (a.type === 'servoMap' && a.comp === id && DL.project.findComp(p, a.src).type === 'US') tol = Math.max(tol, Math.ceil(Math.abs(a.outMax - a.outMin) / Math.abs(a.inMax - a.inMin)) + 1);
  return tol;
}
async function runOnDevice(p, hex, opts) {
  opts = opts || {};
  const s = await server(benchFor(p));
  try {
    const up = await upload(s, hex); assert.ok(up.r.ok && up.r.verified, '上傳：' + JSON.stringify(up.r));
    await until(async () => (await s.state()).uploads === 1);
    const before = (await s.trace(true)).devMs;
    const m = await monitor(s); const t0 = await appStart(s, before);
    // 輸入情境：排定在設備時間（程式開始後的毫秒＋0.5）
    for (const [part, steps] of Object.entries(SCEN)) {
      if (!p.components.some(c => c.id === part) || !benchFor(p).parts.some(x => x.id === part)) continue;
      for (const [t, v] of steps) {
        const q = part.startsWith('BTN') ? { part, action: v } : part.startsWith('LDR') ? { part, action: 'set', light: v } : { part, action: 'set', cm: v };
        const r = await s.act(Object.assign(q, { atDevMs: t0 + t + 0.5 })); assert.ok(!r.error, r.error);
      }
    }
    await until(async () => (await s.state()).devMs > t0 + RUN_MS + 50, RUN_MS * 3 + 5000);
    const tr = await s.trace(); const text = m.text(); await m.close();
    const ev = tr.trace.filter(e => e.devMs >= t0 && e.devMs <= t0 + RUN_MS).map(e => Object.assign({}, e, { t: e.devMs - t0 }));
    return { ev, text, firmware: tr.firmware };
  } finally { await s.close(); }
}
function compareAll(p, dev) {
  const inputs = dev.ev.filter(e => e.action && e.part !== 'chip');
  const sim = simulate(p, inputs, RUN_MS); const res = {};
  for (const c of p.components) {
    if (!sim.outs[c.id]) continue;
    if (DL.behavior.LEDS.includes(c.type)) res[c.id] = compareLed(c.id, dev.ev.filter(e => e.part === c.id && 'on' in e).map(e => [e.t, e.on ? 1 : 0]), sim.outs[c.id]);
    else if (c.type === 'SERVO') res[c.id] = compareServo(c.id, dev.ev.filter(e => e.part === c.id && 'us' in e).map(e => [e.t, usToDeg(e.us)]), sim.outs[c.id], servoTol(p, c.id));
  }
  return { res, sim };
}

const UNO_EXPS = DL.experiments.list.filter(e => (e.boards || []).includes('uno')).map(e => e.id);
test('驗收：所有支援 Uno 的引導實驗，產生的程式經網路上傳到虛擬 Uno 後，輸出（LED、伺服）和介面模擬一致', { skip: !hasCli && '沒有 arduino-cli', timeout: 1800000 }, async t => {
  assert.ok(UNO_EXPS.length >= 15, '支援 Uno 的引導實驗：' + UNO_EXPS.join('、'));
  const projects = Object.fromEntries(UNO_EXPS.map(id => [id, id === 'arm-3dof' ? armProject() : solved(id, 'uno')]));
  // 先平行編譯（每次 4 個），再逐一上傳比對
  const hexes = {}; const ids = [...UNO_EXPS];
  await Promise.all(Array.from({ length: 4 }, async () => { while (ids.length) { const id = ids.shift(); const g = DL.codegen.generate(projects[id]); assert.ok(g.ok, id + '：' + (g.blockers || []).join('；')); hexes[id] = await buildAsync(g.code); } }));
  for (const id of UNO_EXPS) {
    await t.test(id, async () => {
      const p = projects[id]; const dev = await runOnDevice(p, hexes[id]);
      assert.strictEqual(dev.firmware.name, '上傳的程式');
      const { res } = compareAll(p, dev);
      assert.ok(Object.keys(res).length > 0, '有比對到輸出');
      // 每個實驗的輸出都要真的有變化（不是兩邊都一直不動）
      assert.ok(Object.values(res).some(r => r.n > 1), '輸出有變化：' + JSON.stringify(res));
      console.log(`# ${id}：` + Object.entries(res).map(([k, r]) => `${k} ${r.n} 次${r.worst !== undefined ? `（最大差 ${r.worst.toFixed(1)} ms）` : r.tol > 1 ? `（容許 ±${r.tol}°＝超音波 1 cm）` : ''}`).join('，'));
    });
  }
});

test('序列埠輸出：Serial.println 的文字經網路送回，內容與順序和介面模擬的序列埠監看相同', { skip: !hasCli && '沒有 arduino-cli', timeout: 300000 }, async () => {
  const p = solved('hold-blink', 'uno');
  p.behavior.ir.rules.push({ type: 'start', actions: [{ type: 'print', text: 'DofLab 準備好了' }] },
    { type: 'event', event: 'press', comp: 'BTN1', actions: [{ type: 'print', text: '按下' }] },
    { type: 'event', event: 'release', comp: 'BTN1', actions: [{ type: 'print', text: '放開' }] });
  confirm(p);
  const g = DL.codegen.generate(p); assert.ok(g.ok, (g.blockers || []).join('；')); assert.match(g.code, /Serial\.println/);
  const dev = await runOnDevice(p, await buildAsync(g.code));
  const { sim } = compareAll(p, dev);
  const lines = dev.text.split(/\r?\n/).filter(Boolean);
  assert.deepStrictEqual(lines, sim.ser.map(x => x.text), '設備送回的文字：' + JSON.stringify(dev.text));
  assert.strictEqual(lines.length, 1 + 3 * 2, '開機一行＋按下放開三次');
});
