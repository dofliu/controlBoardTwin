/* DofLab — 網表分析與電路驗證
 * 只根據 connections（網表）判斷導通，不看元件在場景中的位置。
 * 回報層級：error（阻擋程式產生與真機寫入）、warn、info、unknown（未檢查，不假裝通過）。
 */
(function (root) {
  const DL = (root.DL = root.DL || {});

  function analyze(p) {
    const board = DL.boards[p.board.type];
    const issues = [];
    const add = (level, code, msg, refs) => issues.push({ level, code, msg, refs: refs || [] });
    // 麵包板的孔換成它所屬的導通條：插在同一條上的腳自然相連
    const bbIds = new Set(p.components.filter(c => c.type === 'BB').map(c => c.id));
    const key = ep => bbIds.has(ep.comp) ? ep.comp + '.' + (DL.breadboard.busOf(ep.term) || ep.term) : ep.comp + '.' + ep.term;

    /* ---- 1. 以 union-find 建立節點（net） ---- */
    const parent = {};
    const find = k => { while (parent[k] !== k) { parent[k] = parent[parent[k]]; k = parent[k]; } return k; };
    const touch = k => { if (!(k in parent)) parent[k] = k; };
    for (const w of p.connections) { const a = key(w.a), b = key(w.b); touch(a); touch(b); parent[find(a)] = find(b); }
    const netsByRoot = {};
    for (const k of Object.keys(parent)) { const r = find(k); (netsByRoot[r] = netsByRoot[r] || []).push(k); }
    const nets = Object.values(netsByRoot).map((eps, i) => {
      const n = { id: 'N' + (i + 1), eps, gpio: [], power: [], gnd: [], other: [], comps: [] };
      for (const k of eps) {
        const [comp, term] = splitKey(k);
        if (comp === 'board') {
          const pin = board.pinById[term];
          if (!pin) continue;
          if (pin.kind === 'gpio') n.gpio.push(pin); else if (pin.kind === 'power') n.power.push(pin); else if (pin.kind === 'gnd') n.gnd.push(pin); else n.other.push(pin);
        } else if (bbIds.has(comp)) {
          (n.bb = n.bb || []).push({ bb: comp, bus: term });
        } else {
          n.comps.push({ comp, term });
          const pc = DL.project.findComp(p, comp);
          if (pc && pc.type === 'PSU') {   // 外部電源：+5V 視為電源、GND 視為（外部）地
            if (term === 'VP') n.power.push({ id: comp + '.VP', label: comp + ' +5V', kind: 'power', volts: 5, external: true, caps: [], notes: [] });
            if (term === 'GND') n.gnd.push({ id: comp + '.GND', label: comp + ' GND', kind: 'gnd', external: true, caps: [], notes: [] });
          }
        }
      }
      return n;
    });
    const netOf = {};
    for (const n of nets) for (const k of n.eps) netOf[k] = n;
    const net = (comp, term) => netOf[comp + '.' + term] || null;

    /* ---- 2. 節點層級檢查 ---- */
    for (const n of nets) {
      const volts = [...new Set(n.power.map(x => x.volts))];
      if (n.power.some(x => x.external) && n.power.some(x => !x.external)) add('error', 'psu_backfeed', `${pinNames(n.power)} 被接在一起：外部電源與控制板電源直接相連，可能互相倒灌。外部 +5V 只接負載，兩者只共用 GND。`, n.eps);
      if (n.power.length && n.gnd.length) add('error', 'short', `短路：${pinNames(n.power)} 與 GND 直接相連。`, n.eps);
      if (volts.length > 1) add('error', 'short', `不同電壓的電源接在一起：${pinNames(n.power)}。`, n.eps);
      if (n.gpio.length > 1) add('error', 'gpio_gpio', `${pinNames(n.gpio)} 被接到同一個節點，兩個輸出互相衝突時會損壞腳位。`, n.eps);
      if (n.gpio.length && n.power.length) add('error', 'gpio_power', `${pinNames(n.gpio)} 直接接到 ${pinNames(n.power)}：輸出 LOW 時會短路${n.power.some(x => x.volts > board.logicV) ? '，而且電壓超過這塊板子的 ' + board.logicV + 'V 邏輯' : ''}。`, n.eps);
      if (n.gpio.length && n.gnd.length) add('error', 'gpio_gnd', `${pinNames(n.gpio)} 直接接到 GND：輸出 HIGH 時會短路。`, n.eps);
      for (const o of n.other) {
        const lvl = /^FLASH|^ID_/.test(o.id) ? 'error' : 'warn';
        add(lvl, 'other_pin', `${o.label} 腳：${(o.notes[0] && (o.notes[0].text || o.notes[0])) || '本版不分析這個腳位的用途。'}`, n.eps);
      }
    }

    /* ---- 3. 元件層級檢查與腳位綁定 ---- */
    const bindings = {}; const boardServo = [];
    const pinUse = {};
    const claim = (pin, compId) => { (pinUse[pin.id] = pinUse[pin.id] || []).push(compId); };
    const resistorsOn = n => { // 回傳經過一顆電阻可到達的另一個節點
      if (!n) return [];
      const out = [];
      for (const { comp, term } of n.comps) {
        const c = DL.project.findComp(p, comp);
        if (!c || c.type !== 'RES') continue;
        const other = term === '1' ? '2' : '1';
        out.push({ res: c, net: net(c.id, other) });
      }
      return out;
    };
    const wireToPin = (pin) => p.connections.find(w => w.kind !== 'insert' && ((w.a.comp === 'board' && w.a.term === pin.id) || (w.b.comp === 'board' && w.b.term === pin.id))) || p.connections.find(w => (w.a.comp === 'board' && w.a.term === pin.id) || (w.b.comp === 'board' && w.b.term === pin.id));

    for (const c of p.components) {
      const def = DL.components[c.type];
      if (!def) { add('unknown', 'unknown_component', `${c.id}（${c.type}）不在元件型錄中：未檢查接線與電氣條件。`, [c.id]); continue; }
      if (def.holder) continue;   // 麵包板本身只負責導通
      // 同一個元件的兩支腳落在同一個節點：元件被短路（例如電阻直插在同一條導通條上）
      const seen = {}; let shorted = null;
      for (const t of def.terminals) { const n = net(c.id, t.id); if (!n) continue; if (seen[n.id] && !shorted) shorted = [seen[n.id], t]; seen[n.id] = t; }
      if (shorted) { const n = net(c.id, shorted[1].id); const where = n.bb && n.bb.length ? `插在同一條導通條（${n.bb.map(b => b.bb + ' ' + DL.breadboard.busLabel(b.bus)).join('、')}）` : '接在同一個節點'; add('error', 'comp_shorted', `${c.id} 的 ${shorted[0].label.split('（')[0]} 與 ${shorted[1].label.split('（')[0]} ${where}，等於把 ${c.id} 短路，它不會作用。${n.bb && n.bb.length ? '請把元件轉 90° 或跨到不同號的孔。' : ''}`, [c.id]); continue; }
      const open = def.terminals.filter(t => !net(c.id, t.id));
      if (open.length === def.terminals.length) { add('warn', 'unconnected', `${c.id} 還沒有任何連線。`, [c.id]); continue; }
      for (const t of open) add('warn', 'open_terminal', `${c.id} 的 ${t.label} 未連接。`, [c.id + '.' + t.id]);

      if (c.type === 'LED') checkLED(c);
      else if (c.type === 'BTN') checkBTN(c);
      else if (c.type === 'LDR') checkLDR(c);
      else if (c.type === 'SERVO') checkServo(c);
      else if (c.type === 'PSU') checkPSU(c);
    }

    function sideReach(n, skipRes) {
      // 從某節點出發：直接或經一顆電阻能到達的板子腳位
      const res = { gpio: [], power: [], gnd: [], via: [] };
      if (!n) return res;
      const take = (m, via) => {
        for (const g of m.gpio) res.gpio.push({ pin: g, via });
        for (const g of m.power) res.power.push({ pin: g, via });
        for (const g of m.gnd) res.gnd.push({ pin: g, via });
      };
      take(n, null);
      for (const r of resistorsOn(n)) { if (r.res.id === skipRes || !r.net) continue; take(r.net, r.res); }
      return res;
    }

    function checkLED(c) {
      const nA = net(c.id, 'A'), nK = net(c.id, 'K');
      if (!nA || !nK) return;
      const A = sideReach(nA), K = sideReach(nK);
      const vf = DL.components.LED.vf[c.params.color] || 2.0;
      if (A.gnd.length && (K.gpio.length || K.power.length)) { add('error', 'led_reversed', `${c.id} 方向接反：陽極（長腳）接到 GND，陰極接到 ${K.gpio.length ? pinNames(K.gpio.map(x => x.pin)) : '電源'}。LED 不會亮。`, [c.id]); return; }
      const drive = A.gpio[0] || null, sink = K.gnd[0] || null;
      if (!drive && A.power.length && sink) { add('warn', 'led_always_on', `${c.id} 接在 ${A.power[0].pin.label} 與 GND 之間，會常亮，不受程式控制。`, [c.id]); return; }
      if (!drive) { add('error', 'led_no_pin', `${c.id} 的陽極沒有接到（或經一顆電阻接到）任何 GPIO。本版只支援「GPIO → LED → GND」的接法。`, [c.id]); return; }
      if (!sink) { add('error', 'led_no_gnd', `${c.id} 的陰極沒有接到（或經一顆電阻接到）GND，電流沒有回路。`, [c.id]); return; }
      const pin = drive.pin;
      if (!pin.caps.includes('dout')) { add('error', 'pin_cap', `${board.pinLabel(pin)} 只能當輸入，不能驅動 ${c.id}。`, [c.id, 'board.' + pin.id]); return; }
      const rs = [drive.via, sink.via].filter(Boolean);
      claim(pin, c.id);
      bindings[c.id] = { comp: c.id, role: 'led', pin: pin.id, num: pin.num, wire: (wireToPin(pin) || {}).id, via: rs.map(r => r.id) };
      if (!rs.length) { add('error', 'led_no_resistor', `${c.id} 沒有串聯限流電阻：電流只受腳位內阻限制，可能燒毀 LED 或 ${board.pinLabel(pin)}。`, [c.id]); return; }
      const R = rs.reduce((s, r) => s + Number(r.params.ohms || 0), 0);
      const mA = Math.max(0, (board.logicV - vf) / R * 1000);
      bindings[c.id].mA = Math.round(mA * 10) / 10;
      if (mA > board.absMaxPinmA) add('error', 'overcurrent', `${c.id} 估計電流 ${mA.toFixed(1)} mA，超過 ${board.short} 單一腳位上限 ${board.absMaxPinmA} mA。請加大電阻（目前 ${R} Ω）。`, [c.id]);
      else if (mA > board.maxPinmA) add('warn', 'high_current', `${c.id} 估計電流 ${mA.toFixed(1)} mA，高於建議值 ${board.maxPinmA} mA。`, [c.id]);
      else if (mA < 1) add('info', 'dim', `${c.id} 估計電流只有 ${mA.toFixed(2)} mA，可能很暗或不亮（${board.logicV}V − Vf ${vf}V，${R} Ω）。`, [c.id]);
      else add('info', 'led_ok', `${c.id}：${board.pinLabel(pin)} → ${rs.map(r => r.id).join('、')}（${R} Ω）→ LED → GND，估計 ${mA.toFixed(1)} mA（以 Vf ${vf} V 估算）。`, [c.id]);
    }

    function checkBTN(c) {
      const n1 = net(c.id, '1'), n2 = net(c.id, '2');
      if (!n1 || !n2) return;
      const s1 = { gpio: n1.gpio, gnd: n1.gnd, power: n1.power }, s2 = { gpio: n2.gpio, gnd: n2.gnd, power: n2.power };
      let sig = null, other = null;
      if (s1.gpio.length && !s2.gpio.length) { sig = s1; other = s2; } else if (s2.gpio.length && !s1.gpio.length) { sig = s2; other = s1; }
      if (!sig) {
        if (s1.gpio.length && s2.gpio.length) add('error', 'btn_two_pins', `${c.id} 兩端都接到 GPIO（${pinNames([...s1.gpio, ...s2.gpio])}），按下時會讓兩個腳位互接。`, [c.id]);
        else add('error', 'btn_no_pin', `${c.id} 沒有任何一端直接接到 GPIO。`, [c.id]);
        return;
      }
      const pin = sig.gpio[0];
      if (other.power.length) {
        const v = other.power[0].volts;
        if (v > board.logicV) add('error', 'overvoltage', `${c.id} 按下時會把 ${other.power[0].label}（${v}V）送進 ${board.pinLabel(pin)}，超過 ${board.short} 的 ${board.logicV}V 邏輯，可能損壞腳位。`, [c.id]);
        else add('error', 'btn_needs_pulldown', `${c.id} 接到 ${other.power[0].label}：需要外部下拉電阻。本版只支援「按鈕接 GND＋內建上拉」，外部下拉尚未分析。`, [c.id]);
        return;
      }
      if (!other.gnd.length) { add('error', 'btn_no_gnd', `${c.id} 另一端沒有接到 GND。`, [c.id]); return; }
      if (!pin.caps.includes('pullup')) { add('error', 'pin_cap', `${board.pinLabel(pin)} 沒有內建上拉電阻，按鈕放開時電位會浮動。請改用其他腳位（外部上拉本版未分析）。`, [c.id, 'board.' + pin.id]); return; }
      claim(pin, c.id);
      bindings[c.id] = { comp: c.id, role: 'button', pin: pin.id, num: pin.num, wire: (wireToPin(pin) || {}).id, pull: 'up', activeLow: true, debounceMs: c.params.debounceMs };
      add('info', 'btn_ok', `${c.id}：${board.pinLabel(pin)} ↔ 按鈕 ↔ GND，使用內建上拉；放開讀到 HIGH，按下讀到 LOW。`, [c.id]);
    }

    function checkLDR(c) {
      const nV = net(c.id, 'VCC'), nG = net(c.id, 'GND'), nO = net(c.id, 'AO');
      if (!board.adcBits) { add('error', 'no_adc', `${board.short} 沒有內建類比輸入（ADC），不能直接讀 ${c.id} 的類比輸出。需要外接 ADC 模組（本版未支援）。`, [c.id]); return; }
      if (nV && !nV.power.length) add('error', 'ldr_vcc', `${c.id} 的 VCC 沒有接到電源腳位。`, [c.id]);
      if (nV && nV.power.length && nV.power[0].volts > board.logicV) add('error', 'overvoltage', `${c.id} 接 ${nV.power[0].label} 供電，AO 最高可能輸出 ${nV.power[0].volts}V，超過 ${board.short} 的 ${board.logicV}V 類比輸入範圍。請改接 ${board.logicV === 3.3 ? '3V3' : '5V'}。`, [c.id]);
      if (nG && !nG.gnd.length) add('error', 'ldr_gnd', `${c.id} 的 GND 沒有接到 GND。`, [c.id]);
      if (!nO) return;
      if (!nO.gpio.length) { add('error', 'ldr_no_pin', `${c.id} 的 AO 沒有接到 GPIO。`, [c.id]); return; }
      const pin = nO.gpio[0];
      if (!pin.caps.includes('adc')) { add('error', 'pin_cap', `${board.pinLabel(pin)} 不能讀類比值；請接到有 ADC 的腳位（例如 ${board.pins.filter(x => x.caps.includes('adc')).slice(0, 3).map(x => x.label).join('、')}）。`, [c.id, 'board.' + pin.id]); return; }
      claim(pin, c.id);
      bindings[c.id] = { comp: c.id, role: 'analog', pin: pin.id, num: pin.num, code: board.codeName(pin), wire: (wireToPin(pin) || {}).id, bits: board.adcBits };
      add('info', 'ldr_ok', `${c.id}：AO → ${board.pinLabel(pin)}（${board.adcBits} 位元 ADC，0–${(1 << board.adcBits) - 1}）。`, [c.id]);
    }

    function checkPSU(c) {
      const nG = net(c.id, 'GND');
      if (nG && !nG.gnd.some(g => !g.external)) add('error', 'psu_no_common_gnd', `${c.id} 的 GND 沒有接到控制板 GND：外部電源與控制板沒有共地，訊號沒有共同參考電位。`, [c.id]);
    }
    function checkServo(c) {
      const nS = net(c.id, 'SIG'), nV = net(c.id, 'VCC'), nG = net(c.id, 'GND');
      if (nG && !nG.gnd.length) add('error', 'servo_gnd', `${c.id} 的 GND 沒有接到 GND（伺服與控制板必須共地）。`, [c.id]);
      else if (nG && !nG.gnd.some(g => !g.external)) add('error', 'servo_no_common_gnd', `${c.id} 的 GND 只接到外部電源，沒有與控制板共地：SIG 訊號沒有共同參考電位。`, [c.id]);
      if (nV && !nV.power.length) add('error', 'servo_vcc', `${c.id} 的 VCC 沒有接到電源。`, [c.id]);
      if (nV && nV.power.length) {
        const v = nV.power[0].volts;
        if (nV.power[0].external) add('info', 'servo_ext_power', `${c.id} 由 ${nV.power[0].label} 供電（外部電源）。`, [c.id]);
        else if (v && v < 4.5) add('warn', 'servo_low_v', `${c.id} 接 ${nV.power[0].label}：SG90 類伺服通常需要約 4.8–6 V，3.3 V 可能轉不動或抖動。`, [c.id]);
        else { add('warn', 'servo_power', `${c.id} 由開發板 ${nV.power[0].label} 供電：只適合空載測試。轉動時電流可能達數百 mA，請依實物規格改用外部電源並共地。`, [c.id]); boardServo.push(c.id); }
      }
      if (!nS) return;
      if (!nS.gpio.length) { add('error', 'servo_no_pin', `${c.id} 的 SIG 沒有接到 GPIO。`, [c.id]); return; }
      const pin = nS.gpio[0];
      if (!pin.caps.includes('servo')) { add('error', 'pin_cap', `${board.pinLabel(pin)} 不能輸出伺服脈波。`, [c.id, 'board.' + pin.id]); return; }
      claim(pin, c.id);
      bindings[c.id] = { comp: c.id, role: 'servo', pin: pin.id, num: pin.num, wire: (wireToPin(pin) || {}).id };
      if (board.id === 'pi4b') add('warn', 'pi_soft_pwm', `${board.pinLabel(pin)} 以軟體 PWM 產生伺服脈波，可能抖動；硬體 PWM 腳位為 GPIO12、13、18、19。`, [c.id]);
      add('info', 'servo_cmd_only', `${c.id}：沒有角度回授，畫面只顯示「命令角度」，不是實測角度。`, [c.id]);
    }

    if (boardServo.length >= 2) add('error', 'servo_board_supply', `${boardServo.join('、')} 共 ${boardServo.length} 顆伺服由開發板供電：同時轉動的電流可能超過 USB／穩壓器上限，造成板子重開機。請加入外部 5V 電源並共地。`, boardServo);
    /* ---- 4. 重複占用、腳位注意事項 ---- */
    for (const [pinId, users] of Object.entries(pinUse)) {
      const pin = board.pinById[pinId];
      if (users.length > 1) {
        add('error', 'pin_conflict', `${board.pinLabel(pin)} 同時被 ${users.join('、')} 使用。`, users);
        for (const u of users) delete bindings[u];
      }
      for (const n of pin.notes) add(n.level, 'pin_note', `${board.pinLabel(pin)}：${n.text}`, ['board.' + pinId]);
    }

    const counts = { error: 0, warn: 0, info: 0, unknown: 0 };
    for (const i of issues) counts[i.level]++;
    const order = { error: 0, unknown: 1, warn: 2, info: 3 };
    issues.sort((a, b) => order[a.level] - order[b.level]);
    return { nets, bindings, issues, pinUse, counts, ok: counts.error === 0 };

    function pinNames(list) { return list.map(x => board.pinLabel(x)).join('、'); }
  }

  function splitKey(k) { const i = k.indexOf('.'); return [k.slice(0, i), k.slice(i + 1)]; }

  // 試算：把某條板端連線換到新腳位後，會不會出錯（同步虛擬接線前檢查）
  function tryRewire(p, compId, newPinId) {
    const res = analyze(p);
    const b = res.bindings[compId];
    if (!b || !b.wire) return { ok: false, msg: `${compId} 目前沒有可識別的板端連線。` };
    const board = DL.boards[p.board.type];
    const pin = board.pinById[newPinId];
    if (!pin || pin.kind !== 'gpio') return { ok: false, msg: `${newPinId} 不是 ${board.short} 的 GPIO。` };
    const q = JSON.parse(JSON.stringify(p));
    const r = DL.project.rewireBoardEnd(q, b.wire, newPinId);
    if (!r.ok) return r;
    const after = analyze(q);
    const nb = after.bindings[compId];
    const newErrors = after.issues.filter(i => i.level === 'error' && !res.issues.some(j => j.level === 'error' && j.msg === i.msg));
    if (!nb || nb.pin !== newPinId || newErrors.length) return { ok: false, msg: `改接到 ${board.pinLabel(pin)} 會產生問題：${newErrors.map(e => e.msg).join(' ') || '無法建立綁定'}`, after };
    return { ok: true, project: q, wire: b.wire, from: b.pin, to: newPinId, after };
  }

  DL.netlist = { analyze, tryRewire };
  if (typeof module !== 'undefined') module.exports = DL;
})(typeof globalThis !== 'undefined' ? globalThis : this);
