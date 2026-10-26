/* DofLab — 觀測頁的「訊號測試」（V2.14）：每次寫入都換一個值（伺服角度遞增、LED 方波、PWM 工作週期遞增），每一次寫入有序號，
 * 螢幕（波形的序號標記、事件紀錄）和示波器上都看得出是哪一次。數值的產生在 src/core/testsig.js（DL.testsig）。
 * 規則：
 *   - 模擬：數值寫進模擬層（3D 畫面與波形），不送到設備。
 *   - 唯讀：不能開始（要送到設備先授權受控寫入）。受控寫入：每次寫入都是 Twin Core 的命令（來源 test），設備回讀確認（ACK）；斷線保護照常。
 *   - 和「▶ 執行」（行為）不同時進行：開始測試會暫停行為，開始行為會停止測試。
 *   - PWM：腳位能力要有 PWM（連線時看韌體回報：DofLabFirmata 1.3、pi_bridge 新版）；開始時把 LED 的腳位切成 PWM，停止時切回數位輸出並寫 LOW。
 *   - 手臂的關節伺服不在這裡（請用手臂頁）。SG90 的角度是命令值，沒有回授。
 */
(function (root) {
  const DL = root.DL; const App = DL.ui.App; const esc = DL.ui.esc;
  const $ = id => document.getElementById(id);
  const P = App.prototype;
  const { sigOf, fmt, isLed } = DL.ui.obs;
  const T = DL.testsig;
  const fmtV = (c, kind, v) => kind === 'pwm' ? `PWM ${v}/255` : kind === 'servo' ? `${Math.round(v)}°` : fmt(c, v);

  P.tsigOutputs = function () {
    const arm = this.armServoIds ? this.armServoIds() : [];
    return this.p.components.filter(c => (isLed(c) || c.type === 'SERVO') && !arm.includes(c.id) && this.analysis.bindings[c.id]);
  };
  // PWM 可不可以用：模擬看板子的腳位能力；連線時看韌體（或 pi_bridge）回報。Uno 的 D9、D10 和伺服共用 Timer1
  P.tsigPwmOk = function (c) {
    const b = this.analysis.bindings[c.id]; if (!b) return { ok: false, msg: '沒有接到板子的腳位' };
    const board = DL.boards[this.p.board.type], pin = board.pinById[b.pin];
    if (!pin || !pin.caps.includes('pwm')) return { ok: false, msg: `${pin ? board.pinLabel(pin) : b.pin} 不能 PWM` };
    if (this.p.board.type === 'uno' && [9, 10].includes(b.num) && this.p.components.some(x => x.type === 'SERVO')) return { ok: false, msg: 'Uno 的 D9、D10 和伺服共用 Timer1：專案裡有伺服時不能 PWM' };
    if (this.twin.mode === 'sim') return { ok: true };
    const d = this.hw.driver; if (!d || !d.pwmSupport) return { ok: false, msg: '這個連線不支援 PWM' };
    return d.pwmSupport(b.num);
  };
  // 授權受控寫入時一起授權的 PWM 訊號（LED.pwm：同一個腳位，測試時才切換）
  P.tsigPwmSignals = function (outs) {
    return outs.filter(o => o.kind === 'digital').map(o => DL.project.findComp(this.p, o.comp)).filter(c => c && isLed(c) && this.tsigPwmOk(c).ok).map(c => c.id + '.pwm');
  };
  P.tsigDefaults = function (c) {
    const kind = c.type === 'SERVO' ? 'servo' : 'digital';
    return Object.assign({ on: true, kind }, T.KINDS[kind].def);
  };
  P.tsigCfgOf = function (c) {
    const all = this.tsigCfg = this.tsigCfg || {};
    if (!all[c.id] || (all[c.id].kind === 'servo') !== (c.type === 'SERVO')) all[c.id] = this.tsigDefaults(c);
    return all[c.id];
  };
  P.tsigAllowed = function () {
    const m = this.twin.mode;
    if (m === 'hw-read') return { ok: false, msg: '唯讀：要送到設備，請先在「真機連線」授權受控寫入。' };
    if (this.replay) return { ok: false, msg: '重播連線紀錄時不能做訊號測試。' };
    return { ok: true };
  };

  /* ---------- 卡片 ---------- */
  P.renderTsig = function () {
    const el = $('tsigBody'); if (!el || !this.p) return;
    const t = this.tsig && this.tsig.active ? this.tsig : null, mode = this.twin.mode, dev = this.twin.conn.virtual ? '虛擬設備' : '真機';
    const outs = this.tsigOutputs(); const board = DL.boards[this.p.board.type];
    const head = mode === 'sim' ? '模擬預覽：數值寫進模擬層（畫面與波形），<b>不送到設備</b>。連線並授權受控寫入後，同樣的設定會送到設備。'
      : mode === 'hw-read' ? `<span style="color:var(--warn)">唯讀：要送到${dev}，請先在「真機連線」授權受控寫入。</span>`
        : `送往${dev}：每一次寫入都是 Twin Core 的命令，設備回讀確認（ACK）；序號記在事件紀錄與波形上，方便和示波器對照。SG90 的角度是命令值，沒有回授。`;
    if (!outs.length) { el.innerHTML = `<p class="hint">${head}</p><p class="hint">這個專案沒有可以測試的輸出（LED、伺服）${this.p.arm ? '；手臂的伺服請用「手臂」頁' : ''}。</p>`; return; }
    const rows = outs.map(c => {
      const cfg = this.tsigCfgOf(c), K = T.KINDS[cfg.kind], b = this.analysis.bindings[c.id], pin = board.pinById[b.pin];
      const pw = isLed(c) ? this.tsigPwmOk(c) : null;
      if (cfg.kind === 'pwm' && pw && !pw.ok) Object.assign(cfg, { kind: 'digital' }, T.KINDS.digital.def);
      const kindSel = isLed(c) ? `<select class="inp" data-k="kind" aria-label="${c.id} 的訊號種類" ${t ? 'disabled' : ''} style="width:auto"><option value="digital" ${cfg.kind === 'digital' ? 'selected' : ''}>數位輸出（亮／滅交替）</option><option value="pwm" ${cfg.kind === 'pwm' ? 'selected' : ''} ${pw.ok ? '' : 'disabled'}>PWM 工作週期 0–255${pw.ok ? '' : '（不能用）'}</option></select>` : '<span class="muted">伺服角度（命令）</span>';
      const pats = T.KINDS[cfg.kind].patterns.map(p => `<option value="${p}" ${cfg.pattern === p ? 'selected' : ''}>${T.PATTERNS[p]}</option>`).join('');
      const num = (k, lab) => `<label>${lab}<input class="inp" type="number" data-k="${k}" value="${cfg[k]}" min="${K.lo}" max="${K.hi}" ${t ? 'disabled' : ''} aria-label="${c.id} ${lab}"></label>`;
      const opts = cfg.kind === 'digital' ? '<span>每次寫入在亮、滅之間切換（第一次是亮）</span>' : `${num('min', `起點${K.unit}`)}${num('max', `終點${K.unit}`)}${num('step', '每次變化')}`;
      return `<div class="tsig-row ${cfg.on ? '' : 'off'}" data-comp="${c.id}"><div class="head"><label class="check"><input type="checkbox" data-k="on" ${cfg.on ? 'checked' : ''} ${t ? 'disabled' : ''}><b class="mono">${c.id}</b></label><span class="muted mono">${esc(pin ? board.pinLabel(pin) : b.pin)}</span>${kindSel}<select class="inp" data-k="pattern" ${t ? 'disabled' : ''} style="width:auto" aria-label="${c.id} 的變化方式">${pats}</select></div><div class="opts">${opts}</div>${pw && !pw.ok ? `<span class="hint">PWM 不能用：${esc(pw.msg)}</span>` : ''}</div>`;
    }).join('');
    const al = this.tsigAllowed();
    const iv = this.tsigInterval || 200;
    el.innerHTML = `<p class="hint">${head}</p><div class="tsig-rows">${rows}</div>
      <div class="tsig-bar"><label class="row" style="gap:4px;font-size:.84rem" for="tsigIv">每次寫入間隔<input class="inp" type="number" id="tsigIv" value="${iv}" min="${T.MIN_INTERVAL_MS}" max="${T.MAX_INTERVAL_MS}" step="10" style="width:6em" ${t ? 'disabled' : ''}> ms</label>
        ${!t ? `<button class="btn primary" id="tsigStart" ${al.ok ? '' : 'disabled'}>▶ 開始測試</button>` : `<button class="btn" id="tsigPause">${t.paused ? '▶ 繼續' : '❚❚ 暫停'}</button>`}
        <button class="btn" id="tsigStep" ${al.ok && (!t || t.paused) ? '' : 'disabled'} title="只寫一次（下一個值），方便在示波器上一筆一筆看">單步</button>
        <button class="btn danger" id="tsigStop" ${t ? '' : 'disabled'}>■ 停止</button></div>
      <p class="tsig-stat" id="tsigStat">${this.tsigStatText()}</p>${al.ok ? '' : `<p class="hint">${esc(al.msg)}</p>`}`;
    el.querySelectorAll('.tsig-row').forEach(r => {
      const c = DL.project.findComp(this.p, r.dataset.comp), cfg = this.tsigCfgOf(c);
      r.querySelectorAll('[data-k]').forEach(i => i.onchange = () => {
        const k = i.dataset.k;
        if (k === 'on') cfg.on = i.checked;
        else if (k === 'kind') Object.assign(cfg, { kind: i.value }, T.KINDS[i.value].def);
        else if (k === 'pattern') cfg.pattern = i.value;
        else cfg[k] = +i.value;
        this.renderTsig();
      });
    });
    const st = $('tsigStart'); if (st) st.onclick = () => this.tsigStart();
    const ps = $('tsigPause'); if (ps) ps.onclick = () => this.tsigPause(!this.tsig.paused);
    const sp = $('tsigStep'); if (sp) sp.onclick = () => this.tsigSingle();
    const so = $('tsigStop'); if (so) so.onclick = () => this.tsigStop('使用者停止');
    const ivi = $('tsigIv'); if (ivi) ivi.onchange = () => { this.tsigInterval = +ivi.value; };
  };
  P.tsigStatText = function () {
    const t = this.tsig; if (!t || !t.seq) return t && t.active ? '準備好了：按「單步」或「繼續」寫第一次' : '還沒有開始';
    return `${t.active ? (t.paused ? '已暫停' : '測試中') : '已停止'} · 第 <b>#${t.seq}</b> 次寫入：${esc(t.lastText || '')}`;
  };
  P.renderTsigLive = function () { const s = $('tsigStat'); if (s && this.tsig) { const h = this.tsigStatText(); if (s.innerHTML !== h) s.innerHTML = h; } };

  /* ---------- 執行 ---------- */
  P.tsigPrepare = async function () {
    const al = this.tsigAllowed(); if (!al.ok) { this.toast(al.msg, 'e'); return null; }
    const iv = this.tsigInterval || 200;
    if (!(iv >= T.MIN_INTERVAL_MS && iv <= T.MAX_INTERVAL_MS)) { this.toast(`間隔要在 ${T.MIN_INTERVAL_MS}–${T.MAX_INTERVAL_MS} ms`, 'e'); return null; }
    const items = [];
    for (const c of this.tsigOutputs()) {
      const cfg = this.tsigCfgOf(c); if (!cfg.on) continue;
      const v = T.validate(cfg); if (!v.ok) { this.toast(`${c.id}：${v.msg}`, 'e'); return null; }
      if (cfg.kind === 'pwm') { const pw = this.tsigPwmOk(c); if (!pw.ok) { this.toast(`${c.id}：${pw.msg}`, 'e'); return null; } }
      items.push({ c, cfg: Object.assign({}, cfg), gen: T.create(cfg), b: this.analysis.bindings[c.id] });
    }
    if (!items.length) { this.toast('請至少勾選一個輸出。', 'e'); return null; }
    if (this.sim.running) this.toggleRun();   // 行為先停下來：同一個輸出不能同時由行為和測試寫入
    const mode = this.twin.mode, t = { active: true, paused: true, seq: 0, items, mode, interval: iv, simPwm: {}, lastText: '' };
    if (mode === 'hw-control') for (const it of items) if (it.cfg.kind === 'pwm') await this.hw.driver.setKind({ num: it.b.num }, 'pwm');
    if (mode === 'sim') for (const it of items) if (it.cfg.kind === 'pwm') t.simPwm[it.c.id] = true;
    this.tsig = t;
    const desc = items.map(it => `${it.c.id} ${it.cfg.kind === 'digital' ? '亮滅交替' : `${T.PATTERNS[it.cfg.pattern].split('（')[0]} ${it.cfg.min}→${it.cfg.max}${T.KINDS[it.cfg.kind].unit}（每次 ${it.cfg.step}）`}`).join('、');
    this.log('s', `訊號測試開始（${mode === 'sim' ? '模擬預覽，不送到設備' : '送往' + (this.twin.conn.virtual ? '虛擬設備' : '真機')}，每 ${iv} ms）：${desc}`);
    return t;
  };
  P.tsigStart = async function () {
    if (this.tsig && this.tsig.active) return;
    const t = await this.tsigPrepare(); if (!t) return;
    this.tsigPause(false);
  };
  P.tsigPause = function (pause) {
    const t = this.tsig; if (!t || !t.active) return;
    clearInterval(t.timer); t.timer = null; t.paused = pause;
    if (!pause) { this.tsigStep(); t.timer = setInterval(() => this.tsigStep(), t.interval); }
    else if (t.seq) this.log('w', `訊號測試暫停（停在第 #${t.seq} 次寫入）`);
    this.renderTsig();
  };
  P.tsigSingle = async function () {
    if (!this.tsig || !this.tsig.active) { const t = await this.tsigPrepare(); if (!t) return; }
    if (!this.tsig.paused) return;
    this.tsigStep(); this.renderTsig();
  };
  P.tsigStep = function () {
    const t = this.tsig; if (!t || !t.active) return;
    if (this.twin.mode !== t.mode) { this.tsigStop('模式改變'); return; }
    t.seq++; const parts = [];
    for (const it of t.items) {
      const { c, cfg, b } = it, { v } = it.gen.next();
      const sig = cfg.kind === 'pwm' ? c.id + '.pwm' : sigOf(c);
      if (t.mode === 'sim') {
        if (cfg.kind === 'pwm') { this.twin.simulate(sigOf(c), v > 0 ? 1 : 0); this.wavePut(c.id, c.type, 'pwm', 'sim', v); }
        else this.twin.simulate(sig, v);
      } else {
        this.twin.target(sig, v, 'test');
        const r = this.twin.command(sig, v, 'test');
        if (r.ok && r.cmd && this.hw.driver) this.hw.driver.write(r.cmd, { num: b.num, kind: cfg.kind });
        else if (!r.ok) { this.log('e', `訊號測試 #${t.seq}：${c.id} 沒有送出（${r.msg}）`); this.tsigStop('命令不能送出'); return; }
      }
      const text = `${c.id} → ${fmtV(c, cfg.kind, v)}`; parts.push(text);
      if (this.waveMark) this.waveMark({ seq: t.seq, comp: c.id, text });
    }
    t.lastText = parts.join('、');
    this.log('', `訊號測試 #${t.seq}：${t.lastText}`);
  };
  // 停止：PWM 的腳位切回數位輸出並寫 LOW（Twin Core 的命令，狀態一致）；模擬只把預覽清掉
  P.tsigStop = async function (why, silent) {
    const t = this.tsig; if (!t || !t.active) return;
    clearInterval(t.timer); t.timer = null; t.active = false; t.simPwm = {};
    if (t.mode === 'hw-control' && this.twin.mode === 'hw-control' && this.hw.driver) {
      for (const it of t.items) if (it.cfg.kind === 'pwm') {
        await this.hw.driver.setKind({ num: it.b.num }, 'digital');
        const r = this.twin.command(sigOf(it.c), 0, 'test'); if (r.ok && r.cmd) this.hw.driver.write(r.cmd, { num: it.b.num, kind: 'digital' });
      }
    } else if (t.mode === 'sim') for (const it of t.items) if (it.cfg.kind === 'pwm') this.twin.simulate(sigOf(it.c), 0);
    if (!silent) this.log('w', `訊號測試停止（${why}）：共寫入 ${t.seq} 次`);
    if (this.ui && $('tsigBody')) this.renderTsig();
  };
  // 模式改變（撤銷授權、斷線、重新開機、斷線保護、連線）：測試的寫入不能再送，停止
  P.tsigOnMode = function (e) { const t = this.tsig; if (t && t.active && e.to !== t.mode) this.tsigStop(`模式改變：${DL.modeLabel(e.to, this.twin.conn.virtual)}`); else if (this.ui && $('tsigBody')) this.renderTsig(); };
})(typeof globalThis !== 'undefined' ? globalThis : this);
