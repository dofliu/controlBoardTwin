// 網路故障注入（雲端虛擬硬體第 3 階段）：在虛擬設備主機與介面之間加上延遲、抖動與掉包。
// 每個方向一條佇列：up＝介面 → 設備（命令），down＝設備 → 介面（量測、回讀）。
// WebSocket 走 TCP：資料只會晚到、不會亂序，所以抖動也保持先後順序（後送的不會比先送的早到）。
// 掉包只丟「資料訊框」（Firmata 位元組）：用來模擬線路雜訊或不可靠的中繼；控制訊息（hello、ping／pong）只延遲、不丟。
class Lane {
  constructor(deliver, rand) {
    this.deliver = deliver; this.rand = rand || Math.random;
    this.cfg = { delayMs: 0, jitterMs: 0, loss: 0 }; this.q = []; this.timer = null; this.lastDue = 0;
    this.stats = { frames: 0, dropped: 0, delayed: 0 };
  }
  set(cfg) { this.cfg = Object.assign({ delayMs: 0, jitterMs: 0, loss: 0 }, cfg || {}); }
  push(item, droppable) {
    this.stats.frames++;
    if (droppable && this.cfg.loss > 0 && this.rand() < this.cfg.loss) { this.stats.dropped++; return; }
    const d = Math.max(0, this.cfg.delayMs + (this.cfg.jitterMs ? (this.rand() * 2 - 1) * this.cfg.jitterMs : 0));
    if (d === 0 && !this.q.length) { this.deliver(item); return; }
    const due = Math.max(Date.now() + d, this.lastDue); this.lastDue = due;   // 保持順序
    this.q.push({ due, item }); this.stats.delayed++; this.arm();
  }
  arm() {
    if (this.timer || !this.q.length) return;
    this.timer = setTimeout(() => {
      this.timer = null; const now = Date.now();
      while (this.q.length && this.q[0].due <= now) this.deliver(this.q.shift().item);
      this.arm();
    }, Math.max(0, this.q[0].due - Date.now()));
  }
  clear() { this.q = []; clearTimeout(this.timer); this.timer = null; this.lastDue = 0; }
}

// 檢查並整理 API 送來的網路設定；dir：both（預設）、up、down
function netConfig(x) {
  if (x === null || x === undefined) return null;
  const n = (v, lo, hi, what) => { const f = v === undefined ? 0 : +v; if (!Number.isFinite(f) || f < lo || f > hi) throw new Error(`${what}要在 ${lo}–${hi} 之間`); return f; };
  const dir = x.dir || 'both';
  if (!['both', 'up', 'down'].includes(dir)) throw new Error('dir 只能是 both、up、down');
  return { delayMs: n(x.delayMs, 0, 5000, '延遲（ms）'), jitterMs: n(x.jitterMs, 0, 5000, '抖動（ms）'), loss: n(x.loss, 0, 1, '掉包比例'), dir };
}

// 一台設備的網路故障設定（虛擬 Uno、虛擬 ESP32、虛擬樹莓派共用）：套用到目前的每個連線，之後的新連線也沿用
class NetHost {
  constructor() { this.links = new Set(); this.net = null; this.faultLog = []; }
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
  // 像網路線被拔掉：不送關閉訊息，直接斷（每個連線）
  cutAll() { if (!this.links.size) return false; this.faultLog.push({ at: Date.now(), fault: 'disconnect' }); for (const l of [...this.links]) l.terminate(); return true; }
}

module.exports = { Lane, netConfig, NetHost };
