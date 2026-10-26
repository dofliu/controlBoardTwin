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

  DL.ui.obs = { sigOf, fmt, isLed, isBtn, INPUTS };   // 訊號測試與波形（testsig.js、wave.js）共用

  P.bindObserve = function () {
    $('simRun').onclick = () => this.toggleRun();
    $('simStep').onclick = () => { if (this.sim.running) this.toggleRun(); this.advance(10); this.renderObserve(); };
    $('simReset').onclick = () => { this.resetSim(); this.log('w', '模擬已重置到 t = 0'); this.renderObserve(); };
    $('simSpeed').onchange = e => { this.sim.speed = +e.target.value; };
    $('clearEvents').onclick = () => { this.events = []; this._evDirty = true; };
    if (this.bindRec) this.bindRec();
    if (this.bindWave) this.bindWave();
  };

  P.defineSignals = function () {
    for (const c of this.p.components) {
      const s = sigOf(c); if (!s) continue;
      this.twin.define(s, { kind: INPUTS.includes(c.type) ? 'input' : 'output', comp: c.id, ctype: c.type, feedback: INPUTS.includes(c.type), periodic: c.type === 'LDR' || c.type === 'US' });   // 光敏、超音波每 50／60 ms 回報一次：停了就是卡住
      if (isLed(c)) this.twin.define(c.id + '.pwm', { kind: 'output', comp: c.id, ctype: 'PWM', feedback: false });   // 訊號測試的 PWM 工作週期（0–255，V2.14）
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
    if (!this.sim.running && this.tsig && this.tsig.active) this.tsigStop('開始執行行為');   // 執行行為和訊號測試不同時進行
    this.sim.running = !this.sim.running; this.sim.last = null;
    if (this.sim.running && this.p.arm && this.armOnRun) this.armOnRun();
    $('simRun').textContent = this.sim.running ? '❚❚ 暫停' : '▶ 執行'; $('simRun').classList.toggle('primary', !this.sim.running);
    this.log(this.sim.running ? 's' : 'w', this.sim.running ? `${this.twin.mode === 'hw-control' ? '開始以行為控制真機' : this.twin.mode === 'hw-read' ? '開始執行（唯讀：只推算，不送命令）' : '開始模擬'}` : '已暫停', this.sim.time);
    if (this.recRun) this.recRun();
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
  // 真機的按鈕量測：依收到的時刻排隊，模擬推進到那個時刻才生效。畫面很慢（一幀幾百 ms）時，短按也不會被整個跳過
  P.noteButtonEvent = function (e) {
    if (this.twin.mode === 'sim' || !/\.pressed$/.test(e.name)) return;
    const q = this.hw.btnQ = this.hw.btnQ || []; q.push({ name: e.name, v: !!e.v, at: performance.now() }); if (q.length > 500) q.shift();
  };
  P.feedButtons = function (until) {
    const q = this.hw.btnQ || [], fed = this.hw.fed = this.hw.fed || {};
    while (q.length && q[0].at <= until) { const x = q.shift(); fed[x.name] = x.v; }
  };
  P.advance = function (ms, wall) {
    const e = this.sim.engine; const mode = this.twin.mode; const p = this.p;
    const bnd = this.analysis.bindings; const board = DL.boards[p.board.type]; const armIds = this.armServoIds ? this.armServoIds() : [];
    const armAuto = !!(p.arm && this.arm && this.arm.mode === 'auto' && this.armHasSeq());
    for (let i = 0; i < ms; i++) {
      this.sim.time++;
      const t = this.sim.time;
      const tw = wall ? wall.from + (wall.to - wall.from) * (i + 1) / ms : performance.now();   // 這一毫秒對應的實際時間
      if (mode !== 'sim') this.feedButtons(wall ? tw : Infinity);
      const rp = this.replay ? this.replayApply(t) : null;   // 重播：紀錄裡「這一毫秒送進引擎的輸入」
      const rec = mode !== 'sim' && this.recIn ? (sig, v, raw) => this.recIn(sig, v, raw, t, tw) : null;   // 連線紀錄：記下引擎實際收到的輸入（模擬時間）
      if (armAuto) this.armSeqTick(t);   // 手臂行為序列（與產生的程式同一套規則）
      for (const c of p.components) {
        if (isBtn(c)) {
          const sg = c.id + '.pressed'; let v;
          if (rp) v = !!(rp[sg] && rp[sg].v);
          else if (mode === 'sim') v = !!this.sim.held[c.id];
          else { const s = this.twin.view(sg); const f = (this.hw.fed || {})[sg]; v = s.quality === 'ok' ? (f !== undefined ? f : !!(s.measured && s.measured.v)) : false; }
          e.setButton(c.id, v); if (rec) rec(sg, v);
        } else if (c.type === 'LDR') {
          const sg = c.id + '.level';
          if (rp) { const x = rp[sg]; if (x) { if (x.raw !== undefined) e.setAdcRaw(c.id, x.raw); else e.setLightPercent(c.id, x.v); } }
          else if (mode === 'sim') e.setLightPercent(c.id, this.sim.light[c.id]);
          else { const s = this.twin.view(sg); if (s.quality === 'ok' && s.measured) { const raw = s.measured.raw !== undefined ? s.measured.raw : s.measured.v; e.setAdcRaw(c.id, raw); if (rec) rec(sg, s.measured.v, raw); } }
        } else if (c.type === 'US') {
          const sg = c.id + '.distance'; let d;
          if (rp) d = rp[sg] ? rp[sg].v : US_FAR;
          else if (mode === 'sim') d = this.sim.dist[c.id];
          else { const s = this.twin.view(sg); d = s.quality === 'ok' && s.measured ? s.measured.v : US_FAR; }   // 沒有有效量測：當成沒有物體（不推算）
          e.setDistance(c.id, d); if (rec) rec(sg, d);
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
        if (this.recOut) this.recOut(s, v, tw, t);   // 連線紀錄（真機模式）或重播的輸出
        if (mode === 'hw-control' && bnd[c.id]) {
          this.twin.target(s, v, 'behavior');
          const res = this.twin.command(s, v, 'behavior');
          if (res.ok && res.cmd && this.hw.driver) this.hw.driver.write(res.cmd, { num: bnd[c.id].num, kind: c.type === 'SERVO' ? 'servo' : 'digital' });
          else if (!res.ok && !this._cmdWarned) { this._cmdWarned = true; this.log('e', res.msg, t); }
        }
      }
      for (const c of p.components) {
        if (isBtn(c) && mode === 'sim') this.twin.simulate(c.id + '.pressed', this.replay ? !!(this.replay.cur[c.id + '.pressed'] || {}).v : !!this.sim.held[c.id]);
        if (c.type === 'LDR' && mode === 'sim') this.twin.simulate(c.id + '.level', this.replay ? (this.replay.cur[c.id + '.level'] || {}).v : this.sim.light[c.id]);
        if (c.type === 'US' && mode === 'sim') this.twin.simulate(c.id + '.distance', this.replay ? (this.replay.cur[c.id + '.distance'] || { v: US_FAR }).v : this.sim.dist[c.id]);
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
    if (this.replay) this.replayFrame(now);   // 重播連線紀錄：進度與結束
    if (this.armTick) this.armTick(dtFrame);
    if (this.sim.running) {
      if (this.sim.last === null) this.sim.last = now;
      const from = this.sim.last;
      this.sim.acc = (this.sim.acc || 0) + Math.min(1000, now - this.sim.last) * this.sim.speed; this.sim.last = now;   // 畫面很慢（軟體繪圖）時也跟上真實時間；分頁在背景太久才截斷
      const step = Math.floor(this.sim.acc); this.sim.acc -= step;
      if (step > 0) this.advance(step, { from, to: now });   // 這一幀涵蓋的實際時間：真機的按鈕變化依收到的時刻放進對應的那一毫秒
    }
    // 波形取樣（牆上時間軸，像示波器）
    if (!this._lastSample || now - this._lastSample > 30) { this._lastSample = now; this.sample(now); }
    if (this.scene.ok) { this.scene.setVis(this.visState()); this.scene.frame(); }
    if (this.ui.tab === 'observe') {
      this.drawTrace(now);
      if (!this._lastCmp || now - this._lastCmp > 500) { this._lastCmp = now; if (this.drawWaveCmp) this.drawWaveCmp(); if (this.renderTsigLive) this.renderTsigLive(); }   // 擷取比較（大小可能變了）、訊號測試的計數
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
    this.renderTwin(); this.renderHw(); this.renderEventsIfDirty(true); this.renderSerial(); if (this.renderTsig) this.renderTsig();
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
    else if (e.type === 'measure') { this.noteMeasure(e); this.noteButtonEvent(e); }
    else if (e.type === 'reboot') this.log('e', `設備重新開機（${e.reason}）：已撤銷寫入授權、回到唯讀${e.dropped.length ? `；${e.dropped.length} 個未確認命令作廢，不會重送` : ''}。開機前的量測已標為過期。`);
    if (this.recTwin) this.recTwin(e);
    if (this.waveTwin) this.waveTwin(e);   // 波形：命令與量測依收到的時刻記下來（V2.14）
    if (e.type === 'mode' && this.tsigOnMode) this.tsigOnMode(e);   // 訊號測試：不能再寫入時停止
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
    const pr = this.twin.conn.virtual && this.twin.conn.state === 'connected' ? this.hw.presence : null;
    if (pr && pr.holder && pr.holder.id !== pr.you) req.push({ ok: false, text: `控制權在「${pr.holder.name}」手上：同一台虛擬設備同時只有一個人能寫入，等對方停止寫入或中斷連線` });
    if (Object.values(a.bindings).some(b => b.role === 'ultrasonic')) req.push({ ok: !!this.hw.identity && !this.hw.sonarUnsupported, text: '超音波可以讀取（Uno／ESP32 需要 DofLabFirmata）' });
    return { req, ok: req.every(r => r.ok), outs };
  };
  // 連線來源：USB 序列埠或虛擬設備（只有這個板型支援時）；連線中以實際連線的來源為準
  P.hwSource = function () {
    const srcs = DL.drivers.driverFor(this.p.board.type).sources;
    if (this.hw.driver && this.hw.connSrc) return this.hw.connSrc;
    return srcs.includes(this.hw.src) ? this.hw.src : srcs[0];
  };
  // 虛擬設備網址：每個板型各記一個（Uno 沿用舊的 doflab.vdevUrl；ESP32 → esp32-1、樹莓派 → pi-1，第 6 階段）
  const vdevKey = b => b === 'uno' ? 'doflab.vdevUrl' : 'doflab.vdevUrl.' + b;
  P.vdevUrl = function () {
    const b = this.p.board.type;
    if (this.hw.vdevUrl && this.hw.vdevUrlBoard === b) return this.hw.vdevUrl;
    try { const u = localStorage.getItem(vdevKey(b)); if (u) return u; } catch (e) { }
    return DL.drivers.vdevUrl(b);
  };
  P.setVdevUrl = function (url) { const b = this.p.board.type; this.hw.vdevUrl = url; this.hw.vdevUrlBoard = b; try { localStorage.setItem(vdevKey(b), url); } catch (e) { } };
  // 三種虛擬設備的說明（介面各處都要分得出：虛擬 Uno 跑真的韌體；ESP32 是協定模型；樹莓派是 pi_bridge＋模擬腳位）
  const VKIND = {
    uno: { short: '另一個程序模擬的 Uno（avr8js），不是實體板子', btn: '連接虛擬 Uno', hint: '虛擬設備是另一個程式（<span class="mono">node tools/vdev/server.js</span>）裡以 avr8js 模擬的 Uno，執行真的 DofLabFirmata 機器碼；資料經網路（WebSocket）交換，Firmata 位元組和 USB 完全相同。它<b>不是實體板子</b>：在這裡通過的只算「已在虛擬設備驗證」。不需要 Web Serial，手機也能連。' },
    esp32: { short: 'ESP32 協定模型，不是實際韌體，也不是實體板子', btn: '連接虛擬 ESP32（協定模型）', hint: '虛擬 ESP32 是另一個程式（<span class="mono">node tools/vdev/server.js --esp32</span>）裡的<b>協定模型</b>：一段行為和 DofLabFirmata 相同的 JS 程式，<b>不是實際韌體</b>（不模擬 ESP32 的指令），也不是實體板子。韌體本身的錯誤不會在這裡出現；在這裡通過只算「已在虛擬設備（協定模型）驗證」。觸控腳不支援同步。' },
    pi4b: { short: '虛擬樹莓派（pi_bridge＋模擬腳位），不是實體樹莓派', btn: '連接虛擬樹莓派', hint: '虛擬樹莓派是虛擬設備主機（<span class="mono">node tools/vdev/server.js --pi</span>）啟動的 <span class="mono">pi_bridge.py</span>：和接實體樹莓派時同一份閘道程式，GPIO 是 gpiozero 的模擬腳位，外面接工作台。它<b>不是實體樹莓派</b>：在這裡通過只算「已在虛擬設備驗證」。超音波只模擬距離（不模擬回波時序）；不能部署程式。' }
  };
  const vkind = b => VKIND[DL.boardFamily ? (DL.boardFamily(b) === 'esp32' ? 'esp32' : b) : b] || VKIND.uno;
  const benchUrl = ws => { try { const u = new URL(ws); const m = u.pathname.match(/\/dev\/([\w-]+)$/); return `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}/${m ? '?d=' + m[1] : ''}`; } catch (e) { return null; } };   // 工作台頁直接選到這台設備
  P.renderHw = function () {
    const el = $('hwBody'); if (!el || !this.p) return;
    const p = this.p; const board = DL.boards[p.board.type]; const src = this.hwSource(); const info = DL.drivers.driverFor(p.board.type, src); const virt = src === 'virtual';
    $('drvStatus').textContent = info.tag || info.status.split('：')[0]; $('drvStatus').title = info.status; $('drvStatus').className = 'status-tag ' + (info.cls ? 'st-unver' : 'st-no');   // 標籤只放短句，完整說明在滑鼠提示與卡片內
    if (!info.cls) { el.innerHTML = `<p>${esc(info.status)}</p><p class="hint">缺少驅動時，平台會拒絕連線，而不是假裝同步。</p>`; return; }
    const c = this.twin.conn; const connected = c.state === 'connected'; const mode = this.twin.mode;
    const a = this.analysis; const R = this.hwRequirements();
    const urlDefault = (() => { try { const s = localStorage.getItem('doflab.wsUrl'); if (s) return s; } catch (e) { } return location.protocol === 'http:' && location.host && location.port !== '8766' ? `ws://${location.host}/ws` : 'ws://raspberrypi.local:8765/ws'; })();
    const step = (n, title, state, body) => `<li class="${state}"><span class="no">${n}</span><div><b>${title}</b>${body}</div></li>`;
    const srcSel = !connected && info.sources.length > 1 ? `<div class="row" role="radiogroup" aria-label="連線來源">${info.sources.map(k => `<label class="check"><input type="radio" name="hwSrc" value="${k}" ${k === src ? 'checked' : ''}><span>${k === 'virtual' ? '虛擬設備（網址）' : k === 'pibridge' ? '網路閘道（實體樹莓派）' : 'USB 序列埠（實體板子）'}</span></label>`).join('')}</div>` : '';
    const vk = vkind(p.board.type), isPi = p.board.type === 'pi4b';
    const bu = virt ? benchUrl(connected && this.hw.vdevConnUrl ? this.hw.vdevConnUrl : this.vdevUrl()) : null;
    // 多人（第 5 階段）：誰連著、誰有控制權
    const pr = virt && connected ? this.hw.presence : null;
    const prHtml = pr ? `<span class="hint" id="vdevPresence">${this.presenceText(pr)}</span>` : '';
    const rtt = this.hw.driver && this.hw.driver.transport ? `<span id="vdevNet">網路來回 ${this.hw.driver.transport.rtt !== null ? this.hw.driver.transport.rtt + ' ms' : '量測中'}</span> · ` : '';
    const s1 = connected ? `<span>${esc(info.label)} · ${esc(c.info || '')}</span>${virt ? `<span class="hint"><span class="ev-virt">虛擬</span>${esc(vk.short)} · ${rtt}${bu ? `<a href="${esc(bu)}" target="_blank" rel="noopener">開啟工作台</a>` : ''}</span>` : ''}<div class="row"><button class="btn danger" id="hwDisc">中斷連線</button></div>`
      : virt ? `${srcSel}<div class="row"><input class="inp mono" id="vdevUrl" value="${esc(this.vdevUrl())}" aria-label="虛擬設備網址" style="flex:1 1 200px">${isPi ? '' : `<input class="inp" id="vdevName" value="${esc(this.vdevName())}" aria-label="你的名稱（其他連線看得到）" title="你的名稱：同一台虛擬設備的其他連線會看到，例如「控制中：老師」" style="flex:0 1 120px">`}</div><span class="hint">${vk.hint}</span>
         <div class="row"><button class="btn primary" id="hwConn" ${this.hw.busy ? 'disabled' : ''}>${vk.btn}</button></div>
         ${p.board.type === 'uno' ? `<span class="hint">虛擬 Uno 上傳過自己的程式（「程式」頁）之後，要同步請先把 DofLabFirmata 上傳回去：</span>${this.firmataFlashHtml ? this.firmataFlashHtml() : ''}` : ''}
         ${c.state === 'lost' ? `<span class="hint" style="color:var(--err)">上次連線中斷${this.twin.dropped.length ? `；${this.twin.dropped.length} 個未確認命令已作廢、不會重送` : ''}。重新連線後會從唯讀開始。</span>` : ''}`
      : `${srcSel}${p.board.type === 'pi4b' ? `<div class="row"><input class="inp mono" id="wsUrl" value="${esc(urlDefault)}" aria-label="樹莓派閘道網址" style="flex:1 1 200px"></div>` : `<span class="hint">${DL.boardFamily(p.board.type) === 'esp32' ? 'ESP32 需先上傳 DofLabFirmata 韌體' : 'Uno 需先上傳 DofLabFirmata（建議）或 StandardFirmata'}，再用 USB 連接電腦；需要電腦版 Chrome／Edge。韌體在下載包的 firmware 資料夾，也可以直接按下面的按鈕上傳。</span>${this.firmataFlashHtml ? this.firmataFlashHtml() : ''}`}
         <div class="row"><button class="btn primary" id="hwConn" ${this.hw.busy ? 'disabled' : ''}>${p.board.type === 'pi4b' ? '連接樹莓派' : (DL.boardFamily(p.board.type) === 'esp32' ? '連接 ESP32（USB）' : '連接 Arduino（USB）')}</button>${p.board.type !== 'pi4b' && this.hw.lastPort ? `<button class="btn" id="hwReconn" ${this.hw.busy ? 'disabled' : ''} title="不用再選連接埠">用上次的連接埠重新連線</button>` : ''}</div>
         ${p.board.type !== 'pi4b' ? '<span class="hint">連不上時：先關掉 Arduino IDE 的序列埠監控視窗與其他 DofLab 分頁。本頁上一次沒關乾淨的連線會自動關閉；板子沒回應時會自動重新啟動板子再試一次。</span>' : ''}
         ${c.state === 'lost' ? `<span class="hint" style="color:var(--err)">上次連線中斷${this.twin.dropped.length ? `；${this.twin.dropped.length} 個未確認命令已作廢、不會重送` : ''}。重新連線後會從唯讀開始。</span>` : ''}`;
    const s2 = this.hw.identity ? `<span class="${this.hw.identity.ok ? '' : 'muted'}">${this.hw.identity.ok ? '✓' : '✗'} ${esc(this.hw.identity.msg)}</span>${this.hw.identity.mock ? '<span class="hint">這是測試用的模擬腳位，不是實體設備。</span>' : ''}${(this.hw.identity.virtual ? (this.hw.identity.protocol ? '<span class="hint">這是虛擬設備（ESP32 協定模型：行為和韌體相同的 JS 程式，不是實際韌體），不是實體設備：在這裡通過只算「已在虛擬設備（協定模型）驗證，未以實體設備驗證」。</span>' : '<span class="hint">這是虛擬設備（另一個程序模擬的晶片或腳位），不是實體設備：在這裡通過只算「已在虛擬設備驗證，未以實體設備驗證」。</span>') : '')}` : '<span class="hint">連線後讀取板卡回報的型號與腳位能力。</span>';
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
      ${step(1, '連線', connected ? 'done' : 'cur', s1 + prHtml)}
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
    const vu = $('vdevUrl'); if (vu) vu.onchange = () => this.setVdevUrl(vu.value.trim());
    const vn = $('vdevName'); if (vn) vn.onchange = () => { this.hw.vdevName = vn.value.trim().slice(0, 24); try { localStorage.setItem('doflab.vdevName', this.hw.vdevName); } catch (e) { } };
  };
  // 你的名稱：同一台虛擬設備的其他連線看得到（「控制中：老師」）。第一次用時給一個隨機的預設名稱
  P.vdevName = function () {
    if (this.hw.vdevName) return this.hw.vdevName;
    let n = null; try { n = localStorage.getItem('doflab.vdevName'); } catch (e) { }
    if (!n) { n = '使用者 ' + Math.floor(100 + Math.random() * 900); try { localStorage.setItem('doflab.vdevName', n); } catch (e) { } }
    return (this.hw.vdevName = n);
  };
  P.presenceText = function (pr) {
    const me = pr.you; const names = pr.links.map(l => esc(l.name) + (l.id === me ? '（你）' : '') + (l.mode === 'raw' ? '（上傳／序列埠）' : ''));
    const ctl = !pr.holder ? '沒有人控制（大家都是唯讀觀看）' : pr.holder.id === me ? '<b>你</b>（只有你能寫入）' : `<b>${esc(pr.holder.name)}</b>（你只能唯讀觀看）`;
    return `這台虛擬設備有 ${pr.links.length} 個連線：${names.join('、')} · 控制權：${ctl}`;
  };
  // 虛擬設備的連線名單或控制權改變：記進事件紀錄；自己的控制權被拿走（逾時）時回到唯讀
  P.hwPresence = function (m) {
    const prev = this.hw.presence; this.hw.presence = m;
    const who = l => l ? (l.id === m.you ? '你' : `「${l.name}」`) : '';
    const ph = prev && prev.holder ? prev.holder.id : null, nh = m.holder ? m.holder.id : null;
    if (prev && ph !== nh) this.log('w', nh ? `虛擬設備的控制權：${who(m.holder)}取得控制權${m.holder.id === m.you ? '' : '，你只能唯讀觀看'}` : `虛擬設備的控制權已釋放（${{ release: '撤銷授權', 'holder-left': '控制者中斷連線，主機已關掉他的輸出', timeout: '控制者太久沒有回應，逾時；主機已關掉他的輸出' }[m.why] || m.why}）`);
    else if (prev && m.links.length !== prev.links.length && m.by) this.log('', `虛擬設備：${m.by} ${m.links.length > prev.links.length ? '加入觀看' : '離開'}（共 ${m.links.length} 個連線）`);
    if (this.twin.mode === 'hw-control' && this.twin.conn.virtual && nh !== m.you) this.hwRevoke(m.why === 'timeout' ? '控制權逾時被釋放' : '控制權已不在你手上');
    const el = $('vdevPresence'); if (el && ph === nh && prev) el.innerHTML = this.presenceText(m); else this.renderHw();   // 控制權改變：授權條件也跟著變，整個面板重畫
  };
  P.renderHwLive = function () {
    if (this.renderRec && this.recActive && this.recActive()) this.renderRec();   // 連線紀錄的筆數即時更新
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
    if (url && src === 'virtual') this.setVdevUrl(url); else if (url) try { localStorage.setItem('doflab.wsUrl', url); } catch (e) { }
    this.hw.busy = true; this.renderHw();   // 先標示「連線中」：關閉序列埠監看也要一點時間，期間不能再按一次
    if (src === 'virtual' && this.up && this.up.vmon && this.up.vmon.open) await this.vmonClose('「觀測」頁要連線，已關閉（上傳與序列埠監看需要獨占虛擬設備）');
    const drv = new info.cls(this.twin, { log: (m, k) => { this.log(k || '', m); }, onLost: why => this.hwLost(why), onReboot: why => this.hwRebooted(why), onGuard: why => this.hwGuard(why), onPresence: m => this.hwPresence(m) }, p.board.type);
    if (src === 'virtual') { const vn = $('vdevName'); if (vn && vn.value.trim()) { this.hw.vdevName = vn.value.trim().slice(0, 24); try { localStorage.setItem('doflab.vdevName', this.hw.vdevName); } catch (e) { } } this.hw.presence = null; }
    try {
      const r = await drv.connect(src === 'usb' ? { port: reuse ? this.hw.lastPort : null } : { url, name: src === 'virtual' ? this.vdevName() : undefined });
      if (drv.port) this.hw.lastPort = drv.port;   // 記住連接埠：之後可以不經選擇視窗直接重新連線（瀏覽器已授權過）
      if (this.sim.running) this.toggleRun();
      this.hw.driver = drv; this.hw.connSrc = src; this.hw.vdevConnUrl = src === 'virtual' ? url : null; this.hw.identity = r.identity; this.hw.checks = {}; this.hw.sawChange = {}; this.hw.lastSeen = {};
      this.hw.btnQ = []; this.hw.fed = {};
      this.twin.connected(r.deviceId, r.info, { virtual: !!r.virtual });
      if (this.recStart) this.recStart(r);   // 每次連線開始一份新的連線紀錄
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
    if (this.hw.driver.acquire) {   // 虛擬設備：先向主機取得唯一的控制權（實體 USB 本來就獨占，直接通過）
      const g = await this.hw.driver.acquire();
      if (!g.ok) { this.log('e', '沒有取得控制權：' + g.message); this.toast(g.message, 'e'); this.renderHw(); return; }
    }
    const pwmSigs = this.tsigPwmSignals ? this.tsigPwmSignals(outs) : [];   // 訊號測試（V2.14）：可以 PWM 的 LED 也授權 LED.pwm（同一個腳位，測試時才切換）
    const r = this.twin.authorize(outs.map(o => o.signal).concat(pwmSigs), { ok: true });
    if (!r.ok) { if (this.hw.driver.release) await this.hw.driver.release(); this.toast(r.msg, 'e'); return; }
    this._cmdWarned = false;
    // 伺服：授權時先送畫面上目前的角度（模擬層），經 Twin Core 成為一般命令（有回讀確認）。否則韌體在第一個命令到達前會輸出預設的 1500 µs，伺服先轉到約 93°（V2.13）
    for (const o of outs) {
      if (o.kind !== 'servo') continue;
      const sv = this.twin.view(o.signal).simulated; if (!sv || typeof sv.v !== 'number') continue;
      this.twin.target(o.signal, sv.v, 'authorize');
      const c = this.twin.command(o.signal, sv.v, 'authorize'); if (c.ok && c.cmd) o.initial = c.cmd;
    }
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
  // 斷線保護（DofLabFirmata 1.2、pi_bridge）：設備太久沒收到 DofLab 的訊息，自己把輸出關掉了。連線其實還在時才收得到這個通知：撤銷授權、回到唯讀
  P.hwGuard = function (why) {
    if (this.twin.mode === 'hw-control') this.hwRevoke(why);
    this.toast(`${why}。已回到唯讀；要再控制請重新授權。`, 'e'); this.renderAll();
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
