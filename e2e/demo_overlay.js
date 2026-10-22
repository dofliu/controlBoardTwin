// 示範錄影專用的畫面層（只在錄影時注入，不屬於產品）：游標、點擊波紋、字幕列、章節標題、虛擬硬體指示
(() => {
  const css = `
  #dmCur{position:fixed;left:-50px;top:-50px;width:28px;height:28px;z-index:2147483647;pointer-events:none}
  #dmCur svg{filter:drop-shadow(0 2px 3px rgba(0,0,0,.5))}
  .dmRip{position:fixed;z-index:2147483646;pointer-events:none;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;border:3px solid #ff9a3c;opacity:0}
  #dmCap{position:fixed;left:60px;right:60px;bottom:22px;z-index:2147483640;pointer-events:none;display:flex;justify-content:center}
  #dmCap span{background:rgba(10,16,22,.88);color:#fff;font:600 25px/1.45 "Noto Sans CJK TC","Noto Sans TC",sans-serif;padding:11px 26px;border-radius:12px;max-width:100%;text-align:center;box-shadow:0 8px 28px rgba(0,0,0,.35);letter-spacing:.02em}
  #dmCap b{color:#ffb070;font-weight:700}
  #dmChap{position:fixed;inset:0;z-index:2147483645;pointer-events:none;display:flex;align-items:center;justify-content:center;background:rgba(9,14,19,.78);opacity:0}
    #dmChap .box{text-align:center;color:#fff;font-family:"Noto Sans CJK TC","Noto Sans TC",sans-serif}
  #dmChap .no{font:700 22px "IBM Plex Mono",monospace;letter-spacing:.3em;color:#ffb070}
  #dmChap .t{font-weight:900;font-size:64px;margin:10px 0 8px}
  #dmChap .s{font-size:24px;color:#c8d3dc}
  #dmTag{position:fixed;right:18px;bottom:96px;z-index:2147483640;pointer-events:none;font:700 15px "Noto Sans CJK TC",sans-serif;color:#fff;background:rgba(180,88,28,.92);padding:6px 12px;border-radius:999px;opacity:0}
  #dmHw{position:fixed;left:24px;bottom:96px;z-index:2147483640;pointer-events:none;background:rgba(10,16,22,.9);color:#e8eef2;border-radius:12px;padding:12px 16px;font:500 16px "Noto Sans CJK TC",sans-serif;display:none;min-width:300px;box-shadow:0 8px 24px rgba(0,0,0,.3)}
  #dmHw .h{font-weight:700;color:#ffb070;margin-bottom:6px}
  #dmHw .r{display:flex;align-items:center;gap:10px;margin-top:4px;font-family:"IBM Plex Mono","Noto Sans CJK TC",monospace}
  #dmHw .led{width:18px;height:18px;border-radius:50%;background:#3a1512;box-shadow:inset 0 0 0 2px #5a2a24}
  #dmHw .led.on{background:#ff3b2f;box-shadow:0 0 14px 4px rgba(255,70,50,.75)}
  #dmHw .dmSw{padding:1px 8px;border-radius:6px;background:#26313a}
  #dmHw .dmSw.on{background:#2f7a4a}`;
  function boot() {
    if (document.getElementById('dmCur')) return;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    const cur = document.createElement('div'); cur.id = 'dmCur';
    cur.innerHTML = '<svg width="28" height="28" viewBox="0 0 28 28"><path d="M4 2 L4 22 L9.5 17 L13 25 L16.5 23.5 L13 15.8 L20.5 15.5 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.body.appendChild(cur);
    const move = e => { cur.style.left = (e.clientX - 4) + 'px'; cur.style.top = (e.clientY - 2) + 'px'; };
    window.addEventListener('mousemove', move, true); window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerdown', move, true);
    const cap = document.createElement('div'); cap.id = 'dmCap'; cap.style.opacity = 0; cap.innerHTML = '<span></span>'; document.body.appendChild(cap);
    const ch = document.createElement('div'); ch.id = 'dmChap'; ch.innerHTML = '<div class="box"><div class="no"></div><div class="t"></div><div class="s"></div></div>'; document.body.appendChild(ch);
    const tag = document.createElement('div'); tag.id = 'dmTag'; document.body.appendChild(tag);
    const hw = document.createElement('div'); hw.id = 'dmHw'; document.body.appendChild(hw);
    // 逐格渲染：時間由 Playwright 的虛擬時鐘控制，淡入淡出與波紋都依 performance.now 計算
    const tw = [];
    const tween = (el, from, to, ms, apply, done) => { tw.push({ el, from, to, ms, t0: performance.now(), apply, done }); };
    const loop = () => { const now = performance.now(); for (let i = tw.length - 1; i >= 0; i--) { const t = tw[i]; const k = Math.min(1, (now - t.t0) / t.ms); const e = k * k * (3 - 2 * k); t.apply(t.from + (t.to - t.from) * e); if (k >= 1) { tw.splice(i, 1); t.done && t.done(); } } requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    const fade = (el, to, ms) => tween(el, +getComputedStyle(el).opacity, to, ms || 300, v => el.style.opacity = v);
    window.addEventListener('pointerdown', e => { const r = document.createElement('div'); r.className = 'dmRip'; r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px'; document.body.appendChild(r); tween(r, 0, 1, 600, k => { r.style.transform = `scale(${0.25 + 1.25 * k})`; r.style.opacity = 1 - k; }, () => r.remove()); }, true);
    window.demo = {
      cap(html) { const s = cap.querySelector('span'); if (!html) { fade(cap, 0, 250); return; } const show = () => { s.innerHTML = html; fade(cap, 1, 300); }; if (+getComputedStyle(cap).opacity > 0.05) tween(cap, +getComputedStyle(cap).opacity, 0, 160, v => cap.style.opacity = v, show); else show(); },
      chapter(no, t, s) { ch.querySelector('.no').textContent = no; ch.querySelector('.t').textContent = t; ch.querySelector('.s').textContent = s; ch.style.opacity = 1; tag.textContent = no + '　' + t; },
      chapterOff() { fade(ch, 0, 450); fade(tag, 1, 450); },
      hw(on) {
        hw.style.display = on ? 'block' : 'none'; clearInterval(this._hw);
        if (!on) return;
        this._hw = setInterval(() => {
          const u = window.__vuno; if (!u) return;
          const led = u.isHigh(13), btn = !u.isHigh(2) && u.pinState(2) !== 2 ? true : u.port.D.pinState(2) === 0;
          const pressed = window.__vbtn === true;
          hw.innerHTML = `<div class="h">虛擬 Uno（avr8js 執行真實韌體）</div>
            <div class="r"><span class="dmSw ${pressed ? 'on' : ''}">D2 按鈕 ${pressed ? '按下（LOW）' : '放開（HIGH）'}</span></div>
            <div class="r"><span class="led ${led ? 'on' : ''}"></span><span>D13 腳位 ${led ? 'HIGH' : 'LOW'}</span></div>
            <div class="r" style="color:#93a2ad;font-size:13px">模擬時間 ${(u.cpu.cycles / 16e6).toFixed(2)} s</div>`;
        }, 40);
      }
    };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
