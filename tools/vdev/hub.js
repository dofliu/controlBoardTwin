// 多人連線與控制權（雲端虛擬硬體第 5 階段）：一台虛擬設備可以有好幾個 DofLab 連線（老師、助教、學生），
// 都能唯讀觀看；只有拿到控制權的那一個能寫入。晶片只有一份 Firmata 狀態，所以主機在網路與晶片之間做「Firmata 轉接」：
//   介面 → 設備：逐則解析。查詢一律通過（記下是誰問的）；設定輸入（上拉、類比、開啟回報、超音波）只要不碰到別人的輸出就通過；
//               寫入（輸出模式、數位／類比／伺服寫入、系統重置、DTR）只有控制者能送，其他人的寫入在這裡擋下、不會到晶片。
//   設備 → 介面：回報（按鈕、類比、超音波）送給每個連線；查詢的回覆（版本、韌體名稱、腳位能力、類比對應、腳位狀態）只送給問的人，
//               沒有人問的版本與韌體名稱（開機訊息）才送給每個人。這樣別人的交握不會讓你誤判「設備重新開機」，別人的回讀也不會變成你的確認。
// 上傳與序列埠監看（raw）不是 Firmata：需要獨占整台設備，有其他連線時拒絕。
const QUERY_SYSEX = { 0x79: 'fw', 0x6B: 'cap', 0x69: 'amap', 0x6D: 'pin' };
const REPLY_SYSEX = { 0x79: 'fw', 0x6C: 'cap', 0x6A: 'amap', 0x6E: 'pin' };
const INPUT_MODES = [0x00, 0x02, 0x0B];   // INPUT、ANALOG、INPUT_PULLUP
const ASK_MS = 3000;                      // 查詢超過這麼久沒有回覆就不再等（例如設備在交握時重新開機）
const LOCK_IDLE_MS = 10000;               // 控制者這麼久沒有任何訊息（網路斷了但沒有關閉）就釋放控制權

// 逐位元組組成完整的 Firmata 訊息（兩個方向共用）
class Framer {
  constructor() { this.cur = null; this.sysex = null; }
  // 回傳完整訊息的陣列（每則是位元組陣列）
  feed(bytes) {
    const out = [];
    for (const b of bytes) {
      if (this.sysex) { this.sysex.push(b); if (b === 0xF7) { out.push(this.sysex); this.sysex = null; } continue; }
      if (b === 0xF0) { this.sysex = [b]; this.cur = null; continue; }
      if (b & 0x80) {
        this.cur = [b];
        if (b === 0xFF) { out.push(this.cur); this.cur = null; }   // 系統重置：一個位元組
        else if (b === 0xF9 && this.dir === 'up') { out.push(this.cur); this.cur = null; }   // 介面送的版本查詢只有一個位元組
        continue;
      }
      if (!this.cur) continue;   // 沒有命令位元組的資料：丟掉（Firmata 也會忽略）
      this.cur.push(b); const c = this.cur[0];
      const need = (c & 0xF0) === 0xC0 || (c & 0xF0) === 0xD0 ? 2 : 3;
      if (this.cur.length >= need) { out.push(this.cur); this.cur = null; }
    }
    return out;
  }
}

class Hub {
  // send(link, bytes)：送位元組給某個連線；toDevice(bytes)：送給晶片；notify(link, obj)：送控制訊息
  constructor(opts) {
    this.send = opts.send; this.toDevice = opts.toDevice; this.notify = opts.notify; this.log = opts.log || (() => { });
    this.links = new Map(); this.seq = 0; this.holder = null; this.rawLink = null;
    this.down = new Framer(); this.asks = { ver: [], fw: [], cap: [], amap: [], pin: [] };
    this.outputs = new Map();   // 腳位 → 設成輸出的連線 id（控制者）
    this.reports = new Map();   // 'd3'／'a0' → Set(連線 id)：誰開了回報
    this.sonars = new Map();    // trig 腳位 → Set(連線 id)
    this.stats = { blocked: 0, passed: 0 };
    this.timer = setInterval(() => this.checkIdle(), 1000); if (this.timer.unref) this.timer.unref();
  }
  stop() { clearInterval(this.timer); }
  // 新連線：mode 'firmata'（DofLab 觀測頁）或 'raw'（上傳、序列埠監看：需要獨占）
  join(ws, hello) {
    // 對方已經送出關閉（客戶端關掉後馬上重新連線，例如關掉序列埠監看後立刻連觀測頁）：主機的 close 事件可能還沒到，先當成已離開
    for (const l of [...this.links.values()]) if (l.ws && l.ws.readyState >= 2) this.leave(l);
    const mode = hello.mode === 'raw' ? 'raw' : 'firmata';
    if (this.rawLink) return { error: 'busy', message: `虛擬設備正在上傳程式或開著序列埠監看（${this.rawLink.name}），暫時不能連線。` };
    if (mode === 'raw' && this.links.size) return { error: 'busy', message: `有 ${this.links.size} 個連線正在觀看這台虛擬設備（${[...this.links.values()].map(l => l.name).join('、')}）：上傳與序列埠監看需要獨占，請其他人先中斷連線。` };
    const name = String(hello.name || '').trim().slice(0, 24) || `連線 ${this.seq + 1}`;
    const link = { id: 'L' + (++this.seq), ws, name, mode, up: new Framer(), blocked: 0, passed: 0, since: Date.now(), seen: Date.now() };
    link.up.dir = 'up';
    this.links.set(link.id, link); if (mode === 'raw') this.rawLink = link;
    return { link };   // 主機送出 hello 之後再呼叫 presence('join')
  }
  leave(link) {
    if (!this.links.has(link.id)) return;
    this.links.delete(link.id);
    if (this.rawLink === link) { this.rawLink = null; this.down = new Framer(); }   // 上傳之後的位元組不是 Firmata：重新開始解析
    for (const s of this.reports.values()) s.delete(link.id);
    for (const s of this.sonars.values()) s.delete(link.id);
    for (const k of Object.keys(this.asks)) this.asks[k] = this.asks[k].filter(a => a.link !== link);
    const wasHolder = this.holder === link;
    if (wasHolder) this.holder = null;
    this.presence(wasHolder ? 'holder-left' : 'leave', link);
  }
  seen(link) { link.seen = Date.now(); }
  checkIdle() {
    const h = this.holder; if (!h || Date.now() - h.seen < LOCK_IDLE_MS) return;
    this.holder = null; this.log(`控制權逾時釋放（${h.name}）`); this.presence('timeout', h);
  }
  // 控制權：want 'control' 取得、'release' 釋放
  lock(link, want) {
    if (want === 'release') { if (this.holder === link) { this.holder = null; this.presence('release', link); } return { op: 'lock', ok: true, you: false, holder: null }; }
    if (this.holder && this.holder !== link) return { op: 'lock', ok: false, you: false, holder: this.who(this.holder), message: `控制權在「${this.holder.name}」手上；你只能唯讀觀看。等對方撤銷授權或中斷連線後再試。` };
    const fresh = this.holder !== link; this.holder = link; if (fresh) this.presence('lock', link);
    return { op: 'lock', ok: true, you: true, holder: this.who(link) };
  }
  who(l) { return l ? { id: l.id, name: l.name } : null; }
  presence(why, by) {
    const list = [...this.links.values()].map(l => ({ id: l.id, name: l.name, mode: l.mode, control: this.holder === l }));
    for (const l of this.links.values()) this.notify(l, { op: 'presence', you: l.id, links: list, holder: this.who(this.holder), why, by: by ? by.name : null });
  }
  // DTR／RTS：會讓晶片重新啟動，算寫入；控制者，或沒有人控制且只有自己一個連線時才可以
  signalsAllowed(link) { return link.mode === 'raw' || this.holder === link || (!this.holder && this.links.size === 1); }

  /* ---------- 介面 → 設備 ---------- */
  fromLink(link, bytes) {
    this.seen(link);
    if (link.mode === 'raw') { this.toDevice(bytes); return; }
    const pass = [];
    for (const m of link.up.feed(bytes)) {
      const v = this.judge(link, m);
      if (v === true) { pass.push(...m); link.passed++; this.stats.passed++; }
      else { link.blocked++; this.stats.blocked++; if (!link.warned || Date.now() - link.warned > 5000) { link.warned = Date.now(); this.notify(link, { op: 'error', code: 'not_holder', message: v }); } }
    }
    if (pass.length) this.toDevice(Uint8Array.from(pass));
  }
  // true：通過；字串：擋下的原因
  judge(link, m) {
    const c = m[0], holder = this.holder === link;
    const ask = (k, extra) => { this.asks[k].push(Object.assign({ link, t: Date.now() }, extra || {})); return true; };
    const notMine = '你沒有控制權：寫入已被虛擬設備主機擋下，沒有送到晶片。' + (this.holder ? `（控制中：${this.holder.name}）` : '（請先「授權受控寫入」取得控制權）');
    if (c === 0xF9) return ask('ver');
    if (c === 0xF0) {
      const s = m[1];
      if (QUERY_SYSEX[s]) return ask(QUERY_SYSEX[s], s === 0x6D ? { pin: m[2] } : null);
      if (s === 0x62) {   // DofLab 擴充：超音波（TRIG 會變成輸出）；7F＝停止
        if (m[2] === 0x7F) { const mine = [...this.sonars.entries()].filter(([, set]) => set.has(link.id)); for (const [, set] of mine) set.delete(link.id); return [...this.sonars.values()].some(set => set.size) ? '其他連線還在用超音波，沒有停止量測。' : true; }
        const trig = m[2], o = this.outputs.get(trig); if (o && o !== link.id && !holder) return `D${trig} 是別人的輸出腳位，不能改成超音波。`;
        if (!this.sonars.has(trig)) this.sonars.set(trig, new Set()); this.sonars.get(trig).add(link.id); return true;
      }
      return holder ? true : notMine;   // 伺服設定、類比寫入、取樣間隔、其他：都會改變設備
    }
    const hi = c & 0xF0;
    if (c === 0xF4) {   // 腳位模式
      const pin = m[1], mode = m[2], o = this.outputs.get(pin);
      if (INPUT_MODES.includes(mode)) {
        if (o && o !== link.id && !holder) return `D${pin} 是控制者的輸出腳位，不能改成輸入。`;   // 控制者可以改任何腳位（例如前一個控制者關掉分頁、沒有撤銷就離開）
        this.outputs.delete(pin); return true;
      }
      if (!holder) return notMine;
      this.outputs.set(pin, link.id); return true;
    }
    if (hi === 0xC0 || hi === 0xD0) {   // 開啟／關閉回報：開啟一律可以；關閉時如果別人還要就不關
      const k = (hi === 0xC0 ? 'a' : 'd') + (c & 0x0F);
      if (!this.reports.has(k)) this.reports.set(k, new Set());
      const set = this.reports.get(k);
      if (m[1]) { set.add(link.id); return true; }
      set.delete(link.id); return set.size ? '其他連線還在看這個回報，沒有關閉。' : true;
    }
    return holder ? true : notMine;   // 數位寫入（F5、9x）、類比寫入（Ex）、系統重置（FF）
  }

  /* ---------- 設備 → 介面 ---------- */
  fromDevice(bytes) {
    if (this.rawLink) { this.send(this.rawLink, bytes); return; }
    const per = new Map([...this.links.values()].map(l => [l, []]));   // 每個連線依原本的順序收
    for (const m of this.down.feed(bytes)) {
      const c = m[0];
      let key = null; if (c === 0xF9) key = 'ver'; else if (c === 0xF0 && REPLY_SYSEX[m[1]]) key = REPLY_SYSEX[m[1]];
      const a = key ? this.takeAsk(key, key === 'pin' ? m[2] : null) : null;
      if (a) { if (per.has(a.link)) per.get(a.link).push(...m); continue; }
      for (const arr of per.values()) arr.push(...m);
    }
    for (const [l, arr] of per) if (arr.length) this.send(l, Uint8Array.from(arr));
  }
  takeAsk(key, pin) {
    const now = Date.now(); const q = this.asks[key];
    while (q.length && now - q[0].t > ASK_MS) q.shift();
    const i = pin === null ? 0 : q.findIndex(a => a.pin === pin);
    if (i < 0 || !q.length) return null;
    return q.splice(i, 1)[0];
  }
  state() {
    return { holder: this.who(this.holder), raw: !!this.rawLink, links: [...this.links.values()].map(l => ({ id: l.id, name: l.name, mode: l.mode, control: this.holder === l, passed: l.passed, blocked: l.blocked, since: l.since })), blocked: this.stats.blocked, outputs: [...this.outputs.keys()] };
  }
}

module.exports = { Hub, Framer, LOCK_IDLE_MS };
