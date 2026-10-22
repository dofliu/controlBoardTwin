// 測試工具：把虛擬 Uno（含 Optiboot）接到一個 pty，讓 avrdude／arduino-cli upload 以為接了一塊真的 Uno。
// 用法：node pty_uno.js /tmp/ttyX   上傳完成並驗證新程式後，在 stdout 印出一行 JSON 結果再結束。
// 重置的模擬：實體 Uno 在 avrdude 開啟連接埠時由 USB 晶片的 DTR 經電容觸發重置，Optiboot 接著等待約 1 秒。
// pty 沒有 DTR，所以這裡在等待上傳期間讓晶片一直停在 Optiboot（逾時跳到應用程式就再重置一次），效果等同「開埠即重置」。
const fs = require('fs'); const path = require('path');
const { VirtualUno, RESET } = require('./avrsim');
const FX = path.join(__dirname, '..', 'fixtures');
const u = new VirtualUno(path.join(FX, 'DofLabFirmata-uno.hex'), { bootloader: fs.readFileSync(path.join(FX, 'optiboot_atmega328.hex'), 'utf8') });
u.setInput(2, true);
const fd = fs.openSync(process.argv[2], 'r+');
let out = []; u.onSerial = b => out.push(b);
let phase = 'wait', holds = 0, done = false, mark = -1;
const hold = () => { u.reset(); out = []; holds++; };
hold();
fs.createReadStream(null, { fd, autoClose: false }).on('data', chunk => u.sendBytes([...chunk]));
const t0 = Date.now();
const iv = setInterval(() => {
  u.runMs(10);
  if (phase === 'wait' && u.cpu.pc < 0x3f00 && u.spmLog.write === 0) hold();   // 還沒開始上傳就逾時：重新進入 Optiboot
  if (out.length) { fs.writeSync(fd, Buffer.from(out)); out = []; }
  if (mark < 0 && u.spmLog.write > 0) mark = u.resets.length;   // 開始寫入之後的重置才算「上傳完成後重啟」
  if (phase === 'wait' && mark >= 0 && u.resets.slice(mark).some(r => r.flags === RESET.WDRF)) { phase = 'run'; setTimeout(check, 300); }
  if (process.env.PTY_DEBUG && Date.now() % 2000 < 10) process.stderr.write(JSON.stringify({ phase, pc: u.cpu.pc, w: u.spmLog.write, holds }) + '\n');
  if (Date.now() - t0 > 150000 && !done) finish({ ok: false, why: 'timeout' });
}, 10);
function check() {
  if (process.env.PTY_DEBUG) process.stderr.write('check\n');
  u.setInput(2, false); const seen = new Set(); let n = 0;
  const s = setInterval(() => { seen.add(u.isHigh(13)); if (++n > 40) { clearInterval(s); u.setInput(2, true); setTimeout(() => finish({ ok: true, pagesWritten: u.spmLog.write, blink: [...seen].sort(), offAfterRelease: !u.isHigh(13) }), 200); } }, 60);
}
function finish(r) { done = true; clearInterval(iv); if (process.env.PTY_DEBUG) process.stderr.write('finish ' + JSON.stringify(r) + '\n'); fs.writeSync(1, JSON.stringify(r) + '\n'); process.kill(process.pid, 'SIGKILL'); }   // pty 上還有一個阻塞中的讀取，正常結束可能卡住，所以直接結束行程
