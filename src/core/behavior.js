/* DofLab — 行為中介表示（IR）、驗證與行為摘要
 *
 * rules（由上到下依序評估）：
 *   { type:'start', actions:[...] }                          開始時執行一次
 *   { type:'event', event:'press'|'release', comp, actions }  按鈕事件（去彈跳後的邊緣）
 *   { type:'while', cond, actions, onEnd:'off'|'keep', restart:'restart'|'resume' }
 *        持續條件：成立期間持續作用；結束與重新開始的規則都要明示
 *   cond:   { type:'pressed', comp } | { type:'light', comp, op:'lt'|'gt', value(0–100 %) }
 *           | { type:'distance', comp, op:'lt'|'gt', value(2–400 cm) }      超音波：每 60 ms 量一次，用上一次量到的值
 *   action: { type:'led', comp, on } | { type:'toggle', comp } | { type:'blink', comp, onMs, offMs }
 *           | { type:'servo', comp, angle }
 *           | { type:'servoMap', comp, src, inMin, inMax, outMin, outMax }   伺服角度跟著距離（線性換算，只能放在持續條件）
 *
 * 輸出合成：沒有持續規則作用時，元件維持「鎖存值」（由開始／事件規則設定）；
 * 有持續規則作用時，以排在最後、目前成立的那條規則為準。
 */
(function (root) {
  const DL = (root.DL = root.DL || {});

  const ACTION_TYPES = { led: 'LED', toggle: 'LED', blink: 'LED', servo: 'SERVO', servoMap: 'SERVO' };
  const COND_TYPES = { pressed: 'BTN', light: 'LDR', distance: 'US' };
  const US_MAX = 400, US_MIN = 2;

  function validate(p, analysis) {
    const issues = [];
    const add = (level, msg, rule) => issues.push({ level, msg, rule });
    const rules = (p.behavior.ir && p.behavior.ir.rules) || [];
    if (!rules.length) add('warn', '尚未定義任何行為：請在「行為」頁用積木加入規則。');
    const comp = id => DL.project.findComp(p, id);
    const refs = new Set();
    const needType = (id, type, where, ri) => {
      const c = comp(id);
      if (!id) { add('error', `規則 ${ri + 1}：${where}沒有選擇元件。`, ri); return false; }
      if (!c) { add('error', `規則 ${ri + 1}：${where}引用的 ${id} 不在配置中（可能已被刪除）。`, ri); return false; }
      if (c.type !== type) { add('error', `規則 ${ri + 1}：${where}需要${DL.components[type].name}，但 ${id} 是${DL.components[c.type].name}。`, ri); return false; }
      refs.add(id); return true;
    };
    const whileTargets = {};
    rules.forEach((r, i) => {
      if (r.type === 'event') {
        needType(r.comp, 'BTN', '事件', i);
        if (!['press', 'release'].includes(r.event)) add('error', `規則 ${i + 1}：不支援的事件 ${r.event}。`, i);
      } else if (r.type === 'while') {
        if (!r.cond) add('error', `規則 ${i + 1}：持續規則缺少條件。`, i);
        else if (!COND_TYPES[r.cond.type]) add('error', `規則 ${i + 1}：不支援的條件。`, i);
        else {
          needType(r.cond.comp, COND_TYPES[r.cond.type], '條件', i);
          if (r.cond.type === 'light' && !(r.cond.value >= 0 && r.cond.value <= 100)) add('error', `規則 ${i + 1}：亮度門檻必須介於 0–100 %。`, i);
          if (r.cond.type === 'distance' && !(Number.isInteger(r.cond.value) && r.cond.value >= US_MIN && r.cond.value <= US_MAX)) add('error', `規則 ${i + 1}：距離門檻必須是 ${US_MIN}–${US_MAX} cm 的整數。`, i);
        }
        if (!['off', 'keep'].includes(r.onEnd)) add('error', `規則 ${i + 1}：沒有指定條件結束時的處理方式。`, i);
        if (!['restart', 'resume'].includes(r.restart)) add('error', `規則 ${i + 1}：沒有指定再次成立時的處理方式。`, i);
      } else if (r.type !== 'start') add('error', `規則 ${i + 1}：不支援的規則類型 ${r.type}。`, i);
      if (!r.actions || !r.actions.length) add('warn', `規則 ${i + 1}：沒有任何動作。`, i);
      for (const a of r.actions || []) {
        if (!ACTION_TYPES[a.type]) { add('error', `規則 ${i + 1}：不支援的動作 ${a.type}。`, i); continue; }
        needType(a.comp, ACTION_TYPES[a.type], '動作', i);
        if (a.type === 'blink') {
          if (r.type !== 'while') add('error', `規則 ${i + 1}：「閃爍」需要持續條件（例如「按住時」），單次事件無法持續閃爍。`, i);
          for (const k of ['onMs', 'offMs']) if (!(Number.isInteger(a[k]) && a[k] >= 10 && a[k] <= 60000)) add('error', `規則 ${i + 1}：閃爍的${k === 'onMs' ? '亮' : '暗'}時間必須是 10–60000 ms 的整數。`, i);
        }
        if (a.type === 'toggle' && r.type === 'while') add('error', `規則 ${i + 1}：「切換」是單次動作，不能放在持續條件中（會每個迴圈都切換）。`, i);
        if (a.type === 'servo' && !(a.angle >= 0 && a.angle <= 180)) add('error', `規則 ${i + 1}：角度必須介於 0–180°。`, i);
        if (a.type === 'servoMap') {
          if (r.type !== 'while') add('error', `規則 ${i + 1}：「伺服跟著距離」要持續更新，只能放在「持續成立時」規則裡。`, i);
          needType(a.src, 'US', '距離來源', i);
          const ints = ['inMin', 'inMax', 'outMin', 'outMax'].every(k => Number.isInteger(a[k]));
          if (!ints) add('error', `規則 ${i + 1}：距離與角度的換算範圍必須是整數。`, i);
          else {
            if (a.inMin === a.inMax) add('error', `規則 ${i + 1}：距離範圍的兩端不能相同。`, i);
            if (![a.inMin, a.inMax].every(x => x >= US_MIN && x <= US_MAX)) add('error', `規則 ${i + 1}：距離範圍必須介於 ${US_MIN}–${US_MAX} cm。`, i);
            if (![a.outMin, a.outMax].every(x => x >= 0 && x <= 180)) add('error', `規則 ${i + 1}：角度範圍必須介於 0–180°。`, i);
          }
        }
        if (r.type === 'while') (whileTargets[a.comp] = whileTargets[a.comp] || []).push(i + 1);
      }
      if (r.type === 'while') {
        const seen = {};
        for (const a of r.actions || []) { if (seen[a.comp]) add('error', `規則 ${i + 1}：同一條規則裡 ${a.comp} 有兩個動作，請只保留一個。`, i); seen[a.comp] = 1; }
      }
    });
    for (const [c, list] of Object.entries(whileTargets)) if (list.length > 1) add('warn', `${c} 被規則 ${list.join('、')} 同時控制；同時成立時以排在後面的規則為準。`);
    if (analysis) for (const id of refs) if (!analysis.bindings[id]) add('error', `${id} 還沒有正確接到腳位（見「配置」頁檢查結果），無法產生程式或連接真機。`);
    return { issues, refs: [...refs], ok: !issues.some(i => i.level === 'error') };
  }

  /* ---------------- 行為摘要（給人確認用） ---------------- */
  function condText(c, p) {
    if (c.type === 'pressed') { const b = DL.project.findComp(p, c.comp); return `${c.comp} 被按住${b ? `（狀態穩定 ${b.params.debounceMs} ms 後才判定，用來去彈跳）` : ''}`; }
    if (c.type === 'light') return `${c.comp} 的亮度${c.op === 'lt' ? '低於' : '高於'} ${c.value} %`;
    if (c.type === 'distance') return `${c.comp} 量到的距離${c.op === 'lt' ? '小於' : '大於'} ${c.value} cm`;
    return '（未知條件）';
  }
  function actionText(a, inWhile) {
    if (a.type === 'led') return `${a.comp} ${a.on ? '亮' : '熄滅'}`;
    if (a.type === 'toggle') return `切換 ${a.comp}（亮↔滅）`;
    if (a.type === 'servo') return `${a.comp} 命令轉到 ${a.angle}°`;
    if (a.type === 'servoMap') return `${a.comp} 的命令角度跟著 ${a.src} 的距離：${a.inMin} cm → ${a.outMin}°、${a.inMax} cm → ${a.outMax}°（中間線性換算，超出範圍取端點）`;
    if (a.type === 'blink') {
      const T = a.onMs + a.offMs; const hz = 1000 / T;
      return `${a.comp} 反覆閃爍：亮 ${a.onMs} ms、暗 ${a.offMs} ms（週期 ${T} ms，約 ${hz >= 10 ? hz.toFixed(0) : hz.toFixed(hz % 1 ? 2 : 0)} Hz），每次開始都先亮`;
    }
    return '（未知動作）';
  }
  function summarize(p) {
    const rules = p.behavior.ir.rules || [];
    const lines = [];
    rules.forEach((r, i) => {
      const acts = (r.actions || []).map(a => actionText(a, r.type === 'while')).join('；');
      if (r.type === 'start') lines.push({ n: i + 1, kind: '開始', text: `程式開始時：${acts || '（沒有動作）'}。` });
      else if (r.type === 'event') lines.push({ n: i + 1, kind: '事件', text: `每當 ${r.comp} ${r.event === 'press' ? '被按下' : '被放開'}（去彈跳後）一次：${acts || '（沒有動作）'}。` });
      else if (r.type === 'while') {
        const blinkRestart = (r.actions || []).some(a => a.type === 'blink');
        const end = r.onEnd === 'off' ? '立即熄滅 LED／伺服回到初始角度' : '保持結束當下的狀態';
        const again = r.restart === 'restart' ? (blinkRestart ? '從頭開始（先亮）' : '重新套用動作') : '接續上次停下的閃爍相位';
        lines.push({ n: i + 1, kind: '持續條件', text: `當 ${condText(r.cond || {}, p)} 時：${acts || '（沒有動作）'}。條件不再成立時：${end}。再次成立時：${again}。` });
      }
    });
    const init = [];
    for (const c of p.components) {
      if (c.type === 'LED') init.push(`${c.id} 熄滅`);
      if (c.type === 'SERVO') init.push(`${c.id} 命令角度 ${c.params.initAngle}°`);
    }
    const notes = ['所有計時都不阻塞：閃爍等待期間仍持續讀取按鈕，放開會在下一個迴圈（約數毫秒內）反應。'];
    if (p.components.some(c => c.type === 'SERVO')) notes.push('伺服角度是送出的命令值；SG90 沒有回授，實際角度未知。');
    if (p.components.some(c => c.type === 'US')) notes.push('超音波每 60 ms 量一次，規則使用「上一次量到」的距離，所以反應會慢 60–120 ms；沒有回波或超出量程時一律當成 400 cm。');
    return { lines, init, notes };
  }

  DL.behavior = { validate, summarize, condText, actionText, ACTION_TYPES, COND_TYPES, US_MAX, US_MIN, US_PERIOD_MS: 60 };
  if (typeof module !== 'undefined') module.exports = DL;
})(typeof globalThis !== 'undefined' ? globalThis : this);
