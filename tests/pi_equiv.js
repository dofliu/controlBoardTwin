// 輸出：產生的 Pi 程式 + 以 5 ms 步進跑引擎的預期輸出時間線（JSON）
// 不帶參數：按住閃爍（原本的測試）。帶 JSON 參數：{"exp":"toggle-led","press":{"BTN1":[[100,300]]},"outs":["LED1"],"T":2000}
const { DL, solved } = require('./helpers');
const arg = process.argv[2] ? JSON.parse(process.argv[2]) : null;
if (!arg) {
  const p = solved('hold-blink', 'pi4b'); const code = DL.codegen.generate(p).code;
  const press = [[100, 1300], [1700, 2350]]; const held = t => press.some(([a, b]) => t >= a && t < b);
  const e = DL.createEngine(p); const exp = [];
  for (let t = 0; t <= 3000; t += 5) { e.setButton('BTN1', held(t)); exp.push([t, e.tick(t).out.LED1]); }
  process.stdout.write(JSON.stringify({ code, press, exp }));
} else {
  const p = solved(arg.exp, 'pi4b'); const code = DL.codegen.generate(p).code; const a = DL.netlist.analyze(p).bindings;
  const pins = Object.fromEntries(Object.entries(a).map(([k, b]) => [k, DL.boards.pi4b.pinById[b.pin].num]));
  const e = DL.createEngine(p); const exp = [];
  for (let t = 0; t <= arg.T; t += 5) {
    for (const [btn, ranges] of Object.entries(arg.press)) e.setButton(btn, ranges.some(([x, y]) => t >= x && t < y));
    const o = e.tick(t).out; exp.push([t, arg.outs.map(id => Number(o[id]))]);
  }
  process.stdout.write(JSON.stringify({ code, pins, exp }));
}
