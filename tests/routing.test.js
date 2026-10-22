const test = require('node:test'); const assert = require('node:assert');
const { DL, solved } = require('./helpers'); const P = DL.project;

function inside(fp, q) { return q.x > fp.x0 + 1e-6 && q.x < fp.x1 - 1e-6 && q.z > fp.z0 + 1e-6 && q.z < fp.z1 - 1e-6; }
function segPts(a, b, step = 0.05) { const n = Math.max(1, Math.ceil(Math.hypot(a.x - b.x, a.z - b.z) / step)); return Array.from({ length: n + 1 }, (_, i) => ({ x: a.x + (b.x - a.x) * i / n, z: a.z + (b.z - a.z) * i / n })); }

for (const [exp, board] of [['hold-blink', 'uno'], ['hold-blink', 'pi4b'], ['servo-cmd', 'esp32'], ['night-light', 'uno']]) {
  test(`自動整線（${exp}／${board}）：全部連上、正交、避開本體、沒有平行重疊`, () => {
    const p = solved(exp, board); const r = DL.routing.route(p);
    assert.deepStrictEqual(r.failed, []); assert.strictEqual(r.stats.wires, p.connections.length);
    assert.strictEqual(r.stats.overlap, 0, '平行重疊格數');
    for (const [id, w] of Object.entries(r.wires)) {
      const pts = w.pts; const wire = p.connections.find(x => x.id === id);
      // 中段（離開本體後）全部正交、不穿過任何外框
      for (let i = 1; i < pts.length - 2; i++) {
        const a = pts[i], b = pts[i + 1];
        assert.ok(Math.abs(a.x - b.x) < 1e-6 || Math.abs(a.z - b.z) < 1e-6, `${id} 第 ${i} 段不是正交`);
        for (const q of segPts(a, b)) for (const fp of r.footprints) assert.ok(!inside(fp, q), `${id} 穿過 ${fp.id}`);
      }
      assert.ok(w.turns <= 8, `${id} 轉角 ${w.turns} 太多`);
      const ends = [DL.routing.endpoint(p, wire.a, r.footprints).pos, DL.routing.endpoint(p, wire.b, r.footprints).pos];
      const has = e => [pts[0], pts[pts.length - 1]].some(q => Math.abs(q.x - e.x) < 0.01 && Math.abs(q.z - e.z) < 0.01);
      assert.ok(has(ends[0]) && has(ends[1]), `${id} 端點正確`);
    }
  });
}

test('自動整線：結果固定（相同輸入相同輸出）；移動元件會重算路徑，但網表不變', () => {
  const p = solved('hold-blink', 'uno');
  const a = JSON.stringify(DL.routing.route(p).wires), b = JSON.stringify(DL.routing.route(p).wires);
  assert.strictEqual(a, b);
  const net = JSON.stringify(p.connections); P.moveComponent(p, 'LED1', { x: 12, z: 4 });
  assert.notStrictEqual(JSON.stringify(DL.routing.route(p).wires), a); assert.strictEqual(JSON.stringify(p.connections), net);
});

test('外部 5V 電源：共地、倒灌、多顆伺服由開發板供電', () => {
  const B = t => ({ comp: 'board', term: t }); const E = (c, t) => ({ comp: c, term: t });
  const mk = () => { const p = P.create('uno'); for (let i = 0; i < 3; i++) P.addComponent(p, 'SERVO', { x: 10, z: i * 3 }); return p; };
  let p = mk();
  [9, 10, 11].forEach((pin, i) => { const s = 'SERVO' + (i + 1); P.addConnection(p, B('D' + pin), E(s, 'SIG')); P.addConnection(p, E(s, 'VCC'), B('5V')); P.addConnection(p, E(s, 'GND'), B('GND' + (i + 1))); });
  assert.ok(DL.netlist.analyze(p).issues.some(i => i.code === 'servo_board_supply'), '三顆伺服都由板子供電 → 錯誤');
  p = mk(); P.addComponent(p, 'PSU', { x: 16, z: 0 });
  [9, 10, 11].forEach((pin, i) => { const s = 'SERVO' + (i + 1); P.addConnection(p, B('D' + pin), E(s, 'SIG')); P.addConnection(p, E(s, 'VCC'), E('PSU1', 'VP')); P.addConnection(p, E(s, 'GND'), E('PSU1', 'GND')); });
  let a = DL.netlist.analyze(p);
  assert.ok(a.issues.some(i => i.code === 'psu_no_common_gnd') && a.issues.some(i => i.code === 'servo_no_common_gnd'), '沒有共地');
  P.addConnection(p, E('PSU1', 'GND'), B('GND1'));
  a = DL.netlist.analyze(p); assert.ok(a.ok, a.issues.filter(i => i.level === 'error').map(i => i.msg).join('；'));
  assert.ok(a.issues.some(i => i.code === 'servo_ext_power'));
  P.addConnection(p, E('PSU1', 'VP'), B('5V'));
  assert.ok(DL.netlist.analyze(p).issues.some(i => i.code === 'psu_backfeed'), '外部 +5V 接到板子 5V → 倒灌');
});

test('自動整線：三軸手臂（3 顆伺服＋外部電源，10 條線）三種板型都能全部走通', () => {
  for (const b of ['uno', 'esp32', 'pi4b']) {
    const p = DL.experiments.solved('arm-3dof', b).project; const r = DL.routing.route(p);
    assert.deepStrictEqual(r.failed, [], b); assert.strictEqual(r.stats.wires, 10);
    assert.ok(r.stats.overlap <= 4, `${b} 平行重疊 ${r.stats.overlap} 格（共用同一電源端子的進場段）`);
  }
});
