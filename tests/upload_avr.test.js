// 上傳燒錄：瀏覽器用的 STK500 上傳程式 → 虛擬 Uno 上執行「真正的 Optiboot 開機程式」（Arduino 官方 hex）
// 驗證：DTR 重置進入開機程式、同步、簽章、逐頁寫入（由 Optiboot 的 SPM 指令寫進快閃記憶體）、讀回比對、離開後自動執行新程式。
// 限制：模擬器不模擬 USB 轉序列晶片與電氣特性；實體 Uno 仍需另行驗收。
const test = require('node:test'); const assert = require('node:assert');
const { execFileSync } = require('child_process'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { DL, solved } = require('./helpers'); const { VirtualUno, RESET } = require('../tools/vdev/avrsim');
require('../src/drivers/stk500.js');
let hasCli = true; try { execFileSync('arduino-cli', ['version']); } catch (e) { hasCli = false; }
const OPTI = fs.readFileSync(path.join(__dirname, 'fixtures', 'optiboot_atmega328.hex'), 'utf8');
const FIRMATA = fs.readFileSync(path.join(__dirname, 'fixtures', 'DofLabFirmata-uno.hex'), 'utf8');

function build(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-up-')); const sk = path.join(dir, 'sketch'); fs.mkdirSync(sk);
  fs.writeFileSync(path.join(sk, 'sketch.ino'), code);
  const props = (process.env.DOFLAB_ARDUINO_PROPS || '').split(';').filter(Boolean).flatMap(p => ['--build-property', p]);
  execFileSync('arduino-cli', ['compile', '--fqbn', 'arduino:avr:uno', ...props, '--output-dir', path.join(dir, 'out'), sk], { stdio: 'pipe' });
  return fs.readFileSync(path.join(dir, 'out', 'sketch.ino.hex'), 'utf8');
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('HEX 解析：檢查碼錯誤與太大的程式會被拒絕', async () => {
  const img = DL.stk500.parseHex(FIRMATA); assert.ok(img.length > 1000 && img.length < 0x7e00);
  assert.throws(() => DL.stk500.parseHex(':10000000FF\n'), /檢查碼|格式/);
  const big = []; for (let a = 0; a < 0x7f00; a += 16) { const b = [16, a >> 8, a & 0xff, 0, ...Array(16).fill(0)]; const cs = (256 - b.reduce((x, y) => (x + y) & 0xff, 0)) & 0xff; big.push(':' + [...b, cs].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase()); }
  const u = new VirtualUno(FIRMATA, { bootloader: OPTI }); const port = u.webSerialPort();
  await assert.rejects(DL.stk500.flash(port, big.join('\n')), /超過/);
  port.stop();
});

test('上電後 Optiboot 直接跳到應用程式；DTR 重置才停在開機程式', async () => {
  const u = new VirtualUno(FIRMATA, { bootloader: OPTI });
  assert.strictEqual(u.cpu.pc, 0x3f00, '重置向量指向開機程式區（BOOTRST）');
  u.runMs(5); assert.ok(u.cpu.pc < 0x3f00, '上電重置（PORF）→ 立刻執行應用程式');
  u.reset(); assert.strictEqual(u.resets[u.resets.length - 1].flags, RESET.EXTRF); u.runMs(5);
  assert.ok(u.cpu.pc >= 0x3f00, '外部重置（EXTRF）→ 留在開機程式等待上傳');
});

test('STK500 上傳產生的「按住閃爍」程式：寫入、讀回一致，重啟後 D2 按住時 D13 以 1 Hz 閃爍', { skip: !hasCli && '沒有 arduino-cli', timeout: 240000 }, async () => {
  const hex = build(DL.codegen.generate(solved('hold-blink', 'uno')).code);
  const u = new VirtualUno(FIRMATA, { bootloader: OPTI }); u.setInput(2, true);
  const port = u.webSerialPort(); const logs = []; const prog = [];
  const r = await DL.stk500.flash(port, hex, { log: m => logs.push(m), onProgress: p => prog.push(p) });
  assert.ok(r.ok && r.verified, JSON.stringify(r)); assert.strictEqual(r.device, 'ATmega328P');
  assert.strictEqual(r.pages, Math.ceil(DL.stk500.parseHex(hex).length / 128));
  assert.ok(u.spmLog.write >= r.pages, `Optiboot 以 SPM 寫了 ${u.spmLog.write} 頁`);
  assert.ok(logs.some(l => /1e 95 0f/.test(l)), '讀到 ATmega328P 簽章');
  assert.strictEqual(prog.filter(p => p.phase === 'verify').length, r.pages);
  // 快閃記憶體內容與 hex 相同（開機程式區沒有被改動）
  const img = DL.stk500.parseHex(hex); const flash = new Uint8Array(u.flash.buffer);
  for (let i = 0; i < img.length; i++) assert.strictEqual(flash[i], img[i], `位址 ${i}`);
  assert.strictEqual(flash[0x7e00], 0x11, 'Optiboot 仍在');
  // 離開燒錄模式 → 看門狗重置 → 執行新程式
  u.runMs(1100); assert.ok(u.resets.some(x => x.flags === RESET.WDRF), '看門狗重置後執行應用程式');   // avr8js 的看門狗在改設定時沿用已排定的檢查時間，所以多跑一點
  u.setInput(2, false); const seen = new Set();
  for (let i = 0; i < 40; i++) { u.runMs(50); seen.add(u.isHigh(13)); }
  assert.deepStrictEqual([...seen].sort(), [false, true], '按住時閃爍');
  u.setInput(2, true); u.runMs(60); assert.strictEqual(u.isHigh(13), false, '放開熄滅');
});

test('沒有開機程式（或連接埠接錯）時明確失敗，不寫入任何資料', { timeout: 60000 }, async () => {
  const u = new VirtualUno(FIRMATA); const before = new Uint16Array(u.flash);
  const port = u.webSerialPort();
  await assert.rejects(DL.stk500.flash(port, FIRMATA), e => e.code === 'no_sync' && /沒有收到開機程式的回應/.test(e.message));
  assert.deepStrictEqual(new Uint16Array(u.flash), before);
});

test('把 DofLabFirmata 上傳回去：觀測頁需要的 Firmata 韌體可以重新安裝並回報版本', { timeout: 120000 }, async () => {
  const u = new VirtualUno(null, { bootloader: OPTI }); const port = u.webSerialPort();
  const r = await DL.stk500.flash(port, FIRMATA); assert.ok(r.ok && r.verified);
  u.runMs(1100);
  // 以 Firmata 協定詢問韌體名稱（0xF0 0x79 0xF7）
  const got = []; port.tick = null; await port.open(); const rd = port.readable.getReader();
  const w = port.writable.getWriter(); await sleep(50); await w.write(new Uint8Array([0xf0, 0x79, 0xf7]));
  const until = Date.now() + 4000;
  while (Date.now() < until && !(got.includes(0x79) && got.includes(0xf7))) { const x = await Promise.race([rd.read(), sleep(200).then(() => ({ value: [] }))]); for (const b of x.value || []) got.push(b); }
  const i = got.indexOf(0x79); const name = []; for (let k = i + 3; k + 1 < got.length && got[k] !== 0xf7; k += 2) name.push(got[k] | (got[k + 1] << 7));
  rd.releaseLock(); w.releaseLock(); await port.close();
  assert.match(String.fromCharCode(...name), /DofLabFirmata/);
});

test('觀測頁內建的 DofLabFirmata .hex 與 firmware 原始碼編譯結果一致', { skip: !hasCli && '沒有 arduino-cli', timeout: 240000 }, () => {
  const ino = fs.readFileSync(path.join(__dirname, '..', 'tools', 'firmware', 'DofLabFirmata', 'DofLabFirmata.ino'), 'utf8');
  assert.strictEqual(build(ino), FIRMATA, '原始碼改了之後，請重新編譯並更新 tests/fixtures/DofLabFirmata-uno.hex');
});

// V2.14 發現：連線慢時（經網路的虛擬設備、電腦很忙），同步重試的回應（14 10）會在確認之後才到，讀簽章時整串回應錯開一組 →「回應不同步」。
// 用照劇本回應的假開機程式（STK500v1 的子集），結果不受機器快慢影響：確認同步時多送一組晚到的 14 10；第一次確認可以設定成不回應（回應超過 400 ms）
function scriptedOptiboot(opts) {
  const flash = new Uint8Array(0x8000).fill(0xff); let addr = 0, syncs = 0, ctrl = null; const sent = [];
  const reply = b => { try { ctrl.enqueue(new Uint8Array(b)); } catch (e) { } };
  const port = {
    flash, sent,
    async open() { port.readable = new ReadableStream({ start(c) { ctrl = c; } }); port.writable = new WritableStream({ write(c) { handle([...c]); } }); },
    async setSignals() { }, async close() { try { ctrl.close(); } catch (e) { } }
  };
  function handle(b) {
    sent.push(b[0]);
    if (b[0] === 0x30) { syncs++; if (syncs === opts.silentSync) return; reply(syncs === opts.lateAt ? [0x14, 0x10, 0x14, 0x10] : [0x14, 0x10]); }
    else if (b[0] === 0x75) reply([0x14, 0x1e, 0x95, 0x0f, 0x10]);
    else if (b[0] === 0x55) { addr = (b[1] | b[2] << 8) * 2; reply([0x14, 0x10]); }
    else if (b[0] === 0x64) { const n = b[1] << 8 | b[2]; flash.set(b.slice(4, 4 + n), addr); reply([0x14, 0x10]); }
    else if (b[0] === 0x74) { const n = b[1] << 8 | b[2]; reply([0x14, ...flash.slice(addr, addr + n), 0x10]); }
    else reply([0x14, 0x10]);   // 進入／離開燒錄模式
  }
  return port;
}
const smallHex = () => { const hexLine = (a, bytes) => { const b = [bytes.length, a >> 8, a & 0xff, 0, ...bytes]; const sum = (-b.reduce((x, y) => x + y, 0)) & 0xff; return ':' + b.concat(sum).map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase(); };
  const lines = []; for (let a = 0; a < 256; a += 16) lines.push(hexLine(a, Array.from({ length: 16 }, (_, i) => (a + i) & 0xff))); return lines.join('\n') + '\n:00000001FF'; };
test('連線慢時晚到的同步回應：確認同步之後多一組 14 10 → 讀簽章時跳過，寫入與讀回一致', { timeout: 30000 }, async () => {
  const port = scriptedOptiboot({ lateAt: 2 }); const logs = [];
  const r = await DL.stk500.flash(port, smallHex(), { log: m => logs.push(m) });
  assert.ok(r.ok && r.verified, JSON.stringify(r));
  assert.ok(logs.includes('跳過 1 個晚到的同步回應'), logs.join(' | '));
  for (let i = 0; i < 256; i++) assert.strictEqual(port.flash[i], i);
});
test('連線慢時確認同步的回應超過 400 ms：清掉再確認，不會一次就放棄', { timeout: 30000 }, async () => {
  const port = scriptedOptiboot({ silentSync: 2 });
  const r = await DL.stk500.flash(port, smallHex());
  assert.ok(r.ok && r.verified, JSON.stringify(r));
  assert.deepStrictEqual(port.sent.slice(0, 4), [0x30, 0x30, 0x30, 0x75], '同步、確認（沒有回應）、再確認、讀簽章');
});
