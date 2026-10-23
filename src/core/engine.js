/* DofLab — 行為引擎（模擬與真機控制共用）
 * 以「明示的時間 t（毫秒）」逐步計算，與產生的 Arduino／Python 程式使用相同的步驟順序：
 *   1. 讀輸入（含去彈跳；超音波每 60 ms 換用上一次的量測結果並再觸發一次）  2. 開始規則（僅第一次）  3. 事件規則  4. 持續規則啟動／結束  5. 合成輸出
 * 產生器的程式碼與此檔逐行對應；修改任何一邊都必須同步修改另一邊並重跑等價測試。
 */
(function (root) {
  const DL = (root.DL = root.DL || {});

  const US_MAX = 400, US_PERIOD = 60;
  function createEngine(p) {
    const rules = JSON.parse(JSON.stringify(p.behavior.ir.rules || []));
    const board = DL.boards[p.board.type];
    const adcMax = board.adcBits ? (1 << board.adcBits) - 1 : 1023;
    const comps = {};
    for (const c of p.components) comps[c.id] = c;

    const st = {
      started: false,
      btn: {}, adc: {}, us: {},
      latched: {}, out: {},
      rule: rules.map(() => ({ active: false, startedAt: 0, offset: 0, mapLast: {} }))
    };
    for (const c of p.components) {
      if (c.type === 'BTN' || c.type === 'BOOT' || c.type === 'TOUCH') st.btn[c.id] = { input: false, lastRaw: false, stable: false, changedAt: 0, debounce: Number(c.params.debounceMs) || 0, press: false, release: false };
      if (c.type === 'LDR') st.adc[c.id] = Math.round(adcMax / 2);
      // 超音波：input＝現在實際的距離；pending＝這一輪正在量的結果；used＝規則使用的值（上一輪量到的）
      if (c.type === 'US') st.us[c.id] = { input: US_MAX, pending: US_MAX, used: US_MAX, due: 0 };
      if (c.type === 'LED' || c.type === 'OBLED') { st.latched[c.id] = 0; st.out[c.id] = 0; }
      if (c.type === 'SERVO') { st.latched[c.id] = Number(c.params.initAngle); st.out[c.id] = Number(c.params.initAngle); }
    }
    const initial = id => (comps[id] && comps[id].type === 'SERVO' ? Number(comps[id].params.initAngle) : 0);

    /* ---- 輸入 ---- */
    function setButton(id, pressed) { if (st.btn[id]) st.btn[id].input = !!pressed; }
    function setLightPercent(id, pct) { if (id in st.adc) st.adc[id] = Math.round(Math.max(0, Math.min(100, pct)) / 100 * adcMax); }
    function setAdcRaw(id, raw) { if (id in st.adc) st.adc[id] = Math.max(0, Math.min(adcMax, Math.round(raw))); }
    // 距離（cm）：小於 2 cm 或超出 400 cm 的量測，和產生的程式一樣處理（超出量程當成 400 cm）
    function setDistance(id, cm) { if (id in st.us) st.us[id].input = cm === null || cm === undefined || !(cm <= US_MAX) ? US_MAX : Math.max(0, Math.floor(cm)); }
    function lightPct(id) { return Math.floor(st.adc[id] * 100 / adcMax); }

    function evalCond(c) {
      if (!c) return false;
      if (c.type === 'pressed') return !!(st.btn[c.comp] && st.btn[c.comp].stable);
      if (c.type === 'light') { if (!(c.comp in st.adc)) return false; const v = lightPct(c.comp); return c.op === 'lt' ? v < c.value : v > c.value; }
      if (c.type === 'distance') { if (!(c.comp in st.us)) return false; const v = st.us[c.comp].used; return c.op === 'lt' ? v < c.value : v > c.value; }
      return false;
    }
    function actionValue(a, rs, t) {
      if (a.type === 'led') return a.on ? 1 : 0;
      if (a.type === 'servo') return a.angle;
      if (a.type === 'blink') { const T = a.onMs + a.offMs; return ((rs.offset + t - rs.startedAt) % T) < a.onMs ? 1 : 0; }
      if (a.type === 'servoMap') return mapDistance(a);
      return null;
    }
    // 與 Arduino 的 map()（長整數、向零截斷）相同；距離先限制在範圍內
    function mapDistance(a) {
      const u = st.us[a.src]; if (!u) return initial(a.comp);
      const d = Math.min(Math.max(u.used, Math.min(a.inMin, a.inMax)), Math.max(a.inMin, a.inMax));
      return a.outMin + Math.trunc((d - a.inMin) * (a.outMax - a.outMin) / (a.inMax - a.inMin));
    }
    function applyInstant(a) {
      if (a.type === 'led') st.latched[a.comp] = a.on ? 1 : 0;
      else if (a.type === 'toggle') st.latched[a.comp] = st.latched[a.comp] ? 0 : 1;
      else if (a.type === 'servo') st.latched[a.comp] = a.angle;
    }

    // 單次動作依序執行；序列埠訊息記成 serial 事件（與產生程式的 Serial.println 順序相同）
    function run(actions, t, events) { for (const a of actions) { if (a.type === 'print') events.push({ t, kind: 'serial', text: a.text }); else applyInstant(a); } }

    /* ---- 單步 ---- */
    function tick(t) {
      const events = [];
      // 1. 讀輸入與去彈跳
      for (const [id, b] of Object.entries(st.btn)) {
        b.press = b.release = false;
        const raw = b.input;
        if (raw !== b.lastRaw) { b.lastRaw = raw; b.changedAt = t; }
        if (raw !== b.stable && t - b.changedAt >= b.debounce) {
          b.stable = raw;
          if (raw) b.press = true; else b.release = true;
          events.push({ t, kind: 'input', comp: id, text: `${id} ${raw ? '按下' : '放開'}（去彈跳後）` });
        }
      }
      for (const u of Object.values(st.us)) if (t >= u.due) { u.due += US_PERIOD; u.used = u.pending; u.pending = u.input; }
      // 2. 開始規則
      if (!st.started) {
        st.started = true;
        rules.forEach((r, i) => { if (r.type === 'start') { events.push({ t, kind: 'rule', rule: i + 1, text: `規則 ${i + 1}：開始時動作` }); run(r.actions, t, events); } });
      }
      // 3. 事件規則
      rules.forEach((r, i) => {
        if (r.type !== 'event') return;
        const b = st.btn[r.comp]; if (!b) return;
        if ((r.event === 'press' && b.press) || (r.event === 'release' && b.release)) {
          events.push({ t, kind: 'rule', rule: i + 1, text: `規則 ${i + 1}：${r.comp} ${r.event === 'press' ? '按下' : '放開'}事件` });
          run(r.actions, t, events);
        }
      });
      // 4. 持續規則
      rules.forEach((r, i) => {
        if (r.type !== 'while') return;
        const rs = st.rule[i];
        const c = evalCond(r.cond);
        if (c && !rs.active) {
          rs.active = true; rs.startedAt = t;
          if (r.restart === 'restart') rs.offset = 0;
          events.push({ t, kind: 'rule', rule: i + 1, text: `規則 ${i + 1}：條件成立，開始作用` });
        } else if (!c && rs.active) {
          for (const a of r.actions) {
            // 保持：伺服跟著距離時保持「上一輪送出的角度」（這一輪的距離已經不在條件範圍內）
            if (r.onEnd === 'keep') { const v = a.type === 'servoMap' ? (a.comp in rs.mapLast ? rs.mapLast[a.comp] : initial(a.comp)) : actionValue(a, rs, t); if (v !== null) st.latched[a.comp] = v; }
            else st.latched[a.comp] = initial(a.comp);
          }
          const blink = r.actions.find(a => a.type === 'blink');
          if (blink) rs.offset = (rs.offset + t - rs.startedAt) % (blink.onMs + blink.offMs);
          rs.active = false;
          events.push({ t, kind: 'rule', rule: i + 1, text: `規則 ${i + 1}：條件結束（${r.onEnd === 'off' ? '回到初始狀態' : '保持最後狀態'}）` });
        }
      });
      // 5. 合成輸出
      const out = Object.assign({}, st.latched);
      rules.forEach((r, i) => {
        if (r.type !== 'while' || !st.rule[i].active) return;
        for (const a of r.actions) { const v = actionValue(a, st.rule[i], t); if (a.type === 'servoMap') st.rule[i].mapLast[a.comp] = v; if (v !== null) out[a.comp] = v; }
      });
      for (const [k, v] of Object.entries(out)) {
        if (st.out[k] !== v) events.push({ t, kind: 'output', comp: k, value: v, text: comps[k] && comps[k].type === 'SERVO' ? `${k} 命令角度 → ${v}°` : `${k} → ${v ? '亮' : '滅'}` });
      }
      st.out = out;
      return { out, events };
    }

    function snapshot() {
      return {
        out: Object.assign({}, st.out),
        buttons: Object.fromEntries(Object.entries(st.btn).map(([k, b]) => [k, { input: b.input, stable: b.stable }])),
        light: Object.fromEntries(Object.keys(st.adc).map(k => [k, lightPct(k)])),
        adc: Object.assign({}, st.adc),
        distance: Object.fromEntries(Object.entries(st.us).map(([k, u]) => [k, u.used])),
        rules: st.rule.map(r => r.active)
      };
    }
    return { tick, setButton, setLightPercent, setAdcRaw, setDistance, snapshot, adcMax };
  }

  DL.createEngine = createEngine;
  if (typeof module !== 'undefined') module.exports = DL;
})(typeof globalThis !== 'undefined' ? globalThis : this);
