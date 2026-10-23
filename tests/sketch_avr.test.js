// 產生的 Uno 程式 → arduino-cli 編譯成真正的 AVR 機器碼 → 在 avr8js 虛擬 ATmega328P 上執行，
// 以韌體自己的 millis()（讀 RAM 中的 timer0_millis）為時間軸，和模擬引擎比較 LED／伺服輸出。
// 需要 arduino-cli 與 arduino:avr core；找不到時這組測試會標示 skip，而不是假裝通過。
const test = require('node:test'); const assert = require('node:assert');
const { execFileSync } = require('child_process'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { DL, solved, confirm } = require('./helpers'); const { VirtualUno } = require('../tools/vdev/avrsim');
let hasCli = true; try { execFileSync('arduino-cli', ['version']); } catch (e) { hasCli = false; }

function build(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-avr-')); const sk = path.join(dir, 'sketch'); fs.mkdirSync(sk);
  fs.writeFileSync(path.join(sk, 'sketch.ino'), code);
  const props = (process.env.DOFLAB_ARDUINO_PROPS || '').split(';').filter(Boolean).flatMap(p => ['--build-property', p]);
  execFileSync('arduino-cli', ['compile', '--fqbn', 'arduino:avr:uno', ...props, '--output-dir', path.join(dir, 'out'), sk], { stdio: 'pipe' });
  const elf = path.join(dir, 'out', 'sketch.ino.elf');
  const sym = execFileSync('avr-nm', [elf]).toString().split('\n').find(l => / timer0_millis$/.test(l));
  return { hex: path.join(dir, 'out', 'sketch.ino.hex'), millisAddr: parseInt(sym.split(' ')[0], 16) - 0x800000 };
}

// 在虛擬 MCU 上跑：schedule 以「模擬真實時間 ms」給定輸入；回傳 [millis, 輸出] 取樣，以及輸入在 millis 時間軸上的時刻
function runOnAvr(bin, totalMs, schedule, outs) {
  const u = new VirtualUno(bin.hex, { millisAddr: bin.millisAddr });
  const inputs = []; const samples = []; let k = 0; const s = schedule.slice().sort((a, b) => a.t - b.t);
  for (const x of s) if (x.t === 0) { x.apply(u); inputs.push({ m: 0, x }); k++; }
  for (let t = 0; t < totalMs; t += 0.25) {
    // 在 millis 剛跳號時才改變輸入，確保韌體在同一個 millis 值內一定會讀到（避免區間尾端的亞毫秒競態）
    while (k < s.length && s[k].t <= t) { const m0 = u.millis(); while (u.millis() === m0) u.step(16); s[k].apply(u); inputs.push({ m: u.millis(), x: s[k] }); k++; }
    u.runMs(0.25);
    samples.push([u.millis(), outs.map(o => o(u))]);
  }
  return { samples, inputs };
}

test('Uno 按住閃爍：真實 AVR 機器碼的輸出與模擬引擎一致（以韌體 millis 為時間軸）', { skip: !hasCli && '沒有 arduino-cli', timeout: 240000 }, () => {
  const p = solved('hold-blink', 'uno'); const bin = build(DL.codegen.generate(p).code);
  const btn = down => u => u.setInput(2, !down);
  const sch = [{ t: 0, apply: btn(false) }, { t: 300, apply: btn(true) }, { t: 1900, apply: btn(false) }, { t: 2400, apply: btn(true) }, { t: 2950, apply: btn(false) }];
  const { samples, inputs } = runOnAvr(bin, 3600, sch, [u => u.isHigh(13) ? 1 : 0]);
  // 引擎：用韌體 millis 時間軸上的輸入時刻
  const e = DL.createEngine(p); const exp = []; let j = 0; let pressed = false;
  const maxM = samples[samples.length - 1][0];
  // Arduino 的 millis() 每約 42 ms 會跳過一個值；韌體的迴圈只會看到「實際出現過」的 millis，引擎也只在這些值上執行
  const seen = [...new Set(samples.map(s => s[0]))].sort((a, b) => a - b);
  let last = 0;
  for (const m of seen) { while (j < inputs.length && inputs[j].m <= m) { pressed = inputs[j].x.t === 300 || inputs[j].x.t === 2400; j++; } e.setButton('BTN1', pressed); last = e.tick(m).out.LED1; exp[m] = last; }
  for (let m = 1; m <= maxM; m++) if (exp[m] === undefined) exp[m] = exp[m - 1];
  assert.ok(seen.length < maxM, '確實觀察到 millis 跳號（' + (maxM + 1 - seen.length) + ' 次）');
  // 比較轉換：真實韌體在一輪迴圈內先讀 millis()、後讀按鈕，可能用到前一個 millis 值（迴圈延遲），
  // 所以要求「轉換次數完全相同，且每次轉換時刻相差 ≤ 2 ms」；逐毫秒的邏輯等價另由主機端測試驗證。
  const fwT = []; let pv = samples[0][1][0];
  for (const [m, [v]] of samples) { if (v !== pv) { fwT.push([m, v]); pv = v; } }
  const enT = []; let pe = exp[0];
  for (let m = 1; m <= maxM; m++) if (exp[m] !== pe) { enT.push([m, exp[m]]); pe = exp[m]; }
  assert.ok(samples.length > 10000, '取樣數 ' + samples.length);
  assert.strictEqual(fwT.length, enT.length, `轉換次數：韌體 ${fwT.length}、引擎 ${enT.length}`);
  const worst = Math.max(...fwT.map((t, i) => Math.abs(t[0] - enT[i][0])));
  fwT.forEach((t, i) => assert.strictEqual(t[1], enT[i][1], '轉換方向一致'));
  assert.ok(worst <= 2, `最大時刻差 ${worst} ms`);
  console.log(`# 韌體轉換 ${fwT.length} 次，最大時刻差 ${worst} ms，millis 跳號 ${maxM + 1 - seen.length} 次`);
  // 文件範例的關鍵時間點（在韌體時間軸上）
  const at = m => samples.filter(s => s[0] === m).map(s => s[1][0]);
  const pressM = inputs.find(i => i.x.t === 300).m, relM = inputs.find(i => i.x.t === 1900).m;
  assert.deepStrictEqual([...new Set(at(pressM + 25))], [1], '去彈跳後先亮');
  assert.deepStrictEqual([...new Set(at(pressM + 20 + 520))], [0], '500 ms 後轉暗');
  assert.deepStrictEqual([...new Set(at(relM + 25))], [0], '放開後熄滅');
});

test('Uno 伺服事件：真實機器碼在 D9 輸出的脈寬對應命令角度', { skip: !hasCli && '沒有 arduino-cli', timeout: 240000 }, () => {
  const p = solved('servo-cmd', 'uno'); const bin = build(DL.codegen.generate(p).code);
  const u = new VirtualUno(bin.hex, { millisAddr: bin.millisAddr }); u.setInput(2, true);
  const pulses = []; let rise = null;
  u.pinWatchers.push(() => { const h = u.isHigh(9); if (h && rise === null) rise = u.cpu.cycles; else if (!h && rise !== null) { pulses.push(Math.round((u.cpu.cycles - rise) / 16)); rise = null; } });
  const widthAfter = ms => { pulses.length = 0; u.runMs(ms); return pulses[pulses.length - 1]; };
  const w90 = widthAfter(300); u.setInput(2, false); const w150 = widthAfter(300); u.setInput(2, true); const w30 = widthAfter(300);
  assert.ok(Math.abs(w90 - 1472) < 40, '初始 90° 脈寬 ' + w90);
  assert.ok(w150 > w90 + 250 && w30 < w90 - 250, `150°=${w150} µs、30°=${w30} µs`);
});
