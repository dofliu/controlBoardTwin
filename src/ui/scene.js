/* DofLab — 3D 場景（Three.js）
 * 場景只負責「看見與操作」：位置、模型、選取、視角。它不決定電氣導通，所有變更都交回 app 寫進專案資料。
 * 座標：1 單位 = 1 公分；Y 向上；俯視時 X 向右、Z 向下。
 */
(function (root) {
  const DL = root.DL;
  const T = () => root.THREE;

  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'; }

  class Scene {
    constructor(app) {
      this.app = app;
      this.ok = false;
      this.objects = { board: null, comps: {}, wires: {} };
      this.pick = [];            // 可點選的網格
      this.pointers = new Map();
      this.vis = {};             // 每個元件的視覺狀態（由 app 每幀提供）
      this.showPinLabels = true; this.highlightUsed = false;
      this.cam = { target: null, r: 26, theta: 0.55, phi: 0.95 };
      try { this.init(); this.ok = true; } catch (e) { this.err = e; }
    }

    init() {
      const THREE = T(); if (!THREE) throw new Error('Three.js 未載入');
      const renderer = this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: false });
      renderer.setPixelRatio(Math.min(2, root.devicePixelRatio || 1));
      renderer.outputEncoding = THREE.sRGBEncoding;
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 400);
      this.cam.target = new THREE.Vector3(3, 0, 0.5);
      renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
      const hemi = new THREE.HemisphereLight(0xffffff, 0x6f7f8f, 0.55); this.scene.add(hemi);
      const dir = new THREE.DirectionalLight(0xffffff, 0.9); dir.position.set(-10, 22, 12); dir.castShadow = true;
      dir.shadow.mapSize.set(2048, 2048); Object.assign(dir.shadow.camera, { left: -22, right: 22, top: 22, bottom: -22, near: 1, far: 70 }); dir.shadow.bias = -0.0004; dir.shadow.radius = 3;
      this.scene.add(dir); this.scene.add(dir.target); this.sun = dir;
      const fill = new THREE.DirectionalLight(0xdfe8ff, 0.25); fill.position.set(12, 10, -8); this.scene.add(fill);
      this.groundMat = new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 1 });
      const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), this.groundMat);
      ground.rotation.x = -Math.PI / 2; ground.position.y = -0.002; ground.userData = { kind: 'ground' }; ground.receiveShadow = true;
      this.scene.add(ground); this.ground = ground;
      this.root = new THREE.Group(); this.scene.add(this.root);
      this.rubber = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineDashedMaterial({ color: 0xb4581c, dashSize: 0.25, gapSize: 0.15 }));
      this.rubber.visible = false; this.scene.add(this.rubber);
      this.ray = new THREE.Raycaster();
      this.plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

      const el = this.el = document.createElement('div');
      el.style.cssText = 'position:absolute;inset:0';
      el.appendChild(renderer.domElement);
      this.labels = document.createElement('div'); this.labels.className = 'labels'; el.appendChild(this.labels);
      this.tip = document.createElement('div'); this.tip.className = 'tip'; this.tip.hidden = true; el.appendChild(this.tip);
      this.bindPointer(renderer.domElement);
      this.applyTheme();
      const mq = root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)');
      mq && mq.addEventListener && mq.addEventListener('change', () => this.applyTheme());
      new MutationObserver(() => this.applyTheme()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      this.ro = new ResizeObserver(() => this.resize());
      this.setView('iso', true);
    }

    applyTheme() {
      const THREE = T();
      this.scene.background = new THREE.Color(css('--scene-bg'));
      this.groundMat.color = new THREE.Color(css('--scene-bg'));
      if (this.grid) { this.scene.remove(this.grid); this.grid.geometry.dispose(); }
      this.grid = new THREE.GridHelper(60, 60, new THREE.Color(css('--scene-grid')), new THREE.Color(css('--scene-grid2')));
      this.grid.position.y = 0.001; this.scene.add(this.grid);
      this.dirty = true;
    }

    mount(container) {
      if (!this.ok) {
        if (!container.querySelector('.nogl')) { const d = document.createElement('div'); d.className = 'nogl'; d.textContent = '這個瀏覽器無法建立 WebGL 3D 畫面（' + (this.err && this.err.message) + '）。配置資料仍可從右側清單檢視。'; container.appendChild(d); }
        return;
      }
      if (this.el.parentNode !== container) { container.insertBefore(this.el, container.firstChild); this.ro.disconnect(); this.ro.observe(container); }
      this.container = container; this.resize();
    }
    // 版面變動（例如出現捲軸）後，ResizeObserver 是非同步的；點選前先同步尺寸，避免座標錯位
    syncSize() { if (this.container && (this.container.clientWidth !== this._w || this.container.clientHeight !== this._h)) this.resize(); }
    resize() {
      if (!this.container) return;
      const w = this.container.clientWidth, h = this.container.clientHeight;
      if (!w || !h) return;
      this._w = w; this._h = h;
      this.renderer.setSize(w, h, false);
      this.renderer.domElement.style.width = '100%'; this.renderer.domElement.style.height = '100%';
      const was = this.camera.aspect; this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.dirty = true;
      if (this.project && !this.userMoved && Math.abs(was - this.camera.aspect) > 0.2) this.setView(this.view || 'iso');
    }

    /* ------------------------- 視角 ------------------------- */
    setView(name, instant) {
      const v = { iso: [0.55, 0.95, 26], top: [0, 0.0001, 24], front: [0, 1.38, 24], side: [Math.PI / 2, 1.3, 24] }[name] || [0.55, 0.95, 26];
      this.cam.theta = v[0]; this.cam.phi = v[1]; this.cam.r = v[2];
      if (this.project) { const c = this.bounds(); this.cam.target.set(c.x, 0, c.z); const asp = this.camera.aspect || 1.4; this.cam.r = Math.max(11, c.size * 1.32 * Math.max(1, 1.45 / asp)); }
      this.view = name; this.dirty = true;
    }
    bounds() {
      const p = this.project; const xs = [p.board.pos.x - 4.5, p.board.pos.x + 4.5], zs = [p.board.pos.z - 3, p.board.pos.z + 3];
      for (const c of p.components) { const big = c.type === 'BB' ? [4.3, 2.9] : [1, 1]; xs.push(c.pos.x - big[0], c.pos.x + big[0]); zs.push(c.pos.z - big[1], c.pos.z + Math.max(1.5, big[1])); }
      const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
      return { x: (x0 + x1) / 2, z: (z0 + z1) / 2, size: Math.max(x1 - x0, (z1 - z0) * 1.4) };
    }
    updateCamera() {
      const c = this.cam; const s = Math.sin(c.phi);
      this.camera.position.set(c.target.x + c.r * s * Math.sin(c.theta), c.target.y + c.r * Math.cos(c.phi), c.target.z + c.r * s * Math.cos(c.theta));
      if (c.phi < 0.001) this.camera.up.set(0, 0, -1); else this.camera.up.set(0, 1, 0);
      this.camera.lookAt(c.target);
    }

    /* ------------------------- 建模 ------------------------- */
    clear() {
      const disp = o => o.traverse(n => { if (n.geometry) n.geometry.dispose(); if (n.material) (Array.isArray(n.material) ? n.material : [n.material]).forEach(m => { if (m.map) m.map.dispose(); m.dispose(); }); });
      while (this.root.children.length) { const c = this.root.children[0]; this.root.remove(c); disp(c); }
      this.objects = { board: null, comps: {}, wires: {} }; this.pick = []; this.labels.innerHTML = ''; this.labelEls = {}; this.busHl = null; this._busKey = null;
    }
    build(p, analysis) {
      if (!this.ok) return;
      const first = !this.project || this.project.id !== p.id || this.project.board.type !== p.board.type;
      this.project = p; this.analysis = analysis;
      this.clear();
      this.buildBoard(p);
      for (const c of p.components) this.buildComp(c);
      this.routes = ((p.view && p.view.wireStyle) || 'neat') === 'neat' && p.connections.length ? DL.routing.route(p) : null;
      for (const w of p.connections) if (w.kind !== 'insert') this.buildWire(w);   // 插在麵包板上的腳由元件模型畫出
      if (first) this.setView(this.view || 'iso');
      if (this._sugStep) { const s = this._sugStep; this._sugKey = null; this.setSuggest(s); }   // 重建後重畫建議線
      this.scene.updateMatrixWorld(true);
      this.dirty = true;
    }
    mat(color, extra) { const THREE = T(); return new THREE.MeshStandardMaterial(Object.assign({ color: new THREE.Color(color), roughness: 0.65, metalness: 0.05 }, extra || {})); }
    box(w, h, d, color, x, y, z, extra) { const THREE = T(); const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.mat(color, extra)); m.position.set(x || 0, y || 0, z || 0); return m; }
    cyl(r, h, color, x, y, z, seg) { const THREE = T(); const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg || 20), this.mat(color)); m.position.set(x || 0, y || 0, z || 0); return m; }

    buildBoard(p) {
      const THREE = T(); const b = DL.boards[p.board.type]; const g = new THREE.Group();
      const { w, h, t } = b.size;
      const model = DL.models.board(b);
      g.add(model.group); this.boardModel = model; this.pinTop = model.pinTop;
      // 板子本體可點選（拖曳移動）：用一個不可見的外框
      const hitBody = new THREE.Mesh(new THREE.BoxGeometry(w, Math.max(0.3, t), h), new THREE.MeshBasicMaterial({ visible: false }));
      hitBody.position.y = t / 2; hitBody.userData = { kind: 'board' }; g.add(hitBody); this.pick.push(hitBody);
      model.group.traverse(o => { if (o.isMesh && !o.userData.kind) { o.userData = { kind: 'board' }; } });
      // 腳位標記：平常隱藏，滑過、接線中或「高亮已用腳位」時發亮；外加放大的透明點選範圍
      this.pinMeshes = {};
      for (const [id, pos] of Object.entries(b.layout)) {
        const pin = b.pinById[id];
        const m = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.04, 0.15), new THREE.MeshBasicMaterial({ color: pin.kind === 'gnd' ? 0x9aa0a6 : pin.kind === 'power' ? 0xff5040 : 0xffb030, transparent: true, opacity: 0.95 }));
        m.position.set(pos.x, this.pinTop + 0.03, pos.z); m.visible = false; m.raycast = () => { };
        const hit = new THREE.Mesh(new THREE.BoxGeometry(0.24, this.pinTop - t + 0.25, 0.24), new THREE.MeshBasicMaterial({ visible: false }));
        hit.position.set(pos.x, (this.pinTop + t) / 2 + 0.1, pos.z); hit.userData = { kind: 'ep', ep: { comp: 'board', term: id }, pin };
        g.add(m); g.add(hit); this.pick.push(hit); this.pinMeshes[id] = m;
      }
      this.applyBoardTransform(g, p.board);
      g.userData = { kind: 'boardGroup' };
      g.traverse(o => { if (o.isMesh) { o.castShadow = o.castShadow !== false; } });
      this.root.add(g); this.objects.board = g;
      this.label('board', `${b.short}`);
    }
    applyBoardTransform(g, bd) { g.position.set(bd.pos.x, 0, bd.pos.z); g.rotation.y = -bd.rot * Math.PI / 180; }

    buildComp(c) {
      const THREE = T(); const def = DL.components[c.type]; const BBm = DL.breadboard;
      // 插在麵包板上：算出每支腳的孔在元件本地座標的位置，模型的腳直接插進孔裡
      const mount = c.type !== 'BB' && BBm.mountOf(this.project, c.id); let ins = null;
      if (mount) { const bb = DL.project.findComp(this.project, mount.bb); ins = {}; for (const h of mount.holes) { const w = BBm.holeWorld(bb, h.hole); const [lx, lz] = DL.rotXZ(w.x - c.pos.x, w.z - c.pos.z, 360 - (c.rot || 0)); (ins[h.term] = ins[h.term] || []).push([lx, lz]); } }
      const model = DL.models.component(c, ins); const g = model.group; const body = model.body; const ref = model.ref;
      for (const b of body) this.pick.push(b);
      // 端子：小色點＋加大點選範圍（麵包板的孔另外處理；插在麵包板上的元件請接到同一條導通條的其他孔）
      for (const t of def && c.type !== 'BB' && !mount ? def.terminals : []) {
        const color = { anode: '#d8332a', cathode: '#333', gnd: '#333', vcc: '#d8332a', pwm_in: '#e07a1f', analog_out: '#2f8f8a', psu_pos: '#d8332a', psu_gnd: '#333', trig_in: '#e07a1f', echo_out: '#2f8f8a' }[t.role] || '#c9a64b';
        const s = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), this.mat(color, { metalness: 0.4 })); s.position.set(t.x, 0.07, t.z);
        const hit = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 6), new THREE.MeshBasicMaterial({ visible: false })); hit.position.copy(s.position);
        s.userData = hit.userData = { kind: 'ep', ep: { comp: c.id, term: t.id }, term: t };
        g.add(s); g.add(hit); this.pick.push(hit);
      }
      g.position.set(c.pos.x, mount ? BBm.TOP + (ref.lift || 0) : 0, c.pos.z); g.rotation.y = -(c.rot || 0) * Math.PI / 180;
      g.userData = { kind: 'compGroup', comp: c.id, ref, body, mounted: !!mount };
      this.root.add(g); this.objects.comps[c.id] = g;
      this.label(c.id, c.id);
    }

    epWorld(ep) {
      const THREE = T(); const p = this.project;
      if (ep.comp === 'board') {
        const b = DL.boards[p.board.type]; const pos = b.layout[ep.term]; if (!pos) return null;
        const [x, z] = DL.rotXZ(pos.x, pos.z, p.board.rot);
        return new THREE.Vector3(p.board.pos.x + x, this.pinTop || b.size.t + 0.85, p.board.pos.z + z);
      }
      const c = DL.project.findComp(p, ep.comp); if (!c) return null;
      const g = this.objects.comps[c.id];
      const w = DL.terminalWorld(g && g.userData.livePos ? Object.assign({}, c, { pos: g.userData.livePos }) : c, ep.term); if (!w) return null;
      return new THREE.Vector3(w.x, c.type === 'BB' ? DL.breadboard.TOP : 0.08, w.z);
    }
    // 弧線樣式（拖曳中或使用者選擇弧線）
    wirePath(a, b) {
      const THREE = T(); const d = a.distanceTo(b); const h = Math.min(3.2, 0.6 + d * 0.22);
      const up = 0.35 + Math.min(0.8, d * 0.06);
      const pts = [a.clone(), a.clone().add(new THREE.Vector3(0, up, 0)), new THREE.Vector3((a.x + b.x) / 2, Math.max(a.y, b.y) + h, (a.z + b.z) / 2), b.clone().add(new THREE.Vector3(0, up, 0)), b.clone()];
      return new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    }
    // 整齊樣式：依自動整線結果，平貼桌面、正交轉彎（圓角），每條線一個高度層避免交叉處穿模
    neatPath(w, route) {
      const THREE = T(); const a = this.epWorld(w.a), b = this.epWorld(w.b); if (!a || !b || !route) return null;
      const pts2 = route.pts; const y = 0.07 + route.layer * 0.075; const n = pts2.length;
      const first = pts2[0], startIsA = Math.abs(first.x - a.x) < 0.02 && Math.abs(first.z - a.z) < 0.02;
      const A = startIsA ? a : b, Bp = startIsA ? b : a;
      const hiA = A.y > 0.3 ? A.y + 0.35 : null, hiB = Bp.y > 0.3 ? Bp.y + 0.35 : null;
      const P = [A.clone()];
      if (hiA) P.push(new THREE.Vector3(A.x, hiA, A.z));                 // 從排針往上離開
      for (let i = 1; i < n - 1; i++) {
        const q = pts2[i];
        const yy = (i === 1 && hiA) ? hiA : (i === n - 2 && hiB) ? hiB : y;  // 板上段落維持在排針上方，離開板緣後降到桌面
        P.push(new THREE.Vector3(q.x, yy, q.z));
      }
      if (hiB) P.push(new THREE.Vector3(Bp.x, hiB, Bp.z));
      P.push(Bp.clone());
      // 轉角加圓角
      const path = new THREE.CurvePath(); let prev = P[0];
      for (let i = 1; i < P.length; i++) {
        const cur = P[i];
        if (i < P.length - 1) {
          const nxt = P[i + 1]; const d1 = cur.distanceTo(prev), d2 = nxt.distanceTo(cur); const r = Math.min(0.22, d1 / 2, d2 / 2);
          if (r > 0.01) {
            const p1 = cur.clone().add(prev.clone().sub(cur).setLength(r)), p2 = cur.clone().add(nxt.clone().sub(cur).setLength(r));
            if (p1.distanceTo(prev) > 1e-4) path.add(new THREE.LineCurve3(prev, p1));
            path.add(new THREE.QuadraticBezierCurve3(p1, cur, p2)); prev = p2; continue;
          }
        }
        if (cur.distanceTo(prev) > 1e-4) path.add(new THREE.LineCurve3(prev, cur)); prev = cur;
      }
      return path;
    }
    // 麵包板上兩孔之間的跳線：貼著板面、正交轉折（像預先折好的跳線）
    jumperPath(a, b) {
      const THREE = T(); const y = a.y + 0.12; const P = [a.clone(), new THREE.Vector3(a.x, y, a.z)];
      if (Math.abs(a.x - b.x) > 1e-3 && Math.abs(a.z - b.z) > 1e-3) P.push(new THREE.Vector3(b.x, y, a.z));
      P.push(new THREE.Vector3(b.x, y, b.z), b.clone());
      const path = new THREE.CurvePath(); let prev = P[0];
      for (let i = 1; i < P.length; i++) {
        const cur = P[i];
        if (i < P.length - 1) { const nxt = P[i + 1]; const r = Math.min(0.08, cur.distanceTo(prev) / 2, nxt.distanceTo(cur) / 2); const p1 = cur.clone().add(prev.clone().sub(cur).setLength(r)), p2 = cur.clone().add(nxt.clone().sub(cur).setLength(r)); if (p1.distanceTo(prev) > 1e-4) path.add(new THREE.LineCurve3(prev, p1)); path.add(new THREE.QuadraticBezierCurve3(p1, cur, p2)); prev = p2; continue; }
        path.add(new THREE.LineCurve3(prev, cur)); prev = cur;
      }
      return path;
    }
    wireGeometry(w) {
      const THREE = T(); const a = this.epWorld(w.a), b = this.epWorld(w.b); if (!a || !b) return null;
      if (w.a.comp === w.b.comp && DL.project.isBB(this.project, w.a.comp)) return new THREE.TubeGeometry(this.jumperPath(a, b), 64, 0.045, 8, false);
      const style = (this.project.view && this.project.view.wireStyle) || 'neat';
      const r = style === 'neat' && this.routes && this.routes.wires[w.id] ? this.neatPath(w, this.routes.wires[w.id]) : null;
      const curve = r || this.wirePath(a, b);
      const len = curve.getLength ? curve.getLength() : 10;
      return new THREE.TubeGeometry(curve, Math.min(400, Math.max(48, Math.round(len * 14))), 0.06, 8, false);
    }
    buildWire(w) {
      const geo = this.wireGeometry(w); if (!geo) return;
      const THREE = T(); const m = new THREE.Mesh(geo, this.mat(w.color, { roughness: 0.45 })); m.castShadow = true;
      m.userData = { kind: 'wire', id: w.id }; this.root.add(m); this.pick.push(m); this.objects.wires[w.id] = m;
      // 端頭：杜邦接頭（黑色方塊）
      const jumper = w.a.comp === w.b.comp;
      for (const e of [w.a, w.b]) { const p = this.epWorld(e); const bb = DL.project.isBB(this.project, e.comp); const [hh, hw] = e.comp === 'board' ? [0.55, 0.25] : bb ? (jumper ? [0, 0] : [0.32, 0.16]) : [0.2, 0.25]; if (!hh) continue; const hd = this.box(hw, hh, hw, '#202225', p.x, p.y + hh / 2 + (bb ? 0.02 : 0.05), p.z); hd.raycast = () => { }; hd.castShadow = true; m.add(hd); }
    }
    refreshWiresFor(compId) {
      // 拖曳中：受影響的導線暫時改用弧線，放開後再整線
      for (const w of this.project.connections) if (w.a.comp === compId || w.b.comp === compId) {
        const m = this.objects.wires[w.id]; if (!m) continue;
        const a = this.epWorld(w.a), b = this.epWorld(w.b); if (!a || !b) continue;
        const THREE = T(); m.geometry.dispose(); m.geometry = new THREE.TubeGeometry(this.wirePath(a, b), 48, 0.048, 7, false);
        m.children.forEach((hd, i) => { const e = i === 0 ? w.a : w.b; const p = this.epWorld(e); hd.position.set(p.x, p.y + hd.geometry.parameters.height / 2 + 0.03, p.z); });
      }
    }

    label(id, text) {
      const d = document.createElement('div'); d.className = 'lbl'; d.innerHTML = `<span>${text}</span><span class="tag" hidden></span>`;
      this.labels.appendChild(d); this.labelEls[id] = d;
    }

    /* ------------------------- 每幀 ------------------------- */
    setVis(vis) { this.vis = vis || {}; this.dirty = true; }
    frame() {
      if (!this.ok || !this.container || !this.container.offsetParent) return;
      const THREE = T();
      this.updateCamera();
      const sel = this.app.ui.selected;
      for (const [id, g] of Object.entries(this.objects.comps)) {
        const v = this.vis[id] || {}; const ref = g.userData.ref;
        if (ref.lens) { const on = v.on; const e = on === null || on === undefined ? 0 : on ? 1 : 0; ref.lens.material.emissive = e ? ref.glowColor : new THREE.Color(0x000000); ref.lens.material.emissiveIntensity = v.dim ? 0.6 : 1.4; ref.lens.material.opacity = v.unknown ? 0.45 : 0.82; ref.glow.intensity = e ? (v.dim ? 0.8 : 2.0) : 0; }
        if (ref.cap) ref.cap.position.y = v.pressed ? 0.39 : 0.45;
        if (ref.horn) ref.horn.rotation.y = ((v.angle === null || v.angle === undefined ? 90 : v.angle) - 90) * Math.PI / 180;
        if (ref.ldr) { const l = v.light === undefined ? 50 : v.light; ref.ldr.emissive = new THREE.Color(0xffc060); ref.ldr.emissiveIntensity = l / 160; }
        if (ref.obstacle) {   // 超音波前方的物體：沒有數值或沒有回波時不畫
          const o = ref.obstacle; const d = v.dist; const show = d !== null && d !== undefined && d < 400;
          // 畫面上的距離經過壓縮（示意）：2 cm → 1.5、15 cm → 4.6、100 cm → 8.5、200 cm → 10；實際數值看標籤
          o.group.visible = show; const shown = show ? 1.5 * Math.log2(1 + Math.max(0, d) / 2) : 0; const z = o.front - shown;
          if (show) { o.group.position.z = z; o.mat.opacity = d <= 60 ? 0.6 : 0.3; }
          o.beams.forEach((b, i) => { const zz = o.front - 0.3 - i * 0.75; b.visible = show && zz > z + 0.2; b.position.z = zz; });
        }
        const isSel = sel && sel.kind === 'comp' && sel.id === id;
        if (g.userData.wasSel !== !!isSel) { g.userData.wasSel = !!isSel; this.outline(g, isSel); }
      }
      for (const [id, m] of Object.entries(this.objects.wires)) { const isSel = sel && sel.kind === 'wire' && sel.id === id; m.material.emissive = new THREE.Color(isSel ? 0xffffff : 0x000000); m.material.emissiveIntensity = isSel ? 0.45 : 0; }
      if (this.pinMeshes) {
        const used = this.analysis ? this.analysis.pinUse : {};
        const wired = new Set(this.project.connections.flatMap(w => [w.a, w.b]).filter(e => e.comp === 'board').map(e => e.term));
        for (const [id, m] of Object.entries(this.pinMeshes)) {
          const hl = (this.highlightUsed && (used[id] || wired.has(id))) || (this.hoverEp && this.hoverEp.comp === 'board' && this.hoverEp.term === id) || (this.app.ui.wiringFrom && this.app.ui.wiringFrom.comp === 'board' && this.app.ui.wiringFrom.term === id);
          m.visible = !!hl;
        }
      }
      // 板上 LED：電源燈常亮；Uno 的 L 燈跟著 D13
      if (this.boardModel) for (const [k, lens] of Object.entries(this.boardModel.leds || {})) { const on = k === 'ON' || k === 'PWR' || (k === 'L' && this.vis.__board && this.vis.__board.L); lens.material.emissive = on ? lens.material.color : new THREE.Color(0); lens.material.emissiveIntensity = on ? 1.6 : 0; }
      this.renderer.render(this.scene, this.camera);
      this.placeLabels();
    }
    // 選取外框：用半透明的放大外殼標示，不改動材質（材質在元件間共用）
    outline(g, on) {
      const THREE = T();
      if (g.userData.hl) { g.remove(g.userData.hl); g.userData.hl.geometry.dispose(); g.userData.hl = null; }
      if (!on) return;
      const bb = new THREE.Box3(); for (const b of g.userData.body) { b.updateMatrixWorld(); bb.expandByObject(b); }
      const inv = new THREE.Matrix4().copy(g.matrixWorld).invert(); const size = new THREE.Vector3(), ctr = new THREE.Vector3(); bb.getSize(size); bb.getCenter(ctr); ctr.applyMatrix4(inv);
      const rot = Math.abs(Math.round(g.rotation.y / (Math.PI / 2))) % 2 === 1; const sx = rot ? size.z : size.x, sz = rot ? size.x : size.z;
      const m = new THREE.Mesh(new THREE.BoxGeometry(sx + 0.15, size.y + 0.1, sz + 0.15), new THREE.MeshBasicMaterial({ color: 0xb4581c, transparent: true, opacity: 0.18, depthWrite: false }));
      m.position.copy(ctr); m.raycast = () => { }; g.add(m); g.userData.hl = m;
    }
    placeLabels() {
      const THREE = T(); const w = this.container.clientWidth, h = this.container.clientHeight; const sel = this.app.ui.selected;
      const put = (id, world) => {
        const el = this.labelEls[id]; if (!el) return;
        const v = world.clone().project(this.camera);
        const vis = v.z < 1 && v.x > -1.1 && v.x < 1.1 && v.y > -1.1 && v.y < 1.1;
        el.style.display = vis ? '' : 'none';
        if (vis) { el.style.left = ((v.x + 1) / 2 * w) + 'px'; el.style.top = ((1 - v.y) / 2 * h) + 'px'; }
        el.classList.toggle('sel', !!(sel && sel.kind === 'comp' && sel.id === id));
        const tagEl = el.querySelector('.tag'); const t = (this.vis[id] || {}).tag;
        if (t) { tagEl.hidden = false; tagEl.className = 'tag ' + t.cls; tagEl.textContent = t.text; } else tagEl.hidden = true;
      };
      const bd = this.project.board; const b = DL.boards[bd.type];
      put('board', new THREE.Vector3(bd.pos.x, b.size.t + 0.2, bd.pos.z + b.size.h / 2 + 0.6));
      for (const c of this.project.components) { const g = this.objects.comps[c.id]; if (g) put(c.id, c.type === 'BB' ? new THREE.Vector3(g.position.x - DL.breadboard.SIZE.w / 2 + 0.6, DL.breadboard.TOP + 0.1, g.position.z - DL.breadboard.SIZE.d / 2 - 0.35) : new THREE.Vector3(g.position.x, g.position.y + (c.type === 'SERVO' ? 1.9 : 1.25), g.position.z)); }
    }

    /* ------------------------- 點選與拖曳 ------------------------- */
    ndc(e) { this.syncSize(); this.updateCamera(); this.camera.updateMatrixWorld(); const r = this.renderer.domElement.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1 }; }
    hit(e) {
      const n = this.ndc(e); this.scene.updateMatrixWorld(true); this.ray.setFromCamera(n, this.camera);   // 新建的網格要先更新矩陣，否則下一幀前點不到
      const hits = this.ray.intersectObjects(this.pick, false);
      // 端點優先於元件本體與導線
      const ep = hits.find(h => h.object.userData.kind === 'ep');
      if (ep) return ep;
      const h0 = hits[0] || null;
      // 麵包板表面：靠近孔就當成那個孔（端點），孔與孔之間才是板子本體（可拖曳）
      if (h0 && h0.object.userData.bbBody && h0.point.y > DL.breadboard.TOP - 0.03) {
        const c = DL.project.findComp(this.project, h0.object.userData.comp);
        if (c) { const [lx, lz] = DL.breadboard.toLocal(c, h0.point.x, h0.point.z); const hole = DL.breadboard.holeAt(lx, lz, 0.105); if (hole) return { object: { userData: { kind: 'ep', ep: { comp: c.id, term: hole.id } } }, point: h0.point }; }
      }
      return h0;
    }
    // 指標落在哪裡：在麵包板上方時取麵包板表面（避免視差讓元件插錯排），否則取桌面
    planePoint(e, ignore) {
      const n = this.ndc(e); this.ray.setFromCamera(n, this.camera);
      const bbs = this.pick.filter(o => o.userData.bbBody && o.userData.comp !== ignore);
      if (bbs.length) { this.scene.updateMatrixWorld(true); const h = this.ray.intersectObjects(bbs, false)[0]; if (h && h.point.y > DL.breadboard.TOP - 0.05) return h.point.clone(); }
      const v = new (T().Vector3)(); return this.ray.ray.intersectPlane(this.plane, v) ? v : null;
    }
    clientToPlane(x, y) { return this.planePoint({ clientX: x, clientY: y }); }
    inside(x, y) { if (!this.container) return false; const r = this.container.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }

    bindPointer(cv) {
      cv.addEventListener('contextmenu', e => e.preventDefault());
      cv.addEventListener('wheel', e => { e.preventDefault(); this.cam.r = Math.max(4, Math.min(90, this.cam.r * Math.exp(e.deltaY * 0.0012))); this.dirty = true; }, { passive: false });
      cv.addEventListener('pointerdown', e => this.down(e));
      cv.addEventListener('pointermove', e => this.move(e));
      cv.addEventListener('pointerup', e => this.up(e));
      cv.addEventListener('pointercancel', e => this.cancelPointer(e));
      cv.addEventListener('pointerleave', () => { this.hoverEp = null; this.tip.hidden = true; });
    }
    down(e) {
      this.renderer.domElement.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) { this.abortGesture(); this.gesture = { kind: 'pinch', d0: this.pinchDist(), r0: this.cam.r, c0: this.pinchCenter(), t0: this.cam.target.clone() }; return; }
      if (this.pointers.size > 2) return;
      const h = this.hit(e); const mode = this.app.sceneMode();
      const g = { kind: 'pending', x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey, hit: h, moved: false, theta: this.cam.theta, phi: this.cam.phi, target: this.cam.target.clone() };
      if (mode === 'observe' && h && h.object.userData.kind === 'comp') { const c = DL.project.findComp(this.project, h.object.userData.comp); if (c && c.type === 'BTN') { g.kind = 'press'; g.comp = c.id; this.app.scenePress(c.id, true); } }
      this.gesture = g;
    }
    move(e) {
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const g = this.gesture;
      if (g && g.kind === 'pinch' && this.pointers.size === 2) {
        const d = this.pinchDist(); this.cam.r = Math.max(4, Math.min(90, g.r0 * g.d0 / Math.max(10, d)));
        const c = this.pinchCenter(); this.panBy(c.x - g.c0.x, c.y - g.c0.y, g.t0); this.dirty = true; return;
      }
      if (!g) { this.hover(e); return; }
      if (g.kind === 'press') return;
      const dx = e.clientX - g.x, dy = e.clientY - g.y;
      if (g.kind === 'pending' && Math.hypot(dx, dy) > 5) {
        g.moved = true;
        const k = g.hit && g.hit.object.userData.kind; const mode = this.app.sceneMode();
        if (mode === 'edit' && k === 'ep' && g.button === 0) { g.kind = 'wire'; this.app.sceneWireStart(g.hit.object.userData.ep); }
        else if (mode === 'edit' && (k === 'comp' || k === 'board') && g.button === 0 && !g.shift) { const id = k === 'board' ? 'board' : g.hit.object.userData.comp; g.kind = 'drag'; g.id = id; const pp = this.planePoint(e, id); const o = id === 'board' ? this.project.board.pos : DL.project.findComp(this.project, id).pos; g.off = pp ? { x: o.x - pp.x, z: o.z - pp.z } : { x: 0, z: 0 }; g.orig = { x: o.x, z: o.z }; if (id !== 'board' && DL.project.isBB(this.project, id)) g.riders = this.project.components.filter(c => { const m = DL.breadboard.mountOf(this.project, c.id); return m && m.bb === id; }).map(c => ({ id: c.id, x: this.objects.comps[c.id].position.x, z: this.objects.comps[c.id].position.z })); this.app.sceneSelect({ kind: id === 'board' ? 'board' : 'comp', id }); }
        else g.kind = (g.button === 2 || g.shift) ? 'pan' : 'orbit';
      }
      if (g.kind === 'orbit' || g.kind === 'pan') this.userMoved = true;
      if (g.kind === 'orbit') { this.cam.theta = g.theta - dx * 0.008; this.cam.phi = Math.max(0.0001, Math.min(1.5, g.phi - dy * 0.008)); this.dirty = true; }
      else if (g.kind === 'pan') { this.panBy(dx, dy, g.target); }
      else if (g.kind === 'drag') {
        const pp = this.planePoint(e, g.id); if (!pp) return;
        const pos = { x: snap(pp.x + g.off.x), z: snap(pp.z + g.off.z) };
        const obj = g.id === 'board' ? this.objects.board : this.objects.comps[g.id];
        obj.position.x = pos.x; obj.position.z = pos.z; g.live = pos;
        if (g.id !== 'board') { obj.userData.livePos = pos; this.refreshWiresFor(g.id); }
        for (const r of g.riders || []) { const o = this.objects.comps[r.id]; if (o) { o.position.x = r.x + pos.x - g.orig.x; o.position.z = r.z + pos.z - g.orig.z; } }
        this.dirty = true;
      }
      if (g.kind === 'wire' || this.app.ui.wiringFrom) this.updateRubber(e);
    }
    up(e) {
      const g = this.gesture; this.pointers.delete(e.pointerId);
      if (!g) return;
      if (g.kind === 'pinch') { if (this.pointers.size === 0) this.gesture = null; return; }
      this.gesture = null;
      if (g.kind === 'press') { this.app.scenePress(g.comp, false); return; }
      if (g.kind === 'drag') { const obj = g.id === 'board' ? null : this.objects.comps[g.id]; if (obj) delete obj.userData.livePos; if (g.live) this.app.sceneMove(g.id, g.live); return; }
      if (g.kind === 'wire') { const h = this.hit(e); if (h && h.object.userData.kind === 'ep') this.app.sceneWireEnd(h.object.userData.ep); else this.app.sceneWireEnd(null, true); return; }
      if (g.kind === 'orbit' || g.kind === 'pan') return;
      // 單擊
      const h = g.hit; const k = h && h.object.userData.kind; const mode = this.app.sceneMode();
      if (mode === 'placing') { const pp = this.planePoint(e); if (pp) this.app.scenePlace(pp); return; }
      if (mode !== 'edit') { if (k === 'comp') this.app.sceneSelect({ kind: 'comp', id: h.object.userData.comp }); return; }
      if (k === 'ep') this.app.sceneClickEp(h.object.userData.ep);
      else if (k === 'comp') this.app.sceneSelect({ kind: 'comp', id: h.object.userData.comp });
      else if (k === 'board') this.app.sceneSelect({ kind: 'board', id: 'board' });
      else if (k === 'wire') this.app.sceneSelect({ kind: 'wire', id: h.object.userData.id });
      else this.app.sceneEmpty();
    }
    cancelPointer(e) { this.pointers.delete(e.pointerId); this.abortGesture(); }
    abortGesture() {
      const g = this.gesture; this.gesture = null; if (!g) return;
      if (g.kind === 'press') this.app.scenePress(g.comp, false);
      if (g.kind === 'drag') this.revertDrag(g);
      if (g.kind === 'wire') this.app.sceneWireEnd(null, true);
    }
    revertDrag(g) { for (const r of g.riders || []) { const o = this.objects.comps[r.id]; if (o) { o.position.x = r.x; o.position.z = r.z; } } const obj = g.id === 'board' ? this.objects.board : this.objects.comps[g.id]; if (obj) { obj.position.x = g.orig.x; obj.position.z = g.orig.z; delete obj.userData.livePos; if (g.id !== 'board') this.refreshWiresFor(g.id); } this.dirty = true; }
    escape() { const g = this.gesture; if (g && g.kind === 'drag') { this.gesture = null; this.revertDrag(g); return true; } if (g && g.kind === 'wire') { this.gesture = null; } this.rubber.visible = false; return false; }
    panBy(dx, dy, base) {
      const THREE = T(); const k = this.cam.r * 0.0016;
      const right = new THREE.Vector3(Math.cos(this.cam.theta), 0, -Math.sin(this.cam.theta));
      const fwd = new THREE.Vector3(Math.sin(this.cam.theta), 0, Math.cos(this.cam.theta));
      this.cam.target.copy(base).addScaledVector(right, -dx * k).addScaledVector(fwd, -dy * k); this.dirty = true;
    }
    pinchDist() { const [a, b] = [...this.pointers.values()]; return Math.hypot(a.x - b.x, a.y - b.y); }
    pinchCenter() { const [a, b] = [...this.pointers.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
    updateRubber(e) {
      const from = this.app.ui.wiringFrom; if (!from) { this.rubber.visible = false; return; }
      const a = this.epWorld(from); const h = this.hit(e);
      const b = h && h.object.userData.kind === 'ep' ? this.epWorld(h.object.userData.ep) : this.planePoint(e);
      if (!a || !b) return;
      this.rubber.geometry.setFromPoints(this.wirePath(a, b).getPoints(30)); this.rubber.computeLineDistances(); this.rubber.visible = true; this.dirty = true;
    }
    hover(e) {
      const h = this.hit(e);
      const ep = h && h.object.userData.kind === 'ep' ? h.object.userData.ep : null;
      this.hoverEp = ep;
      this.showBus(ep && DL.project.isBB(this.project, ep.comp) ? ep : (this.app.ui.wiringFrom && DL.project.isBB(this.project, this.app.ui.wiringFrom.comp) ? this.app.ui.wiringFrom : null));
      if (this.app.ui.wiringFrom) this.updateRubber(e);
      const r = this.container.getBoundingClientRect();
      const html = ep ? this.app.describeEp(ep) : h && h.object.userData.kind === 'wire' ? this.app.describeWire(h.object.userData.id) : null;
      if (html) { this.tip.innerHTML = html; this.tip.hidden = false; this.tip.style.left = Math.min(e.clientX - r.left, r.width - 270) + 'px'; this.tip.style.top = (e.clientY - r.top) + 'px'; }
      else this.tip.hidden = true;
      this.renderer.domElement.style.cursor = ep ? 'crosshair' : h && ['comp', 'board'].includes(h.object.userData.kind) && this.app.sceneMode() === 'edit' ? 'grab' : h && h.object.userData.kind === 'comp' && this.app.sceneMode() === 'observe' ? 'pointer' : 'default';
    }
    // 滑過麵包板的孔：把同一條導通條的所有孔標成綠色，直接看出哪些孔相通
    showBus(ep) {
      const key = ep ? ep.comp + '.' + DL.breadboard.busOf(ep.term) + '.' + ep.term : null;
      if (key === this._busKey) return; this._busKey = key;
      if (this.busHl) { this.root.remove(this.busHl); this.busHl.traverse(o => o.geometry && o.geometry.dispose()); this.busHl = null; }
      if (!ep) { this.dirty = true; return; }
      const THREE = T(); const bb = DL.project.findComp(this.project, ep.comp); if (!bb) return;
      const g = new THREE.Group(); const mOn = new THREE.MeshBasicMaterial({ color: 0x23c26b, transparent: true, opacity: 0.85, depthWrite: false }); const mMe = new THREE.MeshBasicMaterial({ color: 0xff9a3c });
      for (const h of DL.breadboard.holesOfBus(DL.breadboard.busOf(ep.term))) { const w = DL.breadboard.holeWorld(bb, h.id); const s = h.id === ep.term ? 0.17 : 0.13; const q = new THREE.Mesh(new THREE.BoxGeometry(s, 0.02, s), h.id === ep.term ? mMe : mOn); q.position.set(w.x, DL.breadboard.TOP + 0.012, w.z); q.raycast = () => { }; g.add(q); }
      this.root.add(g); this.busHl = g; this.dirty = true;
    }
    // 接線助手的建議：兩端點之間畫一條綠色虛線，端點加上光點
    setSuggest(step) {
      const THREE = T(); const k = step ? DL.project.epKey(step.a) + '|' + DL.project.epKey(step.b) : null;
      if (k === this._sugKey && this.sugGroup && this.sugGroup.parent) return; this._sugKey = k;
      if (this.sugGroup) { this.scene.remove(this.sugGroup); this.sugGroup.traverse(o => o.geometry && o.geometry.dispose()); this.sugGroup = null; }
      this._sugStep = step || null;
      if (!step || !this.ok || !this.project) { this.dirty = true; return; }
      const a = this.epWorld(step.a), b = this.epWorld(step.b); if (!a || !b) return;
      const g = new THREE.Group();
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(this.wirePath(a, b).getPoints(40)), new THREE.LineDashedMaterial({ color: 0x1fae5b, dashSize: 0.3, gapSize: 0.18, depthTest: false, transparent: true })); line.computeLineDistances(); line.renderOrder = 10; g.add(line);
      for (const v of [a, b]) { const s = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 12), new THREE.MeshBasicMaterial({ color: 0x1fae5b, transparent: true, opacity: 0.85, depthTest: false })); s.position.copy(v).add(new THREE.Vector3(0, 0.12, 0)); s.renderOrder = 11; s.raycast = () => { }; g.add(s); }
      this.scene.add(g); this.sugGroup = g; this.dirty = true;
    }
    // 測試與輔助功能：端點在畫面上的座標（client px）
    screenOf(ep) { const w = ep === 'comp' ? null : this.epWorld(ep); return w ? this.toClient(w) : null; }
    compScreen(id) { const g = this.objects.comps[id]; if (!g) return null; const v = g.position.clone(); v.y += 0.35; return this.toClient(v); }
    toClient(v) { this.syncSize(); this.updateCamera(); this.camera.updateMatrixWorld(); this.scene.updateMatrixWorld(true); const p = v.clone().project(this.camera); const r = this.renderer.domElement.getBoundingClientRect(); return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height }; }

  }

  function snap(v) { return Math.round(v * 10) / 10; }
  function resistorBands(ohms) {
    const C = ['#111', '#7b4a1c', '#d02b20', '#e8812a', '#f0d12a', '#2e9b45', '#2f6fd6', '#7c46c7', '#8a8a8a', '#f4f4f4'];
    let v = Math.max(1, Math.round(ohms)), exp = 0; while (v >= 100) { v = Math.round(v / 10); exp++; }
    const d = String(v).padStart(2, '0');
    return [C[+d[0]], C[+d[1]], C[Math.min(9, exp)], '#c9a64b'];
  }

  DL.ui = DL.ui || {}; DL.ui.Scene = Scene; DL.ui.resistorBands = resistorBands;
})(typeof globalThis !== 'undefined' ? globalThis : this);
