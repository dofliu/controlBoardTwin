/* DofLab — 視覺積木（Blockly）
 * 積木 ↔ 行為 IR。積木裡的元件下拉選單直接列出配置中的實際元件（BTN1、LED1…）。
 * 頂層規則依畫面由上到下的位置排序；沒放進規則的積木會被忽略並提示。
 */
(function (root) {
  const DL = root.DL;
  let defined = false;

  function css(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

  function defineBlocks(app) {
    if (defined) return; defined = true;
    const B = root.Blockly;
    const compField = (type, name) => ({ type: 'field_dropdown', name: name || 'COMP', options: () => { const l = app.compIds(type); return l.length ? l.map(id => [id, id]) : [[`（沒有${DL.components[type].name}）`, '']]; } });
    const RULE = 24, COND = 168, ACT = 212;
    B.defineBlocksWithJsonArray([
      { type: 'dl_rule_while', message0: '當 %1 持續成立時', args0: [{ type: 'input_value', name: 'COND', check: 'DLCond' }],
        message1: '執行 %1', args1: [{ type: 'input_statement', name: 'DO', check: 'DLAction' }],
        message2: '條件結束時 %1', args2: [{ type: 'field_dropdown', name: 'END', options: [['熄滅／伺服回到初始角度', 'off'], ['保持最後狀態', 'keep']] }],
        message3: '再次成立時 %1', args3: [{ type: 'field_dropdown', name: 'RESTART', options: [['從頭開始（閃爍先亮）', 'restart'], ['接續先前的閃爍相位', 'resume']] }],
        colour: RULE, tooltip: '條件成立期間持續作用；結束與重新開始的處理都要明示。' },
      { type: 'dl_rule_event', message0: '每當 %1 %2', args0: [compField('BTN'), { type: 'field_dropdown', name: 'EVENT', options: [['被按下', 'press'], ['被放開', 'release']] }],
        message1: '執行一次 %1', args1: [{ type: 'input_statement', name: 'DO', check: 'DLAction' }], colour: RULE, tooltip: '去彈跳後的按下／放開瞬間執行一次。' },
      { type: 'dl_rule_start', message0: '程式開始時', message1: '執行一次 %1', args1: [{ type: 'input_statement', name: 'DO', check: 'DLAction' }], colour: RULE },
      { type: 'dl_cond_pressed', message0: '%1 被按住', args0: [compField('BTN')], output: 'DLCond', colour: COND },
      { type: 'dl_cond_light', message0: '%1 亮度 %2 %3 %%', args0: [compField('LDR'), { type: 'field_dropdown', name: 'OP', options: [['低於', 'lt'], ['高於', 'gt']] }, { type: 'field_number', name: 'VALUE', value: 30, min: 0, max: 100, precision: 1 }], output: 'DLCond', colour: COND },
      { type: 'dl_act_led', message0: '%1 %2', args0: [compField('LED'), { type: 'field_dropdown', name: 'STATE', options: [['亮', 'on'], ['熄滅', 'off']] }], previousStatement: 'DLAction', nextStatement: 'DLAction', colour: ACT },
      { type: 'dl_act_toggle', message0: '切換 %1（亮↔滅）', args0: [compField('LED')], previousStatement: 'DLAction', nextStatement: 'DLAction', colour: ACT, tooltip: '單次動作，只能放在事件或開始規則。' },
      { type: 'dl_act_blink', message0: '%1 閃爍：亮 %2 ms、暗 %3 ms', args0: [compField('LED'), { type: 'field_number', name: 'ON', value: 500, min: 10, max: 60000, precision: 1 }, { type: 'field_number', name: 'OFF', value: 500, min: 10, max: 60000, precision: 1 }], previousStatement: 'DLAction', nextStatement: 'DLAction', colour: ACT, tooltip: '只能放在「持續成立時」規則裡；不阻塞，等待期間仍能讀按鈕。' },
      { type: 'dl_act_servo', message0: '%1 命令轉到 %2 °', args0: [compField('SERVO'), { type: 'field_number', name: 'ANGLE', value: 90, min: 0, max: 180, precision: 1 }], previousStatement: 'DLAction', nextStatement: 'DLAction', colour: ACT, tooltip: '送出的是命令角度；SG90 沒有回授。' }
    ]);
  }

  const TOOLBOX = {
    kind: 'categoryToolbox',
    contents: [
      { kind: 'category', name: '規則', colour: '24', contents: [{ kind: 'block', type: 'dl_rule_while' }, { kind: 'block', type: 'dl_rule_event' }, { kind: 'block', type: 'dl_rule_start' }] },
      { kind: 'category', name: '條件', colour: '168', contents: [{ kind: 'block', type: 'dl_cond_pressed' }, { kind: 'block', type: 'dl_cond_light' }] },
      { kind: 'category', name: '動作', colour: '212', contents: [{ kind: 'block', type: 'dl_act_blink' }, { kind: 'block', type: 'dl_act_led' }, { kind: 'block', type: 'dl_act_toggle' }, { kind: 'block', type: 'dl_act_servo' }] }
    ]
  };

  function theme() {
    const B = root.Blockly;
    return B.Theme.defineTheme('doflab-' + Math.random().toString(36).slice(2, 6), {
      base: B.Themes.Classic,
      componentStyles: {
        workspaceBackgroundColour: css('--surface'), toolboxBackgroundColour: css('--surface-2'), toolboxForegroundColour: css('--ink'),
        flyoutBackgroundColour: css('--surface-3'), flyoutForegroundColour: css('--ink'), flyoutOpacity: 0.96, scrollbarColour: css('--line-strong'), insertionMarkerColour: css('--accent'), cursorColour: css('--accent')
      },
      fontStyle: { family: '"Noto Sans TC", "PingFang TC", sans-serif', size: 11 }
    });
  }

  class Blocks {
    constructor(app, host) {
      this.app = app; this.host = host; this.ws = null; this.suppress = false; this.readOnly = false;
      this.ok = !!root.Blockly;
      if (!this.ok) return;
      defineBlocks(app);
      const mq = root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)');
      mq && mq.addEventListener && mq.addEventListener('change', () => this.ws && this.ws.setTheme(theme()));
      new MutationObserver(() => this.ws && this.ws.setTheme(theme())).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }
    inject(readOnly) {
      if (!this.ok) return;
      const B = root.Blockly;
      if (this.ws) { this.ws.dispose(); this.ws = null; }
      this.readOnly = readOnly;
      this.ws = B.inject(this.host, {
        toolbox: readOnly ? null : TOOLBOX, readOnly, theme: theme(), trashcan: false, sounds: false, renderer: 'zelos',
        media: root.DOFLAB_BLOCKLY_MEDIA || 'vendor/blockly-media/',   // 不從 Blockly 預設的外部網站載入圖示
        // 預覽環境不允許載入外部圖片，所以不使用 Blockly 內建的縮放按鈕與垃圾桶圖示（拖回工具箱即可刪除）
        zoom: { controls: false, wheel: false, startScale: 0.78, maxScale: 1.6, minScale: 0.4, scaleSpeed: 1.15, pinch: true },
        move: { scrollbars: true, drag: true, wheel: true }, grid: { spacing: 24, length: 2, colour: css('--line'), snap: true }
      });
      this.ws.addChangeListener(e => {
        if (this.suppress || e.isUiEvent) return;
        if (e.type === B.Events.FINISHED_LOADING) return;
        clearTimeout(this.t); this.t = setTimeout(() => this.app.onBlocksChanged(this.toIR(), this.save()), 120);
      });
    }
    resize() { if (this.ws) root.Blockly.svgResize(this.ws); }
    save() { return this.ws ? root.Blockly.serialization.workspaces.save(this.ws) : null; }

    load(ir, saved, readOnly) {
      if (!this.ok) return;
      if (!this.ws || this.readOnly !== !!readOnly) this.inject(!!readOnly);
      this.suppress = true;
      try {
        const B = root.Blockly;
        // 以 IR 為準：保存的積木若與 IR 不一致（例如被手動改過 JSON），就從 IR 重建
        let usedSaved = false;
        if (saved) { try { B.serialization.workspaces.load(saved, this.ws); usedSaved = DL.stableStringify(this.toIR().ir) === DL.stableStringify(ir); } catch (e) { usedSaved = false; } }
        if (!usedSaved) B.serialization.workspaces.load(irToBlocks(ir), this.ws);
      } finally { this.suppress = false; }
      setTimeout(() => this.resize(), 0);
    }

    toIR() {
      const warnings = []; const rules = [];
      if (!this.ws) return { ir: { rules }, warnings };
      const tops = this.ws.getTopBlocks(true);
      const acts = first => { const out = []; for (let b = first; b; b = b.getNextBlock()) { if (!b.isEnabled()) continue; const a = actionOf(b); if (a) out.push(a); } return out; };
      for (const b of tops) {
        if (!b.isEnabled()) continue;
        if (b.type === 'dl_rule_while') {
          const c = b.getInputTargetBlock('COND');
          rules.push({ type: 'while', cond: c ? condOf(c) : null, actions: acts(b.getInputTargetBlock('DO')), onEnd: b.getFieldValue('END'), restart: b.getFieldValue('RESTART') });
        } else if (b.type === 'dl_rule_event') rules.push({ type: 'event', event: b.getFieldValue('EVENT'), comp: b.getFieldValue('COMP') || null, actions: acts(b.getInputTargetBlock('DO')) });
        else if (b.type === 'dl_rule_start') rules.push({ type: 'start', actions: acts(b.getInputTargetBlock('DO')) });
        else warnings.push('有積木沒有放進任何規則裡，已忽略（拖進「當…」「每當…」或「程式開始時」）。');
      }
      return { ir: { rules }, warnings: [...new Set(warnings)] };
    }
  }

  function condOf(b) {
    if (b.type === 'dl_cond_pressed') return { type: 'pressed', comp: b.getFieldValue('COMP') || null };
    if (b.type === 'dl_cond_light') return { type: 'light', comp: b.getFieldValue('COMP') || null, op: b.getFieldValue('OP'), value: Number(b.getFieldValue('VALUE')) };
    return null;
  }
  function actionOf(b) {
    const comp = b.getFieldValue('COMP') || null;
    if (b.type === 'dl_act_led') return { type: 'led', comp, on: b.getFieldValue('STATE') === 'on' };
    if (b.type === 'dl_act_toggle') return { type: 'toggle', comp };
    if (b.type === 'dl_act_blink') return { type: 'blink', comp, onMs: Math.round(Number(b.getFieldValue('ON'))), offMs: Math.round(Number(b.getFieldValue('OFF'))) };
    if (b.type === 'dl_act_servo') return { type: 'servo', comp, angle: Number(b.getFieldValue('ANGLE')) };
    return null;
  }

  // IR → Blockly 序列化 JSON（引導實驗與還原使用）
  function irToBlocks(ir) {
    const chain = actions => {
      let head = null, cur = null;
      for (const a of actions || []) {
        const blk = a.type === 'led' ? { type: 'dl_act_led', fields: { COMP: a.comp, STATE: a.on ? 'on' : 'off' } }
          : a.type === 'toggle' ? { type: 'dl_act_toggle', fields: { COMP: a.comp } }
            : a.type === 'blink' ? { type: 'dl_act_blink', fields: { COMP: a.comp, ON: a.onMs, OFF: a.offMs } }
              : { type: 'dl_act_servo', fields: { COMP: a.comp, ANGLE: a.angle } };
        if (!head) head = cur = blk; else { cur.next = { block: blk }; cur = blk; }
      }
      return head;
    };
    const blocks = (ir.rules || []).map((r, i) => {
      const y = 20 + i * 170;
      let b;
      if (r.type === 'while') {
        b = { type: 'dl_rule_while', x: 20, y, fields: { END: r.onEnd, RESTART: r.restart }, inputs: {} };
        if (r.cond) b.inputs.COND = { block: r.cond.type === 'pressed' ? { type: 'dl_cond_pressed', fields: { COMP: r.cond.comp } } : { type: 'dl_cond_light', fields: { COMP: r.cond.comp, OP: r.cond.op, VALUE: r.cond.value } } };
      } else if (r.type === 'event') b = { type: 'dl_rule_event', x: 20, y, fields: { COMP: r.comp, EVENT: r.event }, inputs: {} };
      else b = { type: 'dl_rule_start', x: 20, y, inputs: {} };
      const c = chain(r.actions); if (c) b.inputs.DO = { block: c };
      return b;
    });
    return { blocks: { languageVersion: 0, blocks } };
  }

  DL.ui = DL.ui || {}; DL.ui.Blocks = Blocks; DL.ui.irToBlocks = irToBlocks;
})(typeof globalThis !== 'undefined' ? globalThis : this);
