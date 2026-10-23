/* DofLab — 機械手臂分頁：3D 手臂、拖曳目標（XZ／XY 平面）、數值備援、關節滑桿、姿態、設定與映射 */
(function (root) {
  const DL = root.DL; const A = DL.arm; const App = DL.ui.App; const esc = DL.ui.esc;
  const $ = id => document.getElementById(id);
  const T = () => root.THREE;
  const D2R = Math.PI / 180;
  function css(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#888'; }

  /* ======================= 3D 手臂場景 ======================= */
  class ArmScene {
    constructor(app) { this.app = app; this.ok = false; this.cam = { theta: 0.9, phi: 1.05, r: 38, target: null }; this.pointers = new Map(); try { this.init(); this.ok = true; } catch (e) { this.err = e; } }
    init() {
      const THREE = T(); if (!THREE) throw new Error('Three.js 未載入');
      const r = this.renderer = new THREE.WebGLRenderer({ antialias: true }); r.setPixelRatio(Math.min(2, root.devicePixelRatio || 1)); r.outputEncoding = THREE.sRGBEncoding;
      r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap; r.toneMapping = THREE.ACESFilmicToneMapping;
      this.scene = new THREE.Scene(); this.camera = new THREE.PerspectiveCamera(36, 1, 0.5, 600); this.cam.target = new THREE.Vector3(4, 6, 0);
      this.scene.add(new THREE.HemisphereLight(0xffffff, 0x6f7f8f, 0.6));
      const sun = new THREE.DirectionalLight(0xffffff, 0.85); sun.position.set(-20, 40, 25); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 120 }); this.scene.add(sun);
      this.groundMat = new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 1 });
      const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), this.groundMat); ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; this.scene.add(ground);
      this.armRoot = new THREE.Group(); this.scene.add(this.armRoot);
      // 板子、導線、伺服排線與手臂本體都來自「配置」頁的場景（同一份模型）：放進這個群組，並平移讓手臂底座落在原點
      this.ctx = new THREE.Group(); this.scene.add(this.ctx);
      this.ray = new THREE.Raycaster();
      const el = this.el = document.createElement('div'); el.style.cssText = 'position:absolute;inset:0'; el.appendChild(r.domElement);
      this.labels = document.createElement('div'); this.labels.className = 'labels'; el.appendChild(this.labels);
      this.lbl = {}; for (const k of ['J1', 'J2', 'J3', 'T']) { const d = document.createElement('div'); d.className = 'lbl'; this.labels.appendChild(d); this.lbl[k] = d; }
      this.bind(r.domElement); this.theme();
      new MutationObserver(() => this.theme()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      const mq = root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)'); mq && mq.addEventListener && mq.addEventListener('change', () => this.theme());
      this.ro = new ResizeObserver(() => this.resize());
    }
    theme() {
      const THREE = T(); this.scene.background = new THREE.Color(css('--scene-bg')); this.groundMat.color = new THREE.Color(css('--scene-bg'));
      if (this.grid) this.scene.remove(this.grid); this.grid = new THREE.GridHelper(80, 40, new THREE.Color(css('--scene-grid')), new THREE.Color(css('--scene-grid2'))); this.grid.position.y = 0.01; this.scene.add(this.grid);
    }
    mount(c) { const first = !this.container; if (!this.ok) { if (!c.querySelector('.nogl')) { const d = document.createElement('div'); d.className = 'nogl'; d.textContent = '這個瀏覽器無法建立 WebGL 3D 畫面。仍可用右側的數值與滑桿操作。'; c.appendChild(d); } return; } if (this.el.parentNode !== c) { c.insertBefore(this.el, c.firstChild); this.ro.disconnect(); this.ro.observe(c); } this.container = c; this.resize();  if (first) this.fit(); }
    syncSize() { if (this.container && (this.container.clientWidth !== this._w || this.container.clientHeight !== this._h)) this.resize(); }
    resize() { if (!this.container) return; const w = this.container.clientWidth, h = this.container.clientHeight; if (!w || !h) return; this._w = w; this._h = h; this.renderer.setSize(w, h, false); this.renderer.domElement.style.width = '100%'; this.renderer.domElement.style.height = '100%'; this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }
    setView(v) { const s = { iso: [0.9, 1.0], top: [0, 0.0001], front: [Math.PI / 2, 1.42], side: [0, 1.42] }[v] || [0.9, 1.0]; this.cam.theta = s[0]; this.cam.phi = s[1]; this.view = v; this.fit(); }
    // 取景：手臂與板子、導線一起放進畫面
    fit() {
      const S = this.app.scene; if (!this.cam.target) return;
      if (!S || !S.ok || !S.project || !S.project.arm) { this.cam.target.set(4, 6, 0); this.cam.r = 38; return; }
      const pl = S.armPlace(S.project); const b = S.bounds(); const cx = b.x - pl.x, cz = b.z - pl.z;
      this.cam.target.set((cx + 5) / 2, 4, (cz + 0) / 2);
      const asp = this.camera.aspect || 1.4; this.cam.r = Math.min(140, Math.max(40, b.size * 1.25 + 8) * Math.max(1, 1.35 / asp));
    }
    updateCamera() { const c = this.cam, s = Math.sin(c.phi); this.camera.position.set(c.target.x + c.r * s * Math.sin(c.theta), c.target.y + c.r * Math.cos(c.phi), c.target.z + c.r * s * Math.cos(c.theta)); this.camera.up.set(0, 1, 0); if (c.phi < 0.001) this.camera.up.set(0, 0, -1); this.camera.lookAt(c.target); this.camera.updateMatrixWorld(); }

    /* ---- 建模（依設定的尺寸） ---- */
    get A() { const S = this.app.scene; return S && S.objects && S.objects.arm; }
    get yaw() { return this.A && this.A.yaw; } get shoulder() { return this.A && this.A.shoulder; } get elbow() { return this.A && this.A.elbow; }
    // 把配置頁場景的內容借過來（只在手臂頁顯示時；回到配置／觀測頁時那邊會自己拿回去）
    adopt() {
      const S = this.app.scene; if (!S || !S.ok || !S.project) return;
      if (S.root.parent !== this.ctx) { this.ctx.add(S.root); S._armKey = null; }
      if (S.project.arm) { const pl = S.armPlace(S.project); this.ctx.position.set(-pl.x, 0, -pl.z); }
    }
    build(cfg) {
      const THREE = T(); this.cfg = cfg; this.built = true;
      while (this.armRoot.children.length) this.armRoot.remove(this.armRoot.children[0]);
      const M = (c, o) => new THREE.MeshStandardMaterial(Object.assign({ color: new THREE.Color(c), roughness: 0.55 }, o || {}));
      const sh = o => { o.traverse(n => { if (n.isMesh) { n.castShadow = true; n.receiveShadow = true; } }); return o; };
      const box = (w, h, d, m) => sh(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m));
      const cyl = (r, h, m, s) => sh(new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, s || 32), m));
      // 工作範圍：桌面上的可達環（只畫底座允許的角度）
      const j1 = cfg.joints[0]; const reach = A.reachAtHeight(cfg, cfg.floorY);
      const ring = new THREE.Mesh(new THREE.RingGeometry(Math.max(0.5, reach.rMin), reach.rMax, 96, 1, j1.min * D2R, (j1.max - j1.min) * D2R), new THREE.MeshBasicMaterial({ color: new THREE.Color(css('--ok')), transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.02; this.armRoot.add(ring); this.ring = ring;
      const edge = new THREE.Mesh(new THREE.RingGeometry(reach.rMax - 0.08, reach.rMax, 96, 1, j1.min * D2R, (j1.max - j1.min) * D2R), new THREE.MeshBasicMaterial({ color: new THREE.Color(css('--ok')), transparent: true, opacity: 0.6, side: THREE.DoubleSide })); edge.rotation.x = -Math.PI / 2; edge.position.y = 0.03; this.armRoot.add(edge);
      // 目標把手、垂直參考線、桌面投影
      this.handle = sh(new THREE.Mesh(new THREE.SphereGeometry(0.62, 24, 16), M('#e58a2e', { emissive: new THREE.Color('#3a1c05'), transparent: true, opacity: 0.7 })));
      this.handle.userData.kind = 'handle'; this.armRoot.add(this.handle);
      this.ghost = new THREE.Mesh(new THREE.SphereGeometry(0.75, 20, 12), new THREE.MeshBasicMaterial({ color: 0xd8332a, transparent: true, opacity: 0.45, depthWrite: false })); this.ghost.visible = false; this.armRoot.add(this.ghost);
      this.guide = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineDashedMaterial({ color: 0xe58a2e, dashSize: 0.4, gapSize: 0.25 })); this.armRoot.add(this.guide);
      this.shadowDot = new THREE.Mesh(new THREE.CircleGeometry(0.55, 24), new THREE.MeshBasicMaterial({ color: 0xe58a2e, transparent: true, opacity: 0.5 })); this.shadowDot.rotation.x = -Math.PI / 2; this.shadowDot.position.y = 0.04; this.armRoot.add(this.shadowDot);
      this.planeViz = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshBasicMaterial({ color: new THREE.Color(css('--info')), transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false })); this.planeViz.visible = false; this.armRoot.add(this.planeViz);
    }
    pose(q, target, ghost) {
      if (!this.handle) return;
      this.adopt(); if (this.app.scene.objects.arm) this.app.scene.armPose(q);
      this.handle.position.set(target.x, target.y, target.z);
      this.guide.geometry.setFromPoints([new (T().Vector3)(target.x, target.y, target.z), new (T().Vector3)(target.x, 0.02, target.z)]); this.guide.computeLineDistances();
      this.shadowDot.position.x = target.x; this.shadowDot.position.z = target.z;
      if (ghost) { this.ghost.visible = true; this.ghost.position.set(ghost.x, ghost.y, ghost.z); } else this.ghost.visible = false;
    }
    frame(info) {
      if (!this.ok || !this.container || !this.container.offsetParent) return;
      this.adopt();
      this.syncSize(); this.updateCamera(); this.renderer.render(this.scene, this.camera);
      const THREE = T(); const w = this._w, h = this._h;
      const put = (k, v, text) => { const el = this.lbl[k]; const p = v.clone().project(this.camera); const vis = p.z < 1; el.style.display = vis ? '' : 'none'; if (vis) { el.style.left = ((p.x + 1) / 2 * w) + 'px'; el.style.top = ((1 - p.y) / 2 * h) + 'px'; el.innerHTML = text; } };
      if (info && this.yaw) {
        const wp = o => o.getWorldPosition(new THREE.Vector3());
        put('J1', new THREE.Vector3(0, 1.6, 3.8), `J1 ${info.q[0].toFixed(0)}°`);
        put('J2', wp(this.shoulder).add(new THREE.Vector3(0, 1.4, 0)), `J2 ${info.q[1].toFixed(0)}°`);
        put('J3', wp(this.elbow).add(new THREE.Vector3(0, 1.3, 0)), `J3 ${info.q[2].toFixed(0)}°`);
        put('T', this.handle.position.clone().add(new THREE.Vector3(0, 1.3, 0)), `<span class="mono">(${info.t.x.toFixed(1)}, ${info.t.y.toFixed(1)}, ${info.t.z.toFixed(1)})</span>`);
      }
    }
    toClient(v) { this.syncSize(); this.updateCamera(); const p = v.clone().project(this.camera); const r = this.renderer.domElement.getBoundingClientRect(); return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height }; }
    handleScreen() { return this.handle ? this.toClient(this.handle.position) : null; }
    ndc(e) { this.syncSize(); this.updateCamera(); const r = this.renderer.domElement.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1 }; }

    /* ---- 互動：拖曳把手 / 環繞 / 縮放 ---- */
    bind(cv) {
      cv.addEventListener('contextmenu', e => e.preventDefault());
      cv.addEventListener('wheel', e => { e.preventDefault(); this.cam.r = Math.max(12, Math.min(140, this.cam.r * Math.exp(e.deltaY * 0.0012))); }, { passive: false });
      cv.addEventListener('pointerdown', e => {
        cv.setPointerCapture(e.pointerId); this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.pointers.size === 2) { this.g = { kind: 'pinch', d0: this.pd(), r0: this.cam.r }; return; }
        this.ray.setFromCamera(this.ndc(e), this.camera); this.scene.updateMatrixWorld(true);
        const onHandle = this.handle && this.ray.intersectObject(this.handle).length > 0;
        if (onHandle) { this.g = { kind: 'drag', plane: this.app.armDragPlane(this.handle.position, this.camera), last: this.handle.position.clone() }; this.planeViz.visible = true; this.showPlane(this.g.plane); this.app.armDragStart(); }
        else this.g = { kind: 'orbit', x: e.clientX, y: e.clientY, theta: this.cam.theta, phi: this.cam.phi };
      });
      cv.addEventListener('pointermove', e => {
        if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const g = this.g; if (!g) { this.hover(e); return; }
        if (g.kind === 'pinch' && this.pointers.size === 2) { this.cam.r = Math.max(12, Math.min(140, g.r0 * g.d0 / Math.max(10, this.pd()))); return; }
        if (g.kind === 'orbit') { this.cam.theta = g.theta - (e.clientX - g.x) * 0.008; this.cam.phi = Math.max(0.0001, Math.min(1.5, g.phi - (e.clientY - g.y) * 0.008)); return; }
        if (g.kind === 'drag') {
          this.ray.setFromCamera(this.ndc(e), this.camera);
          const n = g.plane.normal; const cosA = Math.abs(this.ray.ray.direction.dot(n));
          // 投影退化保護：視線幾乎平行於拖曳平面時，交點會大幅跳動 → 不移動，請改視角或用數值
          if (cosA < 0.15) { this.app.armDragDegenerate(true); return; }
          this.app.armDragDegenerate(false);
          const pt = new (T().Vector3)(); if (!this.ray.ray.intersectPlane(g.plane, pt)) return;
          if (pt.distanceTo(g.last) > 8) return;      // 單次移動超過 8 cm：視為投影跳動，忽略
          g.last.copy(pt); this.app.armDragTo({ x: pt.x, y: pt.y, z: pt.z });
        }
      });
      const up = e => { this.pointers.delete(e.pointerId); if (this.g && this.g.kind === 'drag') { this.planeViz.visible = false; this.app.armDragEnd(); } if (this.pointers.size === 0) this.g = null; };
      cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    }
    pd() { const [a, b] = [...this.pointers.values()]; return Math.hypot(a.x - b.x, a.y - b.y); }
    showPlane(plane) { const THREE = T(); const p = this.handle.position; this.planeViz.position.copy(p); this.planeViz.lookAt(p.clone().add(plane.normal)); }
    hover(e) { if (!this.handle) return; this.ray.setFromCamera(this.ndc(e), this.camera); this.renderer.domElement.style.cursor = this.ray.intersectObject(this.handle).length ? 'grab' : 'default'; }
  }

  const poseName = k => k < 26 ? String.fromCharCode(65 + k) : '姿態 ' + (k + 1);   // A、B、C…

  /* ======================= App：手臂狀態與分頁 ======================= */
  const P = App.prototype;
  P.armInit = function () {
    this.arm = { q: [0, 90, 90], qT: [0, 90, 90], t: { x: 10, y: 8, z: 0 }, attempt: null, status: { ok: true, msg: '' }, plane: 'xz', allowJump: false, stream: false, lastSent: [null, null, null], lastSendAt: [0, 0, 0], degenerate: false,
      mode: 'auto', seqSt: null, plan: null, seqFrom: null, loopsSeen: 0 };   // mode：auto＝依行為序列（按「▶ 執行」），manual＝手動拖曳／滑桿
    document.querySelectorAll('#tab-arm [data-amode]').forEach(b => b.onclick = () => { if (b.dataset.amode === 'auto') this.armRunSeq(); else this.armManual('切換到手動'); });
    const rb = $('armRun'); if (rb) rb.onclick = () => { if (this.sim.running && this.arm.mode === 'auto') this.toggleRun(); else this.armRunSeq(); this.renderArmMode(); };
    this.armScene = new ArmScene(this);
    document.querySelectorAll('#tab-arm [data-aview]').forEach(b => b.onclick = () => { this.armScene.setView(b.dataset.aview); document.querySelectorAll('#tab-arm [data-aview]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); });
    document.querySelectorAll('#tab-arm [data-plane]').forEach(b => b.onclick = () => { this.arm.plane = b.dataset.plane; this.renderArm(); });
  };
  P.armLoad = function () {
    const p = this.p; const a = this.arm;
    if (!p.arm) { a.status = { ok: true, msg: '' }; return; }
    const cfg = p.arm.config; const t = p.arm.target || { x: 10, y: 8, z: 0 };
    const s = A.ik(cfg, t, p.arm.q || [0, 90, 90]);
    a.t = Object.assign({}, t); a.qT = s.ok ? s.q : (p.arm.q || [0, 90, 90]); a.q = a.qT.slice(); a.attempt = null;
    a.status = s.ok ? { ok: true, msg: '可到達' } : { ok: false, msg: s.msg };
    a.stream = false; a.lastSent = [null, null, null];
    if (this.armScene.ok) { this.armScene.build(cfg); this.armScene.pose(a.q, a.t); }
  };
  // 拖曳平面：XZ = 水平面（高度不變）；XY = 通過目標、面向相機的垂直面
  P.armDragPlane = function (pos, camera) {
    const THREE = T();
    if (this.arm.plane === 'xz') return new THREE.Plane(new THREE.Vector3(0, 1, 0), -pos.y);
    const d = new THREE.Vector3(); camera.getWorldDirection(d); d.y = 0; if (d.lengthSq() < 1e-6) d.set(0, 0, -1); d.normalize();
    return new THREE.Plane().setFromNormalAndCoplanarPoint(d.negate(), pos.clone());
  };
  P.armDragStart = function () { this.armManual('拖曳目標'); this.arm.dragging = true; };
  P.armDragEnd = function () { this.arm.dragging = false; this.arm.attempt = null; this.arm.degenerate = false; this.armPersist(); this.renderArm(); };
  P.armDragDegenerate = function (on) { if (this.arm.degenerate !== on) { this.arm.degenerate = on; this.renderArmStatus(); } };
  P.armDragTo = function (pt) { this.armSetTarget(pt, { continuous: true }); };
  P.armSetTarget = function (pt, opts) {
    const p = this.p; if (!p.arm) return { ok: false }; this.armManual('設定目標');
    const cfg = p.arm.config; const a = this.arm;
    const t = { x: Math.round(pt.x * 10) / 10, y: Math.round(pt.y * 10) / 10, z: Math.round(pt.z * 10) / 10 };
    const s = opts && opts.continuous ? A.ikContinuous(cfg, t, a.qT, { allowJump: a.allowJump }) : A.ik(cfg, t, a.qT);
    if (s.ok) { a.t = t; a.qT = s.q; a.attempt = null; a.status = { ok: true, msg: s.singular ? '可到達（目標在底座軸線上，沿用目前的底座角度）' : '可到達' }; }
    else { a.attempt = t; a.status = { ok: false, msg: s.msg, reason: s.reason }; a.sawInvalid = true; }   // 無效目標：保留最後有效命令
    if (!opts || !opts.continuous) this.armPersist();
    this.renderArmStatus(); this.renderArmJoints();
    return s;
  };
  P.armSetJoint = function (i, v) {
    this.armManual('調整關節'); const p = this.p; const cfg = p.arm.config; const a = this.arm; const q = a.qT.slice(); q[i] = v;
    const f = A.fk(cfg, q);
    if (f.y < cfg.floorY) { a.status = { ok: false, msg: `這個關節角度會讓末端低於桌面（${f.y.toFixed(1)} cm），已拒絕。`, reason: 'floor' }; this.renderArmStatus(); this.renderArmJoints(); return false; }
    a.qT = q; a.t = { x: Math.round(f.x * 10) / 10, y: Math.round(f.y * 10) / 10, z: Math.round(f.z * 10) / 10 }; a.attempt = null; a.status = { ok: true, msg: '由關節角直接設定' };
    this.armPersist(); this.renderArmStatus(); return true;
  };
  P.armPersist = function () { if (!this.p.arm) return; this.p.arm.target = Object.assign({}, this.arm.t); this.p.arm.q = this.arm.qT.slice(); this.renderHeader(); };
  P.armServoIds = function () { return this.p.arm ? this.p.arm.config.joints.map(j => j.servo) : []; };

  /* ---------- 兩種模式：自動（行為序列）／手動 ---------- */
  P.armHasSeq = function () { return !!(this.p.arm && (this.p.arm.poses || []).length); };
  // 手動操作（拖曳、滑桿、輸入、移到姿態）→ 自動切到手動；序列暫停在目前的姿勢
  P.armManual = function (why) {
    const a = this.arm; if (!this.p.arm || a.mode === 'manual') return;
    a.mode = 'manual'; a.seqSt = null; a.qT = a.q.slice();
    if (this.sim.running) this.toggleRun();   // 暫停：「▶ 執行」按鈕回到可按的狀態，按下就回到行為序列
    this.log('w', `${why || '手動操作'}：手臂切換到「手動」，行為序列暫停；按「▶ 執行」回到行為序列`, this.sim.time);
    this.renderArmMode(); this.renderTabs && this.renderTabs();
  };
  // 按「▶ 執行」（觀測頁或手臂頁）：回到行為序列
  P.armOnRun = function () {
    const a = this.arm; if (!this.p.arm) return;
    if (!this.armHasSeq()) { this.toast('動作序列還沒有姿態：先在「手臂」頁移到想要的位置，按「記下目前姿態」。'); return; }
    if (this.sim.time > 0 && a.mode !== 'auto') { a.mode = 'auto'; a.seqSt = null; a.seqFrom = A.toServo(this.p.arm.config, a.q); this.log('s', '回到行為序列：從目前的姿勢移到第 1 步', this.sim.time); }
    else if (this.sim.time === 0 && !a.seqSt) { a.mode = 'auto'; const q = A.homeQ(this.p.arm.config); a.q = q.slice(); a.qT = q.slice(); a.t = Object.assign({}, A.HOME_T); a.seqFrom = null; this.log('s', '開始：手臂在預備姿態（實際板子上電時伺服也會直接轉到這個角度）', 0); }
    this.renderArmMode();
  };
  P.armRunSeq = function () { if (!this.armHasSeq()) { this.armOnRun(); return; } if (this.arm.mode !== 'auto' || !this.sim.running) { if (this.sim.running) this.armOnRun(); else this.toggleRun(); } };
  P.armReset = function () { const a = this.arm; if (!a) return; a.seqSt = null; a.seqFrom = null; a.loopsSeen = 0; this.sim.armLoops = 0; };
  // 模擬每 1 ms 呼叫一次（與產生的程式同一套規則）
  P.armSeqTick = function (t) {
    const a = this.arm;
    if (!a.seqSt) { a.plan = A.seqPlan(this.p.arm); a.seqSt = A.seqStart(a.plan, t - 1, a.seqFrom); a.seqFrom = null; a.loopsSeen = 0; }
    A.seqStep(a.plan, a.seqSt, t);
    if (a.seqSt.loops > a.loopsSeen) { a.loopsSeen = a.seqSt.loops; this.sim.armLoops = (this.sim.armLoops || 0) + 1; this.log('s', a.plan.loop ? `手臂序列走完第 ${a.loopsSeen} 輪，從第 1 步重新開始` : '手臂序列走完一輪，停在最後的姿勢', t); }
  };
  // 每次推進模擬後：把序列的姿勢交給畫面
  P.armSeqSync = function () {
    const a = this.arm; const st = a.seqSt; if (!st) return; const cfg = this.p.arm.config;
    const q = A.fromServo(cfg, st.cur); a.q = q.slice(); a.qT = q.slice(); a.attempt = null;
    const f = A.fk(cfg, q); a.t = { x: Math.round(f.x * 10) / 10, y: Math.round(f.y * 10) / 10, z: Math.round(f.z * 10) / 10 };
    const w = a.plan.way[st.idx]; a.status = { ok: true, msg: st.done ? `序列走完，停在「${w.name}」` : `自動：第 ${st.idx + 1}／${a.plan.way.length} 步「${w.name}」${st.holding ? '（停留中）' : '（移動中）'}` };
  };
  P.renderArmMode = function () {
    const a = this.arm; const auto = a.mode === 'auto';
    document.querySelectorAll('#tab-arm [data-amode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.amode === a.mode)));
    const el = $('armModeNote'); if (el) el.textContent = !this.p.arm ? '' : auto ? (this.sim.running && a.seqSt ? a.status.msg : this.armHasSeq() ? '自動：按「▶ 執行序列」依行為頁的序列移動' : '自動：序列還沒有姿態') : '手動：拖曳橘色球、滑桿或輸入座標；按「▶ 執行序列」回到行為序列';
    const rb = $('armRun'); if (rb) { rb.textContent = this.sim.running && auto ? '❚❚ 暫停' : '▶ 執行序列'; rb.classList.toggle('primary', !(this.sim.running && auto)); }
  };

  // 每幀：限速逼近目標 → 模擬層；受控寫入且開啟同步時 → 命令
  P.armTick = function (dt) {
    const p = this.p; if (!p.arm) return;
    const a = this.arm; const cfg = p.arm.config;
    a.q = A.stepToward(a.q, a.qT, Math.min(100, dt), cfg.maxSpeed).q;
    const s = A.toServo(cfg, a.q); const bnd = this.analysis.bindings; const now = performance.now();
    cfg.joints.forEach((j, i) => {
      const sig = j.servo + '.angle'; this.twin.simulate(sig, s[i]);
      if (this.twin.mode === 'hw-control' && a.stream && bnd[j.servo] && s[i] !== a.lastSent[i] && now - a.lastSendAt[i] >= 25) {
        this.twin.target(sig, s[i], 'arm');
        const r = this.twin.command(sig, s[i], 'arm');
        if (r.ok && r.cmd && this.hw.driver) { this.hw.driver.write(r.cmd, { num: bnd[j.servo].num, kind: 'servo' }); a.lastSent[i] = s[i]; a.lastSendAt[i] = now; }
        else if (!r.ok && !a.warned) { a.warned = true; this.log('e', r.msg); }
      }
    });
    if (this.ui.tab === 'arm' && this.armScene.ok) { this.armScene.pose(a.q, a.t, a.attempt); this.armScene.frame({ q: a.q, t: a.t }); }
    if (this.ui.tab === 'arm' && (!this._armUi || now - this._armUi > 150)) { this._armUi = now; this.renderArmLive(); if (a.mode === 'auto' && this.sim.running) { this.renderArmStatus(); this.renderArmJoints(); } this.renderArmMode(); }
  };

  /* ---------- 面板 ---------- */
  P.renderArm = function () {
    const p = this.p; const host = $('armPanel'); if (!host) return;
    const none = !p.arm;
    $('armEmpty').hidden = !none; $('armMain').hidden = none;
    if (none) {
      const servos = p.components.filter(c => c.type === 'SERVO').length;
      $('armEmptyBody').innerHTML = `<p>這個專案還沒有手臂。三自由度手臂需要 3 顆伺服馬達（底座、肩、肘）。</p>
        <div class="row"><button class="btn primary" id="armEnable" ${servos >= 3 && !p.lock.components ? '' : 'disabled'}>啟用手臂（使用 ${p.components.filter(c => c.type === 'SERVO').slice(0, 3).map(c => c.id).join('、') || '3 顆伺服'}）</button><button class="btn" id="armGuided">開啟引導實驗：三軸機械手臂</button></div>
        ${servos < 3 ? `<p class="hint">目前只有 ${servos} 顆伺服；請先在「配置」頁加入並接好 3 顆伺服，或開啟引導實驗。</p>` : ''}`;
      const en = $('armEnable'); if (en) en.onclick = () => { const ids = p.components.filter(c => c.type === 'SERVO').slice(0, 3).map(c => c.id); const cfg = A.defaultConfig(); cfg.joints.forEach((j, i) => j.servo = ids[i]); p.arm = { config: cfg, target: { x: 10, y: 8, z: 0 }, q: null, poses: [], confirmed: null }; this.armLoad(); this.changed('arm'); this.renderArm(); };
      $('armGuided').onclick = () => { const b = p.board.type; const r = DL.experiments.instantiate('arm-3dof', b); this.load(r.project, { note: '依右側任務接好 3 顆伺服與外部電源，再到「手臂」頁拖曳目標。' }); this.setTab('config'); };
      return;
    }
    document.querySelectorAll('#tab-arm [data-plane]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.plane === this.arm.plane)));
    this.renderArmStatus(); this.renderArmJoints(); this.renderArmPoses(); this.renderArmConfig();
  };
  P.renderArmStatus = function () {
    const a = this.arm; const el = $('armStatus'); if (!el || !this.p.arm) return;
    el.className = 'confirmbox ' + (a.status.ok ? 'ok' : 'stale');
    el.innerHTML = `<span class="state" style="color:${a.status.ok ? 'var(--ok)' : 'var(--err)'}">${a.status.ok ? '目標可到達' : '目標無效：保留最後有效命令'}</span><span class="hint">${esc(a.status.msg || '')}</span>${a.degenerate ? '<span class="hint" style="color:var(--warn)">視線幾乎平行於拖曳平面，拖曳會跳動：請旋轉視角、改用另一個平面，或直接輸入數值。</span>' : ''}`;
    for (const k of ['x', 'y', 'z']) { const inp = $('armT' + k); if (inp && document.activeElement !== inp) inp.value = a.t[k]; }
    $('armJump').checked = a.allowJump;
    $('armHint').textContent = this.arm.plane === 'xz' ? '拖曳橘色球：在水平面（高度不變）移動目標。' : '拖曳橘色球：在面向你的垂直面移動（可改變高度）。';
  };
  P.renderArmJoints = function () {
    const p = this.p; if (!p.arm) return; const cfg = p.arm.config; const a = this.arm; const s = A.toServo(cfg, a.qT);
    const host = $('armJoints');
    if (!host.dataset.built || host.dataset.cfg !== DL.hash(cfg)) {
      host.dataset.built = '1'; host.dataset.cfg = DL.hash(cfg);
      host.innerHTML = cfg.joints.map((j, i) => `<label class="field" for="armJ${i}"><span>${j.id} ${esc(j.name)}：<b class="mono" id="armJv${i}"></b>　伺服 ${esc(j.servo)} 命令 <b class="mono" id="armJs${i}"></b>　<span class="muted" id="armJc${i}"></span></span><input type="range" id="armJ${i}" min="${j.min}" max="${j.max}" step="1"></label>`).join('');
      cfg.joints.forEach((j, i) => { const r = $('armJ' + i); r.oninput = () => { if (!this.armSetJoint(i, +r.value)) r.value = Math.round(this.arm.qT[i]); }; });
    }
    cfg.joints.forEach((j, i) => { const r = $('armJ' + i); if (document.activeElement !== r) r.value = Math.round(a.qT[i]); $('armJv' + i).textContent = a.qT[i].toFixed(1) + '°'; $('armJs' + i).textContent = s[i] + '°'; });
  };
  P.renderArmLive = function () {
    const p = this.p; if (!p.arm) return; const a = this.arm;
    a.q.forEach((v, i) => { const el = $('armJc' + i); if (el) el.textContent = Math.abs(v - a.qT[i]) > 0.5 ? `（移動中 ${v.toFixed(0)}°）` : ''; });
    const st = $('armStream'); if (st) { st.disabled = this.twin.mode !== 'hw-control'; st.checked = a.stream && this.twin.mode === 'hw-control'; }
    const note = $('armHwNote'); if (note) note.textContent = this.twin.mode === 'hw-control' ? (a.stream ? '正在把限速後的命令角度送往設備。SG90 沒有回授：畫面上的手臂是命令姿態，不是實測姿態。' : '已授權受控寫入：勾選後才會送出手臂命令。') : this.twin.mode === 'hw-read' ? '真機唯讀中：到「觀測」頁核對接線並授權寫入後，才能送出手臂命令。' : '目前是模擬。要控制真機，先到「觀測」頁連線、核對並授權寫入。';
  };
  P.renderArmPoses = function () {
    const p = this.p; const list = $('armPoses'); const poses = p.arm.poses || [];
    list.innerHTML = poses.length ? poses.map((ps, i) => `<li><span class="mono">${i + 1}</span><span>${esc(ps.name)} <span class="muted mono">(${ps.t.x}, ${ps.t.y}, ${ps.t.z})</span></span><span class="row"><button class="btn sm" data-go="${i}">移到</button><button class="btn sm" data-del="${i}">刪除</button></span></li>`).join('') : '<li><span></span><span class="muted">還沒有姿態。移到想要的位置後按「記下目前姿態」。產生程式時會依序播放這些姿態。</span><span></span></li>';
    list.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { this.armManual('移到姿態'); const ps = poses[+b.dataset.go]; this.arm.qT = ps.q.slice(); this.arm.t = Object.assign({}, ps.t); this.arm.status = { ok: true, msg: `移到姿態「${ps.name}」（依限速移動）` }; this.armPersist(); this.renderArm(); });
    list.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { poses.splice(+b.dataset.del, 1); this.changed('arm'); this.renderArm(); });
  };
  P.renderArmConfig = function () {
    const p = this.p; const cfg = p.arm.config; const host = $('armConfig'); const servos = p.components.filter(c => c.type === 'SERVO').map(c => c.id);
    const errs = A.validateConfig(cfg); const conf = this.armConfirmState();
    host.innerHTML = `<p class="hint">尺寸、角度範圍與速度都是教學假設，不是 SG90 原廠規格；接真機前請逐軸量測零位、方向、機構尺寸與允許角度。</p>
      <div class="row">${[['H', '肩高'], ['L1', '上臂'], ['L2', '前臂'], ['maxSpeed', '最大角速度 °/s']].map(([k, l]) => `<label class="field" style="flex:1 1 90px"><span>${l}${k === 'maxSpeed' ? '' : '（cm）'}</span><input class="inp mono" type="number" step="0.5" data-ck="${k}" id="armC${k}" value="${cfg[k]}"></label>`).join('')}</div>
      <div class="tablewrap"><table class="twin"><thead><tr><th>關節</th><th>下限°</th><th>上限°</th><th>伺服</th><th>零位°</th><th>方向</th></tr></thead><tbody>${cfg.joints.map((j, i) => `<tr><td>${j.id} ${esc(j.name)}</td><td><input class="inp mono" style="width:64px" type="number" data-jk="min" data-j="${i}" value="${j.min}"></td><td><input class="inp mono" style="width:64px" type="number" data-jk="max" data-j="${i}" value="${j.max}"></td><td><select class="inp" style="width:auto" data-jk="servo" data-j="${i}">${servos.map(s => `<option ${s === j.servo ? 'selected' : ''}>${s}</option>`).join('')}</select></td><td><input class="inp mono" style="width:64px" type="number" data-jk="zero" data-j="${i}" value="${j.zero}"></td><td><select class="inp" style="width:auto" data-jk="dir" data-j="${i}"><option value="1" ${j.dir === 1 ? 'selected' : ''}>+1</option><option value="-1" ${j.dir === -1 ? 'selected' : ''}>−1</option></select></td></tr>`).join('')}</tbody></table></div>
      ${errs.length ? `<ul class="issues">${errs.map(e => `<li class="error"><span class="lv error">錯誤</span><span>${esc(e)}</span></li>`).join('')}</ul>` : ''}
      ${new Set(cfg.joints.map(j => j.servo)).size < 3 ? '<ul class="issues"><li class="error"><span class="lv error">錯誤</span><span>三個關節必須對應三顆不同的伺服。</span></li></ul>' : ''}
      <div class="confirmbox ${conf === 'current' ? 'ok' : conf === 'stale' ? 'stale' : ''}"><span class="state">${conf === 'current' ? '手臂設定已確認' : conf === 'stale' ? '設定或接線改變了，需要重新確認' : '尚未確認手臂設定'}</span><span class="hint">確認後才能產生姿態播放程式或授權真機寫入。</span><div class="row"><button class="btn ${conf === 'current' ? '' : 'primary'}" id="armConfirm" ${errs.length || conf === 'current' ? 'disabled' : ''}>確認手臂設定與映射</button></div></div>`;
    host.querySelectorAll('[data-ck]').forEach(inp => inp.onchange = () => { const v = +inp.value; if (!Number.isFinite(v)) return; cfg[inp.dataset.ck] = v; this.armAfterConfig(); });
    host.querySelectorAll('[data-jk]').forEach(inp => inp.onchange = () => { const j = cfg.joints[+inp.dataset.j]; const k = inp.dataset.jk; j[k] = k === 'servo' ? inp.value : +inp.value; this.armAfterConfig(); });
    const cb = $('armConfirm'); if (cb) cb.onclick = () => { p.arm.confirmed = { hash: this.armHash(), at: new Date().toISOString() }; this.log('s', '手臂設定已確認'); this.renderAll(); };
  };
  P.armAfterConfig = function () {
    const cfg = this.p.arm.config; const errs = A.validateConfig(cfg);
    if (!errs.length) { this.armScene.ok && this.armScene.build(cfg); const s = A.ik(cfg, this.arm.t, this.arm.qT); if (s.ok) this.arm.qT = s.q; else this.arm.status = { ok: false, msg: '設定改變後，目前目標' + s.msg }; }
    this.changed('arm'); this.renderArm();
  };
  P.armHash = function () { const p = this.p; const a = this.analysis; return DL.hash({ cfg: p.arm.config, b: p.arm.config.joints.map(j => a.bindings[j.servo] ? a.bindings[j.servo].pin : null), board: p.board.type }); };
  P.armConfirmState = function () { const c = this.p.arm && this.p.arm.confirmed; if (!c) return 'none'; return c.hash === this.armHash() ? 'current' : 'stale'; };
  P.bindArm = function () {
    $('armApply').onclick = () => { const t = { x: +$('armTx').value, y: +$('armTy').value, z: +$('armTz').value }; if ([t.x, t.y, t.z].some(v => !Number.isFinite(v))) { this.toast('請輸入數字', 'e'); return; } this.armSetTarget(t, { continuous: false }); };
    $('armJump').onchange = e => { this.arm.allowJump = e.target.checked; };
    $('armSavePose').onclick = () => { const p = this.p; p.arm.poses = p.arm.poses || []; const used = new Set(p.arm.poses.map(x => x.name)); let k = 0; while (used.has(poseName(k))) k++; p.arm.poses.push({ name: poseName(k), t: Object.assign({}, this.arm.t), q: this.arm.qT.slice() }); this.changed('arm'); this.renderArmPoses(); this.toast(`已記下姿態「${poseName(k)}」：在「行為」頁可以調整順序與停留時間`); };
    $('armHome').onclick = () => this.armSetTarget({ x: 10, y: 8, z: 0 }, { continuous: false });
    $('armStream').onchange = e => { if (this.twin.mode !== 'hw-control') { e.target.checked = false; return; } const R = this.hwRequirements(); if (!R.ok) { e.target.checked = false; this.toast('還有條件未符合，不能送出手臂命令。', 'e'); return; } this.arm.stream = e.target.checked; this.arm.warned = false; this.log(this.arm.stream ? 's' : 'w', this.arm.stream ? '開始把手臂命令送往設備（限速）' : '停止送出手臂命令'); };
  };
  /* ---------- 行為頁：手臂動作序列（取代積木） ---------- */
  // 一輪需要多久：用同一套序列規則推算（最多算 10 分鐘）
  function cycleMs(plan) { if (!plan.way.length) return 0; const st = A.seqStart(plan, 0); for (let t = 1; t <= 600000; t++) { A.seqStep(plan, st, t); if (st.loops >= 1) return t; } return null; }
  P.renderArmSeqBehavior = function () {
    const p = this.p; const arm = p.arm; const poses = arm.poses || []; const o = A.seqOptions(arm); const plan = A.seqPlan(arm);
    const key = DL.hash({ cfg: arm.config, poses: poses.map(x => [x.q, x.holdMs]), seq: arm.seq || null }); if (this._cycKey !== key) { this._cycKey = key; this._cyc = cycleMs(plan); }
    const H = A.HOME_T; const sec = ms => (ms / 1000).toFixed(1);
    $('armSeqBody').innerHTML = `<ol class="seq">
      <li class="home"><span class="no">▶</span><span><b>開始：預備姿態</b> <span class="muted mono">(${H.x}, ${H.y}, ${H.z})</span><br><span class="hint">實際板子上電時，伺服直接轉到這個姿勢</span></span><span></span></li>
      ${poses.map((ps, i) => `<li><span class="no">${i + 1}</span><span><b>${esc(ps.name)}</b> <span class="muted mono">(${ps.t.x}, ${ps.t.y}, ${ps.t.z})</span></span>
        <span class="row"><label class="sh">停留 <input class="inp mono" type="number" min="0" max="60" step="0.1" data-shold="${i}" value="${sec(A.holdOf(ps.holdMs === undefined ? 1000 : ps.holdMs))}"> 秒</label>
        <button class="btn sm" data-up="${i}" ${i ? '' : 'disabled'} aria-label="往前">↑</button><button class="btn sm" data-dn="${i}" ${i < poses.length - 1 ? '' : 'disabled'} aria-label="往後">↓</button><button class="btn sm" data-sdel="${i}">刪除</button></span></li>`).join('')}
      ${poses.length && o.returnHome ? `<li class="home"><span class="no">${poses.length + 1}</span><span><b>預備姿態</b> <span class="muted">（回到原點）</span></span><span class="row"><label class="sh">停留 <input class="inp mono" type="number" min="0" max="60" step="0.1" id="seqHomeHold" value="${sec(o.homeHoldMs)}"> 秒</label></span></li>` : ''}
    </ol>
    ${poses.length ? '' : '<p class="hint" style="color:var(--warn)">還沒有姿態。到「手臂」頁把手臂移到想要的位置（A），按「記下目前姿態」；再移到 B、C…，每記一個就多一步。</p>'}
    <label class="check"><input type="checkbox" id="seqHome" ${o.returnHome ? 'checked' : ''}><span>最後回到預備姿態（原點）</span></label>
    <label class="check"><input type="checkbox" id="seqLoop" ${o.loop ? 'checked' : ''}><span>反覆執行（不勾：走完一輪後停住）</span></label>
    <div class="row"><button class="btn" id="seqGoArm">到「手臂」頁記下姿態</button></div>`;
    const set = fn => { fn(); this.changed('arm'); };
    const body = $('armSeqBody');
    body.querySelectorAll('[data-shold]').forEach(inp => inp.onchange = () => { const v = +inp.value; if (!Number.isFinite(v)) return; set(() => { poses[+inp.dataset.shold].holdMs = A.holdOf(v * 1000); }); });
    body.querySelectorAll('[data-up]').forEach(b => b.onclick = () => set(() => { const i = +b.dataset.up; [poses[i - 1], poses[i]] = [poses[i], poses[i - 1]]; }));
    body.querySelectorAll('[data-dn]').forEach(b => b.onclick = () => set(() => { const i = +b.dataset.dn; [poses[i + 1], poses[i]] = [poses[i], poses[i + 1]]; }));
    body.querySelectorAll('[data-sdel]').forEach(b => b.onclick = () => set(() => { poses.splice(+b.dataset.sdel, 1); }));
    const hh = $('seqHomeHold'); if (hh) hh.onchange = () => { const v = +hh.value; if (Number.isFinite(v)) set(() => { arm.seq = Object.assign({}, arm.seq, { homeHoldMs: A.holdOf(v * 1000) }); }); };
    $('seqHome').onchange = e => set(() => { arm.seq = Object.assign({}, arm.seq, { returnHome: e.target.checked }); });
    $('seqLoop').onchange = e => set(() => { arm.seq = Object.assign({}, arm.seq, { loop: e.target.checked }); });
    $('seqGoArm').onclick = () => this.setTab('arm');
    // 右側摘要：就是產生的程式會做的事
    $('summaryList').innerHTML = poses.length ? `<li><span class="rn">序列</span><span>${esc(DL.codegen.armSeqText(plan))}。</span></li>` : '<li><span class="rn">—</span><span class="muted">序列還沒有姿態。</span></li>';
    $('summaryInit').textContent = poses.length ? `每個關節限速 ${arm.config.maxSpeed} °/s，三個關節都到位後才開始停留計時。${this._cyc ? `一輪約 ${sec(this._cyc)} 秒。` : ''}按「▶ 執行」從預備姿態開始；手動操作手臂（拖曳、滑桿、輸入）會自動切到手動模式，再按「▶ 執行」就回到這個序列。` : '';
    $('behaviorIssues').innerHTML = poses.length ? '' : '<li class="warn"><span class="lv warn">注意</span><span>序列沒有姿態：產生程式前至少要記下一個姿態。</span></li>';
    const conf = this.armConfirmState(); const box = $('confirmBox');
    box.className = 'confirmbox' + (conf === 'current' ? ' ok' : conf === 'stale' ? ' stale' : '');
    box.innerHTML = `<span class="state">${conf === 'current' ? '手臂設定已確認' : '手臂設定尚未確認'}</span><span class="hint">手臂專案的程式由這個序列產生；手臂的尺寸、範圍與伺服映射在「手臂」頁確認後，就可以到「程式」頁產生。</span><div class="row"><button class="btn ${conf === 'current' ? '' : 'primary'}" id="seqGoConfirm">${conf === 'current' ? '前往「程式」產生程式' : '到「手臂」頁確認設定'}</button></div>`;
    $('seqGoConfirm').onclick = () => this.setTab(conf === 'current' ? 'code' : 'arm');
  };

  DL.ui.ArmScene = ArmScene;
})(typeof globalThis !== 'undefined' ? globalThis : this);
