/* DofLab — 三自由度機械手臂：運動學、限位、連續性、限速與伺服映射
 *
 * 關節：J1 底座水平旋轉（yaw）、J2 肩（仰角，相對水平）、J3 肘（彎曲角，相對上臂）
 * 座標：公分；Y 向上；手臂底座在原點。J1 = 0° 朝 +X，正角逆時針（俯視）。
 * 正向運動學：
 *   r = L1·cos(q2) + L2·cos(q2 − q3)
 *   y = H + L1·sin(q2) + L2·sin(q2 − q3)
 *   x = r·cos(q1)，z = −r·sin(q1)
 *   q3 > 0 表示「手肘在上」（肘關節高於肩到末端的連線）
 *
 * 尺寸、角度範圍與速度都是可調整的教學假設，不是 SG90 原廠 CAD、力矩或安全規格。
 * 運動學可達 ≠ 機構安全可動：碰撞、負載與力矩沒有在這裡檢查。
 */
(function (root) {
  const DL = (root.DL = root.DL || {});
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;

  function defaultConfig() {
    return {
      version: 1,
      H: 7.0, L1: 8.0, L2: 8.0,            // 公分：肩軸高度、上臂、前臂（教學假設）
      floorY: 0.5,                          // 末端不得低於桌面上方 0.5 cm
      maxSpeed: 90,                         // 每個關節最大角速度（°/s），也是畫面動畫的限速
      maxJump: 45,                          // 單次目標移動若需要任一關節跳超過此角度，視為「換解翻轉」並拒絕
      joints: [
        { id: 'J1', name: '底座', min: -90, max: 90, servo: 'SERVO1', zero: 90, dir: 1 },
        { id: 'J2', name: '肩', min: 15, max: 165, servo: 'SERVO2', zero: 0, dir: 1 },
        { id: 'J3', name: '肘', min: 0, max: 150, servo: 'SERVO3', zero: 170, dir: -1 }
      ]
    };
  }

  function fk(cfg, q) {
    const [q1, q2, q3] = q.map(a => a * D2R);
    const r = cfg.L1 * Math.cos(q2) + cfg.L2 * Math.cos(q2 - q3);
    const y = cfg.H + cfg.L1 * Math.sin(q2) + cfg.L2 * Math.sin(q2 - q3);
    const elbowR = cfg.L1 * Math.cos(q2), elbowY = cfg.H + cfg.L1 * Math.sin(q2);
    return {
      x: r * Math.cos(q1), y, z: -r * Math.sin(q1),
      elbow: { x: elbowR * Math.cos(q1), y: elbowY, z: -elbowR * Math.sin(q1) },
      shoulder: { x: 0, y: cfg.H, z: 0 }
    };
  }

  const wrap = a => { a = ((a + 180) % 360 + 360) % 360 - 180; return a; };
  const inLimits = (cfg, q) => q.every((a, i) => a >= cfg.joints[i].min - 1e-6 && a <= cfg.joints[i].max + 1e-6);
  const violations = (cfg, q) => q.map((a, i) => (a < cfg.joints[i].min - 1e-6 || a > cfg.joints[i].max + 1e-6) ? i : -1).filter(i => i >= 0);

  // 回傳所有幾何解（yaw 正向／翻轉 × 手肘上／下），不檢查限位
  function candidates(cfg, t, prevQ1) {
    const rH = Math.hypot(t.x, t.z), dy = t.y - cfg.H;
    const out = [];
    const singular = rH < 1e-3;             // 目標在底座正上方：yaw 不確定，沿用原角度（靠近軸線時的大幅轉動由 maxJump 攔下）
    const yaw0 = singular ? prevQ1 : Math.atan2(-t.z, t.x) * R2D;
    for (const flip of [false, true]) {
      const q1 = wrap(yaw0 + (flip ? 180 : 0)); const r = flip ? -rH : rH;
      const d2 = r * r + dy * dy, d = Math.sqrt(d2);
      const c = (d2 - cfg.L1 * cfg.L1 - cfg.L2 * cfg.L2) / (2 * cfg.L1 * cfg.L2);
      if (c > 1 + 1e-9 || c < -1 - 1e-9) continue;
      const base = Math.acos(Math.max(-1, Math.min(1, c)));   // 兩連桿方向的夾角
      for (const s of [1, -1]) {
        const a = s * base;                 // a = q3（手肘彎曲）
        const q2 = Math.atan2(dy, r) + Math.atan2(cfg.L2 * Math.sin(a), cfg.L1 + cfg.L2 * Math.cos(a));
        out.push({ q: [q1, q2 * R2D, a * R2D], flip, elbowUp: a >= 0, singular });
      }
    }
    return out;
  }

  // 逆運動學：選「在限位內、離目前姿態最近」的解；需要大幅翻轉時拒絕
  function ik(cfg, t, prev) {
    prev = prev || [0, 90, 90];
    const rH = Math.hypot(t.x, t.z), dy = t.y - cfg.H, d = Math.hypot(rH, dy);
    if (t.y < cfg.floorY) return { ok: false, reason: 'floor', msg: `目標高度 ${t.y.toFixed(1)} cm 低於桌面安全高度 ${cfg.floorY} cm。` };
    if (d > cfg.L1 + cfg.L2 + 1e-6) return { ok: false, reason: 'far', msg: `太遠：距肩軸 ${d.toFixed(1)} cm，超過最大伸展 ${(cfg.L1 + cfg.L2).toFixed(1)} cm。` };
    if (d < Math.abs(cfg.L1 - cfg.L2) - 1e-6) return { ok: false, reason: 'near', msg: `太近：距肩軸 ${d.toFixed(1)} cm，小於最小距離 ${Math.abs(cfg.L1 - cfg.L2).toFixed(1)} cm。` };
    const all = candidates(cfg, t, prev[0]);
    const valid = all.filter(c => inLimits(cfg, c.q));
    if (!valid.length) {
      const v = all.map(c => violations(cfg, c.q)).sort((a, b) => a.length - b.length)[0] || [];
      const names = v.map(i => `${cfg.joints[i].id} ${cfg.joints[i].name}`).join('、');
      return { ok: false, reason: 'limit', msg: `幾何上可到達，但會超出關節範圍：${names}。`, joints: v };
    }
    const cost = c => c.q.reduce((s, a, i) => s + Math.abs(wrap(a - prev[i])) * (i === 0 ? 1.2 : 1), 0);
    valid.sort((a, b) => cost(a) - cost(b));
    const best = valid[0];
    const jump = Math.max(...best.q.map((a, i) => Math.abs(wrap(a - prev[i]))));
    return { ok: true, q: best.q.map(a => Math.round(a * 100) / 100), jump, elbowUp: best.elbowUp, flip: best.flip, singular: best.singular, alternatives: valid.length };
  }

  // 拖曳時的連續目標：小步移動卻需要大跳 → 換解翻轉，預設拒絕
  function ikContinuous(cfg, t, prev, opts) {
    const r = ik(cfg, t, prev);
    if (r.ok && r.jump > cfg.maxJump && !(opts && opts.allowJump)) return { ok: false, reason: 'flip', msg: `需要讓關節瞬間轉 ${r.jump.toFixed(0)}°（換解翻轉），已拒絕。可改用數值輸入確認，或先移到中間點。`, solution: r };
    return r;
  }

  // 限速：每個關節以 maxSpeed（°/s）逼近目標
  function stepToward(cur, target, dtMs, maxSpeed) {
    const lim = maxSpeed * dtMs / 1000;
    let moving = false;
    const next = cur.map((a, i) => { const d = target[i] - a; if (Math.abs(d) <= lim) return target[i]; moving = true; return a + Math.sign(d) * lim; });
    return { q: next, moving };
  }

  // 關節角 ↔ 伺服命令角（0–180°）
  const toServo = (cfg, q) => q.map((a, i) => { const j = cfg.joints[i]; return Math.round(j.zero + j.dir * a); });
  const fromServo = (cfg, s) => s.map((v, i) => { const j = cfg.joints[i]; return (v - j.zero) / j.dir; });

  function validateConfig(cfg) {
    const e = [];
    for (const k of ['H', 'L1', 'L2']) if (!(cfg[k] > 0 && cfg[k] < 100)) e.push(`${k} 必須介於 0–100 cm。`);
    if (!(cfg.maxSpeed >= 5 && cfg.maxSpeed <= 600)) e.push('最大角速度必須介於 5–600 °/s。');
    cfg.joints.forEach(j => {
      if (!(j.min < j.max)) e.push(`${j.id} 的下限必須小於上限。`);
      if (![1, -1].includes(j.dir)) e.push(`${j.id} 的方向必須是 +1 或 −1。`);
      for (const a of [j.min, j.max]) { const s = j.zero + j.dir * a; if (s < -0.01 || s > 180.01) e.push(`${j.id} 在 ${a}° 時伺服命令為 ${s.toFixed(0)}°，超出 0–180°：請調整零位、方向或範圍。`); }
    });
    return e;
  }

  // 工作空間（給畫面畫可達範圍）：在桌面高度的最小、最大水平半徑
  function reachAtHeight(cfg, y) {
    const dy = y - cfg.H, max = cfg.L1 + cfg.L2, min = Math.abs(cfg.L1 - cfg.L2);
    const rMax = max > Math.abs(dy) ? Math.sqrt(max * max - dy * dy) : 0;
    const rMin = min > Math.abs(dy) ? Math.sqrt(min * min - dy * dy) : 0;
    return { rMin, rMax };
  }

  /* ---------- 行為序列：開始執行 → 預備姿態 → A → B → C →（回到預備姿態）→ 反覆 ----------
   * 模擬與產生的程式用同一套規則（每 1 ms 一輪、每個關節限速、到位後停留、32 位元浮點數），
   * 讓畫面上的動作和板子上跑的程式一樣。角度都是伺服命令角（0–180°）。 */
  const HOME_T = { x: 10, y: 8, z: 0 };   // 預備姿態（手臂頁「回到預備姿態」也是這個點）
  const HOLD_MIN = 0, HOLD_MAX = 60000, HOLD_DEFAULT = 1000;
  const holdOf = v => (Number.isFinite(+v) ? Math.max(HOLD_MIN, Math.min(HOLD_MAX, Math.round(+v))) : HOLD_DEFAULT);
  function homeQ(cfg) { const s = ik(cfg, HOME_T, [0, 90, 90]); return s.ok ? s.q : [0, 90, 90]; }
  function seqOptions(arm) { const q = (arm && arm.seq) || {}; return { returnHome: q.returnHome !== false, loop: q.loop !== false, homeHoldMs: holdOf(q.homeHoldMs === undefined ? HOLD_DEFAULT : q.homeHoldMs) }; }
  function seqPlan(arm) {
    const cfg = arm.config; const o = seqOptions(arm); const home = toServo(cfg, homeQ(cfg));
    const way = (arm.poses || []).map(ps => ({ name: ps.name, s: toServo(cfg, ps.q), hold: holdOf(ps.holdMs === undefined ? HOLD_DEFAULT : ps.holdMs), t: ps.t }));
    if (way.length && o.returnHome) way.push({ name: '預備姿態', s: home, hold: o.homeHoldMs, t: HOME_T, home: true });
    return { way, home, loop: o.loop, maxSpeed: cfg.maxSpeed, opts: o };
  }
  const f32 = Math.fround;
  // cur：開始時的伺服角（預設＝預備姿態，等同板子上電）；now：毫秒
  function seqStart(plan, now, cur) { return { cur: (cur || plan.home).map(f32), idx: 0, holding: false, holdStart: 0, last: now || 0, done: !plan.way.length, loops: 0 }; }
  function seqStep(plan, st, now) {
    const step = f32(f32(f32(plan.maxSpeed) * f32(now - st.last)) / 1000); st.last = now;
    if (st.done) return st;
    const w = plan.way[st.idx]; let arrived = true;
    for (let i = 0; i < 3; i++) {
      const d = f32(w.s[i] - st.cur[i]);
      if (d > step) { st.cur[i] = f32(st.cur[i] + step); arrived = false; }
      else if (d < -step) { st.cur[i] = f32(st.cur[i] - step); arrived = false; }
      else st.cur[i] = f32(w.s[i]);
    }
    if (arrived && !st.holding) { st.holding = true; st.holdStart = now; }
    if (st.holding && now - st.holdStart >= w.hold) {
      st.holding = false; st.idx++;
      if (st.idx >= plan.way.length) { st.loops++; if (plan.loop) st.idx = 0; else { st.idx = plan.way.length - 1; st.done = true; } }
    }
    return st;
  }
  const seqWritten = st => st.cur.map(v => Math.floor(v + 0.5));   // 與 C++ 的 (int)(x + 0.5) 相同（角度不為負）

  DL.arm = { defaultConfig, fk, ik, ikContinuous, candidates, stepToward, toServo, fromServo, validateConfig, reachAtHeight, inLimits, wrap, HOME_T, homeQ, seqOptions, seqPlan, seqStart, seqStep, seqWritten, holdOf };
  if (typeof module !== 'undefined') module.exports = DL;
})(typeof globalThis !== 'undefined' ? globalThis : this);
