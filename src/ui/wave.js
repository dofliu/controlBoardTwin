/* DofLab — 觀測頁的訊號波形（V2.14）：記錄、暫停與往回看、擷取 A／B 上下並排比較、存檔
 * 記錄的是「變化」：模擬層每一幀取樣（有變才記）；命令與量測依 Twin Core 事件收到的時刻（不受畫面快慢影響）；訊號測試的每一次寫入有序號標記。
 * 時間一律用 Date.now()（和 Twin Core 相同）。保留最近 3 分鐘。資料格式與擷取在 src/core/testsig.js（DL.wave）。
 */
(function (root) {
  const DL = root.DL; const App = DL.ui.App; const esc = DL.ui.esc;
  const $ = id => document.getElementById(id);
  const P = App.prototype;
  const KEEP_MS = 180000;
  const LAYERS = [['sim', '--sim', 2, '模擬'], ['cmd', '--cmd', 2, '命令'], ['meas', '--meas', 2.5, '量測']];
  const { sigOf } = DL.ui.obs;
  const rowsOf = p => p.components.filter(sigOf).map(c => ({ id: c.id, ctype: c.type }));

  P.waveReset = function () {
    const keep = this.wave ? this.wave.caps : {};
    this.wave = { evs: [], marks: [], last: {}, span: (this.wave && this.wave.span) || 6000, paused: null, back: 0, caps: keep || {} };
    if (this.ui && $('wavePause')) this.renderWaveBar();
  };
  // 一條線（元件|層）有變化才記
  P.wavePut = function (comp, ctype, sig, layer, v, t) {
    const w = this.wave; if (!w) return;
    const k = comp + '|' + layer, n = DL.wave.norm(ctype, sig, v);
    if (w.last[k] === n) return; w.last[k] = n;
    w.evs.push({ t: t || Date.now(), k, v: n });
    if (w.evs.length % 500 === 0) { const cut = Date.now() - KEEP_MS; let i = 0; while (i < w.evs.length && w.evs[i].t < cut) i++; if (i) w.evs.splice(0, i); while (w.marks.length && w.marks[0].t < cut) w.marks.shift(); }
  };
  // Twin Core 事件：命令（commanded）與量測（measured）依事件的時刻記下
  P.waveTwin = function (e) {
    if (e.type !== 'command' && e.type !== 'measure') return;
    const dot = e.name.indexOf('.'), comp = e.name.slice(0, dot), sig = e.name.slice(dot + 1);
    const c = this.p && DL.project.findComp(this.p, comp); if (!c) return;
    this.wavePut(comp, c.type, sig, e.type === 'command' ? 'cmd' : 'meas', e.v, e.t);
  };
  // 模擬層：每一幀看一次（觀測頁的 frame 呼叫）；訊號測試在模擬裡預覽 PWM 時，那個 LED 由測試直接記
  P.sample = function () {
    if (!this.p || !this.wave) return; const t = Date.now(), skip = (this.tsig && this.tsig.simPwm) || {};
    for (const c of this.p.components) { const s = sigOf(c); if (!s || skip[c.id]) continue; const v = this.twin.view(s).simulated; this.wavePut(c.id, c.type, s.split('.')[1], 'sim', v ? v.v : null, t); }
  };
  P.waveMark = function (m) { if (this.wave) this.wave.marks.push(Object.assign({ t: Date.now() }, m)); };

  /* ---------- 畫圖（即時與擷取共用） ---------- */
  // data：{ init, evs }（init 是 t0 時每條線的值），marks：[{t, seq, comp}]，畫 [t0, t0 + span]；axis：'ago'（-6s…0s）或 'from'（0s…6s）
  function drawWave(cv, rows, data, marks, t0, span, axis, dEnd) {
    if (!cv || !cv.offsetParent) return;
    const dpr = Math.min(2, root.devicePixelRatio || 1), W = cv.clientWidth, H = cv.clientHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    if (!rows.length) return;
    const L = 64, R = 8, top = 4, bottom = 16, rowH = Math.min(46, (H - top - bottom) / rows.length), t1 = t0 + span;
    const x = t => L + (W - L - R) * ((t - t0) / span);
    g.font = '600 11px "IBM Plex Mono", monospace'; g.textBaseline = 'middle';
    // 時間格線：大約 6 格
    const stepS = [0.25, 0.5, 1, 2, 5, 10, 20, 30, 60].find(s => span / 1000 / s <= 7) || 60;
    g.strokeStyle = css('--line'); g.lineWidth = 1; g.fillStyle = css('--muted');
    for (let s = 0; s <= span / 1000 + 1e-9; s += stepS) {
      const xx = axis === 'from' ? x(t0 + s * 1000) : x(t1 - s * 1000);
      g.beginPath(); g.moveTo(xx, top); g.lineTo(xx, H - bottom + 2); g.stroke();
      const lab = axis === 'from' ? `${+s.toFixed(2)}s` : (s ? `-${+s.toFixed(2)}s` : '0s'); g.fillText(lab, Math.min(W - R - 24, Math.max(L, xx - 9)), H - 6);
    }
    const byKey = {}; for (const e of data.evs) (byKey[e.k] = byKey[e.k] || []).push(e);
    rows.forEach((c, i) => {
      const y0 = top + 2 + i * rowH, y1 = y0 + rowH - 8;
      g.fillStyle = css('--ink'); g.fillText(c.id, 6, (y0 + y1) / 2);
      for (const [layer, color, w] of LAYERS) {
        const k = c.id + '|' + layer; let v = data.init[k]; const list = byKey[k] || [];
        if ((v === undefined || v === null) && !list.length) continue;
        g.strokeStyle = css(color); g.lineWidth = w; g.beginPath(); let pen = false, cx = x(t0);
        const seg = (nx, val) => { if (val === null || val === undefined) { pen = false; return; } const yy = y1 - val * (y1 - y0); if (!pen) { g.moveTo(cx, yy); pen = true; } g.lineTo(nx, yy); };
        for (const e of list) { const nx = x(e.t); seg(nx, v); if (pen && e.v !== null) g.lineTo(nx, y1 - e.v * (y1 - y0)); v = e.v; cx = nx; }
        seg(x(Math.min(t1, Date.now(), dEnd || Infinity)), v); g.stroke();
      }
      // 訊號測試的寫入：細的直線＋序號（太擠時隔幾個才寫序號）
      const ms = marks.filter(m => m.comp === c.id && m.t >= t0 && m.t <= t1);
      if (ms.length) {
        g.strokeStyle = css('--tsig'); g.fillStyle = css('--tsig'); g.lineWidth = 1; g.font = '600 9px "IBM Plex Mono", monospace';
        let lastX = -1e9;
        for (const m of ms) { const xx = x(m.t); g.beginPath(); g.moveTo(xx, y0 - 1); g.lineTo(xx, y0 + 5); g.stroke(); if (xx - lastX > 26) { g.fillText('#' + m.seq, xx + 2, y0 + 3); lastX = xx; } }
        g.font = '600 11px "IBM Plex Mono", monospace';
      }
    });
    g.fillStyle = css('--muted'); g.font = '500 10px "Noto Sans TC", sans-serif';
    let lx = W - R - 236;
    for (const [, color, , label] of LAYERS) { g.fillStyle = css(color); g.fillRect(lx, H - 9, 10, 3); g.fillStyle = css('--muted'); g.fillText(label, lx + 14, H - 7); lx += 52; }
    g.fillStyle = css('--tsig'); g.fillRect(lx, H - 12, 1.5, 7); g.fillStyle = css('--muted'); g.fillText('測試寫入 #', lx + 6, H - 7);
  }

  // 即時：最近 span 毫秒；暫停時停在按下暫停的那一刻，可以往回看
  P.waveEnd = function () { const w = this.wave; return w.paused ? w.paused - w.back * 1000 : Date.now(); };
  P.drawTrace = function () {
    const w = this.wave; if (!w || !this.p) return;
    const end = this.waveEnd(), t0 = end - w.span;
    drawWave($('trace'), rowsOf(this.p), DL.wave.slice(w.evs, t0, end), w.marks, t0, w.span, 'ago');
  };

  /* ---------- 控制列 ---------- */
  P.bindWave = function () {
    this.waveReset();
    $('waveSpan').onchange = e => { this.wave.span = +e.target.value; this.renderWaveBar(); };
    $('wavePause').onclick = () => { const w = this.wave; if (w.paused) { w.paused = null; w.back = 0; } else w.paused = Date.now(); this.renderWaveBar(); };
    $('waveBack').oninput = e => { this.wave.back = +e.target.value; this.renderWaveBar(true); };
    $('waveCapA').onclick = () => this.waveCapture('A');
    $('waveCapB').onclick = () => this.waveCapture('B');
    $('waveClear').onclick = () => { this.wave.caps = {}; this.renderWaveCmp(); this.renderWaveBar(); };
    $('waveSave').onclick = () => this.waveSave();
    $('waveOpen').onclick = () => $('waveFile').click();
    $('waveFile').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) f.text().then(t => this.waveLoad(t)).catch(err => this.toast('讀不到檔案：' + err.message, 'e')); };
    this.renderWaveBar();
  };
  P.renderWaveBar = function (sliderOnly) {
    const w = this.wave; if (!w || !$('wavePause')) return;
    const avail = w.evs.length ? Math.max(0, Math.floor(((w.paused || Date.now()) - w.evs[0].t - w.span) / 1000)) : 0;
    const bk = $('waveBack'); bk.hidden = !w.paused; bk.max = String(avail); if (+bk.value !== w.back) bk.value = String(w.back);
    $('waveBackLab').textContent = w.paused ? (w.back ? `往回 ${w.back} 秒` : '暫停中（拖動拉桿往回看）') : '';
    if (sliderOnly) return;
    $('wavePause').textContent = w.paused ? '▶ 繼續' : '❚❚ 暫停畫面'; $('wavePause').setAttribute('aria-pressed', String(!!w.paused));
    $('waveTitle').textContent = `（${w.paused ? '已暫停' : '最近'} ${w.span / 1000} 秒）`;
    $('waveSpan').value = String(w.span);
    $('waveSave').disabled = !Object.keys(w.caps).length;
  };
  P.waveCapture = function (k) {
    const w = this.wave, end = this.waveEnd(), t0 = end - w.span;
    const ms = w.marks.filter(m => m.t >= t0 && m.t <= end).map(m => m.seq);
    const meta = { at: new Date(end).toISOString(), project: this.p.name, board: this.p.board.type, mode: DL.modeLabel(this.twin.mode, this.twin.conn.virtual), device: this.twin.conn.state === 'connected' ? this.twin.conn.info : null, rows: rowsOf(this.p), seq: ms.length ? [Math.min(...ms), Math.max(...ms)] : null };
    w.caps[k] = DL.wave.capture(w, t0, end, meta);
    this.log('', `波形擷取為 ${k}：${w.span / 1000} 秒（${meta.mode}${meta.seq ? `，測試寫入 #${meta.seq[0]}–#${meta.seq[1]}` : ''}）`);
    this.renderWaveCmp(); this.renderWaveBar();
  };
  const capLabel = (k, c) => {
    if (!c) return `<b>${k}</b><span class="muted">（還沒有擷取：按「擷取為 ${k}」）</span>`;
    const m = c.meta || {}, at = m.at ? new Date(m.at).toLocaleString() : '';
    return `<b>${k}</b> ${esc(at)} · ${esc(m.mode || '')}${m.device ? ' · ' + esc(m.device) : ''} · ${c.span / 1000} 秒${m.seq ? ` · 測試寫入 #${m.seq[0]}–#${m.seq[1]}` : ''}${m.project ? ` · <span class="muted">${esc(m.project)}</span>` : ''}`;
  };
  P.renderWaveCmp = function () {
    const caps = this.wave.caps, any = !!(caps.A || caps.B); $('waveCmp').hidden = !any; if (!any) return;
    for (const k of ['A', 'B']) $('waveLab' + k).innerHTML = capLabel(k, caps[k]);
    this.drawWaveCmp();
  };
  // 上下並排：兩張圖的時間軸都從擷取的起點算起，刻度相同（取較長的那一段）
  P.drawWaveCmp = function () {
    const caps = this.wave && this.wave.caps; if (!caps || $('waveCmp').hidden) return;
    const span = Math.max(caps.A ? caps.A.span : 0, caps.B ? caps.B.span : 0);
    for (const k of ['A', 'B']) {
      const c = caps[k], cv = $('wave' + k); if (!cv) continue;
      if (!c) { const g = cv.getContext('2d'); g.clearRect(0, 0, cv.width, cv.height); continue; }
      drawWave(cv, (c.meta && c.meta.rows) || [], { init: c.init, evs: c.evs }, c.marks || [], c.t0, span, 'from', c.t1);
    }
  };
  P.waveSave = function () {
    const o = DL.wave.toFile(this.wave.caps, { project: this.p.name, board: this.p.board.type });
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(o)], { type: 'application/json' }));
    a.download = `doflab-波形-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`; document.body.appendChild(a); a.click(); a.remove();
    this.log('s', '波形擷取已存檔（A、B）');
  };
  P.waveLoad = function (text) {
    let o; try { o = JSON.parse(text); } catch (e) { this.toast('檔案不是 JSON', 'e'); return; }
    const r = DL.wave.fromFile(o); if (!r.ok) { this.toast(r.msg, 'e'); return; }
    this.wave.caps = r.captures; this.log('s', `已開啟波形擷取檔（${Object.keys(r.captures).join('、')}）`);
    this.renderWaveCmp(); this.renderWaveBar();
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
