"""DofLab 示範影片錄製：以 Playwright 操作真實網頁並錄影（每章一段）。
用法：python3 e2e/demo_record.py [章節編號 ...]   輸出：$DEMO_OUT/ch<N>.webm 與 ch<N>.json（剪輯起點）"""
import asyncio, json, os, sys, time, math, subprocess, socket, pathlib
from playwright.async_api import async_playwright
ROOT = pathlib.Path(__file__).resolve().parent.parent; DIST = ROOT / 'dist'
OUT = pathlib.Path(os.environ.get('DEMO_OUT', '/tmp/doflab-demo')); OUT.mkdir(parents=True, exist_ok=True)
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
W, H = 1600, 900
OVERLAY = (ROOT / 'e2e' / 'demo_overlay.js').read_text()
SHIM = (ROOT / 'e2e' / 'demo_timeshim.js').read_text()

FPS = 25; FRAME_MS = 1000 / FPS

class Rec:
    """逐格錄製：每推進虛擬時鐘 1/25 秒就截一張圖（不受軟體渲染速度影響，成片流暢）。"""
    def __init__(self, pg, frames_dir):
        self.pg = pg; self.x, self.y = W / 2, H / 2; self.dir = frames_dir; self.n = 0; self.recording = False
    async def ev(self, js, *a): return await self.pg.evaluate(js, *a)
    async def frame(self):
        await self.pg.evaluate(f'__step({FRAME_MS})')
        if self.recording:
            self.n += 1; await self.pg.screenshot(path=str(self.dir / f"f_{self.n:06d}.jpg"), type='jpeg', quality=90)
    async def wait(self, s):
        for _ in range(max(1, round(s * FPS))): await self.frame()
    async def until(self, js, max_s=240):
        t0 = time.monotonic()
        while not await self.ev(js):
            await self.frame()
            if time.monotonic() - t0 > max_s: raise TimeoutError(js)
    async def cap(self, html, hold=0): await self.ev("h => demo.cap(h)", html); await self.wait(max(0.04, hold))
    async def glide(self, x, y, speed=1.0):
        d = math.hypot(x - self.x, y - self.y); steps = max(8, int(d / (26 * speed)))
        x0, y0 = self.x, self.y
        for i in range(1, steps + 1):
            t = i / steps; e = t * t * (3 - 2 * t)
            await self.pg.mouse.move(x0 + (x - x0) * e, y0 + (y - y0) * e); await self.frame()
        self.x, self.y = x, y
    async def click_xy(self, x, y, pause=0.35):
        await self.glide(x, y); await self.wait(0.12); await self.pg.mouse.down(); await self.frame(); await self.frame(); await self.pg.mouse.up(); await self.wait(pause)
    async def center(self, sel):
        el = self.pg.locator(sel).first
        b = await el.bounding_box()
        if b is None or b['y'] < 70 or b['y'] + b['height'] > H - 110:
            await self.scroll_to(sel); b = await el.bounding_box()
        return b['x'] + b['width'] / 2, b['y'] + b['height'] / 2
    async def click(self, sel, pause=0.5): x, y = await self.center(sel); await self.click_xy(x, y, pause)
    async def ep(self, comp, term): return await self.ev("ep => doflab.scene.screenOf(ep)", {'comp': comp, 'term': term})
    async def drag(self, pts, hold_end=0.1, step_ms=None):
        await self.glide(*pts[0]); await self.pg.mouse.down(); await self.frame()
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            n = max(2, int(math.hypot(x1 - x0, y1 - y0) / 14))
            for i in range(1, n + 1): await self.pg.mouse.move(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n); await self.frame()
        self.x, self.y = pts[-1]; await self.wait(hold_end); await self.pg.mouse.up(); await self.frame()
    async def chapter(self, no, t, s, hold=2.3):
        await self.ev("([a,b,c]) => demo.chapter(a,b,c)", [no, t, s]); await self.wait(hold); await self.ev("demo.chapterOff()"); await self.wait(0.6)
    async def scroll_to(self, sel, block='center'):
        target = await self.ev("""([s,b]) => { const el = document.querySelector(s); const r = el.getBoundingClientRect(); const y = b === 'start' ? scrollY + r.top - 130 : scrollY + r.top + r.height / 2 - innerHeight / 2; return Math.max(0, Math.min(y, document.documentElement.scrollHeight - innerHeight)); }""", [sel, block])
        y0 = await self.ev("scrollY"); n = 14
        for i in range(1, n + 1):
            t = i / n; e = t * t * (3 - 2 * t); await self.ev(f"window.scrollTo(0, {y0 + (target - y0) * e})"); await self.frame()

async def session(p, name, body, virtual=False):
    frames = OUT / f'{name}_frames'
    if frames.exists():
        for f in frames.iterdir(): f.unlink()
    frames.mkdir(parents=True, exist_ok=True)
    b = await p.chromium.launch(args=ARGS)
    ctx = await b.new_context(viewport={'width': W, 'height': H}, device_scale_factor=1.2)
    init = SHIM + '\n' + OVERLAY
    if virtual:
        bundle = (ROOT / 'e2e' / 'virtual_uno.bundle.js').read_text(); hexText = (ROOT / 'tests' / 'fixtures' / 'DofLabFirmata-uno.hex').read_text()
        init = SHIM + '\n' + bundle + "\nwindow.addEventListener('DOMContentLoaded',()=>DofLabVirtual.install(" + json.dumps(hexText) + "));\n" + OVERLAY
    await ctx.add_init_script(init)
    await ctx.route("**/fonts.googleapis.com/**", lambda rt: rt.abort()); await ctx.route("**/fonts.gstatic.com/**", lambda rt: rt.abort())
    pg = await ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.goto('http://localhost:8766/')
    r = Rec(pg, frames)
    for _ in range(400):
        if await pg.evaluate("!!(window.doflab && doflab.p && window.demo)"): break
        await pg.evaluate('__step(100)')
    await pg.mouse.move(W / 2, H / 2)
    await body(r, prepare=True); await r.wait(0.5)
    r.recording = True; t0 = time.monotonic()
    await body(r, prepare=False)
    await r.ev("demo.cap('')"); await r.wait(0.6)
    await ctx.close(); await b.close()
    (OUT / f'{name}.json').write_text(json.dumps({'frames': r.n, 'seconds': round(r.n / FPS, 2), 'render_s': round(time.monotonic() - t0), 'errors': errs}, ensure_ascii=False))
    print(name, 'frames', r.n, '=', round(r.n / FPS, 1), 's video;', round(time.monotonic() - t0), 's render; errors', errs[:2], flush=True)

def loader(js):
    return "(()=>{" + js + "})()"
LOAD_SOLVED = lambda exp, board, name: loader(f"const r=DL.experiments.solved('{exp}','{board}');doflab.load(DL.project.clone(r.project,{{name:'{name}',origin:{{kind:'custom'}},lock:{{components:false,behavior:false,board:false}}}}));doflab.banner(null);")

# ---------------- 第 1 章：配置與接線 ----------------
async def ch1(r, prepare):
    if prepare:
        await r.ev("doflab.banner(null)"); await r.wait(0.6); return None
    await r.chapter('第 1 章', '配置與接線', '引導實驗「按住閃爍」· Arduino Uno R3')
    await r.cap('打開「開始／實驗」，選擇引導實驗<b>按住閃爍</b>（Uno R3）', 0.6)
    await r.click('#btnStart', 0.9)
    await r.click('[data-exp="hold-blink"][data-board="uno"]', 1.0)
    await r.cap('元件已就位，<b>元件與行為鎖定</b>；學生只需要完成接線', 2.2)
    await r.click('#vpConfig [data-view="top"]', 0.8)
    await r.cap('點一個腳位、再點元件端子，就建立一條連線；滑過腳位會顯示它的能力', 0.4)
    pins = [(('board', 'D2'), ('BTN1', '1')), (('BTN1', '2'), ('board', 'GND1')), (('board', 'D13'), ('R1', '1')), (('R1', '2'), ('LED1', 'A')), (('LED1', 'K'), ('board', 'GND2'))]
    for k, (a, b) in enumerate(pins):
        pa = await r.ep(*a); await r.glide(pa['x'], pa['y'])
        if k == 0: await r.wait(1.4)   # 停一下讓提示框顯示腳位能力
        await r.click_xy(pa['x'], pa['y'], 0.25)
        pb = await r.ep(*b); await r.glide(pb['x'], pb['y'], speed=0.7); await r.click_xy(pb['x'], pb['y'], 0.5)
        if k == 2: await r.cap('右側「電路檢查」即時更新：腳位、上拉、限流電阻與估計電流', 0.2)
    await r.wait(0.8)
    await r.cap('把 LED 兩腳直接相連？平台拒絕：<b>等於讓元件自己短路</b>', 0.3)
    pa = await r.ep('LED1', 'A'); pb = await r.ep('LED1', 'K'); await r.click_xy(pa['x'], pa['y'], 0.2); await r.click_xy(pb['x'], pb['y'], 1.6)
    await r.click('#vpConfig [data-view="iso"]', 0.6)
    await r.cap('<b>自動整線</b>：每條線依最佳路徑正交走線、避開元件、彼此不重疊', 2.4)
    await r.click('#tglWire', 1.6)
    await r.cap('切成弧線比較——整線只改變外觀，<b>網表與程式完全不變</b>', 1.4)
    await r.click('#tglWire', 1.2)
    await r.cap('真 3D 場景：360° 旋轉、縮放，從各角度檢查接線', 0.3)
    vp = await r.center('#vpConfig'); x0, y0 = vp[0] - 330, vp[1] + 200
    await r.drag([(x0, y0), (x0 + 260, y0 - 30), (x0 + 120, y0 + 10)], step_ms=22)
    await r.ev("doflab.scene.cam.r *= 0.82"); await r.wait(1.2)
    tasks = await r.ev("[...document.querySelectorAll('#taskList li')].filter(l=>l.classList.contains('done')).length")
    await r.cap(f'引導任務自動打勾：接線類任務 {tasks} 項完成', 2.2)

# ---------------- 第 2 章：擬真板子 ----------------
async def ch2(r, prepare):
    if prepare:
        await r.ev(LOAD_SOLVED('hold-blink', 'uno', '擬真板子：Uno R3')); await r.wait(0.8); return None
    await r.chapter('第 2 章', '擬真 3D 控制板', 'Arduino Uno R3 · ESP32-DevKitC V4 · Raspberry Pi 4B')
    spin = "(()=>{if(!window.__spin){window.__spin=()=>{doflab.scene.cam.theta+=0.016};__perFrame.push(window.__spin)}})()"
    for board, text in [('uno', '<b>Uno R3</b>：依機構尺寸建模——ATmega328P、USB-B、電源插座、排母'), ('esp32', '<b>ESP32-DevKitC V4</b>：WROOM-32 模組與天線、按鈕、排針，3.3 V 邏輯'), ('pi4b', '<b>Raspberry Pi 4B</b>：SoC、記憶體、USB 3／USB 2、乙太網路、40-pin GPIO')]:
        await r.ev(LOAD_SOLVED('hold-blink', board, '擬真板子')); await r.wait(0.3)
        await r.ev("doflab.scene.cam.r *= 0.62; doflab.scene.cam.phi = 0.85"); await r.ev(spin)
        await r.cap(text, 4.6)
    await r.ev("__perFrame.splice(__perFrame.indexOf(window.__spin),1)")
    await r.cap('不同板子各有能力資料：腳位、電壓、ADC、上拉——不只是換外觀', 2.0)

# ---------------- 第 3 章：行為積木 ----------------
async def ch3(r, prepare):
    if prepare:
        await r.ev(LOAD_SOLVED('hold-blink', 'uno', '示範：按住閃爍')); await r.wait(0.6); return None
    await r.chapter('第 3 章', '視覺積木與行為摘要', '積木直接引用場景中的 BTN1、LED1')
    await r.click('#t-behavior', 1.0)
    await r.cap('用積木描述行為：<b>當 BTN1 被按住時，LED1 亮 500 ms、暗 500 ms</b>', 2.6)
    bx = await r.center('.blocklyDraggable'); await r.glide(bx[0] + 40, bx[1] + 10); await r.wait(0.8)
    await r.cap('條件結束與再次成立的規則都要明示：放開立即熄滅、再按從亮開始', 2.4)
    await r.glide(*(await r.center('#summaryList'))); await r.wait(0.5)
    await r.cap('系統先寫出<b>行為摘要</b>（1 Hz、去彈跳 20 ms），老師與學生確認後才產生程式', 2.6)
    await r.click('#btnConfirm', 1.2)
    await r.cap('確認之後，接線或行為只要一改，確認就會失效', 1.8)

# ---------------- 第 4 章：程式與真實編譯 ----------------
async def ch4(r, prepare):
    if prepare:
        await r.ev(LOAD_SOLVED('hold-blink', 'uno', '示範：按住閃爍') + ";(()=>{const p=doflab.p;p.behavior.confirmed={inputs:DL.project.inputsHash(p,DL.codegen.GENERATOR_VERSION),at:new Date().toISOString()};doflab.renderAll();})()"); await r.wait(0.5); return None
    await r.chapter('第 4 章', '產生程式與真實編譯', 'Arduino C++／Python · arduino-cli 正式工具鏈')
    await r.click('#t-code', 0.8)
    await r.click('#btnGen', 1.0)
    await r.cap('依接線與行為產生<b>可閱讀的 Arduino C++</b>：不使用 delay，閃爍時仍隨時能讀按鈕', 1.2)
    await r.ev("(()=>{const t=document.getElementById('code');const f=()=>{t.scrollTop+=9;};__perFrame.push(f);window.__sc=f})()"); await r.wait(3.2); await r.ev("__perFrame.splice(__perFrame.indexOf(window.__sc),1)")
    await r.ev("document.getElementById('code').scrollTop=0")
    await r.cap('按「編譯」：呼叫 <b>arduino-cli</b> 真實編譯，保留原始輸出與行號', 0.2)
    await r.click('#btnCompile', 0.2)
    await r.until("document.querySelector('#btnCompile').textContent==='編譯'"); await r.wait(0.6)
    await r.glide(*(await r.center('#buildBody'))); await r.cap('編譯成功：' + (await r.ev("document.querySelector('#buildBody .muted') ? document.querySelector('#buildBody .muted').textContent.split('·').slice(-1)[0].trim() : ''")), 2.2)
    await r.cap('如果學生手動把程式裡的 <b>BTN1 改成 D4</b>……', 0.3)
    cx, cy = await r.center('#code'); await r.glide(cx - 200, cy - 180); await r.wait(0.4)
    await r.ev("(()=>{const t=document.getElementById('code');t.value=t.value.replace('const int BTN1_PIN = 2;','const int BTN1_PIN = 4;');t.dispatchEvent(new Event('input'))})()"); await r.wait(1.0)
    await r.glide(*(await r.center('#scanList'))); await r.cap('平台立即提示：<b>程式用 D4，接線卻是 D2</b>——編譯會過，但行為不一致', 2.6)
    await r.click('[data-sync]', 1.0)
    await r.cap('「同步虛擬接線」前先說明：畫面中的線會改，<b>實體導線不會自己移動</b>', 2.2)
    await r.click('#icOk', 1.0)
    await r.cap('同步後接線改到 D4；接線改變，行為摘要也自動要求重新確認', 2.2)

# ---------------- 第 5 章：觀測與模擬 ----------------
async def ch5(r, prepare):
    if prepare:
        await r.ev(LOAD_SOLVED('hold-blink', 'uno', '示範：按住閃爍') + ";(()=>{const p=doflab.p;p.behavior.confirmed={inputs:DL.project.inputsHash(p,DL.codegen.GENERATOR_VERSION),at:new Date().toISOString()};doflab.renderAll();doflab.setTab('observe');})()"); await r.wait(0.8); return None
    await r.chapter('第 5 章', '觀測與模擬', '按住 3D 場景中的按鈕，看 LED 與波形')
    await r.ev("doflab.scene.cam.r *= 0.75"); await r.wait(0.3)
    await r.click('#simRun', 0.6)
    await r.cap('執行模擬後，<b>按住場景裡的 BTN1</b>：LED1 以 1 Hz 閃爍', 0.3)
    bx = await r.ev("doflab.scene.compScreen('BTN1')"); await r.glide(bx['x'], bx['y']); await r.pg.mouse.down(); await r.wait(3.6)
    await r.cap('波形同步記錄按鈕與 LED；放開按鈕，LED 立即熄滅', 0.2); await r.wait(0.8)
    await r.pg.mouse.up(); await r.wait(1.4)
    await r.scroll_to('#twinRows'); await r.glide(*(await r.center('#twinRows')))
    await r.cap('孿生狀態分五層：模擬、目標、命令、確認、量測——LED 沒有感測器，量測欄如實寫<b>「無回授」</b>', 3.2)
    await r.scroll_to('#trace')
    await r.cap('沒有實體設備時，模擬結果不會被當成量測值', 1.8)

# ---------------- 第 6 章：真機同步（虛擬 Uno） ----------------
async def ch6(r, prepare):
    if prepare:
        await r.ev(LOAD_SOLVED('hold-blink', 'uno', '示範：真機同步') + ";(()=>{const p=doflab.p;p.behavior.confirmed={inputs:DL.project.inputsHash(p,DL.codegen.GENERATOR_VERSION),at:new Date().toISOString()};doflab.renderAll();doflab.setTab('observe');})()"); await r.wait(0.8); return None
    await r.chapter('第 6 章', '真機同步：先唯讀、再授權', '虛擬 Uno：晶片模擬器執行真實韌體 DofLabFirmata')
    await r.ev("demo.hw(true)")
    await r.cap('沒有實體板時，用 <b>avr8js 晶片模擬器</b>執行真正編譯的韌體，介面走完整 USB 連線流程', 2.4)
    await r.scroll_to('#hwBody', 'start')
    await r.click('#hwConn', 0.3)
    await r.until("doflab.twin.conn.state==='connected'"); await r.wait(0.8)
    await r.cap('連線後一律<b>唯讀</b>：辨識出 DofLabFirmata、20 個腳位，不改變任何輸出', 2.6)
    await r.cap('按下實體按鈕（D2 拉低）→ 量測層顯示「按下」，品質有效', 0.2)
    await r.ev("window.__vbtn=true; window.__vuno.setInput(2,false)"); await r.wait(1.6)
    await r.ev("window.__vbtn=false; window.__vuno.setInput(2,true)"); await r.wait(0.8)
    await r.cap('逐一核對實體接線後，才能<b>授權受控寫入</b>', 0.3)
    for i in range(await r.pg.locator('[data-chk]').count()): await r.click(f'[data-chk] >> nth={i}', 0.4)
    await r.click('#hwAuth', 1.0)
    await r.scroll_to('main', 'start')
    await r.click('#simRun', 0.4)
    await r.cap('授權後按住按鈕：行為的輸出送往晶片，<b>D13 真的跟著 1 Hz 閃爍</b>，並收到回讀確認', 0.2)
    await r.ev("window.__vbtn=true; window.__vuno.setInput(2,false)"); await r.wait(4.2)
    await r.ev("window.__vbtn=false; window.__vuno.setInput(2,true)"); await r.wait(1.0)
    await r.cap('放開即熄滅。SG90、LED 沒有回授：畫面標示「已確認（非實測）」', 2.0)
    await r.scroll_to('#hwBody', 'start')
    await r.click('#hwDisc', 1.0)
    await r.cap('中斷連線：輸出撤銷、回到模擬，<b>未確認的命令不會重送</b>', 2.4)
    await r.ev("demo.hw(false)")

# ---------------- 第 7 章：三軸機械手臂 ----------------
async def ch7(r, prepare):
    if prepare:
        await r.ev(LOAD_SOLVED('arm-3dof', 'uno', '示範：三軸機械手臂')); await r.wait(0.8); return None
    await r.chapter('第 7 章', '三軸機械手臂', '逆運動學 · 限位 · 不可達 · 限速 · 姿態播放')
    await r.ev("doflab.scene.cam.r *= 0.85"); await r.wait(0.2)
    await r.cap('三顆 SG90 由<b>外部 5V 電源</b>供電並與控制板共地；10 條線自動整線', 2.6)
    await r.click('#t-arm', 1.2)
    await r.cap('拖曳橘色球：<b>逆運動學</b>即時算出底座、肩、肘三個角度，並以最大角速度平滑移動', 0.3)
    h = await r.ev("doflab.armScene.handleScreen()")
    pts = [(h['x'], h['y'])] + [(h['x'] + 110 * math.sin(a / 10), h['y'] + 55 * (1 - math.cos(a / 10))) for a in range(1, 64, 2)]
    await r.drag(pts, step_ms=24); await r.wait(1.2)
    await r.cap('拖出工作範圍：顯示原因（太遠），手臂<b>保留最後有效的姿態</b>', 0.2)
    h = await r.ev("doflab.armScene.handleScreen()")
    await r.drag([(h['x'], h['y']), (h['x'] + 120, h['y'] + 40), (h['x'] + 330, h['y'] + 110)], hold_end=1.6, step_ms=22); await r.wait(1.6)
    await r.click('[data-plane="xy"]', 0.4)
    await r.cap('切到<b>垂直 XY 平面</b>：上下拖曳改變高度', 0.2)
    h = await r.ev("doflab.armScene.handleScreen()")
    await r.drag([(h['x'], h['y']), (h['x'] - 70, h['y'] - 70), (h['x'] - 150, h['y'] - 30), (h['x'] - 130, h['y'] + 40)], step_ms=24); await r.wait(1.0)
    await r.click('[data-plane="xz"]', 0.3)
    await r.ev("doflab.p.arm.poses=[]")
    await r.click('#armSavePose', 0.4)
    await r.cap('也能直接輸入座標或拖關節滑桿，作為拖曳的備援', 0.2)
    await r.click('#armTx', 0.2); await r.pg.keyboard.press('Control+A'); await r.pg.keyboard.type('9', delay=80)
    await r.click('#armTy', 0.2); await r.pg.keyboard.press('Control+A'); await r.pg.keyboard.type('4', delay=80)
    await r.click('#armTz', 0.2); await r.pg.keyboard.press('Control+A'); await r.pg.keyboard.type('-7', delay=80)
    await r.click('#armApply', 2.2)
    await r.click('#armSavePose', 0.6)
    await r.cap('記下兩個姿態；切換時三個關節依<b>限速</b>同步移動', 0.2)
    await r.click('#armPoses [data-go="0"]', 2.4)
    await r.click('#armPoses [data-go="1"]', 2.4)
    await r.scroll_to('#armConfig', 'start')
    await r.cap('設定與伺服映射是<b>教學假設</b>：零位、方向、範圍要用實物量測後確認', 0.2)
    await r.click('#armConfirm', 1.4)
    await r.click('#t-code', 0.6)
    await r.click('#btnGen', 0.8)
    await r.cap('產生<b>姿態播放程式</b>並以 arduino-cli 真實編譯', 0.2)
    await r.click('#btnCompile', 0.2)
    await r.until("document.querySelector('#btnCompile').textContent==='編譯'"); await r.wait(0.4)
    await r.glide(*(await r.center('#buildBadge'))); await r.cap('編譯成功。自動測試另在虛擬晶片上執行這類程式，量得 D9／D10／D11 脈寬符合姿態', 2.6)

CHAPTERS = {'1': ('ch1', ch1, False), '2': ('ch2', ch2, False), '3': ('ch3', ch3, False), '4': ('ch4', ch4, False), '5': ('ch5', ch5, False), '6': ('ch6', ch6, True), '7': ('ch7', ch7, False)}

def wait_port(p):
    for _ in range(80):
        try: socket.create_connection(("127.0.0.1", p), 0.2).close(); return
        except OSError: time.sleep(0.1)

async def main():
    which = sys.argv[1:] or list(CHAPTERS)
    srv = subprocess.Popen([sys.executable, str(DIST / 'doflab_server.py'), '--port', '8766'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); wait_port(8766)
    try:
        async with async_playwright() as p:
            for k in which:
                name, fn, virtual = CHAPTERS[k]; await session(p, name, fn, virtual)
    finally: srv.kill()

asyncio.run(main())
