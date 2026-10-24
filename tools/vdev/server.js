#!/usr/bin/env node
// DofLab 虛擬設備主機（雲端虛擬硬體第 1、2 階段）
// 介面經網路（WebSocket）連到這個程序裡的虛擬 Uno：二進位訊框＝序列埠位元組（和 USB 完全相同的 Firmata），文字訊框＝控制訊息。
// 每台設備一個 worker thread：avr8js 跑真的 DofLabFirmata 機器碼，外面接著工作台（tools/vdev/benches/ 的接線與元件模型）。
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
//   POST /api/devices/uno-1/bench         工作台操作 {"part":"BTN1","action":"press"|"release"}、{"part":"LDR1","action":"set","light":30}、{"part":"US1","action":"set","cm":12}（cm 為 null：移走物體）
// 安全：第 1 階段只聽本機（127.0.0.1／::1／localhost），沒有通行碼；放到網路上是第 7 階段、要使用者決定。
const http = require('http'); const path = require('path'); const os = require('os'); const fs = require('fs');
const { presets, loadSpec } = require('./bench');
const { Lane, netConfig } = require('./netfault');
const { Worker } = require('worker_threads');
const { WebSocketServer } = require('ws');
const PROTO = 1;
const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];

class DeviceHost {
  constructor(spec) {
    this.id = spec.id; this.link = null; this.reqs = new Map(); this.rid = 0; this.helloInfo = null; this.net = null; this.faultLog = [];
    this.worker = new Worker(path.join(__dirname, 'device.js'), { workerData: { vdev: spec } });
    this.ready = new Promise((res, rej) => { this._ready = res; this._fail = rej; });
    this.worker.on('message', m => {
      if (m.t === 'tx') this.toLink(Buffer.from(m.bytes.buffer, m.bytes.byteOffset, m.bytes.byteLength), true);
      else if (m.t === 'reply') { const r = this.reqs.get(m.id); if (r) { this.reqs.delete(m.id); m.ok ? r.res(m.v) : r.rej(new Error(m.error)); } }
      else if (m.t === 'event') this.toLink(JSON.stringify(Object.assign({ op: 'event' }, m.e)), false);
      else if (m.t === 'ready') { this.helloInfo = m.hello; this._ready(); }
      else if (m.t === 'fatal') this._fail(new Error(`虛擬設備 ${this.id} 無法啟動：${m.error}`));
    });
    this.worker.on('error', e => this._fail(e));
  }
  request(q) { const id = ++this.rid; return new Promise((res, rej) => { this.reqs.set(id, { res, rej }); this.worker.postMessage({ t: 'req', id, q }); }); }
  rx(buf) { const bytes = new Uint8Array(buf); this.worker.postMessage({ t: 'rx', bytes }); }
  stop() { return this.worker.terminate(); }
  // 送給介面：經過「設備 → 介面」方向的網路故障（延遲、掉包）
  toLink(data, binary) { const l = this.link; if (l && l.helloDone) l.down.push({ data, binary }, binary); }
  // 網路故障設定：套用到目前的連線，之後的新連線也沿用
  setNet(cfg) {
    this.net = cfg; this.applyNet(this.link);
    this.faultLog.push({ at: Date.now(), net: cfg }); if (this.faultLog.length > 50) this.faultLog.shift();
  }
  applyNet(l) {
    if (!l) return; const c = this.net;
    l.up.set(c && c.dir !== 'down' ? c : null); l.down.set(c && c.dir !== 'up' ? c : null);
  }
  netState() { const l = this.link; return { net: this.net, up: l ? l.up.stats : null, down: l ? l.down.stats : null }; }
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
    const u = new URL(req.url, 'http://x'); const m = u.pathname.match(/^\/api\/devices\/([\w-]+)(?:(\/bench)|(\/fault))?$/);
    try {
      if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/bench')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(fs.readFileSync(path.join(__dirname, 'bench.html'))); return; }
      if (req.method === 'GET' && u.pathname === '/api/benches') { json(res, 200, presets().map(id => { const b = loadSpec(id); return { id, name: b.name }; })); return; }
      if (req.method === 'GET' && u.pathname === '/api/devices') { json(res, 200, [...devs.values()].map(d => Object.assign({ id: d.id, url: `/dev/${d.id}`, linked: !!d.link }, d.helloInfo))); return; }
      if (m && devs.has(m[1])) {
        const d = devs.get(m[1]);
        if (req.method === 'GET' && !m[2] && !m[3]) { json(res, 200, Object.assign(await d.request({ op: 'state' }), { faults: d.netState() })); return; }
        if (req.method === 'POST' && m[2]) {
          let body = ''; for await (const c of req) { body += c; if (body.length > 10000) throw new Error('請求太大'); }
          const q = JSON.parse(body || '{}'); json(res, 200, await d.request({ op: 'bench', part: q.part, action: q.action, light: q.light, cm: q.cm })); return;
        }
        if (req.method === 'POST' && m[3]) {
          let body = ''; for await (const c of req) { body += c; if (body.length > 10000) throw new Error('請求太大'); }
          const q = JSON.parse(body || '{}');
          if ('net' in q) d.setNet(netConfig(q.net));
          if (q.fault === 'disconnect') { if (d.link) { d.faultLog.push({ at: Date.now(), fault: 'disconnect' }); d.link.terminate(); } }   // 像網路線被拔掉：不送關閉訊息，直接斷
          else if (q.fault === 'reset' || q.fault === 'brownout') { d.faultLog.push({ at: Date.now(), fault: q.fault }); await d.request({ op: 'fault', fault: q.fault }); }
          else if (q.fault !== undefined) throw new Error('未知的故障：' + q.fault);
          json(res, 200, Object.assign(await d.request({ op: 'state' }), { faults: d.netState() })); return;
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
    // 第 1 階段一台設備同時只接受一個連線（和 USB 序列埠一樣獨占）；多人唯讀觀看在第 5 階段
    if (d.link) { ws.send(JSON.stringify({ op: 'error', code: 'busy', message: `虛擬設備 ${d.id} 已經有其他連線（同時只能一個；多人觀看在第 5 階段）。` })); ws.close(4001, 'busy'); return; }
    d.link = ws; ws.helloDone = false;
    // 兩個方向各一條佇列（網路故障注入）；沒有故障時直接送達
    ws.down = new Lane(it => { if (ws.readyState === 1) ws.send(it.data, { binary: it.binary }); });
    ws.up = new Lane(it => {
      if (it.binary) { if (ws.helloDone) d.rx(it.data); return; }
      let q; try { q = JSON.parse(String(it.data)); } catch (e) { return; }
      control(q).catch(e => { try { ws.send(JSON.stringify({ op: 'error', code: 'internal', message: '虛擬設備主機錯誤：' + e.message })); } catch (e2) { } });
    });
    d.applyNet(ws);
    ws.on('message', (data, isBinary) => ws.up.push({ data, binary: isBinary }, isBinary));
    async function control(q) {
      if (q.op === 'hello') {
        if (q.proto !== PROTO) { ws.send(JSON.stringify({ op: 'error', code: 'proto', message: `協定版本 ${q.proto} 不符（虛擬設備主機是 ${PROTO}）。` })); ws.close(4002, 'proto'); return; }
        const h = await d.request({ op: 'link' }); ws.helloDone = true;
        ws.down.push({ data: JSON.stringify(Object.assign({ op: 'hello', proto: PROTO, host: os.hostname(), note: '虛擬設備：avr8js 模擬的 ATmega328P，不是實體板子' }, h)), binary: false }, false);
      } else if (q.op === 'signals') { if (ws.helloDone) d.request({ op: 'signals', dtr: q.dtr, rts: q.rts }).catch(() => { }); }
      else if (q.op === 'ping') { const s = await d.request({ op: 'time' }).catch(() => null); ws.down.push({ data: JSON.stringify({ op: 'pong', t: q.t, devMs: s && s.devMs }), binary: false }, false); }
    }
    ws.on('close', () => { ws.up.clear(); ws.down.clear(); if (d.link === ws) { d.link = null; d.request({ op: 'unlink' }).catch(() => { }); } });
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
