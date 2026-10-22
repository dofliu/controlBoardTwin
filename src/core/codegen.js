/* DofLab — 程式產生器
 * 輸入：板型、網表綁定、元件參數、行為 IR。輸出：可閱讀、可修改的 Arduino C++ 或 Python。
 * 步驟順序與 engine.js 完全相同（讀輸入→開始→事件→持續規則→輸出），以等價測試驗證。
 */
(function (root) {
  const DL = (root.DL = root.DL || {});
  const GENERATOR_VERSION = 'doflab-gen 2.1.0';

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
    if (!(p.arm.poses || []).length) blockers.push('還沒有記錄任何姿態：到「手臂」頁移到想要的位置，按「記下目前姿態」。');
    if (!p.arm.confirmed || p.arm.confirmed.hash !== armHash(p, analysis)) blockers.push('手臂設定與伺服映射尚未確認，或確認後又改變了：請到「手臂」頁確認。');
    return { analysis, bv: { issues: [], ok: true }, inputs: DL.project.inputsHash(p, GENERATOR_VERSION), blockers, arm: true };
  }
  function genArmArduino(p, board, prep) {
    const cfg = p.arm.config; const B = prep.analysis.bindings; const poses = p.arm.poses;
    const L = [];
    L.push(`// ============================================================`);
    L.push(`// DofLab 產生的程式（${GENERATOR_VERSION}）：三自由度手臂姿態播放`);
    L.push(`// 專案：${p.name}　板型：${board.name}（${board.fqbn}）`);
    L.push(`// 輸入雜湊：${prep.inputs}`);
    L.push(`// 依序移到 ${poses.length} 個姿態，每個關節限速 ${cfg.maxSpeed} °/s，到位後停留 1 秒，循環播放。`);
    L.push(`// 角度是送給伺服的命令值；SG90 沒有回授，程式無法知道實際是否到位。`);
    L.push(`// 尺寸、範圍與零位是教學假設：上電前請確認機構不會碰撞，伺服使用外部電源並與控制板共地。`);
    L.push(`// ============================================================`);
    L.push(`#include <${board.libs.servo === 'Servo' ? 'Servo' : 'ESP32Servo'}.h>`);
    L.push('');
    cfg.joints.forEach((j, i) => { const pin = board.pinById[B[j.servo].pin]; L.push(`const int ${j.id}_PIN = ${board.codeName(pin)};`.padEnd(26) + `// ${j.id} ${j.name}：${j.servo} SIG → ${board.pinLabel(pin)}`); });
    L.push('');
    L.push(`const int POSE_COUNT = ${poses.length};`);
    L.push(`const int POSES[POSE_COUNT][3] = {   // 伺服命令角度（已依零位與方向換算）`);
    poses.forEach((ps, k) => { const sv = DL.arm.toServo(cfg, ps.q); L.push(`  {${sv.join(', ')}}${k < poses.length - 1 ? ',' : ''}   // ${ps.name}：目標 (${ps.t.x}, ${ps.t.y}, ${ps.t.z}) cm`); });
    L.push('};');
    L.push(`const float MAX_SPEED = ${Number(cfg.maxSpeed).toFixed(1)};   // °/s（每個關節）`);
    L.push('const unsigned long HOLD_MS = 1000;');
    L.push('');
    L.push('Servo joint[3];');
    L.push('float current[3];');
    L.push('int written[3] = {-1, -1, -1};');
    L.push('int poseIndex = 0;');
    L.push('bool holding = false;');
    L.push('unsigned long lastMs = 0, holdStart = 0;');
    L.push('');
    L.push('void setup() {');
    cfg.joints.forEach((j, i) => L.push(`  joint[${i}].attach(${j.id}_PIN);`));
    L.push('  for (int i = 0; i < 3; i++) { current[i] = POSES[0][i]; joint[i].write(POSES[0][i]); written[i] = POSES[0][i]; }');
    L.push('  lastMs = millis();');
    L.push('}');
    L.push('');
    L.push('void loop() {');
    L.push('  unsigned long now = millis();');
    L.push('  float step = MAX_SPEED * (now - lastMs) / 1000.0;   // 這一輪最多可轉幾度');
    L.push('  lastMs = now;');
    L.push('  bool arrived = true;');
    L.push('  for (int i = 0; i < 3; i++) {');
    L.push('    float target = POSES[poseIndex][i];');
    L.push('    float d = target - current[i];');
    L.push('    if (d > step) { current[i] += step; arrived = false; }');
    L.push('    else if (d < -step) { current[i] -= step; arrived = false; }');
    L.push('    else current[i] = target;');
    L.push('    int a = (int)(current[i] + 0.5);');
    L.push('    if (a != written[i]) { joint[i].write(a); written[i] = a; }');
    L.push('  }');
    L.push('  if (arrived && !holding) { holding = true; holdStart = now; }');
    L.push('  if (holding && now - holdStart >= HOLD_MS) { holding = false; poseIndex = (poseIndex + 1) % POSE_COUNT; }');
    L.push('}');
    return { code: L.join('\n') + '\n', libs: [board.libs.servo] };
  }
  function genArmPython(p, board, prep) {
    const cfg = p.arm.config; const B = prep.analysis.bindings; const poses = p.arm.poses; const L = [];
    L.push('# ============================================================');
    L.push(`# DofLab 產生的程式（${GENERATOR_VERSION}）：三自由度手臂姿態播放`);
    L.push(`# 專案：${p.name}　板型：${board.name}`);
    L.push(`# 輸入雜湊：${prep.inputs}`);
    L.push(`# 依序移到 ${poses.length} 個姿態，每個關節限速 ${cfg.maxSpeed} °/s，到位後停留 1 秒，循環播放。`);
    L.push('# 角度是命令值；SG90 沒有回授。尺寸、範圍與零位是教學假設，上電前請確認機構不會碰撞。');
    L.push('# ============================================================');
    L.push('import time');
    L.push('from gpiozero import AngularServo');
    L.push('');
    cfg.joints.forEach(j => { const pin = board.pinById[B[j.servo].pin]; L.push(`${j.id}_PIN = ${pin.num}`.padEnd(16) + `# ${j.id} ${j.name}：${j.servo} SIG → ${board.pinLabel(pin)}`); });
    L.push('POSES = [   # 伺服命令角度（已依零位與方向換算）');
    poses.forEach(ps => { const sv = DL.arm.toServo(cfg, ps.q); L.push(`    (${sv.join(', ')}),   # ${ps.name}`); });
    L.push(']');
    L.push(`MAX_SPEED = ${Number(cfg.maxSpeed).toFixed(1)}   # °/s`);
    L.push('HOLD_S = 1.0');
    L.push('');
    L.push('');
    L.push('def main():');
    L.push(`    joints = [AngularServo(p, min_angle=0, max_angle=180, min_pulse_width=0.0005, max_pulse_width=0.0024) for p in (${cfg.joints.map(j => j.id + '_PIN').join(', ')})]`);
    L.push('    current = list(POSES[0])');
    L.push('    for s, a in zip(joints, current):');
    L.push('        s.angle = a');
    L.push('    index, holding, hold_start = 0, False, 0.0');
    L.push('    last = time.monotonic()');
    L.push('    print("DofLab：姿態播放程式開始執行（Ctrl+C 結束）", flush=True)');
    L.push('    while True:');
    L.push('        now = time.monotonic()');
    L.push('        step = MAX_SPEED * (now - last)');
    L.push('        last = now');
    L.push('        arrived = True');
    L.push('        for i in range(3):');
    L.push('            d = POSES[index][i] - current[i]');
    L.push('            if abs(d) > step:');
    L.push('                current[i] += step if d > 0 else -step');
    L.push('                arrived = False');
    L.push('            else:');
    L.push('                current[i] = POSES[index][i]');
    L.push('            joints[i].angle = round(current[i])');
    L.push('        if arrived and not holding:');
    L.push('            holding, hold_start = True, now');
    L.push('        if holding and now - hold_start >= HOLD_S:');
    L.push('            holding = False');
    L.push('            index = (index + 1) % len(POSES)');
    L.push('        time.sleep(0.02)');
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
  const used = (p, type) => p.components.filter(c => c.type === type && p.behavior.ir.rules.some(r => refsComp(r, c.id)));
  function refsComp(r, id) { return r.comp === id || (r.cond && r.cond.comp === id) || (r.actions || []).some(a => a.comp === id); }

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
    const btns = used(p, 'BTN'), leds = p.components.filter(c => c.type === 'LED' && B[c.id]), ldrs = used(p, 'LDR'), servos = p.components.filter(c => c.type === 'SERVO' && B[c.id]);
    const adcMax = (1 << board.adcBits) - 1;
    const libs = [];
    const L = headerLines(p, board, prep, '//');
    if (servos.length) { libs.push(board.libs.servo); L.push(`#include <${board.libs.servo === 'Servo' ? 'Servo' : 'ESP32Servo'}.h>${board.libs.servo === 'Servo' ? '   // Arduino 內建函式庫' : '   // 需安裝函式庫：ESP32Servo'}`); }
    L.push('');
    L.push('// ---- 腳位綁定（由網表產生；手動修改後，「程式」頁會比對是否與接線一致）----');
    const pinComment = (c) => {
      const b = B[c.id]; const pin = board.pinById[b.pin];
      if (c.type === 'BTN') return `${c.id}：${board.pinLabel(pin)} ↔ 按鈕 ↔ GND，內建上拉，按下 = LOW`;
      if (c.type === 'LED') return `${c.id}：${board.pinLabel(pin)} → ${b.via.join('、')} → LED → GND`;
      if (c.type === 'LDR') return `${c.id}：AO → ${board.pinLabel(pin)}（0–${adcMax}）`;
      if (c.type === 'SERVO') return `${c.id}：SIG → ${board.pinLabel(pin)}（只送出命令角度，沒有回授）`;
    };
    for (const c of [...btns, ...leds, ...ldrs, ...servos]) {
      const b = B[c.id]; const pin = board.pinById[b.pin];
      L.push(`const int ${c.id}_PIN = ${board.codeName(pin)};`.padEnd(30) + `// ${pinComment(c)}`);
    }
    if (btns.length) { L.push(''); L.push('// ---- 參數 ----'); for (const c of btns) L.push(`const unsigned long ${c.id}_DEBOUNCE_MS = ${c.params.debounceMs};   // 去彈跳時間（實驗設定）`); }
    L.push('');
    L.push('// ---- 狀態 ----');
    for (const c of btns) {
      L.push(`bool ${v(c.id)}Stable = false;          // 去彈跳後的狀態：true = 按下`);
      L.push(`bool ${v(c.id)}LastRaw = false;`);
      L.push(`unsigned long ${v(c.id)}ChangedAt = 0;`);
      L.push(`bool ${v(c.id)}Pressed = false;         // 這一輪剛按下`);
      L.push(`bool ${v(c.id)}Released = false;        // 這一輪剛放開`);
    }
    for (const c of leds) L.push(`bool ${v(c.id)}Latched = false;         // 沒有持續規則作用時 ${c.id} 的狀態`);
    for (const c of servos) { L.push(`int ${v(c.id)}Latched = ${c.params.initAngle};`); L.push(`int ${v(c.id)}Written = -1;`); L.push(`Servo ${v(c.id)}Servo;`); }
    rules.forEach((r, i) => { if (r.type === 'while') L.push(`bool rule${i + 1}Active = false;  unsigned long rule${i + 1}StartedAt = 0;  unsigned long rule${i + 1}Offset = 0;`); });
    L.push('');
    for (const c of btns) {
      const n = v(c.id);
      L.push(`// 讀取 ${c.id} 並去彈跳：原始讀值要穩定 ${c.id}_DEBOUNCE_MS 才更新狀態`);
      L.push(`void read${c.id}(unsigned long now) {`);
      L.push(`  bool raw = (digitalRead(${c.id}_PIN) == LOW);   // 接 GND＋上拉：按下讀到 LOW`);
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
    const instant = (a, ind) => {
      if (a.type === 'led') return `${ind}${v(a.comp)}Latched = ${a.on ? 'true' : 'false'};`;
      if (a.type === 'toggle') return `${ind}${v(a.comp)}Latched = !${v(a.comp)}Latched;`;
      if (a.type === 'servo') return `${ind}${v(a.comp)}Latched = ${a.angle};`;
    };
    const valueExpr = (a, i) => {
      if (a.type === 'led') return a.on ? 'true' : 'false';
      if (a.type === 'servo') return String(a.angle);
      if (a.type === 'blink') return `((rule${i}Offset + now - rule${i}StartedAt) % ${a.onMs + a.offMs}UL) < ${a.onMs}UL`;
    };
    const condExpr = c => c.type === 'pressed' ? `${v(c.comp)}Stable` : `${v(c.comp)}Pct ${c.op === 'lt' ? '<' : '>'} ${c.value}`;
    const initial = id => { const c = DL.project.findComp(p, id); return c.type === 'SERVO' ? String(c.params.initAngle) : 'false'; };

    L.push('void setup() {');
    for (const c of btns) L.push(`  pinMode(${c.id}_PIN, INPUT_PULLUP);`);
    for (const c of leds) { L.push(`  pinMode(${c.id}_PIN, OUTPUT);`); L.push(`  digitalWrite(${c.id}_PIN, LOW);`); }
    for (const c of servos) L.push(`  ${v(c.id)}Servo.attach(${c.id}_PIN);`);
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
        if (r.onEnd === 'keep') L.push(`      ${v(a.comp)}Latched = ${valueExpr(a, n)};   // 保持結束當下的狀態`);
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
      for (const [r, i] of whiles) for (const a of r.actions) if (a.comp === c.id) L.push(`  if (rule${i + 1}Active) ${v(c.id)}Angle = ${valueExpr(a, i + 1)};`);
      L.push(`  if (${v(c.id)}Angle != ${v(c.id)}Written) { ${v(c.id)}Servo.write(${v(c.id)}Angle); ${v(c.id)}Written = ${v(c.id)}Angle; }`);
    }
    L.push('}');
    return { code: L.join('\n') + '\n', libs };
  }

  /* ======================= Python（Raspberry Pi · gpiozero） ======================= */
  function genPython(p, board, prep) {
    const B = prep.analysis.bindings;
    const rules = p.behavior.ir.rules;
    const btns = used(p, 'BTN'), leds = p.components.filter(c => c.type === 'LED' && B[c.id]), servos = p.components.filter(c => c.type === 'SERVO' && B[c.id]);
    const libs = ['gpiozero'];
    const L = headerLines(p, board, prep, '#');
    L.push('import time');
    const imp = [leds.length && 'LED', btns.length && 'Button', servos.length && 'AngularServo'].filter(Boolean);
    if (imp.length) L.push(`from gpiozero import ${imp.join(', ')}`);
    L.push('');
    L.push('# ---- 腳位綁定（BCM GPIO 編號；由網表產生，手動修改後「程式」頁會比對一致性）----');
    for (const c of [...btns, ...leds, ...servos]) {
      const b = B[c.id]; const pin = board.pinById[b.pin];
      const note = c.type === 'BTN' ? `${board.pinLabel(pin)} ↔ 按鈕 ↔ GND，內建上拉` : c.type === 'LED' ? `${board.pinLabel(pin)} → ${b.via.join('、')} → LED → GND` : `SIG → ${board.pinLabel(pin)}，只送出命令角度`;
      L.push(`${c.id}_PIN = ${pin.num}`.padEnd(18) + `# ${c.id}：${note}`);
    }
    for (const c of btns) L.push(`${c.id}_DEBOUNCE_MS = ${c.params.debounceMs}   # 去彈跳時間（實驗設定）`);
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
    L.push('');
    L.push('def main():');
    for (const c of btns) L.push(`    ${v(c.id)} = DebouncedButton(${c.id}_PIN, ${c.id}_DEBOUNCE_MS)`);
    for (const c of leds) L.push(`    ${v(c.id)} = LED(${c.id}_PIN)`);
    for (const c of servos) L.push(`    ${v(c.id)} = AngularServo(${c.id}_PIN, min_angle=0, max_angle=180, min_pulse_width=0.0005, max_pulse_width=0.0024)  # 脈寬為教學假設，請依實物調整`);
    for (const c of leds) L.push(`    ${v(c.id)}_latched = False`);
    for (const c of servos) { L.push(`    ${v(c.id)}_latched = ${c.params.initAngle}`); L.push(`    ${v(c.id)}_written = None`); }
    for (const c of leds) L.push(`    ${v(c.id)}_written = None`);
    rules.forEach((r, i) => { if (r.type === 'while') L.push(`    rule${i + 1}_active = False; rule${i + 1}_started_at = 0; rule${i + 1}_offset = 0`); });
    const instant = (a, ind) => {
      if (a.type === 'led') return `${ind}${v(a.comp)}_latched = ${a.on ? 'True' : 'False'}`;
      if (a.type === 'toggle') return `${ind}${v(a.comp)}_latched = not ${v(a.comp)}_latched`;
      if (a.type === 'servo') return `${ind}${v(a.comp)}_latched = ${a.angle}`;
    };
    const valueExpr = (a, i) => {
      if (a.type === 'led') return a.on ? 'True' : 'False';
      if (a.type === 'servo') return String(a.angle);
      if (a.type === 'blink') return `((rule${i}_offset + now - rule${i}_started_at) % ${a.onMs + a.offMs}) < ${a.onMs}`;
    };
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
    if (!btns.length) L.push('        pass');
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
      L.push(`        cond = ${v(r.cond.comp)}.stable   # 規則 ${n}`);
      L.push(`        if cond and not rule${n}_active:`);
      L.push(`            rule${n}_active = True`);
      L.push(`            rule${n}_started_at = now`);
      if (r.restart === 'restart') L.push(`            rule${n}_offset = 0   # 再次成立：從頭開始`);
      L.push(`        elif not cond and rule${n}_active:`);
      for (const a of r.actions) {
        if (r.onEnd === 'keep') L.push(`            ${v(a.comp)}_latched = ${valueExpr(a, n)}   # 保持結束當下的狀態`);
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
      for (const [r, i] of whiles) for (const a of r.actions) if (a.comp === c.id) { L.push(`        if rule${i + 1}_active:`); L.push(`            ${v(c.id)}_angle = ${valueExpr(a, i + 1)}`); }
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
      const f = j ? Object.assign({}, f0, { name: j.servo, label: `${j.id}（${j.servo}）` }) : f0;
      const b = res.bindings[f.name];
      if (f.pin === null) { items.push({ level: 'unknown', comp: f.name, line: f.line, msg: `第 ${f.line} 行 ${f.name}_PIN = ${f.expr}：不是固定數字，無法分析是否與接線一致。` }); continue; }
      if (f.pin === 'nopin') { items.push({ level: 'error', comp: f.name, line: f.line, msg: `第 ${f.line} 行 ${f.name}_PIN = ${f.expr}：${board.short} 沒有這個腳位。` }); continue; }
      if (!DL.project.findComp(p, f.name)) { items.push({ level: 'warn', comp: f.name, line: f.line, msg: `第 ${f.line} 行 ${f.name}_PIN：配置中沒有元件 ${f.name}。` }); continue; }
      if (!b) { items.push({ level: 'warn', comp: f.name, line: f.line, msg: `${f.name} 在接線中沒有有效的腳位綁定，無法比對。` }); continue; }
      if (b.pin !== f.pin.id) items.push({ level: 'mismatch', comp: f.name, line: f.line, codePin: f.pin.id, netPin: b.pin, msg: `${f.label || f.name}：程式第 ${f.line} 行用 ${board.pinLabel(f.pin)}，但接線是 ${board.pinLabel(board.pinById[b.pin])}。編譯可能成功，但行為會與電路不一致。` });
      else items.push({ level: 'ok', comp: f.name, line: f.line, msg: `${f.label || f.name}：程式與接線一致（${board.pinLabel(f.pin)}）。` });
    }
    for (const id of Object.keys(res.bindings)) if (!found.some(f => f.name === id || joints.some(j => j.id === f.name && j.servo === id)) && p.behavior.ir.rules.some(r => refsComp(r, id))) items.push({ level: 'warn', comp: id, msg: `程式裡找不到 ${id}_PIN 的定義，無法確認 ${id} 的腳位。` });
    // 直接寫在函式呼叫裡的數字腳位
    const re = board.lang === 'python' ? /\b(?:LED|Button|AngularServo|PWMLED|DigitalOutputDevice|DigitalInputDevice)\(\s*(\d+)/g : /\b(?:pinMode|digitalWrite|digitalRead|analogRead|analogWrite)\s*\(\s*(\d+|A\d)\b/g;
    lines.forEach((ln, i) => { let m; re.lastIndex = 0; while ((m = re.exec(ln))) items.push({ level: 'unknown', line: i + 1, msg: `第 ${i + 1} 行直接使用腳位 ${m[1]}，沒有對應到具名綁定，平台無法判斷它屬於哪個元件。` }); });
    items.push({ level: 'note', msg: '只追蹤「名稱_PIN = 數字」的具名綁定；動態計算的腳位無法完整分析。比對一致或編譯成功，都不代表電路、邏輯或真機安全已通過。' });
    return items;
  }

  DL.codegen = { generate, prepare, scanPins, GENERATOR_VERSION };
  if (typeof module !== 'undefined') module.exports = DL;
})(typeof globalThis !== 'undefined' ? globalThis : this);
