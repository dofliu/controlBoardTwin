/* DofLab — 麵包板（400 孔，半尺寸）
 * 孔位：a–j 列 × 1–30 號，中間有溝槽；上下各兩條電源排（+ 紅、− 藍）。
 * 導通規則（與實物相同）：
 *   - 同一號的 a–e 五個孔相通；f–j 五個孔相通；溝槽兩側不相通。
 *   - 每條電源排整條相通（半尺寸麵包板的電源排不分段）。
 * 元件「插入」麵包板時，每支腳對應一個孔，以 kind:'insert' 的連線記錄在網表裡；
 * 網表分析把孔換成它所屬的導通條（bus），所以插在同一條上的腳會自動相連。
 * 單位：公分；麵包板中心為原點，未旋轉時 1 號在左、a 列在上（−z）。
 */
(function (root) {
  const DL = (root.DL = root.DL || {});
  const P = 0.254;                       // 孔距 2.54 mm
  const COLS = 30, ROWS = 'abcdefghij';
  const TOP = 0.85;                      // 麵包板上表面高度
  const SIZE = { w: 8.26, d: 5.46, t: TOP };
  const ROW_Z = { a: -5.5, b: -4.5, c: -3.5, d: -2.5, e: -1.5, f: 1.5, g: 2.5, h: 3.5, i: 4.5, j: 5.5 };
  const RAILS = { TP: { z: -9, sign: '+', side: '上方' }, TN: { z: -8, sign: '−', side: '上方' }, BP: { z: 8, sign: '+', side: '下方' }, BN: { z: 9, sign: '−', side: '下方' } };
  const RAIL_SLOTS = []; for (let g = 0; g < 5; g++) for (let j = 0; j < 5; j++) RAIL_SLOTS.push(g * 6 + j);   // 5 孔一組，組間空一格

  const HOLES = []; const BY_ID = {};
  for (let c = 1; c <= COLS; c++) for (const r of ROWS) {
    const h = { id: r + c, x: (c - 15.5) * P, z: ROW_Z[r] * P, bus: 'c' + c + (r <= 'e' ? 'a' : 'f'), row: r, col: c };
    HOLES.push(h); BY_ID[h.id] = h;
  }
  for (const [rid, rail] of Object.entries(RAILS)) RAIL_SLOTS.forEach((s, k) => {
    const h = { id: rid + (k + 1), x: (s - 14) * P, z: rail.z * P, bus: rid, rail: rid, n: k + 1 };
    HOLES.push(h); BY_ID[h.id] = h;
  });

  function busOf(holeId) { const h = BY_ID[holeId]; return h ? h.bus : null; }
  function busLabel(bus) {
    if (RAILS[bus]) return `${RAILS[bus].side} ${RAILS[bus].sign} 電源排`;
    const m = /^c(\d+)([af])$/.exec(bus); return m ? `${m[1]} 號 ${m[2] === 'a' ? 'a–e' : 'f–j'}` : bus;
  }
  function holeLabel(id) { const h = BY_ID[id]; if (!h) return id; return h.rail ? `${RAILS[h.rail].side} ${RAILS[h.rail].sign} 電源排第 ${h.n} 孔` : `${h.row}${h.col}`; }
  function holesOfBus(bus) { return HOLES.filter(h => h.bus === bus); }
  function holeAt(x, z, tol) { tol = tol == null ? 0.06 : tol; let best = null, bd = tol; for (const h of HOLES) { const d = Math.hypot(h.x - x, h.z - z); if (d <= bd) { bd = d; best = h; } } return best; }

  const isBB = (p, id) => { const c = DL.project.findComp(p, id); return !!(c && c.type === 'BB'); };
  const toLocal = (bb, x, z) => DL.rotXZ(x - bb.pos.x, z - bb.pos.z, 360 - (bb.rot || 0));
  const toWorld = (bb, x, z) => { const [wx, wz] = DL.rotXZ(x, z, bb.rot || 0); return { x: bb.pos.x + wx, z: bb.pos.z + wz }; };
  function holeWorld(bb, holeId) { const h = BY_ID[holeId]; return h ? toWorld(bb, h.x, h.z) : null; }

  // 這個元件插在哪塊麵包板、哪些孔
  // 插入連線一律是 a = 元件端子、b = 麵包板的孔
  function insertsOf(p, compId) { return p.connections.filter(w => w.kind === 'insert' && w.a.comp === compId); }
  function mountOf(p, compId) {
    const ins = insertsOf(p, compId); if (!ins.length) return null;
    const holes = ins.map(w => ({ term: w.a.term, bb: w.b.comp, hole: w.b.term }));
    return { bb: holes[0].bb, holes };
  }
  function occupant(p, bbId, holeId, exceptComp) {
    for (const w of p.connections) for (const [x, y] of [[w.a, w.b], [w.b, w.a]]) if (x.comp === bbId && x.term === holeId && y.comp !== exceptComp) return { wire: w, other: y };
    return null;
  }

  // 計算把元件插進某塊麵包板的孔位（不修改專案）
  function fit(p, compId, bbId) {
    const c = DL.project.findComp(p, compId); const bb = DL.project.findComp(p, bbId);
    const def = c && DL.components[c.type];
    if (!c || !bb || !def) return { ok: false, msg: '找不到元件或麵包板。' };
    if (!def.bb) return { ok: false, code: 'not_insertable', msg: `${c.id}（${def.name}）不能直接插在麵包板上，請用導線連到孔位。` };
    const offs = [];
    for (const t of def.terminals) for (const o of def.bb.holes[t.id] || []) offs.push({ term: t.id, o });
    const rot = c.rot || 0;
    const W = o => { const [x, z] = DL.rotXZ(o[0] * P, o[1] * P, rot); return { x: c.pos.x + x, z: c.pos.z + z }; };
    // 以第一支腳為基準，吸附到最近的孔
    const w0 = W(offs[0].o); const l0 = toLocal(bb, w0.x, w0.z);
    if (Math.abs(l0[0]) > SIZE.w / 2 + 0.3 || Math.abs(l0[1]) > SIZE.d / 2 + 0.3) return { ok: false, code: 'outside', msg: `${c.id} 不在麵包板範圍內。` };
    const anchor = holeAt(l0[0], l0[1], 0.6);
    if (!anchor) return { ok: false, code: 'no_hole', msg: `${c.id} 附近沒有可插的孔。` };
    const holes = []; const used = new Set();
    for (const { term, o } of offs) {
      const [dx, dz] = DL.rotXZ((o[0] - offs[0].o[0]) * P, (o[1] - offs[0].o[1]) * P, rot);
      const [lx, lz] = DL.rotXZ(dx, dz, 360 - (bb.rot || 0));
      const h = holeAt(anchor.x + lx, anchor.z + lz, 0.03);
      if (!h) return { ok: false, code: 'off_grid', msg: c.type === 'BTN' ? `${c.id} 的四支腳要跨在中間溝槽兩側（e 列與 f 列）；目前的方向或位置放不進去，請旋轉 90° 或移到溝槽上。` : `${c.id} 的腳在這個方向或位置對不到孔，請旋轉或移動一點。` };
      if (used.has(h.id)) return { ok: false, code: 'same_hole', msg: `${c.id} 有兩支腳落在同一個孔。` };
      const occ = occupant(p, bbId, h.id, c.id);
      if (occ) return { ok: false, code: 'occupied', msg: `${holeLabel(h.id)} 已經插了 ${occ.other.comp === 'board' ? '一條導線' : occ.other.comp + (occ.wire.kind === 'insert' ? '' : ' 的導線')}，${c.id} 沒有插入。` };
      used.add(h.id); holes.push({ term, hole: h.id });
    }
    // 讓元件位置與孔位精確對齊
    const aw = toWorld(bb, anchor.x, anchor.z); const [ox, oz] = DL.rotXZ(offs[0].o[0] * P, offs[0].o[1] * P, rot);
    return { ok: true, bb: bbId, holes, pos: { x: r3(aw.x - ox), z: r3(aw.z - oz) } };
  }

  function detach(p, compId) {
    const before = p.connections.length;
    p.connections = p.connections.filter(w => !(w.kind === 'insert' && w.a.comp === compId));
    return before - p.connections.length;
  }
  function attach(p, compId, f) {
    detach(p, compId);
    const c = DL.project.findComp(p, compId); c.pos = f.pos;
    for (const { term, hole } of f.holes) {
      p.counters.I = (p.counters.I || 0) + 1;
      p.connections.push({ id: 'I' + p.counters.I, kind: 'insert', a: { comp: compId, term }, b: { comp: f.bb, term: hole }, color: '#b9bec4' });
    }
  }
  // 元件放下或旋轉後呼叫：在麵包板上就插入；離開麵包板就拔出
  function settle(p, compId) {
    const c = DL.project.findComp(p, compId); if (!c || c.type === 'BB') return { changed: false };
    const was = mountOf(p, compId);
    const boards = p.components.filter(x => x.type === 'BB');
    let fail = null;
    for (const bb of boards) {
      const f = fit(p, compId, bb.id);
      if (f.ok) {
        const same = was && was.bb === f.bb && was.holes.length === f.holes.length && was.holes.every(h => f.holes.some(k => k.term === h.term && k.hole === h.hole));
        attach(p, compId, f);
        return { changed: !same, inserted: true, fit: f, msg: same ? null : `${compId} 已插入 ${f.bb}：${f.holes.map(h => `${h.term}→${holeLabel(h.hole)}`).join('、')}` };
      }
      if (f.code !== 'outside') fail = f;
    }
    const n = detach(p, compId);
    if (fail) return { changed: n > 0, inserted: false, msg: fail.msg, warn: true };
    return { changed: n > 0, inserted: false, msg: n ? `${compId} 已從麵包板拔出。` : null };
  }
  // 麵包板移動／旋轉時，插在上面的元件跟著一起動（孔位不變）
  function carry(p, bbId, fn) {
    const bb = DL.project.findComp(p, bbId); if (!bb) return;
    const riders = p.components.filter(c => { const m = mountOf(p, c.id); return m && m.bb === bbId; }).map(c => ({ c, local: toLocal(bb, c.pos.x, c.pos.z), rot: (c.rot || 0) - (bb.rot || 0) }));
    fn(bb);
    for (const r of riders) { const w = toWorld(bb, r.local[0], r.local[1]); r.c.pos = { x: r3(w.x), z: r3(w.z) }; r.c.rot = (((bb.rot || 0) + r.rot) % 360 + 360) % 360; }
  }
  function r3(v) { return Math.round(v * 1000) / 1000; }

  DL.breadboard = { PITCH: P, COLS, ROWS, TOP, SIZE, RAILS, HOLES, BY_ID, busOf, busLabel, holeLabel, holesOfBus, holeAt, holeWorld, toLocal, toWorld, isBB, mountOf, insertsOf, occupant, fit, attach, detach, settle, carry };
  if (typeof module !== 'undefined') module.exports = DL;
})(typeof globalThis !== 'undefined' ? globalThis : this);
