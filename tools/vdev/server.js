#!/usr/bin/env node
// DofLab 虛擬設備主機（雲端虛擬硬體第 1–4 階段）
// 介面經網路（WebSocket）連到這個程序裡的虛擬 Uno：二進位訊框＝序列埠位元組（和 USB 完全相同的 Firmata），文字訊框＝控制訊息。
// 每台設備一個 worker thread：avr8js 跑真的 DofLabFirmata 機器碼，外面接著工作台（tools/vdev/benches/ 的接線與元件模型）。
// 晶片裡有 Arduino 官方 Optiboot：介面可以像實體 Uno 一樣用 STK500（DTR 重置）上傳別的程式，序列埠輸出照樣經 WebSocket 送回（第 4 階段）。
// 這是虛擬設備，不是實體板子：在這裡通過的只能寫「已在虛擬設備驗證，未以實體設備驗證」。
//
// 用法：node tools/vdev/server.js [--port 8770] [--host 127.0.0.1] [--bench hold-blink] [--hex 韌體.hex] [--device uno-1]
//   --bench：工作台預設的名稱（tools/vdev/benches/*.json）或規格檔路徑；預設 hold-blink
//   ws://127.0.0.1:8770/dev/uno-1         介面的「虛擬設備」網址
//   http://127.0.0.1:8770/                工作台頁（按按鈕、拉亮度與距離、看 LED、伺服與手臂）
//   GET  /api/devices/uno-1               設備狀態（腳位、工作台、收到的命令紀錄）
//   GET  /api/benches                     可用的工作台預設
//   POST /api/devices/uno-1/fault         故障注入（第 3 階段）：{"net":{"delayMs":200,"jitterMs":100,"loss":0.05,"dir":"both"}}（null 清除）、
//                                          {"fault":"disconnect"|"reset"|"brownout"}
//   GET  /api/devices/uno-1/trace[?clear=1]  輸出軌跡（第 4 階段）：工作台的輸入操作與 LED／伺服變化（設備時間）、晶片重置紀錄、目前的程式
//   POST /api/devices/uno-1/bench         工作台操作 {"part":"BTN1","action":"press"|"release"}、{"part":"LDR1","action":"set","light":30}、{"part":"US1","action":"set","cm":12}（cm 為 null：移走物體）；
//                                          加上 "atDevMs":1234.5 則排定在該設備時間執行（第 4 階段）
// 安全：第 1 階段只聽本機（127.0.0.1／::1／localhost），沒有通行碼；放到網路上是第 7 階段、要使用者決定。
const http = require('http'); const path = require('path'); const os = require('os'); const fs = require('fs');
const { presets, loadSpec } = require('./bench');
const { Lane, netConfig } = require('./netfault');
const { Hub } = require('./hub');
const { Worker } = require('worker_threads');
const { WebSocketServer } = require('ws');
const PROTO = 2;   // 2（第 5 階段）：多個連線、控制權（lock）、presence；寫入需要控制權
const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];

class DeviceHost {
  constructor(spec) {
    this.id = spec.id; this.links = new Set(); this.reqs = new Map(); this.rid = 0; this.helloInfo = null; this.net = null; this.faultLog = [];
    this.worker = new Worker(path.join(__dirname, 'device.js'), { workerData: { vdev: spec } });
    this.ready = new Promise((res, rej) => { this._ready = res; this._fail = rej; });
    this.worker.on('message', m => {
      if (m.t === 'tx') this.hub.fromDevice(m.bytes);
      else if (m.t === 'reply') { const r = this.reqs.get(m.id); if (r) { this.reqs.delete(m.id); m.ok ? r.res(m.v) : r.rej(new Error(m.error)); } }
      else if (m.t === 'event') { if (m.e.firmware && this.helloInfo) this.helloInfo.firmware = m.e.firmware; this.toAll(Object.assign({ op: 'event' }, m.e)); }
      else if (m.t === 'ready') { this.helloInfo = m.hello; this._ready(); }
      else if (m.t === 'fatal') this._fail(new Error(`虛擬設備 ${this.id} 無法啟動：${m.error}`));
    });
    this.worker.on('error', e => this._fail(e));
    // 每個連線一個 ws：位元組與控制訊息都經過該連線「設備 → 介面」方向的網路佇列（故障注入）
    this.hub = new Hub({
      send: (l, bytes) => { if (l.ws.helloDone) l.ws.down.push({ data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), binary: true }, true); },
      notify: (l, o) => { if (l.ws.helloDone) l.ws.down.push({ data: JSON.stringify(o), binary: false }, false); },
      toDevice: bytes => this.rx(bytes)
    });
  }
  toAll(o) { for (const ws of this.links) if (ws.helloDone) ws.down.push({ data: JSON.stringify(o), binary: false }, false); }
  request(q) { const id = ++this.rid; return new Promise((res, rej) => { this.reqs.set(id, { res, rej }); this.worker.postMessage({ t: 'req', id, q }); }); }
  rx(buf) { const bytes = new Uint8Array(buf); this.worker.postMessage({ t: 'rx', bytes }); }
  stop() { this.hub.stop(); return this.worker.terminate(); }
  // 網路故障設定：套用到目前的每個連線，之後的新連線也沿用
  setNet(cfg) {
    this.net = cfg; for (const l of this.links) this.applyNet(l);
    this.faultLog.push({ at: Date.now(), net: cfg }); if (this.faultLog.length > 50) this.faultLog.shift();
  }
  applyNet(l) {
    if (!l) return; const c = this.net;
    l.up.set(c && c.dir !== 'down' ? c : null); l.down.set(c && c.dir !== 'up' ? c : null);
  }
  // 各連線的佇列統計加總
  netState() {
    const sum = k => { if (!this.links.size) return null; const o = { frames: 0, dropped: 0, delayed: 0 }; for (const l of this.links) for (const f of Object.keys(o)) o[f] += l[k].stats[f]; return o; };
    return { net: this.net, up: sum('up'), down: sum('down') };
  }
}

async function startServer(opts) {
  opts = opts || {};
  const host = opts.host || '127.0.0.1';
  if (!LOOPBACK.includes(host)) throw new Error(`第 1 階段只允許在本機執行（--host 127.0.0.1）。放到網路上需要 TLS、通行碼與資源限制（規劃文件第 5、7 節），而且要由使用者決定。`);
  const specs = opts.devices || [{ id: 'uno-1', hex: opts.hex, bench: opts.bench }];
  const devs = new Map(specs.map(s => [s.id, new DeviceHost(s)]));
  await Promise.all([...devs.values()].map(d => d.ready));
  const json = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'); const m = u.pathname.match(/^\/api\/devices\/([\w-]+)(?:(\/bench)|(\/fault)|(\/trace))?$/);
    try {
      if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/bench')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(fs.readFileSync(path.join(__dirname, 'bench.html'))); return; }
      if (req.method === 'GET' && u.pathname === '/api/benches') { json(res, 200, presets().map(id => { const b = loadSpec(id); return { id, name: b.name }; })); return; }
      if (req.method === 'GET' && u.pathname === '/api/devices') { json(res, 200, [...devs.values()].map(d => Object.assign({ id: d.id, url: `/dev/${d.id}`, linked: d.links.size > 0, hub: d.hub.state() }, d.helloInfo))); return; }
      if (m && devs.has(m[1])) {
        const d = devs.get(m[1]);
        if (req.method === 'GET' && m[4]) { json(res, 200, await d.request({ op: 'trace', clear: u.searchParams.get('clear') === '1' })); return; }
        if (req.method === 'GET' && !m[2] && !m[3] && !m[4]) { json(res, 200, Object.assign(await d.request({ op: 'state' }), { faults: d.netState(), hub: d.hub.state() })); return; }
        if (req.method === 'POST' && m[2]) {
          let body = ''; for await (const c of req) { body += c; if (body.length > 10000) throw new Error('請求太大'); }
          const q = JSON.parse(body || '{}'); json(res, 200, await d.request({ op: 'bench', part: q.part, action: q.action, light: q.light, cm: q.cm, atDevMs: q.atDevMs })); return;
        }
        if (req.method === 'POST' && m[3]) {
          let body = ''; for await (const c of req) { body += c; if (body.length > 10000) throw new Error('請求太大'); }
          const q = JSON.parse(body || '{}');
          if ('net' in q) d.setNet(netConfig(q.net));
          if (q.fault === 'disconnect') { if (d.links.size) { d.faultLog.push({ at: Date.now(), fault: 'disconnect' }); for (const l of [...d.links]) l.terminate(); } }   // 像網路線被拔掉：不送關閉訊息，直接斷（每個連線）
          else if (q.fault === 'reset' || q.fault === 'brownout') { d.faultLog.push({ at: Date.now(), fault: q.fault }); await d.request({ op: 'fault', fault: q.fault }); }
          else if (q.fault !== undefined) throw new Error('未知的故障：' + q.fault);
          json(res, 200, Object.assign(await d.request({ op: 'state' }), { faults: d.netState(), hub: d.hub.state() })); return;
        }
      }
      json(res, 404, { error: '找不到：' + u.pathname });
    } catch (e) { json(res, 400, { error: e.message }); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (req, sock, head) => {
    const m = new URL(req.url, 'http://x').pathname.match(/^\/dev\/([\w-]+)$/);
    if (!m || !devs.has(m[1])) { sock.write('HTTP/1.1 404 Not Found\r\n\r\n'); sock.destroy(); return; }
    wss.handleUpgrade(req, sock, head, ws => onLink(devs.get(m[1]), ws));
  });
  function onLink(d, ws) {
    // 第 5 階段：一台設備可以有好幾個連線（唯讀觀看）；寫入只有拿到控制權的連線能送（hub.js）
    d.links.add(ws); ws.helloDone = false; ws.link = null;
    // 兩個方向各一條佇列（網路故障注入）；沒有故障時直接送達
    ws.down = new Lane(it => { if (ws.readyState === 1) ws.send(it.data, { binary: it.binary }); });
    ws.up = new Lane(it => {
      if (it.binary) { if (ws.link) d.hub.fromLink(ws.link, new Uint8Array(it.data)); return; }
      let q; try { q = JSON.parse(String(it.data)); } catch (e) { return; }
      if (ws.link) d.hub.seen(ws.link);
      control(q).catch(e => { try { ws.send(JSON.stringify({ op: 'error', code: 'internal', message: '虛擬設備主機錯誤：' + e.message })); } catch (e2) { } });
    });
    d.applyNet(ws);
    ws.on('message', (data, isBinary) => ws.up.push({ data, binary: isBinary }, isBinary));
    const reply = o => ws.down.push({ data: JSON.stringify(o), binary: false }, false);
    async function control(q) {
      if (q.op === 'hello') {
        if (ws.link) return;
        if (q.proto !== PROTO) { ws.send(JSON.stringify({ op: 'error', code: 'proto', message: `協定版本 ${q.proto} 不符（虛擬設備主機是 ${PROTO}）。請重新整理 DofLab 或更新 tools/vdev/server.js。` })); ws.close(4002, 'proto'); return; }
        const r = d.hub.join(ws, q);
        if (r.error) { ws.send(JSON.stringify({ op: 'error', code: r.error, message: r.message })); ws.close(4001, r.error); return; }
        ws.link = r.link;
        const h = await d.request({ op: d.hub.links.size === 1 ? 'link' : 'hello' });   // 第一個連線開始時才重設設備端的紀錄
        ws.helloDone = true;
        reply(Object.assign({ op: 'hello', proto: PROTO, host: os.hostname(), note: '虛擬設備：avr8js 模擬的 ATmega328P，不是實體板子', you: r.link.id, name: r.link.name, mode: r.link.mode }, h));
        d.hub.presence('join', r.link);
      } else if (!ws.link) return;
      else if (q.op === 'signals') {
        if (d.hub.signalsAllowed(ws.link)) d.request({ op: 'signals', dtr: q.dtr, rts: q.rts }).catch(() => { });
        else reply({ op: 'error', code: 'not_holder', message: '你沒有控制權：重新啟動（DTR）的訊號已被擋下，沒有送到晶片。' });
      }
      else if (q.op === 'lock') reply(d.hub.lock(ws.link, q.want));
      else if (q.op === 'ping') { const s = await d.request({ op: 'time' }).catch(() => null); reply({ op: 'pong', t: q.t, devMs: s && s.devMs }); }
    }
    ws.on('close', () => {
      ws.up.clear(); ws.down.clear(); d.links.delete(ws);
      if (ws.link) { d.hub.leave(ws.link); ws.link = null; if (!d.hub.links.size) d.request({ op: 'unlink' }).catch(() => { }); }
    });
    ws.on('error', () => { });
  }
  await new Promise((res, rej) => { server.once('error', rej); server.listen(opts.port === undefined ? 8770 : opts.port, host, res); });
  const port = server.address().port;
  return {
    port, host, devices: devs, server,
    async close() { for (const c of wss.clients) c.terminate(); await new Promise(r => server.close(r)); await Promise.all([...devs.values()].map(d => d.stop())); }
  };
}

if (require.main === module) {
  const arg = (k, def) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : def; };
  const hex = arg('hex') ? path.resolve(arg('hex')) : undefined, bench = arg('bench');
  startServer({ port: +arg('port', 8770), host: arg('host', '127.0.0.1'), hex, bench, devices: arg('device') ? [{ id: arg('device'), hex, bench }] : undefined })
    .then(s => {
      const h = s.host.includes(':') ? `[${s.host}]` : s.host;
      console.log(`DofLab 虛擬設備主機（虛擬設備，不是實體板子）`);
      for (const id of s.devices.keys()) console.log(`  介面的虛擬設備網址：ws://${h}:${s.port}/dev/${id}`);
      for (const d of s.devices.values()) console.log(`  工作台：http://${h}:${s.port}/?d=${d.id}（${d.helloInfo.benchName}）`);
      console.log(`VDEV_READY port=${s.port}`);
      const stop = () => s.close().then(() => process.exit(0));
      process.on('SIGINT', stop); process.on('SIGTERM', stop);
    })
    .catch(e => { console.error('無法啟動：' + e.message); process.exit(1); });
}

module.exports = { startServer, PROTO };
