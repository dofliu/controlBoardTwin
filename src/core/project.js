/* DofLab — 專案資料模型
 * 原則：場景座標（pos/rot）只描述「放在哪裡」；connections（網表）才描述「誰跟誰相連」。
 * 移動或旋轉元件不會改變任何連線；自由放置的位置也不會被當成電氣導通。
 * 即時狀態（遙測、連線）不屬於專案，不會被保存或還原。
 */
(function (root) {
  const DL = (root.DL = root.DL || {});
  const FORMAT = 'doflab.project';
  const FORMAT_VERSION = 2;
  const WIRE_COLORS = ['#e07a1f', '#2f8f8a', '#7a4fd0', '#c23b5a', '#3a7bd5', '#8a8f2a', '#303438', '#c9452b'];

  /* ---------- 穩定雜湊（FNV-1a 64 → 16 進位） ---------- */
  function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  function hash(v) {
    const s = typeof v === 'string' ? v : stableStringify(v);
    let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
      h2 = (h2 ^ (h2 >>> 13)) >>> 0;
    }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
  }

  function uid() { return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function nowIso() { return new Date().toISOString(); }

  function create(boardId, opts) {
    opts = opts || {};
    const board = DL.boards[boardId];
    if (!board) throw new Error('未知的板型：' + boardId);
    return {
      format: FORMAT, formatVersion: FORMAT_VERSION,
      id: uid(), name: opts.name || '未命名專案', createdAt: nowIso(), updatedAt: nowIso(), revision: 0,
      origin: opts.origin || { kind: 'custom' },
      lock: opts.lock || { components: false, behavior: false, board: false },
      board: { type: boardId, capabilityVersion: board.capabilityVersion, pos: { x: 0, z: 0 }, rot: 0 },
      components: [], connections: [], counters: {},
      behavior: { blocks: null, ir: { rules: [] }, confirmed: null },
      code: { text: '', origin: 'none', basedOnInputs: null, generatorVersion: null },
      builds: [],
      view: { wireStyle: 'neat' },   // 外觀設定（不影響網表與程式）
      arm: null                       // 三自由度手臂（設定、目標、姿態、確認）
    };
  }

  /* ---------- 元件 ---------- */
  function nextId(p, type) {
    const def = DL.components[type];
    const prefix = def ? def.prefix : type;
    p.counters[prefix] = (p.counters[prefix] || 0) + 1;    // 計數只增不減：刪除後不重用識別碼
    return prefix + p.counters[prefix];
  }
  function findComp(p, id) { return p.components.find(c => c.id === id) || null; }

  function addComponent(p, type, pos, rot) {
    if (p.lock.components) return { ok: false, msg: '這個引導實驗鎖定了元件清單；請先「複製為自訂專案」。' };
    if (!DL.components[type]) return { ok: false, msg: `未知的元件型號「${type}」，無法加入。` };
    const c = { id: nextId(p, type), type, model: DL.components[type].model, params: DL.defaultParams(type), pos: { x: round(pos.x), z: round(pos.z) }, rot: norm(rot || 0) };
    p.components.push(c);
    return { ok: true, comp: c };
  }
  function moveComponent(p, id, pos) {
    if (id === 'board') { p.board.pos = { x: round(pos.x), z: round(pos.z) }; return { ok: true }; }
    const c = findComp(p, id); if (!c) return { ok: false, msg: '找不到元件 ' + id };
    if (c.type === 'BB') { DL.breadboard.carry(p, id, bb => { bb.pos = { x: round(pos.x), z: round(pos.z) }; }); return { ok: true }; }   // 插在上面的元件一起移動
    c.pos = { x: round(pos.x), z: round(pos.z) };
    return { ok: true };
  }
  function rotateComponent(p, id, delta) {
    if (id === 'board') { p.board.rot = norm(p.board.rot + (delta || 90)); return { ok: true }; }
    const c = findComp(p, id); if (!c) return { ok: false, msg: '找不到元件 ' + id };
    if (c.type === 'BB') { DL.breadboard.carry(p, id, bb => { bb.rot = norm(bb.rot + (delta || 90)); }); return { ok: true }; }
    c.rot = norm(c.rot + (delta || 90));
    return { ok: true };
  }
  function removeComponent(p, id) {
    if (p.lock.components) return { ok: false, msg: '這個引導實驗鎖定了元件清單；請先「複製為自訂專案」。' };
    const i = p.components.findIndex(c => c.id === id); if (i < 0) return { ok: false, msg: '找不到元件 ' + id };
    p.components.splice(i, 1);
    const removed = p.connections.filter(w => w.a.comp === id || w.b.comp === id).map(w => w.id);
    p.connections = p.connections.filter(w => w.a.comp !== id && w.b.comp !== id);
    return { ok: true, removedWires: removed };
  }
  function setParam(p, id, key, value) {
    const c = findComp(p, id); if (!c) return { ok: false, msg: '找不到元件 ' + id };
    const spec = DL.components[c.type].params[key]; if (!spec) return { ok: false, msg: '沒有參數 ' + key };
    if (spec.type === 'number') {
      const v = Number(value);
      if (!Number.isFinite(v) || v < spec.min || v > spec.max) return { ok: false, msg: `${spec.label}必須介於 ${spec.min} 到 ${spec.max}。` };
      c.params[key] = v;
    } else {
      if (!(value in spec.options)) return { ok: false, msg: '不支援的選項' };
      c.params[key] = value;
    }
    return { ok: true };
  }

  /* ---------- 連線（網表） ---------- */
  function endpointExists(p, ep) {
    if (ep.comp === 'board') return !!DL.boards[p.board.type].pinById[ep.term];
    const c = findComp(p, ep.comp); if (!c) return false;
    return DL.components[c.type].terminals.some(t => t.id === ep.term);
  }
  function isBB(p, id) { const c = findComp(p, id); return !!(c && c.type === 'BB'); }
  function sameEp(a, b) { return a.comp === b.comp && a.term === b.term; }
  function epKey(ep) { return ep.comp + '.' + ep.term; }

  function addConnection(p, a, b, color) {
    if (!endpointExists(p, a) || !endpointExists(p, b)) return { ok: false, code: 'missing', msg: '端點不存在，連線未建立。' };
    if (sameEp(a, b)) return { ok: false, code: 'self', msg: '起點和終點是同一個端子，連線未建立。' };
    const bbA = isBB(p, a.comp), bbB = isBB(p, b.comp);
    if (a.comp === b.comp && bbA) {   // 麵包板上兩孔之間的跳線
      if (DL.breadboard.busOf(a.term) === DL.breadboard.busOf(b.term)) return { ok: false, code: 'same_bus', msg: `${DL.breadboard.holeLabel(a.term)} 與 ${DL.breadboard.holeLabel(b.term)} 本來就在同一條導通條上，不需要跳線。` };
    } else if (a.comp === b.comp && a.comp !== 'board') return { ok: false, code: 'same_component', msg: `兩端都在 ${a.comp} 上，等於把元件自己短路，連線未建立。` };
    for (const [ep, bb] of [[a, bbA], [b, bbB]]) if (bb) { const occ = DL.breadboard.occupant(p, ep.comp, ep.term); if (occ) return { ok: false, code: 'occupied', msg: `${ep.comp} 的 ${DL.breadboard.holeLabel(ep.term)} 已經插了 ${occ.wire.kind === 'insert' ? occ.other.comp + ' 的腳' : '一條導線（' + occ.wire.id + '）'}；一個孔只能插一支腳或一條線，請改插同一條導通條上的其他孔。` }; }
    for (const ep of [a, b]) if (ep.comp !== 'board' && !isBB(p, ep.comp) && DL.breadboard && DL.breadboard.mountOf(p, ep.comp)) return { ok: false, code: 'mounted', msg: `${ep.comp} 插在麵包板上：請把導線插到與這支腳同一條導通條的其他孔。` };
    if (a.comp === 'board' && b.comp === 'board') return { ok: false, code: 'board_board', msg: '兩端都在控制板上；本版不支援板上腳位互接（容易造成短路）。' };
    const dup = p.connections.find(w => (sameEp(w.a, a) && sameEp(w.b, b)) || (sameEp(w.a, b) && sameEp(w.b, a)));
    if (dup) return { ok: false, code: 'duplicate', msg: `已經有同樣的連線（${dup.id}）。` };
    p.counters.W = (p.counters.W || 0) + 1;
    const w = { id: 'W' + p.counters.W, a: { comp: a.comp, term: a.term }, b: { comp: b.comp, term: b.term }, color: color || WIRE_COLORS[(p.counters.W - 1) % WIRE_COLORS.length] };
    p.connections.push(w);
    return { ok: true, wire: w };
  }
  function removeConnection(p, id) {
    const i = p.connections.findIndex(w => w.id === id); if (i < 0) return { ok: false, msg: '找不到連線 ' + id };
    p.connections.splice(i, 1); return { ok: true };
  }
  function setWireColor(p, id, color) {
    const w = p.connections.find(w => w.id === id); if (!w) return { ok: false };
    w.color = color; return { ok: true };
  }
  // 把元件某端子在板子上的那條線，移到另一個板子腳位（同步虛擬接線用）
  function rewireBoardEnd(p, wireId, newPinId) {
    const w = p.connections.find(w => w.id === wireId); if (!w) return { ok: false, msg: '找不到連線' };
    const side = w.a.comp === 'board' ? 'a' : w.b.comp === 'board' ? 'b' : null;
    if (!side) return { ok: false, msg: '這條連線沒有接到控制板。' };
    if (!DL.boards[p.board.type].pinById[newPinId]) return { ok: false, msg: '板子上沒有腳位 ' + newPinId };
    w[side] = { comp: 'board', term: newPinId };
    return { ok: true };
  }

  /* ---------- 版本綁定用的「輸入雜湊」 ---------- */
  // 只要板型、元件型號／參數、網表或行為改變，雜湊就改變 → 舊程式與建置標為過期
  // 刻意不含場景座標：移動元件不應讓程式過期。
  function electricalSnapshot(p) {
    return {
      board: p.board.type, cap: p.board.capabilityVersion,
      comps: p.components.map(c => ({ id: c.id, type: c.type, params: c.params })).sort((x, y) => x.id < y.id ? -1 : 1),
      // 麵包板的孔以導通條表示：在同一條導通條上換個孔插，不算電路改變，程式不會過期
      wires: p.connections.map(w => [elKey(p, w.a), elKey(p, w.b)].sort().join('~')).sort()
    };
  }
  function elKey(p, ep) { return isBB(p, ep.comp) ? ep.comp + '.' + DL.breadboard.busOf(ep.term) : epKey(ep); }
  function inputsHash(p, generatorVersion) {
    return hash({ e: electricalSnapshot(p), ir: p.behavior.ir, gen: generatorVersion || null, arm: p.arm ? { cfg: p.arm.config, poses: (p.arm.poses || []).map(x => x.q) } : null });
  }

  /* ---------- 保存／載入 ---------- */
  function serialize(p) {
    const copy = JSON.parse(JSON.stringify(p));
    copy.updatedAt = nowIso();
    return JSON.stringify(copy, null, 2);
  }
  function deserialize(text) {
    let raw;
    try { raw = JSON.parse(text); } catch (e) { return { ok: false, msg: '檔案不是有效的 JSON：' + e.message + '。原始內容已保留，沒有被修改。' }; }
    if (!raw || typeof raw !== 'object') return { ok: false, msg: '檔案內容不是專案物件。' };
    if (raw.format !== FORMAT) return { ok: false, msg: `不是 DofLab 專案（format = ${JSON.stringify(raw.format)}）。` };
    if (typeof raw.formatVersion !== 'number') return { ok: false, msg: '缺少 formatVersion，無法判斷格式版本。' };
    if (raw.formatVersion > FORMAT_VERSION) return { ok: false, msg: `這個專案是較新的格式 v${raw.formatVersion}，目前版本只支援到 v${FORMAT_VERSION}。請更新 DofLab 後再開啟。` };
    let p = raw; const notes = [];
    if (p.formatVersion === 1) { const r = migrateV1(p); p = r.project; notes.push(...r.notes); }
    const errs = check(p);
    if (errs.length) return { ok: false, msg: '專案內容不完整：' + errs.join('；') + '。原始內容已保留。' };
    // 載入後一律從安全狀態開始：不恢復連線、不帶入遙測、不自動執行硬體動作
    delete p.runtime; delete p.telemetry; delete p.connection;
    p.view = p.view || { wireStyle: 'neat' }; if (p.arm === undefined) p.arm = null;
    return { ok: true, project: p, notes };
  }
  function migrateV1(p) {
    // v1：沒有 lock / builds / code.basedOnInputs；connections 欄位名為 from/to
    const q = JSON.parse(JSON.stringify(p));
    q.formatVersion = 2;
    q.lock = q.lock || { components: false, behavior: false, board: false };
    q.builds = q.builds || [];
    q.code = q.code || { text: '', origin: 'none', basedOnInputs: null, generatorVersion: null };
    q.connections = (q.connections || []).map(w => w.from ? { id: w.id, a: w.from, b: w.to, color: w.color || '#e07a1f' } : w);
    q.behavior = q.behavior || { blocks: null, ir: { rules: [] }, confirmed: null };
    q.counters = q.counters || {};
    return { project: q, notes: ['已從格式 v1 升級為 v2；原檔沒有被覆寫。'] };
  }
  function check(p) {
    const e = [];
    if (!p.board || !DL.boards[p.board.type]) e.push('板型不存在或不支援（' + (p.board && p.board.type) + '）');
    if (!Array.isArray(p.components)) e.push('缺少元件清單');
    if (!Array.isArray(p.connections)) e.push('缺少連線清單');
    if (!p.behavior || !p.behavior.ir || !Array.isArray(p.behavior.ir.rules)) e.push('缺少行為資料');
    if (e.length) return e;
    const ids = new Set();
    for (const c of p.components) {
      if (!c.id || ids.has(c.id)) e.push('元件識別碼重複或缺少：' + c.id);
      ids.add(c.id);
      if (!c.pos || typeof c.pos.x !== 'number') e.push(c.id + ' 缺少位置');
    }
    for (const w of p.connections) {
      if (!w.a || !w.b) { e.push('連線 ' + w.id + ' 缺少端點'); continue; }
      for (const ep of [w.a, w.b]) if (ep.comp !== 'board' && !ids.has(ep.comp)) e.push(`連線 ${w.id} 指向不存在的元件 ${ep.comp}`);
    }
    return e;
  }
  function clone(p, overrides) {
    const q = JSON.parse(JSON.stringify(p));
    q.id = uid(); q.createdAt = nowIso(); q.updatedAt = nowIso(); q.revision = 0;
    Object.assign(q, overrides || {});
    return q;
  }

  function round(v) { return Math.round(v * 100) / 100; }
  function norm(r) { return ((Math.round(r / 90) * 90) % 360 + 360) % 360; }

  DL.project = {
    FORMAT, FORMAT_VERSION, WIRE_COLORS, create, clone, addComponent, moveComponent, rotateComponent, removeComponent, setParam,
    addConnection, removeConnection, setWireColor, rewireBoardEnd, findComp, epKey, sameEp, isBB,
    electricalSnapshot, inputsHash, serialize, deserialize, check
  };
  DL.hash = hash; DL.stableStringify = stableStringify;
  if (typeof module !== 'undefined') module.exports = DL;
})(typeof globalThis !== 'undefined' ? globalThis : this);
