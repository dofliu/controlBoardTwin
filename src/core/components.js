/* DofLab — 元件型錄
 * terminals: 端子（本地座標，單位公分，元件中心為原點，未旋轉時）
 * params: 可調參數與預設值
 * 不在型錄裡的元件，一律回報「未知，未檢查」，不假裝驗證過。
 */
(function (root) {
  const DL = (root.DL = root.DL || {});
  const T = (id, label, x, z, role) => ({ id, label, x, z, role });

  const COMPONENTS = {
    LED: {
      type: 'LED', prefix: 'LED', name: 'LED', model: '5 mm LED',
      terminals: [T('A', '陽極 A（長腳 +）', -0.13, 0.55, 'anode'), T('K', '陰極 K（短腳 −）', 0.13, 0.55, 'cathode')],
      params: { color: { label: '顏色', type: 'select', options: { red: '紅', green: '綠', yellow: '黃', blue: '藍' }, default: 'red' } },
      vf: { red: 2.0, green: 2.1, yellow: 2.0, blue: 3.0 },
      footprint: { w: 0.65, d: 0.65 },
      bb: { holes: { A: [[-0.5, 0]], K: [[0.5, 0]] } },   // 插麵包板時每支腳的孔位（以孔距為單位，相對元件中心）
      ratedmA: 20,
      kind: 'output'
    },
    RES: {
      type: 'RES', prefix: 'R', name: '電阻', model: '1/4 W 碳膜電阻',
      terminals: [T('1', '端子 1', -0.6, 0, 'passive'), T('2', '端子 2', 0.6, 0, 'passive')],
      params: { ohms: { label: '電阻值（Ω）', type: 'number', min: 1, max: 1000000, default: 220 } },
      footprint: { w: 0.75, d: 0.3 },
      bb: { holes: { 1: [[-2, 0]], 2: [[2, 0]] } },   // 兩腳折彎後跨 4 個孔距（0.4 吋）
      kind: 'passive'
    },
    BTN: {
      type: 'BTN', prefix: 'BTN', name: '按鈕', model: '6 mm 輕觸按鈕（兩端子等效）',
      terminals: [T('1', '端子 1', -0.45, 0.45, 'switch'), T('2', '端子 2', 0.45, 0.45, 'switch')],
      params: { debounceMs: { label: '去彈跳時間（ms）', type: 'number', min: 0, max: 500, default: 20, hint: '依實驗設定，不是所有按鈕的通用標準。' } },
      footprint: { w: 0.62, d: 0.62 },
      // 四支腳跨在溝槽兩側：同一號的上下兩腳內部常通（算同一個端子），按下時左右兩號導通
      bb: { holes: { 1: [[-1, -1.5], [-1, 1.5]], 2: [[1, -1.5], [1, 1.5]] } },
      notes: ['四腳輕觸按鈕的同側兩腳內部相通；這裡以兩個端子表示「按下才導通」的兩側。'],
      kind: 'input'
    },
    LDR: {
      type: 'LDR', prefix: 'LDR', name: '光敏模組', model: '光敏電阻分壓模組（類比輸出 AO）',
      terminals: [T('VCC', 'VCC', -0.25, 0.7, 'vcc'), T('GND', 'GND', 0, 0.7, 'gnd'), T('AO', 'AO 類比輸出', 0.25, 0.7, 'analog_out')],
      params: {},
      footprint: { w: 1.4, d: 1.4 },
      bb: { holes: { VCC: [[-1, 2.36]], GND: [[0, 2.36]], AO: [[1, 2.36]] } },   // 三針排針直接插入同一列相鄰三孔
      notes: ['輸出電壓約等於 VCC × 亮度比例；不同模組方向可能相反，請以實物確認。'],
      kind: 'input'
    },
    US: {
      type: 'US', prefix: 'US', name: '超音波測距', model: 'HC-SR04 類超音波測距模組',
      // 模組直立、兩個探頭朝前（本地 −Z），四支排針在下緣：VCC、TRIG、ECHO、GND
      terminals: [T('VCC', 'VCC', -0.381, 0.6, 'vcc'), T('TRIG', 'TRIG 觸發輸入', -0.127, 0.6, 'trig_in'), T('ECHO', 'ECHO 回波輸出', 0.127, 0.6, 'echo_out'), T('GND', 'GND', 0.381, 0.6, 'gnd')],
      params: {
        model: { label: '型號', type: 'select', options: { 'HC-SR04': 'HC-SR04（只能 5 V 供電）', 'HC-SR04P': 'HC-SR04P 類（3.3–5 V 皆可）' }, default: 'HC-SR04' }
      },
      footprint: { w: 4.6, d: 1.6 },
      bb: { holes: { VCC: [[-1.5, 0]], TRIG: [[-0.5, 0]], ECHO: [[0.5, 0]], GND: [[1.5, 0]] } },   // 直立，四支排針插進同一列相鄰四孔
      range: { min: 2, max: 400 },   // 公分；超出量程或沒有回波時，程式一律當成 400 cm
      notes: ['TRIG 收到 10 µs 的高電位脈衝後送出超音波；ECHO 的高電位寬度等於聲波來回的時間（約 58 µs／cm）。', 'ECHO 的高電位約等於 VCC：HC-SR04 接 5 V 時會輸出 5 V，不能直接接到 3.3 V 的 ESP32 或樹莓派。', '量測間隔至少 60 ms；兩顆模組同時量測可能互相干擾。'],
      kind: 'input'
    },
    /* ---- 板載元件：焊在開發板上，不需要接線（onboard: true）；腳位由板型決定 ---- */
    OBLED: {
      type: 'OBLED', prefix: 'OBLED', name: '板載 LED', model: '開發板上的 LED（ESP32 DevKit V1 的藍燈 GPIO2、Uno 的 L 燈 D13）',
      terminals: [], params: {}, footprint: { w: 0.4, d: 0.4 }, onboard: 'led', kind: 'output',
      notes: ['不需要接線，板上已經有限流電阻。', '這顆 LED 和排針上的同一個腳位相連：用了板載 LED，那個腳位就不能再接別的元件。']
    },
    BOOT: {
      type: 'BOOT', prefix: 'BOOT', name: 'BOOT 鍵', model: 'ESP32 開發板上的 BOOT 鍵（GPIO0，按下 = LOW）',
      terminals: [], footprint: { w: 0.4, d: 0.4 }, onboard: 'boot', kind: 'input',
      params: { debounceMs: { label: '去彈跳時間（ms）', type: 'number', min: 0, max: 500, default: 20 } },
      notes: ['程式執行中可以當一般按鈕用。', '按住 BOOT 再按 EN（重置）會進入下載模式，這是上傳程式用的；要讓程式正常啟動，重置時不要按 BOOT。']
    },
    TOUCH: {
      type: 'TOUCH', prefix: 'TOUCH', name: '觸控腳', model: 'ESP32 電容式觸控（手指直接碰排針）',
      terminals: [], footprint: { w: 0.4, d: 0.4 }, onboard: 'touch', kind: 'input',
      params: {
        pin: { label: '觸控腳位', type: 'select', options: { GPIO4: 'T0 · GPIO4（D4）', GPIO15: 'T3 · GPIO15（D15）', GPIO13: 'T4 · GPIO13（D13）', GPIO14: 'T6 · GPIO14（D14）', GPIO27: 'T7 · GPIO27（D27）', GPIO33: 'T8 · GPIO33（D33）', GPIO32: 'T9 · GPIO32（D32）' }, default: 'GPIO4' },
        dropPct: { label: '判定為碰到：讀值比開機基準低幾 %', type: 'number', min: 10, max: 80, default: 40, hint: '開機時不要碰觸控腳，程式會先量基準值。' },
        debounceMs: { label: '去彈跳時間（ms）', type: 'number', min: 0, max: 500, default: 50 }
      },
      notes: ['不需要任何零件：用手指碰排針，或接一條杜邦線當觸控片。', 'touchRead() 的讀值會隨板子、濕度與接線長度改變，所以程式在開機時先量基準值。']
    },
    SERVO: {
      type: 'SERVO', prefix: 'SERVO', name: '伺服馬達', model: 'SG90 類三線伺服（無位置回授）',
      terminals: [T('GND', 'GND（棕）', -0.254, 2.6, 'gnd'), T('VCC', 'VCC（紅）', 0, 2.6, 'vcc'), T('SIG', 'SIG 訊號（橘）', 0.254, 2.6, 'pwm_in')],
      footprint: { w: 3.3, d: 1.3 },
      params: {
        initAngle: { label: '初始角度（°）', type: 'number', min: 0, max: 180, default: 90 }
      },
      notes: ['三線伺服沒有角度回授：畫面只能顯示「命令角度」，不能當成實測角度。', '供電需求依實物核對；從開發板 5V 供電只適合空載測試，負載時建議外部電源並共地。'],
      kind: 'output'
    },
    PSU: {
      type: 'PSU', prefix: 'PSU', name: '外部 5V 電源', model: '5 V／2 A 外部電源模組（教學假設）',
      terminals: [T('VP', '+5V', -0.4, 1.0, 'psu_pos'), T('GND', 'GND', 0.4, 1.0, 'psu_gnd')],
      params: {},
      footprint: { w: 2.4, d: 1.5 },
      notes: ['給伺服馬達等大電流負載用；GND 必須與控制板 GND 相連（共地），+5V 不可接到控制板的 5V 或任何 GPIO。'],
      kind: 'power'
    }
  };
  // 麵包板：每個孔都是一個端子（孔的導通關係見 breadboard.js）
  if (DL.breadboard) COMPONENTS.BB = {
    type: 'BB', prefix: 'BB', name: '麵包板', model: '400 孔半尺寸麵包板',
    terminals: DL.breadboard.HOLES.map(h => T(h.id, DL.breadboard.holeLabel(h.id), h.x, h.z, 'bb')),
    params: {}, footprint: { w: DL.breadboard.SIZE.w, d: DL.breadboard.SIZE.d },
    notes: ['同一號的 a–e 五孔相通、f–j 五孔相通，中間溝槽兩側不通；上下電源排整條相通。', '元件拖到麵包板上會自動插入最近的孔；拖離麵包板就拔出。', '一個孔只能插一支腳或一條導線。'],
    kind: 'passive', holder: true
  };

  function defaultParams(type) {
    const def = COMPONENTS[type]; const out = {};
    if (!def) return out;
    for (const [k, p] of Object.entries(def.params)) out[k] = p.default;
    return out;
  }

  // 依旋轉（0/90/180/270，繞 Y 軸，俯視順時針）把本地端子座標轉成場景座標
  function rotXZ(x, z, rot) {
    const r = ((rot % 360) + 360) % 360;
    if (r === 90) return [-z, x];
    if (r === 180) return [-x, -z];
    if (r === 270) return [z, -x];
    return [x, z];
  }
  function terminalWorld(comp, termId) {
    const def = COMPONENTS[comp.type]; if (!def) return null;
    if (comp.type === 'BB') { const h = DL.breadboard.BY_ID[termId]; if (!h) return null; const [x, z] = rotXZ(h.x, h.z, comp.rot || 0); return { x: comp.pos.x + x, z: comp.pos.z + z }; }
    const t = def.terminals.find(t => t.id === termId); if (!t) return null;
    const [x, z] = rotXZ(t.x, t.z, comp.rot || 0);
    return { x: comp.pos.x + x, z: comp.pos.z + z };
  }

  DL.components = COMPONENTS;
  DL.defaultParams = defaultParams;
  DL.rotXZ = rotXZ;
  DL.terminalWorld = terminalWorld;
  if (typeof module !== 'undefined') module.exports = DL;
})(typeof globalThis !== 'undefined' ? globalThis : this);
