/* DofLab — 接線助手：依目前的元件（與麵包板）推算「還缺哪些線」，可以一條一條建議，也可以一次接完。
 * 原則：
 *   - 保留已經接對的線；接錯的線只會指出來（勾選「移除接錯的線」才會移除）。
 *   - 腳位：已經形成綁定的沿用；老師指定的（元件的 prefPin）優先；其餘依板型的建議順序挑選能力相符、尚未使用的腳位，避開開機模式腳與序列埠。
 *   - LED 需要限流電阻：優先使用場上沒用到的電阻；勾選「補上缺少的元件」才會自動加一顆。兩顆以上伺服同理（外部 5V 電源）。
 *   - 元件插在麵包板上時，線接到同一條導通條的空孔；GND 走麵包板的 − 電源排。
 *   - 每一步都附說明，供教學使用。這裡只算出接法，電氣檢查仍以 netlist.js 為準。
 */
(function (root) {
  const DL = (root.DL = root.DL || {});

  // 各板型、各用途的建議腳位順序（與引導實驗的建議一致）
  const PREF = {
    uno: { button: ['D2', 'D3', 'D4', 'D7', 'D8', 'D12'], led: ['D13', 'D12', 'D11', 'D10', 'D8', 'D7', 'D6', 'D5', 'D4'], analog: ['A0', 'A1', 'A2', 'A3'], servo: ['D9', 'D10', 'D11', 'D6', 'D5', 'D3'], trig: ['D7', 'D4', 'D5', 'D6', 'D8', 'D12'], echo: ['D8', 'D4', 'D5', 'D6', 'D7', 'D12'] },
    esp32: { button: ['GPIO4', 'GPIO16', 'GPIO17', 'GPIO25', 'GPIO26', 'GPIO27', 'GPIO32', 'GPIO33'], led: ['GPIO23', 'GPIO22', 'GPIO21', 'GPIO19', 'GPIO18', 'GPIO17', 'GPIO16'], analog: ['GPIO34', 'GPIO35', 'GPIO32', 'GPIO33', 'GPIO36', 'GPIO39'], servo: ['GPIO18', 'GPIO19', 'GPIO21', 'GPIO22', 'GPIO23', 'GPIO25', 'GPIO26', 'GPIO27'], trig: ['GPIO26', 'GPIO25', 'GPIO32', 'GPIO33', 'GPIO16', 'GPIO17'], echo: ['GPIO27', 'GPIO35', 'GPIO34', 'GPIO32', 'GPIO33', 'GPIO25'] },
    pi4b: { button: ['GPIO27', 'GPIO22', 'GPIO5', 'GPIO6', 'GPIO26', 'GPIO16'], led: ['GPIO17', 'GPIO23', 'GPIO24', 'GPIO25', 'GPIO16', 'GPIO20', 'GPIO21'], analog: [], servo: ['GPIO12', 'GPIO13', 'GPIO18', 'GPIO19'], trig: ['GPIO5', 'GPIO16', 'GPIO20', 'GPIO21', 'GPIO26'], echo: ['GPIO6', 'GPIO16', 'GPIO20', 'GPIO21', 'GPIO26', 'GPIO19'] }
  };
  const NEED = { LED: { role: 'led', caps: ['dout'] }, BTN: { role: 'button', caps: ['din', 'pullup'] }, LDR: { role: 'analog', caps: ['adc'] }, SERVO: { role: 'servo', caps: ['servo'] } };
  // 超音波模組有兩個訊號腳：TRIG 用元件 id、ECHO 用「元件 id.ECHO」記在 pins 裡
  const US_SLOTS = [{ part: 'TRIG', role: 'trig', caps: ['dout'], pref: 'prefPin' }, { part: 'ECHO', role: 'echo', caps: ['din'], pref: 'prefPinEcho' }];
  const slotKey = (id, part) => part === 'ECHO' ? id + '.ECHO' : id;
  const ROLE_NAME = { led: '數位輸出', button: '數位輸入＋內建上拉', analog: '類比輸入（ADC）', servo: '伺服脈波', trig: 'TRIG（數位輸出）', echo: 'ECHO（數位輸入）' };

  const clone = o => JSON.parse(JSON.stringify(o));
  const key = ep => ep.comp + '.' + ep.term;
  const B = term => ({ comp: 'board', term });
  const T = (comp, term) => ({ comp, term });

  // 端點的中文名稱（說明文字用）
  function epName(p, ep) {
    const board = DL.boards[p.board.type];
    if (ep.comp === 'board') return board.pinLabel(board.pinById[ep.term]);
    const c = DL.project.findComp(p, ep.comp); if (!c) return key(ep);
    if (c.type === 'BB') return `${c.id} 的 ${DL.breadboard.holeLabel(ep.term)} 孔`;
    const t = DL.components[c.type].terminals.find(x => x.id === ep.term);
    return `${c.id} ${t ? t.label.split('（')[0] : ep.term}`;
  }

  /* ---------- 1. 決定每個元件的腳位 ---------- */
  function assignPins(p, a, issues) {
    const board = DL.boards[p.board.type]; const used = new Set(Object.keys(a.pinUse)); const pins = {};
    const ok = (pin, need) => pin && pin.kind === 'gpio' && need.caps.every(c => pin.caps.includes(c));
    const quiet = pin => !pin.notes.some(n => n.level === 'warn' || n.level === 'error');
    const exp = p.origin && (p.origin.custom || (p.origin.experimentId && DL.experiments && DL.experiments.list.find(e => e.id === p.origin.experimentId)));
    // 幫一個訊號挑腳位：接了一半的沿用 → 老師指定 → 實驗建議 → 板型建議順序
    const choose = (c, key, need, terms, prefPin, label) => {
      const ex = existingPin(p, a, c, need, terms);       // 接了一半：某支腳（或經過一顆電阻）已經接到能力相符的腳位
      if (ex && (!used.has(ex) || (a.pinUse[ex] || []).length === 0)) { pins[key] = ex; used.add(ex); return; }
      if (prefPin) {
        const pin = board.pinById[prefPin];
        if (!ok(pin, need)) issues.push({ level: 'warn', comp: c.id, msg: `${label} 指定的 ${pin ? board.pinLabel(pin) : prefPin} 不能當${ROLE_NAME[need.role]}，改用建議腳位。` });
        else if (used.has(pin.id)) issues.push({ level: 'warn', comp: c.id, msg: `${label} 指定的 ${board.pinLabel(pin)} 已被使用，改用建議腳位。` });
        else { pins[key] = pin.id; used.add(pin.id); return; }
      }
      // 引導實驗的建議腳位（老師自訂的實驗也一樣）優先，其次才是板型的建議順序
      const sug = exp && exp.suggest && exp.suggest[board.id] && exp.suggest[board.id][key];
      const list = [...(sug ? [String(sug).split('（')[0]] : []), ...((PREF[board.id] && PREF[board.id][need.role]) || [])];
      let pick = list.find(id => !used.has(id) && ok(board.pinById[id], need));
      if (!pick) pick = (board.pins.find(x => !used.has(x.id) && ok(x, need) && quiet(x)) || board.pins.find(x => !used.has(x.id) && ok(x, need)) || {}).id;
      if (!pick) { issues.push({ level: 'error', comp: c.id, msg: need.role === 'analog' && !board.adcBits ? `${board.short} 沒有類比輸入（ADC），無法接 ${c.id}。` : `${board.short} 沒有可用的${ROLE_NAME[need.role]}腳位給 ${label}。` }); return; }
      pins[key] = pick; used.add(pick);
    };
    for (const c of p.components) {
      const b = a.bindings[c.id];
      if (c.type === 'US') {
        if (b) { pins[c.id] = b.trig; pins[c.id + '.ECHO'] = b.echo; continue; }
        for (const s of US_SLOTS) choose(c, slotKey(c.id, s.part), s, [s.part], c[s.pref], `${c.id} ${s.part}`);
        continue;
      }
      const need = NEED[c.type]; if (!need) continue;
      if (b) { pins[c.id] = b.pin; continue; }   // 已經接好的沿用
      choose(c, c.id, need, null, c.prefPin, c.id);
    }
    return pins;
  }

  function existingPin(p, a, c, need, terms) {
    const board = DL.boards[p.board.type]; const def = DL.components[c.type];
    const netOf = k => a.nets.find(n => n.eps.includes(k)) || null;
    const sig = terms || { LED: ['A'], BTN: ['1', '2'], LDR: ['AO'], SERVO: ['SIG'] }[c.type] || [];
    for (const t of sig) {
      const n = netOf(c.id + '.' + t); if (!n) continue;
      const nets = [n];
      if (c.type === 'LED') for (const x of n.comps) { const r = DL.project.findComp(p, x.comp); if (r && r.type === 'RES') { const o = netOf(r.id + '.' + (x.term === '1' ? '2' : '1')); if (o) nets.push(o); } }
      for (const m of nets) for (const g of m.gpio) if (need.caps.every(k => g.caps.includes(k))) return g.id;
    }
    return null;
  }

  /* ---------- 2. 每個元件需要的連線關係 ---------- */
  // 關係：{ e: 端點, t: 目標 }，目標可以是 {pin}、{gnd:true}（任一控制板 GND）、{power:伏特}、{term:端點}
  function relations(p, a, pins, extra, issues) {
    const rel = []; const board = DL.boards[p.board.type];
    const netOf = k => a.nets.find(n => n.eps.includes(k)) || null;
    const servos = p.components.filter(c => c.type === 'SERVO');
    const psu = p.components.find(c => c.type === 'PSU');
    const usedRes = new Set();
    for (const c of p.components) {
      if (c.type === 'BTN' && pins[c.id]) {
        // 已經有一側接到 GPIO 的話，維持這個方向
        const n2 = netOf(c.id + '.2'); const sig = n2 && n2.gpio.length && !(netOf(c.id + '.1') || { gpio: [] }).gpio.length ? '2' : '1'; const oth = sig === '1' ? '2' : '1';
        rel.push({ e: T(c.id, sig), t: { pin: pins[c.id] }, why: `${c.id} 一側接 ${pinL(pins[c.id])}：使用內建上拉，放開讀到 HIGH、按下讀到 LOW` });
        rel.push({ e: T(c.id, oth), t: { gnd: true }, why: `${c.id} 另一側接 GND，按下時把腳位拉到 LOW` });
      }
      if (c.type === 'LED' && pins[c.id]) {
        const r = extra.resistorFor[c.id];
        if (r) {
          rel.push({ e: T(r.id, r.inT), t: { pin: pins[c.id] }, why: `${pinL(pins[c.id])} 接 ${r.id}：${c.id} 的訊號先經過限流電阻` });
          rel.push({ e: T(r.id, r.outT), t: { term: T(c.id, 'A') }, why: `${r.id} 另一端接 ${c.id} 陽極（長腳）` });
        }
        rel.push({ e: T(c.id, 'K'), t: { gnd: true }, why: `${c.id} 陰極（短腳）接 GND，電流才有回路` });
      }
      if (c.type === 'LDR' && pins[c.id]) {
        rel.push({ e: T(c.id, 'VCC'), t: { power: board.logicV }, why: `${c.id} VCC 接 ${board.logicV}V：輸出電壓不能超過 ${board.short} 的 ${board.logicV}V 類比輸入範圍` });
        rel.push({ e: T(c.id, 'GND'), t: { gnd: true }, why: `${c.id} GND 接 GND` });
        rel.push({ e: T(c.id, 'AO'), t: { pin: pins[c.id] }, why: `${c.id} AO 接 ${pinL(pins[c.id])}（類比輸入）` });
      }
      if (c.type === 'US' && pins[c.id] && pins[c.id + '.ECHO']) {
        const model = c.params.model || 'HC-SR04';
        if (model === 'HC-SR04' && board.logicV < 5) {
          // 只能 5 V 供電的 HC-SR04：ECHO 會輸出 5 V，不能直接接 3.3 V 的腳位，所以不自動接這顆
          (issues || []).push({ level: 'error', comp: c.id, msg: `${c.id} 是只能 5 V 供電的 HC-SR04，ECHO 會輸出 5 V，不能直接接 ${board.short} 的 3.3 V 腳位：請在「選取項目」把型號改成 HC-SR04P 類（3.3 V 可用），或自己加分壓電阻（本版不分析分壓）。` });
        } else {
          const vcc = model === 'HC-SR04' ? 5 : board.logicV;
          rel.push({ e: T(c.id, 'VCC'), t: { power: vcc }, why: model === 'HC-SR04' ? `${c.id} VCC 接 5V：HC-SR04 需要 5 V 供電` : `${c.id} VCC 接 ${vcc}V：ECHO 的高電位等於 VCC，接 ${board.logicV} V 才不會超過 ${board.short} 的腳位電壓` });
          rel.push({ e: T(c.id, 'GND'), t: { gnd: true }, why: `${c.id} GND 接 GND` });
          rel.push({ e: T(c.id, 'TRIG'), t: { pin: pins[c.id] }, why: `${c.id} TRIG 接 ${pinL(pins[c.id])}：程式每 60 ms 送出一次 10 µs 的觸發脈衝` });
          rel.push({ e: T(c.id, 'ECHO'), t: { pin: pins[c.id + '.ECHO'] }, why: `${c.id} ECHO 接 ${pinL(pins[c.id + '.ECHO'])}：讀回波高電位的寬度（約 58 µs／cm）換算距離` });
        }
      }
      if (c.type === 'SERVO' && pins[c.id]) {
        rel.push({ e: T(c.id, 'SIG'), t: { pin: pins[c.id] }, why: `${c.id} SIG（橘）接 ${pinL(pins[c.id])}：可輸出伺服脈波` });
        if (psu) {
          rel.push({ e: T(c.id, 'VCC'), t: { term: T(psu.id, 'VP') }, why: `${c.id} VCC（紅）接外部電源 ${psu.id} +5V：伺服轉動時電流大，不由控制板供電` });
          rel.push({ e: T(c.id, 'GND'), t: { term: T(psu.id, 'GND') }, why: `${c.id} GND（棕）接 ${psu.id} GND` });
        } else {
          rel.push({ e: T(c.id, 'VCC'), t: { power: 5 }, why: `${c.id} VCC（紅）接 5V（只適合空載測試）` });
          rel.push({ e: T(c.id, 'GND'), t: { gnd: true }, why: `${c.id} GND（棕）接 GND，和控制板共地` });
        }
      }
    }
    if (psu) rel.push({ e: T(psu.id, 'GND'), t: { gnd: true }, why: `外部電源 ${psu.id} 的 GND 接控制板 GND（共地），訊號才有共同參考電位` });
    return rel;
    function pinL(id) { return board.pinLabel(board.pinById[id]); }
  }

  /* ---------- 3. LED 配電阻、伺服配電源 ---------- */
  function pairParts(p, a, opts, steps, issues, pins) {
    const resistorFor = {}; const taken = new Set();
    const netOf = k => a.nets.find(n => n.eps.includes(k)) || null;
    const leds = p.components.filter(c => c.type === 'LED');
    // 已經和 LED 相連的電阻
    for (const led of leds) {
      for (const lt of ['A', 'K']) {
        const n = netOf(led.id + '.' + lt); if (!n) continue;
        const r = n.comps.find(x => { const c = DL.project.findComp(p, x.comp); return c && c.type === 'RES' && !taken.has(c.id); });
        if (r && lt === 'A') { resistorFor[led.id] = { id: r.comp, outT: r.term, inT: r.term === '1' ? '2' : '1' }; taken.add(r.comp); break; }
      }
    }
    // 沒有配到的：先找一端已經接到這顆 LED 的腳位、另一端還空著的電阻；再找完全沒接線的電阻（最近的）
    for (const led of leds) {
      if (resistorFor[led.id]) continue;
      const half = p.components.find(c => c.type === 'RES' && !taken.has(c.id) && ['1', '2'].some(t => { const n = netOf(c.id + '.' + t), o = netOf(c.id + '.' + (t === '1' ? '2' : '1')); return n && pins[led.id] && n.eps.includes('board.' + pins[led.id]) && (!o || o.eps.length === 1 && !(o.bb || []).length); }));
      if (half) { const inT = ['1', '2'].find(t => { const n = netOf(half.id + '.' + t); return n && n.eps.includes('board.' + pins[led.id]); }); resistorFor[led.id] = { id: half.id, inT, outT: inT === '1' ? '2' : '1' }; taken.add(half.id); continue; }
      const free = p.components.filter(c => c.type === 'RES' && !taken.has(c.id) && !p.connections.some(w => w.kind !== 'insert' && (w.a.comp === c.id || w.b.comp === c.id)) && ['1', '2'].every(t => { const n = netOf(c.id + '.' + t); return !n || n.eps.length <= 2; }))
        .sort((x, y) => dist(x, led) - dist(y, led));
      let r = free[0];
      if (!r && opts.addParts) {
        if (p.lock && p.lock.components) { issues.push({ level: 'error', comp: led.id, msg: `${led.id} 缺少限流電阻，但這個引導實驗鎖定了元件清單。` }); continue; }
        r = addNear(p, 'RES', led, steps, `${led.id} 沒有限流電阻：自動加一顆 220 Ω`);
      }
      if (!r) { issues.push({ level: 'error', comp: led.id, msg: `${led.id} 需要一顆限流電阻：請放一顆電阻，或勾選「補上缺少的元件」。` }); continue; }
      // 方向：靠近 LED 的那一端接陽極
      const t1 = DL.terminalWorld(r, '1'), t2 = DL.terminalWorld(r, '2'), la = DL.terminalWorld(led, 'A') || led.pos;
      const outT = Math.hypot(t1.x - la.x, t1.z - la.z) < Math.hypot(t2.x - la.x, t2.z - la.z) ? '1' : '2';
      resistorFor[led.id] = { id: r.id, outT, inT: outT === '1' ? '2' : '1' }; taken.add(r.id);
    }
    // 兩顆以上伺服：需要外部電源
    const servos = p.components.filter(c => c.type === 'SERVO');
    if (servos.length >= 2 && !p.components.some(c => c.type === 'PSU')) {
      if (opts.addParts && !(p.lock && p.lock.components)) {
        const maxX = Math.max(...p.components.map(c => c.pos.x)); const avgZ = servos.reduce((s, c) => s + c.pos.z, 0) / servos.length;
        const r = DL.project.addComponent(p, 'PSU', { x: maxX + 5, z: avgZ }, 0);
        if (r.ok) steps.push({ kind: 'part', type: 'PSU', id: r.comp.id, pos: r.comp.pos, why: `${servos.length} 顆伺服同時轉動的電流可能超過控制板上限：自動加一個外部 5V 電源` });
      } else issues.push({ level: 'warn', msg: `${servos.length} 顆伺服由控制板供電會超過電流上限：建議加一個外部 5V 電源（勾選「補上缺少的元件」可以自動加）。` });
    }
    return { resistorFor };
  }
  function dist(x, y) { return Math.hypot(x.pos.x - y.pos.x, x.pos.z - y.pos.z); }
  // 在 LED 旁邊加一顆電阻；LED 插在麵包板上時，電阻也插在麵包板上，一端和 LED 陽極同一條
  function addNear(p, type, led, steps, why) {
    const m = DL.breadboard && DL.breadboard.mountOf(p, led.id);
    const r = DL.project.addComponent(p, type, { x: led.pos.x - 1.6, z: led.pos.z + 1.6 }, 0); if (!r.ok) return null;
    const c = r.comp;
    if (m) {
      const bb = DL.project.findComp(p, m.bb); const hA = m.holes.find(h => h.term === 'A');
      const H = DL.breadboard.BY_ID[hA.hole];
      if (H && !H.rail) {
        const half = H.row <= 'e' ? ['a', 'b', 'c', 'd', 'e'] : ['f', 'g', 'h', 'i', 'j'];
        outer: for (const dir of [-1, 1]) for (const row of half.slice().reverse()) {
          const far = H.col + dir * 4; if (far < 1 || far > 30) continue;
          const near = row + H.col, other = row + far;
          if (DL.breadboard.occupant(p, bb.id, near) || DL.breadboard.occupant(p, bb.id, other)) continue;
          if (p.connections.some(w => w.b.comp === bb.id && DL.breadboard.busOf(w.b.term) === DL.breadboard.busOf(other))) continue;   // 另一端那一條要是空的
          const first = dir < 0 ? other : near;   // 端子 1 在左邊
          try { DL.experiments.placeOn(p, c.id, bb.id, first); steps.push({ kind: 'part', type, id: c.id, pos: c.pos, why: why + `，插在 ${DL.breadboard.holeLabel(near)} 與 ${DL.breadboard.holeLabel(other)}` }); return c; } catch (e) { DL.breadboard.detach(p, c.id); }
          break outer;
        }
      }
    }
    steps.push({ kind: 'part', type, id: c.id, pos: c.pos, why });
    return c;
  }

  /* ---------- 4. 目前的導通情形 ---------- */
  function netIndex(a) { const m = {}; a.nets.forEach((n, i) => n.eps.forEach(k => { m[k] = i; })); return m; }
  function satisfied(p, a, idx, r) {
    const n = idx[key(r.e)]; if (n === undefined) return false; const net = a.nets[n];
    const t = r.t;
    if (t.pin) return net.eps.includes('board.' + t.pin);
    if (t.gnd) return net.gnd.some(g => !g.external);
    if (t.power) return net.power.some(x => !x.external && x.volts === t.power);
    if (t.term) return net.eps.includes(key(t.term));
    return false;
  }

  /* ---------- 5. 找出接錯的線（把兩個不該相通的群組連在一起） ---------- */
  function groupsOf(p, rel) {
    const parent = {}; const f = k => { if (!(k in parent)) parent[k] = k; while (parent[k] !== k) { parent[k] = parent[parent[k]]; k = parent[k]; } return k; };
    const u = (x, y) => { parent[f(x)] = f(y); };
    const tk = t => t.pin ? 'board.' + t.pin : t.gnd ? 'GND' : t.power ? 'P' + t.power : key(t.term);
    for (const r of rel) u(key(r.e), tk(r.t));
    const board = DL.boards[p.board.type];
    return k => {
      if (k.startsWith('board.')) { const pin = board.pinById[k.slice(6)]; if (pin && pin.kind === 'gnd') return f('GND'); if (pin && pin.kind === 'power') return f('P' + pin.volts); }
      if (/\.GND$/.test(k) && DL.project.findComp(p, k.split('.')[0]) && DL.project.findComp(p, k.split('.')[0]).type === 'PSU') return f('GND');
      return k in parent ? f(k) : null;
    };
  }
  function mixedNets(p, rel) {
    const a = DL.netlist.analyze(p); const g = groupsOf(p, rel); let count = 0;
    for (const n of a.nets) { const s = new Set(n.eps.map(g).filter(Boolean)); if (s.size > 1) count++; }
    return count;
  }
  function findWrong(p, rel) {
    const base = mixedNets(p, rel); if (!base) return [];
    const wrong = [];
    for (const w of p.connections) {
      if (w.kind === 'insert') continue;
      const q = clone(p); q.connections = q.connections.filter(x => x.id !== w.id);
      if (mixedNets(q, rel) < base) wrong.push(w);
    }
    return wrong;
  }

  /* ---------- 6. 接線點：插在麵包板上的腳要接到同一條導通條的空孔 ---------- */
  function freeHole(p, bbId, bus, prefer) {
    const holes = DL.breadboard.holesOfBus(bus).filter(h => !DL.breadboard.occupant(p, bbId, h.id));
    if (!holes.length) return null;
    if (prefer) holes.sort((x, y) => Math.hypot(x.x - prefer.x, x.z - prefer.z) - Math.hypot(y.x - prefer.x, y.z - prefer.z));
    else holes.sort((x, y) => (x.row && y.row ? (x.row <= 'e' ? x.row.localeCompare(y.row) : y.row.localeCompare(x.row)) : 0));   // 上半部優先 a、下半部優先 j（靠外側，方便插線）
    return holes[0];
  }
  function attachFor(p, ep, toward) {
    if (ep.comp === 'board') return { ep };
    const m = DL.breadboard && DL.breadboard.mountOf(p, ep.comp);
    if (!m) return { ep };
    const h = m.holes.find(x => x.term === ep.term); const bus = DL.breadboard.busOf(h.hole);
    const fh = freeHole(p, m.bb, bus, toward);
    if (!fh) return { fail: `${ep.comp} 那一條導通條（${DL.breadboard.busLabel(bus)}）已經沒有空孔` };
    return { ep: T(m.bb, fh.id), bb: m.bb, bus };
  }
  // 控制板上還沒接線的腳位優先（一個排針孔只插得進一條杜邦線）
  function boardPin(p, kind, volts) {
    const board = DL.boards[p.board.type];
    const cands = board.pins.filter(x => x.kind === kind && (kind !== 'power' || x.volts === volts));
    const wired = id => p.connections.filter(w => (w.a.comp === 'board' && w.a.term === id) || (w.b.comp === 'board' && w.b.term === id)).length;
    cands.sort((x, y) => wired(x.id) - wired(y.id));
    return cands[0] || null;
  }
  // 麵包板的 − 電源排：沒有接到 GND 的話，先從控制板 GND 接一條過去
  function groundRail(p, a, bbId, rail, steps) {
    const BBm = DL.breadboard; const idx = netIndex(a);
    const k = bbId + '.' + rail; const n = idx[k];
    if (n !== undefined && a.nets[n].gnd.some(g => !g.external)) return true;
    const g = boardPin(p, 'gnd'); const h = freeHole(p, bbId, rail); if (!g || !h) return false;
    return add(p, B(g.id), T(bbId, h.id), `控制板 ${g.label} 接到麵包板${BBm.busLabel(rail)}：之後所有要接地的腳都接到這一排`, steps);
  }
  function add(p, x, y, why, steps) {
    const r = DL.project.addConnection(p, x, y);
    if (!r.ok) return false;
    steps.push({ kind: 'wire', a: x, b: y, why, id: r.wire.id, text: `${epName(p, x)} ↔ ${epName(p, y)}` });
    return true;
  }

  /* ---------- 7. 主程式 ---------- */
  function plan(p0, opts) {
    opts = opts || {};
    const p = clone(p0); const steps = []; const issues = [];
    let a = DL.netlist.analyze(p);
    const pins = assignPins(p, a, issues);
    const extra = pairParts(p, a, opts, steps, issues, pins);
    a = DL.netlist.analyze(p);
    let rel = relations(p, a, pins, extra, issues);
    // 接錯的線
    const wrong = findWrong(p, rel);
    for (const w of wrong) {
      const why = `${w.id}（${epName(p, w.a)} ↔ ${epName(p, w.b)}）把不該相通的兩組接在一起`;
      if (opts.fixWrong) { DL.project.removeConnection(p, w.id); steps.push({ kind: 'remove', id: w.id, why: why + '：移除' }); }
      else issues.push({ level: 'warn', wire: w.id, msg: why + '。可以勾選「移除接錯的線」，或自己刪掉後再自動完成。' });
    }
    if (wrong.length && !opts.fixWrong) return finish();
    // 逐一補上缺少的連線
    for (const r of rel) {
      a = DL.netlist.analyze(p); const idx = netIndex(a);
      if (satisfied(p, a, idx, r)) continue;
      const ea = attachFor(p, r.e, null);
      if (ea.fail) { issues.push({ level: 'error', msg: ea.fail }); continue; }
      let target;
      if (r.t.pin) target = { ep: B(r.t.pin) };
      else if (r.t.power) { const pin = boardPin(p, 'power', r.t.power); if (!pin) { issues.push({ level: 'error', msg: `${DL.boards[p.board.type].short} 沒有 ${r.t.power}V 電源腳` }); continue; } target = { ep: B(pin.id) }; }
      else if (r.t.term) target = attachFor(p, r.t.term, null);
      else if (r.t.gnd) {
        if (ea.bb) {   // 插在麵包板上：接到同一塊麵包板的 − 電源排
          const H = DL.breadboard.BY_ID[ea.ep.term]; const rail = H && H.rail ? H.rail : (H && H.row > 'e' ? 'BN' : 'TN');
          if (!groundRail(p, a, ea.bb, rail, steps)) { issues.push({ level: 'error', msg: '麵包板的 − 電源排沒有空孔可以接 GND' }); continue; }
          const bbc = DL.project.findComp(p, ea.bb); const hw = DL.breadboard.holeWorld(bbc, ea.ep.term);
          const lc = DL.breadboard.toLocal(bbc, hw.x, hw.z); const rh = freeHole(p, ea.bb, rail, { x: lc[0], z: lc[1] });
          target = rh ? { ep: T(ea.bb, rh.id) } : { fail: '− 電源排沒有空孔' };
        } else { const g = boardPin(p, 'gnd'); target = g ? { ep: B(g.id) } : { fail: '控制板沒有 GND 腳' }; }
      }
      if (!target || target.fail) { issues.push({ level: 'error', msg: (target && target.fail) || '找不到接線點' }); continue; }
      if (target.ep.comp === ea.ep.comp && target.ep.term === ea.ep.term) continue;
      if (!add(p, ea.ep, target.ep, r.why + (ea.bb && ea.ep.comp !== r.e.comp ? `（${r.e.comp} 插在麵包板上，線接到同一條導通條的 ${DL.breadboard.holeLabel(ea.ep.term)}）` : ''), steps)) {
        const res = DL.project.addConnection(clone(p), ea.ep, target.ep);
        issues.push({ level: 'error', msg: `${r.why}：無法建立連線（${res.msg}）` });
      }
    }
    return finish();

    function finish() {
      const after = DL.netlist.analyze(p);
      return { steps, issues, pins, project: p, done: !steps.some(s => s.kind !== 'remove') && !issues.some(i => i.level === 'error'), analysis: after, wrong: wrong.map(w => w.id) };
    }
  }

  // 把計畫的前 n 步（不給 n 就全部）套用到真正的專案；回傳實際做了哪些步驟
  function apply(p, opts, n) {
    const done = [];
    for (let i = 0; i < (n || 999); i++) {
      const pl = plan(p, opts); const s = pl.steps[0];
      if (!s) return { done, plan: pl };
      if (s.kind === 'remove') DL.project.removeConnection(p, s.id);
      else if (s.kind === 'part') {
        // 從模擬結果拷貝新元件（包含插在麵包板上的孔位）
        const c = pl.project.components.find(x => x.id === s.id);
        p.components.push(clone(c)); const pre = DL.components[s.type].prefix; p.counters[pre] = pl.project.counters[pre]; p.counters.I = Math.max(p.counters.I || 0, pl.project.counters.I || 0);
        for (const w of pl.project.connections) if (w.kind === 'insert' && w.a.comp === s.id) p.connections.push(clone(w));
      } else if (s.kind === 'wire') { const r = DL.project.addConnection(p, s.a, s.b); if (!r.ok) return { done, plan: pl, error: r.msg }; s.id = r.wire.id; }
      done.push(s);
    }
    return { done, plan: plan(p, opts) };
  }

  DL.autowire = { plan, apply, PREF, epName, US_SLOTS };
  if (typeof module !== 'undefined') module.exports = DL;
})(typeof globalThis !== 'undefined' ? globalThis : this);
