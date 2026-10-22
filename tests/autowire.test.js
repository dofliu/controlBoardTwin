// 接線助手：建議下一條線、自動完成、保留接對的線、指出接錯的線、指定腳位、補元件、麵包板
const test = require('node:test'); const assert = require('node:assert');
const { DL } = require('./helpers');
const P = DL.project; const AW = DL.autowire;
const bind = p => { const a = DL.netlist.analyze(p); return Object.fromEntries(Object.entries(a.bindings).flatMap(([k, b]) => b.role === 'ultrasonic' ? [[k, b.trig], [k + '.ECHO', b.echo]] : [[k, b.pin]])); };
const errors = p => DL.netlist.analyze(p).issues.filter(i => i.level === 'error').map(i => i.msg);

test('所有引導實驗 × 三種板型：從沒有接線自動完成，檢查沒有錯誤，腳位與實驗建議相同', () => {
  for (const e of DL.experiments.list) for (const b of DL.boardList) {
    const r = DL.experiments.instantiate(e.id, b); if (!r.ok) continue;
    const p = r.project; const before = p.connections.length;
    const res = AW.apply(p, {});
    assert.deepStrictEqual(errors(p), [], `${e.id}/${b}`);
    assert.ok(res.plan.done, `${e.id}/${b} 計畫應該已完成：` + JSON.stringify(res.plan.issues));
    assert.ok(p.connections.length > before);
    const sg = e.suggest[b]; const bd = bind(p);
    for (const [id, want] of Object.entries(sg)) assert.strictEqual(bd[id], want.split('（')[0], `${e.id}/${b} ${id}`);
    assert.ok(p.lock.components, '引導實驗仍然鎖定元件');
  }
});

test('一步一步：每次只接一條線並附說明；接到最後和一次完成的結果相同', () => {
  const p = DL.experiments.instantiate('hold-blink', 'uno').project; const q = P.clone(p);
  const steps = [];
  for (let i = 0; i < 20; i++) { const n0 = p.connections.length; const r = AW.apply(p, {}, 1); if (!r.done.length) break; assert.strictEqual(p.connections.length, n0 + 1); assert.ok(r.done[0].why.length > 8); steps.push(r.done[0]); }
  assert.strictEqual(steps.length, 5);
  assert.match(steps.map(s => s.why).join('\n'), /內建上拉[\s\S]*限流電阻[\s\S]*陽極（長腳）[\s\S]*陰極（短腳）/);
  AW.apply(q, {});
  const norm = x => x.connections.map(w => [P.epKey(w.a), P.epKey(w.b)].sort().join('~')).sort();
  assert.deepStrictEqual(norm(p), norm(q));
});

test('保留接對的線、沿用接了一半的腳位；接錯的線只指出，勾選後才移除', () => {
  const p = DL.experiments.instantiate('hold-blink', 'uno').project;
  P.addConnection(p, { comp: 'board', term: 'D4' }, { comp: 'BTN1', term: '2' });   // 學生自己接了 D4（另一側）
  const keep = JSON.stringify(p.connections[0]);
  AW.apply(p, {});
  assert.strictEqual(JSON.stringify(p.connections[0]), keep); assert.strictEqual(bind(p).BTN1, 'D4'); assert.deepStrictEqual(errors(p), []);
  const q = DL.experiments.instantiate('hold-blink', 'uno').project;
  P.addConnection(q, { comp: 'board', term: 'D13' }, { comp: 'LED1', term: 'A' });   // 少了限流電阻
  const pl = AW.plan(q, {});
  assert.deepStrictEqual(pl.wrong, ['W1']); assert.strictEqual(pl.steps.length, 0); assert.match(pl.issues[0].msg, /W1/);
  assert.strictEqual(q.connections.length, 1, '沒有勾選就不動學生的線');
  const r = AW.apply(q, { fixWrong: true });
  assert.strictEqual(r.done[0].kind, 'remove'); assert.ok(!q.connections.some(w => w.id === 'W1'));
  assert.deepStrictEqual(errors(q), []); assert.strictEqual(DL.netlist.analyze(q).bindings.LED1.via[0], 'R1');
});

test('老師指定腳位：照指定接；不相容或已占用時改用建議腳位並說明', () => {
  const p = DL.experiments.instantiate('hold-blink', 'esp32').project;
  P.findComp(p, 'LED1').prefPin = 'GPIO21'; P.findComp(p, 'BTN1').prefPin = 'GPIO34';   // GPIO34 只能輸入、沒有上拉
  const pl = AW.plan(p, {});
  assert.ok(pl.issues.some(i => i.comp === 'BTN1' && /GPIO34|IO34/.test(i.msg)));
  AW.apply(p, {}); const b = bind(p);
  assert.strictEqual(b.LED1, 'GPIO21'); assert.strictEqual(b.BTN1, 'GPIO4');
  assert.strictEqual(P.inputsHash(p, 'x'), P.inputsHash(Object.assign(P.clone(p), {}), 'x'));
});

test('補上缺少的元件：只有 LED 時加一顆電阻；在麵包板上就插進麵包板；三顆伺服加外部電源；鎖定時不加', () => {
  let p = P.create('uno'); P.addComponent(p, 'LED', { x: 8, z: 0 }, 0);
  assert.ok(AW.plan(p, {}).issues.some(i => /限流電阻/.test(i.msg)));
  AW.apply(p, { addParts: true }); assert.ok(P.findComp(p, 'R1')); assert.deepStrictEqual(errors(p), []); assert.deepStrictEqual(DL.netlist.analyze(p).bindings.LED1.via, ['R1']);
  p = P.create('uno'); P.addComponent(p, 'BB', { x: 12, z: 0 }, 0); const L = P.addComponent(p, 'LED', { x: 0, z: 0 }, 0).comp; DL.experiments.placeOn(p, L.id, 'BB1', 'e20');
  AW.apply(p, { addParts: true });
  assert.ok(DL.breadboard.mountOf(p, 'R1'), '電阻插在麵包板上'); assert.deepStrictEqual(errors(p), []);
  const a = DL.netlist.analyze(p); assert.ok(a.nets.some(n => n.gnd.length && (n.bb || []).some(b => b.bus === 'TN')), 'GND 走 − 電源排');
  p = P.create('esp32'); for (let i = 0; i < 3; i++) P.addComponent(p, 'SERVO', { x: 9, z: -5 + i * 5 }, 0);
  AW.apply(p, { addParts: true }); assert.ok(P.findComp(p, 'PSU1')); assert.deepStrictEqual(errors(p), []);
  const g = DL.experiments.instantiate('hold-blink', 'uno').project; g.components = g.components.filter(c => c.id !== 'R1');
  const pl = AW.plan(g, { addParts: true }); assert.ok(pl.issues.some(i => /鎖定/.test(i.msg))); assert.ok(!pl.steps.some(s => s.kind === 'part'));
});

test('做不到的明確說明：Pi 沒有 ADC 不能接光敏模組；麵包板導通條沒有空孔', () => {
  const p = P.create('pi4b'); P.addComponent(p, 'LDR', { x: 8, z: 0 }, 0);
  assert.ok(AW.plan(p, {}).issues.some(i => i.level === 'error' && /ADC/.test(i.msg)));
  const q = P.create('uno'); P.addComponent(q, 'BB', { x: 12, z: 0 }, 0);
  const L = P.addComponent(q, 'LED', { x: 0, z: 0 }, 0).comp; DL.experiments.placeOn(q, L.id, 'BB1', 'e20');
  for (const r of ['a', 'b', 'c', 'd']) P.addConnection(q, { comp: 'BB1', term: r + '21' }, { comp: 'BB1', term: 'f' + (r.charCodeAt(0) - 90) });   // 把 21 號 a–d 塞滿
  const pl = AW.plan(q, { addParts: true });
  assert.ok(pl.issues.some(i => /沒有空孔/.test(i.msg)));
});

test('存成引導實驗：學生版沒有導線、鎖定；任務依元件產生；嚴格腳位；解答可以自動接回；可以保存與載入', () => {
  const p = P.create('uno', { name: '老師的專案' });
  P.addComponent(p, 'BB', { x: 12, z: 0 }, 0);
  const led = P.addComponent(p, 'LED', { x: 0, z: 0 }, 0).comp; DL.experiments.placeOn(p, led.id, 'BB1', 'e20');
  P.addComponent(p, 'BTN', { x: 7, z: 3 }, 0);
  p.behavior.ir = { rules: JSON.parse(JSON.stringify(DL.experiments.HOLD_BLINK)) };
  led.prefPin = 'D7';
  // 缺電阻：不能存（解答接不完）
  let r = DL.experiments.fromTeacher(p, { title: 'x' }); assert.strictEqual(r.ok, false); assert.match(r.msg, /電阻/);
  AW.apply(p, { addParts: true });   // 老師用助手補電阻並接好
  r = DL.experiments.fromTeacher(p, { title: '我的實驗', goal: '按住閃爍', strictPins: true });
  assert.ok(r.ok, r.msg);
  const q = r.project;
  assert.strictEqual(q.origin.kind, 'guided'); assert.ok(q.lock.components && q.lock.behavior);
  assert.ok(!q.connections.some(w => w.kind !== 'insert'), '學生版沒有導線');
  assert.ok(DL.breadboard.mountOf(q, 'LED1') && DL.breadboard.mountOf(q, 'R1'), '麵包板上的插件保留');
  assert.ok(!q.components.some(c => c.prefPin), '學生版不帶老師的指定腳位');
  assert.deepStrictEqual(r.custom.pins, { BTN1: 'D2', LED1: 'D7' });
  const back = P.deserialize(P.serialize(q)); assert.ok(back.ok);
  const e = DL.experiments.forProject(back.project); assert.strictEqual(e.title, '我的實驗');
  const ctx = { confirmedCurrent: false, maxHoldMs: 0 };
  const done = s => e.tasks.map(t => !!t.check(s, DL.netlist.analyze(s), ctx));
  assert.deepStrictEqual(done(back.project), [false, false, false, false, false]);
  const sol = P.clone(back.project); AW.apply(sol, {});   // 解答：助手照實驗的腳位接
  assert.deepStrictEqual(done(sol).slice(0, 3), [true, true, true]);
  // 學生接到別的腳位：嚴格模式不算對
  const other = P.clone(back.project); P.findComp(other, 'LED1').prefPin = 'D8'; other.origin = Object.assign({}, other.origin, { custom: Object.assign({}, other.origin.custom, { suggest: {} }) });
  AW.apply(other, {}); assert.strictEqual(DL.netlist.analyze(other).bindings.LED1.pin, 'D8');
  const iLed = e.tasks.findIndex(t => /LED1/.test(t.text)); assert.ok(/D7/.test(e.tasks[iLed].text));
  assert.strictEqual(done(other)[iLed], false, '嚴格腳位：接到 D8 不算對');
  assert.strictEqual(done(sol)[iLed], true);
});
