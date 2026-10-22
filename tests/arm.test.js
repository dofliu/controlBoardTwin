const test = require('node:test'); const assert = require('node:assert');
const { DL } = require('./helpers'); const A = DL.arm;
const cfg = A.defaultConfig();
const near = (a, b, e = 1e-3) => Math.abs(a - b) <= e;
function rnd(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }

test('手臂預設設定合法，伺服命令都在 0–180°', () => { assert.deepStrictEqual(A.validateConfig(cfg), []); });

test('IK→FK 往返：隨機可達點的末端誤差 < 0.01 cm，且都在限位內', () => {
  const r = rnd(7); let n = 0;
  for (let i = 0; i < 3000; i++) {
    const q = [-90 + 180 * r(), 15 + 150 * r(), 150 * r()];
    const p = A.fk(cfg, q); if (p.y < cfg.floorY) continue;
    const s = A.ik(cfg, p, q.map(a => a + 5));
    assert.ok(s.ok, JSON.stringify([q, p, s]));
    const p2 = A.fk(cfg, s.q); assert.ok(near(p.x, p2.x, 0.01) && near(p.y, p2.y, 0.01) && near(p.z, p2.z, 0.01));
    assert.ok(A.inLimits(cfg, s.q)); n++;
  }
  assert.ok(n > 2000);
});

test('不可達：太遠、太近、低於桌面、超出關節範圍，各有明確原因', () => {
  assert.strictEqual(A.ik(cfg, { x: 30, y: 7, z: 0 }).reason, 'far');
  const c2 = Object.assign(A.defaultConfig(), { L2: 4 });
  assert.strictEqual(A.ik(c2, { x: 1, y: 7.5, z: 0 }).reason, 'near');
  assert.strictEqual(A.ik(cfg, { x: 10, y: 0.2, z: 0 }).reason, 'floor');
  const lim = A.ik(cfg, { x: -10, y: 5, z: 0.5 }, [0, 90, 60]);   // 正後方：底座只能 ±90°
  assert.ok(!lim.ok); assert.ok(['limit'].includes(lim.reason), JSON.stringify(lim));
});

test('連續性：沿直線移動目標，關節每步變化都很小（不突然翻轉）', () => {
  let q = A.ik(cfg, { x: 12, y: 4, z: -6 }, [0, 90, 60]).q; let worst = 0;
  for (let i = 0; i <= 400; i++) {
    const t = { x: 12 - 8 * i / 400, y: 4 + 8 * i / 400, z: -6 + 12 * i / 400 };
    const s = A.ikContinuous(cfg, t, q); assert.ok(s.ok, JSON.stringify([t, s]));
    worst = Math.max(worst, ...s.q.map((a, k) => Math.abs(A.wrap(a - q[k])))); q = s.q;
  }
  assert.ok(worst < 3, '最大單步 ' + worst);
});

test('奇異點：目標在底座正上方時保留原本的底座角度', () => {
  const s = A.ik(cfg, { x: 0, y: 15, z: 0.0005 }, [37, 90, 60]);
  assert.ok(s.ok && s.singular); assert.ok(near(s.q[0], 37, 1e-6));
});

test('換解翻轉：底座接近 90° 極限再往外，只剩「往後翻」的解 → 預設拒絕，允許時才接受', () => {
  const at = deg => ({ x: 10 * Math.cos(deg * Math.PI / 180), y: 9, z: -10 * Math.sin(deg * Math.PI / 180) });
  // 預設肘關節只允許「手肘在上」→ 越界時回報限位
  assert.strictEqual(A.ik(cfg, at(95), [85, 60, 100]).reason, 'limit');
  // 若肘關節允許反折，就存在「往後翻」的解；它需要大跳，連續拖曳時要拒絕
  const c2 = A.defaultConfig(); c2.joints[2].min = -150;
  const prev = A.ik(c2, at(85), [80, 90, 60]); assert.ok(prev.ok && Math.abs(prev.q[0] - 85) < 1e-6);
  const c = A.ikContinuous(c2, at(95), prev.q);
  assert.strictEqual(c.ok, false); assert.strictEqual(c.reason, 'flip'); assert.match(c.msg, /換解翻轉/);
  const r = A.ikContinuous(c2, at(95), prev.q, { allowJump: true });
  assert.ok(r.ok && r.flip, '允許時改用往後翻的解'); assert.ok(Math.abs(r.q[0] - (-85)) < 1e-6);
});

test('限速：每個關節以最大角速度逼近目標', () => {
  let q = [0, 90, 60]; const tgt = [90, 30, 120]; let t = 0;
  while (true) { const s = A.stepToward(q, tgt, 20, cfg.maxSpeed); const d = s.q.map((a, i) => Math.abs(a - q[i])); assert.ok(d.every(x => x <= cfg.maxSpeed * 0.02 + 1e-9)); q = s.q; t += 20; if (!s.moving) break; }
  assert.deepStrictEqual(q, tgt); assert.ok(Math.abs(t - 1000) <= 20, '90° @ 90°/s ≈ 1 s，實際 ' + t);
});

test('伺服映射往返、錯誤設定會被指出', () => {
  const q = [30, 60, 45]; const s = A.toServo(cfg, q); assert.deepStrictEqual(s, [120, 60, 125]);
  assert.deepStrictEqual(A.fromServo(cfg, s), q);
  const bad = A.defaultConfig(); bad.joints[2].zero = 90; assert.ok(A.validateConfig(bad).some(m => /超出 0–180/.test(m)));
});
