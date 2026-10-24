/* DofLab — 觀測分頁：模擬執行、Twin 狀態、波形、事件與真機連線 */
(function (root) {
  const DL = root.DL; const App = DL.ui.App; const esc = DL.ui.esc;
  const $ = id => document.getElementById(id);
  const P = App.prototype;

  const sigOf = c => ({ BTN: c.id + '.pressed', BOOT: c.id + '.pressed', TOUCH: c.id + '.pressed', LDR: c.id + '.level', LED: c.id + '.state', OBLED: c.id + '.state', SERVO: c.id + '.angle', US: c.id + '.distance' }[c.type]);
  const INPUTS = ['BTN', 'BOOT', 'TOUCH', 'LDR', 'US'];
  const isBtn = c => ['BTN', 'BOOT', 'TOUCH'].includes(c.type), isLed = c => ['LED', 'OBLED'].includes(c.type);
  const US_FAR = 400;   // 沒有回波／超出量程
  const fmt = (c, v) => {
    if (v === null || v === undefined) return '—';
    if (c.type === 'TOUCH') return v ? '碰到' : '放開';
    if (isBtn(c)) return v ? '按下' : '放開';
    if (isLed(c)) return v ? '亮' : '滅';
    if (c.type === 'SERVO') return Math.round(v) + '°';
    if (c.type === 'LDR') return Math.round(v) + ' %';
    if (c.type === 'US') return v >= US_FAR ? '沒有回波（≥ 400 cm）' : Math.round(v) + ' cm';
    return String(v);
  };

  P.bindObserve = function () {
    $('simRun').onclick = () => this.toggleRun();
    $('simStep').onclick = () => { if (this.sim.running) this.toggleRun(); this.advance(10); this.renderObserve(); };
    $('simReset').onclick = () => { this.resetSim(); this.log('w', '模擬已重置到 t = 0'); this.renderObserve(); };
    $('simSpeed').onchange = e => { this.sim.speed = +e.target.value; };
    $('clearEvents').onclick = () => { this.events = []; this._evDirty = true; };
  };

  P.defineSignals = function () {
    for (const c of this.p.components) {
      const s = sigOf(c); if (!s) continue;
      this.twin.define(s, { kind: INPUTS.includes(c.type) ? 'input' : 'output', comp: c.id, ctype: c.type, feedback: INPUTS.includes(c.type), periodic: c.type === 'LDR' || c.type === 'US' });   // 光敏、超音波每 50／60 ms 回報一次：停了就是卡住
    }
  };
  P.resetSim = function () {
    this.sim.running = false; this.sim.time = 0; this.sim.acc = 0; this.sim.last = null; this.sim.serial = []; this._serialDirty = true;
    this.sim.engine = DL.createEngine(this.p);
    this.sim.light = this.sim.light || {};
    for (const c of this.p.components) if (c.type === 'LDR' && this.sim.light[c.id] === undefined) this.sim.light[c.id] = 60;
    this.sim.dist = this.sim.dist || {};
    for (const c of this.p.components) if (c.type === 'US' && this.sim.dist[c.id] === undefined) this.sim.dist[c.id] = 100;
    this.defineSignals();
    const out = this.sim.engine.snapshot().out;
    const armIds = this.armServoIds ? this.armServoIds() : [];
    for (const c of this.p.components) { const s = sigOf(c); if (!s || armIds.includes(c.id)) continue; if (isBtn(c)) this.twin.simulate(s, !!this.sim.held[c.id]); else if (c.type === 'LDR') this.twin.simulate(s, this.sim.light[c.id]); else if (c.type === 'US') this.twin.simulate(s, this.sim.dist[c.id]); else this.twin.simulate(s, out[c.id]); }
    if (this.armReset) this.armReset();
    if (this.ui && $('simRun')) { $('simRun').textContent = '▶ 執行'; $('simRun').classList.add('primary'); }
  };
  P.toggleRun = function () {
    const v = DL.behavior.validate(this.p, null);
    if (!this.sim.running && v.issues.some(i => i.level === 'error')) { this.toast('行為有錯誤，無法執行：' + v.issues.find(i => i.level === 'error').msg, 'e'); return; }
    this.sim.running = !this.sim.running; this.sim.last = null;
    if (this.sim.running && this.p.arm && this.armOnRun) this.armOnRun();
    $('simRun').textContent = this.sim.running ? '❚❚ 暫停' : '▶ 執行'; $('simRun').classList.toggle('primary', !this.sim.running);
    this.log(this.sim.running ? 's' : 'w', this.sim.running ? `${this.twin.mode === 'hw-control' ? '開始以行為控制真機' : this.twin.mode === 'hw-read' ? '開始執行（唯讀：只推算，不送命令）' : '開始模擬'}` : '已暫停', this.sim.time);
    this.renderTabs();
  };
  P.setHeld = function (id, down) {
    const was = !!this.sim.held[id]; this.sim.held[id] = down;
    if (down && !was) { this.sim.holdStart[id] = this.sim.running ? this.sim.time : null; this.sim.presses++; }
    if (!down) delete this.sim.holdStart[id];
    const b = document.querySelector(`[data-hold="${id}"]`); if (b) b.setAttribute('aria-pressed', String(down));
    if (!this.sim.running && down) this.toast('模擬尚未執行：按鈕已按下，但規則不會動作。先按「▶ 執行」。');
    this.renderTasks();
  };

  // 前進 ms 毫秒的模擬時間（1 ms 步進，與產生的程式等價測試一致）
  P.advance = function (ms) {
    const e = this.sim.engine; const mode = this.twin.mode; const p = this.p;
    const bnd = this.analysis.bindings; const board = DL.boards[p.board.type]; const armIds = this.armServoIds ? this.armServoIds() : [];
    const armAuto = !!(p.arm && this.arm && this.arm.mode === 'auto' && this.armHasSeq());
    for (let i = 0; i < ms; i++) {
      this.sim.time++;
      const t = this.sim.time;
      if (armAuto) this.armSeqTick(t);   // 手臂行為序列（與產生的程式同一套規則）
      for (const c of p.components) {
        if (isBtn(c)) {
          if (mode === 'sim') e.setButton(c.id, !!this.sim.held[c.id]);
          else { const s = this.twin.view(c.id + '.pressed'); e.setButton(c.id, s.quality === 'ok' ? !!(s.measured && s.measured.v) : false); }
        } else if (c.type === 'LDR') {
          if (mode === 'sim') e.setLightPercent(c.id, this.sim.light[c.id]);
          else { const s = this.twin.view(c.id + '.level'); if (s.quality === 'ok' && s.measured) e.setAdcRaw(c.id, s.measured.raw !== undefined ? s.measured.raw : s.measured.v); }
        } else if (c.type === 'US') {
          if (mode === 'sim') e.setDistance(c.id, this.sim.dist[c.id]);
          else { const s = this.twin.view(c.id + '.distance'); e.setDistance(c.id, s.quality === 'ok' && s.measured ? s.measured.v : US_FAR); }   // 沒有有效量測：當成沒有物體（不推算）
        }
      }
      const r = e.tick(t);
      for (const ev of r.events) {
        if (ev.kind === 'serial') { this.serialLine(ev.text, t); continue; }
        this.log(ev.kind === 'output' ? '' : 's', ev.text, t);
      }
      for (const c of p.components) {
        const s = sigOf(c); if (!s || !(c.id in r.out) || armIds.includes(c.id)) continue;   // 手臂關節的伺服由手臂分頁控制
        const v = r.out[c.id];
        this.twin.simulate(s, v);
        if (mode === 'hw-control' && bnd[c.id]) {
          this.twin.target(s, v, 'behavior');
          const res = this.twin.command(s, v, 'behavior');
          if (res.ok && res.cmd && this.hw.driver) this.hw.driver.write(res.cmd, { num: bnd[c.id].num, kind: c.type === 'SERVO' ? 'servo' : 'digital' });
          else if (!res.ok && !this._cmdWarned) { this._cmdWarned = true; this.log('e', res.msg, t); }
        }
      }
      for (const c of p.components) {
        if (isBtn(c) && mode === 'sim') this.twin.simulate(c.id + '.pressed', !!this.sim.held[c.id]);
        if (c.type === 'LDR' && mode === 'sim') this.twin.simulate(c.id + '.level', this.sim.light[c.id]);
        if (c.type === 'US' && mode === 'sim') this.twin.simulate(c.id + '.distance', this.sim.dist[c.id]);
      }
    }
    if (armAuto) this.armSeqSync();
    // 任務用的觀察紀錄
    for (const [id, t0] of Object.entries(this.sim.holdStart)) { if (t0 === null) this.sim.holdStart[id] = this.sim.time; else this.sim.maxHoldMs = Math.max(this.sim.maxHoldMs, this.sim.time - t0); }
    for (const c of p.components) if (c.type === 'LDR' && mode === 'sim') { this.sim.minLight = Math.min(this.sim.minLight, this.sim.light[c.id]); this.sim.maxLight = Math.max(this.sim.maxLight, this.sim.light[c.id]); }
    for (const c of p.components) if (c.type === 'US') { const d = mode === 'sim' ? this.sim.dist[c.id] : (v => v.quality === 'ok' && v.measured ? v.measured.v : null)(this.twin.view(c.id + '.distance')); if (d !== null && d !== undefined) this.noteDistance(d); }
  };

  // 任務用的距離紀錄：最近距離、60 cm 內的最小與最大距離、靠近（< 15 cm）之後有沒有再離開
  P.noteDistance = function (d) {
    const s = this.sim; s.minDist = Math.min(s.minDist, d);
    if (d < 60) { s.nearMin = Math.min(s.nearMin, d); s.nearMax = Math.max(s.nearMax, d); }
    if (s.minDist < 15 && d >= 20) s.farAfterNear = true;
  };
  // 觀測頁的距離輸入：拉桿 2–200 cm，另有「移走物體」（沒有回波）
  P.setDistance = function (id, cm) {
    this.sim.dist[id] = cm; this.twin.simulate(id + '.distance', cm);
    const lab = $('usv-' + id); if (lab) lab.textContent = cm >= US_FAR ? '沒有物體' : cm + ' cm';
    const r = $('us-' + id); if (r && cm < US_FAR) r.value = cm;
    if (this.sim.running) this.noteDistance(cm);
  };

  // 序列埠監看（模擬）：產生的程式用 Serial.println 印出同樣的文字
  P.serialLine = function (text, t) {
    const s = this.sim; s.serial = s.serial || []; s.serial.push({ t, text }); if (s.serial.length > 200) s.serial.shift(); s.serialCount = (s.serialCount || 0) + 1;
    this.log('s', `序列埠：${text}`, t); this._serialDirty = true;
  };
  P.renderSerial = function () {
    const card = $('serialCard'); if (!card) return;
    const used = (this.p.behavior.ir.rules || []).some(r => (r.actions || []).some(a => a.type === 'print'));
    card.hidden = !used; if (!used) return;
    const el = $('serialLog'); const lines = (this.sim.serial || []).slice(-60);
    el.textContent = lines.length ? lines.map(l => `[${(l.t / 1000).toFixed(3)}] ${l.text}`).join('\n') : '（還沒有訊息：按「▶ 執行」開始模擬）';
    el.scrollTop = el.scrollHeight; this._serialDirty = false;
  };

  /* ---------- 每幀 ---------- */
  P.frame = function () {
    const now = performance.now();
    const dtFrame = this._lastFrame ? now - this._lastFrame : 16; this._lastFrame = now;
    if (this.armTick) this.armTick(dtFrame);
    if (this.sim.running) {
      if (this.sim.last === null) this.sim.last = now;
      this.sim.acc = (this.sim.acc || 0) + Math.min(1000, now - this.sim.last) * this.sim.speed; this.sim.last = now;   // 畫面很慢（軟體繪圖）時也跟上真實時間；分頁在背景太久才截斷
      const step = Math.floor(this.sim.acc); this.sim.acc -= step;
      if (step > 0) this.advance(step);
    }
    // 波形取樣（牆上時間軸，像示波器）
    if (!this._lastSample || now - this._lastSample > 30) { this._lastSample = now; this.sample(now); }
    if (this.scene.ok) { this.scene.setVis(this.visState()); this.scene.frame(); }
    if (this.ui.tab === 'observe') {
      this.drawTrace(now);
      if (!this._lastObs || now - this._lastObs > 120) { this._lastObs = now; this.renderTwin(); this.renderEventsIfDirty(); if (this._serialDirty) this.renderSerial(); $('simTime').textContent = `t = ${(this.sim.time / 1000).toFixed(3)} s`; this.renderHwLive(); }
    }
    if (!this._lastTask || now - this._lastTask > 500) { this._lastTask = now; if (this.p.origin.kind === 'guided') this.renderTasks(); }
    if (this.ui.tab === 'config' && (!this._lastHud || now - this._lastHud > 250)) { this._lastHud = now; this.renderHud(); }
    if (this.ui.tab === 'observe' && (!this._lastHudO || now - this._lastHudO > 150)) { this._lastHudO = now; this.renderHudObserve(); }
  };

  // 3D 畫面要顯示哪一層：模擬時顯示模擬；真機時輸入顯示量測，輸出顯示 ACK／命令，沒有回授就標示未知
  P.visState = function () {
    const vis = {}; const mode = this.twin.mode;
    const MEAS = this.twin.conn.virtual ? '虛擬量測' : '量測';   // 虛擬設備的量測一律標示
    for (const c of this.p.components) {
      const s = sigOf(c); if (!s) continue; const v = this.twin.view(s);
      if (mode === 'sim') {
        const val = v.simulated ? v.simulated.v : null;
        vis[c.id] = isBtn(c) ? { pressed: !!this.sim.held[c.id], tag: this.ui.tab === 'observe' ? { cls: 'sim', text: '模擬' } : null }
          : isLed(c) ? { on: !!val, tag: this.ui.tab === 'observe' ? { cls: 'sim', text: '模擬' } : null }
            : c.type === 'SERVO' ? { angle: val, tag: this.ui.tab === 'observe' ? { cls: 'sim', text: '模擬命令角度' } : null }
              : c.type === 'US' ? { dist: this.ui.tab === 'observe' ? this.sim.dist[c.id] : null, tag: this.ui.tab === 'observe' ? { cls: 'sim', text: `模擬 ${fmt(c, this.sim.dist[c.id])}` } : null }
              : { light: this.sim.light[c.id], tag: this.ui.tab === 'observe' ? { cls: 'sim', text: `模擬 ${this.sim.light[c.id]}%` } : null };
        continue;
      }
      if (c.type === 'US') { const q = v.quality; const m = v.measured; vis[c.id] = { dist: q === 'ok' && m ? m.v : null, tag: { cls: q === 'ok' ? 'meas' : q === 'stale' ? 'stale' : 'unk', text: q === 'ok' ? `${MEAS} ${fmt(c, m.v)}` : q === 'stale' ? '量測已過期' : '未知' } }; continue; }
      if (isBtn(c) || c.type === 'LDR') {
        const q = v.quality; const m = v.measured;
        vis[c.id] = isBtn(c) ? { pressed: q === 'ok' && m && m.v, tag: { cls: q === 'ok' ? 'meas' : q === 'stale' ? 'stale' : 'unk', text: q === 'ok' ? MEAS : q === 'stale' ? '量測已過期' : '未知' } }
          : { light: m ? m.v : 50, tag: { cls: q === 'ok' ? 'meas' : q === 'stale' ? 'stale' : 'unk', text: q === 'ok' ? `${MEAS} ${Math.round(m.v)}%` : '未知' } };
      } else {
        const cmd = v.commanded, a = v.ack && (!cmd || v.ack.id === cmd.id) ? v.ack : null; const has = mode === 'hw-control' && (v.ack || cmd);   /* 確認的是較早的命令時，顯示最新的命令（未確認） */
        const val = a ? a.v : cmd ? cmd.v : null;
        if (isLed(c)) vis[c.id] = has ? { on: !!val, dim: !a, tag: a ? { cls: 'ack', text: '已確認（非實測）' } : { cls: 'cmd', text: '命令未確認' } } : { on: null, unknown: true, tag: { cls: 'unk', text: '未知：無回授' } };
        else vis[c.id] = has ? { angle: val, tag: { cls: a ? 'ack' : 'cmd', text: `命令 ${Math.round(val)}°（非實測）` } } : { angle: null, tag: { cls: 'unk', text: '角度未知' } };
      }
    }
    // 板上 L 燈（Uno D13）：跟著接在 D13 的 LED 輸出
    // 板上的 LED（Uno 的 L 燈 D13、DevKit V1 的藍燈 GPIO2）：跟著接在那個腳位的 LED 輸出
    const ledPin = (DL.boards[this.p.board.type].onboard || {}).led;
    const l13 = ledPin && Object.values(this.analysis.bindings).find(b => b.pin === ledPin && b.role === 'led');
    vis.__board = { L: !!(l13 && vis[l13.comp] && vis[l13.comp].on) };
    return vis;
  };

  /* ---------- 觀測頁內容 ---------- */
  P.renderObserve = function () {
    if (!this.p) return;
    const p = this.p; const host = $('simInputs'); if (!host) return;
    const items = [];
    for (const c of p.components) {
      if (isBtn(c)) { const bd = DL.boards[p.board.type]; const lab = c.type === 'TOUCH' ? `碰住 ${bd.pinById[c.params.pin] ? bd.pinLabel(bd.pinById[c.params.pin]) : c.id}` : c.type === 'BOOT' ? '按住 BOOT' : `按住 ${c.id}`; items.push(`<div class="in"><span class="mono" style="font-weight:700">${c.id}</span><button class="btn hold" data-hold="${c.id}" aria-pressed="${!!this.sim.held[c.id]}" ${this.twin.mode !== 'sim' ? 'disabled' : ''}>${esc(lab)}</button></div>`); }
      if (c.type === 'US') { const d = this.sim.dist[c.id]; items.push(`<div class="in"><label class="mono" style="font-weight:700" for="us-${c.id}">${c.id} 前方物體 <span id="usv-${c.id}">${d >= US_FAR ? '沒有物體' : d + ' cm'}</span></label><input type="range" id="us-${c.id}" min="2" max="200" value="${Math.min(200, d)}" ${this.twin.mode !== 'sim' ? 'disabled' : ''}><div class="row"><button class="btn sm" data-usnear="${c.id}" ${this.twin.mode !== 'sim' ? 'disabled' : ''}>靠近（8 cm）</button><button class="btn sm" data-usfar="${c.id}" ${this.twin.mode !== 'sim' ? 'disabled' : ''}>移走物體（沒有回波）</button></div></div>`); }
      if (c.type === 'LDR') items.push(`<label class="in" for="ldr-${c.id}"><span class="mono" style="font-weight:700">${c.id} 亮度 <span id="ldrv-${c.id}">${this.sim.light[c.id]}</span> %</span><input type="range" id="ldr-${c.id}" min="0" max="100" value="${this.sim.light[c.id]}" ${this.twin.mode !== 'sim' ? 'disabled' : ''}></label>`);
    }
    host.innerHTML = items.join('') || '<p class="hint">這個專案沒有輸入元件。</p>';
    host.querySelectorAll('[data-hold]').forEach(b => {
      const id = b.dataset.hold;
      b.addEventListener('pointerdown', e => { e.preventDefault(); b.setPointerCapture(e.pointerId); this.setHeld(id, true); });
      const up = () => this.setHeld(id, false);
      b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('lostpointercapture', up);
      b.addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); this.setHeld(id, true); } });
      b.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); this.setHeld(id, false); } });
    });
    host.querySelectorAll('input[id^="us-"]').forEach(r => r.oninput = () => this.setDistance(r.id.slice(3), +r.value));
    host.querySelectorAll('[data-usnear]').forEach(b => b.onclick = () => this.setDistance(b.dataset.usnear, 8));
    host.querySelectorAll('[data-usfar]').forEach(b => b.onclick = () => this.setDistance(b.dataset.usfar, US_FAR));
    host.querySelectorAll('input[id^="ldr-"]').forEach(r => r.oninput = () => { const id = r.id.slice(4); this.sim.light[id] = +r.value; $('ldrv-' + id).textContent = r.value; this.twin.simulate(id + '.level', +r.value); if (this.sim.running) { this.sim.minLight = Math.min(this.sim.minLight, +r.value); this.sim.maxLight = Math.max(this.sim.maxLight, +r.value); } });
    const dev = this.twin.conn.virtual ? '虛擬設備' : '真機';
    $('simNote').textContent = this.twin.mode === 'sim' ? '' : this.twin.mode === 'hw-read' ? `唯讀：輸入來自${dev}量測，行為只推算、不送命令。` : `受控寫入：行為的輸出會送往${dev}。`;
    $('hintObserve').textContent = p.arm ? '手臂的姿態由「手臂」頁控制；這裡是同一隻手臂的命令姿態（SG90 沒有回授，不是實測）' : this.twin.mode === 'sim' && p.components.some(c => c.type === 'BOOT' || c.type === 'TOUCH') ? '模擬時，按住 3D 板子上的 BOOT 鍵，或按住觸控腳的排針（青色圓圈）' : this.twin.mode === 'sim' ? (p.components.some(c => c.type === 'US') ? '模擬時，用下方的拉桿移動超音波前方的物體（橘色板；畫面上的距離是壓縮過的示意，實際數值看標籤）' : '模擬時，按住場景中的按鈕即可按下') : this.twin.conn.virtual ? '虛擬設備模式：請在虛擬設備的工作台（另開的網頁）按按鈕；畫面顯示經網路量測到的狀態' : '真機模式：請操作實體按鈕或移動實體物體；畫面顯示量測到的狀態';
    this.renderTwin(); this.renderHw(); this.renderEventsIfDirty(true); this.renderSerial();
  };

  // 觀測頁主畫面右上角：每個元件目前的值（模擬或量測，依模式），點一下跳到右側的孿生狀態表
  P.renderHudObserve = function () {
    const el = $('hudObserve'); if (!el) return; const mode = this.twin.mode; const rows = [];
    for (const c of this.p.components) {
      const s = sigOf(c); if (!s) continue; const v = this.twin.view(s);
      const x = mode === 'sim' ? v.simulated : (INPUTS.includes(c.type) ? v.measured : ((v.commanded && (!v.ack || v.ack.id !== v.commanded.id) ? v.commanded : v.ack) || v.simulated));
      rows.push(`<span class="k">${esc(c.id)}</span><span class="v ${mode === 'sim' ? 'sim' : INPUTS.includes(c.type) ? 'meas' : 'cmd'}">${x ? fmt(c, x.v) : '—'}</span>`);
    }
    const head = `<button type="button" class="hc ${this.sim.running ? 'ok' : ''}" data-card="twinCard"><b>${this.sim.running ? '執行中' : '已暫停'}</b> · ${DL.modeLabel(mode, this.twin.conn.virtual)} · t = ${(this.sim.time / 1000).toFixed(1)} s</button>`;
    const html = head + (rows.length ? `<div class="vals" data-card="twinCard">${rows.slice(0, 12).join('')}</div>` : '');
    if (html !== this._hudOHtml) { this._hudOHtml = html; el.innerHTML = html; el.querySelectorAll('[data-card]').forEach(b => b.onclick = () => this.focusCard('twinCard')); }
  };
  P.renderTwin = function () {
    const rows = []; const mode = this.twin.mode; const now = Date.now();
    const th = $('thMeas'); if (th) th.textContent = mode !== 'sim' && this.twin.conn.virtual ? '量測（虛擬）' : '量測';
    const age = x => x ? `<small>${((now - x.t) / 1000).toFixed(1)} s 前${x.seq !== undefined ? ' · #' + x.seq : ''}</small>` : '';
    for (const c of this.p.components) {
      const s = sigOf(c); if (!s) continue; const v = this.twin.view(s); const isOut = ['LED', 'OBLED', 'SERVO'].includes(c.type);
      const sim = v.simulated ? `<span class="v sim">${fmt(c, v.simulated.v)}</span>${mode !== 'sim' && isOut ? '<small>推算</small>' : ''}` : '<span class="na">—</span>';
      const tgt = isOut ? (v.target ? `<span class="v">${fmt(c, v.target.v)}</span>` : '<span class="na">—</span>') : '<span class="na">不適用</span>';
      const cmd = isOut ? (v.commanded ? `<span class="v cmd">${fmt(c, v.commanded.v)}</span><small class="mono">${v.commanded.id}</small>` : '<span class="na">—</span>') : '<span class="na">不適用</span>';
      // 最新的命令還沒確認時，ACK 欄顯示它的狀態（不能讓上一個命令的回讀看起來像是現在的）
      const pend = this.twin.pending.filter(x => x.name === s).pop();
      const ack = !isOut ? '<span class="na">不適用</span>'
        : pend ? (Date.now() - pend.t > 1000 ? `<span class="q stale">逾時未確認</span><small>不自動重送${v.ack ? '；上一次確認：' + esc(fmt(c, v.ack.v)) : ''}</small>` : `<span class="na">等待中</span>${v.ack ? `<small>上一次確認：${esc(fmt(c, v.ack.v))}</small>` : ''}`)
        : v.ack ? `<span class="v ack">${fmt(c, v.ack.v)}</span><small>${v.ack.matches ? '回讀一致' : '回讀不一致'}</small>` : '<span class="na">—</span>';
      let meas;
      if (!v.feedback) meas = `<span class="q none">無回授</span><small>${c.type === 'SERVO' ? 'SG90 沒有角度回授' : 'LED 亮度沒有感測'}</small>`;
      else if (!v.measured) meas = `<span class="q unknown">${mode === 'sim' ? '未連線' : '尚無讀值'}</span>`;
      else if (c.type === 'US' && mode !== 'sim' && this.hw.sonarUnsupported) meas = `<span class="q unknown">不支援</span><small>需要 DofLabFirmata</small>`;
      else meas = `<span class="v meas">${fmt(c, v.measured.v)}</span> <span class="q ${v.quality}">${{ ok: '有效', stale: '已過期', unknown: '未知' }[v.quality]}</span>${age(v.measured)}`;
      const dot = s.indexOf('.');   // 訊號名分兩行（元件／訊號），讓最重要的「量測」欄在窄側欄裡也看得到
      rows.push(`<tr><td class="sig" title="${esc(s)}">${esc(s.slice(0, dot))}<small>${esc(s.slice(dot))}</small></td><td>${sim}</td><td>${tgt}</td><td>${cmd}</td><td>${ack}</td><td>${meas}</td></tr>`);
    }
    $('twinRows').innerHTML = rows.join('') || '<tr><td colspan="6" class="na">沒有訊號</td></tr>';
  };

  P.sample = function (now) {
    const row = { t: now };
    for (const c of this.p.components) {
      const s = sigOf(c); if (!s) continue; const v = this.twin.view(s);
      const norm = x => x === null || x === undefined ? null : c.type === 'SERVO' ? x / 180 : c.type === 'LDR' ? x / 100 : c.type === 'US' ? Math.min(1, x / 200) : x ? 1 : 0;
      row[c.id] = { sim: norm(v.simulated && v.simulated.v), meas: v.quality === 'ok' ? norm(v.measured && v.measured.v) : null, cmd: norm((v.ack || v.commanded || {}).v) };
    }
    this.trace.push(row); while (this.trace.length && now - this.trace[0].t > 6500) this.trace.shift();
  };
  P.drawTrace = function (now) {
    const cv = $('trace'); if (!cv || !cv.offsetParent) return;
    const dpr = Math.min(2, root.devicePixelRatio || 1); const W = cv.clientWidth, H = cv.clientHeight;
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const comps = this.p.components.filter(sigOf);
    if (!comps.length) return;
    const L = 64, R = 8, rowH = Math.min(46, (H - 18) / comps.length), span = 6000;
    const x = t => L + (W - L - R) * (1 - (now - t) / span);
    g.font = '600 11px "IBM Plex Mono", monospace'; g.textBaseline = 'middle';
    // 時間格線
    g.strokeStyle = css('--line'); g.lineWidth = 1; g.fillStyle = css('--muted');
    for (let s = 0; s <= 6; s++) { const xx = L + (W - L - R) * (s / 6); g.beginPath(); g.moveTo(xx, 4); g.lineTo(xx, H - 14); g.stroke(); g.fillText(`${s - 6}s`, xx - 9, H - 6); }
    comps.forEach((c, i) => {
      const y0 = 6 + i * rowH, y1 = y0 + rowH - 8;
      g.fillStyle = css('--ink'); g.fillText(c.id, 6, (y0 + y1) / 2);
      for (const [layer, color, w] of [['sim', css('--sim'), 2], ['cmd', css('--cmd'), 2], ['meas', css('--meas'), 2.5]]) {
        g.strokeStyle = color; g.lineWidth = w; g.beginPath(); let pen = false;
        for (const r of this.trace) { const v = r[c.id] && r[c.id][layer]; if (v === null || v === undefined) { pen = false; continue; } const yy = y1 - v * (y1 - y0); const xx = x(r.t); if (!pen) { g.moveTo(xx, yy); pen = true; } else g.lineTo(xx, yy); }
        g.stroke();
      }
    });
    g.fillStyle = css('--muted'); g.font = '500 10px "Noto Sans TC", sans-serif';
    const lg = [['模擬', css('--sim')], ['命令／ACK', css('--cmd')], ['量測', css('--meas')]]; let lx = W - R - 190;
    for (const [t, c] of lg) { g.fillStyle = c; g.fillRect(lx, H - 9, 10, 3); g.fillStyle = css('--muted'); g.fillText(t, lx + 14, H - 7); lx += 64; }
  };
  P.renderEventsIfDirty = function (force) {
    if (!this._evDirty && !force) return; this._evDirty = false;
    const el = $('eventList'); if (!el) return;
    el.innerHTML = this.events.slice(0, 120).map(e => `<li class="${e.kind}"><span class="t">${e.simT !== null ? (e.simT / 1000).toFixed(3) + ' s' : new Date(e.t).toLocaleTimeString()}</span><span>${e.virtual ? '<span class="ev-virt">虛擬</span>' : ''}${esc(e.text)}</span></li>`).join('') || '<li><span class="t"></span><span class="muted">尚無事件</span></li>';
  };

  P.onTwinEvent = function (e) {
    if (e.type === 'mode') { const vv = this.twin.conn.virtual; this.log('w', `模式：${DL.modeLabel(e.from, vv)} → ${DL.modeLabel(e.to, vv)}${e.why ? '（' + e.why + '）' : ''}`); this.renderHeader(); this.renderTabs(); if (this.ui.tab === 'observe') this.renderObserve(); }
    else if (e.type === 'connected') this.log('s', `已連線 ${e.info || e.deviceId}（第 ${e.session} 次連線${e.virtual ? '；虛擬設備，不是實體板子' : ''}）`);
    else if (e.type === 'disconnected') this.log('e', `連線中斷：${e.reason || ''}${e.dropped.length ? `；${e.dropped.length} 個未確認命令已作廢，不會重送` : ''}`);
    else if (e.type === 'authorized') this.log('s', `已授權受控寫入：${e.outputs.join('、')}`);
    else if (e.type === 'warn') this.log('w', e.msg);
    else if (e.type === 'measure') this.noteMeasure(e);
    else if (e.type === 'reboot') this.log('e', `設備重新開機（${e.reason}）：已撤銷寫入授權、回到唯讀${e.dropped.length ? `；${e.dropped.length} 個未確認命令作廢，不會重送` : ''}。開機前的量測已標為過期。`);
  };
  // 核對接線用：每一筆量測都比對上一筆（不靠畫面取樣，快速按放也不會漏掉）
  P.noteMeasure = function (e) {
    const id = e.name.split('.')[0]; const ls = this.hw.lastSeen || (this.hw.lastSeen = {});
    if (ls[id] !== undefined && ls[id] !== e.v) this.hw.sawChange[id] = true;
    ls[id] = e.v;
  };

  /* ---------- 真機連線 ---------- */
  P.hwRequirements = function () {
    const p = this.p; const a = this.analysis; const outs = Object.values(a.bindings).filter(b => b.role === 'led' || b.role === 'servo');
    const req = [
      { ok: !!(this.hw.identity && this.hw.identity.ok), text: '板卡辨識結果與專案板型相符' },
      { ok: a.ok, text: '配置檢查沒有錯誤' },
      (p.arm && !p.behavior.ir.rules.length) ? { ok: this.armConfirmState() === 'current', text: '手臂設定與伺服映射已確認且為最新' } : { ok: this.confirmState() === 'current', text: '行為摘要已確認且為最新' },
      { ok: Object.keys(a.bindings).every(id => this.hw.checks[id]), text: this.twin.conn.virtual ? '每個元件都已勾選「接線已核對」（虛擬設備：核對的是工作台的接線）' : '每個元件都已勾選「實體接線已核對」' },
      { ok: outs.length > 0, text: '至少有一個輸出元件（LED／伺服）' }
    ];
    if (Object.values(a.bindings).some(b => b.role === 'ultrasonic')) req.push({ ok: !!this.hw.identity && !this.hw.sonarUnsupported, text: '超音波可以讀取（Uno／ESP32 需要 DofLabFirmata）' });
    return { req, ok: req.every(r => r.ok), outs };
  };
  // 連線來源：USB 序列埠或虛擬設備（只有這個板型支援時）；連線中以實際連線的來源為準
  P.hwSource = function () {
    const srcs = DL.drivers.driverFor(this.p.board.type).sources;
    if (this.hw.driver && this.hw.connSrc) return this.hw.connSrc;
    return srcs.includes(this.hw.src) ? this.hw.src : srcs[0];
  };
  P.vdevUrl = function () { if (this.hw.vdevUrl) return this.hw.vdevUrl; try { const u = localStorage.getItem('doflab.vdevUrl'); if (u) return u; } catch (e) { } return DL.drivers.VDEV_URL; };
  const benchUrl = ws => { try { const u = new URL(ws); return `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}/`; } catch (e) { return null; } };
  P.renderHw = function () {
    const el = $('hwBody'); if (!el || !this.p) return;
    const p = this.p; const board = DL.boards[p.board.type]; const src = this.hwSource(); const info = DL.drivers.driverFor(p.board.type, src); const virt = src === 'virtual';
    $('drvStatus').textContent = info.tag || info.status.split('：')[0]; $('drvStatus').title = info.status; $('drvStatus').className = 'status-tag ' + (info.cls ? 'st-unver' : 'st-no');   // 標籤只放短句，完整說明在滑鼠提示與卡片內
    if (!info.cls) { el.innerHTML = `<p>${esc(info.status)}</p><p class="hint">缺少驅動時，平台會拒絕連線，而不是假裝同步。</p>`; return; }
    const c = this.twin.conn; const connected = c.state === 'connected'; const mode = this.twin.mode;
    const a = this.analysis; const R = this.hwRequirements();
    const urlDefault = (() => { try { const s = localStorage.getItem('doflab.wsUrl'); if (s) return s; } catch (e) { } return location.protocol === 'http:' && location.host && location.port !== '8766' ? `ws://${location.host}/ws` : 'ws://raspberrypi.local:8765/ws'; })();
    const step = (n, title, state, body) => `<li class="${state}"><span class="no">${n}</span><div><b>${title}</b>${body}</div></li>`;
    const srcSel = !connected && info.sources.length > 1 ? `<div class="row" role="radiogroup" aria-label="連線來源">${info.sources.map(k => `<label class="check"><input type="radio" name="hwSrc" value="${k}" ${k === src ? 'checked' : ''}><span>${k === 'virtual' ? '虛擬設備（網址）' : 'USB 序列埠（實體板子）'}</span></label>`).join('')}</div>` : '';
    const bu = virt ? benchUrl(connected && this.hw.vdevConnUrl ? this.hw.vdevConnUrl : this.vdevUrl()) : null;
    const s1 = connected ? `<span>${esc(info.label)} · ${esc(c.info || '')}</span>${virt ? `<span class="hint"><span class="ev-virt">虛擬</span>另一個程序模擬的 Uno，不是實體板子 · <span id="vdevNet">網路來回 ${this.hw.driver && this.hw.driver.transport && this.hw.driver.transport.rtt !== null ? this.hw.driver.transport.rtt + ' ms' : '量測中'}</span>${bu ? ` · <a href="${esc(bu)}" target="_blank" rel="noopener">開啟工作台</a>` : ''}</span>` : ''}<div class="row"><button class="btn danger" id="hwDisc">中斷連線</button></div>`
      : virt ? `${srcSel}<div class="row"><input class="inp mono" id="vdevUrl" value="${esc(this.vdevUrl())}" aria-label="虛擬設備網址" style="flex:1 1 200px"></div><span class="hint">虛擬設備是另一個程式（<span class="mono">node tools/vdev/server.js</span>）裡以 avr8js 模擬的 Uno，執行真的 DofLabFirmata 機器碼；資料經網路（WebSocket）交換，Firmata 位元組和 USB 完全相同。它<b>不是實體板子</b>：在這裡通過的只算「已在虛擬設備驗證」。不需要 Web Serial，手機也能連。</span>
         <div class="row"><button class="btn primary" id="hwConn" ${this.hw.busy ? 'disabled' : ''}>連接虛擬 Uno</button></div>
         ${c.state === 'lost' ? `<span class="hint" style="color:var(--err)">上次連線中斷${this.twin.dropped.length ? `；${this.twin.dropped.length} 個未確認命令已作廢、不會重送` : ''}。重新連線後會從唯讀開始。</span>` : ''}`
      : `${srcSel}${p.board.type === 'pi4b' ? `<div class="row"><input class="inp mono" id="wsUrl" value="${esc(urlDefault)}" aria-label="樹莓派閘道網址" style="flex:1 1 200px"></div>` : `<span class="hint">${DL.boardFamily(p.board.type) === 'esp32' ? 'ESP32 需先上傳 DofLabFirmata 韌體' : 'Uno 需先上傳 DofLabFirmata（建議）或 StandardFirmata'}，再用 USB 連接電腦；需要電腦版 Chrome／Edge。韌體在下載包的 firmware 資料夾，也可以直接按下面的按鈕上傳。</span>${this.firmataFlashHtml ? this.firmataFlashHtml() : ''}`}
         <div class="row"><button class="btn primary" id="hwConn" ${this.hw.busy ? 'disabled' : ''}>${p.board.type === 'pi4b' ? '連接樹莓派' : (DL.boardFamily(p.board.type) === 'esp32' ? '連接 ESP32（USB）' : '連接 Arduino（USB）')}</button>${p.board.type !== 'pi4b' && this.hw.lastPort ? `<button class="btn" id="hwReconn" ${this.hw.busy ? 'disabled' : ''} title="不用再選連接埠">用上次的連接埠重新連線</button>` : ''}</div>
         ${p.board.type !== 'pi4b' ? '<span class="hint">連不上時：先關掉 Arduino IDE 的序列埠監控視窗與其他 DofLab 分頁。本頁上一次沒關乾淨的連線會自動關閉；板子沒回應時會自動重新啟動板子再試一次。</span>' : ''}
         ${c.state === 'lost' ? `<span class="hint" style="color:var(--err)">上次連線中斷${this.twin.dropped.length ? `；${this.twin.dropped.length} 個未確認命令已作廢、不會重送` : ''}。重新連線後會從唯讀開始。</span>` : ''}`;
    const s2 = this.hw.identity ? `<span class="${this.hw.identity.ok ? '' : 'muted'}">${this.hw.identity.ok ? '✓' : '✗'} ${esc(this.hw.identity.msg)}</span>${this.hw.identity.mock ? '<span class="hint">這是測試用的模擬腳位，不是實體設備。</span>' : ''}${(this.hw.identity.virtual ? '<span class="hint">這是虛擬設備（另一個程序模擬的晶片），不是實體設備：在這裡通過只算「已在虛擬設備驗證，未以實體設備驗證」。</span>' : '')}` : '<span class="hint">連線後讀取板卡回報的型號與腳位能力。</span>';
    const bindings = Object.values(a.bindings);
    const hasUs = bindings.some(b => b.role === 'ultrasonic');
    const s3 = connected ? `<span class="hint">唯讀只會把輸入腳位設為上拉／類比並開啟回報，不改變任何輸出。${virt ? '到虛擬設備的工作台（「開啟工作台」）按一下按鈕' : '按一下實體按鈕'}，確認畫面有反應。${hasUs ? '超音波的 TRIG 是量距離必須的觸發輸出：唯讀時韌體也會每 60 ms 送一次 10 µs 的觸發脈衝，只接到超音波模組。' : ''}</span>${this.hw.sonarUnsupported ? `<span class="hint" style="color:var(--err)">${esc(this.hw.sonarUnsupported)}</span>` : ''}${this.hw.touchUnsupported ? `<span class="hint" style="color:var(--warn)">${esc(this.hw.touchUnsupported)}</span>` : ''}${bindings.map(b => {
      const cc = DL.project.findComp(p, b.comp); const isIn = b.role === 'button' || b.role === 'analog' || b.role === 'ultrasonic';
      return `<label class="check"><input type="checkbox" data-chk="${b.comp}" ${this.hw.checks[b.comp] ? 'checked' : ''}><span>${b.comp} ${isIn ? '←' : '→'} ${esc(b.role === 'ultrasonic' ? `TRIG ${board.pinLabel(board.pinById[b.trig])}、ECHO ${board.pinLabel(board.pinById[b.echo])}` : board.pinLabel(board.pinById[b.pin]))}${b.via && b.via.length ? '（經 ' + b.via.join('、') + '）' : ''}</span>${isIn ? `<span class="ind ${this.hw.sawChange[b.comp] ? 'ok' : ''}" id="saw-${b.comp}">${this.hw.sawChange[b.comp] ? '已偵測到變化' : '等待變化'}</span>` : (mode === 'hw-control' ? `<span class="ind ok">輸出：已授權寫入</span>` : `<span class="ind">輸出：唯讀，未寫入</span>`)}</label>`;
    }).join('')}` : '<span class="hint">連線後在這裡逐一核對實體接線。</span>';
    const s4 = mode === 'hw-control'
      ? `<span>已授權：${R.outs.map(o => o.comp).join('、')}。按「▶ 執行」後，行為的輸出才會送往設備。</span><div class="row"><button class="btn" id="hwRevoke">停止寫入（回到唯讀）</button></div>`
      : `<ul class="issues">${R.req.map(r => `<li class="${r.ok ? 'info' : 'warn'}"><span class="lv ${r.ok ? 'ok' : 'warn'}">${r.ok ? '已符合' : '未符合'}</span><span>${esc(r.text)}</span></li>`).join('')}</ul><div class="row"><button class="btn primary" id="hwAuth" ${connected && R.ok ? '' : 'disabled'}>授權受控寫入</button></div>`;
    el.innerHTML = `<ol class="hwsteps">
      ${step(1, '連線', connected ? 'done' : 'cur', s1)}
      ${step(2, '辨識板卡與能力', this.hw.identity ? (this.hw.identity.ok ? 'done' : 'cur') : '', s2)}
      ${step(3, '唯讀觀測與核對接線', connected ? (bindings.every(b => this.hw.checks[b.comp]) ? 'done' : 'cur') : '', s3)}
      ${step(4, '受控寫入', mode === 'hw-control' ? 'done' : connected && R.ok ? 'cur' : '', s4)}
    </ol><p class="hint" id="drvStatusFull">驗證狀態：${esc(info.status)}。</p><p class="hint">斷線、資料過期、重連或裝置重啟時，不會自動重送未確認的命令；重連一律從唯讀開始。此流程不是實際接線或機械安全操作程序，電壓、電流、共地與供電請依實物規格核對。</p>`;
    const cn = $('hwConn'); if (cn) cn.onclick = () => this.hwConnect();
    const rc = $('hwReconn'); if (rc) rc.onclick = () => this.hwConnect(true);
    if (this.bindFirmataFlash) this.bindFirmataFlash();
    const dc = $('hwDisc'); if (dc) dc.onclick = () => this.hwDisconnect('使用者中斷連線');
    const au = $('hwAuth'); if (au) au.onclick = () => this.hwAuthorize();
    const rv = $('hwRevoke'); if (rv) rv.onclick = () => this.hwRevoke('使用者停止寫入');
    el.querySelectorAll('[data-chk]').forEach(cb => cb.onchange = () => { this.hw.checks[cb.dataset.chk] = cb.checked; this.renderHw(); });
    el.querySelectorAll('input[name="hwSrc"]').forEach(r => r.onchange = () => { if (!r.checked) return; this.hw.src = r.value; try { localStorage.setItem('doflab.hwSrc', r.value); } catch (e) { } this.renderHw(); });
    const vu = $('vdevUrl'); if (vu) vu.onchange = () => { this.hw.vdevUrl = vu.value.trim(); try { localStorage.setItem('doflab.vdevUrl', this.hw.vdevUrl); } catch (e) { } };
  };
  P.renderHwLive = function () {
    const net = $('vdevNet'); const t = this.hw.driver && this.hw.driver.transport;
    if (net && t && t.rtt !== null && t.rtt !== undefined) net.textContent = `網路來回 ${t.rtt} ms`;
    for (const c of this.p.components) {
      if (!INPUTS.includes(c.type)) continue;
      const el = $('saw-' + c.id); if (this.hw.sawChange[c.id] && el && el.className !== 'ind ok') { el.className = 'ind ok'; el.textContent = '已偵測到變化'; }
    }
  };
  P.hwConnect = async function (reuse) {
    const p = this.p; const src = this.hwSource(); const info = DL.drivers.driverFor(p.board.type, src);
    if (!info.cls) { this.toast(info.status, 'e'); return; }
    // 先讀網址，再重繪面板：樹莓派閘道（wsUrl）或虛擬設備（vdevUrl）；USB 不用網址
    const url = src === 'virtual' ? ($('vdevUrl') ? $('vdevUrl').value.trim() : this.vdevUrl()) : src === 'pibridge' && $('wsUrl') ? $('wsUrl').value.trim() : null;
    if (url) try { localStorage.setItem(src === 'virtual' ? 'doflab.vdevUrl' : 'doflab.wsUrl', url); } catch (e) { }
    if (src === 'virtual') this.hw.vdevUrl = url;
    this.hw.busy = true; this.renderHw();
    const drv = new info.cls(this.twin, { log: (m, k) => { this.log(k || '', m); }, onLost: why => this.hwLost(why), onReboot: why => this.hwRebooted(why) }, p.board.type);
    try {
      const r = await drv.connect(src === 'usb' ? { port: reuse ? this.hw.lastPort : null } : { url });
      if (drv.port) this.hw.lastPort = drv.port;   // 記住連接埠：之後可以不經選擇視窗直接重新連線（瀏覽器已授權過）
      if (this.sim.running) this.toggleRun();
      this.hw.driver = drv; this.hw.connSrc = src; this.hw.vdevConnUrl = src === 'virtual' ? url : null; this.hw.identity = r.identity; this.hw.checks = {}; this.hw.sawChange = {}; this.hw.lastSeen = {};
      this.twin.connected(r.deviceId, r.info, { virtual: !!r.virtual });
      this.defineSignals();
      const touch = Object.values(this.analysis.bindings).filter(b => b.role === 'touch').map(b => b.comp);
      this.hw.touchUnsupported = touch.length ? `${touch.join('、')}：觸控腳的真機同步本版未支援，量測會一直是「未知」。請改用「程式」頁產生程式並上傳到板子，直接在板子上測試。` : null;
      if (this.hw.touchUnsupported) this.log('w', this.hw.touchUnsupported);
      const inputs = Object.values(this.analysis.bindings).filter(b => b.role === 'button' || b.role === 'analog' || b.role === 'ultrasonic').map(b => b.role === 'ultrasonic' ? { signal: b.comp + '.distance', num: b.trigNum, echo: b.echoNum, kind: 'sonar' } : { signal: b.comp + (b.role === 'button' ? '.pressed' : '.level'), num: b.num, kind: b.role === 'button' ? 'button' : 'analog' });
      this.hw.sonarUnsupported = null;
      const w = await drv.watch(inputs);
      if (w && w.sonarUnsupported) { this.hw.sonarUnsupported = w.sonarUnsupported; this.log('e', w.sonarUnsupported); }
      if (!r.identity.ok) this.log('w', '板卡辨識與專案不符：只能唯讀觀測，不能授權寫入。');
    } catch (e) {
      const msg = e && e.name === 'NotFoundError' ? '沒有選擇序列埠。' : e && (e.name === 'SecurityError' || e.name === 'NotAllowedError') ? '這個頁面不允許存取裝置（例如在 Claude 的預覽中）。請改用下載版，在 Chrome／Edge 以 https 或 localhost 開啟。' : (e && e.message) || String(e);
      if (drv.port && e && e.code !== 'port_busy') this.hw.lastPort = drv.port;
      this.log('e', '連線失敗：' + msg); this.toast(msg, 'e');
    } finally { this.hw.busy = false; this.renderAll(); }
  };
  P.hwAuthorize = async function () {
    const R = this.hwRequirements(); if (!R.ok) { this.toast('還有條件未符合，不能授權寫入。', 'e'); return; }
    const outs = R.outs.map(b => ({ comp: b.comp, signal: b.comp + (b.role === 'servo' ? '.angle' : '.state'), num: b.num, kind: b.role === 'servo' ? 'servo' : 'digital' }));
    const r = this.twin.authorize(outs.map(o => o.signal), { ok: true });
    if (!r.ok) { this.toast(r.msg, 'e'); return; }
    this._cmdWarned = false;
    await this.hw.driver.authorize(outs);
    this.renderAll();
  };
  P.hwRevoke = function (why) { if (this.twin.mode !== 'hw-control') return; this.twin.revoke(why); if (this.sim.running) this.toggleRun(); this.hw.driver && this.hw.driver.revoke(); this.renderAll(); };
  P.hwDisconnect = function (why) {
    const d = this.hw.driver; if (!d) return Promise.resolve();
    this.hw.driver = null; if (this.sim.running) this.toggleRun();
    this.twin.disconnected(why || '中斷連線'); const done = d.disconnect();
    this.hw.identity = null; this.renderAll(); return done;
  };
  // 設備重新開機（連線還在）：撤銷授權、回到唯讀，未確認命令不重送；重新送出唯讀的輸入設定（板子開機後全部回到預設）
  P.hwRebooted = function (why) {
    if (!this.hw.driver) return;
    if (this.sim.running) this.toggleRun();
    this.twin.rebooted(why);
    this.hw.driver.rewatch().catch(() => { });
    this.toast(`${this.twin.conn.virtual ? '虛擬設備' : '設備'}重新開機：已撤銷寫入授權、回到唯讀，未確認的命令不會重送。要再控制請重新授權。`, 'e');
    this.renderAll();
  };
  P.hwLost = function (why) {
    if (!this.hw.driver) return; this.hw.driver = null; if (this.sim.running) this.toggleRun();
    this.twin.disconnected(why); this.hw.identity = null; this.toast(`${this.twin.conn.virtual ? '虛擬設備' : '真機'}連線中斷：已回到模擬模式，未確認的命令不會重送。`, 'e'); this.renderAll();
  };

  /* ---------- 版本狀態表（依規劃文件的標示） ---------- */
  DL.ui.STATUS = [];
  DL.ui.aboutTable = function () {
    const tag = { impl: ['st-impl', '已實作'], unver: ['st-unver', '未驗證'], prop: ['st-prop', '設計提案'], no: ['st-no', '未包含'] };
    return `<table class="status"><thead><tr><th>項目</th><th>標示</th><th>證據與限制</th></tr></thead><tbody>${DL.ui.STATUS.map(r => `<tr><td>${esc(r[0])}</td><td><span class="status-tag ${tag[r[1]][0]}">${tag[r[1]][1]}</span></td><td>${esc(r[2])}</td></tr>`).join('')}</tbody></table>`;
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
