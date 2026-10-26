/* DofLab — 訊號測試與波形比較的資料（V2.14），和畫面、設備無關（瀏覽器與 Node 共用）
 * 1. 訊號測試的數值：每次寫入都換一個值，螢幕與示波器上才看得出變化。
 *    鋸齒（ramp）：由 min 每次 +step，超過 max 時先寫 max、下一次回到 min；三角（triangle）：來回，兩端都會寫到；
 *    方波（square）：max、min 交替（第一次寫 max）。每一次寫入有序號（seq，從 1 開始）。
 *    種類：servo（命令角度 0–180°，SG90 沒有回授）、pwm（工作週期 0–255）、digital（數位輸出，只有方波：亮、滅交替）。
 * 2. 波形紀錄：每一筆是 { t（Date.now 的毫秒）, k（「元件|層」，層是 sim 模擬、cmd 命令、meas 量測）, v（0–1，已經換算） }；
 *    標記（訊號測試的寫入）是 { t, seq, comp, text }。擷取＝某段時間的紀錄（含開始時各線的值），可以存檔、之後再開來比較。
 */
(function (root) {
  const DL = root.DL = root.DL || {};

  /* ---------- 訊號測試的數值 ---------- */
  const KINDS = {
    servo: { label: '伺服角度（命令）', unit: '°', lo: 0, hi: 180, patterns: ['ramp', 'triangle', 'square'], def: { pattern: 'ramp', min: 0, max: 180, step: 10 } },
    pwm: { label: 'PWM 工作週期', unit: '／255', lo: 0, hi: 255, patterns: ['ramp', 'triangle', 'square'], def: { pattern: 'ramp', min: 0, max: 255, step: 15 } },
    digital: { label: '數位輸出', unit: '', lo: 0, hi: 1, patterns: ['square'], def: { pattern: 'square', min: 0, max: 1, step: 1 } }
  };
  const PATTERNS = { ramp: '鋸齒（遞增，到頂回起點）', triangle: '三角（來回）', square: '方波（兩個值交替）' };
  const MIN_INTERVAL_MS = 20, MAX_INTERVAL_MS = 60000;

  function validate(cfg) {
    const K = KINDS[cfg && cfg.kind]; if (!K) return { ok: false, msg: `不支援的種類 ${cfg && cfg.kind}` };
    if (!K.patterns.includes(cfg.pattern)) return { ok: false, msg: `${K.label}只能用${K.patterns.map(p => PATTERNS[p].split('（')[0]).join('、')}` };
    const { min, max, step } = cfg;
    if (![min, max, step].every(Number.isFinite)) return { ok: false, msg: '起點、終點、每次變化都要是數字' };
    if (min < K.lo || max > K.hi || min >= max) return { ok: false, msg: `${K.label}的範圍要在 ${K.lo}–${K.hi}${K.unit}，而且起點小於終點` };
    if (cfg.kind !== 'digital' && step <= 0) return { ok: false, msg: '每次變化要大於 0' };
    return { ok: true };
  }
  function create(cfg) {
    const c = Object.assign({}, cfg); const g = { cfg: c, seq: 0, v: null, dir: 1 };
    g.next = () => {
      const p = g.v; let v;
      if (g.seq === 0) v = c.pattern === 'square' ? c.max : c.min;
      else if (c.pattern === 'square') v = p === c.max ? c.min : c.max;
      else if (c.pattern === 'ramp') v = p >= c.max ? c.min : Math.min(c.max, p + c.step);
      else {   // 三角：兩端都會寫到
        if ((g.dir > 0 && p >= c.max) || (g.dir < 0 && p <= c.min)) g.dir = -g.dir;
        v = Math.max(c.min, Math.min(c.max, p + g.dir * c.step));
      }
      g.v = v; g.seq++; return { seq: g.seq, v };
    };
    return g;
  }
  const sequence = (cfg, n) => { const g = create(cfg); return Array.from({ length: n }, () => g.next().v); };

  /* ---------- 波形紀錄與擷取 ---------- */
  const FORMAT = 'doflab-wave', VERSION = 1;
  // 換算成 0–1（畫圖用）；ctype 是元件類型，sig 是訊號名的後半（state、pwm、angle…）
  function norm(ctype, sig, v) {
    if (v === null || v === undefined) return null;
    if (sig === 'pwm') return Math.max(0, Math.min(1, v / 255));
    if (ctype === 'SERVO') return v / 180;
    if (ctype === 'LDR') return v / 100;
    if (ctype === 'US') return Math.min(1, v / 200);
    return v ? 1 : 0;
  }
  // 某段時間 [t0, t1] 的紀錄：init 是開始時每條線的值（t0 之前最後一筆），evs 是這段時間內的變化
  function slice(evs, t0, t1) {
    const init = {}; const out = [];
    for (const e of evs) { if (e.t < t0) init[e.k] = e.v; else if (e.t <= t1) out.push(e); else break; }
    return { init, evs: out };
  }
  function capture(rec, t0, t1, meta) {
    const s = slice(rec.evs, t0, t1);
    return { t0, t1, span: t1 - t0, meta: Object.assign({}, meta), rows: (meta && meta.rows) || [], init: s.init, evs: s.evs, marks: rec.marks.filter(m => m.t >= t0 && m.t <= t1) };
  }
  function toFile(caps, info) { return { format: FORMAT, version: VERSION, savedAt: new Date().toISOString(), info: info || {}, captures: caps }; }
  function fromFile(o) {
    if (!o || o.format !== FORMAT) return { ok: false, msg: '這不是 DofLab 的波形擷取檔' };
    if (o.version > VERSION) return { ok: false, msg: `波形擷取檔的版本 ${o.version} 比這個 DofLab 新，請更新 DofLab` };
    const caps = {};
    for (const k of ['A', 'B']) { const c = o.captures && o.captures[k]; if (c && Array.isArray(c.evs) && Number.isFinite(c.span)) caps[k] = c; }
    if (!Object.keys(caps).length) return { ok: false, msg: '檔案裡沒有擷取' };
    return { ok: true, captures: caps, info: o.info || {} };
  }

  DL.testsig = { KINDS, PATTERNS, MIN_INTERVAL_MS, MAX_INTERVAL_MS, validate, create, sequence };
  DL.wave = { FORMAT, VERSION, norm, slice, capture, toFile, fromFile };
  if (typeof module !== 'undefined') module.exports = DL;
})(typeof globalThis !== 'undefined' ? globalThis : this);
