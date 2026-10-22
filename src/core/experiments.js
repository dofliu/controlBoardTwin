/* DofLab — 引導實驗
 * 引導實驗是唯讀範本：開啟時建立一份「引導專案」，元件與行為鎖定，只開放接線；
 * 要自由修改時「複製為自訂專案」，原範本不受影響。
 */
(function (root) {
  const DL = (root.DL = root.DL || {});

  const HOLD_BLINK = [
    { type: 'while', cond: { type: 'pressed', comp: 'BTN1' }, actions: [{ type: 'blink', comp: 'LED1', onMs: 500, offMs: 500 }], onEnd: 'off', restart: 'restart' }
  ];

  const EXPERIMENTS = [
    {
      id: 'hold-blink', title: '按住閃爍', boards: ['uno', 'esp32', 'pi4b'],
      goal: '按住 BTN1 時，LED1 亮 500 ms、暗 500 ms 反覆閃爍（1 Hz）；放開時立即熄滅；再次按下從亮燈開始。',
      parts: [['BTN', 7.5, 2.2, 0], ['RES', 8.2, -1.6, 0], ['LED', 10.6, -1.8, 0]],
      suggest: { uno: { BTN1: 'D2', LED1: 'D13' }, esp32: { BTN1: 'GPIO4', LED1: 'GPIO23' }, pi4b: { BTN1: 'GPIO27', LED1: 'GPIO17' } },
      rules: HOLD_BLINK,
      tasks: [
        { text: 'BTN1 一端接 GPIO、另一端接 GND', check: (p, a) => !!a.bindings.BTN1 },
        { text: 'LED1 經 R1 接到 GPIO，陰極接 GND', check: (p, a) => !!(a.bindings.LED1 && a.bindings.LED1.via.length) },
        { text: '配置檢查沒有錯誤', check: (p, a) => a.ok && a.counts.unknown === 0 },
        { text: '在「行為」頁確認行為摘要', check: (p, a, ctx) => !!ctx.confirmedCurrent },
        { text: '在「觀測」頁按住 BTN1 超過 1.5 秒，看 LED1 閃爍', check: (p, a, ctx) => ctx.maxHoldMs >= 1500 }
      ]
    },
    {
      id: 'night-light', title: '光控夜燈', boards: ['uno', 'esp32'],
      goal: '環境亮度低於 30 % 時 LED1 亮；回到 30 % 以上時熄滅。練習類比輸入與 ADC 腳位。',
      unsupported: { pi4b: 'Raspberry Pi 4B 沒有內建類比輸入（ADC），這個實驗需要外接 ADC 模組，本版未支援。' },
      parts: [['LDR', 7.8, 2.4, 0], ['RES', 8.2, -1.6, 0], ['LED', 10.6, -1.8, 0]],
      suggest: { uno: { LDR1: 'A0（VCC 接 5V）', LED1: 'D13' }, esp32: { LDR1: 'GPIO34（VCC 接 3V3）', LED1: 'GPIO23' } },
      rules: [{ type: 'while', cond: { type: 'light', comp: 'LDR1', op: 'lt', value: 30 }, actions: [{ type: 'led', comp: 'LED1', on: true }], onEnd: 'off', restart: 'restart' }],
      tasks: [
        { text: 'LDR1 的 VCC、GND、AO 都接好，AO 接到有 ADC 的腳位', check: (p, a) => !!a.bindings.LDR1 },
        { text: 'LED1 經 R1 接到 GPIO', check: (p, a) => !!(a.bindings.LED1 && a.bindings.LED1.via.length) },
        { text: '配置檢查沒有錯誤', check: (p, a) => a.ok },
        { text: '確認行為摘要', check: (p, a, ctx) => !!ctx.confirmedCurrent },
        { text: '在「觀測」頁把亮度拉到 30 % 以下', check: (p, a, ctx) => ctx.minLight < 30 }
      ]
    },
    {
      id: 'servo-cmd', title: '伺服角度命令', boards: ['uno', 'esp32', 'pi4b'],
      goal: '按下 BTN1 時 SERVO1 命令轉到 150°，放開時命令轉到 30°。觀察「命令角度」與「量測角度（未知）」的差別。',
      parts: [['BTN', 7.5, 2.4, 0], ['SERVO', 10.4, -1.4, 0]],
      suggest: { uno: { BTN1: 'D2', SERVO1: 'D9' }, esp32: { BTN1: 'GPIO4', SERVO1: 'GPIO18' }, pi4b: { BTN1: 'GPIO27', SERVO1: 'GPIO18' } },
      rules: [
        { type: 'event', event: 'press', comp: 'BTN1', actions: [{ type: 'servo', comp: 'SERVO1', angle: 150 }] },
        { type: 'event', event: 'release', comp: 'BTN1', actions: [{ type: 'servo', comp: 'SERVO1', angle: 30 }] }
      ],
      tasks: [
        { text: 'BTN1 接 GPIO 與 GND', check: (p, a) => !!a.bindings.BTN1 },
        { text: 'SERVO1 的 SIG、VCC、GND 都接好', check: (p, a) => !!a.bindings.SERVO1 && !a.issues.some(i => i.level === 'error') },
        { text: '確認行為摘要', check: (p, a, ctx) => !!ctx.confirmedCurrent },
        { text: '在「觀測」頁按一下 BTN1，看命令角度改變', check: (p, a, ctx) => ctx.presses >= 1 }
      ]
    }
  ];

  // 麵包板版本：元件已插在麵包板上，學生用導線把控制板接到正確的導通條
  EXPERIMENTS.push({
    id: 'hold-blink-bb', title: '按住閃爍（麵包板）', boards: ['uno', 'esp32', 'pi4b'],
    goal: '和「按住閃爍」相同的行為，但元件插在麵包板上。練習麵包板的導通規則：同一號的 a–e 相通、f–j 相通，電源排整條相通。',
    parts: [['BB', 11.6, 0.2, 0], ['BTN', { on: 'BB1', hole: 'e5' }, 0], ['RES', { on: 'BB1', hole: 'c14' }, 0], ['LED', { on: 'BB1', hole: 'e18' }, 0]],
    suggest: { uno: { BTN1: 'D2', LED1: 'D13' }, esp32: { BTN1: 'GPIO4', LED1: 'GPIO23' }, pi4b: { BTN1: 'GPIO27', LED1: 'GPIO17' } },
    bbWires: [['pin:BTN1', 'a5'], ['pin:LED1', 'a14'], ['a7', 'TN3'], ['a19', 'TN15'], ['gnd', 'TN1']],
    rules: HOLD_BLINK,
    tasks: [
      { text: '控制板 GND 接到麵包板的 − 電源排', check: (p, a) => a.nets.some(n => n.gnd.some(g => !g.external) && (n.bb || []).some(b => /^(TN|BN)$/.test(b.bus))) },
      { text: 'BTN1 的一側接 GPIO、另一側接到 − 電源排', check: (p, a) => !!a.bindings.BTN1 },
      { text: 'LED1 經 R1 接到 GPIO，陰極那一號接到 − 電源排', check: (p, a) => !!(a.bindings.LED1 && a.bindings.LED1.via.length) },
      { text: '配置檢查沒有錯誤', check: (p, a) => a.ok && a.counts.unknown === 0 },
      { text: '在「行為」頁確認行為摘要', check: (p, a, ctx) => !!ctx.confirmedCurrent },
      { text: '在「觀測」頁按住 BTN1 超過 1.5 秒，看 LED1 閃爍', check: (p, a, ctx) => ctx.maxHoldMs >= 1500 }
    ]
  });

  /* ---------- V2.4 新增的引導實驗（解答由接線助手產生：auto: true） ---------- */
  const bound = id => (p, a) => !!a.bindings[id];
  const ledR = id => (p, a) => !!(a.bindings[id] && a.bindings[id].via.length);
  EXPERIMENTS.push({
    id: 'toggle-led', title: '按一下切換', boards: ['uno', 'esp32', 'pi4b'], auto: true,
    goal: '每按一下 BTN1（按下的那一刻），LED1 就在亮與滅之間切換一次；按住不放不會連續切換。練習「事件」和「持續條件」的差別。',
    parts: [['BTN', 7.5, 2.2, 0], ['RES', 8.2, -1.6, 0], ['LED', 10.6, -1.8, 0]],
    suggest: { uno: { BTN1: 'D2', LED1: 'D13' }, esp32: { BTN1: 'GPIO4', LED1: 'GPIO23' }, pi4b: { BTN1: 'GPIO27', LED1: 'GPIO17' } },
    rules: [{ type: 'event', event: 'press', comp: 'BTN1', actions: [{ type: 'toggle', comp: 'LED1' }] }],
    tasks: [
      { text: 'BTN1 一端接 GPIO、另一端接 GND', check: bound('BTN1') },
      { text: 'LED1 經 R1 接到 GPIO，陰極接 GND', check: ledR('LED1') },
      { text: '配置檢查沒有錯誤', check: (p, a) => a.ok && a.counts.unknown === 0 },
      { text: '在「行為」頁確認行為摘要', check: (p, a, ctx) => !!ctx.confirmedCurrent },
      { text: '在「觀測」頁按 BTN1 至少兩次，看 LED1 亮、滅切換', check: (p, a, ctx) => ctx.presses >= 2 }
    ]
  });
  EXPERIMENTS.push({
    id: 'ped-light', title: '行人按鈕紅綠燈', boards: ['uno', 'esp32', 'pi4b'], auto: true,
    goal: '平常綠燈 LED2 亮；行人按住 BTN1 時改成紅燈 LED1 亮、綠燈熄滅；放開後回到綠燈。練習「開始時」與兩個按鈕事件。',
    parts: [['BTN', 7.2, 2.6, 0], ['RES', 8.2, -2.2, 0], ['LED', 10.6, -2.4, 0, { color: 'red' }], ['RES', 8.2, -0.2, 0], ['LED', 10.6, -0.4, 0, { color: 'green' }]],
    suggest: { uno: { BTN1: 'D2', LED1: 'D13', LED2: 'D12' }, esp32: { BTN1: 'GPIO4', LED1: 'GPIO23', LED2: 'GPIO22' }, pi4b: { BTN1: 'GPIO27', LED1: 'GPIO17', LED2: 'GPIO23' } },
    rules: [
      { type: 'start', actions: [{ type: 'led', comp: 'LED2', on: true }] },
      { type: 'event', event: 'press', comp: 'BTN1', actions: [{ type: 'led', comp: 'LED1', on: true }, { type: 'led', comp: 'LED2', on: false }] },
      { type: 'event', event: 'release', comp: 'BTN1', actions: [{ type: 'led', comp: 'LED1', on: false }, { type: 'led', comp: 'LED2', on: true }] }
    ],
    tasks: [
      { text: 'BTN1 接 GPIO 與 GND', check: bound('BTN1') },
      { text: '紅燈 LED1 經 R1、綠燈 LED2 經 R2 各接一個 GPIO', check: (p, a) => ledR('LED1')(p, a) && ledR('LED2')(p, a) },
      { text: '配置檢查沒有錯誤', check: (p, a) => a.ok && a.counts.unknown === 0 },
      { text: '在「行為」頁確認行為摘要', check: (p, a, ctx) => !!ctx.confirmedCurrent },
      { text: '在「觀測」頁按住 BTN1，看紅綠燈切換', check: (p, a, ctx) => ctx.presses >= 1 }
    ]
  });
  EXPERIMENTS.push({
    id: 'bright-alarm', title: '太亮警示', boards: ['uno', 'esp32'], auto: true,
    unsupported: { pi4b: 'Raspberry Pi 4B 沒有內建類比輸入（ADC），這個實驗需要外接 ADC 模組，本版未支援。' },
    goal: '環境亮度高於 70 % 時 LED1 快速閃爍（亮 100 ms、暗 100 ms）警示；降到 70 % 以下立即熄滅。和「光控夜燈」相反：比較「高於」與「低於」。',
    parts: [['LDR', 7.8, 2.4, 0], ['RES', 8.2, -1.6, 0], ['LED', 10.6, -1.8, 0, { color: 'yellow' }]],
    suggest: { uno: { LDR1: 'A0', LED1: 'D13' }, esp32: { LDR1: 'GPIO34', LED1: 'GPIO23' } },
    rules: [{ type: 'while', cond: { type: 'light', comp: 'LDR1', op: 'gt', value: 70 }, actions: [{ type: 'blink', comp: 'LED1', onMs: 100, offMs: 100 }], onEnd: 'off', restart: 'restart' }],
    tasks: [
      { text: 'LDR1 的 VCC、GND、AO 都接好，AO 接到有 ADC 的腳位', check: bound('LDR1') },
      { text: 'LED1 經 R1 接到 GPIO', check: ledR('LED1') },
      { text: '配置檢查沒有錯誤', check: (p, a) => a.ok },
      { text: '確認行為摘要', check: (p, a, ctx) => !!ctx.confirmedCurrent },
      { text: '在「觀測」頁把亮度拉到 70 % 以上', check: (p, a, ctx) => ctx.maxLight > 70 }
    ]
  });
  EXPERIMENTS.push({
    id: 'sun-shade', title: '光控遮陽板', boards: ['uno', 'esp32'], auto: true,
    unsupported: { pi4b: 'Raspberry Pi 4B 沒有內建類比輸入（ADC），這個實驗需要外接 ADC 模組，本版未支援。' },
    goal: '亮度高於 60 % 時 SERVO1 命令轉到 150°（放下遮陽板）；亮度回到 60 % 以下時回到初始的 30°。伺服沒有回授：畫面顯示的是命令角度。',
    parts: [['LDR', 7.4, 2.8, 0], ['SERVO', 10.4, -1.6, 0, { initAngle: 30 }]],
    suggest: { uno: { LDR1: 'A0', SERVO1: 'D9' }, esp32: { LDR1: 'GPIO34', SERVO1: 'GPIO18' } },
    rules: [{ type: 'while', cond: { type: 'light', comp: 'LDR1', op: 'gt', value: 60 }, actions: [{ type: 'servo', comp: 'SERVO1', angle: 150 }], onEnd: 'off', restart: 'restart' }],
    tasks: [
      { text: 'LDR1 接好，AO 接到有 ADC 的腳位', check: bound('LDR1') },
      { text: 'SERVO1 的 SIG、VCC、GND 都接好', check: (p, a) => !!a.bindings.SERVO1 && !a.issues.some(i => i.level === 'error') },
      { text: '確認行為摘要', check: (p, a, ctx) => !!ctx.confirmedCurrent },
      { text: '在「觀測」頁把亮度拉到 60 % 以上再拉回來，看命令角度變化', check: (p, a, ctx) => ctx.maxLight > 60 && ctx.minLight <= 60 }
    ]
  });
  EXPERIMENTS.push({
    id: 'bb-two-toggles', title: '雙按鈕雙燈（麵包板）', boards: ['uno', 'esp32', 'pi4b'], auto: true,
    goal: '麵包板上兩組按鈕與 LED：按一下 BTN1 切換 LED1，按一下 BTN2 切換 LED2，兩組互不影響。練習在麵包板上分配導通條、共用 − 電源排。',
    parts: [['BB', 11.6, 0.2, 0], ['BTN', { on: 'BB1', hole: 'e4' }, 0], ['BTN', { on: 'BB1', hole: 'e10' }, 0], ['RES', { on: 'BB1', hole: 'c15' }, 0], ['LED', { on: 'BB1', hole: 'e19' }, 0], ['RES', { on: 'BB1', hole: 'c22' }, 0], ['LED', { on: 'BB1', hole: 'e26' }, 0, { color: 'green' }]],
    suggest: { uno: { BTN1: 'D2', BTN2: 'D3', LED1: 'D13', LED2: 'D12' }, esp32: { BTN1: 'GPIO4', BTN2: 'GPIO16', LED1: 'GPIO23', LED2: 'GPIO22' }, pi4b: { BTN1: 'GPIO27', BTN2: 'GPIO22', LED1: 'GPIO17', LED2: 'GPIO23' } },
    rules: [
      { type: 'event', event: 'press', comp: 'BTN1', actions: [{ type: 'toggle', comp: 'LED1' }] },
      { type: 'event', event: 'press', comp: 'BTN2', actions: [{ type: 'toggle', comp: 'LED2' }] }
    ],
    tasks: [
      { text: '控制板 GND 接到麵包板的 − 電源排', check: (p, a) => a.nets.some(n => n.gnd.some(g => !g.external) && (n.bb || []).some(b => /^(TN|BN)$/.test(b.bus))) },
      { text: 'BTN1、BTN2 各接一個 GPIO，另一側接 − 電源排', check: (p, a) => !!(a.bindings.BTN1 && a.bindings.BTN2) },
      { text: 'LED1、LED2 各經自己的電阻接到 GPIO', check: (p, a) => ledR('LED1')(p, a) && ledR('LED2')(p, a) },
      { text: '配置檢查沒有錯誤', check: (p, a) => a.ok && a.counts.unknown === 0 },
      { text: '在「行為」頁確認行為摘要', check: (p, a, ctx) => !!ctx.confirmedCurrent },
      { text: '在「觀測」頁兩個按鈕都按一下', check: (p, a, ctx) => ctx.presses >= 2 }
    ]
  });

  EXPERIMENTS.push({
    id: 'arm-3dof', title: '三軸機械手臂', boards: ['uno', 'esp32', 'pi4b'],
    goal: '三顆伺服組成底座、肩、肘三個關節。在「手臂」頁拖曳目標點，觀察逆運動學、關節限位、不可達提示與限速；伺服由外部 5V 供電並與控制板共地。',
    parts: [['SERVO', 9.5, -6.0, 0], ['SERVO', 9.5, -0.6, 0], ['SERVO', 9.5, 4.8, 0], ['PSU', 16.5, 0.6, 0]],
    suggest: { uno: { SERVO1: 'D9', SERVO2: 'D10', SERVO3: 'D11' }, esp32: { SERVO1: 'GPIO18', SERVO2: 'GPIO19', SERVO3: 'GPIO21' }, pi4b: { SERVO1: 'GPIO12', SERVO2: 'GPIO13', SERVO3: 'GPIO18' } },
    rules: [], arm: true,
    tasks: [
      { text: '三顆伺服的 SIG 都接到可輸出伺服脈波的腳位', check: (p, a) => ['SERVO1', 'SERVO2', 'SERVO3'].every(id => a.bindings[id]) },
      { text: '伺服 VCC 接外部電源 +5V，GND 接外部電源 GND', check: (p, a) => ['SERVO1', 'SERVO2', 'SERVO3'].every(id => a.issues.some(i => i.code === 'servo_ext_power' && i.refs.includes(id))) },
      { text: '外部電源 GND 與控制板 GND 相連（共地），檢查沒有錯誤', check: (p, a) => a.ok },
      { text: '在「手臂」頁確認設定與伺服映射', check: (p, a, ctx) => !!ctx.armConfirmed },
      { text: '拖曳或輸入一個不可達的目標，看手臂保留最後有效命令', check: (p, a, ctx) => !!ctx.armSawInvalid },
      { text: '記下至少兩個姿態', check: (p) => !!(p.arm && p.arm.poses && p.arm.poses.length >= 2) }
    ]
  });

  function instantiate(expId, boardId) {
    const e = EXPERIMENTS.find(x => x.id === expId);
    if (!e) throw new Error('找不到實驗 ' + expId);
    if (!e.boards.includes(boardId)) return { ok: false, msg: (e.unsupported && e.unsupported[boardId]) || '這個實驗不支援此板型。' };
    const p = DL.project.create(boardId, { name: `引導：${e.title}（${DL.boards[boardId].short}）`, origin: { kind: 'guided', experimentId: e.id } });
    for (const part of e.parts) {
      const [type, x, z, rot] = part; const params = typeof x === 'object' ? part[3] : part[4]; let r;
      if (typeof x === 'object') { r = DL.project.addComponent(p, type, { x: 0, z: 0 }, z || 0); placeOn(p, r.comp.id, x.on, x.hole); }
      else r = DL.project.addComponent(p, type, { x, z }, rot);
      if (params && r.ok) Object.assign(r.comp.params, params);   // 例如 LED 顏色、伺服初始角度
    }
    p.behavior.ir = { rules: JSON.parse(JSON.stringify(e.rules)) };
    p.lock = { components: true, behavior: true, board: true };
    if (e.arm) { const cfg = DL.arm.defaultConfig(); p.arm = { config: cfg, target: { x: 10, y: 8, z: 0 }, q: null, poses: [], confirmed: null }; }
    return { ok: true, project: p, experiment: e };
  }

  // 把元件的第一支腳對準麵包板上的某個孔後插入
  function placeOn(p, compId, bbId, hole) {
    const c = DL.project.findComp(p, compId); const bb = DL.project.findComp(p, bbId); const def = DL.components[c.type];
    const first = def.bb.holes[def.terminals[0].id][0]; const w = DL.breadboard.holeWorld(bb, hole);
    const [ox, oz] = DL.rotXZ(first[0] * DL.breadboard.PITCH, first[1] * DL.breadboard.PITCH, c.rot || 0);
    c.pos = { x: w.x - ox, z: w.z - oz };
    const f = DL.breadboard.fit(p, compId, bbId); if (!f.ok) throw new Error(f.msg);
    DL.breadboard.attach(p, compId, f);
  }

  // 完整接好線的範例（測試與「看解答」用）
  function solved(expId, boardId) {
    const r = instantiate(expId, boardId); if (!r.ok) return r;
    const p = r.project; const P = DL.project;
    const B = t => ({ comp: 'board', term: t });
    const gnds = DL.boards[boardId].pins.filter(x => x.kind === 'gnd').map(x => x.id);
    const pw = v => DL.boards[boardId].pins.find(x => x.kind === 'power' && x.volts === v).id;
    const pin = id => r.experiment.suggest[boardId][id].split('（')[0];
    if (r.experiment.auto) {   // 新的實驗：解答由接線助手產生（腳位依實驗建議）
      const res = DL.autowire.apply(p, {});
      if (!res.plan.done) throw new Error(`${expId}/${boardId} 的解答沒有接完：` + res.plan.issues.map(i => i.msg).join(' '));
      return r;
    }
    let g = 0;
    const has = id => p.components.some(c => c.id === id);
    if (r.experiment.bbWires) {
      const ep = s => s.startsWith('pin:') ? B(pin(s.slice(4))) : s === 'gnd' ? B(gnds[0]) : { comp: 'BB1', term: s };
      for (const [a, b] of r.experiment.bbWires) { const res = P.addConnection(p, ep(a), ep(b)); if (!res.ok) throw new Error(res.msg); }
      return r;
    }
    if (has('BTN1')) { P.addConnection(p, B(pin('BTN1')), { comp: 'BTN1', term: '1' }); P.addConnection(p, { comp: 'BTN1', term: '2' }, B(gnds[g++ % gnds.length])); }
    if (has('LED1')) { P.addConnection(p, B(pin('LED1')), { comp: 'R1', term: '1' }); P.addConnection(p, { comp: 'R1', term: '2' }, { comp: 'LED1', term: 'A' }); P.addConnection(p, { comp: 'LED1', term: 'K' }, B(gnds[g++ % gnds.length])); }
    if (has('LDR1')) { P.addConnection(p, B(pin('LDR1')), { comp: 'LDR1', term: 'AO' }); P.addConnection(p, { comp: 'LDR1', term: 'VCC' }, B(pw(DL.boards[boardId].logicV))); P.addConnection(p, { comp: 'LDR1', term: 'GND' }, B(gnds[g++ % gnds.length])); }
    if (has('PSU1')) {
      for (const id of ['SERVO1', 'SERVO2', 'SERVO3']) { if (!has(id)) continue; P.addConnection(p, B(pin(id)), { comp: id, term: 'SIG' }); P.addConnection(p, { comp: id, term: 'VCC' }, { comp: 'PSU1', term: 'VP' }); P.addConnection(p, { comp: id, term: 'GND' }, { comp: 'PSU1', term: 'GND' }); }
      P.addConnection(p, { comp: 'PSU1', term: 'GND' }, B(gnds[0]));
    } else if (has('SERVO1')) { P.addConnection(p, B(pin('SERVO1')), { comp: 'SERVO1', term: 'SIG' }); P.addConnection(p, { comp: 'SERVO1', term: 'VCC' }, B(pw(5))); P.addConnection(p, { comp: 'SERVO1', term: 'GND' }, B(gnds[g++ % gnds.length])); }
    return r;
  }

  /* ---------- 老師自訂的引導實驗 ----------
   * 老師在自訂專案裡放好元件、寫好行為（線可以接也可以不接），存成引導實驗：
   *   - 解答：用接線助手在副本上自動完成，記下每個元件的腳位；接不完（例如缺電阻）就不能存。
   *   - 學生版：拿掉所有導線（插在麵包板上的元件保留），鎖定元件與行為。
   *   - 任務：依元件自動產生；strictPins 時腳位必須和解答相同。
   * 實驗定義放在專案的 origin.custom 裡，所以學生用匯入專案檔就能使用，不需要同一台電腦。
   */
  function fromTeacher(p, meta) {
    meta = meta || {};
    const sol = DL.autowire.plan(p, {});
    const errs = sol.issues.filter(i => i.level === 'error' || i.wire);
    if (errs.length) return { ok: false, msg: '這個配置還不能自動接完：' + errs.map(i => i.msg).join(' ') };
    const a = DL.netlist.analyze(sol.project);
    if (!a.ok) return { ok: false, msg: '自動接線後檢查仍有錯誤：' + a.issues.filter(i => i.level === 'error').map(i => i.msg).join(' ') };
    const pins = {}; for (const [id, b] of Object.entries(a.bindings)) pins[id] = b.pin;
    if (!Object.keys(pins).length) return { ok: false, msg: '沒有需要接到控制板的元件（LED、按鈕、光敏模組、伺服）。' };
    const board = DL.boards[p.board.type];
    const id = 'c_' + DL.hash({ t: meta.title, at: Date.now(), r: Math.random() }).slice(0, 10);
    const custom = {
      id, title: String(meta.title || p.name || '自訂實驗').slice(0, 60), goal: String(meta.goal || '').slice(0, 400), board: board.id,
      strictPins: !!meta.strictPins, allowHints: meta.allowHints !== false, pins,
      suggest: { [board.id]: Object.fromEntries(Object.entries(pins).map(([k, v]) => [k, v])) },
      hasButton: p.components.some(c => c.type === 'BTN'), hasLight: p.components.some(c => c.type === 'LDR'), arm: !!p.arm,
      createdAt: new Date().toISOString()
    };
    const q = DL.project.clone(p, { name: '引導：' + custom.title, origin: { kind: 'guided', experimentId: 'custom:' + id, custom }, lock: { components: true, behavior: true, board: true } });
    q.connections = q.connections.filter(w => w.kind === 'insert');
    q.behavior.confirmed = null; q.code = { text: '', origin: 'none', basedOnInputs: null, generatorVersion: null }; q.builds = [];
    for (const c of q.components) delete c.prefPin;
    if (q.arm) { q.arm.confirmed = null; q.arm.poses = []; }
    return { ok: true, project: q, custom, solutionSteps: sol.steps.length };
  }
  function customTasks(cu) {
    const board = DL.boards[cu.board]; const L = id => board.pinLabel(board.pinById[id]);
    const t = Object.entries(cu.pins).map(([comp, pin]) => ({
      text: `${comp} 接好${cu.strictPins ? `（接到 ${L(pin)}）` : ''}`,
      check: (p, a) => !!a.bindings[comp] && (!cu.strictPins || a.bindings[comp].pin === pin)
    }));
    t.push({ text: '配置檢查沒有錯誤', check: (p, a) => a.ok && a.counts.unknown === 0 });
    if (cu.arm) t.push({ text: '在「手臂」頁確認設定與伺服映射', check: (p, a, ctx) => !!ctx.armConfirmed });
    else t.push({ text: '在「行為」頁確認行為摘要', check: (p, a, ctx) => !!ctx.confirmedCurrent });
    if (cu.hasButton) t.push({ text: '在「觀測」頁按住按鈕超過 1.5 秒，觀察結果', check: (p, a, ctx) => ctx.maxHoldMs >= 1500 });
    else if (cu.hasLight) t.push({ text: '在「觀測」頁把亮度拉到 30 % 以下，觀察結果', check: (p, a, ctx) => ctx.minLight < 30 });
    return t;
  }
  // 依專案找出它的引導實驗（內建或老師自訂）
  function forProject(p) {
    const o = p && p.origin; if (!o) return null;
    if (o.custom) return { id: o.experimentId, title: o.custom.title, goal: o.custom.goal || '依任務完成接線，再確認行為並模擬。', suggest: o.custom.suggest, tasks: customTasks(o.custom), custom: o.custom, allowHints: o.custom.allowHints };
    const e = EXPERIMENTS.find(x => x.id === o.experimentId); return e ? Object.assign({ allowHints: true }, e) : null;
  }

  DL.experiments = { list: EXPERIMENTS, instantiate, solved, placeOn, fromTeacher, customTasks, forProject, HOLD_BLINK };
  if (typeof module !== 'undefined') module.exports = DL;
})(typeof globalThis !== 'undefined' ? globalThis : this);
