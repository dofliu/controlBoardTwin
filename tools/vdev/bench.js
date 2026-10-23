// 虛擬工作台（bench）：虛擬板子「外面的世界」——實際接了哪些元件、元件怎麼影響腳位。
// 刻意不使用 src/core/engine.js：如果工作台和介面共用同一份模擬，兩邊一定一致，等於自己驗證自己。
// 第 1 階段只有兩種元件、最簡單的模型（教學假設）：
//   button  按下時把腳位拉到 GND；放開時視為高電位（假設韌體開了內部上拉）。彈跳在第 2 階段加入。
//   led     依腳位的實際電位（不是介面的 ACK）判斷亮滅；以 5 V、順向電壓 2.0 V、限流電阻估算電流。
// 介面看不到工作台：介面只看得到 Firmata 回報的東西（量測、回讀）。工作台的狀態只給工作台頁、測試與老師看。
const avr = require('avr8js');

// 預設工作台：和引導實驗「按住閃爍」同樣的接線（BTN1：D2 接 GND；LED1：D13 經 220 Ω）
const DEFAULT_BENCH = { id: 'bench-a', name: '按鈕＋LED（與「按住閃爍」相同接線）', parts: [{ id: 'BTN1', type: 'button', pin: 2 }, { id: 'LED1', type: 'led', pin: 13, ohm: 220 }] };
const VCC = 5, LED_VF = 2.0;

class Bench {
  constructor(uno, spec) {
    this.uno = uno; this.spec = JSON.parse(JSON.stringify(spec || DEFAULT_BENCH));
    this.parts = {}; this.log = [];
    for (const p of this.spec.parts) {
      if (!['button', 'led'].includes(p.type)) throw new Error(`工作台第 1 階段不支援元件類型 ${p.type}（${p.id}）`);
      if (!(Number.isInteger(p.pin) && p.pin >= 0 && p.pin <= 19)) throw new Error(`${p.id} 的腳位 ${p.pin} 不是 Uno 的 D0–D13／A0–A5（14–19）`);
      this.parts[p.id] = Object.assign({ pressed: false, on: false, toggles: 0, lastChangeMs: null }, p);
    }
    for (const p of Object.values(this.parts)) if (p.type === 'button') this.uno.setInput(p.pin, true);   // 放開
    this.uno.pinWatchers.push(() => this.sense());
    this.sense();
  }
  // 讀晶片腳位，更新 LED（腳位是輸出且為高電位才亮）
  sense() {
    for (const p of Object.values(this.parts)) {
      if (p.type !== 'led') continue;
      const on = this.uno.pinState(p.pin) === avr.PinState.High;
      if (on !== p.on) { p.on = on; p.toggles++; p.lastChangeMs = this.uno.timeMs; }
    }
  }
  // 工作台操作：{part, action:'press'|'release'}
  act(q) {
    const p = this.parts[q && q.part];
    if (!p) throw new Error(`工作台上沒有元件 ${q && q.part}`);
    if (p.type !== 'button' || !['press', 'release'].includes(q.action)) throw new Error(`${p.id}（${p.type}）不能做「${q.action}」`);
    p.pressed = q.action === 'press';
    this.uno.setInput(p.pin, !p.pressed);
    this.log.push({ devMs: this.uno.timeMs, part: p.id, action: q.action }); if (this.log.length > 100) this.log.shift();
    return this.partState(p);
  }
  partState(p) {
    if (p.type === 'button') return { id: p.id, type: p.type, pin: p.pin, pressed: p.pressed };
    const mA = p.on ? Math.round((VCC - LED_VF) / p.ohm * 1000 * 10) / 10 : 0;
    return { id: p.id, type: p.type, pin: p.pin, ohm: p.ohm, on: p.on, mA, overCurrent: mA > 20, toggles: p.toggles, lastChangeMs: p.lastChangeMs };
  }
  state() { return { id: this.spec.id, name: this.spec.name, parts: Object.values(this.parts).map(p => this.partState(p)), log: this.log.slice(-20) }; }
}

module.exports = { Bench, DEFAULT_BENCH };
