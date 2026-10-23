#!/usr/bin/env node
// DofLab 虛擬設備主機（雲端虛擬硬體第 1 階段）
// 介面經網路（WebSocket）連到這個程序裡的虛擬 Uno：二進位訊框＝序列埠位元組（和 USB 完全相同的 Firmata），文字訊框＝控制訊息。
// 每台設備一個 worker thread：avr8js 跑真的 DofLabFirmata 機器碼，外面接著工作台（按鈕、LED）。
// 這是虛擬設備，不是實體板子：在這裡通過的只能寫「已在虛擬設備驗證，未以實體設備驗證」。
//
// 用法：node tools/vdev/server.js [--port 8770] [--host 127.0.0.1] [--hex 韌體.hex] [--device uno-1]
//   ws://127.0.0.1:8770/dev/uno-1         介面的「虛擬設備」網址
//   http://127.0.0.1:8770/                簡易工作台（按按鈕、看 LED；完整工作台在第 2 階段）
//   GET  /api/devices/uno-1               設備狀態（腳位、工作台、收到的命令紀錄）
//   POST /api/devices/uno-1/bench         工作台操作 {"part":"BTN1","action":"press"|"release"}
// 安全：第 1 階段只聽本機（127.0.0.1／::1／localhost），沒有通行碼；放到網路上是第 7 階段、要使用者決定。
const http = require('http'); const path = require('path'); const os = require('os');
const { Worker } = require('worker_threads');
const { WebSocketServer } = require('ws');
const PROTO = 1;
const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];

class DeviceHost {
  constructor(spec) {
    this.id = spec.id; this.link = null; this.reqs = new Map(); this.rid = 0; this.helloInfo = null;
    this.worker = new Worker(path.join(__dirname, 'device.js'), { workerData: { vdev: spec } });
    this.ready = new Promise((res, rej) => { this._ready = res; this._fail = rej; });
    this.worker.on('message', m => {
      if (m.t === 'tx') { if (this.link && this.link.helloDone) this.link.send(Buffer.from(m.bytes.buffer, m.bytes.byteOffset, m.bytes.byteLength), { binary: true }); }
      else if (m.t === 'reply') { const r = this.reqs.get(m.id); if (r) { this.reqs.delete(m.id); m.ok ? r.res(m.v) : r.rej(new Error(m.error)); } }
      else if (m.t === 'event') { if (this.link && this.link.helloDone) this.link.send(JSON.stringify(Object.assign({ op: 'event' }, m.e))); }
      else if (m.t === 'ready') { this.helloInfo = m.hello; this._ready(); }
      else if (m.t === 'fatal') this._fail(new Error(`虛擬設備 ${this.id} 無法啟動：${m.error}`));
    });
    this.worker.on('error', e => this._fail(e));
  }
  request(q) { const id = ++this.rid; return new Promise((res, rej) => { this.reqs.set(id, { res, rej }); this.worker.postMessage({ t: 'req', id, q }); }); }
  rx(buf) { const bytes = new Uint8Array(buf); this.worker.postMessage({ t: 'rx', bytes }); }
  stop() { return this.worker.terminate(); }
}

function benchPage(devs) {
  const ids = JSON.stringify(devs.map(d => d.id));
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DofLab 虛擬設備主機</title>
<style>body{font-family:system-ui,"Noto Sans TC",sans-serif;margin:16px;background:#f4f6f8;color:#16202a}.dev{background:#fff;border:2px dashed #5b4fb0;border-radius:10px;padding:12px;margin:12px 0;max-width:560px}
.tag{display:inline-block;background:#e6e3f7;color:#5b4fb0;border-radius:6px;padding:2px 8px;font-size:.8rem}button{font-size:1rem;padding:10px 16px;margin:6px 6px 0 0;border-radius:8px;border:1px solid #aeb9c1;background:#eef2f5;touch-action:none}
button[aria-pressed=true]{background:#b4581c;color:#fff}.led{display:inline-block;width:14px;height:14px;border-radius:50%;background:#ccc;vertical-align:middle;margin-right:6px}.led.on{background:#e53935;box-shadow:0 0 10px #e53935}small{color:#5a6873}
@media (prefers-color-scheme:dark){body{background:#0f1418;color:#e2e9ee}.dev{background:#172027}button{background:#25323b;color:#e2e9ee}small{color:#93a2ad}}</style></head><body>
<h1>DofLab 虛擬設備主機 <span class="tag">虛擬設備，不是實體板子</span></h1>
<p><small>第 1 階段的簡易工作台：按住按鈕、看 LED。介面看不到這一頁的內容，只看得到 Firmata 回報的量測與回讀。完整工作台（彈跳、光敏、超音波、伺服、拔線）在第 2 階段。</small></p>
<div id="devs"></div>
<script>
const ids=${ids};const host=document.getElementById('devs');
for(const id of ids){const el=document.createElement('div');el.className='dev';el.id='d-'+id;host.appendChild(el);}
const post=(id,q)=>fetch('/api/devices/'+id+'/bench',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(q)});
function render(s){const el=document.getElementById('d-'+s.id);const parts=s.bench.parts;
 const html='<h2>'+s.id+' <span class="tag">虛擬 Uno · '+s.firmware.name+'</span></h2><small>網址 ws://'+location.host+'/dev/'+s.id+' · 晶片時間 '+(s.devMs/1000).toFixed(1)+' s · 速度 '+(s.realtime??'—')+' 倍 · '+(s.linked?'介面已連線':'沒有連線')+'</small><div>'+parts.map(p=>p.type==='button'?'<button data-part="'+p.id+'" aria-pressed="'+p.pressed+'">按住 '+p.id+'（D'+p.pin+'）</button>':'<p><span class="led '+(p.on?'on':'')+'"></span>'+p.id+'（D'+p.pin+'）'+(p.on?'亮，約 '+p.mA+' mA':'滅')+'</p>').join('')+'</div>';
 if(el.dataset.h!==html&&!el.querySelector('button[data-down]')){el.dataset.h=html;el.innerHTML=html;el.querySelectorAll('button[data-part]').forEach(b=>{const p=b.dataset.part;b.onpointerdown=e=>{b.setPointerCapture(e.pointerId);b.dataset.down=1;post(s.id,{part:p,action:'press'});};const up=()=>{if(!b.dataset.down)return;delete b.dataset.down;post(s.id,{part:p,action:'release'});};b.onpointerup=up;b.onpointercancel=up;});}}
async function poll(){for(const id of ids){try{render(await (await fetch('/api/devices/'+id)).json());}catch(e){}}setTimeout(poll,200);}poll();
</script></body></html>`;
}

async function startServer(opts) {
  opts = opts || {};
  const host = opts.host || '127.0.0.1';
  if (!LOOPBACK.includes(host)) throw new Error(`第 1 階段只允許在本機執行（--host 127.0.0.1）。放到網路上需要 TLS、通行碼與資源限制（規劃文件第 5、7 節），而且要由使用者決定。`);
  const specs = opts.devices || [{ id: 'uno-1', hex: opts.hex }];
  const devs = new Map(specs.map(s => [s.id, new DeviceHost(s)]));
  await Promise.all([...devs.values()].map(d => d.ready));
  const json = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'); const m = u.pathname.match(/^\/api\/devices\/([\w-]+)(\/bench)?$/);
    try {
      if (req.method === 'GET' && u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(benchPage([...devs.values()])); return; }
      if (req.method === 'GET' && u.pathname === '/api/devices') { json(res, 200, [...devs.values()].map(d => Object.assign({ id: d.id, url: `/dev/${d.id}`, linked: !!d.link }, d.helloInfo))); return; }
      if (m && devs.has(m[1])) {
        const d = devs.get(m[1]);
        if (req.method === 'GET' && !m[2]) { json(res, 200, await d.request({ op: 'state' })); return; }
        if (req.method === 'POST' && m[2]) {
          let body = ''; for await (const c of req) { body += c; if (body.length > 10000) throw new Error('請求太大'); }
          const q = JSON.parse(body || '{}'); json(res, 200, await d.request({ op: 'bench', part: q.part, action: q.action })); return;
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
    ws.on('message', (data, isBinary) => {
      if (isBinary) { if (ws.helloDone) d.rx(data); return; }
      let q; try { q = JSON.parse(String(data)); } catch (e) { return; }
      control(q).catch(e => { try { ws.send(JSON.stringify({ op: 'error', code: 'internal', message: '虛擬設備主機錯誤：' + e.message })); } catch (e2) { } });
    });
    async function control(q) {
      if (q.op === 'hello') {
        if (q.proto !== PROTO) { ws.send(JSON.stringify({ op: 'error', code: 'proto', message: `協定版本 ${q.proto} 不符（虛擬設備主機是 ${PROTO}）。` })); ws.close(4002, 'proto'); return; }
        const h = await d.request({ op: 'link' }); ws.helloDone = true;
        ws.send(JSON.stringify(Object.assign({ op: 'hello', proto: PROTO, host: os.hostname(), note: '虛擬設備：avr8js 模擬的 ATmega328P，不是實體板子' }, h)));
      } else if (q.op === 'signals') { if (ws.helloDone) d.request({ op: 'signals', dtr: q.dtr, rts: q.rts }).catch(() => { }); }
      else if (q.op === 'ping') { const s = await d.request({ op: 'time' }).catch(() => null); ws.send(JSON.stringify({ op: 'pong', t: q.t, devMs: s && s.devMs })); }
    }
    ws.on('close', () => { if (d.link === ws) { d.link = null; d.request({ op: 'unlink' }).catch(() => { }); } });
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
  startServer({ port: +arg('port', 8770), host: arg('host', '127.0.0.1'), hex: arg('hex') ? path.resolve(arg('hex')) : undefined, devices: arg('device') ? [{ id: arg('device'), hex: arg('hex') ? path.resolve(arg('hex')) : undefined }] : undefined })
    .then(s => {
      const h = s.host.includes(':') ? `[${s.host}]` : s.host;
      console.log(`DofLab 虛擬設備主機（虛擬設備，不是實體板子）`);
      for (const id of s.devices.keys()) console.log(`  介面的虛擬設備網址：ws://${h}:${s.port}/dev/${id}`);
      console.log(`  簡易工作台：http://${h}:${s.port}/`);
      console.log(`VDEV_READY port=${s.port}`);
      const stop = () => s.close().then(() => process.exit(0));
      process.on('SIGINT', stop); process.on('SIGTERM', stop);
    })
    .catch(e => { console.error('無法啟動：' + e.message); process.exit(1); });
}

module.exports = { startServer, PROTO };
