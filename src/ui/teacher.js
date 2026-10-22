/* DofLab — 教師模式：接線助手（建議下一條線、接一條、全部自動完成）、指定腳位、存成引導實驗
 * 學生在引導實驗中（老師允許時）只能看「提示下一條線」，不會自動接線。
 */
(function (root) {
  const DL = root.DL; const P = DL.ui.App.prototype;
  const $ = id => document.getElementById(id);
  const esc = DL.ui.esc;
  const TKEY = 'doflab.teacher', XKEY = 'doflab.teacherExps';
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };

  P.teacherInit = function () {
    this.teacher = { on: !!lsGet(TKEY, false), fixWrong: false, addParts: true, hint: false };
    const b = $('btnTeacher'); if (b) b.onclick = () => this.setTeacher(!this.teacher.on);
    this.renderTeacherBtn();
  };
  P.setTeacher = function (on) {
    this.teacher.on = on; lsSet(TKEY, on); this.renderTeacherBtn();
    this.toast(on ? '教師模式：右側出現「接線助手」，元件可以指定腳位，也可以把目前的配置存成引導實驗。' : '已關閉教師模式。');
    this.renderAll();
  };
  P.renderTeacherBtn = function () { const b = $('btnTeacher'); if (b) { b.setAttribute('aria-pressed', String(!!this.teacher.on)); b.classList.toggle('on', !!this.teacher.on); } };

  P.awOpts = function () { return { fixWrong: this.teacher.fixWrong, addParts: this.teacher.addParts && !this.p.lock.components }; };

  // 右側卡片：老師看到完整的助手；學生在允許提示的引導實驗中只看到「提示下一條線」
  P.renderAssist = function () {
    const card = $('assistCard'); if (!card || !this.p || !this.teacher) return;
    const exp = DL.experiments.forProject(this.p);
    const studentHints = !this.teacher.on && this.p.origin.kind === 'guided' && exp && exp.allowHints;
    if (!this.teacher.on && !studentHints) { card.hidden = true; this.scene.setSuggest && this.scene.setSuggest(null); return; }
    card.hidden = false;
    const pl = DL.autowire.plan(this.p, this.awOpts()); this._awPlan = pl;
    const board = DL.boards[this.p.board.type];
    const todo = pl.steps.filter(s => s.kind === 'wire').length, parts = pl.steps.filter(s => s.kind === 'part'), rem = pl.steps.filter(s => s.kind === 'remove');
    const next = pl.steps[0];
    $('assistCount').textContent = pl.done ? '完成' : todo ? `還缺 ${todo} 條` : '';
    const iss = pl.issues.map(i => `<li class="${i.level === 'error' ? 'error' : 'warn'}"><span class="lv ${i.level === 'error' ? 'error' : 'warn'}">${i.level === 'error' ? '做不到' : '注意'}</span><span>${esc(i.msg)}</span></li>`).join('');
    const nextHtml = next ? `<div class="aw-next"><b>${next.kind === 'remove' ? '先移除' : next.kind === 'part' ? '先加元件' : '下一條線'}</b>${next.kind === 'wire' ? `<span class="mono">${esc(next.text)}</span>` : next.kind === 'remove' ? `<span class="mono">${esc(next.id)}</span>` : `<span class="mono">${esc(next.id)}</span>`}<span>${esc(next.why)}</span></div>` : (pl.done ? '<p class="hint" style="color:var(--ok)">接線已完成，電路檢查沒有錯誤。</p>' : '');
    if (!this.teacher.on) {   // 學生：只給提示
      card.querySelector('h3').firstChild.textContent = '提示 ';
      $('assistBody').innerHTML = (this.teacher.hint && next ? nextHtml : '') + `<div class="row"><button class="btn" id="awHint">${this.teacher.hint ? '隱藏提示' : '提示下一條線'}</button></div><p class="hint">提示只告訴你下一步，不會幫你接線。</p>`;
      $('awHint').onclick = () => { this.teacher.hint = !this.teacher.hint; this.renderAssist(); };
      this.scene.setSuggest && this.scene.setSuggest(this.teacher.hint && next && next.kind === 'wire' ? next : null);
      return;
    }
    card.querySelector('h3').firstChild.textContent = '接線助手 ';
    const pinRows = Object.entries(pl.pins).map(([id, pin]) => { const c = DL.project.findComp(this.p, id); return `<li><span class="mono">${esc(id)}</span><span>${esc(board.pinLabel(board.pinById[pin]))}</span><span class="muted">${c && c.prefPin ? '老師指定' : this.analysis.bindings[id] ? '已接好' : '自動選擇'}</span></li>`; }).join('');
    const custom = this.p.origin.kind !== 'guided';
    $('assistBody').innerHTML = nextHtml
      + (iss ? `<ul class="issues">${iss}</ul>` : '')
      + `<div class="row"><button class="btn" id="awOne" ${next ? '' : 'disabled'}>接這一條</button><button class="btn primary" id="awAll" ${next ? '' : 'disabled'}>全部自動完成</button></div>
        <label class="check"><input type="checkbox" id="awFix" ${this.teacher.fixWrong ? 'checked' : ''}><span>移除接錯的線${rem.length ? `（${rem.length} 條）` : ''}</span></label>
        <label class="check"><input type="checkbox" id="awAdd" ${this.teacher.addParts ? 'checked' : ''} ${this.p.lock.components ? 'disabled' : ''}><span>補上缺少的元件（LED 的限流電阻、多顆伺服的外部電源）${parts.length ? `：會加 ${parts.map(x => x.id).join('、')}` : ''}</span></label>
        ${pinRows ? `<p class="sec-t" style="margin-top:8px">腳位</p><ul class="aw-pins">${pinRows}</ul><p class="hint">點元件後可以在左側「選取項目」指定腳位；自動接線會照著做。</p>` : ''}
        ${custom ? '<div class="row" style="margin-top:6px"><button class="btn" id="awGuide">存成引導實驗…</button></div>' : '<p class="hint">這是引導實驗；老師可以用助手示範接線或看解答。</p>'}`;
    $('awOne').onclick = () => this.awApply(1);
    $('awAll').onclick = () => this.awApply();
    $('awFix').onchange = e => { this.teacher.fixWrong = e.target.checked; this.renderAssist(); };
    $('awAdd').onchange = e => { this.teacher.addParts = e.target.checked; this.renderAssist(); };
    const g = $('awGuide'); if (g) g.onclick = () => this.openGuideDialog();
    this.scene.setSuggest && this.scene.setSuggest(next && next.kind === 'wire' ? next : null);
  };

  P.awApply = function (n) {
    const r = DL.autowire.apply(this.p, this.awOpts(), n);
    if (r.error) { this.toast(r.error, 'e'); return; }
    if (!r.done.length) { this.toast('沒有可以自動接的線。', 'e'); return; }
    for (const s of r.done) this.log('s', `接線助手：${s.kind === 'wire' ? s.text : s.kind === 'part' ? '加入 ' + s.id : '移除 ' + s.id}（${s.why}）`);
    const last = r.done[r.done.length - 1];
    this.changed('circuit', n === 1 ? (last.kind === 'wire' ? `已接：${last.text}` : last.why) : `接線助手完成 ${r.done.length} 步${r.plan.done ? '，接線完成' : ''}`);
  };

  // 選取元件時：老師可以指定腳位
  P.prefPinHtml = function (c) {
    if (!this.teacher || !this.teacher.on) return '';
    const need = { LED: ['dout'], BTN: ['din', 'pullup'], LDR: ['adc'], SERVO: ['servo'] }[c.type]; if (!need) return '';
    const board = DL.boards[this.p.board.type];
    const opts = board.pins.filter(x => x.kind === 'gpio' && need.every(k => x.caps.includes(k)));
    return `<label class="field"><span>指定腳位（教師模式；自動接線會照這個腳位）</span><select class="inp" id="prefPin"><option value="">自動選擇</option>${opts.map(x => `<option value="${x.id}" ${c.prefPin === x.id ? 'selected' : ''}>${esc(board.pinLabel(x))}${x.notes.some(n => n.level === 'warn') ? '（注意）' : ''}</option>`).join('')}</select></label>`;
  };
  P.bindPrefPin = function (c) {
    const s = $('prefPin'); if (!s) return;
    s.onchange = () => { if (s.value) c.prefPin = s.value; else delete c.prefPin; this.renderAssist(); this.renderHeader(); this.toast(s.value ? `${c.id} 指定為 ${s.options[s.selectedIndex].text}` : `${c.id} 改回自動選擇腳位`); };
  };

  /* ---------- 存成引導實驗 ---------- */
  P.openGuideDialog = function () {
    const p = this.p; const d = $('dlgGuide');
    const sum = (() => { try { return DL.behavior.summarize(p).lines.map(l => l.text).join(' '); } catch (e) { return ''; } })();
    $('gTitle').value = p.name.replace(/^我的專案/, '').replace(/[（(].*[)）]$/, '').trim() || '我的實驗';
    $('gGoal').value = sum.slice(0, 300);
    $('gStrict').checked = false; $('gHints').checked = true; $('gMsg').textContent = '';
    $('gSave').onclick = () => {
      const r = DL.experiments.fromTeacher(p, { title: $('gTitle').value.trim(), goal: $('gGoal').value.trim(), strictPins: $('gStrict').checked, allowHints: $('gHints').checked });
      if (!r.ok) { $('gMsg').innerHTML = `<span style="color:var(--err)">${esc(r.msg)}</span>`; return; }
      const list = lsGet(XKEY, []); list.unshift({ id: r.custom.id, title: r.custom.title, board: r.custom.board, at: r.custom.createdAt, json: DL.project.serialize(r.project) });
      if (!lsSet(XKEY, list.slice(0, 40))) { $('gMsg').innerHTML = '<span style="color:var(--err)">瀏覽器不允許保存；請用下面的「複製學生版 JSON」分享。</span>'; }
      this._lastGuide = r;
      $('gMsg').innerHTML = `已存成引導實驗「${esc(r.custom.title)}」（解答 ${r.solutionSteps} 步）。學生版已拿掉導線、鎖定元件與行為。<div class="row" style="margin-top:6px"><button class="btn" id="gCopy">複製學生版 JSON</button><button class="btn primary" id="gOpen">開啟學生版試做</button></div>`;
      $('gCopy').onclick = () => this.copy(DL.project.serialize(r.project));
      $('gOpen').onclick = () => { d.close(); this.load(DL.project.deserialize(DL.project.serialize(r.project)).project, { note: '這是學生看到的樣子：依右側任務接線。' }); this.setTab('config'); };
      this.log('s', `存成引導實驗「${r.custom.title}」`);
    };
    d.showModal();
  };
  // 開始對話框裡的「老師自訂的實驗」
  P.renderMyExps = function () {
    const el = $('myExpList'); if (!el) return;
    const list = lsGet(XKEY, []);
    el.innerHTML = list.length ? list.map((x, i) => `<div class="exp"><h4>${esc(x.title)}</h4><p>${esc(DL.boards[x.board] ? DL.boards[x.board].short : x.board)} · ${new Date(x.at).toLocaleString()}</p><div class="row"><button class="btn sm" data-myopen="${i}">開啟（學生版）</button><button class="btn sm" data-mycopy="${i}">複製 JSON</button><button class="btn sm danger" data-mydel="${i}">刪除</button></div></div>`).join('')
      : '<p class="hint">還沒有。開啟教師模式，在自訂專案的「接線助手」按「存成引導實驗」。學生可以在「專案與版本」匯入老師給的 JSON。</p>';
    el.querySelectorAll('[data-myopen]').forEach(b => b.onclick = () => { const r = DL.project.deserialize(list[+b.dataset.myopen].json); if (!r.ok) { this.toast(r.msg, 'e'); return; } $('dlgStart').close(); this.load(r.project, { note: '依右側「引導任務」完成接線，再到「行為」確認、到「觀測」模擬。' }); this.setTab('config'); });
    el.querySelectorAll('[data-mycopy]').forEach(b => b.onclick = () => this.copy(list[+b.dataset.mycopy].json));
    el.querySelectorAll('[data-mydel]').forEach(b => b.onclick = () => { list.splice(+b.dataset.mydel, 1); lsSet(XKEY, list); this.renderMyExps(); });
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
