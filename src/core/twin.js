/* DofLab — Twin Core 狀態核心
 * 每個訊號（例如 LED1.state、BTN1.pressed）分五層保存，彼此不混用：
 *   target     使用者／行為要求的目標值          ≠ 命令已送達
 *   commanded  已經送往設備的控制值              ≠ 設備實際到位
 *   ack        設備回覆已接受（或回讀的暫存值）  ≠ 物理動作完成
 *   measured   感測器或設備回報的讀值            需來源、時間、序號與品質；無回授 = 未知
 *   simulated  軟體模型推算的狀態                斷線時不得冒充量測
 *
 * 模式：sim（模擬）→ hw-read（真機唯讀）→ hw-control（受控寫入，需明確授權）
 * 斷線／過期／重連：量測標為過期；未確認命令列出但「不重送」；重連後回到唯讀，需重新授權。
 */
(function (root) {
  const DL = (root.DL = root.DL || {});

  function createTwin(opts) {
    opts = opts || {};
    const staleMs = opts.staleMs || 2500;
    const clock = opts.now || (() => Date.now());
    const sig = {};
    const listeners = new Set();
    const log = [];
    let mode = 'sim';
    let conn = { state: 'none', deviceId: null, info: null, since: null, lastHeard: null, session: 0 };
    let auth = null;            // { at, outputs:[signal], by }
    let cmdSeq = 0;
    const pending = new Map();  // id → command
    const seenAck = new Set();
    const superseded = new Set();  // 被同一訊號的新命令取代的舊命令
    const lastSeq = {};         // 每個來源的最後序號（去重）
    let dropped = [];           // 斷線時未確認、未重送的命令

    function S(name) {
      return sig[name] || (sig[name] = { name, kind: null, unit: null, feedback: true, target: null, commanded: null, ack: null, measured: null, simulated: null });
    }
    function define(name, meta) { Object.assign(S(name), meta); return S(name); }
    function emit(type, data) { const e = Object.assign({ type, t: clock() }, data); log.push(e); if (log.length > 500) log.shift(); for (const f of listeners) f(e); return e; }

    function setMode(m, why) {
      if (!['sim', 'hw-read', 'hw-control'].includes(m)) throw new Error('未知模式 ' + m);
      if (m !== 'sim' && conn.state !== 'connected') return { ok: false, msg: '沒有連線中的設備，不能切換到真機模式。' };
      if (m === 'hw-control' && !auth) return { ok: false, msg: '尚未授權受控寫入。' };
      const prev = mode; mode = m;
      if (m !== 'hw-control') auth = m === 'hw-read' ? null : auth;
      emit('mode', { from: prev, to: m, why: why || '' });
      return { ok: true };
    }

    /* ---- 模擬層 ---- */
    function simulate(name, v) { S(name).simulated = { v, t: clock() }; }

    /* ---- 目標與命令 ---- */
    function target(name, v, src) { S(name).target = { v, t: clock(), src: src || 'ui' }; }
    function command(name, v, src) {
      const s = S(name);
      if (mode !== 'hw-control') return { ok: false, msg: `目前是「${modeLabel(mode)}」，不會送出任何控制命令。` };
      if (!auth || !auth.outputs.includes(name)) return { ok: false, msg: `${name} 不在授權寫入的清單中。` };
      if (conn.state !== 'connected') return { ok: false, msg: '設備未連線，命令未送出（也不會稍後補送）。' };
      // 同一個值已在途或已確認：不重複送出（行為迴圈每輪都會算一次輸出）
      if (s.commanded && s.commanded.v === v && s.commanded.session === conn.session && (pending.has(s.commanded.id) || (s.ack && s.ack.id === s.commanded.id))) return { ok: true, skipped: true };
      for (const [pid, pc] of pending) if (pc.name === name) { pending.delete(pid); superseded.add(pid); emit('superseded', { id: pid, name, by: cmdSeq + 1 }); }
      const id = `c${conn.session}-${++cmdSeq}`;
      const c = { id, name, v, t: clock(), session: conn.session, src: src || 'behavior' };
      s.commanded = c; pending.set(id, c);
      emit('command', { id, name, v });
      return { ok: true, cmd: c };
    }
    function ack(id, readBack) {
      if (seenAck.has(id)) return { ok: false, dup: true };
      seenAck.add(id);
      const c = pending.get(id);
      if (!c && superseded.has(id)) return { ok: false, superseded: true };   // 已被新命令取代：忽略，不影響目前狀態
      if (!c) { emit('warn', { msg: `收到未知或已作廢的確認 ${id}（可能是斷線前的命令），已忽略。` }); return { ok: false, unknown: true }; }
      pending.delete(id);
      S(c.name).ack = { v: readBack === undefined ? c.v : readBack, id, t: clock(), matches: readBack === undefined || readBack === c.v };
      emit('ack', { id, name: c.name, v: S(c.name).ack.v });
      return { ok: true };
    }

    /* ---- 量測層 ---- */
    function measure(name, v, meta) {
      meta = meta || {};
      const src = meta.src || conn.deviceId || 'device';
      if (meta.seq !== undefined) {
        const key = src + '|' + name;
        if (lastSeq[key] !== undefined && meta.seq <= lastSeq[key]) return { ok: false, dup: true };
        lastSeq[key] = meta.seq;
      }
      if (conn.state !== 'connected') return { ok: false, msg: '未連線時收到的量測已丟棄。' };
      S(name).measured = { v, raw: meta.raw, t: meta.t || clock(), seq: meta.seq, src, session: conn.session };
      conn.lastHeard = clock();
      emit('measure', { name, v, seq: meta.seq });
      return { ok: true };
    }
    function heard() { conn.lastHeard = clock(); }
    function quality(name) {
      const s = S(name);
      if (s.feedback === false) return 'none';      // 元件本身沒有回授
      if (!s.measured) return 'unknown';
      if (s.measured.session !== conn.session || conn.state !== 'connected') return 'stale';
      if (conn.lastHeard && clock() - conn.lastHeard > staleMs) return 'stale';
      return 'ok';
    }

    /* ---- 連線生命週期 ---- */
    // meta.virtual：對方是虛擬設備（不是實體板子）；所有畫面與紀錄都要標示
    function connected(deviceId, info, meta) {
      const virtual = !!(meta && meta.virtual);
      conn = { state: 'connected', deviceId, info: info || null, since: clock(), lastHeard: clock(), session: conn.session + 1, virtual };
      auth = null; pending.clear(); dropped = [];
      for (const k of Object.keys(lastSeq)) delete lastSeq[k];
      mode = 'hw-read';
      emit('connected', { deviceId, info, session: conn.session, virtual });
      emit('mode', { from: 'sim', to: 'hw-read', why: '新連線一律從唯讀開始' });
    }
    function disconnected(reason) {
      if (conn.state !== 'connected') return;
      dropped = [...pending.values()];
      pending.clear();
      conn = Object.assign({}, conn, { state: 'lost', reason: reason || '' });
      const prev = mode; mode = 'sim'; auth = null;
      emit('disconnected', { reason, dropped: dropped.map(c => c.id) });
      emit('mode', { from: prev, to: 'sim', why: '設備斷線' });
      return { dropped };
    }
    function authorize(outputs, check) {
      if (conn.state !== 'connected') return { ok: false, msg: '沒有連線中的設備。' };
      if (check && !check.ok) return { ok: false, msg: check.msg };
      auth = { at: clock(), outputs: outputs.slice(), session: conn.session };
      mode = 'hw-control';
      emit('authorized', { outputs });
      emit('mode', { from: 'hw-read', to: 'hw-control', why: '使用者授權受控寫入' });
      return { ok: true };
    }
    function revoke(why) { if (mode === 'hw-control') { auth = null; mode = 'hw-read'; emit('mode', { from: 'hw-control', to: 'hw-read', why: why || '撤銷授權' }); } }

    function view(name) {
      const s = S(name); return Object.assign({}, s, { quality: quality(name) });
    }
    function reset() { for (const k of Object.keys(sig)) delete sig[k]; pending.clear(); seenAck.clear(); superseded.clear(); log.length = 0; }

    return {
      define, simulate, target, command, ack, measure, heard, quality, view, setMode, connected, disconnected, authorize, revoke, reset,
      get mode() { return mode; }, get conn() { return Object.assign({}, conn); }, get auth() { return auth && Object.assign({}, auth); },
      get pending() { return [...pending.values()]; }, get dropped() { return dropped.slice(); }, get log() { return log.slice(); },
      signals: () => Object.keys(sig), on: f => (listeners.add(f), () => listeners.delete(f))
    };
  }
  function modeLabel(m, virtual) { return (virtual ? { sim: '模擬', 'hw-read': '虛擬設備 · 唯讀', 'hw-control': '虛擬設備 · 受控寫入' } : { sim: '模擬', 'hw-read': '真機唯讀', 'hw-control': '真機受控寫入' })[m] || m; }

  DL.createTwin = createTwin;
  DL.modeLabel = modeLabel;
  if (typeof module !== 'undefined') module.exports = DL;
})(typeof globalThis !== 'undefined' ? globalThis : this);
