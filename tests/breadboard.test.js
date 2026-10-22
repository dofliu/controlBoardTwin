// 麵包板：導通規則、插入、占用、跳線、短路偵測、跟著移動、雜湊、保存
const test = require('node:test'); const assert = require('node:assert');
const { DL, solved } = require('./helpers');
const BB = DL.breadboard; const P = DL.project;

function bbProject(board) {
  const p = P.create(board || 'uno');
  P.addComponent(p, 'BB', { x: 12, z: 0 }, 0);
  return p;
}
function put(p, type, hole, rot) {
  const r = P.addComponent(p, type, { x: 0, z: 0 }, rot || 0);
  DL.experiments.placeOn(p, r.comp.id, 'BB1', hole);
  return r.comp.id;
}

test('孔位與導通條：400 孔；同一號 a–e 相通、f–j 相通、溝槽兩側不通；電源排整條相通', () => {
  assert.strictEqual(BB.HOLES.length, 400);
  assert.strictEqual(new Set(BB.HOLES.map(h => h.id)).size, 400);
  assert.strictEqual(BB.busOf('a10'), BB.busOf('e10'));
  assert.notStrictEqual(BB.busOf('e10'), BB.busOf('f10'));
  assert.notStrictEqual(BB.busOf('a10'), BB.busOf('a11'));
  assert.strictEqual(BB.busOf('TN1'), BB.busOf('TN25'));
  assert.notStrictEqual(BB.busOf('TN1'), BB.busOf('TP1'));
  assert.strictEqual(BB.holesOfBus(BB.busOf('c7')).length, 5);
  assert.strictEqual(BB.holesOfBus('BP').length, 25);
  // 孔距 2.54 mm
  assert.ok(Math.abs(BB.BY_ID.a2.x - BB.BY_ID.a1.x - 0.254) < 1e-9);
  assert.ok(Math.abs(BB.BY_ID.f1.z - BB.BY_ID.e1.z - 3 * 0.254) < 1e-9, '溝槽寬 3 個孔距');
});

test('麵包板版「按住閃爍」：三種板型解答都通過檢查，產生的程式與一般版相同腳位', () => {
  for (const b of ['uno', 'esp32', 'pi4b']) {
    const s = solved('hold-blink-bb', b); const a = DL.netlist.analyze(s);
    assert.ok(a.ok, b + '：' + a.issues.filter(i => i.level === 'error').map(i => i.msg).join('；'));
    const ref = DL.netlist.analyze(solved('hold-blink', b));
    assert.strictEqual(a.bindings.BTN1.pin, ref.bindings.BTN1.pin); assert.strictEqual(a.bindings.LED1.pin, ref.bindings.LED1.pin);
    assert.deepStrictEqual(a.bindings.LED1.via, ['R1']); assert.strictEqual(a.bindings.LED1.mA, ref.bindings.LED1.mA);
    const g = DL.codegen.generate(s); assert.ok(g.ok, (g.blockers || []).join());
  }
});

test('插入：LED 兩腳插在相鄰兩號；轉 90° 兩腳落在同一條 → 偵測為短路', () => {
  const p = bbProject(); const id = put(p, 'LED', 'e18');
  assert.deepStrictEqual(BB.mountOf(p, id).holes.map(h => h.hole).sort(), ['e18', 'e19']);
  const q = bbProject(); const id2 = put(q, 'LED', 'b10', 90);
  const holes = BB.mountOf(q, id2).holes.map(h => h.hole);
  assert.strictEqual(BB.busOf(holes[0]), BB.busOf(holes[1]), '直向插：同一條導通條');
  const a = DL.netlist.analyze(q);
  assert.ok(a.issues.some(i => i.code === 'comp_shorted' && /同一條導通條/.test(i.msg)));
});

test('電阻直插在同一號 → 短路；按鈕必須跨溝槽，轉 90° 插不進去', () => {
  const p = bbProject(); const r = put(p, 'RES', 'a3', 90);   // 轉 90°：兩腳在同一號
  assert.ok(DL.netlist.analyze(p).issues.some(i => i.code === 'comp_shorted' && i.refs.includes(r)));
  const q = bbProject(); const b = P.addComponent(q, 'BTN', { x: 12, z: 0 }, 90).comp.id;
  const f = BB.fit(q, b, 'BB1'); assert.strictEqual(f.ok, false); assert.strictEqual(f.code, 'off_grid'); assert.match(f.msg, /溝槽/);
  // 正確方向：四支腳在 e/f 兩列、兩個號碼；兩側各自是同一個端子
  const id = put(q, 'BTN', 'e5'); const holes = BB.mountOf(q, id).holes;
  assert.deepStrictEqual(holes.filter(h => h.term === '1').map(h => h.hole).sort(), ['e5', 'f5']);
  assert.deepStrictEqual(holes.filter(h => h.term === '2').map(h => h.hole).sort(), ['e7', 'f7']);
});

test('占用：一個孔只能插一支腳或一條線；同一條上的兩孔不能再跳線；插著的元件不能直接接線', () => {
  const p = bbProject(); const led = put(p, 'LED', 'e18');
  const r1 = P.addComponent(p, 'RES', { x: 0, z: 0 }, 0).comp.id;
  const c = DL.project.findComp(p, r1); c.pos = BB.holeWorld(DL.project.findComp(p, 'BB1'), 'e16'); c.pos.x += 2 * 0.254;   // R1 的 1 號腳會落在 e16，2 號腳落在 e20
  const f = BB.fit(p, r1, 'BB1'); assert.ok(f.ok, f.msg);
  // 把 R1 移到 1 號腳在 e17、2 號腳在 e21 的位置 → 不重疊，可插
  // 讓 R1 的 2 號腳撞到 LED 的 A（e18）
  c.pos = BB.holeWorld(DL.project.findComp(p, 'BB1'), 'e14'); c.pos.x += 2 * 0.254;
  const g = BB.fit(p, r1, 'BB1'); assert.strictEqual(g.ok, false); assert.strictEqual(g.code, 'occupied'); assert.match(g.msg, /LED1/);
  let w = P.addConnection(p, { comp: 'board', term: 'D13' }, { comp: 'BB1', term: 'e18' });
  assert.strictEqual(w.ok, false); assert.strictEqual(w.code, 'occupied');
  w = P.addConnection(p, { comp: 'board', term: 'D13' }, { comp: 'BB1', term: 'a18' }); assert.ok(w.ok);
  w = P.addConnection(p, { comp: 'BB1', term: 'b19' }, { comp: 'BB1', term: 'd19' }); assert.strictEqual(w.code, 'same_bus');
  w = P.addConnection(p, { comp: 'BB1', term: 'b19' }, { comp: 'BB1', term: 'TN4' }); assert.ok(w.ok, '跳線到電源排');
  w = P.addConnection(p, { comp: 'board', term: 'GND1' }, { comp: led, term: 'K' }); assert.strictEqual(w.code, 'mounted');
});

test('移動麵包板：插在上面的元件跟著走，網表與輸入雜湊不變；元件拖離就拔出', () => {
  const p = solved('hold-blink-bb', 'uno'); p.lock.components = false;
  const h0 = P.inputsHash(p, 'x'); const led0 = Object.assign({}, DL.project.findComp(p, 'LED1').pos);
  P.moveComponent(p, 'BB1', { x: 20, z: 5 });
  const led = DL.project.findComp(p, 'LED1').pos;
  assert.ok(Math.abs(led.x - led0.x - (20 - 11.6)) < 0.01 && Math.abs(led.z - led0.z - (5 - 0.2)) < 0.01);
  assert.strictEqual(P.inputsHash(p, 'x'), h0);
  P.rotateComponent(p, 'BB1', 90); assert.strictEqual(P.inputsHash(p, 'x'), h0, '旋轉麵包板不改變電路');
  assert.ok(DL.netlist.analyze(p).ok);
  // 重新插入同樣的孔：沒有變化
  assert.strictEqual(BB.settle(p, 'LED1').changed, false);
  // 拖到麵包板外 → 拔出，LED 不再綁定
  P.moveComponent(p, 'LED1', { x: -30, z: -30 }); const st = BB.settle(p, 'LED1');
  assert.ok(st.changed && !st.inserted); assert.ok(!BB.mountOf(p, 'LED1'));
  assert.ok(!DL.netlist.analyze(p).bindings.LED1);
});

test('在同一條導通條上換孔不改變雜湊；換到別號會改變', () => {
  const p = solved('hold-blink-bb', 'uno');
  const h0 = P.inputsHash(p, 'x');
  const w = p.connections.find(w => w.b.term === 'a14' || w.a.term === 'a14'); const side = w.a.term === 'a14' ? 'a' : 'b';
  w[side] = { comp: 'BB1', term: 'b14' }; assert.strictEqual(P.inputsHash(p, 'x'), h0);
  w[side] = { comp: 'BB1', term: 'b13' }; assert.notStrictEqual(P.inputsHash(p, 'x'), h0);
  const a = DL.netlist.analyze(p); assert.ok(!a.bindings.LED1, 'D13 接到 13 號，沒有接到電阻那一號');
});

test('保存／載入保留插件；整線略過插件與跳線且全部成功', () => {
  const p = solved('hold-blink-bb', 'esp32');
  const r = P.deserialize(P.serialize(p)); assert.ok(r.ok);
  assert.deepStrictEqual(DL.netlist.analyze(r.project).bindings, DL.netlist.analyze(p).bindings);
  const rt = DL.routing.route(p);
  assert.deepStrictEqual(rt.failed, []);
  assert.ok(!Object.keys(rt.wires).some(id => id.startsWith('I')), '插件不是導線');
  const jumpers = p.connections.filter(w => w.a.comp === 'BB1' && w.b.comp === 'BB1').map(w => w.id);
  assert.ok(jumpers.length >= 2); for (const j of jumpers) assert.ok(!rt.wires[j]);
});

test('移除麵包板：插件與接到孔的導線一起移除，元件留下但不再綁定', () => {
  const p = solved('hold-blink-bb', 'uno'); p.lock.components = false;
  const r = P.removeComponent(p, 'BB1'); assert.ok(r.ok);
  assert.ok(!p.connections.some(w => w.a.comp === 'BB1' || w.b.comp === 'BB1'));
  assert.ok(DL.project.findComp(p, 'LED1') && !BB.mountOf(p, 'LED1'));
});
