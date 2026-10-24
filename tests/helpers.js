// 載入核心模組（與瀏覽器相同的原始檔）
const path = require('path');
for (const f of ['boards', 'breadboard', 'components', 'project', 'netlist', 'behavior', 'engine', 'codegen', 'experiments', 'twin', 'session', 'arm', 'routing', 'autowire'])
  try { require(path.join(__dirname, '..', 'src', 'core', f + '.js')); } catch (e) { if (!/Cannot find module/.test(e.message)) throw e; }
const DL = globalThis.DL;
function confirm(p) { p.behavior.confirmed = { inputs: DL.project.inputsHash(p, DL.codegen.GENERATOR_VERSION), at: 'test' }; return p; }
function solved(exp, board) { const r = DL.experiments.solved(exp, board); if (!r.ok) throw new Error(r.msg); return confirm(r.project); }
// 以 1 ms 步進跑引擎；schedule: [{t, comp, pressed}|{t, comp, raw}|{t, comp, cm}]
function runEngine(p, T, schedule) {
  const e = DL.createEngine(p); const rows = []; let k = 0; const s = schedule.slice().sort((a, b) => a.t - b.t);
  for (let t = 0; t <= T; t++) {
    while (k < s.length && s[k].t <= t) { const ev = s[k++]; if ('pressed' in ev) e.setButton(ev.comp, ev.pressed); else if ('cm' in ev) e.setDistance(ev.comp, ev.cm); else e.setAdcRaw(ev.comp, ev.raw); }
    rows.push(e.tick(t).out);
  }
  return rows;
}
module.exports = { DL, confirm, solved, runEngine };
