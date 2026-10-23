/* DofLab — 透過 Web Serial 上傳程式到 Arduino Uno（STK500v1 協定，對象是 Uno 內建的 Optiboot 開機程式）
 * 流程：開啟序列埠 → 用 DTR 讓板子重置進入開機程式 → 同步 → 讀晶片簽章 → 逐頁寫入 → 逐頁讀回比對 → 離開燒錄模式（板子自動重啟執行新程式）。
 * 這個檔案在瀏覽器與 Node（測試）共用；序列埠只需要具備 Web Serial 的 open／setSignals／readable／writable／close。
 */
(function (root) {
  const DL = (root.DL = root.DL || {});
  const STK = { OK: 0x10, INSYNC: 0x14, EOP: 0x20, GET_SYNC: 0x30, ENTER: 0x50, LEAVE: 0x51, LOAD_ADDR: 0x55, PROG_PAGE: 0x64, READ_PAGE: 0x74, READ_SIGN: 0x75 };
  const DEVICES = { uno: { name: 'ATmega328P', sig: [0x1e, 0x95, 0x0f], page: 128, maxBytes: 0x7e00, baud: 115200 } };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Intel HEX → 位元組陣列（從 0 開始，未使用的位置填 0xFF）
  function parseHex(text) {
    const mem = []; let base = 0, top = 0, lineNo = 0;
    for (const raw of String(text).split(/\r?\n/)) {
      lineNo++; const line = raw.trim(); if (!line) continue;
      if (line[0] !== ':') throw new Error(`HEX 第 ${lineNo} 行格式錯誤`);
      const bytes = []; for (let i = 1; i < line.length; i += 2) bytes.push(parseInt(line.substr(i, 2), 16));
      const sum = bytes.reduce((a, b) => (a + b) & 0xff, 0); if (sum !== 0) throw new Error(`HEX 第 ${lineNo} 行檢查碼錯誤`);
      const n = bytes[0], addr = (bytes[1] << 8) | bytes[2], type = bytes[3];
      if (type === 0) { for (let i = 0; i < n; i++) mem[base + addr + i] = bytes[4 + i]; top = Math.max(top, base + addr + n); }
      else if (type === 1) break;
      else if (type === 2) base = ((bytes[4] << 8) | bytes[5]) << 4;
      else if (type === 4) base = ((bytes[4] << 8) | bytes[5]) << 16;
    }
    const out = new Uint8Array(top).fill(0xff); for (let i = 0; i < top; i++) if (mem[i] !== undefined) out[i] = mem[i];
    return out;
  }

  // 位元組佇列：背景讀取序列埠，read(n) 等到有 n 個位元組或逾時
  function byteReader(port) {
    const buf = []; let waiters = []; let done = false; const reader = port.readable.getReader();
    (async () => { try { for (;;) { const { value, done: d } = await reader.read(); if (d) break; for (const b of value) buf.push(b); const w = waiters; waiters = []; w.forEach(f => f()); } } catch (e) { } done = true; const w = waiters; waiters = []; w.forEach(f => f()); })();
    return {
      async read(n, ms) {
        const until = Date.now() + ms;
        while (buf.length < n) { if (done || Date.now() > until) throw new Error('timeout'); await new Promise(r => { waiters.push(r); setTimeout(r, Math.max(1, until - Date.now())); }); }
        return buf.splice(0, n);
      },
      drain() { buf.length = 0; },
      async release() { try { await reader.cancel(); } catch (e) { } try { reader.releaseLock(); } catch (e) { } }
    };
  }

  async function flash(port, hexText, opts) {
    opts = opts || {}; const dev = DEVICES[opts.board || 'uno']; const log = opts.log || (() => { }); const progress = opts.onProgress || (() => { });
    const image = parseHex(hexText);
    if (image.length > dev.maxBytes) throw new Error(`程式有 ${image.length} 位元組，超過 ${dev.name} 可用的 ${dev.maxBytes} 位元組（最後 512 位元組保留給開機程式）。`);
    const pages = Math.ceil(image.length / dev.page);
    if (opts.open) await opts.open(port, dev.baud); else await port.open({ baudRate: dev.baud });   // 瀏覽器傳入 DL.serial.open：會先關掉本頁沒關乾淨的連線
    const io = byteReader(port); const writer = port.writable.getWriter();
    const send = bytes => writer.write(new Uint8Array(bytes));
    const cmd = async (bytes, extra, ms) => { await send(bytes); const r = await io.read(2 + (extra || 0), ms || 800); if (r[0] !== STK.INSYNC || r[r.length - 1] !== STK.OK) throw new Error('回應不同步'); return r.slice(1, -1); };
    const t0 = Date.now();
    try {
      // 1. 重置進入開機程式：DTR 拉一下（Uno 板上的 USB 晶片經電容接到 RESET 腳）
      if (opts.reset !== false && port.setSignals) { log('重置板子，進入開機程式…'); await port.setSignals({ dataTerminalReady: false, requestToSend: false }); await sleep(250); await port.setSignals({ dataTerminalReady: true, requestToSend: true }); await sleep(60); }
      // 2. 同步（開機程式只會等大約 1 秒）
      let synced = false;
      for (let i = 0; i < 12 && !synced; i++) { io.drain(); try { await cmd([STK.GET_SYNC, STK.EOP], 0, 150); synced = true; } catch (e) { await sleep(40); } }
      if (synced) { await sleep(60); io.drain(); try { await cmd([STK.GET_SYNC, STK.EOP], 0, 400); } catch (e) { synced = false; } }   // 前幾次重試的回應可能晚到：清掉後再確認一次，避免錯位
      if (!synced) throw Object.assign(new Error('沒有收到開機程式的回應。請確認：板型是 Uno、選對連接埠、沒有其他程式（例如觀測頁或 Arduino IDE）正在使用這個連接埠；必要時在上傳開始時手動按一下板子上的 RESET。'), { code: 'no_sync' });
      log('已和開機程式同步');
      // 3. 晶片簽章：確認真的是 ATmega328P
      const sig = await cmd([STK.READ_SIGN, STK.EOP], 3);
      if (sig.some((b, i) => b !== dev.sig[i])) throw Object.assign(new Error(`晶片簽章 ${sig.map(b => b.toString(16).padStart(2, '0')).join(' ')} 不是 ${dev.name}（1e 95 0f），已停止，沒有寫入任何資料。`), { code: 'bad_sig' });
      log(`晶片：${dev.name}（簽章 ${sig.map(b => b.toString(16).padStart(2, '0')).join(' ')}）`);
      await cmd([STK.ENTER, STK.EOP]);
      // 4. 逐頁寫入
      for (let p = 0; p < pages; p++) {
        const a = p * dev.page; const data = Array.from(image.slice(a, a + dev.page)); while (data.length < dev.page) data.push(0xff);
        const w = a >> 1; await cmd([STK.LOAD_ADDR, w & 0xff, w >> 8, STK.EOP]);
        await cmd([STK.PROG_PAGE, dev.page >> 8, dev.page & 0xff, 0x46, ...data, STK.EOP], 0, 1500);
        progress({ phase: 'write', done: p + 1, total: pages });
      }
      log(`已寫入 ${image.length} 位元組（${pages} 頁）`);
      // 5. 逐頁讀回比對
      let verified = false;
      if (opts.verify !== false) {
        for (let p = 0; p < pages; p++) {
          const a = p * dev.page; const w = a >> 1; await cmd([STK.LOAD_ADDR, w & 0xff, w >> 8, STK.EOP]);
          const back = await cmd([STK.READ_PAGE, dev.page >> 8, dev.page & 0xff, 0x46, STK.EOP], dev.page, 1500);
          for (let i = 0; i < dev.page && a + i < image.length; i++) if (back[i] !== image[a + i]) throw Object.assign(new Error(`讀回比對失敗：位址 0x${(a + i).toString(16)} 寫入 0x${image[a + i].toString(16)}，讀回 0x${back[i].toString(16)}。`), { code: 'verify' });
          progress({ phase: 'verify', done: p + 1, total: pages });
        }
        verified = true; log('讀回比對一致');
      }
      // 6. 離開燒錄模式：開機程式會重新啟動，開始執行新程式
      await cmd([STK.LEAVE, STK.EOP]);
      log('完成，板子重新啟動執行新程式');
      return { ok: true, bytes: image.length, pages, verified, ms: Date.now() - t0, device: dev.name };
    } finally {
      try { writer.releaseLock(); } catch (e) { }
      await io.release();
      try { await port.close(); } catch (e) { }
    }
  }

  DL.stk500 = { flash, parseHex, DEVICES };
  if (typeof module !== 'undefined') module.exports = DL;
})(typeof globalThis !== 'undefined' ? globalThis : this);
