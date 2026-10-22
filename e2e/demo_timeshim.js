// 示範錄影專用：網頁內的時間（performance.now、Date、計時器、requestAnimationFrame）全部改由錄影腳本逐格推進。
// 瀏覽器本身的合成照常運作，所以截圖不會等待；每格推進 40 ms → 成片固定 25 fps，畫面上的時間與真實操作一致。
(() => {
  let vt = 0, id = 0; const raf = []; const timers = new Map(); const per = [];
  const D0 = Date.now(), RD = Date;
  performance.now = () => vt;
  class VDate extends RD { constructor(...a) { if (a.length) super(...a); else super(D0 + vt); } static now() { return D0 + vt; } }
  window.Date = VDate;
  window.requestAnimationFrame = cb => { raf.push([++id, cb]); return id; };
  window.cancelAnimationFrame = i => { const k = raf.findIndex(e => e[0] === i); if (k >= 0) raf.splice(k, 1); };
  const add = (cb, ms, rep, args) => { const t = ++id; timers.set(t, { at: vt + Math.max(0, +ms || 0), cb, rep: rep ? Math.max(1, +ms || 0) : 0, args }); return t; };
  window.setTimeout = (cb, ms, ...a) => add(cb, ms, false, a);
  window.setInterval = (cb, ms, ...a) => add(cb, ms, true, a);
  window.clearTimeout = window.clearInterval = t => timers.delete(t);
  const call = (f, a) => { try { typeof f === 'function' ? f(...(a || [])) : 0; } catch (e) { console.error(e); } };
  window.__perFrame = per;
  window.__step = ms => {
    const end = vt + ms;
    for (let guard = 0; guard < 5000; guard++) {     // 依時間順序執行到期的計時器
      let best = null; for (const [k, t] of timers) if (t.at <= end && (!best || t.at < best[1].at)) best = [k, t];
      if (!best) break;
      const [k, t] = best; vt = Math.max(vt, t.at);
      if (t.rep) t.at += t.rep; else timers.delete(k);
      call(t.cb, t.args);
    }
    vt = end;
    for (const f of per.slice()) call(f, [ms]);
    const cur = raf.splice(0); for (const [, cb] of cur) call(cb, [vt]);
  };
})();
