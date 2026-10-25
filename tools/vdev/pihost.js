// 虛擬樹莓派（雲端虛擬硬體第 6 階段）：虛擬設備主機啟動一個 pi_bridge.py --bench 子程序，介面的連線原樣轉接過去。
// 子程序跑的是真的 pi_bridge.py（和接實體樹莓派時同一份程式），GPIO 是 gpiozero 的模擬腳位，外面接 tools/vdev/pi_bench.py 的工作台。
// 轉接時經過和虛擬 Uno 相同的網路故障佇列（延遲、抖動、掉包、中斷）；工作台的 HTTP API 也轉接，格式和虛擬 Uno 相同。
// 這是虛擬設備，不是實體樹莓派：在這裡通過的只能寫「已在虛擬設備驗證，未以實體設備驗證」。
const path = require('path'); const net = require('net'); const { spawn } = require('child_process');
const WebSocket = require('ws');
const { Lane, NetHost } = require('./netfault');
const { loadSpec } = require('./bench');

const PI_BRIDGE = path.join(__dirname, '..', 'pi_bridge.py');
const PYTHON = process.env.DOFLAB_PYTHON || 'python3';
// 掉包只丟資料訊息（量測、命令、回讀）；交握與心跳只延遲（和虛擬 Uno 只丟資料訊框相同）
const DATA_OPS = ['input', 'distance', 'ack', 'write', 'servo', 'proc'];
const droppable = text => { try { return DATA_OPS.includes(JSON.parse(text).op); } catch (e) { return false; } };
const wait = ms => new Promise(r => setTimeout(r, ms));
function freePort() { return new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }

class PiHost extends NetHost {
  constructor(spec) {
    super();
    this.id = spec.id; this.board = 'pi4b'; this.helloInfo = null; this.out = '';
    const b = loadSpec(spec.bench || 'pi-hold-blink');
    if ((b.board || 'uno') !== 'pi4b') throw new Error(`工作台「${b.id}」不是樹莓派用的（board 是 ${b.board || 'uno'}）`);
    this.spec = Object.assign(b, { device: this.id });
    this.ready = this.start();
  }
  async start() {
    this.port = await freePort();
    this.child = spawn(PYTHON, [PI_BRIDGE, '--bench', JSON.stringify(this.spec), '--port', String(this.port), '--host', '127.0.0.1', '--exit-with-parent'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const keep = d => { this.out = (this.out + d).slice(-4000); };
    this.child.stdout.on('data', keep); this.child.stderr.on('data', keep);
    this.child.on('exit', code => { this.dead = `pi_bridge 結束（${code}）`; for (const l of [...this.links]) l.terminate(); });
    const t0 = Date.now();
    for (;;) {
      if (this.dead) throw new Error(`虛擬樹莓派 ${this.id} 無法啟動：${this.dead}\n${this.out}`);
      try { const s = await this.get('/api/bench'); this.helloInfo = { kind: 'virtual', board: 'pi4b', device: this.id, firmware: s.firmware, bench: s.bench.id, benchName: s.bench.name }; return; } catch (e) { }
      if (Date.now() - t0 > 20000) throw new Error(`虛擬樹莓派 ${this.id} 沒有啟動（20 秒）：\n${this.out}`);
      await wait(100);
    }
  }
  async get(p) { const r = await fetch(`http://127.0.0.1:${this.port}${p}`); const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j; }
  async post(p, q) { const r = await fetch(`http://127.0.0.1:${this.port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(q) }); const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j; }
  hubState() { return { holder: null, links: [...this.links].map((l, i) => ({ id: 'P' + (i + 1), name: `連線 ${i + 1}`, mode: 'pibridge', control: false })), note: '樹莓派閘道依腳位分配：同一個腳位同時只有一個連線能用' }; }
  async apiState() { return Object.assign(await this.get('/api/bench'), { faults: this.netState(), hub: this.hubState() }); }
  async apiBench(q) { return Object.assign(await this.post('/api/bench', { part: q.part, action: q.action, cm: q.cm }), { faults: this.netState(), hub: this.hubState() }); }
  apiTrace(clear) { return this.get('/api/trace' + (clear ? '?clear=1' : '')); }
  async apiFault(q) {
    if (q.fault === 'disconnect') this.cutAll();
    else if (q.fault === 'reset' || q.fault === 'brownout') throw new Error('虛擬樹莓派沒有「RESET」與「瞬間斷電」的故障（只有虛擬 Uno 有）；可以用「中斷網路連線」。');
    else if (q.fault !== undefined) throw new Error('未知的故障：' + q.fault);
    return this.apiState();
  }
  // 介面的一個連線：轉接到子程序的 /ws；兩個方向各一條網路故障佇列
  attach(ws) {
    this.links.add(ws);
    const up = new WebSocket(`ws://127.0.0.1:${this.port}/ws`); const pending = [];
    ws.down = new Lane(it => { if (ws.readyState === 1) ws.send(it.data); });
    ws.up = new Lane(it => { if (up.readyState === 1) up.send(it.data); else pending.push(it.data); });
    this.applyNet(ws);
    up.on('open', () => { for (const d of pending.splice(0)) up.send(d); });
    up.on('message', d => { const t = String(d); ws.down.push({ data: t }, droppable(t)); });
    up.on('close', () => { if (ws.readyState === 1) ws.close(1011, 'pi_bridge 關閉了連線'); });
    up.on('error', () => { });
    ws.on('message', d => { const t = String(d); ws.up.push({ data: t }, droppable(t)); });
    ws.on('close', () => { ws.up.clear(); ws.down.clear(); this.links.delete(ws); try { up.close(); } catch (e) { } });
    ws.on('error', () => { });
  }
  async stop() { if (this.child && !this.dead) { this.child.kill('SIGTERM'); await new Promise(r => { this.child.once('exit', r); setTimeout(r, 3000); }); } }
}

module.exports = { PiHost };
