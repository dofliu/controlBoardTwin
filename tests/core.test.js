const test = require('node:test'); const assert = require('node:assert');
const { execFileSync } = require('child_process'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { DL, confirm, solved, runEngine } = require('./helpers');
const P = DL.project; const B = t => ({ comp: 'board', term: t }); const E = (c, t) => ({ comp: c, term: t });

test('板型能力資料：腳位唯一、排針座標完整、Pi 40 腳', () => {
  for (const id of DL.boardList) {
    const b = DL.boards[id]; const ids = b.pins.map(p => p.id);
    assert.strictEqual(new Set(ids).size, ids.length, id + ' 腳位 id 重複');
    for (const k of Object.keys(b.layout)) assert.ok(b.pinById[k], `${id} 排針 ${k} 沒有腳位資料`);
  }
  assert.strictEqual(Object.keys(DL.boards.pi4b.layout).length, 40);
  assert.ok(!DL.boards.esp32.pinById.GPIO34.caps.includes('dout'), 'ESP32 GPIO34 只能輸入');
  assert.strictEqual(DL.boards.pi4b.adcBits, 0);
});

test('元件識別碼穩定、刪除後不重用；鎖定時不能增刪', () => {
  const p = P.create('uno');
  P.addComponent(p, 'LED', { x: 1, z: 1 }); P.addComponent(p, 'LED', { x: 2, z: 1 });
  P.removeComponent(p, 'LED2');
  assert.strictEqual(P.addComponent(p, 'LED', { x: 3, z: 1 }).comp.id, 'LED3');
  p.lock.components = true;
  assert.strictEqual(P.addComponent(p, 'LED', { x: 0, z: 0 }).ok, false);
  assert.strictEqual(P.removeComponent(p, 'LED1').ok, false);
  assert.strictEqual(P.addComponent(P.create('uno'), 'XYZ', { x: 0, z: 0 }).ok, false, '未知元件不能加入');
});

test('連線：自接、同元件、重複、不存在端點、板對板都被拒絕；刪元件一併刪線', () => {
  const p = P.create('uno'); P.addComponent(p, 'BTN', { x: 5, z: 0 }); P.addComponent(p, 'LED', { x: 7, z: 0 });
  assert.strictEqual(P.addConnection(p, E('BTN1', '1'), E('BTN1', '1')).code, 'self');
  assert.strictEqual(P.addConnection(p, E('LED1', 'A'), E('LED1', 'K')).code, 'same_component');
  assert.strictEqual(P.addConnection(p, B('D2'), B('D3')).code, 'board_board');
  assert.strictEqual(P.addConnection(p, B('D99'), E('BTN1', '1')).code, 'missing');
  assert.ok(P.addConnection(p, B('D2'), E('BTN1', '1')).ok);
  assert.strictEqual(P.addConnection(p, E('BTN1', '1'), B('D2')).code, 'duplicate');
  P.addConnection(p, E('BTN1', '2'), E('LED1', 'K'));
  const r = P.removeComponent(p, 'BTN1');
  assert.deepStrictEqual(r.removedWires.sort(), ['W1', 'W2']); assert.strictEqual(p.connections.length, 0);
});

test('外觀與網表分離：移動／旋轉不改變導通與輸入雜湊', () => {
  const p = solved('hold-blink', 'uno');
  const h0 = P.inputsHash(p, DL.codegen.GENERATOR_VERSION); const a0 = DL.netlist.analyze(p);
  P.moveComponent(p, 'LED1', { x: -20, z: 15 }); P.rotateComponent(p, 'BTN1', 90); P.moveComponent(p, 'board', { x: 4, z: 4 }); P.rotateComponent(p, 'board', 90);
  assert.strictEqual(P.inputsHash(p, DL.codegen.GENERATOR_VERSION), h0);
  assert.deepStrictEqual(DL.netlist.analyze(p).bindings, a0.bindings);
  assert.ok(DL.codegen.generate(p).ok, '仍然是已確認且最新');
});

function circuit(board, wires, comps) {
  const p = P.create(board);
  for (const [t, n] of comps || [['BTN'], ['LED'], ['RES']]) P.addComponent(p, t, { x: 5, z: 0 });
  for (const [a, b] of wires) { const r = P.addConnection(p, a, b); assert.ok(r.ok, r.msg); }
  return DL.netlist.analyze(p);
}
const codes = a => a.issues.map(i => i.level + ':' + i.code);

test('電路檢查：正確接線、缺電阻、LED 反接、重複占用、短路', () => {
  let a = circuit('uno', [[B('D13'), E('R1', '1')], [E('R1', '2'), E('LED1', 'A')], [E('LED1', 'K'), B('GND1')], [B('D2'), E('BTN1', '1')], [E('BTN1', '2'), B('GND2')]]);
  assert.ok(a.ok); assert.strictEqual(a.bindings.LED1.pin, 'D13'); assert.ok(a.bindings.LED1.mA > 10 && a.bindings.LED1.mA < 16);
  a = circuit('uno', [[B('D13'), E('LED1', 'A')], [E('LED1', 'K'), B('GND1')]]);
  assert.ok(codes(a).includes('error:led_no_resistor'));
  a = circuit('uno', [[B('D13'), E('R1', '1')], [E('R1', '2'), E('LED1', 'K')], [E('LED1', 'A'), B('GND1')]]);
  assert.ok(codes(a).includes('error:led_reversed'));
  a = circuit('uno', [[B('D2'), E('R1', '1')], [E('R1', '2'), E('LED1', 'A')], [E('LED1', 'K'), B('GND1')], [B('D2'), E('BTN1', '1')], [E('BTN1', '2'), B('GND2')]]);
  assert.ok(codes(a).includes('error:pin_conflict'));
  a = circuit('uno', [[B('5V'), E('BTN1', '1')], [E('BTN1', '1'), B('GND1')]]);
  assert.ok(codes(a).includes('error:short'));
  a = circuit('uno', [[B('D2'), E('BTN1', '1')], [E('BTN1', '1'), B('GND1')]]);
  assert.ok(codes(a).includes('error:gpio_gnd'));
});

test('電路檢查：電阻太小過電流、電壓與板型能力', () => {
  const p = P.create('uno'); P.addComponent(p, 'LED', { x: 0, z: 0 }); P.addComponent(p, 'RES', { x: 0, z: 0 }); P.setParam(p, 'R1', 'ohms', 47);
  P.addConnection(p, B('D9'), E('R1', '1')); P.addConnection(p, E('R1', '2'), E('LED1', 'A')); P.addConnection(p, E('LED1', 'K'), B('GND1'));
  assert.ok(codes(DL.netlist.analyze(p)).includes('error:overcurrent'));
  // Pi：按鈕接 5V → 過電壓；光敏模組 → 沒有 ADC
  let a = circuit('pi4b', [[B('GPIO27'), E('BTN1', '1')], [E('BTN1', '2'), B('5V_1')]]);
  assert.ok(codes(a).includes('error:overvoltage'));
  a = circuit('pi4b', [[B('GPIO17'), E('LDR1', 'AO')], [E('LDR1', 'VCC'), B('3V3_1')], [E('LDR1', 'GND'), B('GND1')]], [['LDR']]);
  assert.ok(codes(a).includes('error:no_adc'));
  // ESP32：輸入專用腳不能驅動 LED、沒有內建上拉；光敏模組接 5V 超過 ADC 範圍
  a = circuit('esp32', [[B('GPIO34'), E('R1', '1')], [E('R1', '2'), E('LED1', 'A')], [E('LED1', 'K'), B('GND1')], [B('GPIO35'), E('BTN1', '1')], [E('BTN1', '2'), B('GND2')]]);
  assert.strictEqual(a.issues.filter(i => i.code === 'pin_cap').length, 2);
  a = circuit('esp32', [[B('GPIO34'), E('LDR1', 'AO')], [E('LDR1', 'VCC'), B('5V')], [E('LDR1', 'GND'), B('GND1')]], [['LDR']]);
  assert.ok(codes(a).includes('error:overvoltage'));
  // Uno：D0/D1 序列埠提醒
  a = circuit('uno', [[B('D0'), E('BTN1', '1')], [E('BTN1', '2'), B('GND1')]], [['BTN']]);
  assert.ok(a.issues.some(i => i.level === 'warn' && /序列埠/.test(i.msg)));
});

test('型錄外元件標示「未檢查」，不假裝通過', () => {
  const p = P.create('uno'); p.components.push({ id: 'X1', type: 'MYSTERY', params: {}, pos: { x: 0, z: 0 }, rot: 0 });
  const a = DL.netlist.analyze(p); assert.ok(a.issues.some(i => i.level === 'unknown' && i.refs.includes('X1')));
});

test('伺服：只有命令角度、供電提醒；Pi 軟體 PWM 提醒', () => {
  const p = solved('servo-cmd', 'pi4b'); const a = DL.netlist.analyze(p);
  assert.ok(a.ok); assert.ok(codes(a).includes('warn:servo_power')); assert.ok(codes(a).includes('warn:pi_soft_pwm')); assert.ok(codes(a).includes('info:servo_cmd_only'));
});

test('行為驗證：閃爍需要持續條件、切換不能放持續條件、引用不存在或型別錯誤的元件', () => {
  const p = solved('hold-blink', 'uno'); p.lock.behavior = false;
  p.behavior.ir.rules = [{ type: 'event', event: 'press', comp: 'BTN1', actions: [{ type: 'blink', comp: 'LED1', onMs: 500, offMs: 500 }] }];
  assert.ok(DL.behavior.validate(p).issues.some(i => /閃爍.*持續條件/.test(i.msg)));
  p.behavior.ir.rules = [{ type: 'while', cond: { type: 'pressed', comp: 'BTN1' }, actions: [{ type: 'toggle', comp: 'LED1' }], onEnd: 'off', restart: 'restart' }];
  assert.ok(DL.behavior.validate(p).issues.some(i => /切換.*單次/.test(i.msg)));
  p.behavior.ir.rules = [{ type: 'event', event: 'press', comp: 'LED1', actions: [{ type: 'led', comp: 'GHOST', on: true }] }];
  const msgs = DL.behavior.validate(p).issues.map(i => i.msg).join('\n');
  assert.match(msgs, /LED1 是LED/); assert.match(msgs, /GHOST 不在配置中/);
});

test('行為摘要：文件範例的事件、計時、停止與重啟都明示', () => {
  const p = solved('hold-blink', 'uno'); const t = DL.behavior.summarize(p).lines[0].text;
  for (const k of ['BTN1 被按住', '亮 500 ms、暗 500 ms', '1000 ms', '1 Hz', '立即熄滅', '從頭開始（先亮）', '20 ms']) assert.ok(t.includes(k), '摘要缺少：' + k + '\n' + t);
});

test('程式產生：未確認不產生；改接線後確認失效、程式過期', () => {
  const r = DL.experiments.solved('hold-blink', 'uno'); const p = r.project;
  assert.strictEqual(DL.codegen.generate(p).ok, false);
  confirm(p); const g = DL.codegen.generate(p); assert.ok(g.ok);
  P.setParam(p, 'BTN1', 'debounceMs', 30);
  assert.notStrictEqual(P.inputsHash(p, DL.codegen.GENERATOR_VERSION), g.inputs, '參數改變 → 雜湊改變');
  assert.ok(DL.codegen.generate(p).blockers.some(b => /重新確認/.test(b)));
});

test('手改腳位：偵測不一致、無法分析的動態腳位、同步虛擬接線前先檢查相容性', () => {
  const p = solved('hold-blink', 'uno'); const code = DL.codegen.generate(p).code;
  assert.ok(DL.codegen.scanPins(p, code).filter(i => i.level === 'ok').length === 2);
  const edited = code.replace('const int BTN1_PIN = 2;', 'const int BTN1_PIN = 4;');
  const mm = DL.codegen.scanPins(p, edited).find(i => i.level === 'mismatch');
  assert.ok(mm && mm.codePin === 'D4' && mm.netPin === 'D2');
  const dyn = code.replace('const int BTN1_PIN = 2;', 'const int BTN1_PIN = BASE + 2;');
  assert.ok(DL.codegen.scanPins(p, dyn).some(i => i.level === 'unknown' && /無法分析/.test(i.msg)));
  assert.strictEqual(DL.netlist.tryRewire(p, 'BTN1', 'D13').ok, false, 'D13 已被 LED1 使用');
  const r = DL.netlist.tryRewire(p, 'BTN1', 'D4'); assert.ok(r.ok);
  assert.strictEqual(r.after.bindings.BTN1.pin, 'D4');
  // 原專案不被試算改動
  assert.strictEqual(DL.netlist.analyze(p).bindings.BTN1.pin, 'D2');
});

test('Pi 產生的 Python 通過 py_compile', () => {
  for (const e of ['hold-blink', 'servo-cmd']) {
    const code = DL.codegen.generate(solved(e, 'pi4b')).code; const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dlpy-')), 'main.py'); fs.writeFileSync(f, code);
    execFileSync('python3', ['-m', 'py_compile', f]);
  }
});

test('Twin Core：模擬與唯讀時拒絕命令；授權後命令→ACK；重複 ACK 與重複量測被忽略', () => {
  let t = 1000; const tw = DL.createTwin({ now: () => t, staleMs: 2000 });
  tw.define('LED1.state', { feedback: false }); tw.define('BTN1.pressed', { feedback: true });
  assert.strictEqual(tw.command('LED1.state', 1).ok, false);
  assert.strictEqual(tw.setMode('hw-read').ok, false, '沒連線不能進真機模式');
  tw.connected('dev', 'mock'); assert.strictEqual(tw.mode, 'hw-read');
  assert.strictEqual(tw.command('LED1.state', 1).ok, false, '唯讀拒絕命令');
  assert.ok(tw.authorize(['LED1.state']).ok); assert.strictEqual(tw.mode, 'hw-control');
  assert.strictEqual(tw.command('SERVO1.angle', 10).ok, false, '未授權的訊號');
  const c = tw.command('LED1.state', 1).cmd; assert.ok(c);
  assert.ok(tw.command('LED1.state', 1).skipped, '同值在途：不重送');
  assert.strictEqual(tw.view('LED1.state').ack, null, '命令 ≠ 確認');
  assert.ok(tw.ack(c.id, 1).ok); assert.strictEqual(tw.ack(c.id, 1).dup, true);
  assert.strictEqual(tw.view('LED1.state').quality, 'none', 'LED 無回授：量測未知');
  assert.ok(tw.measure('BTN1.pressed', true, { seq: 5 }).ok);
  assert.strictEqual(tw.measure('BTN1.pressed', false, { seq: 5 }).dup, true);
  assert.strictEqual(tw.measure('BTN1.pressed', false, { seq: 4 }).dup, true);
  assert.strictEqual(tw.view('BTN1.pressed').measured.v, true);
  t += 2500; assert.strictEqual(tw.quality('BTN1.pressed'), 'stale', '太久沒收到設備訊息 → 過期');
});

test('Twin Core：斷線作廢未確認命令、不重送；重連從唯讀開始、舊量測過期', () => {
  let t = 0; const tw = DL.createTwin({ now: () => t });
  tw.define('LED1.state', { feedback: false }); tw.define('BTN1.pressed', {});
  tw.connected('dev', 'x'); tw.authorize(['LED1.state']);
  tw.measure('BTN1.pressed', true, { seq: 1 });
  const c = tw.command('LED1.state', 1).cmd;
  const r = tw.disconnected('cable');
  assert.deepStrictEqual(r.dropped.map(x => x.id), [c.id]); assert.strictEqual(tw.pending.length, 0); assert.strictEqual(tw.mode, 'sim');
  assert.strictEqual(tw.quality('BTN1.pressed'), 'stale', '斷線後量測不得冒充最新');
  assert.strictEqual(tw.measure('BTN1.pressed', false, { seq: 2 }).ok, false, '斷線時的量測丟棄');
  tw.connected('dev', 'x');
  assert.strictEqual(tw.mode, 'hw-read'); assert.strictEqual(tw.auth, null);
  assert.strictEqual(tw.pending.length, 0, '沒有自動重播');
  assert.strictEqual(tw.quality('BTN1.pressed'), 'stale', '上一次連線的量測仍標為過期');
  assert.strictEqual(tw.ack(c.id, 1).unknown, true, '舊命令的遲到 ACK 被忽略');
  assert.ok(tw.measure('BTN1.pressed', true, { seq: 1 }).ok, '新連線序號重新計算');
});

test('保存／載入：往返一致、損壞與不相容檔案明確報錯、v1 升級、不恢復即時狀態', () => {
  const p = solved('hold-blink', 'esp32'); p.runtime = { connected: true }; p.telemetry = [{ v: 1 }];
  const r = P.deserialize(P.serialize(p)); assert.ok(r.ok);
  assert.strictEqual(r.project.runtime, undefined); assert.strictEqual(r.project.telemetry, undefined);
  assert.deepStrictEqual(r.project.connections, p.connections);
  assert.match(P.deserialize('{"format": "doflab.project", "formatVersion": 2').msg, /不是有效的 JSON/);
  assert.match(P.deserialize('{"format":"other"}').msg, /不是 DofLab 專案/);
  assert.match(P.deserialize(JSON.stringify(Object.assign({}, p, { formatVersion: 9 }))).msg, /較新的格式 v9/);
  const broken = JSON.parse(P.serialize(p)); broken.connections.push({ id: 'W99', a: { comp: 'NOPE', term: '1' }, b: { comp: 'board', term: 'GND1' } });
  assert.match(P.deserialize(JSON.stringify(broken)).msg, /不存在的元件 NOPE/);
  const v1 = JSON.parse(P.serialize(p)); v1.formatVersion = 1; delete v1.lock; delete v1.builds; v1.connections = v1.connections.map(w => ({ id: w.id, from: w.a, to: w.b }));
  const m = P.deserialize(JSON.stringify(v1)); assert.ok(m.ok); assert.strictEqual(m.project.formatVersion, 2); assert.ok(m.notes.length);
  assert.deepStrictEqual(DL.netlist.analyze(m.project).bindings, DL.netlist.analyze(p).bindings);
});

test('引導實驗：可建立、解答可通過檢查；Pi 不支援光控夜燈', () => {
  for (const e of DL.experiments.list) for (const b of DL.boardList) {
    const r = DL.experiments.instantiate(e.id, b);
    if (!DL.experiments.supports(e, b)) { assert.strictEqual(r.ok, false); assert.match(r.msg, /ADC|BOOT|觸控|LED/); continue; }
    assert.ok(r.project.lock.components && r.project.lock.behavior);
    const s = solved(e.id, b); const a = DL.netlist.analyze(s);
    assert.strictEqual(a.counts.error, 0, `${e.id}/${b}: ` + a.issues.filter(i => i.level === 'error').map(i => i.msg).join(';'));
    if (e.arm) { assert.ok(DL.codegen.generate(s).blockers.some(b => /姿態/.test(b)), '手臂：沒有姿態時不產生程式'); continue; }
    assert.ok(DL.behavior.validate(s, a).ok); assert.ok(DL.codegen.generate(s).ok);
  }
});

test('引擎：非整數步進（5 ms）也與規則一致——放開後下一輪就熄滅', () => {
  const p = solved('hold-blink', 'pi4b'); const e = DL.createEngine(p); const out = [];
  for (let t = 0; t <= 2000; t += 5) { e.setButton('BTN1', t >= 100 && t < 1300); out.push([t, e.tick(t).out.LED1]); }
  const at = t => out.find(x => x[0] === t)[1];
  assert.strictEqual(at(120), 1); assert.strictEqual(at(615), 1); assert.strictEqual(at(620), 0); assert.strictEqual(at(1120), 1); assert.strictEqual(at(1320), 0);
});

test('Twin Core：被新命令取代的舊命令晚到 ACK 時靜默忽略，不覆蓋新狀態', () => {
  const tw = DL.createTwin(); tw.define('LED1.state', { feedback: false }); tw.connected('d', 'x'); tw.authorize(['LED1.state']);
  const c1 = tw.command('LED1.state', 0).cmd; const c2 = tw.command('LED1.state', 1).cmd;
  assert.strictEqual(tw.pending.length, 1);
  assert.ok(tw.ack(c1.id, 0).superseded); assert.strictEqual(tw.view('LED1.state').ack, null);
  assert.ok(tw.ack(c2.id, 1).ok); assert.strictEqual(tw.view('LED1.state').ack.v, 1);
  assert.ok(!tw.log.some(e => e.type === 'warn'));
});
