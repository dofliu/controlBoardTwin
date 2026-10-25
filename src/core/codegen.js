/* DofLab — 程式產生器
 * 輸入：板型、網表綁定、元件參數、行為 IR。輸出：可閱讀、可修改的 Arduino C++ 或 Python。
 * 步驟順序與 engine.js 完全相同（讀輸入→開始→事件→持續規則→輸出），以等價測試驗證。
 */
(function (root) {
  const DL = (root.DL = root.DL || {});
  const GENERATOR_VERSION = 'doflab-gen 2.4.0';   // 2.4.0（V2.13）：樹莓派的伺服脈寬改成 544–2400 µs，和 Uno／ESP32 相同

  const isArm = p => !!(p.arm && !(p.behavior.ir.rules || []).length);
  function prepare(p) {
    const analysis = DL.netlist.analyze(p);
    if (isArm(p)) return prepareArm(p, analysis);
    const bv = DL.behavior.validate(p, analysis);
    const blockers = [];
    if (!analysis.ok) blockers.push('配置檢查還有錯誤，請先到「配置」頁修正。');
    if (!bv.ok) blockers.push(...bv.issues.filter(i => i.level === 'error').map(i => i.msg));
    const inputs = DL.project.inputsHash(p, GENERATOR_VERSION);
    if (!p.behavior.confirmed || p.behavior.confirmed.inputs !== inputs) blockers.push('行為摘要尚未確認，或確認後接線／行為又改變了：請到「行為」頁重新確認。');
    return { analysis, bv, inputs, blockers };
  }

  // 手臂專案：沒有積木規則時，產生「依序播放已記錄姿態」的程式
  function armHash(p, analysis) { return DL.hash({ cfg: p.arm.config, b: p.arm.config.joints.map(j => analysis.bindings[j.servo] ? analysis.bindings[j.servo].pin : null), board: p.board.type }); }
  function prepareArm(p, analysis) {
    const blockers = []; const cfg = p.arm.config;
    if (!analysis.ok) blockers.push('配置檢查還有錯誤，請先到「配置」頁修正。');
    blockers.push(...DL.arm.validateConfig(cfg));
    for (const j of cfg.joints) if (!analysis.bindings[j.servo]) blockers.push(`${j.id} 對應的 ${j.servo} 還沒有正確接到腳位。`);
    if (!(p.arm.poses || []).length) blockers.push('動作序列還沒有任何姿態：到「手臂」頁移到想要的位置，按「記下目前姿態」（行為頁會列出序列）。');
    if (!p.arm.confirmed || p.arm.confirmed.hash !== armHash(p, analysis)) blockers.push('手臂設定與伺服映射尚未確認，或確認後又改變了：請到「手臂」頁確認。');
    return { analysis, bv: { issues: [], ok: true }, inputs: DL.project.inputsHash(p, GENERATOR_VERSION), blockers, arm: true };
  }
  // 序列說明（程式開頭的註解與行為頁摘要共用）
  function armSeqText(plan) {
    const parts = plan.way.map(w => `${w.name}（停 ${(w.hold / 1000).toFixed(1)} 秒）`);
    return `開機在預備姿態 → ${parts.join(' → ')}${plan.loop ? '，反覆執行' : '，走完一輪後停住'}`;
  }
  function genArmArduino(p, board, prep) {
    const cfg = p.arm.config; const B = prep.analysis.bindings; const plan = DL.arm.seqPlan(p.arm); const W = plan.way;
    const L = [];
    L.push(`// ============================================================`);
    L.push(`// DofLab 產生的程式（${GENERATOR_VERSION}）：三自由度手臂動作序列`);
    L.push(`// 專案：${p.name}　板型：${board.name}（${board.fqbn}）`);
    L.push(`// 輸入雜湊：${prep.inputs}`);
    L.push(`// 序列：${armSeqText(plan)}。`);
    L.push(`// 每個關節限速 ${cfg.maxSpeed} °/s；三個關節都到位後才開始停留計時。`);
    L.push(`// 角度是送給伺服的命令值；SG90 沒有回授，程式無法知道實際是否到位。`);
    L.push(`// 尺寸、範圍與零位是教學假設：上電前請確認機構不會碰撞，伺服使用外部電源並與控制板共地。`);
    L.push(`// ============================================================`);
    L.push(`#include <${board.libs.servo === 'Servo' ? 'Servo' : 'ESP32Servo'}.h>`);
    L.push('');
    cfg.joints.forEach((j, i) => { const pin = board.pinById[B[j.servo].pin]; L.push(`const int ${j.id}_PIN = ${board.codeName(pin)};`.padEnd(26) + `// ${j.id} ${j.name}：${j.servo} SIG → ${board.pinLabel(pin)}`); });
    L.push('');
    L.push(`const int HOME[3] = {${plan.home.join(', ')}};   // 預備姿態 (${DL.arm.HOME_T.x}, ${DL.arm.HOME_T.y}, ${DL.arm.HOME_T.z}) cm：開機時的姿勢`);
    L.push(`const int STEP_COUNT = ${W.length};`);
    L.push(`const int STEPS[STEP_COUNT][3] = {   // 每一步的伺服命令角度（已依零位與方向換算）`);
    W.forEach((w, k) => L.push(`  {${w.s.join(', ')}}${k < W.length - 1 ? ',' : ''}   // ${k + 1}. ${w.name}${w.t ? `：(${w.t.x}, ${w.t.y}, ${w.t.z}) cm` : ''}`));
    L.push('};');
    L.push(`const unsigned long HOLD_MS[STEP_COUNT] = {${W.map(w => w.hold).join(', ')}};   // 到位後停留（毫秒）`);
    L.push(`const bool LOOP = ${plan.loop ? 'true' : 'false'};   // true：最後一步做完回到第 1 步`);
    L.push(`const float MAX_SPEED = ${Number(cfg.maxSpeed).toFixed(1)};   // °/s（每個關節）`);
    L.push('');
    L.push('Servo joint[3];');
    L.push('float current[3];');
    L.push('int written[3] = {-1, -1, -1};');
    L.push('int stepIndex = 0;');
    L.push('bool holding = false, done = false;');
    L.push('unsigned long lastMs = 0, holdStart = 0;');
    L.push('');
    L.push('void setup() {');
    cfg.joints.forEach((j, i) => L.push(`  joint[${i}].attach(${j.id}_PIN);`));
    L.push('  for (int i = 0; i < 3; i++) { current[i] = HOME[i]; joint[i].write(HOME[i]); written[i] = HOME[i]; }');
    L.push('  lastMs = millis();');
    L.push('}');
    L.push('');
    L.push('void loop() {');
    L.push('  unsigned long now = millis();');
    L.push('  float step = MAX_SPEED * (now - lastMs) / 1000.0;   // 這一輪最多可轉幾度');
    L.push('  lastMs = now;');
    L.push('  if (done) return;');
    L.push('  bool arrived = true;');
    L.push('  for (int i = 0; i < 3; i++) {');
    L.push('    float d = STEPS[stepIndex][i] - current[i];');
    L.push('    if (d > step) { current[i] += step; arrived = false; }');
    L.push('    else if (d < -step) { current[i] -= step; arrived = false; }');
    L.push('    else current[i] = STEPS[stepIndex][i];');
    L.push('    int a = (int)(current[i] + 0.5);');
    L.push('    if (a != written[i]) { joint[i].write(a); written[i] = a; }');
    L.push('  }');
    L.push('  if (arrived && !holding) { holding = true; holdStart = now; }');
    L.push('  if (holding && now - holdStart >= HOLD_MS[stepIndex]) {');
    L.push('    holding = false; stepIndex++;');
    L.push('    if (stepIndex >= STEP_COUNT) { if (LOOP) stepIndex = 0; else { stepIndex = STEP_COUNT - 1; done = true; } }');
    L.push('  }');
    L.push('}');
    return { code: L.join('\n') + '\n', libs: [board.libs.servo] };
  }
  function genArmPython(p, board, prep) {
    const cfg = p.arm.config; const B = prep.analysis.bindings; const plan = DL.arm.seqPlan(p.arm); const W = plan.way; const L = [];
    L.push('# ============================================================');
    L.push(`# DofLab 產生的程式（${GENERATOR_VERSION}）：三自由度手臂動作序列`);
    L.push(`# 專案：${p.name}　板型：${board.name}`);
    L.push(`# 輸入雜湊：${prep.inputs}`);
    L.push(`# 序列：${armSeqText(plan)}。每個關節限速 ${cfg.maxSpeed} °/s。`);
    L.push('# 角度是命令值；SG90 沒有回授。尺寸、範圍與零位是教學假設，上電前請確認機構不會碰撞。');
    L.push('# ============================================================');
    L.push('import time');
    L.push('from gpiozero import AngularServo');
    L.push('');
    cfg.joints.forEach(j => { const pin = board.pinById[B[j.servo].pin]; L.push(`${j.id}_PIN = ${pin.num}`.padEnd(16) + `# ${j.id} ${j.name}：${j.servo} SIG → ${board.pinLabel(pin)}`); });
    L.push(`HOME = (${plan.home.join(', ')})   # 預備姿態：開機時的姿勢`);
    L.push('STEPS = [   # (伺服命令角度, 停留秒數)');
    W.forEach((w, k) => L.push(`    ((${w.s.join(', ')}), ${(w.hold / 1000).toFixed(3)}),   # ${k + 1}. ${w.name}`));
    L.push(']');
    L.push(`LOOP = ${plan.loop ? 'True' : 'False'}`);
    L.push(`MAX_SPEED = ${Number(cfg.maxSpeed).toFixed(1)}   # °/s`);
    L.push('');
    L.push('');
    L.push('def main():');
    L.push(`    joints = [AngularServo(p, min_angle=0, max_angle=180, min_pulse_width=0.000544, max_pulse_width=0.0024) for p in (${cfg.joints.map(j => j.id + '_PIN').join(', ')})]`);
    L.push('    current = list(HOME)');
    L.push('    for s, a in zip(joints, current):');
    L.push('        s.angle = a');
    L.push('    index, holding, hold_start, done = 0, False, 0.0, False');
    L.push('    last = time.monotonic()');
    L.push('    print("DofLab：手臂動作序列開始執行（Ctrl+C 結束）", flush=True)');
    L.push('    while not done:');
    L.push('        now = time.monotonic()');
    L.push('        step = MAX_SPEED * (now - last)');
    L.push('        last = now');
    L.push('        target, hold = STEPS[index]');
    L.push('        arrived = True');
    L.push('        for i in range(3):');
    L.push('            d = target[i] - current[i]');
    L.push('            if abs(d) > step:');
    L.push('                current[i] += step if d > 0 else -step');
    L.push('                arrived = False');
    L.push('            else:');
    L.push('                current[i] = target[i]');
    L.push('            joints[i].angle = round(current[i])');
    L.push('        if arrived and not holding:');
    L.push('            holding, hold_start = True, now');
    L.push('        if holding and now - hold_start >= hold:');
    L.push('            holding = False');
    L.push('            index += 1');
    L.push('            if index >= len(STEPS):');
    L.push('                if LOOP:');
    L.push('                    index = 0');
    L.push('                else:');
    L.push('                    index, done = len(STEPS) - 1, True');
    L.push('        time.sleep(0.02)');
    L.push('    print("DofLab：序列走完，停在最後的姿勢", flush=True)');
    L.push('');
    L.push('');
    L.push('if __name__ == "__main__":');
    L.push('    main()');
    return { code: L.join('\n') + '\n', libs: ['gpiozero'] };
  }


  function generate(p, opts) {
    opts = opts || {};
    const prep = prepare(p);
    if (prep.blockers.length && !opts.force) return { ok: false, blockers: prep.blockers };
    const board = DL.boards[p.board.type];
    const out = prep.arm ? (board.lang === 'python' ? genArmPython(p, board, prep) : genArmArduino(p, board, prep)) : board.lang === 'python' ? genPython(p, board, prep) : genArduino(p, board, prep);
    return { ok: true, code: out.code, lang: board.lang, libs: out.libs, inputs: prep.inputs, generatorVersion: GENERATOR_VERSION, at: new Date().toISOString() };
  }

  const v = id => id.toLowerCase();             // LED1 → led1
  const cap = id => id.charAt(0) + id.slice(1).toLowerCase();   // SERVO1 → Servo1
  const initialOf = (p, id) => { const c = DL.project.findComp(p, id); return c && c.type === 'SERVO' ? Number(c.params.initAngle) : 0; };
  const usedAny = (p, types) => p.components.filter(c => types.includes(c.type) && p.behavior.ir.rules.some(r => refsComp(r, c.id)));
  const hasPrint = rules => (rules || []).some(r => (r.actions || []).some(a => a.type === 'print'));
  const used = (p, type) => p.components.filter(c => c.type === type && p.behavior.ir.rules.some(r => refsComp(r, c.id)));
  function refsComp(r, id) { return r.comp === id || (r.cond && r.cond.comp === id) || (r.actions || []).some(a => a.comp === id || a.src === id); }

  function headerLines(p, board, prep, cm) {
    const sum = DL.behavior.summarize(p);
    const L = [];
    L.push(`${cm} ============================================================`);
    L.push(`${cm} DofLab 產生的程式（${GENERATOR_VERSION}）`);
    L.push(`${cm} 專案：${p.name}　板型：${board.name}${board.fqbn ? '（' + board.fqbn + '）' : ''}`);
    L.push(`${cm} 輸入雜湊：${prep.inputs}`);
    L.push(`${cm}   接線、元件參數、行為或板型改變後，這份程式會被標為「過期」。`);
    L.push(`${cm} ------------------------------------------------------------`);
    L.push(`${cm} 行為摘要`);
    for (const l of sum.lines) L.push(`${cm}   規則 ${l.n}（${l.kind}）：${l.text}`);
    L.push(`${cm}   初始狀態：${sum.init.join('、') || '（無）'}`);
    L.push(`${cm} ============================================================`);
    return L;
  }

  /* ======================= Arduino C++（Uno / ESP32） ======================= */
  function genArduino(p, board, prep) {
    const B = prep.analysis.bindings;
    const rules = p.behavior.ir.rules;
    const btns = usedAny(p, DL.behavior.BUTTONS), leds = p.components.filter(c => DL.behavior.LEDS.includes(c.type) && B[c.id]), ldrs = used(p, 'LDR'), servos = p.components.filter(c => c.type === 'SERVO' && B[c.id]), uss = used(p, 'US');
    const touches = btns.filter(c => c.type === 'TOUCH'); const serial = hasPrint(rules);
    const adcMax = (1 << board.adcBits) - 1;
    const libs = [];
    const L = headerLines(p, board, prep, '//');
    if (servos.length) { libs.push(board.libs.servo); L.push(`#include <${board.libs.servo === 'Servo' ? 'Servo' : 'ESP32Servo'}.h>${board.libs.servo === 'Servo' ? '   // Arduino 內建函式庫' : '   // 需安裝函式庫：ESP32Servo'}`); }
    L.push('');
    L.push('// ---- 腳位綁定（由網表產生；手動修改後，「程式」頁會比對是否與接線一致）----');
    const pinComment = (c) => {
      const b = B[c.id]; const pin = board.pinById[b.pin];
      if (c.type === 'BTN') return `${c.id}：${board.pinLabel(pin)} ↔ 按鈕 ↔ GND，內建上拉，按下 = LOW`;
      if (c.type === 'BOOT') return `${c.id}：板上的 BOOT 鍵（${board.pinLabel(pin)}），按下 = LOW；不需要接線`;
      if (c.type === 'TOUCH') return `${c.id}：觸控腳 ${board.pinLabel(pin)}，用手指碰排針；不需要接線`;
      if (c.type === 'OBLED') return `${c.id}：板上的 LED（${board.pinLabel(pin)}），HIGH 亮；不需要接線`;
      if (c.type === 'LED') return `${c.id}：${board.pinLabel(pin)} → ${b.via.join('、')} → LED → GND`;
      if (c.type === 'LDR') return `${c.id}：AO → ${board.pinLabel(pin)}（0–${adcMax}）`;
      if (c.type === 'SERVO') return `${c.id}：SIG → ${board.pinLabel(pin)}（只送出命令角度，沒有回授）`;
    };
    for (const c of [...btns, ...leds, ...ldrs, ...servos]) {
      const b = B[c.id]; const pin = board.pinById[b.pin];
      L.push(`const int ${c.id}_PIN = ${board.codeName(pin)};`.padEnd(30) + `// ${pinComment(c)}`);
    }
    for (const c of uss) {
      const b = B[c.id]; const tp = board.pinById[b.trig], ep = board.pinById[b.echo];
      L.push(`const int ${c.id}_TRIG_PIN = ${board.codeName(tp)};`.padEnd(30) + `// ${c.id}：TRIG ← ${board.pinLabel(tp)}（送出 10 µs 觸發脈衝）`);
      L.push(`const int ${c.id}_ECHO_PIN = ${board.codeName(ep)};`.padEnd(30) + `// ${c.id}：ECHO → ${board.pinLabel(ep)}（${b.model}，高電位寬度約 58 µs／cm）`);
    }
    if (btns.length || uss.length) { L.push(''); L.push('// ---- 參數 ----'); }
    for (const c of btns) L.push(`const unsigned long ${c.id}_DEBOUNCE_MS = ${c.params.debounceMs};   // 去彈跳時間（實驗設定）`);
    for (const c of touches) L.push(`const int ${c.id}_DROP_PCT = ${c.params.dropPct};             // 讀值比開機基準低這麼多 % 就算碰到`);
    if (uss.length) {
      L.push('const unsigned long US_PERIOD_MS = 60;       // 超音波量測間隔（HC-SR04 建議至少 60 ms）');
      L.push('const unsigned long US_TIMEOUT_US = 30000;   // 30 ms 內沒有回波＝超出量程');
      L.push('const int US_MAX_CM = 400;                   // 超出量程或沒有回波時，一律當成 400 cm');
    }
    L.push('');
    L.push('// ---- 狀態 ----');
    for (const c of btns) {
      L.push(`bool ${v(c.id)}Stable = false;          // 去彈跳後的狀態：true = 按下`);
      L.push(`bool ${v(c.id)}LastRaw = false;`);
      L.push(`unsigned long ${v(c.id)}ChangedAt = 0;`);
      L.push(`bool ${v(c.id)}Pressed = false;         // 這一輪剛按下`);
      L.push(`bool ${v(c.id)}Released = false;        // 這一輪剛放開`);
    }
    for (const c of touches) L.push(`int ${v(c.id)}Threshold = 0;            // 開機時量到的基準值 × (100 − ${c.id}_DROP_PCT) %`);
    for (const c of uss) {
      const n = v(c.id);
      L.push(`int ${n}Cm = US_MAX_CM;                 // 規則使用的距離（cm）：上一次量到的結果`);
      L.push(`int ${n}Next = US_MAX_CM;               // 這一次觸發正在量的結果`);
      L.push(`byte ${n}State = 0;                     // 0 等待下一次觸發、1 等待回波開始、2 量測回波寬度`);
      L.push(`unsigned long ${n}Due = 0;              // 下一次觸發的時間（ms）`);
      L.push(`unsigned long ${n}T0 = 0;               // 觸發或回波開始的時間（µs）`);
    }
    for (const c of leds) L.push(`bool ${v(c.id)}Latched = false;         // 沒有持續規則作用時 ${c.id} 的狀態`);
    for (const c of servos) { L.push(`int ${v(c.id)}Latched = ${c.params.initAngle};`); L.push(`int ${v(c.id)}Written = -1;`); L.push(`Servo ${v(c.id)}Servo;`); }
    rules.forEach((r, i) => { if (r.type === 'while') L.push(`bool rule${i + 1}Active = false;  unsigned long rule${i + 1}StartedAt = 0;  unsigned long rule${i + 1}Offset = 0;`); });
    rules.forEach((r, i) => { if (r.type === 'while') for (const a of r.actions) if (a.type === 'servoMap') L.push(`int rule${i + 1}${cap(a.comp)}Map = ${initialOf(p, a.comp)};       // 規則 ${i + 1} 上一輪換算出的 ${a.comp} 角度`); });
    L.push('');
    for (const c of btns) {
      const n = v(c.id);
      L.push(`// 讀取 ${c.id} 並去彈跳：原始讀值要穩定 ${c.id}_DEBOUNCE_MS 才更新狀態`);
      L.push(`void read${c.id}(unsigned long now) {`);
      if (c.type === 'TOUCH') L.push(`  bool raw = (touchRead(${c.id}_PIN) < ${v(c.id)}Threshold);   // 手指碰到時讀值變小`);
      else L.push(`  bool raw = (digitalRead(${c.id}_PIN) == LOW);   // ${c.type === 'BOOT' ? '板上的上拉電阻：按下 BOOT 讀到 LOW' : '接 GND＋上拉：按下讀到 LOW'}`);
      L.push(`  ${n}Pressed = false;`);
      L.push(`  ${n}Released = false;`);
      L.push(`  if (raw != ${n}LastRaw) { ${n}LastRaw = raw; ${n}ChangedAt = now; }`);
      L.push(`  if (raw != ${n}Stable && now - ${n}ChangedAt >= ${c.id}_DEBOUNCE_MS) {`);
      L.push(`    ${n}Stable = raw;`);
      L.push(`    if (raw) ${n}Pressed = true; else ${n}Released = true;`);
      L.push(`  }`);
      L.push(`}`);
      L.push('');
    }
    for (const c of uss) {
      const n = v(c.id);
      L.push(`// 量 ${c.id} 的距離：不用 pulseIn（它會讓整個程式停住最多數十毫秒），而是每一輪迴圈看一次 ECHO。`);
      L.push(`// 精度取決於迴圈多快跑完一輪；規則用的是上一次量到的值，所以反應會慢 60–120 ms。`);
      L.push(`void update${c.id}(unsigned long now) {`);
      L.push(`  if (${n}State == 1) {                                   // 等待回波開始`);
      L.push(`    if (digitalRead(${c.id}_ECHO_PIN) == HIGH) { ${n}T0 = micros(); ${n}State = 2; }`);
      L.push(`    else if (micros() - ${n}T0 > US_TIMEOUT_US) { ${n}Next = US_MAX_CM; ${n}State = 0; }   // 沒有回波`);
      L.push(`  } else if (${n}State == 2) {                            // 量測回波寬度`);
      L.push(`    unsigned long w = micros() - ${n}T0;`);
      L.push(`    if (digitalRead(${c.id}_ECHO_PIN) == LOW) { ${n}Next = (w / 58 > (unsigned long)US_MAX_CM) ? US_MAX_CM : (int)(w / 58); ${n}State = 0; }`);
      L.push(`    else if (w > US_TIMEOUT_US) { ${n}Next = US_MAX_CM; ${n}State = 0; }   // 回波太長：超出量程`);
      L.push(`  }`);
      L.push(`  if (now >= ${n}Due) {                                   // 每 60 ms：改用上一次的結果，再觸發一次`);
      L.push(`    ${n}Due += US_PERIOD_MS;`);
      L.push(`    ${n}Cm = ${n}Next;`);
      L.push(`    ${n}Next = US_MAX_CM;`);
      L.push(`    if (${n}State == 0 && digitalRead(${c.id}_ECHO_PIN) == LOW) {`);
      L.push(`      digitalWrite(${c.id}_TRIG_PIN, HIGH); delayMicroseconds(10); digitalWrite(${c.id}_TRIG_PIN, LOW);`);
      L.push(`      ${n}T0 = micros(); ${n}State = 1;`);
      L.push(`    }`);
      L.push(`  }`);
      L.push(`}`);
      L.push('');
    }
    const instant = (a, ind) => {
      if (a.type === 'led') return `${ind}${v(a.comp)}Latched = ${a.on ? 'true' : 'false'};`;
      if (a.type === 'toggle') return `${ind}${v(a.comp)}Latched = !${v(a.comp)}Latched;`;
      if (a.type === 'servo') return `${ind}${v(a.comp)}Latched = ${a.angle};`;
      if (a.type === 'print') return `${ind}Serial.println(${JSON.stringify(a.text)});`;
    };
    const valueExpr = (a, i) => {
      if (a.type === 'led') return a.on ? 'true' : 'false';
      if (a.type === 'servo') return String(a.angle);
      if (a.type === 'blink') return `((rule${i}Offset + now - rule${i}StartedAt) % ${a.onMs + a.offMs}UL) < ${a.onMs}UL`;
      if (a.type === 'servoMap') return `map(constrain(${v(a.src)}Cm, ${Math.min(a.inMin, a.inMax)}, ${Math.max(a.inMin, a.inMax)}), ${a.inMin}, ${a.inMax}, ${a.outMin}, ${a.outMax})`;
    };
    const condExpr = c => c.type === 'pressed' ? `${v(c.comp)}Stable` : c.type === 'distance' ? `${v(c.comp)}Cm ${c.op === 'lt' ? '<' : '>'} ${c.value}` : `${v(c.comp)}Pct ${c.op === 'lt' ? '<' : '>'} ${c.value}`;
    const initial = id => { const c = DL.project.findComp(p, id); return c.type === 'SERVO' ? String(c.params.initAngle) : 'false'; };

    L.push('void setup() {');
    if (serial) L.push('  Serial.begin(115200);              // 序列埠監控視窗請選 115200 bps');
    for (const c of btns) if (c.type !== 'TOUCH') L.push(`  pinMode(${c.id}_PIN, INPUT_PULLUP);`);
    for (const c of touches) {
      L.push(`  // ${c.id} 校正：開機時不要碰觸控腳，取 16 次讀值的平均當基準`);
      L.push(`  { long sum = 0; for (int i = 0; i < 16; i++) { sum += touchRead(${c.id}_PIN); delay(5); }`);
      L.push(`    ${v(c.id)}Threshold = sum / 16 * (100 - ${c.id}_DROP_PCT) / 100; }`);
    }
    for (const c of leds) { L.push(`  pinMode(${c.id}_PIN, OUTPUT);`); L.push(`  digitalWrite(${c.id}_PIN, LOW);`); }
    for (const c of servos) L.push(`  ${v(c.id)}Servo.attach(${c.id}_PIN);`);
    for (const c of uss) { L.push(`  pinMode(${c.id}_TRIG_PIN, OUTPUT);`); L.push(`  digitalWrite(${c.id}_TRIG_PIN, LOW);`); L.push(`  pinMode(${c.id}_ECHO_PIN, INPUT);`); }
    const starts = rules.map((r, i) => [r, i]).filter(([r]) => r.type === 'start');
    for (const [r, i] of starts) { L.push(`  // 規則 ${i + 1}：開始時`); for (const a of r.actions) L.push(instant(a, '  ')); }
    L.push('}');
    L.push('');
    L.push('void loop() {');
    L.push('  unsigned long now = millis();');
    L.push('');
    L.push('  // 1. 讀取輸入');
    for (const c of btns) L.push(`  read${c.id}(now);`);
    for (const c of ldrs) L.push(`  int ${v(c.id)}Pct = (long)analogRead(${c.id}_PIN) * 100 / ${adcMax};   // 亮度 0–100 %`);
    for (const c of uss) L.push(`  update${c.id}(now);                    // 距離 ${v(c.id)}Cm（cm）`);
    const evs = rules.map((r, i) => [r, i]).filter(([r]) => r.type === 'event');
    if (evs.length) { L.push(''); L.push('  // 2. 事件規則（只在按下／放開的那一輪執行一次）'); }
    for (const [r, i] of evs) {
      L.push(`  if (${v(r.comp)}${r.event === 'press' ? 'Pressed' : 'Released'}) {   // 規則 ${i + 1}`);
      for (const a of r.actions) L.push(instant(a, '    '));
      L.push('  }');
    }
    const whiles = rules.map((r, i) => [r, i]).filter(([r]) => r.type === 'while');
    if (whiles.length) { L.push(''); L.push('  // 3. 持續條件規則：成立時開始、不成立時結束（不使用 delay，所以隨時能反應）'); }
    for (const [r, i] of whiles) {
      const n = i + 1;
      L.push(`  {   // 規則 ${n}：當 ${DL.behavior.condText(r.cond, p).replace(/（.*?）/, '')}`);
      L.push(`    bool cond = ${condExpr(r.cond)};`);
      L.push(`    if (cond && !rule${n}Active) {`);
      L.push(`      rule${n}Active = true;`);
      L.push(`      rule${n}StartedAt = now;`);
      if (r.restart === 'restart') L.push(`      rule${n}Offset = 0;            // 再次成立：從頭開始`);
      L.push(`    } else if (!cond && rule${n}Active) {`);
      for (const a of r.actions) {
        if (r.onEnd === 'keep') L.push(a.type === 'servoMap' ? `      ${v(a.comp)}Latched = rule${n}${cap(a.comp)}Map;   // 保持上一輪送出的角度` : `      ${v(a.comp)}Latched = ${valueExpr(a, n)};   // 保持結束當下的狀態`);
        else L.push(`      ${v(a.comp)}Latched = ${initial(a.comp)};   // 條件結束：回到初始狀態`);
      }
      const blink = r.actions.find(a => a.type === 'blink');
      if (blink) L.push(`      rule${n}Offset = (rule${n}Offset + now - rule${n}StartedAt) % ${blink.onMs + blink.offMs}UL;`);
      L.push(`      rule${n}Active = false;`);
      L.push('    }');
      L.push('  }');
    }
    L.push('');
    L.push('  // 4. 合成並輸出（排在後面、正在作用的持續規則優先）');
    for (const c of leds) {
      L.push(`  bool ${v(c.id)} = ${v(c.id)}Latched;`);
      for (const [r, i] of whiles) for (const a of r.actions) if (a.comp === c.id) L.push(`  if (rule${i + 1}Active) ${v(c.id)} = ${valueExpr(a, i + 1)};`);
      L.push(`  digitalWrite(${c.id}_PIN, ${v(c.id)} ? HIGH : LOW);`);
    }
    for (const c of servos) {
      L.push(`  int ${v(c.id)}Angle = ${v(c.id)}Latched;`);
      for (const [r, i] of whiles) for (const a of r.actions) if (a.comp === c.id) L.push(a.type === 'servoMap' ? `  if (rule${i + 1}Active) { rule${i + 1}${cap(c.id)}Map = ${valueExpr(a, i + 1)}; ${v(c.id)}Angle = rule${i + 1}${cap(c.id)}Map; }` : `  if (rule${i + 1}Active) ${v(c.id)}Angle = ${valueExpr(a, i + 1)};`);
      L.push(`  if (${v(c.id)}Angle != ${v(c.id)}Written) { ${v(c.id)}Servo.write(${v(c.id)}Angle); ${v(c.id)}Written = ${v(c.id)}Angle; }`);
    }
    L.push('}');
    return { code: L.join('\n') + '\n', libs };
  }

  /* ======================= Python（Raspberry Pi · gpiozero） ======================= */
  function genPython(p, board, prep) {
    const B = prep.analysis.bindings;
    const rules = p.behavior.ir.rules;
    const btns = used(p, 'BTN'), leds = p.components.filter(c => c.type === 'LED' && B[c.id]), servos = p.components.filter(c => c.type === 'SERVO' && B[c.id]), uss = used(p, 'US');
    const libs = ['gpiozero'];
    const L = headerLines(p, board, prep, '#');
    L.push('import time');
    const imp = [leds.length && 'LED', btns.length && 'Button', servos.length && 'AngularServo', uss.length && 'DistanceSensor'].filter(Boolean);
    if (imp.length) L.push(`from gpiozero import ${imp.join(', ')}`);
    L.push('');
    L.push('# ---- 腳位綁定（BCM GPIO 編號；由網表產生，手動修改後「程式」頁會比對一致性）----');
    for (const c of [...btns, ...leds, ...servos]) {
      const b = B[c.id]; const pin = board.pinById[b.pin];
      const note = c.type === 'BTN' ? `${board.pinLabel(pin)} ↔ 按鈕 ↔ GND，內建上拉` : c.type === 'LED' ? `${board.pinLabel(pin)} → ${b.via.join('、')} → LED → GND` : `SIG → ${board.pinLabel(pin)}，只送出命令角度`;
      L.push(`${c.id}_PIN = ${pin.num}`.padEnd(18) + `# ${c.id}：${note}`);
    }
    for (const c of uss) {
      const b = B[c.id]; const tp = board.pinById[b.trig], ep = board.pinById[b.echo];
      L.push(`${c.id}_TRIG_PIN = ${tp.num}`.padEnd(18) + `# ${c.id}：TRIG ← ${board.pinLabel(tp)}`);
      L.push(`${c.id}_ECHO_PIN = ${ep.num}`.padEnd(18) + `# ${c.id}：ECHO → ${board.pinLabel(ep)}（${b.model}；樹莓派 GPIO 只能接 3.3 V）`);
    }
    for (const c of btns) L.push(`${c.id}_DEBOUNCE_MS = ${c.params.debounceMs}   # 去彈跳時間（實驗設定）`);
    if (uss.length) { L.push('US_PERIOD_MS = 60     # 超音波量測間隔'); L.push('US_MAX_CM = 400       # 超出量程或沒有回波時，一律當成 400 cm'); }
    L.push('');
    if (btns.length) {
      L.push('');
      L.push('class DebouncedButton:');
      L.push('    """原始讀值要穩定 debounce_ms 才更新狀態；與 Arduino 版與模擬器步驟相同。"""');
      L.push('    def __init__(self, pin, debounce_ms):');
      L.push('        self.button = Button(pin, pull_up=True, bounce_time=None)  # 接 GND＋內建上拉');
      L.push('        self.debounce_ms = debounce_ms');
      L.push('        self.stable = False');
      L.push('        self.last_raw = False');
      L.push('        self.changed_at = 0');
      L.push('        self.pressed = False');
      L.push('        self.released = False');
      L.push('');
      L.push('    def update(self, now):');
      L.push('        raw = self.button.is_pressed');
      L.push('        self.pressed = False');
      L.push('        self.released = False');
      L.push('        if raw != self.last_raw:');
      L.push('            self.last_raw = raw');
      L.push('            self.changed_at = now');
      L.push('        if raw != self.stable and now - self.changed_at >= self.debounce_ms:');
      L.push('            self.stable = raw');
      L.push('            if raw:');
      L.push('                self.pressed = True');
      L.push('            else:');
      L.push('                self.released = True');
      L.push('');
    }
    if (uss.length) {
      L.push('');
      L.push('def read_cm(sensor):');
      L.push('    """gpiozero 在背景量測並取最近幾次的中位數；回傳整數公分，超出量程當成 400。"""');
      L.push('    d = sensor.distance   # 公尺，0 到 max_distance');
      L.push('    if d is None:');
      L.push('        return US_MAX_CM');
      L.push('    cm = int(d * 100)');
      L.push('    return US_MAX_CM if cm >= US_MAX_CM else cm');
      L.push('');
    }
    if (rules.some(r => (r.actions || []).some(a => a.type === 'servoMap'))) {
      L.push('');
      L.push('def map_range(x, in_min, in_max, out_min, out_max):');
      L.push('    """與 Arduino 的 map() 相同：整數運算、向零截斷"""');
      L.push('    return out_min + int((x - in_min) * (out_max - out_min) / (in_max - in_min))');
      L.push('');
    }
    L.push('');
    L.push('def main():');
    for (const c of btns) L.push(`    ${v(c.id)} = DebouncedButton(${c.id}_PIN, ${c.id}_DEBOUNCE_MS)`);
    for (const c of leds) L.push(`    ${v(c.id)} = LED(${c.id}_PIN)`);
    for (const c of uss) L.push(`    ${v(c.id)} = DistanceSensor(echo=${c.id}_ECHO_PIN, trigger=${c.id}_TRIG_PIN, max_distance=US_MAX_CM / 100, queue_len=3)`);
    for (const c of uss) L.push(`    ${v(c.id)}_cm = US_MAX_CM; ${v(c.id)}_next = US_MAX_CM; ${v(c.id)}_due = 0   # 規則使用上一次量到的距離`);
    for (const c of servos) L.push(`    ${v(c.id)} = AngularServo(${c.id}_PIN, min_angle=0, max_angle=180, min_pulse_width=0.000544, max_pulse_width=0.0024)  # 脈寬 544–2400 µs，和 Uno／ESP32 的 Servo 函式庫相同（教學假設，請依實物調整）`);
    for (const c of leds) L.push(`    ${v(c.id)}_latched = False`);
    for (const c of servos) { L.push(`    ${v(c.id)}_latched = ${c.params.initAngle}`); L.push(`    ${v(c.id)}_written = None`); }
    for (const c of leds) L.push(`    ${v(c.id)}_written = None`);
    rules.forEach((r, i) => { if (r.type === 'while') L.push(`    rule${i + 1}_active = False; rule${i + 1}_started_at = 0; rule${i + 1}_offset = 0`); });
    rules.forEach((r, i) => { if (r.type === 'while') for (const a of r.actions) if (a.type === 'servoMap') L.push(`    rule${i + 1}_${v(a.comp)}_map = ${initialOf(p, a.comp)}   # 規則 ${i + 1} 上一輪換算出的 ${a.comp} 角度`); });
    const instant = (a, ind) => {
      if (a.type === 'led') return `${ind}${v(a.comp)}_latched = ${a.on ? 'True' : 'False'}`;
      if (a.type === 'toggle') return `${ind}${v(a.comp)}_latched = not ${v(a.comp)}_latched`;
      if (a.type === 'servo') return `${ind}${v(a.comp)}_latched = ${a.angle}`;
      if (a.type === 'print') return `${ind}print(${JSON.stringify(a.text)}, flush=True)`;
    };
    const valueExpr = (a, i) => {
      if (a.type === 'led') return a.on ? 'True' : 'False';
      if (a.type === 'servo') return String(a.angle);
      if (a.type === 'blink') return `((rule${i}_offset + now - rule${i}_started_at) % ${a.onMs + a.offMs}) < ${a.onMs}`;
      if (a.type === 'servoMap') return `map_range(min(max(${v(a.src)}_cm, ${Math.min(a.inMin, a.inMax)}), ${Math.max(a.inMin, a.inMax)}), ${a.inMin}, ${a.inMax}, ${a.outMin}, ${a.outMax})`;
    };
    const condExpr = c => c.type === 'pressed' ? `${v(c.comp)}.stable` : c.type === 'distance' ? `${v(c.comp)}_cm ${c.op === 'lt' ? '<' : '>'} ${c.value}` : 'False';
    const initial = id => { const c = DL.project.findComp(p, id); return c.type === 'SERVO' ? String(c.params.initAngle) : 'False'; };
    const starts = rules.map((r, i) => [r, i]).filter(([r]) => r.type === 'start');
    for (const [r, i] of starts) { L.push(`    # 規則 ${i + 1}：開始時`); for (const a of r.actions) L.push(instant(a, '    ')); }
    L.push('');
    L.push('    t0 = time.monotonic()');
    L.push('    print("DofLab：程式開始執行（Ctrl+C 結束）", flush=True)');
    L.push('    while True:');
    L.push('        now = int((time.monotonic() - t0) * 1000)   # 毫秒');
    L.push('');
    L.push('        # 1. 讀取輸入');
    for (const c of btns) L.push(`        ${v(c.id)}.update(now)`);
    for (const c of uss) {
      const n = v(c.id);
      L.push(`        if now >= ${n}_due:   # 每 60 ms：改用上一次的結果，再讀一次`);
      L.push(`            ${n}_due += US_PERIOD_MS`);
      L.push(`            ${n}_cm = ${n}_next`);
      L.push(`            ${n}_next = read_cm(${n})`);
    }
    if (!btns.length && !uss.length) L.push('        pass');
    const evs = rules.map((r, i) => [r, i]).filter(([r]) => r.type === 'event');
    if (evs.length) { L.push(''); L.push('        # 2. 事件規則'); }
    for (const [r, i] of evs) {
      L.push(`        if ${v(r.comp)}.${r.event === 'press' ? 'pressed' : 'released'}:   # 規則 ${i + 1}`);
      for (const a of r.actions) L.push(instant(a, '            '));
    }
    const whiles = rules.map((r, i) => [r, i]).filter(([r]) => r.type === 'while');
    if (whiles.length) { L.push(''); L.push('        # 3. 持續條件規則（不使用長時間 sleep，所以隨時能反應）'); }
    for (const [r, i] of whiles) {
      const n = i + 1;
      L.push(`        cond = ${condExpr(r.cond)}   # 規則 ${n}`);
      L.push(`        if cond and not rule${n}_active:`);
      L.push(`            rule${n}_active = True`);
      L.push(`            rule${n}_started_at = now`);
      if (r.restart === 'restart') L.push(`            rule${n}_offset = 0   # 再次成立：從頭開始`);
      L.push(`        elif not cond and rule${n}_active:`);
      for (const a of r.actions) {
        if (r.onEnd === 'keep') L.push(a.type === 'servoMap' ? `            ${v(a.comp)}_latched = rule${n}_${v(a.comp)}_map   # 保持上一輪送出的角度` : `            ${v(a.comp)}_latched = ${valueExpr(a, n)}   # 保持結束當下的狀態`);
        else L.push(`            ${v(a.comp)}_latched = ${initial(a.comp)}   # 條件結束：回到初始狀態`);
      }
      const blink = r.actions.find(a => a.type === 'blink');
      if (blink) L.push(`            rule${n}_offset = (rule${n}_offset + now - rule${n}_started_at) % ${blink.onMs + blink.offMs}`);
      L.push(`            rule${n}_active = False`);
    }
    L.push('');
    L.push('        # 4. 合成並輸出（排在後面、正在作用的持續規則優先）');
    for (const c of leds) {
      L.push(`        ${v(c.id)}_out = ${v(c.id)}_latched`);
      for (const [r, i] of whiles) for (const a of r.actions) if (a.comp === c.id) { L.push(`        if rule${i + 1}_active:`); L.push(`            ${v(c.id)}_out = ${valueExpr(a, i + 1)}`); }
      L.push(`        if ${v(c.id)}_out != ${v(c.id)}_written:`);
      L.push(`            ${v(c.id)}.value = 1 if ${v(c.id)}_out else 0`);
      L.push(`            ${v(c.id)}_written = ${v(c.id)}_out`);
    }
    for (const c of servos) {
      L.push(`        ${v(c.id)}_angle = ${v(c.id)}_latched`);
      for (const [r, i] of whiles) for (const a of r.actions) if (a.comp === c.id) { L.push(`        if rule${i + 1}_active:`); if (a.type === 'servoMap') { L.push(`            rule${i + 1}_${v(c.id)}_map = ${valueExpr(a, i + 1)}`); L.push(`            ${v(c.id)}_angle = rule${i + 1}_${v(c.id)}_map`); } else L.push(`            ${v(c.id)}_angle = ${valueExpr(a, i + 1)}`); }
      L.push(`        if ${v(c.id)}_angle != ${v(c.id)}_written:`);
      L.push(`            ${v(c.id)}.angle = ${v(c.id)}_angle`);
      L.push(`            ${v(c.id)}_written = ${v(c.id)}_angle`);
    }
    L.push('');
    L.push('        time.sleep(0.005)   # 約 5 ms 一輪；Linux 排程可能讓實際間隔更長');
    L.push('');
    L.push('');
    L.push('if __name__ == "__main__":');
    L.push('    main()');
    return { code: L.join('\n') + '\n', libs };
  }

  /* ======================= 手改程式的腳位比對 ======================= */
  function scanPins(p, code) {
    const board = DL.boards[p.board.type];
    const found = []; const lines = code.split('\n');
    const resolve = raw => {
      const s = raw.trim();
      if (board.lang === 'python') { if (/^\d+$/.test(s)) return board.pins.find(x => x.kind === 'gpio' && x.num === +s) || 'nopin'; return null; }
      if (/^A\d$/.test(s)) return board.pinById[s] || 'nopin';
      if (/^\d+$/.test(s)) return board.pins.find(x => x.kind === 'gpio' && x.num === +s && !x.code) || board.pins.find(x => x.kind === 'gpio' && x.num === +s) || 'nopin';
      return null;
    };
    lines.forEach((ln, i) => {
      const t = ln.replace(board.lang === 'python' ? /#.*$/ : /\/\/.*$/, '');
      const m = board.lang === 'python' ? t.match(/^\s*([A-Za-z_]\w*)_PIN\s*=\s*(.+?)\s*$/) : t.match(/^\s*(?:static\s+)?(?:const\s+)?(?:int|uint8_t|byte|short|long)\s+([A-Za-z_]\w*)_PIN\s*=\s*([^;]+);/);
      const d = board.lang !== 'python' && t.match(/^\s*#define\s+([A-Za-z_]\w*)_PIN\s+(\S+)/);
      const mm = m || d;
      if (mm) found.push({ name: mm[1].toUpperCase(), expr: mm[2].trim(), line: i + 1, pin: resolve(mm[2]) });
    });
    const res = DL.netlist.analyze(p);
    const items = [];
    const joints = p.arm && p.arm.config ? p.arm.config.joints : [];
    for (const f0 of found) {
      const j = joints.find(x => x.id === f0.name);   // 手臂程式用關節名稱（J1_PIN），對應到該關節的伺服元件
      const us = /^(.+)_(TRIG|ECHO)$/.exec(f0.name); const usc = us && DL.project.findComp(p, us[1]);
      const f = j ? Object.assign({}, f0, { name: j.servo, label: `${j.id}（${j.servo}）` }) : usc && usc.type === 'US' ? Object.assign({}, f0, { name: us[1], label: `${us[1]} ${us[2]}`, part: us[2] }) : f0;   // 超音波有兩個腳位：US1_TRIG_PIN、US1_ECHO_PIN
      const b = res.bindings[f.name];
      if (f.pin === null) { items.push({ level: 'unknown', comp: f.name, line: f.line, msg: `第 ${f.line} 行 ${f.name}_PIN = ${f.expr}：不是固定數字，無法分析是否與接線一致。` }); continue; }
      if (f.pin === 'nopin') { items.push({ level: 'error', comp: f.name, line: f.line, msg: `第 ${f.line} 行 ${f.name}_PIN = ${f.expr}：${board.short} 沒有這個腳位。` }); continue; }
      if (!DL.project.findComp(p, f.name)) { items.push({ level: 'warn', comp: f.name, line: f.line, msg: `第 ${f.line} 行 ${f.name}_PIN：配置中沒有元件 ${f.name}。` }); continue; }
      if (!b) { items.push({ level: 'warn', comp: f.name, line: f.line, msg: `${f.name} 在接線中沒有有效的腳位綁定，無法比對。` }); continue; }
      const want = f.part === 'ECHO' ? b.echo : b.pin;
      if (want !== f.pin.id) items.push({ level: 'mismatch', comp: f.name, line: f.line, codePin: f.pin.id, netPin: want, part: f.part, msg: `${f.label || f.name}：程式第 ${f.line} 行用 ${board.pinLabel(f.pin)}，但接線是 ${board.pinLabel(board.pinById[want])}。編譯可能成功，但行為會與電路不一致。` });
      else items.push({ level: 'ok', comp: f.name, line: f.line, msg: `${f.label || f.name}：程式與接線一致（${board.pinLabel(f.pin)}）。` });
    }
    for (const id of Object.keys(res.bindings)) if (!found.some(f => f.name === id || f.name === id + '_TRIG' || joints.some(j => j.id === f.name && j.servo === id)) && p.behavior.ir.rules.some(r => refsComp(r, id))) items.push({ level: 'warn', comp: id, msg: `程式裡找不到 ${id}_PIN 的定義，無法確認 ${id} 的腳位。` });
    // 直接寫在函式呼叫裡的數字腳位
    const re = board.lang === 'python' ? /\b(?:LED|Button|AngularServo|PWMLED|DigitalOutputDevice|DigitalInputDevice)\(\s*(\d+)/g : /\b(?:pinMode|digitalWrite|digitalRead|analogRead|analogWrite)\s*\(\s*(\d+|A\d)\b/g;
    lines.forEach((ln, i) => { let m; re.lastIndex = 0; while ((m = re.exec(ln))) items.push({ level: 'unknown', line: i + 1, msg: `第 ${i + 1} 行直接使用腳位 ${m[1]}，沒有對應到具名綁定，平台無法判斷它屬於哪個元件。` }); });
    items.push({ level: 'note', msg: '只追蹤「名稱_PIN = 數字」的具名綁定；動態計算的腳位無法完整分析。比對一致或編譯成功，都不代表電路、邏輯或真機安全已通過。' });
    return items;
  }

  DL.codegen = { armSeqText, generate, prepare, scanPins, GENERATOR_VERSION };
  if (typeof module !== 'undefined') module.exports = DL;
})(typeof globalThis !== 'undefined' ? globalThis : this);
