"""產生示範影片的片頭、流程、測試結果、未驗證事項、片尾五個 HTML 場景（以 intro-video 模板為底）。"""
import pathlib, re
S = pathlib.Path('/root/.claude/skills/synced/79704726-45c7-4e0f-94ad-410c81141e6c_9d78875b-375d-428a-9731-649c89ad27d3/intro-video/assets/scene_template.html')
T = S.read_text()
HERE = pathlib.Path(__file__).parent

# DofLab 的配色：橘（強調）＋深藍綠；把模板的 teal/violet 換成橘/青
THEME = """
.bg{background:radial-gradient(1200px 800px at 24% 18%,rgba(255,154,60,.13),transparent 62%),radial-gradient(1100px 760px at 78% 82%,rgba(45,190,200,.13),transparent 60%),linear-gradient(160deg,#10202a 0%,#081118 58%,#05080c 100%)}
.aur.a{background:radial-gradient(circle,rgba(255,150,60,.26),transparent 62%)}
.aur.b{background:radial-gradient(circle,rgba(40,190,200,.24),transparent 62%)}
.kicker{color:#ffa955}
.h1{background:linear-gradient(100deg,#fff7ef 15%,#ffc58a 50%,#8fe3e6 85%);-webkit-background-clip:text;background-clip:text;color:transparent;filter:drop-shadow(0 8px 40px rgba(255,150,60,.18))}
.accent{color:#ffa955}
.badge{background:rgba(255,150,60,.12);border-color:rgba(255,150,60,.45);color:#ffc999}
.logoMark{width:150px;height:150px;border-radius:40px;background:conic-gradient(from 45deg,#e8772e 0 25%,#1d2a33 0 50%,#e8772e 0 75%,#1d2a33 0);box-shadow:0 20px 60px rgba(232,119,46,.35),inset 0 0 0 3px rgba(255,255,255,.08)}
"""

def scene(name, title, dur, css, body, particles=True):
    h = T.replace('<title>SceneXX 標題</title>', f'<title>{title}</title>')
    h = h.replace('/* ▼▼ 本景專屬 CSS 寫在這 ▼▼ */', '/* ▼▼ 本景專屬 CSS 寫在這 ▼▼ */' + THEME + css)
    h = re.sub(r'<!-- ▼▼ 本景內容.*?<!-- ▲▲ 本景內容到此 ▲▲ -->', lambda m: body, h, flags=re.S)
    h = h.replace('--dur:7s', f'--dur:{dur}s')
    if not particles:
        h = re.sub(r'<canvas id="fx".*?</script>', '', h, flags=re.S)
    else:
        h = h.replace("'45,212,191':'167,139,250'", "'255,170,90':'110,215,220'")
    (HERE / f'{name}.html').write_text(h)

# 1 開場
scene('s01_open', 'DofLab 開場', 7, """
.boards{display:flex;gap:26px;margin-top:64px}
""", """
 <div class="logoMark pop" style="--d:.1s"></div>
 <div class="kicker in" style="--d:.45s;margin-top:44px">DOFLAB V2.1 · 原型示範</div>
 <div class="h1 pop" style="--d:.7s;margin-top:22px;font-size:170px">DofLab</div>
 <div class="sub in" style="--d:1.3s;margin-top:26px">從<span class="accent">電路配置、行為設計、模擬測試</span>，到<span class="accent">真實設備同步</span></div>
 <div class="boards">
  <div class="chip in" style="--d:1.9s">Arduino Uno R3</div>
  <div class="chip in" style="--d:2.1s">ESP32-DevKitC V4</div>
  <div class="chip in" style="--d:2.3s">Raspberry Pi 4B</div>
 </div>
""")

# 2 流程
scene('s02_flow', 'DofLab 流程', 8, """
.row{display:flex;gap:30px;margin-top:70px;align-items:stretch}
.step{width:300px;padding:34px 30px 32px;text-align:left;position:relative}
.step .n{font:800 28px "IBM Plex Mono",monospace;color:#ffa955;letter-spacing:.1em}
.step .t{font-size:48px;font-weight:900;margin:10px 0 14px;white-space:nowrap}
.step .d{font-size:27px;line-height:1.55;color:rgba(232,238,247,.78)}
.step .bar{position:absolute;left:30px;right:30px;bottom:18px;height:5px;border-radius:3px;background:rgba(255,255,255,.08);overflow:hidden}
.step .bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#ff9a3c,#ffd29a);animation:fill .7s ease-out forwards;animation-delay:var(--f)}
@keyframes fill{to{width:100%}}
.note{margin-top:64px;font-size:30px;color:rgba(232,238,247,.6)}
""", """
 <div class="kicker in" style="--d:.1s">一條完整的流程</div>
 <div class="h1 in" style="--d:.35s;margin-top:18px;font-size:96px">五個分頁，從接線到手臂</div>
 <div class="row">
  <div class="card step in" style="--d:.9s"><div class="n">01</div><div class="t">配置</div><div class="d">擺放元件、接線<br>電路檢查・整線</div><div class="bar"><i style="--f:2.2s"></i></div></div>
  <div class="card step in" style="--d:1.1s"><div class="n">02</div><div class="t">行為</div><div class="d">視覺積木<br>行為摘要與確認</div><div class="bar"><i style="--f:2.8s"></i></div></div>
  <div class="card step in" style="--d:1.3s"><div class="n">03</div><div class="t">程式</div><div class="d">C++／Python 產生<br>正式工具鏈編譯</div><div class="bar"><i style="--f:3.4s"></i></div></div>
  <div class="card step in" style="--d:1.5s"><div class="n">04</div><div class="t">觀測</div><div class="d">模擬與數位孿生<br>先唯讀、再授權</div><div class="bar"><i style="--f:4.0s"></i></div></div>
  <div class="card step in" style="--d:1.7s"><div class="n">05</div><div class="t">手臂</div><div class="d">三軸逆運動學<br>限位・姿態播放</div><div class="bar"><i style="--f:4.6s"></i></div></div>
 </div>
 <div class="note in" style="--d:5.2s">以下是實際操作畫面，依序示範每個功能</div>
""", particles=False)

# 3 測試結果
scene('s03_tests', 'DofLab 測試結果', 9, """
.big{display:flex;align-items:baseline;gap:28px;margin-top:20px}
.num{font:900 230px/1 "IBM Plex Mono","Noto Sans CJK TC",monospace;color:#ffb36b;filter:drop-shadow(0 10px 50px rgba(255,150,60,.35))}
.unit{font-size:56px;font-weight:800}
.row{display:flex;gap:30px;margin-top:46px}
.t3{width:420px;padding:30px 34px;text-align:left}
.t3 .k{font-size:28px;color:rgba(232,238,247,.7)}
.t3 .v{font:800 64px "IBM Plex Mono",monospace;margin-top:6px}
.t3 .v small{font-size:30px;color:#7fe0b0;margin-left:10px;font-family:"Noto Sans CJK TC",sans-serif}
.t3 .d{font-size:24px;color:rgba(232,238,247,.6);margin-top:8px;line-height:1.5}
.badges{display:flex;gap:22px;margin-top:44px}
""", """
 <div class="kicker in" style="--d:.1s">測試結果</div>
 <div class="big in" style="--d:.35s"><span class="num" id="n">0</span><span class="unit">項自動測試<br><span style="color:#7fe0b0">全部通過</span></span></div>
 <div class="row">
  <div class="card t3 in" style="--d:1.2s"><div class="k">Node 單元與整合</div><div class="v">49<small>/ 49</small></div><div class="d">網表、行為、程式等價<br>整線、手臂、Firmata</div></div>
  <div class="card t3 in" style="--d:1.4s"><div class="k">Python 服務</div><div class="v">7<small>/ 7</small></div><div class="d">編譯服務、Pi 閘道協定<br>Pi 程式產生</div></div>
  <div class="card t3 in" style="--d:1.6s"><div class="k">瀏覽器端到端</div><div class="v">79<small>/ 79</small></div><div class="d">桌面、手機、深色模式<br>Pi 閘道、手臂、虛擬 Uno</div></div>
 </div>
 <div class="badges">
  <span class="badge in" style="--d:2.4s">arduino-cli 真實編譯 Uno／ESP32</span>
  <span class="badge in" style="--d:2.6s">avr8js 執行真實韌體</span>
  <span class="badge in" style="--d:2.8s">C++ 與模擬逐步比對</span>
 </div>
 <script>
 (()=>{const el=document.getElementById('n');const t0=600,T=1600;function f(){const k=Math.min(1,Math.max(0,(performance.now()-t0)/T));const e=1-Math.pow(1-k,3);el.textContent=Math.round(135*e);if(k<1)requestAnimationFrame(f);}requestAnimationFrame(f);})();
 </script>
""", particles=False)

# 4 未驗證事項（誠實標示）
scene('s04_limits', 'DofLab 未驗證事項', 9, """
.list{margin-top:56px;display:flex;flex-direction:column;gap:22px;width:1360px}
.it{display:flex;gap:28px;align-items:center;padding:26px 36px;text-align:left}
.tag{flex:none;min-width:156px;text-align:center;font-size:26px;font-weight:800;padding:8px 18px;border-radius:10px;white-space:nowrap}
.tag.u{background:rgba(255,190,70,.14);border:1.5px solid rgba(255,190,70,.55);color:#ffd27a}
.tag.p{background:rgba(120,200,255,.12);border:1.5px solid rgba(120,200,255,.45);color:#a9dcff}
.it .x{font-size:33px;line-height:1.5}
.it .x small{display:block;font-size:24px;color:rgba(232,238,247,.6);margin-top:2px}
""", """
 <div class="kicker in" style="--d:.1s">誠實標示</div>
 <div class="h1 in" style="--d:.3s;margin-top:16px;font-size:92px">還沒驗證的部分</div>
 <div class="list">
  <div class="card it in" style="--d:1.0s"><span class="tag u">未驗證</span><div class="x">尚未在實體 Uno、ESP32、Raspberry Pi 上燒錄與接線測試<small>示範中的「真機」是晶片模擬器執行真實韌體；實機需在授權設備上另行驗收</small></div></div>
  <div class="card it in" style="--d:1.4s"><span class="tag u">未驗證</span><div class="x">SG90 伺服與 LED 沒有回授<small>畫面顯示的是送出的命令與腳位回讀，不是實際角度或亮度的量測</small></div></div>
  <div class="card it in" style="--d:1.8s"><span class="tag p">設計提案</span><div class="x">手臂尺寸、關節範圍、零位與方向是教學假設<small>接實物前要逐軸量測並修改；伺服需外部 5V 電源並與控制板共地</small></div></div>
 </div>
""", particles=False)

# 5 片尾
scene('s05_end', 'DofLab 片尾', 7, """
.feat{display:flex;gap:22px;margin-top:56px}
.foot{margin-top:58px;font-size:28px;color:rgba(232,238,247,.58)}
""", """
 <div class="logoMark pop" style="--d:.1s;width:120px;height:120px;border-radius:32px"></div>
 <div class="h1 pop" style="--d:.45s;margin-top:34px;font-size:150px">DofLab</div>
 <div class="sub in" style="--d:1.0s;margin-top:20px">下一步：在授權的實體設備上，依驗收清單逐項確認</div>
 <div class="feat">
  <div class="chip in" style="--d:1.5s">三種控制板</div>
  <div class="chip in" style="--d:1.7s">真實編譯</div>
  <div class="chip in" style="--d:1.9s">數位孿生</div>
  <div class="chip in" style="--d:2.1s">三軸手臂</div>
 </div>
 <div class="foot in" style="--d:2.6s">V2.1 私人原型・不公開部署・畫面皆為實際操作錄製</div>
""")
print('ok')
