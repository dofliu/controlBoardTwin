/* DofLab — 介面主控
 * 一份專案資料＋一個 Twin Core；介面、模擬與設備都讀寫同一份狀態，避免畫面一套、程式一套。
 */
(function (root) {
  const DL = root.DL;
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const LV = { error: '錯誤', warn: '注意', info: '說明', unknown: '未檢查', ok: '一致', mismatch: '不一致', note: '範圍' };
  const STORE_KEY = 'doflab.v2.store';
  const GEN = () => DL.codegen.GENERATOR_VERSION;

  function storeGet() { try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null') || { projects: {}, last: null }; } catch (e) { return { projects: {}, last: null, unavailable: true }; } }
  function storeSet(s) { try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); return true; } catch (e) { return false; } }

  class App {
    constructor() {
      this.ui = { tab: 'config', selected: null, mode: 'idle', placingType: null, wiringFrom: null, confirm: null };
      this.twin = DL.createTwin();
      this.events = [];
      this.sim = { running: false, time: 0, speed: 1, engine: null, held: {}, holdStart: {}, maxHoldMs: 0, minLight: 101, maxLight: -1, presses: 0, last: null, dist: {}, minDist: 999, nearMin: 999, nearMax: -1, farAfterNear: false, serial: [], serialCount: 0 };
      this.hw = { driver: null, identity: null, checks: {}, sawChange: {}, busy: false };
      this.trace = [];
      this.saved = null;
    }

    /* =========================== 啟動 =========================== */
    start() {
      this.scene = new DL.ui.Scene(this);
      this.blocks = new DL.ui.Blocks(this, $('blocklyHost'));
      if (!this.blocks.ok) { const f = $('blocklyFallback'); f.hidden = false; f.textContent = '積木編輯器（Blockly）沒有載入，可能是網路無法連到 CDN。行為摘要與程式仍以已保存的行為資料運作。'; }
      this.bindChrome();
      this.initCollapsibles(); this.initChromeHeight();
      this.armInit(); this.bindArm();
      if (this.teacherInit) this.teacherInit();
      this.twin.on(e => this.onTwinEvent(e));
      const st = storeGet();
      let loaded = false;
      if (st.last && st.projects[st.last]) {
        const revs = st.projects[st.last].revisions; const r = revs[revs.length - 1];
        const res = DL.project.deserialize(r.json);
        if (res.ok) { this.load(res.project, { saved: r.json, note: `已開啟上次保存的「${res.project.name}」r${res.project.revision}。硬體連線不會自動恢復。` }); loaded = true; }
      }
      if (!loaded) this.openExample(true);
      this.setTab((location.hash || '').replace('#', '') || 'config');
      const loop = () => { this.frame(); requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
    }
    openExample(first) {
      const r = DL.experiments.solved('hold-blink', 'uno');
      const p = DL.project.clone(r.project, { name: '範例：按住閃爍（Uno R3）', origin: { kind: 'example', experimentId: 'hold-blink' }, lock: { components: false, behavior: false, board: false } });
      p.behavior.confirmed = null;
      this.load(p, { note: first ? '這是已接好線的範例專案（尚未保存）。到「行為」頁確認摘要後即可產生程式；或按「開始／實驗」選引導實驗。' : '已開啟範例專案。' });
    }

    /* =========================== 專案載入與變更 =========================== */
    load(p, opts) {
      opts = opts || {};
      if (this.hw.driver) this.hwDisconnect('開啟其他專案');
      this.p = p;
      this.saved = opts.saved ? this.contentKey(JSON.parse(opts.saved)) : null;
      this.ui.selected = null; this.cancelModes();
      this.twin.reset(); this.events = []; this.trace = [];
      this.hw.checks = {}; this.hw.sawChange = {};
      this.sim.maxHoldMs = 0; this.sim.minLight = 101; this.sim.maxLight = -1; this.sim.presses = 0; this.sim.minDist = 999; this.sim.nearMin = 999; this.sim.nearMax = -1; this.sim.farAfterNear = false; this.sim.serialCount = 0;
      this.analysis = DL.netlist.analyze(p);
      this.resetSim();
      this.scene.build(p, this.analysis);
      if (this.blocks.ok) this.blocks.load(p.behavior.ir, p.behavior.blocks, p.lock.behavior);
      if (this.armInit) this.armLoad();
      this.renderAll();
      if (opts.note) this.banner(opts.note);
      else this.banner(null);
      this.log('s', `開啟專案「${p.name}」（${DL.boards[p.board.type].name}）`);
    }
    contentKey(p) { const q = JSON.parse(JSON.stringify(p)); delete q.updatedAt; delete q.revision; return DL.hash(q); }
    get dirty() { return this.saved !== this.contentKey(this.p); }

    // 所有「改變電路或行為」的操作都經過這裡
    changed(kind, msg) {
      this.analysis = DL.netlist.analyze(this.p);
      if (kind !== 'move' && kind !== 'name' && kind !== 'code') {
        if (this.sim.running || this.sim.time > 0) { this.resetSim(); this.log('w', '配置或行為改變，模擬已重置。'); }
        if (this.hw.driver && this.twin.mode === 'hw-control') { this.hwRevoke('配置或行為改變，已撤銷寫入授權'); }
      }
      if (kind === 'circuit' || kind === 'board' || kind === 'view' || kind === 'arm') this.scene.build(this.p, this.analysis);
      if (kind === 'circuit' && this.blocks.ok && this.ui.tab === 'behavior') this.blocks.load(this.p.behavior.ir, this.p.behavior.blocks, this.p.lock.behavior);
      this.renderAll();
      if (msg) this.toast(msg);
    }

    /* =========================== 場景互動（scene.js 呼叫） =========================== */
    sceneMode() { if (this.ui.tab === 'observe') return 'observe'; if (this.ui.mode === 'placing') return 'placing'; return 'edit'; }
    scenePlace(pt) { this.place(this.ui.placingType, pt); }
    place(type, pt) {
      const r = DL.project.addComponent(this.p, type, { x: Math.round(pt.x * 10) / 10, z: Math.round(pt.z * 10) / 10 }, 0);
      this.cancelModes();
      if (!r.ok) { this.toast(r.msg, 'e'); return r; }
      this.ui.selected = { kind: 'comp', id: r.comp.id };
      const st = DL.breadboard.settle(this.p, r.comp.id);   // 放在麵包板上就直接插入
      this.changed('circuit', st.msg && st.inserted ? st.msg : `已放置 ${r.comp.id}`);
      if (st.warn) this.toast(st.msg, 'e');
      return r;
    }
    sceneMove(id, pos) {
      const r = DL.project.moveComponent(this.p, id, pos);
      if (!r.ok) return;
      const st = id === 'board' ? { changed: false } : DL.breadboard.settle(this.p, id);
      if (st.changed) this.changed('circuit', st.warn ? null : st.msg);
      else { this.scene.build(this.p, this.analysis); this.renderAll(); }
      if (st.warn) this.toast(st.msg, 'e');
    }
    // 把插在麵包板上的元件拔出，放到麵包板外側
    unmount(id) {
      const m = DL.breadboard.mountOf(this.p, id); if (!m) return;
      const bb = DL.project.findComp(this.p, m.bb); const c = DL.project.findComp(this.p, id);
      DL.breadboard.detach(this.p, id); c.pos = { x: Math.round(c.pos.x * 10) / 10, z: Math.round((bb.pos.z + DL.breadboard.SIZE.d / 2 + 1.4) * 10) / 10 };
      this.changed('circuit', `${id} 已從 ${m.bb} 拔出`);
    }
    sceneSelect(sel) { if (this.ui.wiringFrom) { this.cancelModes(); } this.ui.selected = sel; this.renderInspector(); this.renderWires(); }
    sceneEmpty() { if (this.ui.wiringFrom) { this.cancelModes(); this.toast('已取消接線，沒有建立任何連線。'); return; } this.ui.selected = null; this.renderInspector(); this.renderWires(); }
    sceneClickEp(ep) {
      if (!this.ui.wiringFrom) { this.ui.wiringFrom = ep; this.ui.mode = 'wiring'; this.renderHint(); return; }
      this.finishWire(ep);
    }
    sceneWireStart(ep) { this.ui.wiringFrom = ep; this.ui.mode = 'wiring'; this.ui.dragWire = true; this.renderHint(); }
    sceneWireEnd(ep, cancel) {
      const wasDrag = this.ui.dragWire; this.ui.dragWire = false;
      if (cancel || !ep) { if (wasDrag) { this.cancelModes(); this.toast('已取消接線，沒有建立任何連線。'); } return; }
      this.finishWire(ep);
    }
    finishWire(ep) {
      const from = this.ui.wiringFrom; this.cancelModes();
      if (!from) return;
      const r = DL.project.addConnection(this.p, from, ep);
      if (!r.ok) { this.toast(r.msg, 'e'); this.renderAll(); return r; }
      this.ui.selected = { kind: 'wire', id: r.wire.id };
      this.changed('circuit', `${r.wire.id}：${this.epName(from)} ↔ ${this.epName(ep)}`);
      return r;
    }
    scenePress(id, down) { if (this.twin.mode !== 'sim') { if (down) this.toast('真機模式：請按實體按鈕，畫面會顯示量測到的狀態。'); return; } this.setHeld(id, down); }
    cancelModes() {
      this.ui.mode = 'idle'; this.ui.placingType = null; this.ui.wiringFrom = null;
      if (this.scene && this.scene.ok) { this.scene.escape(); this.scene.rubber.visible = false; }
      this.renderPalette(); this.renderHint();
    }
    epName(ep) {
      if (ep.comp === 'board') { const b = DL.boards[this.p.board.type]; return b.pinLabel(b.pinById[ep.term]); }
      const c = DL.project.findComp(this.p, ep.comp); const t = c && DL.components[c.type].terminals.find(t => t.id === ep.term);
      return `${ep.comp}.${t ? t.label.split('（')[0] : ep.term}`;
    }
    describeEp(ep) {
      if (ep.comp === 'board') {
        const b = DL.boards[this.p.board.type]; const pin = b.pinById[ep.term];
        const capName = { din: '數位輸入', dout: '數位輸出', pullup: '內建上拉', pwm: 'PWM', adc: '類比輸入', servo: '伺服' };
        const users = (this.analysis.pinUse[pin.id] || []).join('、');
        const caps = pin.kind === 'gpio' ? pin.caps.map(c => capName[c]).join('、') : pin.kind === 'power' ? `電源 ${pin.volts ?? ''}V` : pin.kind === 'gnd' ? '接地' : '特殊用途';
        return `<b>${esc(b.pinLabel(pin))}</b><br>${esc(caps)}${users ? '<br>目前：' + esc(users) : ''}${pin.notes.length ? '<br>' + esc(pin.notes.map(n => n.text).join(' ')) : ''}<br><span style="opacity:.7">${this.ui.wiringFrom ? '點一下完成接線' : '點一下開始接線'}</span>`;
      }
      const c = DL.project.findComp(this.p, ep.comp);
      if (c.type === 'BB') {   // 麵包板的孔：顯示導通條與上面已經插了什麼
        const BBm = DL.breadboard; const bus = BBm.busOf(ep.term);
        const on = this.p.connections.filter(w => w.a.comp === c.id && BBm.busOf(w.a.term) === bus || w.b.comp === c.id && BBm.busOf(w.b.term) === bus).map(w => { const [me, other] = w.a.comp === c.id ? [w.a, w.b] : [w.b, w.a]; return `${BBm.holeLabel(me.term)}：${other.comp === c.id ? '跳線到 ' + BBm.holeLabel(other.term) : this.epName(other)}`; });
        const occ = BBm.occupant(this.p, c.id, ep.term);
        return `<b>${esc(c.id)} · ${esc(BBm.holeLabel(ep.term))}</b><br>屬於「${esc(BBm.busLabel(bus))}」導通條（綠色的孔都相通）${on.length ? '<br>這條上：' + esc(on.join('；')) : '<br>這條上還沒有東西'}<br><span style="opacity:.7">${occ ? '這個孔已經有東西了' : this.ui.wiringFrom ? '點一下完成接線' : '點一下開始接線'}</span>`;
      }
      const t = DL.components[c.type].terminals.find(t => t.id === ep.term);
      const wires = this.p.connections.filter(w => DL.project.sameEp(w.a, ep) || DL.project.sameEp(w.b, ep)).map(w => w.id);
      return `<b>${esc(c.id)}</b> · ${esc(t.label)}${wires.length ? '<br>連線：' + esc(wires.join('、')) : '<br>未連接'}`;
    }
    describeWire(id) { const w = this.p.connections.find(w => w.id === id); return w ? `<b>${w.id}</b><br>${esc(this.epName(w.a))} ↔ ${esc(this.epName(w.b))}` : ''; }
    compIds(type) { return this.p ? this.p.components.filter(c => c.type === type).map(c => c.id) : []; }

    /* =========================== 外框、分頁、對話框 =========================== */
    bindChrome() {
      for (const t of ['config', 'behavior', 'code', 'observe', 'arm']) $('t-' + t).onclick = () => this.setTab(t);
      $('projName').addEventListener('change', e => { this.p.name = e.target.value.trim() || '未命名專案'; this.changed('name'); });
      $('btnSave').onclick = () => this.save();
      $('btnStart').onclick = () => this.openStart();
      $('btnProject').onclick = () => this.openProject();
      $('openExample').onclick = () => { $('dlgStart').close(); this.openExample(); };
      document.querySelectorAll('dialog [data-close]').forEach(b => b.onclick = () => b.closest('dialog').close());
      document.querySelectorAll('.vp-tools [data-view]').forEach(b => b.onclick = () => { this.scene.setView(b.dataset.view); document.querySelectorAll('.vp-tools [data-view]').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.view === b.dataset.view))); });
      $('tglWire').onclick = e => { this.p.view = this.p.view || {}; const neat = (this.p.view.wireStyle || 'neat') !== 'neat'; this.p.view.wireStyle = neat ? 'neat' : 'arc'; e.currentTarget.setAttribute('aria-pressed', String(neat)); this.changed('view', neat ? '已自動整線' : '改用弧線'); };
      $('tglUsed').onclick = e => { const on = e.currentTarget.getAttribute('aria-pressed') !== 'true'; e.currentTarget.setAttribute('aria-pressed', String(on)); this.scene.highlightUsed = on; };
      $('boardSel').onchange = e => this.changeBoard(e.target.value);
      document.addEventListener('keydown', e => this.key(e));
      // 程式頁
      $('btnGen').onclick = () => this.generate();
      $('btnCompile').onclick = () => this.compile();
      const ta = $('code');
      ta.addEventListener('input', () => this.onCodeEdit());
      ta.addEventListener('scroll', () => { $('gutter').scrollTop = ta.scrollTop; });
      ta.addEventListener('keydown', e => { if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; const ind = this.p.board.type === 'pi4b' ? '    ' : '  '; ta.setRangeText(ind, s, ta.selectionEnd, 'end'); this.onCodeEdit(); } });
      $('compileUrl').value = this.defaultCompileUrl();
      // 專案對話框
      $('btnExport').onclick = () => { $('jsonBox').value = DL.project.serialize(this.p); this.setDownload(); };
      $('btnCopyJson').onclick = () => this.copy($('jsonBox').value, $('jsonBox'));
      $('btnImport').onclick = () => this.importJson($('jsonBox').value);
      $('importFile').onchange = e => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => { $('jsonBox').value = r.result; this.importJson(r.result); }; r.readAsText(f); e.target.value = ''; };
      this.bindObserve();
      this.renderPalette();
      root.addEventListener('beforeunload', e => { if (this.p && this.dirty) { e.preventDefault(); e.returnValue = ''; } });
    }
    /* ---------- V2.7 緊湊版面：可收合卡片、主畫面高度、浮動資訊 ---------- */
    initCollapsibles() {
      let st = {}; try { st = JSON.parse(localStorage.getItem('doflab.collapsed') || '{}') || {}; } catch (e) { }
      this._collapsed = st;
      document.querySelectorAll('main .card').forEach(card => {
        const h = card.querySelector(':scope > h3'); if (!h || h.dataset.cx) return; h.dataset.cx = '1';
        const key = card.id || ((h.firstChild && h.firstChild.textContent) || '').trim(); card.dataset.ckey = key;
        const ttl = document.createElement('span'); ttl.className = 'ttl';
        const cx = document.createElement('button'); cx.type = 'button'; cx.className = 'cx'; cx.textContent = '▼'; cx.setAttribute('aria-label', '收合或展開'); cx.setAttribute('aria-expanded', 'true');
        ttl.appendChild(cx); while (h.firstChild && h.firstChild.nodeType === 3) ttl.appendChild(h.firstChild);
        h.insertBefore(ttl, h.firstChild);
        h.addEventListener('click', e => { if (e.target.closest('button:not(.cx),input,select,a,label,textarea')) return; this.setCollapsed(card, !card.classList.contains('collapsed'), true); });
        if (st[key] !== undefined) this.setCollapsed(card, !!st[key], false);
      });
    }
    setCollapsed(card, on, save) {
      card.classList.toggle('collapsed', on); const cx = card.querySelector(':scope > h3 .cx'); if (cx) cx.setAttribute('aria-expanded', String(!on));
      if (save) { this._collapsed[card.dataset.ckey] = on; try { localStorage.setItem('doflab.collapsed', JSON.stringify(this._collapsed)); } catch (e) { } }
      if (!on && card.id === 'traceCard') this._traceSize = null;
    }
    // 從主畫面的浮動資訊跳到側欄的卡片：展開、捲到看得到的位置、閃一下
    focusCard(id) {
      const c = $(id); if (!c || c.hidden) return;
      if (c.classList.contains('collapsed')) this.setCollapsed(c, false, true);
      c.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); c.classList.add('flash'); setTimeout(() => c.classList.remove('flash'), 900);
    }
    initChromeHeight() {
      const upd = () => { const m = document.querySelector('main'); const bar = document.querySelector('.bar'); if (!m || !bar) return; document.documentElement.style.setProperty('--chrome-h', Math.round(m.getBoundingClientRect().top + root.scrollY) + 'px'); document.documentElement.style.setProperty('--sticky-h', bar.offsetHeight + 'px'); };
      this.updateChrome = upd; upd();
      root.addEventListener('resize', upd);
      if (root.ResizeObserver) { const ro = new ResizeObserver(upd); for (const el of [document.querySelector('.bar'), $('banner'), document.querySelector('.tabs')]) if (el) ro.observe(el); }
    }
    // 配置頁主畫面右上角：檢查結果、任務進度、連線數、選取項目（點一下跳到右側卡片）
    renderHud() {
      const el = $('hudConfig'); if (!el || !this.p) return;
      const a = this.analysis; const c = a.counts; const chips = [];
      chips.push(c.error ? ['err', 'issueCard', `電路檢查 <b>${c.error} 錯誤</b>${c.warn ? ` · ${c.warn} 注意` : ''}`] : c.warn || c.unknown ? ['warn', 'issueCard', `電路檢查 <b>${c.warn ? c.warn + ' 注意' : ''}${c.unknown ? ' ' + c.unknown + ' 未檢查' : ''}</b>`] : ['ok', 'issueCard', '電路檢查 <b>✓ 通過</b>']);
      const tl = $('taskList'); if (!$('taskCard').hidden && tl) { const all = tl.querySelectorAll('li'); const done = tl.querySelectorAll('li.done'); const next = [...all].find(li => !li.classList.contains('done')); chips.push([done.length === all.length ? 'ok' : '', 'taskCard', `任務 <b>${done.length}／${all.length}</b>${next ? ' · ' + esc(next.textContent.slice(0, 16)) + (next.textContent.length > 16 ? '…' : '') : ''}`]); }
      if (!$('assistCard').hidden) chips.push(['', 'assistCard', `接線助手 <b>${esc(($('assistCount') || {}).textContent || '')}</b>`]);
      chips.push(['', 'wireCard', `連線 <b>${this.p.connections.length}</b> 條`]);
      const sel = this.ui.selected; if (sel && sel.id) chips.push(['', 'inspectCard', `選取 <b>${esc(sel.id)}</b>`]);
      const html = chips.map(([k, id, t]) => `<button type="button" class="hc ${k}" data-card="${id}">${t}</button>`).join('');
      if (html !== this._hudHtml) { this._hudHtml = html; el.innerHTML = html; el.querySelectorAll('[data-card]').forEach(b => b.onclick = () => this.focusCard(b.dataset.card)); }
    }
    setTab(t) {
      if (!['config', 'behavior', 'code', 'observe', 'arm'].includes(t)) t = 'config';
      if (this.ui.tab !== t) this.cancelModes();
      this.ui.tab = t;
      for (const x of ['config', 'behavior', 'code', 'observe', 'arm']) { $('t-' + x).setAttribute('aria-selected', String(x === t)); $('tab-' + x).hidden = x !== t; }
      if (this.updateChrome) this.updateChrome();
      if (t === 'config') this.scene.mount($('vpConfig'));
      if (t === 'observe') { this.scene.mount($('vpObserve')); this.renderObserve(); }
      if (t === 'behavior' && this.blocks.ok) { if (!this.blocks.ws) this.blocks.load(this.p.behavior.ir, this.p.behavior.blocks, this.p.lock.behavior); setTimeout(() => this.blocks.resize(), 0); }
      if (t === 'code') this.renderCode();
      if (t === 'arm') { this.renderArm(); if (this.armScene.ok) { this.armScene.mount($('vpArm')); if (this.p.arm && !this.armScene.built) this.armScene.build(this.p.arm.config); if (this.armScene._fitId !== this.p.id) { this.armScene._fitId = this.p.id; this.armScene.fit(); } } }
      try { history.replaceState(null, '', '#' + t); } catch (e) { }
    }
    key(e) {
      const tag = (e.target.tagName || '').toLowerCase();
      if (['input', 'textarea', 'select'].includes(tag) || e.target.closest && e.target.closest('.blockly-host')) return;
      if (e.key === 'Escape') { if (this.ui.mode !== 'idle' || (this.scene.gesture)) { this.cancelModes(); this.toast('已取消，沒有留下任何變更。'); } }
      if (this.ui.tab !== 'config') return;
      const s = this.ui.selected;
      if ((e.key === 'Delete' || e.key === 'Backspace') && s) { e.preventDefault(); this.removeSelected(); }
      if ((e.key === 'r' || e.key === 'R') && s && (s.kind === 'comp' || s.kind === 'board')) this.rotateSelected();
    }
    banner(html, kind) {
      const p = this.p; const guided = p && p.origin.kind === 'guided';
      const parts = [];
      if (guided) parts.push(`<b>引導實驗</b><span>元件與行為已鎖定，只開放接線與移動。</span><button class="btn sm" id="bnCopy">複製為自訂專案</button>`);
      if (html) parts.push(`<span>${html}</span>`);
      $('banner').hidden = !parts.length; $('banner').className = 'banner' + (guided ? ' guided' : '');
      $('bannerBody').innerHTML = parts.join('<span class="muted">·</span>') + (parts.length ? '<button class="btn sm" id="bnAbout" style="margin-left:auto">這個版本做到哪裡</button>' : '');
      const c = $('bnCopy'); if (c) c.onclick = () => this.copyGuided();
      const a = $('bnAbout'); if (a) a.onclick = () => this.openAbout();
    }
    toast(msg, kind) {
      const d = document.createElement('div'); d.className = 'toast' + (kind === 'e' ? ' e' : ''); d.textContent = msg; d.setAttribute('role', 'status');
      document.body.appendChild(d); clearTimeout(this._tt); document.querySelectorAll('.toast').forEach(x => { if (x !== d) x.remove(); });
      this._tt = setTimeout(() => d.remove(), kind === 'e' ? 5200 : 2600);
    }
    copy(text, fallbackEl) {
      const sel = () => { if (fallbackEl) { fallbackEl.focus(); fallbackEl.select(); } this.toast('瀏覽器不允許直接複製，已選取文字，請按 Ctrl／⌘＋C。'); };
      try { navigator.clipboard.writeText(text).then(() => this.toast('已複製'), sel); } catch (e) { sel(); }
    }

    /* =========================== 渲染 =========================== */
    renderAll() {
      this.renderHeader(); this.renderTabs(); this.renderBoardSel(); this.renderPalette(); this.renderInspector(); this.renderIssues(); this.renderWires(); this.renderTasks(); this.renderHint();
      if (this.renderAssist) this.renderAssist();
      this.renderBehavior();
      if (this.ui.tab === 'code') this.renderCode();
      if (this.ui.tab === 'arm') this.renderArm();
      const tw = $('tglWire'); if (tw) tw.setAttribute('aria-pressed', String(((this.p.view || {}).wireStyle || 'neat') === 'neat'));
      this.renderObserve();
    }
    renderHeader() {
      const p = this.p; const b = DL.boards[p.board.type];
      if (document.activeElement !== $('projName')) $('projName').value = p.name;
      const m = $('projMeta'); m.textContent = `r${p.revision}${this.dirty ? ' · 未保存的變更' : ' · 已保存'}`; m.classList.toggle('dirty', this.dirty);
      $('boardChip').textContent = b.name;
      const mode = this.twin.mode; const mp = $('modePill');
      mp.className = 'pill ' + (mode === 'sim' ? 'sim' : mode === 'hw-read' ? 'read' : 'ctl'); mp.querySelector('span').textContent = DL.modeLabel(mode);
      const c = this.twin.conn; const cp = $('connPill');
      cp.className = 'pill ' + (c.state === 'connected' ? 'on' : c.state === 'lost' ? 'lost' : '');
      cp.querySelector('span').textContent = c.state === 'connected' ? `已連線 · ${c.info || ''}`.slice(0, 40) : c.state === 'lost' ? '連線中斷' : '未連線';
      document.title = `DofLab`;
    }
    renderTabs() {
      const a = this.analysis; const tb = $('tbConfig');
      tb.className = 'tb ' + (a.counts.error ? 'err' : a.counts.warn || a.counts.unknown ? 'warn' : 'ok'); tb.textContent = a.counts.error ? `${a.counts.error} 錯誤` : a.counts.unknown ? `${a.counts.unknown} 未檢查` : a.counts.warn ? `${a.counts.warn} 注意` : '通過';
      const cs = this.confirmState(); const tbb = $('tbBehavior');
      tbb.className = 'tb ' + (cs === 'current' ? 'ok' : cs === 'stale' ? 'warn' : ''); tbb.textContent = cs === 'current' ? '已確認' : cs === 'stale' ? '需重新確認' : '未確認';
      if (this.p.arm && !(this.p.behavior.ir.rules || []).length) { const n = (this.p.arm.poses || []).length; tbb.className = 'tb ' + (n ? 'ok' : 'warn'); tbb.textContent = n ? `序列 ${n} 步` : '沒有姿態'; }
      const code = this.codeState(); const tbc = $('tbCode');
      tbc.className = 'tb ' + ({ current: 'ok', stale: 'warn', manual: 'warn', none: '' }[code.state]); tbc.textContent = { current: '最新', stale: '過期', manual: '手動修改', none: '尚未產生' }[code.state];
      const tba = $('tbArm'); if (tba) { const st = !this.p.arm ? '' : this.armConfirmState(); tba.className = 'tb ' + (st === 'current' ? 'ok' : st ? 'warn' : ''); tba.textContent = !this.p.arm ? '未啟用' : st === 'current' ? '已確認' : '未確認'; }
      const tbo = $('tbObserve'); tbo.className = 'tb ' + (this.twin.mode === 'sim' ? '' : 'ok'); tbo.textContent = this.sim.running ? '執行中' : DL.modeLabel(this.twin.mode);
    }
    renderBoardSel() {
      const s = $('boardSel'); const p = this.p;
      s.innerHTML = DL.boardList.map(id => `<option value="${id}" ${id === p.board.type ? 'selected' : ''}>${DL.boards[id].name}</option>`).join('');
      s.disabled = !!p.lock.board || !!this.hw.driver;
      const b = DL.boards[p.board.type];
      $('boardNotes').innerHTML = b.notes.map(esc).join('<br>') + `<br><span class="mono" style="font-size:.74rem">能力資料 ${b.capabilityVersion}${b.fqbn ? ' · ' + b.fqbn : ''}</span>`;
    }
    changeBoard(id) {
      const p = this.p; if (id === p.board.type) return;
      const n = p.connections.filter(w => w.a.comp === 'board' || w.b.comp === 'board').length;
      this.inlineConfirm('config', `換成 ${DL.boards[id].name} 會移除 ${n} 條接到控制板的連線（腳位名稱不同），並讓已產生的程式與建置過期。元件與元件之間的連線會保留。`, '換板型', () => {
        p.connections = p.connections.filter(w => w.a.comp !== 'board' && w.b.comp !== 'board');
        p.board = { type: id, capabilityVersion: DL.boards[id].capabilityVersion, pos: p.board.pos, rot: p.board.rot };
        this.changed('board', `已換成 ${DL.boards[id].name}`);
        this.renderHw();
      }, () => { $('boardSel').value = p.board.type; });
    }
    inlineConfirm(where, text, okLabel, onOk, onCancel) {
      const host = where === 'code' ? $('codeConfirm') : $('inspector');
      const prev = host.innerHTML;
      host.innerHTML = `<div class="inline-confirm" role="alertdialog"><span>${esc(text)}</span><div class="row"><button class="btn primary" id="icOk">${esc(okLabel)}</button><button class="btn" id="icNo">取消</button></div></div>`;
      $('icOk').onclick = () => { host.innerHTML = ''; onOk(); if (where !== 'code') this.renderInspector(); };
      $('icNo').onclick = () => { host.innerHTML = where === 'code' ? '' : prev; onCancel && onCancel(); if (where !== 'code') this.renderInspector(); };
    }

    renderPalette() {
      const el = $('palette'); if (!el || !this.p) return;
      const locked = this.p.lock.components;
      const icons = {
        LED: '<svg viewBox="0 0 34 28"><path d="M11 20V11a6 6 0 0 1 12 0v9z" fill="#d8332a"/><rect x="9" y="19" width="16" height="3" fill="#b02a22"/><path d="M14 22v5M20 22v5" stroke="#8a949c" stroke-width="1.6"/></svg>',
        RES: '<svg viewBox="0 0 34 28"><path d="M2 14h7M25 14h7" stroke="#8a949c" stroke-width="1.6"/><rect x="9" y="10" width="16" height="8" rx="3" fill="#d9c08e"/><path d="M13 10v8M16 10v8M19 10v8" stroke="#c0392b" stroke-width="1.5"/><path d="M22 10v8" stroke="#c9a64b" stroke-width="1.5"/></svg>',
        BTN: '<svg viewBox="0 0 34 28"><rect x="7" y="8" width="20" height="16" rx="2" fill="#2a2f35"/><circle cx="17" cy="16" r="5.5" fill="#cfd6dc"/></svg>',
        LDR: '<svg viewBox="0 0 34 28"><rect x="5" y="6" width="24" height="18" rx="2" fill="#1f5fa8"/><circle cx="13" cy="13" r="4.5" fill="#e0a347"/><path d="M10 13h6" stroke="#8a4a10" stroke-width="1.2"/></svg>',
        PSU: '<svg viewBox="0 0 34 28"><rect x="3" y="6" width="28" height="17" rx="2" fill="#2b6b3a"/><rect x="5" y="9" width="9" height="11" rx="1" fill="#1b1d20"/><rect x="18" y="12" width="11" height="8" rx="1" fill="#1f9a4f"/><circle cx="21" cy="16" r="1.8" fill="#c3c8cc"/><circle cx="26" cy="16" r="1.8" fill="#c3c8cc"/></svg>',
        BB: '<svg viewBox="0 0 34 28"><rect x="2" y="4" width="30" height="20" rx="1.5" fill="#f1efe8" stroke="#c9c5ba"/><path d="M4 7h26M4 21h26" stroke="#d63a32" stroke-width=".8"/><path d="M4 8.6h26M4 19.4h26" stroke="#2b5fc4" stroke-width=".8"/><rect x="2" y="13.4" width="30" height="1.2" fill="#c9c5ba"/>' + [0, 1, 2, 3, 4, 5, 6, 7, 8].map(i => `<rect x="${5 + i * 3}" y="10.6" width="1.2" height="1.2" fill="#444"/><rect x="${5 + i * 3}" y="16.2" width="1.2" height="1.2" fill="#444"/>`).join('') + '</svg>',
        SERVO: '<svg viewBox="0 0 34 28"><rect x="4" y="9" width="20" height="14" rx="1.5" fill="#2f6fbf"/><circle cx="18" cy="9" r="3" fill="#2f6fbf"/><rect x="16" y="6.5" width="15" height="4" rx="2" fill="#f2f2f2"/></svg>',
        OBLED: '<svg viewBox="0 0 34 28"><rect x="3" y="7" width="28" height="15" rx="2" fill="#141a2b"/><rect x="18" y="12" width="6" height="4" rx="1" fill="#3a7bff"/><circle cx="21" cy="14" r="6" fill="#3a7bff" opacity=".25"/><rect x="7" y="12" width="6" height="4" rx="1" fill="#ff3b30"/></svg>',
        BOOT: '<svg viewBox="0 0 34 28"><rect x="3" y="7" width="28" height="15" rx="2" fill="#141a2b"/><rect x="11" y="9" width="11" height="11" rx="1.5" fill="#2a2d31"/><circle cx="16.5" cy="14.5" r="3.4" fill="#cfd6dc"/></svg>',
        TOUCH: '<svg viewBox="0 0 34 28"><rect x="3" y="15" width="28" height="7" rx="1" fill="#141a2b"/><rect x="15" y="9" width="3" height="8" fill="#c9a64b"/><path d="M16.5 3c-2.2 0-3.5 1.6-3.5 3.6V12h7V6.6C20 4.6 18.7 3 16.5 3z" fill="#e8b48f"/><circle cx="16.5" cy="12" r="6.5" fill="none" stroke="#31c3c7" stroke-width="1.4"/></svg>',
        US: '<svg viewBox="0 0 34 28"><rect x="1.5" y="7" width="31" height="14" rx="1.5" fill="#1f62a8"/><circle cx="9.5" cy="14" r="5.6" fill="#c9ced3"/><circle cx="9.5" cy="14" r="3.6" fill="#3a3f45"/><circle cx="24.5" cy="14" r="5.6" fill="#c9ced3"/><circle cx="24.5" cy="14" r="3.6" fill="#3a3f45"/><path d="M14 23v4M16 23v4M18 23v4M20 23v4" stroke="#c9a64b" stroke-width="1.2"/></svg>'
      };
      const bd = DL.boards[this.p.board.type];
      const fits = d => !d.onboard || (d.onboard === 'touch' ? bd.pins.some(x => x.caps.includes('touch')) : !!(bd.onboard || {})[d.onboard]);   // 只列出這塊板子有的板載元件
      const pc = $('paletteCard'); if (pc && this._collapsed && this._collapsed.paletteCard === undefined) this.setCollapsed(pc, !!locked, false);   // 引導實驗鎖定元件時，清單預設收起來（使用者自己開關過就照他的）
      el.innerHTML = Object.values(DL.components).filter(fits).map(d => `<button class="pal" data-type="${d.type}" title="${esc(d.name + '：' + d.model)}" ${locked ? 'disabled' : ''} aria-pressed="${this.ui.placingType === d.type}">${icons[d.type] || ''}<span><b>${d.name}</b><small>${esc(d.model)}</small></span></button>`).join('') + (locked ? '<p class="hint">引導實驗鎖定了元件清單。</p>' : '');
      el.querySelectorAll('.pal').forEach(b => b.addEventListener('pointerdown', e => this.paletteDown(e, b.dataset.type)));
    }
    // 從清單拖到場景（滑鼠與觸控共用）；沒有移動就視為「先選元件、再點位置」
    paletteDown(e, type) {
      if (this.p.lock.components) return;
      e.preventDefault();
      const x0 = e.clientX, y0 = e.clientY; let ghost = null; let moved = false;
      const mv = ev => {
        if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 6) { moved = true; ghost = document.createElement('div'); ghost.className = 'ghost'; ghost.textContent = DL.components[type].name; document.body.appendChild(ghost); }
        if (ghost) { ghost.style.left = ev.clientX + 'px'; ghost.style.top = ev.clientY + 'px'; ghost.style.opacity = this.scene.inside(ev.clientX, ev.clientY) ? 1 : 0.55; }
      };
      const upf = ev => {
        root.removeEventListener('pointermove', mv); root.removeEventListener('pointerup', upf); root.removeEventListener('pointercancel', cancel);
        if (ghost) ghost.remove();
        if (!moved) { if (this.ui.placingType === type) { this.cancelModes(); return; } this.cancelModes(); this.ui.mode = 'placing'; this.ui.placingType = type; this.renderPalette(); this.renderHint(); const vp = $('vpConfig').getBoundingClientRect(); if (vp.top < 0 || vp.bottom > innerHeight) $('vpConfig').scrollIntoView({ block: 'center' }); return; }   // 手機上清單在場景下方：自動捲回場景
        if (this.scene.ok && this.scene.inside(ev.clientX, ev.clientY)) { const pt = this.scene.clientToPlane(ev.clientX, ev.clientY); if (pt) this.place(type, pt); }
        else this.toast('放在場景外，已取消。');
      };
      const cancel = () => { root.removeEventListener('pointermove', mv); root.removeEventListener('pointerup', upf); root.removeEventListener('pointercancel', cancel); if (ghost) ghost.remove(); };
      root.addEventListener('pointermove', mv); root.addEventListener('pointerup', upf); root.addEventListener('pointercancel', cancel);
    }
    renderHint() {
      const h = $('hintConfig'); if (!h) return;
      let t = '拖曳空白處旋轉 · 右鍵或雙指平移 · 滾輪／雙指縮放 · 點端子開始接線', act = false;
      if (this.ui.mode === 'placing') { t = `放置 ${DL.components[this.ui.placingType].name}：點選場景中的位置（Esc 取消）`; act = true; }
      else if (this.ui.wiringFrom) { t = `接線中：從 ${this.epName(this.ui.wiringFrom)} 出發，點另一個端子完成；點空白處或 Esc 取消`; act = true; }
      h.textContent = t; h.classList.toggle('act', act);
    }

    renderInspector() {
      const el = $('inspector'); const s = this.ui.selected; const p = this.p;
      if (!s) { el.innerHTML = '<p class="empty">點選場景中的元件、控制板或導線以查看與修改。快捷鍵：R 旋轉、Delete 移除、Esc 取消。</p>'; return; }
      if (s.kind === 'board') {
        const b = DL.boards[p.board.type];
        el.innerHTML = `<dl class="kv"><dt>板型</dt><dd>${esc(b.name)}</dd><dt>位置</dt><dd class="mono">x ${p.board.pos.x}, z ${p.board.pos.z}</dd><dt>方向</dt><dd>${p.board.rot}°</dd></dl><div class="row"><button class="btn" id="insRot">旋轉 90°</button></div><p class="hint">移動或旋轉控制板只改變擺放位置，不改變任何連線。</p>`;
        $('insRot').onclick = () => this.rotateSelected(); return;
      }
      if (s.kind === 'wire') {
        const w = p.connections.find(w => w.id === s.id); if (!w) { this.ui.selected = null; return this.renderInspector(); }
        el.innerHTML = `<dl class="kv"><dt>連線</dt><dd class="mono">${w.id}</dd><dt>端點 A</dt><dd>${esc(this.epName(w.a))}</dd><dt>端點 B</dt><dd>${esc(this.epName(w.b))}</dd></dl>
          <div class="field"><span>導線顏色（只是外觀，功能以端點為準）</span><div class="swatches">${DL.project.WIRE_COLORS.map(c => `<button style="background:${c}" data-c="${c}" aria-label="顏色 ${c}" aria-pressed="${c === w.color}"></button>`).join('')}</div></div>
          <div class="row"><button class="btn danger" id="insDel">移除連線</button></div>`;
        el.querySelectorAll('.swatches button').forEach(b => b.onclick = () => { DL.project.setWireColor(p, w.id, b.dataset.c); this.scene.build(p, this.analysis); this.renderInspector(); this.renderWires(); this.renderHeader(); });
        $('insDel').onclick = () => this.removeSelected(); return;
      }
      const c = DL.project.findComp(p, s.id); if (!c) { this.ui.selected = null; return this.renderInspector(); }
      const def = DL.components[c.type]; const bnd = this.analysis.bindings[c.id];
      const params = Object.entries(def.params).map(([k, sp]) => sp.type === 'select'
        ? `<label class="field"><span>${sp.label}</span><select class="inp" data-k="${k}" id="par-${c.id}-${k}">${Object.entries(sp.options).map(([v, l]) => `<option value="${v}" ${c.params[k] === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`
        : `<label class="field"><span>${sp.label}</span><input class="inp mono" type="number" data-k="${k}" id="par-${c.id}-${k}" value="${c.params[k]}" min="${sp.min}" max="${sp.max}">${sp.hint ? `<small class="muted">${sp.hint}</small>` : ''}</label>`).join('');
      if (def.holder) {
        const riders = p.components.filter(x => { const m = DL.breadboard.mountOf(p, x.id); return m && m.bb === c.id; }).map(x => x.id);
        const nw = p.connections.filter(w => w.kind !== 'insert' && (w.a.comp === c.id || w.b.comp === c.id)).length;
        el.innerHTML = `<dl class="kv"><dt>識別碼</dt><dd class="mono">${c.id}</dd><dt>型號</dt><dd>${esc(c.model)}</dd><dt>插在上面</dt><dd>${riders.length ? esc(riders.join('、')) : '<span class="muted">還沒有元件</span>'}</dd><dt>導線</dt><dd>${nw} 條</dd></dl>${(def.notes || []).map(n => `<p class="hint">${esc(n)}</p>`).join('')}
          <div class="row"><button class="btn" id="insRot">旋轉 90°</button><button class="btn danger" id="insDel" ${p.lock.components ? 'disabled' : ''}>移除</button></div>`;
        $('insRot').onclick = () => this.rotateSelected(); $('insDel').onclick = () => this.removeSelected(); return;
      }
      const prefHtml = this.prefPinHtml ? this.prefPinHtml(c) : '';
      const mnt = DL.breadboard.mountOf(p, c.id);
      const mntHtml = mnt ? `<dt>麵包板</dt><dd>插在 ${esc(mnt.bb)}：${esc(mnt.holes.map(h => `${h.term}→${DL.breadboard.holeLabel(h.hole)}`).join('、'))}</dd>` : '';
      el.innerHTML = `<dl class="kv"><dt>識別碼</dt><dd class="mono">${c.id}</dd><dt>型號</dt><dd>${esc(c.model)}</dd>${mntHtml}<dt>腳位綁定</dt><dd>${bnd ? (bnd.role === 'ultrasonic' ? esc(`TRIG ${DL.boards[p.board.type].pinLabel(DL.boards[p.board.type].pinById[bnd.trig])}、ECHO ${DL.boards[p.board.type].pinLabel(DL.boards[p.board.type].pinById[bnd.echo])}（VCC ${bnd.vcc} V）`) : esc(DL.boards[p.board.type].pinLabel(DL.boards[p.board.type].pinById[bnd.pin]))) + (bnd.mA ? ` · 約 ${bnd.mA} mA` : '') : '<span class="muted">尚未形成有效綁定</span>'}</dd><dt>端子</dt><dd>${def.terminals.map(t => esc(t.label)).join('、')}</dd></dl>
        ${params}${prefHtml}${(def.notes || []).map(n => `<p class="hint">${esc(n)}</p>`).join('')}
        <div class="row"><button class="btn" id="insRot">旋轉 90°</button>${mnt ? '<button class="btn" id="insUnmount">從麵包板拔出</button>' : ''}<button class="btn danger" id="insDel" ${p.lock.components ? 'disabled' : ''}>移除</button></div>`;
      if (mnt) $('insUnmount').onclick = () => this.unmount(c.id);
      if (this.bindPrefPin) this.bindPrefPin(c);
      el.querySelectorAll('[data-k]').forEach(inp => inp.onchange = () => { const r = DL.project.setParam(p, c.id, inp.dataset.k, inp.value); if (!r.ok) { this.toast(r.msg, 'e'); inp.value = c.params[inp.dataset.k]; return; } this.changed('circuit', '已更新參數'); });
      $('insRot').onclick = () => this.rotateSelected();
      $('insDel').onclick = () => this.removeSelected();
    }
    rotateSelected() {
      const s = this.ui.selected; if (!s) return; DL.project.rotateComponent(this.p, s.kind === 'board' ? 'board' : s.id, 90);
      const st = s.kind === 'comp' ? DL.breadboard.settle(this.p, s.id) : { changed: false };
      if (st.changed) this.changed('circuit', st.warn ? null : st.msg); else { this.scene.build(this.p, this.analysis); this.renderAll(); }
      if (st.warn) this.toast(st.msg, 'e');
    }
    removeSelected() {
      const s = this.ui.selected; if (!s) return;
      if (s.kind === 'wire') { DL.project.removeConnection(this.p, s.id); this.ui.selected = null; this.changed('circuit', `已移除 ${s.id}`); return; }
      if (s.kind === 'comp') { const r = DL.project.removeComponent(this.p, s.id); if (!r.ok) { this.toast(r.msg, 'e'); return; } this.ui.selected = null; this.changed('circuit', `已移除 ${s.id}${r.removedWires.length ? `與 ${r.removedWires.length} 條連線` : ''}`); }
    }
    renderIssues() {
      const a = this.analysis;
      $('issueCounts').innerHTML = ['error', 'unknown', 'warn'].filter(l => a.counts[l]).map(l => `<span class="lv ${l}">${a.counts[l]} ${LV[l]}</span>`).join('') || '<span class="lv ok">沒有錯誤</span>';
      const list = a.issues.filter(i => i.code !== 'pin_note' || i.level !== 'info');
      $('issueList').innerHTML = list.length ? list.map(i => `<li class="${i.level}"><span class="lv ${i.level}">${LV[i.level]}</span><span>${esc(i.msg)}</span></li>`).join('') : '<li><span class="lv info">說明</span><span>還沒有連線。點選板子腳位或元件端子開始接線。</span></li>';
    }
    renderWires() {
      const p = this.p; const s = this.ui.selected; const wires = p.connections.filter(w => w.kind !== 'insert');
      // 插在麵包板上的腳：每個元件一行
      const mounts = p.components.map(c => [c, DL.breadboard.mountOf(p, c.id)]).filter(x => x[1]);
      $('wireCount').textContent = wires.length + (mounts.length ? ` ＋ ${mounts.length} 個插件` : '');
      $('wireList').innerHTML = (mounts.map(([c, m]) => `<li class="ins" data-comp="${c.id}"><span class="sw" style="background:#f1efe8;border-color:#c9c5ba"></span><span class="mono">${c.id}</span><span>插在 ${m.bb}：${esc(m.holes.map(h => `${h.term}→${DL.breadboard.holeLabel(h.hole)}`).join('、'))}</span><button class="btn sm" data-unmount="${c.id}">拔出</button></li>`).join('')) + (wires.length ? wires.map(w => `<li data-id="${w.id}" class="${s && s.kind === 'wire' && s.id === w.id ? 'sel' : ''}"><span class="sw" style="background:${w.color}"></span><span class="mono">${w.id}</span><span>${esc(this.epName(w.a))} ↔ ${esc(this.epName(w.b))}</span><button class="btn sm" data-del="${w.id}" aria-label="移除 ${w.id}">移除</button></li>`).join('') : '<li class="muted" style="cursor:default;display:block">尚無導線</li>');
      $('wireList').querySelectorAll('[data-unmount]').forEach(b => b.onclick = e => { e.stopPropagation(); this.unmount(b.dataset.unmount); });
      $('wireList').querySelectorAll('li.ins').forEach(li => li.onclick = e => { if (e.target.dataset.unmount) return; this.ui.selected = { kind: 'comp', id: li.dataset.comp }; this.renderInspector(); this.renderWires(); });
      $('wireList').querySelectorAll('li[data-id]').forEach(li => li.onclick = e => { if (e.target.dataset.del) { DL.project.removeConnection(p, e.target.dataset.del); this.ui.selected = null; this.changed('circuit', `已移除 ${e.target.dataset.del}`); return; } this.ui.selected = { kind: 'wire', id: li.dataset.id }; this.renderInspector(); this.renderWires(); });
    }
    taskCtx() { return { armLoops: this.sim.armLoops || 0, confirmedCurrent: this.confirmState() === 'current', maxHoldMs: this.sim.maxHoldMs, minLight: this.sim.minLight, maxLight: this.sim.maxLight, minDist: this.sim.minDist, nearMin: this.sim.nearMin, nearMax: this.sim.nearMax, farAfterNear: this.sim.farAfterNear, serialCount: this.sim.serialCount || 0, presses: this.sim.presses, armConfirmed: !!(this.p.arm && this.armConfirmState() === 'current'), armSawInvalid: !!(this.arm && this.arm.sawInvalid) }; }
    renderTasks() {
      const p = this.p; const card = $('taskCard');
      const e = p.origin.kind === 'guided' && DL.experiments.forProject(p);
      if (!e) { card.hidden = true; return; }
      card.hidden = false;
      const ctx = this.taskCtx(); const done = e.tasks.map(t => !!t.check(p, this.analysis, ctx));
      $('taskGoal').textContent = e.goal;
      $('taskCount').textContent = `${done.filter(Boolean).length} / ${done.length}`;
      $('taskList').innerHTML = e.tasks.map((t, i) => `<li class="${done[i] ? 'done' : ''}">${esc(t.text)}</li>`).join('');
      const sg0 = e.custom ? e.suggest && e.suggest[p.board.type] : DL.experiments.suggestFor(e, p.board.type); const sg = sg0 && Object.keys(sg0).length ? sg0 : null; const bd = DL.boards[p.board.type];
      $('taskSuggest').textContent = sg ? (e.custom && e.custom.strictPins ? '指定腳位：' : '建議腳位：') + Object.entries(sg).map(([k, v]) => `${k.replace(/\.ECHO$/, ' ECHO')}${p.components.some(c => c.id === k && c.type === 'US') ? ' TRIG' : ''} → ${bd.pinById[v] ? bd.pinLabel(bd.pinById[v]) : v}`).join('、') + (e.custom && e.custom.strictPins ? '。' : '。其他相容腳位也可以。') : '';
    }

    /* =========================== 行為 =========================== */
    onBlocksChanged(res, saved) {
      if (this.p.lock.behavior) return;
      const before = DL.stableStringify(this.p.behavior.ir);
      this.p.behavior.ir = res.ir; this.p.behavior.blocks = saved; this.blockWarnings = res.warnings;
      if (before !== DL.stableStringify(res.ir)) this.changed('behavior'); else { this.renderBehavior(); this.renderHeader(); }
    }
    confirmState() {
      const c = this.p.behavior.confirmed; if (!c) return 'none';
      return c.inputs === DL.project.inputsHash(this.p, GEN()) ? 'current' : 'stale';
    }
    renderBehavior() {
      const p = this.p;
      const armSeq = !!(p.arm && !(p.behavior.ir.rules || []).length);   // 手臂專案：行為＝動作序列（不用積木）
      $('armSeqCard').hidden = !armSeq; $('blocklyHost').hidden = armSeq; $('blocklyHint').hidden = armSeq;
      if (armSeq && this.renderArmSeqBehavior) { this.renderArmSeqBehavior(); return; }
      const sum = DL.behavior.summarize(p); const v = DL.behavior.validate(p, this.analysis);
      $('summaryList').innerHTML = sum.lines.length ? sum.lines.map(l => `<li><span class="rn">規則 ${l.n}</span><span><span class="rk">${l.kind}</span>${esc(l.text)}</span></li>`).join('') : '<li><span class="rn">—</span><span class="muted">還沒有規則。從左側積木的「規則」分類拖一個出來。</span></li>';
      $('summaryInit').textContent = (sum.init.length ? '初始狀態：' + sum.init.join('、') + '。' : '') + ' ' + sum.notes.join(' ');
      const issues = v.issues.concat((this.blockWarnings || []).map(w => ({ level: 'warn', msg: w })));
      $('behaviorIssues').innerHTML = issues.map(i => `<li class="${i.level}"><span class="lv ${i.level}">${LV[i.level]}</span><span>${esc(i.msg)}</span></li>`).join('');
      const st = this.confirmState(); const box = $('confirmBox');
      box.className = 'confirmbox' + (st === 'current' ? ' ok' : st === 'stale' ? ' stale' : '');
      const blockers = v.issues.filter(i => i.level === 'error');
      box.innerHTML = st === 'current'
        ? `<span class="state" style="color:var(--ok)">已確認</span><span class="hint">確認時間 ${new Date(p.behavior.confirmed.at).toLocaleString()}；接線、元件參數或行為一改，就需要重新確認。</span><div class="row"><button class="btn" id="btnGoCode">前往「程式」產生程式</button></div>`
        : `<span class="state">${st === 'stale' ? '確認後內容已改變，需要重新確認' : '尚未確認'}</span><span class="hint">請讀過上面的摘要：這就是平台要產生的程式會做的事。確認後才能產生程式與授權真機寫入。</span><div class="row"><button class="btn primary" id="btnConfirm" ${blockers.length || !p.behavior.ir.rules.length ? 'disabled' : ''}>確認這份行為摘要</button>${blockers.length ? '<span class="hint">先修正上面的錯誤。</span>' : ''}</div>`;
      const bc = $('btnConfirm'); if (bc) bc.onclick = () => { p.behavior.confirmed = { inputs: DL.project.inputsHash(p, GEN()), at: new Date().toISOString() }; this.log('s', '行為摘要已確認'); this.renderAll(); };
      const bg = $('btnGoCode'); if (bg) bg.onclick = () => this.setTab('code');
    }

    /* =========================== 程式、比對、編譯 =========================== */
    codeState() {
      const c = this.p.code; if (!c || !c.text) return { state: 'none' };
      const now = DL.project.inputsHash(this.p, GEN());
      if (c.origin === 'manual' || DL.hash(c.text) !== c.generatedHash) return { state: 'manual', baseStale: c.basedOnInputs !== now };
      return { state: c.basedOnInputs === now ? 'current' : 'stale' };
    }
    buildState() {
      const b = (this.p.builds || [])[0]; if (!b) return { state: 'none' };
      const valid = b.codeHash === DL.hash(this.p.code.text || '') && b.board === this.p.board.type;
      if (!valid) return { state: 'stale', b };
      return { state: b.ok ? 'ok' : 'fail', b };
    }
    generate(force) {
      const p = this.p; const cs = this.codeState();
      if (cs.state === 'manual' && !force) { this.inlineConfirm('code', '目前的程式有手動修改。重新產生會用積木與接線的結果覆蓋它（手動修改無法自動轉回積木）。', '覆蓋並重新產生', () => this.generate(true)); return; }
      const g = DL.codegen.generate(p);
      if (!g.ok) { this.toast(g.blockers[0], 'e'); this.renderCodeBlockers(g.blockers); return; }
      p.code = { text: g.code, origin: 'generated', basedOnInputs: g.inputs, generatorVersion: g.generatorVersion, generatedHash: DL.hash(g.code), libs: g.libs, at: g.at };
      $('code').value = g.code; this.log('s', `已產生 ${DL.boards[p.board.type].lang === 'python' ? 'Python' : 'Arduino C++'} 程式（輸入雜湊 ${g.inputs.slice(0, 8)}）`);
      this.changed('code'); this.renderCode();
    }
    renderCodeBlockers(list) { $('scanList').innerHTML = list.map(m => `<li class="error"><span class="lv error">無法產生</span><span>${esc(m)}</span></li>`).join(''); }
    onCodeEdit() {
      const p = this.p; const t = $('code').value;
      if (!p.code || !p.code.text && !t) return;
      p.code = Object.assign({}, p.code, { text: t, origin: DL.hash(t) === p.code.generatedHash ? 'generated' : 'manual' });
      this.updateGutter(); clearTimeout(this._ce); this._ce = setTimeout(() => { this.renderCodeSide(); this.renderTabs(); this.renderHeader(); }, 250);
    }
    updateGutter(bad) {
      const n = $('code').value.split('\n').length; const set = new Set((bad || this._badLines || []));
      let s = ''; for (let i = 1; i <= n; i++) s += (set.has(i) ? '<span class="bad">' + i + '</span>' : i) + '\n';
      $('gutter').innerHTML = s;
    }
    renderCode() {
      const p = this.p; const b = DL.boards[p.board.type];
      if ($('code').value !== (p.code.text || '')) $('code').value = p.code.text || '';
      $('code').placeholder = '還沒有程式。完成配置並確認行為摘要後，按「產生程式」。';
      $('langInfo').textContent = `${b.lang === 'python' ? 'Python 3 · gpiozero' : 'Arduino C++'} · ${b.fqbn || 'python3'} · ${GEN()}`;
      this.renderCodeSide();
    }
    renderCodeSide() {
      const p = this.p; const cs = this.codeState(); const bs = this.buildState();
      const cb = $('codeBadge');
      const map = { none: ['unk', '尚未產生'], current: ['ok', '與目前配置與行為一致'], stale: ['warn', '過期：配置或行為已改變'], manual: ['warn', cs.baseStale ? '手動修改（而且產生時的配置已過期）' : '手動修改：積木不會反向同步'] };
      cb.className = 'badge ' + map[cs.state][0]; cb.textContent = map[cs.state][1];
      const bb = $('buildBadge');
      const bmap = { none: ['unk', '尚未編譯'], ok: ['ok', '編譯成功'], fail: ['err', '編譯失敗'], stale: ['warn', '編譯結果已過期'] };
      bb.className = 'badge ' + bmap[bs.state][0]; bb.textContent = bmap[bs.state][1];
      // 一致性比對
      if (!p.code.text) { $('scanList').innerHTML = '<li><span class="lv note">範圍</span><span>產生或貼上程式後，會在這裡比對程式中的腳位與接線。</span></li>'; }
      else {
        const items = DL.codegen.scanPins(p, p.code.text);
        $('scanList').innerHTML = items.map((it, i) => `<li class="${it.level === 'mismatch' ? 'error' : it.level === 'ok' ? 'info' : it.level}"><span class="lv ${it.level}">${LV[it.level]}</span><span>${esc(it.msg)}${it.level === 'mismatch' ? `<span class="row" style="margin-top:6px"><button class="btn sm" data-sync="${i}">同步虛擬接線到 ${esc(DL.boards[p.board.type].pinLabel(DL.boards[p.board.type].pinById[it.codePin]))}</button></span>` : ''}</span></li>`).join('');
        $('scanList').querySelectorAll('[data-sync]').forEach(btn => btn.onclick = () => this.syncWiring(items[+btn.dataset.sync]));
      }
      // 編譯結果
      const body = $('buildBody'); const last = (p.builds || [])[0];
      if (!last) body.innerHTML = '<p class="empty">尚未編譯。編譯會呼叫正式工具鏈；沒有連上編譯服務時，不會顯示任何成功標章。</p>';
      else {
        const diag = last.diagnostics || [];
        this._badLines = bs.state === 'stale' ? [] : diag.filter(d => d.line && d.severity === 'error').map(d => d.line);
        body.innerHTML = `<div class="row"><span class="badge ${bmap[bs.state][0]}">${bmap[bs.state][1]}</span><span class="muted" style="font-size:.78rem">${new Date(last.at).toLocaleString()} · ${esc(last.toolchain ? last.toolchain.name + ' ' + (last.toolchain.version || '') : '')}${last.size ? ` · ${last.size.bytes} bytes（${last.size.percent}%）` : ''}</span></div>
          ${bs.state === 'stale' ? '<p class="hint">程式或板型在編譯後改變了，這個結果不再代表目前的程式。</p>' : ''}
          ${diag.length ? `<ul class="diag">${diag.map(d => `<li data-line="${d.line || ''}"><span class="lv ${d.severity === 'error' ? 'error' : 'warn'}">${d.line ? '第 ' + d.line + ' 行' : '—'}</span><span>${esc(d.message)}</span></li>`).join('')}</ul>` : ''}
          <details ${last.ok ? '' : 'open'}><summary class="hint">原始輸出</summary><pre class="raw">${esc(last.raw || '')}</pre></details>
          ${p.builds.length > 1 ? `<div class="builds muted">${p.builds.slice(1, 5).map(b => `<span>${new Date(b.at).toLocaleTimeString()} · ${b.ok ? '成功' : '失敗'} · ${b.board}</span>`).join('')}</div>` : ''}`;
        body.querySelectorAll('.diag li[data-line]').forEach(li => li.onclick = () => this.gotoLine(+li.dataset.line));
      }
      this.updateGutter();
      if (this.renderUpload) this.renderUpload();
    }
    gotoLine(n) {
      if (!n) return; const ta = $('code'); const lines = ta.value.split('\n'); let pos = 0; for (let i = 0; i < n - 1; i++) pos += lines[i].length + 1;
      ta.focus(); ta.setSelectionRange(pos, pos + (lines[n - 1] || '').length); ta.scrollTop = Math.max(0, (n - 5) * 20.5);
    }
    syncWiring(item) {
      const p = this.p; const b = DL.boards[p.board.type];
      const r = DL.netlist.tryRewire(p, item.comp, item.codePin, item.part);
      if (!r.ok) { this.toast(r.msg, 'e'); return; }
      this.inlineConfirm('code', `把畫面中 ${item.comp} 的板端虛擬接線從 ${b.pinLabel(b.pinById[r.from])} 改到 ${b.pinLabel(b.pinById[r.to])}。實體導線不會因此移動；若已接真機，請自己改接並重新核對。`, '同步虛擬接線', () => {
        DL.project.rewireBoardEnd(p, r.wire, r.to);
        this.changed('circuit', `${item.comp} 的虛擬接線已改到 ${b.pinLabel(b.pinById[r.to])}`);
        this.log('w', `同步虛擬接線：${item.comp} ${r.from} → ${r.to}（實體導線未移動）`);
        this.renderCode();
      });
    }
    defaultCompileUrl() { try { const s = localStorage.getItem('doflab.compileUrl'); if (s) return s; } catch (e) { } if (/^https?:$/.test(location.protocol) && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(location.host)) return location.origin; return 'http://localhost:8766'; }
    async compile() {
      const p = this.p; const code = p.code.text || $('code').value;
      if (!code.trim()) { this.toast('沒有程式可以編譯。', 'e'); return; }
      const url = $('compileUrl').value.trim().replace(/\/$/, ''); try { localStorage.setItem('doflab.compileUrl', url); } catch (e) { }
      const btn = $('btnCompile'); btn.disabled = true; btn.textContent = '編譯中…';
      const codeHash = DL.hash(code); const board = p.board.type;
      let res;
      try {
        const r = await fetch(url + '/api/compile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ board, code }) });
        res = await r.json();
      } catch (e) {
        btn.disabled = false; btn.textContent = '編譯';
        const msg = `連不到編譯服務 ${url}：${e.message}。請在你的電腦執行 doflab_server.py；若你在 Claude 的預覽中開啟本頁，預覽不允許連到外部服務，請改用下載版。沒有編譯結果，不顯示成功。`;
        $('buildBody').innerHTML = `<ul class="issues"><li class="error"><span class="lv error">未編譯</span><span>${esc(msg)}</span></li></ul>`;
        this.log('e', msg); return;
      }
      btn.disabled = false; btn.textContent = '編譯';
      const rec = { at: new Date().toISOString(), board, ok: !!res.ok, codeHash, inputs: DL.project.inputsHash(p, GEN()), toolchain: res.toolchain, diagnostics: res.diagnostics || [], raw: String(res.raw || '').slice(0, 20000), size: res.size || null, exitCode: res.exitCode };
      p.builds = [rec].concat(p.builds || []).slice(0, 10);
      this.lastArtifacts = res.ok && res.artifacts ? { codeHash, board, artifacts: res.artifacts } : null;   // 上傳用的檔案只留在記憶體，不存進專案
      this.log(rec.ok ? 's' : 'e', `編譯${rec.ok ? '成功' : '失敗'}（${res.toolchain ? res.toolchain.name : '?'}，結束碼 ${res.exitCode}）`);
      this.changed('code'); this.renderCode();
    }

    /* =========================== 保存、版本、匯入 =========================== */
    save() {
      const p = this.p; const st = storeGet();
      if (st.unavailable) { this.toast('這個瀏覽器不允許本機保存（私密視窗或已封鎖網站資料）。請到「專案與版本」匯出 JSON。', 'e'); return; }
      p.revision += 1; p.updatedAt = new Date().toISOString();
      const json = DL.project.serialize(p);
      const rec = st.projects[p.id] || { name: p.name, board: p.board.type, revisions: [] };
      rec.name = p.name; rec.board = p.board.type; rec.revisions.push({ rev: p.revision, at: p.updatedAt, json });
      if (rec.revisions.length > 20) rec.revisions = rec.revisions.slice(-20);
      st.projects[p.id] = rec; st.last = p.id;
      if (!storeSet(st)) { p.revision -= 1; this.toast('保存失敗：瀏覽器儲存空間已滿或被封鎖。請匯出 JSON。', 'e'); return; }
      this.saved = this.contentKey(p);
      this.log('s', `已保存 r${p.revision}`); this.toast(`已保存 r${p.revision}`); this.renderHeader();
    }
    openProject() {
      const st = storeGet(); const p = this.p; const rec = st.projects[p.id];
      $('revList').innerHTML = rec ? rec.revisions.slice().reverse().map(r => `<li><span class="mono">r${r.rev}</span><span>${new Date(r.at).toLocaleString()}</span><button class="btn sm" data-rev="${r.rev}">開啟此版本</button></li>`).join('') : '<li><span class="muted">這個專案還沒有保存過。</span></li>';
      $('revList').querySelectorAll('[data-rev]').forEach(b => b.onclick = () => { const r = rec.revisions.find(x => x.rev === +b.dataset.rev); const res = DL.project.deserialize(r.json); if (!res.ok) { $('importMsg').textContent = res.msg; return; } $('dlgProject').close(); this.load(res.project, { saved: rec.revisions[rec.revisions.length - 1].json, note: `已開啟 r${r.rev}（舊版本）。再次保存會成為新的版本，不會覆蓋舊紀錄。` }); this.saved = null; this.renderHeader(); });
      const others = Object.entries(st.projects).filter(([id]) => id !== p.id);
      $('projList').innerHTML = others.length ? others.map(([id, r]) => `<li><span class="mono">r${r.revisions[r.revisions.length - 1].rev}</span><span>${esc(r.name)} · ${esc(DL.boards[r.board] ? DL.boards[r.board].short : r.board)}</span><button class="btn sm" data-pid="${id}">開啟</button></li>`).join('') : '<li><span class="muted">沒有其他已保存的專案。</span></li>';
      $('projList').querySelectorAll('[data-pid]').forEach(b => b.onclick = () => { const r = st.projects[b.dataset.pid]; const last = r.revisions[r.revisions.length - 1]; const res = DL.project.deserialize(last.json); if (!res.ok) { $('importMsg').textContent = res.msg; return; } $('dlgProject').close(); st.last = b.dataset.pid; storeSet(st); this.load(res.project, { saved: last.json, note: `已開啟「${res.project.name}」r${res.project.revision}。` }); });
      $('jsonBox').value = ''; $('importMsg').textContent = '匯入失敗時，文字框內容會原樣保留，不會被修改或丟棄。「下載」在 Claude 預覽中可能無效，請改用複製。';
      this.setDownload();
      $('dlgProject').showModal();
    }
    setDownload() { if (!$('dlJson')) return; try { const blob = new Blob([DL.project.serialize(this.p)], { type: 'application/json' }); const a = $('dlJson'); if (a._u) URL.revokeObjectURL(a._u); a._u = URL.createObjectURL(blob); a.href = a._u; a.download = (this.p.name || 'doflab').replace(/[\\/:*?"<>|]/g, '_') + '.json'; } catch (e) { } }
    importJson(text) {
      const res = DL.project.deserialize(text);
      if (!res.ok) { $('importMsg').innerHTML = `<span style="color:var(--err)">${esc(res.msg)}</span>`; this.log('e', '匯入失敗：' + res.msg); return res; }
      $('dlgProject').close();
      this.load(res.project, { note: '已匯入專案（尚未保存到這個瀏覽器）。' + res.notes.join(' ') });
      return res;
    }

    /* =========================== 開始對話框、引導實驗 =========================== */
    openStart() {
      $('expList').innerHTML = DL.experiments.list.map(e => `<div class="exp"><h4>${esc(e.title)}</h4><p>${esc(e.goal)}</p><div class="row">${DL.boardList.map(b => DL.experiments.supports(e, b) ? `<button class="btn sm" data-exp="${e.id}" data-board="${b}">${DL.boards[b].short}</button>` : `<button class="btn sm" disabled title="${esc((e.unsupported || {})[b] || '不支援')}">${DL.boards[b].short}</button>`).join('')}</div>${[...new Set(Object.values(e.unsupported || {}))].map(u => `<p>${esc(u)}</p>`).join('')}</div>`).join('');
      $('expList').querySelectorAll('[data-exp]').forEach(b => b.onclick = () => { const r = DL.experiments.instantiate(b.dataset.exp, b.dataset.board); if (!r.ok) { this.toast(r.msg, 'e'); return; } $('dlgStart').close(); this.load(r.project, { note: '依右側「引導任務」完成接線，再到「行為」確認、到「觀測」模擬。' }); this.setTab('config'); });
      if (this.renderMyExps) this.renderMyExps();
      $('newList').innerHTML = DL.boardList.map(b => `<button class="btn" data-new="${b}">新專案 · ${DL.boards[b].name}</button>`).join('');
      $('newList').querySelectorAll('[data-new]').forEach(b => b.onclick = () => { const p = DL.project.create(b.dataset.new, { name: `我的專案（${DL.boards[b.dataset.new].short}）` }); $('dlgStart').close(); this.load(p, { note: '從左側把元件拖到場景，點端子接線；完成後到「行為」用積木說明它要做什麼。' }); this.setTab('config'); });
      $('dlgStart').showModal();
    }
    copyGuided() {
      const p = this.p;
      const q = DL.project.clone(p, { name: p.name.replace(/^引導：/, '') + '（自訂）', origin: { kind: 'custom', copiedFrom: { experimentId: p.origin.experimentId, projectId: p.id } }, lock: { components: false, behavior: false, board: false } });
      q.behavior.confirmed = null;
      this.load(q, { note: '已複製為自訂專案；原引導實驗不受影響。現在可以自由修改元件與行為。' });
    }
    openAbout() { $('aboutBody').innerHTML = DL.ui.aboutTable(); $('dlgAbout').showModal(); }

    log(kind, text, simT) { this.events.unshift({ kind, text, t: Date.now(), simT: simT === undefined ? null : simT }); if (this.events.length > 300) this.events.pop(); this._evDirty = true; }
  }

  DL.ui = DL.ui || {}; DL.ui.App = App; DL.ui.esc = esc; DL.ui.LV = LV;
})(typeof globalThis !== 'undefined' ? globalThis : this);
