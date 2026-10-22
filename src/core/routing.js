/* DofLab — 自動整線（只影響外觀，不改變網表）
 * 在俯視平面的網格上用 A* 找正交路徑：
 *   - 避開控制板與元件本體
 *   - 轉角越少越好（轉角懲罰）
 *   - 不和已走好的導線平行重疊（重疊懲罰高；垂直交叉懲罰低）
 *   - 每條線先從腳位／端子「垂直離開」本體，再進入走線區
 * 輸出每條線的轉折點與高度層，3D 場景據此畫出整齊的線束。
 */
(function (root) {
  const DL = (root.DL = root.DL || {});
  const G = 0.25;                 // 網格 2.5 mm
  const COST = { step: 1, turn: 6, parallel: 40, cross: 4, nearObstacle: 0.6, inside: 250 };   // 穿越本體代價極高：能繞就繞，元件擠在一起時仍找得到路

  function rot(x, z, deg) { return DL.rotXZ(x, z, deg); }

  // 元件與控制板在場景中的外框（軸對齊矩形）
  function footprints(p) {
    const out = [];
    const b = DL.boards[p.board.type];
    const bw = b.size.w, bh = b.size.h; const r = ((p.board.rot % 360) + 360) % 360;
    const [W, H] = r === 90 || r === 270 ? [bh, bw] : [bw, bh];
    out.push({ id: 'board', x0: p.board.pos.x - W / 2 - 0.2, x1: p.board.pos.x + W / 2 + 0.2, z0: p.board.pos.z - H / 2 - 0.2, z1: p.board.pos.z + H / 2 + 0.2 });
    for (const c of p.components) {
      const def = DL.components[c.type]; if (!def) continue;
      const f = def.footprint || { w: 1, d: 1 };
      const cr = ((c.rot % 360) + 360) % 360; const [w, d] = cr === 90 || cr === 270 ? [f.d, f.w] : [f.w, f.d];
      const [ox, oz] = rot(f.cx || 0, f.cz || 0, c.rot || 0);
      out.push({ id: c.id, x0: c.pos.x + ox - w / 2 - 0.15, x1: c.pos.x + ox + w / 2 + 0.15, z0: c.pos.z + oz - d / 2 - 0.15, z1: c.pos.z + oz + d / 2 + 0.15 });
    }
    return out;
  }

  // 端點位置與離開方向
  function endpoint(p, ep, fps) {
    if (ep.comp === 'board') {
      const b = DL.boards[p.board.type]; const L = b.layout[ep.term]; if (!L) return null;
      const [x, z] = rot(L.x, L.z, p.board.rot); const pos = { x: p.board.pos.x + x, z: p.board.pos.z + z };
      const [nx, nz] = rot(0, L.side === 'top' ? -1 : 1, p.board.rot);
      const fb = fps.find(f => f.id === 'board');
      const ex = nx ? (nx > 0 ? fb.x1 + 0.35 : fb.x0 - 0.35) : pos.x, ez = nz ? (nz > 0 ? fb.z1 + 0.35 : fb.z0 - 0.35) : pos.z;
      return { pos, exit: { x: ex, z: ez }, dir: [Math.sign(nx), Math.sign(nz)], board: true };
    }
    const c = DL.project.findComp(p, ep.comp); if (!c) return null;
    const def = DL.components[c.type]; const t = def.terminals.find(t => t.id === ep.term); if (!t) return null;
    const w = DL.terminalWorld(c, ep.term); const pos = { x: w.x, z: w.z };
    // 離開方向：端子相對元件中心的主要方向
    // 麵包板的孔：從較近的長邊（上方或下方）離開
    const ex0 = c.type === 'BB' ? [0, t.z < 0 ? -1 : 1] : t.exit || null;
    const [lx, lz] = rot(ex0 ? ex0[0] : (Math.abs(t.x) > Math.abs(t.z) ? Math.sign(t.x) : 0), ex0 ? ex0[1] : (Math.abs(t.x) > Math.abs(t.z) ? 0 : Math.sign(t.z) || 1), c.rot || 0);
    const fc = fps.find(f => f.id === c.id);
    let ex = pos.x, ez = pos.z;
    if (lx) ex = lx > 0 ? Math.max(pos.x, fc.x1) + 0.3 : Math.min(pos.x, fc.x0) - 0.3;
    if (lz) ez = lz > 0 ? Math.max(pos.z, fc.z1) + 0.3 : Math.min(pos.z, fc.z0) - 0.3;
    return { pos, exit: { x: ex, z: ez }, dir: [Math.sign(lx), Math.sign(lz)] };
  }

  // 最小堆積
  class Heap { constructor() { this.a = []; } push(x) { const a = this.a; a.push(x); let i = a.length - 1; while (i) { const j = (i - 1) >> 1; if (a[j][0] <= a[i][0]) break; [a[i], a[j]] = [a[j], a[i]]; i = j; } } pop() { const a = this.a; const top = a[0]; const last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[i], a[m]] = [a[m], a[i]]; i = m; } } return top; } get size() { return this.a.length; } }

  function route(p) {
    const fps = footprints(p);
    const eps = [];
    for (const w of p.connections) {
      if (w.kind === 'insert') continue;                                         // 插在麵包板上的腳不是導線
      if (w.a.comp === w.b.comp && DL.project.isBB(p, w.a.comp)) continue;       // 麵包板上的跳線貼著板面走，不需要繞線
      const a = endpoint(p, w.a, fps), b = endpoint(p, w.b, fps); if (a && b) eps.push({ w, a, b });
    }
    if (!eps.length) return { wires: {}, failed: [], stats: { wires: 0 } };
    // 網格範圍
    const xs = [], zs = [];
    for (const f of fps) { xs.push(f.x0, f.x1); zs.push(f.z0, f.z1); }
    for (const e of eps) { xs.push(e.a.exit.x, e.b.exit.x); zs.push(e.a.exit.z, e.b.exit.z); }
    const X0 = Math.min(...xs) - 3, Z0 = Math.min(...zs) - 3, X1 = Math.max(...xs) + 3, Z1 = Math.max(...zs) + 3;
    const NX = Math.ceil((X1 - X0) / G) + 1, NZ = Math.ceil((Z1 - Z0) / G) + 1, N = NX * NZ;
    const cell = (x, z) => [Math.max(0, Math.min(NX - 1, Math.round((x - X0) / G))), Math.max(0, Math.min(NZ - 1, Math.round((z - Z0) / G)))];
    const blocked = new Uint8Array(N), near = new Uint8Array(N);
    for (const f of fps) {
      const [i0, j0] = cell(f.x0, f.z0), [i1, j1] = cell(f.x1, f.z1);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) blocked[j * NX + i] = 1;
      for (let i = i0 - 1; i <= i1 + 1; i++) for (let j = j0 - 1; j <= j1 + 1; j++) if (i >= 0 && j >= 0 && i < NX && j < NZ) near[j * NX + i] = 1;
    }
    const useH = new Uint16Array(N), useV = new Uint16Array(N);
    const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    // 短的先走：長線繞開短線，整體較整齊
    eps.sort((u, v) => (Math.abs(u.a.exit.x - u.b.exit.x) + Math.abs(u.a.exit.z - u.b.exit.z)) - (Math.abs(v.a.exit.x - v.b.exit.x) + Math.abs(v.a.exit.z - v.b.exit.z)) || (u.w.id < v.w.id ? -1 : 1));
    const wires = {}; const failed = [];
    eps.forEach((e, order) => {
      const [si, sj] = cell(e.a.exit.x, e.a.exit.z), [ti, tj] = cell(e.b.exit.x, e.b.exit.z);
      const S = sj * NX + si, T = tj * NX + ti;
      const dist = new Float64Array(N * 4).fill(Infinity), prev = new Int32Array(N * 4).fill(-1);
      const h = new Heap();
      const startDir = e.a.dir[0] ? (e.a.dir[0] > 0 ? 0 : 1) : (e.a.dir[1] > 0 ? 2 : 3);
      dist[S * 4 + startDir] = 0; h.push([0, S * 4 + startDir, 0]);
      let goal = -1; let guard = 0;
      while (h.size && guard++ < 400000) {
        const [, s, d] = h.pop(); if (d > dist[s]) continue;   // [f, 狀態, g]
        const c = s >> 2, dir = s & 3;
        if (c === T) { goal = s; break; }
        const ci = c % NX, cj = (c / NX) | 0;
        for (let nd = 0; nd < 4; nd++) {
          if ((nd ^ 1) === dir && (nd >> 1) === (dir >> 1)) continue;     // 不回頭
          const ni = ci + DIRS[nd][0], nj = cj + DIRS[nd][1];
          if (ni < 0 || nj < 0 || ni >= NX || nj >= NZ) continue;
          const n = nj * NX + ni;
          const horiz = nd < 2;
          let cost = COST.step + (nd !== dir ? COST.turn : 0) + (near[n] ? COST.nearObstacle : 0) + (blocked[n] && n !== T ? COST.inside : 0);
          cost += (horiz ? useH[n] : useV[n]) * COST.parallel + (horiz ? useV[n] : useH[n]) * COST.cross;
          const nk = n * 4 + nd, ndist = d + cost;
          if (ndist < dist[nk]) { dist[nk] = ndist; prev[nk] = s; h.push([ndist + (Math.abs(ni - ti) + Math.abs(nj - tj)) * COST.step, nk, ndist]); }
        }
      }
      if (goal < 0) { failed.push(e.w.id); return; }
      // 回溯路徑並標記使用
      const cells = []; for (let s = goal; s >= 0; s = prev[s]) cells.push(s); cells.reverse();
      const pts = [];
      for (let k = 0; k < cells.length; k++) {
        const c = cells[k] >> 2, dir = cells[k] & 3;
        if (k > 0) { if (dir < 2) useH[c]++; else useV[c]++; }
        const x = X0 + (c % NX) * G, z = Z0 + ((c / NX) | 0) * G;
        const nextDir = k + 1 < cells.length ? cells[k + 1] & 3 : -1;
        if (k === 0 || k === cells.length - 1 || nextDir !== dir) pts.push({ x: round(x), z: round(z) });
      }
      // 從真正的端點接到網格路徑（端點 → 離開點 → 路徑 → 離開點 → 端點），並對齊成正交
      const full = [e.a.pos, ...orthoJoin(e.a.exit, pts[0]), ...pts, ...orthoJoin(pts[pts.length - 1], e.b.exit), e.b.pos].map(q => ({ x: round(q.x), z: round(q.z) }));
      wires[e.w.id] = { pts: simplify(full), layer: order % 4, order, turns: Math.max(0, simplify(full).length - 2) };
    });
    // 統計：平行重疊格數（越少越好）
    let overlap = 0; for (let n = 0; n < N; n++) { if (useH[n] > 1) overlap += useH[n] - 1; if (useV[n] > 1) overlap += useV[n] - 1; }
    return { wires, failed, stats: { wires: Object.keys(wires).length, overlap, grid: [NX, NZ] }, footprints: fps };
  }
  function orthoJoin(a, b) {
    if (Math.abs(a.x - b.x) < 1e-6 || Math.abs(a.z - b.z) < 1e-6) return [a];
    return [a, { x: b.x, z: a.z }];
  }
  function simplify(pts) {
    const out = [];
    for (const q of pts) {
      if (out.length && Math.abs(out[out.length - 1].x - q.x) < 1e-6 && Math.abs(out[out.length - 1].z - q.z) < 1e-6) continue;
      if (out.length >= 2) { const a = out[out.length - 2], b = out[out.length - 1]; if ((Math.abs(a.x - b.x) < 1e-6 && Math.abs(b.x - q.x) < 1e-6) || (Math.abs(a.z - b.z) < 1e-6 && Math.abs(b.z - q.z) < 1e-6)) { out[out.length - 1] = q; continue; } }
      out.push(q);
    }
    return out;
  }
  function round(v) { return Math.round(v * 1000) / 1000; }

  DL.routing = { route, footprints, endpoint, GRID: G };
  if (typeof module !== 'undefined') module.exports = DL;
})(typeof globalThis !== 'undefined' ? globalThis : this);
