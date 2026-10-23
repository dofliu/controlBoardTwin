/* DofLab — 擬真 3D 模型（程序化建模）
 * 依公開的機構尺寸建出板形、安裝孔、晶片、接頭、排針、被動元件與絲印。
 * 刻意不重現任何品牌商標圖案；絲印只保留腳位與功能標示。
 * 單位：公分。板子中心在原點，板面頂部 y = t。
 */
(function (root) {
  const DL = root.DL;
  const T = () => root.THREE;
  const PIN_TOP = { uno: 0.85, esp32: 0.86, esp32doit: 0.86, pi4b: 0.86 };   // 端點（插針頂端）高於板面多少

  // 決定性亂數：每次畫出來的走線都一樣
  function rng(seed) { let s = seed >>> 0; return () => ((s = Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9 >>> 0) / 4294967296); }

  function M(THREE, color, o) { return new THREE.MeshStandardMaterial(Object.assign({ color: new THREE.Color(color), roughness: 0.6, metalness: 0.05 }, o || {})); }
  const MAT = {};
  function mat(key, color, o) { const THREE = T(); return MAT[key] || (MAT[key] = M(THREE, color, o)); }
  const metal = () => mat('metal', '#c3c8cc', { metalness: 0.85, roughness: 0.32 });
  const darkMetal = () => mat('dmetal', '#8d949a', { metalness: 0.8, roughness: 0.4 });
  const gold = () => mat('gold', '#d4ad4f', { metalness: 0.9, roughness: 0.28 });
  const black = () => mat('black', '#121315', { roughness: 0.82 });
  const plastic = c => mat('pl' + c, c, { roughness: 0.55 });

  function box(w, h, d, m, x, y, z) { const THREE = T(); const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x || 0, y || 0, z || 0); o.castShadow = true; o.receiveShadow = true; return o; }
  function cyl(r, h, m, x, y, z, seg, rt) { const THREE = T(); const o = new THREE.Mesh(new THREE.CylinderGeometry(rt == null ? r : rt, r, h, seg || 24), m); o.position.set(x || 0, y || 0, z || 0); o.castShadow = true; o.receiveShadow = true; return o; }
  function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

  /* ---------------- PCB：外形擠出＋頂面印刷貼圖 ---------------- */
  function pcb(spec) {
    const THREE = T(); const { w, h, t, color, corner, holes, chamfers } = spec;
    const shape = new THREE.Shape(); const r = corner || 0.05;
    const x0 = -w / 2, x1 = w / 2, z0 = -h / 2, z1 = h / 2;
    const ch = chamfers || {};
    // Shape 在 XY 平面畫，之後旋轉成 XZ（y = −z）
    if (spec.outline) { const o = spec.outline; shape.moveTo(o[0][0], -o[0][1]); for (let i = 1; i < o.length; i++) shape.lineTo(o[i][0], -o[i][1]); shape.closePath(); }   // 依機構圖的外形（例如 Uno 右側的階梯與斜角）
    else {
    shape.moveTo(x0 + r, -z0);
    shape.lineTo(x1 - (ch.tr || r), -z0); ch.tr ? shape.lineTo(x1, -z0 - ch.tr) : shape.quadraticCurveTo(x1, -z0, x1, -z0 - r);
    shape.lineTo(x1, -z1 + (ch.br || r)); ch.br ? shape.lineTo(x1 - ch.br, -z1) : shape.quadraticCurveTo(x1, -z1, x1 - r, -z1);
    shape.lineTo(x0 + r, -z1); shape.quadraticCurveTo(x0, -z1, x0, -z1 + r);
    shape.lineTo(x0, -z0 - r); shape.quadraticCurveTo(x0, -z0, x0 + r, -z0);
    }
    for (const [hx, hz, hr] of holes || []) { const p = new THREE.Path(); p.absarc(hx, -hz, hr, 0, Math.PI * 2, true); shape.holes.push(p); }
    const geo = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: 18 });
    geo.rotateX(-Math.PI / 2);   // 擠出方向 → +Y
    const body = new THREE.Mesh(geo, [M(THREE, color, { roughness: 0.5 }), M(THREE, spec.edge || '#c9b98a', { roughness: 0.8 })]);
    body.castShadow = true; body.receiveShadow = true;
    // 頂面貼圖
    const S = 160, cv = document.createElement('canvas'); cv.width = Math.round(w * S); cv.height = Math.round(h * S);
    const g = cv.getContext('2d'); const px = x => (x + w / 2) * S, pz = z => (z + h / 2) * S;
    g.save(); g.beginPath(); if (spec.outline) { spec.outline.forEach(([ox, oz], i) => i ? g.lineTo(px(ox), pz(oz)) : g.moveTo(px(ox), pz(oz))); g.closePath(); } else g.rect(0, 0, cv.width, cv.height); for (const [hx, hz, hr] of holes || []) { g.moveTo(px(hx) + hr * S * 1.9, pz(hz)); g.arc(px(hx), pz(hz), hr * S * 1.9, 0, Math.PI * 2, true); } g.clip('evenodd');
    g.fillStyle = color; g.fillRect(0, 0, cv.width, cv.height);
    // 細微色差
    const rnd = rng(spec.seed || 1);
    for (let i = 0; i < 2600; i++) { g.fillStyle = `rgba(0,0,0,${rnd() * 0.05})`; g.fillRect(rnd() * cv.width, rnd() * cv.height, 2, 2); }
    // 走線（45° 與正交），顏色比底色略亮
    g.strokeStyle = spec.trace || 'rgba(255,255,255,0.13)'; g.lineCap = 'round'; g.lineJoin = 'round';
    for (let i = 0; i < (spec.traces || 70); i++) {
      g.lineWidth = rnd() < 0.15 ? 5 : 2.2; g.beginPath(); let x = rnd() * cv.width, y = rnd() * cv.height; g.moveTo(x, y);
      for (let k = 0; k < 3 + rnd() * 4; k++) { const len = 20 + rnd() * 140; const dir = Math.floor(rnd() * 8); const a = dir * Math.PI / 4; x += Math.cos(a) * len; y += Math.sin(a) * len; g.lineTo(x, y); }
      g.stroke(); g.fillStyle = spec.via || 'rgba(220,190,120,0.9)'; g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.fill();
    }
    g.restore();
    // 安裝孔的鍍錫環
    for (const [hx, hz, hr] of holes || []) { g.strokeStyle = 'rgba(205,205,200,0.95)'; g.lineWidth = hr * S * 0.9; g.beginPath(); g.arc(px(hx), pz(hz), hr * S * 1.45, 0, Math.PI * 2); g.stroke(); }
    if (spec.draw) spec.draw(g, px, pz, S);
    const tex = new THREE.CanvasTexture(cv); tex.anisotropy = 8; tex.encoding = THREE.sRGBEncoding;
    const top = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.45, metalness: 0.05 }));
    top.rotation.x = -Math.PI / 2; top.position.y = t + 0.002; top.receiveShadow = true; top.renderOrder = 1;
    const grp = new THREE.Group(); grp.add(body); grp.add(top);
    return { group: grp, canvas: cv, tex, top };
  }

  // 絲印文字
  function silk(g, text, x, y, size, opts) {
    opts = opts || {}; g.save(); g.translate(x, y); if (opts.rot) g.rotate(opts.rot);
    g.font = `${opts.weight || 600} ${size}px ${opts.font || '"IBM Plex Mono", "Noto Sans TC", monospace'}`; g.fillStyle = opts.color || 'rgba(250,250,245,0.92)';
    g.textAlign = opts.align || 'center'; g.textBaseline = 'middle'; g.fillText(text, 0, 0); g.restore();
  }
  function silkRect(g, x, y, w, h, lw) { g.strokeStyle = 'rgba(250,250,245,0.85)'; g.lineWidth = lw || 3; g.strokeRect(x, y, w, h); }

  /* ---------------- 共用零件 ---------------- */
  function femaleHeader(n, pitch) {   // 沿 X 方向的單排母座
    const THREE = T(); const g = new THREE.Group(); const L = n * pitch;
    g.add(box(L, 0.85, 0.25, black(), 0, 0.425, 0));
    for (let i = 0; i < n; i++) { const x = -L / 2 + pitch / 2 + i * pitch; g.add(box(0.1, 0.02, 0.1, mat('hole', '#050505'), x, 0.851, 0)); }
    return g;
  }
  function maleHeader(n, rows, pitch) {   // 針朝上的排針
    const THREE = T(); const g = new THREE.Group(); const L = n * pitch, D = rows * pitch;
    g.add(box(L, 0.25, D, black(), 0, 0.125, 0));
    for (let r = 0; r < rows; r++) for (let i = 0; i < n; i++) g.add(box(0.064, 0.61, 0.064, gold(), -L / 2 + pitch / 2 + i * pitch, 0.25 + 0.305, -D / 2 + pitch / 2 + r * pitch));
    return g;
  }
  function chip(w, d, h, pins, opts) {      // pins: 'dip' | 'soic' | 'qfn' | 'sot223'
    const THREE = T(); const g = new THREE.Group(); opts = opts || {};
    g.add(box(w, h, d, mat('ic', '#0e0f11', { roughness: 0.68 }), 0, h / 2, 0));
    if (pins === 'dip' || pins === 'soic') {
      const n = opts.n || 14; const pitch = pins === 'dip' ? 0.254 : 0.127; const len = pins === 'dip' ? 0.12 : 0.06;
      for (let i = 0; i < n; i++) { const x = -((n - 1) * pitch) / 2 + i * pitch; for (const s of [-1, 1]) g.add(box(pins === 'dip' ? 0.05 : 0.04, pins === 'dip' ? 0.25 : 0.03, len, metal(), x, pins === 'dip' ? h * 0.35 : 0.02, s * (d / 2 + len / 2))); }
      g.add(cyl(pins === 'dip' ? 0.05 : 0.025, 0.01, mat('dot', '#3a3d40'), -w / 2 + 0.15, h + 0.005, 0, 16));
    }
    if (pins === 'qfn') for (const s of [-1, 1]) for (let i = 0; i < 6; i++) { g.add(box(0.03, 0.02, 0.02, metal(), -w / 2 + 0.08 + i * (w - 0.16) / 5, 0.01, s * (d / 2 + 0.01))); }
    if (pins === 'sot223') { g.add(box(w * 0.75, 0.03, 0.18, metal(), 0, 0.015, -d / 2 - 0.09)); for (let i = -1; i <= 1; i++) g.add(box(0.07, 0.03, 0.15, metal(), i * 0.23, 0.015, d / 2 + 0.075)); }
    if (opts.label) { const s = labelPlane(opts.label, w * 0.9, d * 0.6, opts.labelSize); s.position.y = h + 0.002; g.add(s); }
    return g;
  }
  function labelPlane(text, w, d, size) {
    const THREE = T(); const cv = document.createElement('canvas'); cv.width = 512; cv.height = Math.max(32, Math.round(512 * d / w));
    const g = cv.getContext('2d'); g.fillStyle = 'rgba(205,205,200,0.62)'; g.font = `600 ${size || 54}px "IBM Plex Mono", monospace`; g.textAlign = 'center'; g.textBaseline = 'middle';
    String(text).split('\n').forEach((ln, i, a) => g.fillText(ln, 256, cv.height / 2 + (i - (a.length - 1) / 2) * (size || 54) * 1.15));
    const tex = new THREE.CanvasTexture(cv); tex.encoding = THREE.sRGBEncoding;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })); m.rotation.x = -Math.PI / 2; m.raycast = () => { }; return m;
  }
  function smd(g, rnd, area, n, colors) {   // 散布的貼片電阻電容
    for (let i = 0; i < n; i++) {
      const x = area[0] + rnd() * (area[2] - area[0]), z = area[1] + rnd() * (area[3] - area[1]); const vert = rnd() < 0.5;
      const c = colors[Math.floor(rnd() * colors.length)];
      const part = box(vert ? 0.08 : 0.16, 0.05, vert ? 0.16 : 0.08, mat('smd' + c, c, { roughness: 0.5 }), x, 0.025, z);
      g.add(part);
      for (const s of [-1, 1]) g.add(box(vert ? 0.082 : 0.03, 0.052, vert ? 0.03 : 0.082, metal(), x + (vert ? 0 : s * 0.065), 0.026, z + (vert ? s * 0.065 : 0)));
    }
  }
  function smdLed(color, x, z) { const THREE = T(); const g = new THREE.Group(); const m = M(THREE, '#f2f2ec', { roughness: 0.3 }); g.add(box(0.16, 0.06, 0.08, m, x, 0.03, z)); const lens = box(0.08, 0.03, 0.06, M(THREE, color, { transparent: true, opacity: 0.85, emissive: new THREE.Color('#000') }), x, 0.075, z); g.add(lens); g.userData.lens = lens; g.userData.color = color; return g; }
  function tact(x, z, size, capColor) { const THREE = T(); const g = new THREE.Group(); g.add(box(size, size * 0.5, size, black(), x, size * 0.25, z)); g.add(box(size * 0.98, 0.02, size * 0.98, metal(), x, size * 0.5, z)); g.add(cyl(size * 0.3, size * 0.25, plastic(capColor || '#222'), x, size * 0.62, z, 20)); return g; }
  function electrolytic(r, h, x, z) { const THREE = T(); const g = new THREE.Group(); g.add(cyl(r, h, mat('alu', '#d7dadc', { metalness: 0.75, roughness: 0.35 }), x, h / 2, z, 28)); const sleeve = cyl(r * 1.01, h * 0.92, mat('capsl', '#1f2a44', { roughness: 0.5 }), x, h * 0.46, z, 28); g.add(sleeve); const stripe = box(r * 0.5, h * 0.92, 0.02, mat('stripe', '#c9ccd2'), x, h * 0.46, z - r * 0.98); g.add(stripe); return g; }

  /* ======================= Arduino Uno R3（68.6 × 53.3 mm） ======================= */
  function uno(b) {
    const THREE = T(); const { w, h, t } = b.size; const grp = new THREE.Group();
    const mm = (x, y) => [x / 10 - w / 2, h / 2 - y / 10];      // 機構圖座標（左下為原點，mm）→ 場景
    const holes = [[14.0, 2.5], [15.3, 50.7], [66.1, 7.6], [66.1, 35.5]].map(([x, y]) => [...mm(x, y), 0.16]);
    const P = pcb({
      w, h, t, color: '#0e7c88', corner: 0.08, holes, seed: 11, traces: 90,
      // Uno R3 外形（機構圖，mm，左下為原點）：右側上段較窄、兩處 45° 斜角
      outline: [[0, 0], [66.04, 0], [68.58, 2.54], [68.58, 37.08], [66.04, 39.62], [66.04, 51.82], [64.52, 53.34], [0, 53.34]].map(([x, y]) => mm(x, y)),
      draw(g, px, pz, S) {
        const L = b.layout;
        for (const [id, pos] of Object.entries(L)) { const pin = b.pinById[id]; const lbl = pin.kind === 'gnd' ? 'GND' : pin.label.replace(/^D/, ''); silk(g, lbl, px(pos.x), pz(pos.z) + (pos.side === 'top' ? 52 : -52), 19, { rot: -Math.PI / 2 }); }
        for (const [id, pos] of Object.entries(b.layoutExtra || {})) if (id !== 'NC') silk(g, id, px(pos.x), pz(pos.z) + 52, 17, { rot: -Math.PI / 2 });
        silk(g, 'DIGITAL (PWM~)', px(1.2), pz(-1.55), 24); silk(g, 'POWER', px(-0.28), pz(1.62), 22); silk(g, 'ANALOG IN', px(2.2), pz(1.62), 22);
        silk(g, 'UNO R3', px(0.1), pz(-0.35), 64, { weight: 800, font: '"Noto Sans TC", sans-serif' });
        silk(g, 'ON', px(3.0), pz(-1.0), 18); silk(g, 'L', px(-0.55), pz(-1.86), 18); silk(g, 'TX', px(-0.55), pz(-1.58), 18); silk(g, 'RX', px(-0.55), pz(-1.35), 18);
        silk(g, 'ICSP', px(3.05), pz(-0.65), 18, { rot: -Math.PI / 2 }); silk(g, 'RESET', px(-2.85), pz(-1.85), 16); silk(g, 'ICSP', px(-1.61), pz(-1.38), 15);
        silkRect(g, px(-0.4), pz(0.55), 3.7 * S, 0.9 * S); // ATmega 外框
        g.fillStyle = 'rgba(250,250,245,0.85)'; g.fillRect(px(-3.2), pz(-2.45), 6, 6);
      }
    });
    grp.add(P.group);
    // USB-B、DC 電源插座
    const [ux, uz] = mm(1.8, 37.7); const usb = new THREE.Group(); usb.add(box(1.6, 1.09, 1.2, metal(), 0, 0.545, 0)); usb.add(box(0.05, 0.7, 0.85, black(), -0.79, 0.5, 0)); usb.position.set(ux, t, uz); grp.add(usb);
    // DC 圓形電源插座：方形本體＋前端圓筒（2.1 mm 中心針）
    const [jx, jz] = mm(5.0, 7.8); const jack = new THREE.Group(); jack.add(box(1.25, 1.1, 0.9, black(), 0.08, 0.55, 0)); jack.add(cyl(0.45, 0.35, black(), -0.62, 0.62, 0, 28).rotateZ(Math.PI / 2)); jack.add(cyl(0.3, 0.02, mat('jackhole', '#050505'), -0.8, 0.62, 0, 24).rotateZ(Math.PI / 2)); jack.add(cyl(0.05, 0.03, metal(), -0.81, 0.62, 0, 12).rotateZ(Math.PI / 2)); jack.position.set(jx, t, jz); grp.add(jack);
    // ATmega328P（DIP-28）與插座
    const [ax, az] = mm(48.8, 16.8); const sock = box(3.75, 0.25, 0.9, mat('socket', '#2a2a2a'), ax, t + 0.125, az); grp.add(sock);
    const mcu = chip(3.56, 0.75, 0.33, 'dip', { n: 14, label: 'ATMEGA328P-PU', labelSize: 30 }); mcu.position.set(ax, t + 0.25, az); grp.add(mcu);
    // 16U2、振盪器、穩壓器、電解電容
    const u2 = chip(0.5, 0.5, 0.09, 'qfn', { label: '16U2', labelSize: 90 }); u2.position.set(...(([x, z]) => [x, t, z])(mm(19.5, 28.5))); grp.add(u2);
    const [cx, cz] = mm(27.5, 36.5); const xtal = new THREE.Group(); const xb = box(1.0, 0.36, 0.42, metal(), 0, 0.18, 0); xtal.add(xb); for (const s of [-1, 1]) xtal.add(cyl(0.21, 0.36, metal(), s * 0.5, 0.18, 0, 20)); xtal.position.set(cx, t, cz); grp.add(xtal);
    const reg = chip(0.65, 0.35, 0.16, 'sot223'); reg.position.set(...(([x, z]) => [x, t, z])(mm(17, 8))); grp.add(reg);
    for (const [x, y] of [[20.5, 14.5], [27.0, 14.5]]) { const [ex, ez] = mm(x, y); grp.add(electrolytic(0.31, 0.55, ex, ez).translateY(t)); }
    // 重置按鈕、ICSP、LED
    const [rx, rz] = mm(5.5, 49.0); grp.add(tact(rx, rz, 0.6, '#5a2a1a').translateY(t));
    const icsp = maleHeader(3, 2, 0.254); icsp.rotation.y = Math.PI / 2; icsp.position.set(...(([x, z]) => [x, t, z])(mm(64.0, 27.5))); grp.add(icsp);
    const icsp2 = maleHeader(3, 2, 0.254); icsp2.position.set(...(([x, z]) => [x, t, z])(mm(18.2, 46.0))); grp.add(icsp2);   // 16U2 的 ICSP（USB 旁）
    const leds = {};
    for (const [k, c, x, y] of [['ON', '#3ddc6b', 64.0, 37.0], ['L', '#ffb020', 29.5, 45.6], ['TX', '#ffb020', 29.5, 42.9], ['RX', '#ffb020', 29.5, 40.6]]) { const [lx, lz] = mm(x, y); const l = smdLed(c, lx, lz); l.position.y = t; grp.add(l); leds[k] = l.userData.lens; }
    const sm = new THREE.Group(); smd(sm, rng(5), [-3.0, -0.6, 2.6, 1.9], 26, ['#2b2b2b', '#b48a4a', '#c9b48c']); sm.position.y = t; grp.add(sm);
    // 母座排針
    headers(grp, b, t, 'female');
    return { group: grp, leds, pinTop: t + PIN_TOP.uno };
  }

  // 依 layout 的連續腳位段落放置排針外殼
  function headers(grp, b, t, kind) {
    const rows = {};
    for (const [id, pos] of Object.entries(Object.assign({}, b.layout, b.layoutExtra || {}))) (rows[pos.z.toFixed(3)] = rows[pos.z.toFixed(3)] || []).push(pos.x);
    for (const [z, xs] of Object.entries(rows)) {
      xs.sort((a, c) => a - c); let start = 0;
      for (let i = 1; i <= xs.length; i++) {
        if (i === xs.length || xs[i] - xs[i - 1] > 0.3) {
          const seg = xs.slice(start, i); const n = seg.length; const cx = (seg[0] + seg[n - 1]) / 2;
          const hd = kind === 'female' ? femaleHeader(n, 0.254) : maleHeader(n, 1, 0.254);
          hd.position.set(cx, t, +z); grp.add(hd); start = i;
        }
      }
    }
  }

  /* ======================= ESP32-DevKitC V4（約 55 × 28 mm） ======================= */
  function esp32(b) {
    const THREE = T(); const { w, h, t } = b.size; const grp = new THREE.Group(); const doit = b.id === 'esp32doit';
    const P = pcb({
      w, h, t, color: doit ? '#141a2b' : '#18191b', corner: 0.06, seed: 23, traces: 40, trace: 'rgba(255,255,255,0.07)', via: 'rgba(200,170,90,0.8)',
      draw(g, px, pz, S) {
        for (const [id, pos] of Object.entries(b.layout)) { const pin = b.pinById[id]; const lbl = pin.kind === 'gpio' ? String(pin.num) : pin.kind === 'gnd' ? 'GND' : pin.label; silk(g, lbl, px(pos.x), pz(pos.z) + (pos.side === 'top' ? 44 : -44), 16, { rot: -Math.PI / 2 }); }
        if (doit) {   // DevKit V1：EN／BOOT 鍵在 USB 兩側，藍燈（GPIO2）與紅色電源燈在旁邊
          const F = b.features; silk(g, 'EN', px(F.en.x - 0.42), pz(F.en.z), 15); silk(g, 'BOOT', px(F.boot.x - 0.48), pz(F.boot.z), 15);
          silk(g, 'D2', px(F.led.x - 0.3), pz(F.led.z), 14); silk(g, 'PWR', px(F.pwr.x - 0.32), pz(F.pwr.z), 14);
          silk(g, 'ESP32 DEVKIT V1 · DOIT', px(0.55), pz(0.62), 20, { weight: 700 });
        } else {
          silk(g, 'EN', px(w / 2 - 0.85), pz(-0.32), 16); silk(g, 'BOOT', px(w / 2 - 0.85), pz(0.32), 16);
          silk(g, 'ESP32-DevKitC V4', px(1.15), pz(0.62), 22, { weight: 700 });
        }
      }
    });
    grp.add(P.group);
    // WROOM-32 模組：天線端超出板緣一點
    const mod = new THREE.Group(); const mx = -w / 2 + 1.05;
    mod.add(box(2.55, 0.08, 1.8, mat('modpcb', '#20262e'), 0, 0.04, 0));
    mod.add(box(1.75, 0.24, 1.6, darkMetal(), 0.35, 0.2, 0));
    const ac = document.createElement('canvas'); ac.width = 128; ac.height = 340; const ag = ac.getContext('2d'); ag.strokeStyle = '#c9a64b'; ag.lineWidth = 9; ag.beginPath(); ag.moveTo(20, 320); for (let i = 0; i < 7; i++) { ag.lineTo(20, 40 + i * 40); ag.lineTo(108, 40 + i * 40); ag.lineTo(108, 60 + i * 40); ag.lineTo(20, 60 + i * 40); } ag.stroke();
    const atex = new THREE.CanvasTexture(ac); const aplane = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 1.6), new THREE.MeshBasicMaterial({ map: atex, transparent: true })); aplane.rotation.x = -Math.PI / 2; aplane.position.set(-0.95, 0.081, 0); mod.add(aplane);
    const lbl = labelPlane('ESP32-WROOM-32\n4MB', 1.5, 0.9, 46); lbl.position.set(0.35, 0.321, 0); mod.add(lbl);
    mod.position.set(mx - 0.1, t, 0); grp.add(mod);
    // micro-USB、按鈕、USB-UART 晶片、穩壓器、LED
    const usb = box(0.6, 0.27, 0.75, metal(), w / 2 - 0.22, t + 0.135, 0); grp.add(usb);
    const buttons = {};
    if (doit) {
      const F = b.features;
      const en = tact(F.en.x, F.en.z, 0.36, '#1a1a1a'); en.translateY(t); grp.add(en);
      const bt = tact(F.boot.x, F.boot.z, 0.36, '#1a1a1a'); bt.translateY(t); grp.add(bt); buttons.BOOT = bt.children[2];
      const uart = chip(0.5, 0.5, 0.09, 'qfn', { label: 'CP2102', labelSize: 60 }); uart.position.set(w / 2 - 1.75, t, 0); grp.add(uart);
      const pwr = smdLed('#ff3b30', F.pwr.x, F.pwr.z); pwr.position.y = t; grp.add(pwr);
      const usr = smdLed('#3a7bff', F.led.x, F.led.z); usr.position.y = t; grp.add(usr);
      const halo = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 10), new THREE.MeshBasicMaterial({ color: 0x4d8dff, transparent: true, opacity: 0.5, depthWrite: false })); halo.position.set(F.led.x, t + 0.1, F.led.z); halo.visible = false; halo.raycast = () => { }; grp.add(halo);   // 亮起時的光暈（SMD LED 很小，不然看不出來）
      const sm = new THREE.Group(); smd(sm, rng(9), [0.3, -0.7, 1.3, 0.7], 12, ['#2b2b2b', '#b48a4a']); sm.position.y = t; grp.add(sm);
      headers(grp, b, t, 'male');
      return { group: grp, leds: { PWR: pwr.userData.lens, USER: usr.userData.lens }, halos: { USER: halo }, buttons, pinTop: t + PIN_TOP.esp32doit };
    }
    const en = tact(w / 2 - 0.85, -0.55, 0.36, '#1a1a1a'); en.translateY(t); grp.add(en);
    const bt = tact(w / 2 - 0.85, 0.55, 0.36, '#1a1a1a'); bt.translateY(t); grp.add(bt); buttons.BOOT = bt.children[2];
    const uart = chip(0.5, 0.5, 0.09, 'qfn', { label: 'USB\nUART', labelSize: 70 }); uart.position.set(w / 2 - 1.7, t, 0.25); grp.add(uart);
    const reg = chip(0.65, 0.35, 0.16, 'sot223'); reg.position.set(w / 2 - 1.75, t, -0.5); grp.add(reg);
    const pwr = smdLed('#ff3b30', w / 2 - 1.25, 0.75); pwr.position.y = t; grp.add(pwr);
    const sm = new THREE.Group(); smd(sm, rng(9), [0.7, -0.75, 1.8, 0.75], 14, ['#2b2b2b', '#b48a4a']); sm.position.y = t; grp.add(sm);
    headers(grp, b, t, 'male');
    return { group: grp, leds: { PWR: pwr.userData.lens }, buttons, pinTop: t + PIN_TOP.esp32 };
  }

  /* ======================= Raspberry Pi 4 Model B（85 × 56 mm） ======================= */
  function pi4(b) {
    const THREE = T(); const { w, h, t } = b.size; const grp = new THREE.Group();
    const mm = (x, y) => [x / 10 - w / 2, y / 10 - h / 2];      // 左上為原點（GPIO 在上緣）
    const holes = [[3.5, 3.5], [61.5, 3.5], [3.5, 52.5], [61.5, 52.5]].map(([x, y]) => [...mm(x, y), 0.14]);
    const P = pcb({
      w, h, t, color: '#1d7a44', corner: 0.3, holes, seed: 41, traces: 110, trace: 'rgba(170,255,190,0.12)',
      draw(g, px, pz, S) {
        for (const [id, pos] of Object.entries(b.layout)) { const pin = b.pinById[id]; if (pin.phys === 1) { g.strokeStyle = 'rgba(250,250,245,0.9)'; g.lineWidth = 3; g.strokeRect(px(pos.x) - 20, pz(pos.z) - 20, 40, 40); } }
        silk(g, 'Pi 4 Model B', px(0.1), pz(-1.74), 30, { weight: 700, font: '"Noto Sans TC", sans-serif' });
        silk(g, 'GPIO', px(-2.2), pz(-1.85), 22); silk(g, 'POE', px(2.25), pz(-1.45), 18);
        silk(g, 'DISPLAY', px(-3.55), pz(0.2), 18, { rot: -Math.PI / 2 }); silk(g, 'CAMERA', px(0.35), pz(1.9), 16);
        silk(g, 'POWER', px(-3.1), pz(2.35), 16); silk(g, 'HDMI0', px(-1.6), pz(2.35), 16); silk(g, 'HDMI1', px(-0.25), pz(2.35), 16); silk(g, 'A/V', px(1.15), pz(2.35), 16);
      }
    });
    grp.add(P.group);
    const at = (o, x, y, yy) => { const [px, pz] = mm(x, y); o.position.set(px, t + (yy || 0), pz); grp.add(o); return o; };
    // SoC（金屬散熱蓋）、RAM、USB 控制器、PMIC、無線模組
    const soc = new THREE.Group(); soc.add(box(1.5, 0.12, 1.5, mat('socpcb', '#2c3236'), 0, 0.06, 0)); soc.add(box(1.38, 0.08, 1.38, metal(), 0, 0.16, 0)); const sl = labelPlane('BCM2711', 1.2, 0.5, 60); sl.position.y = 0.201; soc.add(sl); at(soc, 28.5, 20.3);
    at(chip(1.0, 1.45, 0.1, 'qfn', { label: 'LPDDR4', labelSize: 70 }), 44.8, 20.3);
    at(chip(0.85, 0.85, 0.09, 'qfn', { label: 'VL805', labelSize: 80 }), 56.5, 28.5);
    at(chip(0.6, 0.6, 0.08, 'qfn'), 55.5, 16.5);
    at(chip(0.5, 0.5, 0.08, 'qfn'), 9.5, 44.0);
    const wifi = new THREE.Group(); wifi.add(box(1.0, 0.16, 1.25, metal(), 0, 0.08, 0)); at(wifi, 11.0, 12.8);   // 無線模組的金屬遮罩
    // 右緣：乙太網路、USB 3（藍）、USB 2（黑）
    const eth = new THREE.Group(); eth.add(box(2.12, 1.36, 1.6, metal(), 0, 0.68, 0)); eth.add(box(0.02, 0.85, 1.15, black(), 1.07, 0.6, 0)); eth.add(box(0.03, 0.12, 0.25, mat('ledg', '#2fbf55'), 1.075, 1.22, -0.55)); eth.add(box(0.03, 0.12, 0.25, mat('ledy', '#e5b020'), 1.075, 1.22, 0.55)); at(eth, 76.0, 10.25);
    for (const [y, c] of [[29.0, '#2c63c9'], [47.0, '#1b1b1b']]) {
      const u = new THREE.Group(); u.add(box(1.75, 1.6, 1.45, metal(), 0, 0.8, 0));
      for (const yy of [0.42, 1.17]) { u.add(box(0.02, 0.5, 1.2, mat('usbhole', '#0c0c0c'), 0.876, yy, 0)); u.add(box(0.03, 0.18, 1.0, mat('usb' + c, c), 0.876, yy - 0.06, 0)); }
      at(u, 78.0, y);
    }
    // 下緣：USB-C、2 × micro-HDMI、音訊
    at(box(0.9, 0.33, 0.75, metal(), 0, 0.165, 0), 11.2, 52.6);
    at(box(0.65, 0.3, 0.75, metal(), 0, 0.15, 0), 26.0, 52.6);
    at(box(0.65, 0.3, 0.75, metal(), 0, 0.15, 0), 39.5, 52.6);
    const av = new THREE.Group(); av.add(box(0.7, 0.6, 1.2, black(), 0, 0.3, 0)); av.add(cyl(0.3, 0.25, black(), 0, 0.3, 0.68, 20).rotateX(Math.PI / 2)); at(av, 54.0, 50.2);
    // FPC 排線座（顯示、攝影機）、PoE 排針、LED
    const fpc = (len) => { const f = new THREE.Group(); f.add(box(len, 0.28, 0.5, mat('fpc', '#e9e2cf'), 0, 0.14, 0)); f.add(box(len, 0.08, 0.15, mat('fpcl', '#5a3b1e'), 0, 0.3, -0.2)); return f; };
    const disp = fpc(2.0); disp.rotation.y = Math.PI / 2; at(disp, 3.0, 28.0);
    const cam = fpc(2.0); cam.rotation.y = Math.PI / 2; at(cam, 45.0, 46.0);
    const poe = maleHeader(2, 2, 0.254); at(poe, 60.0, 8.5);
    const pl = smdLed('#ff3b30', 0, 0), al = smdLed('#3ddc6b', 0, 0); at(pl, 2.5, 47.0); at(al, 2.5, 49.0);
    const sm = new THREE.Group(); smd(sm, rng(77), [-3.8, -1.2, 2.8, 2.0], 40, ['#2b2b2b', '#b48a4a', '#c9b48c']); sm.position.y = t; grp.add(sm);
    headers(grp, b, t, 'male');
    return { group: grp, leds: { PWR: pl.userData.lens, ACT: al.userData.lens }, pinTop: t + PIN_TOP.pi4b };
  }

  function board(b) { return b.id === 'uno' ? uno(b) : (b.family || b.id) === 'esp32' ? esp32(b) : pi4(b); }

  /* ======================= 元件 ======================= */
  function lathe(points, m, seg) { const THREE = T(); const o = new THREE.Mesh(new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), seg || 28), m); o.castShadow = true; return o; }
  function leg(THREE, pts, r, m) { const curve = new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(...p)), false, 'catmullrom', 0.05); const o = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, r, 6, false), m); o.castShadow = true; return o; }

  function component(c, ins) {
    const THREE = T(); const g = new THREE.Group(); const body = []; const ref = {}; const def = DL.components[c.type];
    if (c.type === 'BB') return breadboard(c);
    const H = (term, i) => ins && ins[term] && ins[term][i || 0];   // 插入時這支腳的孔位 [x, z]
    const add = (o, isBody) => { g.add(o); if (isBody !== false) body.push(o); return o; };
    if (c.type === 'LED') {
      const col = { red: '#c51f17', green: '#1f9a3e', yellow: '#e2ae12', blue: '#2259c9' }[c.params.color] || '#c51f17';
      const epoxy = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(col), roughness: 0.12, transparent: true, opacity: 0.94, clearcoat: 1, clearcoatRoughness: 0.1, emissive: new THREE.Color('#000') });
      ref.lens = add(lathe([[0, 0.38], [0.25, 0.38], [0.25, 0.74], [0.235, 0.82], [0.2, 0.89], [0.13, 0.94], [0, 0.96]], epoxy, 40));
      // 底部凸緣：陰極（短腳）那一側切平，實物就是這樣辨認方向
      const fl = new THREE.Shape(); fl.absarc(0, 0, 0.29, Math.acos(0.235 / 0.29), Math.PI * 2 - Math.acos(0.235 / 0.29), false); fl.closePath();
      const flg = new THREE.ExtrudeGeometry(fl, { depth: 0.06, bevelEnabled: false, curveSegments: 32 }); flg.rotateX(-Math.PI / 2);
      const flange = new THREE.Mesh(flg, epoxy); flange.position.y = 0.33; flange.castShadow = true; add(flange);
      // 內部的支架與反射杯（透過樹脂看得到）
      const inner = mat('ledinner', '#9aa1a8', { metalness: 0.7, roughness: 0.35 });
      g.add(box(0.035, 0.32, 0.035, inner, -0.1, 0.52, 0)); g.add(box(0.035, 0.26, 0.035, inner, 0.1, 0.49, 0)); g.add(box(0.12, 0.05, 0.05, inner, 0.06, 0.67, 0));
      ref.glowColor = new THREE.Color(col);
      const glow = new THREE.PointLight(new THREE.Color(col), 0, 5); glow.position.set(0, 1.1, 0); g.add(glow); ref.glow = glow;
      const legM = metal();
      if (ins) { for (const [t, x0] of [['A', -0.13], ['K', 0.13]]) { const h = H(t); g.add(leg(THREE, [[x0, 0.36, 0], [h[0], 0.18, h[1]], [h[0], 0.02, h[1]], [h[0], -0.32, h[1]]], 0.022, legM)); } }
      else {
      g.add(leg(THREE, [[-0.13, 0.36, 0], [-0.13, 0.15, 0.05], [-0.13, 0.08, 0.35], [-0.13, 0.06, 0.55]], 0.022, legM));
      g.add(leg(THREE, [[0.13, 0.36, 0], [0.13, 0.2, 0.05], [0.13, 0.08, 0.32], [0.13, 0.06, 0.55]], 0.022, legM));
      }
    } else if (c.type === 'RES') {
      const bm = mat('resbody', '#d8c193', { roughness: 0.55 });
      const r = add(lathe([[0, -0.32], [0.09, -0.32], [0.115, -0.27], [0.115, -0.17], [0.095, -0.12], [0.095, 0.12], [0.115, 0.17], [0.115, 0.27], [0.09, 0.32], [0, 0.32]], bm));
      r.rotation.z = Math.PI / 2; r.position.y = 0.2;
      DL.ui.resistorBands(c.params.ohms).forEach((bc, i) => { const bd = cyl(0.118, 0.045, mat('band' + bc, bc), -0.2 + i * 0.11 + (i === 3 ? 0.07 : 0), 0.2, 0, 24); bd.rotation.z = Math.PI / 2; add(bd); });
      if (ins) for (const [t, s] of [['1', -1], ['2', 1]]) { const h = H(t); g.add(leg(THREE, [[s * 0.3, 0.2, 0], [h[0] - s * 0.06, 0.2, h[1]], [h[0], 0.14, h[1]], [h[0], -0.32, h[1]]], 0.02, metal())); }
      else for (const s of [-1, 1]) g.add(leg(THREE, [[s * 0.3, 0.2, 0], [s * 0.45, 0.2, 0], [s * 0.55, 0.1, 0], [s * 0.6, 0.06, 0]], 0.02, metal()));
    } else if (c.type === 'BTN') {
      add(box(0.62, 0.34, 0.62, black(), 0, 0.17, 0));
      add(box(0.6, 0.02, 0.6, metal(), 0, 0.345, 0));
      for (const [x, z] of [[-0.24, -0.24], [0.24, -0.24], [-0.24, 0.24], [0.24, 0.24]]) add(cyl(0.03, 0.01, mat('dimple', '#9aa0a5'), x, 0.356, z, 10));
      ref.cap = add(cyl(0.17, 0.2, plastic('#2a2d31'), 0, 0.45, 0, 28));
      if (ins) { for (const t of def.terminals) for (const h of ins[t.id] || []) g.add(leg(THREE, [[h[0] * 0.92, 0.06, h[1] * 0.92], [h[0], 0.0, h[1]], [h[0], -0.32, h[1]]], 0.025, metal())); }
      else { for (const t of def.terminals) g.add(leg(THREE, [[t.x * 0.75, 0.05, 0.25], [t.x, 0.06, 0.4], [t.x, 0.06, t.z]], 0.025, metal())); for (const s of [-1, 1]) g.add(leg(THREE, [[s * 0.34, 0.05, -0.25], [s * 0.36, 0.03, -0.36], [s * 0.36, 0.0, -0.42]], 0.025, metal())); }   // 另外兩支腳只是固定用（與同側相通）
    } else if (c.type === 'LDR') {
      add(box(1.2, 0.08, 1.3, mat('ldrpcb', '#1e57a8', { roughness: 0.45 }), 0, 0.04, -0.05));
      const cv = document.createElement('canvas'); cv.width = cv.height = 128; const cg = cv.getContext('2d'); cg.fillStyle = '#e6b25a'; cg.beginPath(); cg.arc(64, 64, 62, 0, Math.PI * 2); cg.fill(); cg.strokeStyle = '#8a3c12'; cg.lineWidth = 7; cg.beginPath(); for (let i = 0; i < 7; i++) { const y = 26 + i * 12; cg.moveTo(i % 2 ? 28 : 100, y); cg.lineTo(i % 2 ? 100 : 28, y); cg.lineTo(i % 2 ? 100 : 28, y + 12); } cg.stroke();
      const disk = cyl(0.24, 0.12, [mat('ldrside', '#d9a24c'), new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(cv), roughness: 0.3 }), mat('ldrside', '#d9a24c')], -0.25, 0.2, -0.4, 24); ref.ldr = disk.material[1]; add(disk);
      const pot = add(box(0.38, 0.32, 0.38, plastic('#2f6fd6'), 0.3, 0.24, -0.35)); add(cyl(0.11, 0.04, mat('brass', '#c7a24a', { metalness: 0.8, roughness: 0.3 }), 0.3, 0.42, -0.35, 16));
      add(chip(0.4, 0.3, 0.12, 'soic', { n: 4 }).translateX(0.15).translateY(0.08).translateZ(0.15));
      g.add(smdLed('#ff3b30', -0.4, 0.15).translateY(0.08)); g.add(smdLed('#3ddc6b', -0.4, 0.35).translateY(0.08));
      if (ins) { ref.lift = 0.28; for (const t of def.terminals) { const h = H(t.id); g.add(box(0.064, 0.5, 0.064, gold(), h[0], -0.2, h[1])); g.add(box(0.25, 0.25, 0.25, black(), h[0], -0.13, h[1])); } }   // 排針朝下插入，模組浮在麵包板上方
      else { g.add(box(0.76, 0.25, 0.25, black(), 0, 0.2, 0.5)); for (const t of def.terminals) { g.add(box(0.064, 0.064, 0.42, gold(), t.x, 0.2, 0.6)); g.add(box(0.064, 0.2, 0.064, gold(), t.x, 0.06, 0.42)); } }   // 直角排針：針腳水平朝外
    } else if (c.type === 'US') {
      // HC-SR04：45 × 20 mm 藍色電路板直立，兩個 16 mm 探頭朝前（本地 −Z）；四支排針在下緣
      const pcbM = c.params.model === 'HC-SR04P' ? mat('uspcbP', '#1d6b4f', { roughness: 0.5 }) : mat('uspcb', '#1f5aa0', { roughness: 0.5 });   // 3.3 V 版用綠色電路板，方便分辨（材質依顏色分開快取）
      const PY = 0.3, PH = 2.0;   // 電路板下緣高度與板高
      add(box(4.5, PH, 0.16, pcbM, 0, PY + PH / 2, 0));
      const meshCv = document.createElement('canvas'); meshCv.width = meshCv.height = 128; const mg = meshCv.getContext('2d');
      mg.fillStyle = '#2b2f33'; mg.fillRect(0, 0, 128, 128); mg.fillStyle = '#596067'; for (let y = 4; y < 128; y += 8) for (let x = (y / 8) % 2 ? 8 : 4; x < 128; x += 8) { mg.beginPath(); mg.arc(x, y, 2.2, 0, Math.PI * 2); mg.fill(); }
      const meshM = new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(meshCv), roughness: 0.8 });
      const can = mat('uscan', '#c8ccd0', { metalness: 0.75, roughness: 0.35 });
      for (const sx of [-1.3, 1.3]) {
        const t = cyl(0.8, 1.2, [can, meshM, can], sx, PY + 1.05, -0.68, 36); t.rotation.x = -Math.PI / 2; add(t);   // 圓柱軸改成沿 Z；網面朝前
        const rim = cyl(0.82, 0.08, can, sx, PY + 1.05, -0.14, 36); rim.rotation.x = -Math.PI / 2; add(rim);
      }
      const front = labelPlane(c.params.model === 'HC-SR04P' ? 'HC-SR04P\nT       R' : 'HC-SR04\nT       R', 1.0, 0.7, 70); front.rotation.set(0, Math.PI, 0); front.position.set(0, PY + 1.55, -0.085); g.add(front);
      const back = labelPlane('Vcc Trig Echo Gnd', 1.5, 0.22, 46); back.rotation.set(0, 0, 0); back.position.set(0, PY + 0.2, 0.085); g.add(back);
      const xtal = cyl(0.2, 0.12, metal(), 0, PY + 1.55, 0.14, 20, 0.2); xtal.rotation.x = Math.PI / 2; xtal.scale.set(1.6, 1, 0.7); g.add(xtal);   // 背面的石英振盪器
      for (const [x, y] of [[-1.2, 1.0], [1.2, 1.0], [0, 0.95]]) { const ch = chip(0.55, 0.45, 0.1, 'soic', { n: 4 }); ch.rotation.x = Math.PI / 2; ch.position.set(x, PY + y, 0.08); g.add(ch); }
      const pins = def.terminals;
      if (ins) {   // 直排針朝下插進麵包板
        g.add(box(1.0, 0.25, 0.25, black(), 0, 0.12, 0));
        for (const t of pins) { const h = H(t.id); g.add(leg(THREE, [[t.x, PY + 0.05, 0], [t.x, 0.15, 0], [h[0], 0.0, h[1]], [h[0], -0.32, h[1]]], 0.03, gold())); }
      } else {     // 直角排針：從板子下緣往後（+Z）伸出
        g.add(box(1.0, 0.25, 0.25, black(), 0, 0.15, 0.12));
        for (const t of pins) { g.add(box(0.064, 0.3, 0.064, gold(), t.x, 0.2, 0)); g.add(box(0.064, 0.064, t.z, gold(), t.x, 0.07, t.z / 2)); }
      }
      // 前方的物體（模擬或量測到的距離）：橘色板＋聲波示意線；畫面最多畫到 18 cm 遠，標籤顯示實際數值
      const ob = new THREE.Group(); ob.visible = false;
      const obM = new THREE.MeshStandardMaterial({ color: new THREE.Color('#e8892a'), transparent: true, opacity: 0.55, roughness: 0.6 });
      const plate = box(3.4, 2.6, 0.12, obM, 0, PY + 1.05, 0); plate.raycast = () => { }; ob.add(plate);
      const beamM = new THREE.MeshBasicMaterial({ color: new THREE.Color('#e8892a'), transparent: true, opacity: 0.6 });
      const beams = []; for (let i = 0; i < 24; i++) { const b = box(0.05, 0.05, 0.35, beamM, 0, PY + 1.05, 0); b.raycast = () => { }; g.add(b); beams.push(b); }
      g.add(ob); ref.obstacle = { group: ob, plate, mat: obM, beams, front: -1.28 };
    } else if (c.type === 'SERVO') {
      const blue = new THREE.MeshPhysicalMaterial({ color: new THREE.Color('#2a63c4'), transparent: true, opacity: 0.88, roughness: 0.35, clearcoat: 0.6 });
      add(box(2.3, 2.25, 1.22, blue, 0, 1.125, 0));
      add(box(3.2, 0.25, 1.22, blue, 0, 1.65, 0));
      for (const s of [-1, 1]) add(cyl(0.1, 0.27, mat('hole2', '#0c1830'), s * 1.38, 1.65, 0, 12));
      add(cyl(0.58, 0.4, blue, 0.55, 2.45, 0, 28)); add(cyl(0.3, 0.3, blue, -0.2, 2.4, 0, 20));
      const horn = new THREE.Group(); horn.position.set(0.55, 2.78, 0);
      const hm = plastic('#f4f4f2');
      const arm = box(1.6, 0.13, 0.4, hm, 0.7, 0, 0); horn.add(arm); horn.add(cyl(0.3, 0.2, hm, 0, 0, 0, 24)); horn.add(cyl(0.2, 0.14, hm, 1.45, 0, 0, 20));
      for (let i = 0; i < 4; i++) horn.add(cyl(0.035, 0.15, mat('hornhole', '#888'), 0.35 + i * 0.33, 0.01, 0, 8));
      g.add(horn); body.push(arm); ref.horn = horn;
      // 三色排線＋母座
      const wires = [['#5a3a22', -0.08], ['#d23a2a', 0], ['#e8892a', 0.08]];
      for (const [col, dz] of wires) g.add(leg(THREE, [[-1.15, 0.3, dz], [-1.5, 0.15, dz], [-1.2, 0.06, 1.3 + dz], [dz * 3.2, 0.12, 2.25]], 0.035, mat('sw' + col, col, { roughness: 0.5 })));
      add(box(0.78, 0.26, 0.5, black(), 0, 0.13, 2.45));
    } else if (c.type === 'PSU') {
      add(box(2.4, 0.1, 1.5, mat('psupcb', '#2b6b3a'), 0, 0.05, 0));
      const jack = box(0.9, 0.9, 1.1, black(), -0.7, 0.55, -0.15); add(jack);
      add(chip(0.65, 0.35, 0.16, 'sot223').translateX(0.4).translateY(0.1).translateZ(-0.35));
      g.add(electrolytic(0.25, 0.5, 0.75, -0.3).translateY(0.1));
      const tb = box(1.3, 0.8, 0.75, plastic('#1f9a4f'), 0, 0.5, 0.55); add(tb);
      for (const s of [-1, 1]) add(cyl(0.16, 0.06, metal(), s * 0.4, 0.93, 0.55, 18));
      g.add(smdLed('#ff3b30', 0.95, 0.3).translateY(0.1));
      const lab = labelPlane('+5V   GND', 1.2, 0.3, 60); lab.position.set(0, 0.11, 0.05); g.add(lab);
    } else {
      add(box(0.8, 0.4, 0.8, mat('unk', '#888'), 0, 0.2, 0));
    }
    for (const b of body) b.userData = { kind: 'comp', comp: c.id };
    return { group: g, body, ref };
  }

  /* ======================= 麵包板 ======================= */
  let bbTex = null;
  function breadboardTexture() {
    if (bbTex) return bbTex;
    const THREE = T(); const BBm = DL.breadboard; const S = BBm.SIZE; const k = 250;   // 每公分 250 px
    const cv = document.createElement('canvas'); cv.width = Math.round(S.w * k); cv.height = Math.round(S.d * k); const g = cv.getContext('2d');
    const X = x => (x + S.w / 2) * k, Z = z => (z + S.d / 2) * k;
    g.fillStyle = '#f4f2ec'; g.fillRect(0, 0, cv.width, cv.height);
    // 中間溝槽
    const gr = g.createLinearGradient(0, Z(-0.12), 0, Z(0.12)); gr.addColorStop(0, '#d9d6cc'); gr.addColorStop(0.5, '#bdb9ae'); gr.addColorStop(1, '#d9d6cc');
    g.fillStyle = gr; g.fillRect(0, Z(-0.11), cv.width, 0.22 * k);
    // 電源排的紅藍線與 + − 標示
    const P = BBm.PITCH;
    for (const [rid, r] of Object.entries(BBm.RAILS)) {
      const z = r.z * P; const outer = Math.abs(r.z) === 9; const lineZ = z + (z < 0 ? (outer ? -0.5 : 0.5) : (outer ? 0.5 : -0.5)) * P * 1.3;
      g.strokeStyle = r.sign === '+' ? '#d63a32' : '#2b5fc4'; g.lineWidth = 0.05 * k; g.beginPath(); g.moveTo(X(-3.6), Z(lineZ)); g.lineTo(X(3.6), Z(lineZ)); g.stroke();
      g.fillStyle = g.strokeStyle; g.font = `bold ${0.22 * k}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(r.sign === '+' ? '+' : '−', X(-3.88), Z(z)); g.fillText(r.sign === '+' ? '+' : '−', X(3.88), Z(z));
    }
    // 孔
    // 電源排與主要區之間的分隔細線
    g.strokeStyle = 'rgba(120,115,105,0.6)'; g.lineWidth = 6; for (const z of [-7 * P, 7 * P]) { g.beginPath(); g.moveTo(X(-S.w / 2 + 0.15), Z(z)); g.lineTo(X(S.w / 2 - 0.15), Z(z)); g.stroke(); }
    // 孔：方形開口＋內側陰影（實物的金屬夾在孔內看不到）
    for (const h of BBm.HOLES) { const s = 0.072 * k; g.fillStyle = '#b9b5aa'; g.fillRect(X(h.x) - s / 2 - 3, Z(h.z) - s / 2 - 3, s + 6, s + 6); g.fillStyle = '#25231f'; g.fillRect(X(h.x) - s / 2, Z(h.z) - s / 2, s, s); g.fillStyle = '#4a4740'; g.fillRect(X(h.x) - s / 2, Z(h.z) - s / 2, s, 4); }
    // 列字母與號碼
    g.fillStyle = '#6a6862'; g.font = `${0.12 * k}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const r of BBm.ROWS) { const z = BBm.BY_ID[r + '1'].z; g.fillText(r, X(-15.5 * P - 0.25), Z(z)); g.fillText(r, X(14.5 * P + 0.25), Z(z)); }
    for (let c = 1; c <= BBm.COLS; c++) if (c === 1 || c % 5 === 0) { const x = BBm.BY_ID['a' + c].x; g.fillText(String(c), X(x), Z(BBm.BY_ID['a' + c].z - 0.24)); g.fillText(String(c), X(x), Z(BBm.BY_ID['j' + c].z + 0.24)); }
    bbTex = new THREE.CanvasTexture(cv); bbTex.anisotropy = 8; bbTex.encoding = THREE.sRGBEncoding;
    return bbTex;
  }
  function breadboard(c) {
    const THREE = T(); const g = new THREE.Group(); const S = DL.breadboard.SIZE; const body = [];
    const side = mat('bbside', '#e9e6dd', { roughness: 0.7 });
    const top = new THREE.MeshStandardMaterial({ map: breadboardTexture(), roughness: 0.68 });
    const m = new THREE.Mesh(new THREE.BoxGeometry(S.w, S.t, S.d), [side, side, top, side, side, side]); m.position.y = S.t / 2; m.castShadow = true; m.receiveShadow = true;
    m.userData = { kind: 'comp', comp: c.id, bbBody: true }; g.add(m); body.push(m);
    // 側邊的卡榫凸點（可拼接的那種）
    for (const s of [-1, 1]) for (const z of [-1.4, 0, 1.4]) { const n = box(0.12, S.t * 0.6, 0.35, side, s * (S.w / 2 + 0.06), S.t * 0.4, z); g.add(n); }
    for (const b of body) b.userData = { kind: 'comp', comp: c.id, bbBody: true };
    return { group: g, body, ref: { bb: true } };
  }

  DL.models = { board, component, breadboard, PIN_TOP, labelPlane };
})(typeof globalThis !== 'undefined' ? globalThis : this);
