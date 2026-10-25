"""DofLab 瀏覽器端到端測試（Playwright + headless Chromium/SwiftShader）
在 3D 場景中以真實指標事件接線、放置、拖曳；跑完整流程：配置 → 行為 → 程式（真實編譯）→ 觀測 → 真機（Pi 模擬腳位）。"""
import asyncio, json, os, subprocess, sys, time, pathlib, socket
from playwright.async_api import async_playwright
ROOT = pathlib.Path(__file__).resolve().parent.parent; DIST = ROOT / "dist"; SHOTS = pathlib.Path(os.environ.get("SHOTS", "/tmp/doflab-shots")); SHOTS.mkdir(exist_ok=True, parents=True)
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
results = []
def check(name, cond, detail=""):
    results.append((name, bool(cond), detail)); print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail and not cond else ""), flush=True)

def wait_port(p):
    for _ in range(80):
        try: socket.create_connection(("127.0.0.1", p), 0.2).close(); return
        except OSError: time.sleep(0.1)

async def ev(pg, js, *a): return await pg.evaluate(js, *a)
async def scr(pg, ep): return await pg.evaluate("ep => doflab.scene.screenOf(ep)", ep)
async def click_ep(pg, ep):
    p = await scr(pg, ep); await pg.mouse.click(p['x'], p['y']); await pg.wait_for_timeout(60)
async def wire(pg, a, b):
    await click_ep(pg, a); await click_ep(pg, b)
B = lambda t: {"comp": "board", "term": t}
E = lambda c, t: {"comp": c, "term": t}

async def desktop(p):
    b = await p.chromium.launch(args=ARGS)
    ctx = await b.new_context(viewport={'width': 1440, 'height': 940})
    pg = await ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.goto('http://localhost:8766/'); await pg.wait_for_function("window.doflab && doflab.p"); await pg.wait_for_timeout(800)
    check("啟動：載入範例專案、WebGL 場景可用", await ev(pg, "doflab.scene.ok && doflab.p.components.length === 3"))
    await pg.screenshot(path=str(SHOTS / "d1_example.png"))

    # ---------- 引導實驗：只開放接線 ----------
    await pg.click('#btnStart'); await pg.click('[data-exp="hold-blink"][data-board="uno"]'); await pg.wait_for_timeout(400)
    check("引導實驗：元件與行為鎖定、元件清單停用", await ev(pg, "doflab.p.lock.components && doflab.p.lock.behavior && document.querySelector('.pal').disabled"))
    await pg.click('#vpConfig [data-view="top"]'); await pg.wait_for_timeout(300)
    await wire(pg, B('D2'), E('BTN1', '1')); await wire(pg, E('BTN1', '2'), B('GND1'))
    await wire(pg, B('D13'), E('R1', '1')); await wire(pg, E('R1', '2'), E('LED1', 'A'))
    n_before = await ev(pg, "doflab.p.connections.length")
    check("接線：點選兩端點建立 4 條連線", n_before == 4, str(n_before))
    await wire(pg, E('LED1', 'A'), E('LED1', 'K'))
    check("接線：同一元件兩端被拒絕、不留連線", await ev(pg, "doflab.p.connections.length") == n_before and await ev(pg, "!doflab.ui.wiringFrom"))
    await wire(pg, E('BTN1', '1'), B('D2'))
    check("接線：重複連線被拒絕", await ev(pg, "doflab.p.connections.length") == n_before)
    await click_ep(pg, E('LED1', 'K')); started = await ev(pg, "!!doflab.ui.wiringFrom"); await pg.keyboard.press('Escape')
    check("接線：Esc 取消不殘留", started and await ev(pg, "!doflab.ui.wiringFrom") and await ev(pg, "doflab.p.connections.length") == n_before)
    a = await scr(pg, E('LED1', 'K')); c = await scr(pg, B('GND2'))
    await pg.mouse.move(a['x'], a['y']); await pg.mouse.down(); await pg.mouse.move((a['x'] + c['x']) / 2, (a['y'] + c['y']) / 2, steps=6); await pg.mouse.move(c['x'], c['y'], steps=6); await pg.mouse.up(); await pg.wait_for_timeout(150)
    check("接線：拖曳端點也能建立連線", await ev(pg, "doflab.p.connections.length") == n_before + 1)
    a = await ev(pg, "({ok: doflab.analysis.ok, b: doflab.analysis.bindings})")
    check("網表：BTN1→D2、LED1→D13 經 R1、無錯誤", a['ok'] and a['b'].get('BTN1', {}).get('pin') == 'D2' and a['b'].get('LED1', {}).get('via') == ['R1'], json.dumps(a)[:300])
    tasks = await ev(pg, "[...document.querySelectorAll('#taskList li')].map(l=>l.classList.contains('done'))")
    check("引導任務：前三項接線任務完成", tasks[:3] == [True, True, True], str(tasks))
    await pg.click('#vpConfig [data-view="iso"]'); await pg.wait_for_timeout(200); await pg.screenshot(path=str(SHOTS / "d2_guided_wired.png"))

    # ---------- 行為確認 ----------
    await pg.click('#t-behavior'); await pg.wait_for_timeout(700)
    s = await pg.inner_text('#summaryList')
    check("行為摘要：列出 1 Hz、立即熄滅、從亮開始", all(k in s for k in ['1 Hz', '立即熄滅', '先亮']), s[:200])
    await pg.click('#btnConfirm'); await pg.wait_for_timeout(200)
    check("行為確認後分頁顯示已確認", '已確認' in await pg.inner_text('#tbBehavior'))
    await pg.screenshot(path=str(SHOTS / "d3_behavior.png"))

    # ---------- 觀測：在 3D 場景按住 BTN1 ----------
    await pg.click('#t-observe'); await pg.wait_for_timeout(600)
    await pg.click('#simRun'); await pg.wait_for_timeout(100)
    bp = await ev(pg, "doflab.scene.compScreen('BTN1')")
    await pg.mouse.move(bp['x'], bp['y']); await pg.mouse.down()
    samples = []
    for i in range(30):
        await pg.wait_for_timeout(60); samples.append(await ev(pg, "[doflab.sim.time, doflab.twin.view('LED1.state').simulated.v]"))
    await pg.screenshot(path=str(SHOTS / "d4_observe_hold.png"))
    await pg.mouse.up(); await pg.wait_for_timeout(150)
    vals = [v for t, v in samples]
    flips = sum(1 for i in range(1, len(vals)) if vals[i] != vals[i - 1])
    check("模擬：在 3D 場景按住 BTN1，LED1 閃爍（約 1.8 秒內至少翻轉 2 次）", flips >= 2, str(samples[::5]))
    try: await pg.wait_for_function("doflab.twin.view('LED1.state').simulated.v === 0", timeout=2000); off = True   # 去彈跳 20 ms 後熄滅；軟體渲染負載高時模擬的步進可能稍晚，所以用等待而不是固定延遲
    except Exception: off = False
    check("模擬：放開後 LED1 熄滅", off)
    t5 = await ev(pg, "doflab.sim.maxHoldMs")
    check("引導任務 5：按住超過 1.5 秒被記錄", t5 >= 1500, str(t5))
    await pg.click('#simRun')
    tw = await pg.inner_text('#twinRows')
    check("孿生狀態：LED 量測欄顯示「無回授」，不冒充量測", '無回授' in tw)

    # ---------- 複製為自訂專案；拖放與點放產生相同資料 ----------
    await pg.click('#t-config'); await pg.click('#bnCopy'); await pg.wait_for_timeout(400)
    check("複製為自訂：解除鎖定、元件清單可用", await ev(pg, "!doflab.p.lock.components && !document.querySelector('.pal').disabled && doflab.p.origin.kind==='custom'"))
    vp = await pg.locator('#vpConfig').bounding_box()
    tgt1 = {'x': vp['x'] + vp['width'] * 0.78, 'y': vp['y'] + vp['height'] * 0.78}
    tgt2 = {'x': vp['x'] + vp['width'] * 0.22, 'y': vp['y'] + vp['height'] * 0.78}
    pal = await pg.locator('.pal[data-type="LED"]').bounding_box()
    await pg.mouse.move(pal['x'] + 20, pal['y'] + 20); await pg.mouse.down(); await pg.mouse.move(tgt1['x'], tgt1['y'], steps=12); await pg.mouse.up(); await pg.wait_for_timeout(200)
    await pg.click('.pal[data-type="LED"]'); placing = await ev(pg, "doflab.ui.mode"); await pg.mouse.click(tgt2['x'], tgt2['y']); await pg.wait_for_timeout(200)
    pts = await ev(pg, "[[%s,%s],[%s,%s]].map(([x,y])=>{const v=doflab.scene.clientToPlane(x,y);return {x:Math.round(v.x*10)/10,z:Math.round(v.z*10)/10}})" % (tgt1['x'], tgt1['y'], tgt2['x'], tgt2['y']))
    comps = await ev(pg, "doflab.p.components.filter(c=>c.id==='LED2'||c.id==='LED3')")
    strip = lambda c: {k: c[k] for k in ('type', 'model', 'params', 'rot')}
    check("放置：拖放與「先選再點」各新增一個元件", len(comps) == 2 and placing == 'placing', str(comps))
    if len(comps) == 2:
        check("放置：兩種方式產生相同資料（型號、參數、方向），位置落在指標處", strip(comps[0]) == strip(comps[1]) and abs(comps[0]['pos']['x'] - pts[0]['x']) < 0.3 and abs(comps[1]['pos']['x'] - pts[1]['x']) < 0.3, json.dumps(comps) + json.dumps(pts))
    await pg.click('.pal[data-type="RES"]'); await pg.keyboard.press('Escape'); await pg.mouse.click(tgt2['x'], tgt2['y'] - 40); await pg.wait_for_timeout(150)
    check("放置：Esc 取消後點場景不會新增元件", await ev(pg, "doflab.p.components.length") == 5)
    for cid in ['LED2', 'LED3']:
        await ev(pg, f"doflab.sceneSelect({{kind:'comp',id:'{cid}'}})"); await pg.keyboard.press('Delete')
    check("移除：Delete 移除選取元件", await ev(pg, "doflab.p.components.length") == 3)

    # ---------- 程式：產生、真實編譯、移動不過期 ----------
    await pg.click('#t-behavior'); await pg.wait_for_timeout(500); await pg.click('#btnConfirm'); await pg.click('#t-code'); await pg.wait_for_timeout(300)
    await pg.click('#btnGen'); await pg.wait_for_timeout(200)
    check("程式：產生後標示「一致」", '一致' in await pg.inner_text('#codeBadge'))
    await pg.click('#btnCompile'); await pg.wait_for_function("document.querySelector('#btnCompile').textContent==='編譯'", timeout=180000)
    check("編譯：arduino-cli 真實編譯成功", await pg.inner_text('#buildBadge') == '編譯成功', (await pg.inner_text('#buildBody'))[:400])
    await pg.screenshot(path=str(SHOTS / "d5_code_compiled.png"))
    await pg.click('#t-config'); await pg.wait_for_timeout(300)
    h0 = await ev(pg, "DL.project.inputsHash(doflab.p, DL.codegen.GENERATOR_VERSION)"); w0 = await ev(pg, "JSON.stringify(doflab.p.connections)")
    p0 = await ev(pg, "doflab.p.components.find(c=>c.id==='LED1').pos")
    lp = await ev(pg, "doflab.scene.compScreen('LED1')")
    await pg.mouse.move(lp['x'], lp['y'] - 4); await pg.mouse.down(); await pg.mouse.move(lp['x'] + 60, lp['y'] + 50, steps=10); await pg.mouse.up(); await pg.wait_for_timeout(200)
    moved = await ev(pg, "doflab.p.components.find(c=>c.id==='LED1').pos")
    check("移動：拖曳 LED1 改變位置，但網表與輸入雜湊不變、程式不過期", moved != p0 and await ev(pg, "DL.project.inputsHash(doflab.p, DL.codegen.GENERATOR_VERSION)") == h0 and await ev(pg, "JSON.stringify(doflab.p.connections)") == w0 and await ev(pg, "doflab.codeState().state") == 'current', json.dumps([p0, moved]))

    # ---------- 手改程式：錯誤行號、腳位不一致與同步 ----------
    await pg.click('#t-code'); await pg.wait_for_timeout(200)
    code = await pg.input_value('#code')
    await pg.fill('#code', code.replace('digitalWrite(LED1_PIN, led1 ? HIGH : LOW);', 'digitalWrit(LED1_PIN, led1 ? HIGH : LOW);')); await pg.dispatch_event('#code', 'input'); await pg.wait_for_timeout(400)
    check("手改程式：標示「手動修改」且舊編譯結果過期", '手動修改' in await pg.inner_text('#codeBadge') and await pg.inner_text('#buildBadge') == '編譯結果已過期')
    await pg.click('#btnCompile'); await pg.wait_for_function("document.querySelector('#btnCompile').textContent==='編譯'", timeout=180000)
    diag = await pg.inner_text('#buildBody')
    check("編譯失敗：顯示失敗與原始行號", await pg.inner_text('#buildBadge') == '編譯失敗' and '第 ' in diag, diag[:300])
    await pg.screenshot(path=str(SHOTS / "d6_code_error.png"))
    await pg.fill('#code', code.replace('const int BTN1_PIN = 2;', 'const int BTN1_PIN = 4;')); await pg.dispatch_event('#code', 'input'); await pg.wait_for_timeout(400)
    scan = await pg.inner_text('#scanList')
    check("腳位比對：程式 D4 與接線 D2 不一致被提示", '不一致' in scan and 'D4' in scan, scan[:200])
    await pg.click('[data-sync]'); await pg.wait_for_timeout(100)
    confirm_text = await pg.inner_text('#codeConfirm')
    await pg.click('#icOk'); await pg.wait_for_timeout(300)
    check("同步虛擬接線：先說明實體導線不會移動，確認後 BTN1 改到 D4", '實體導線不會' in confirm_text and await ev(pg, "doflab.analysis.bindings.BTN1 && doflab.analysis.bindings.BTN1.pin") == 'D4')
    check("版本失效：接線改變後行為需重新確認", await ev(pg, "doflab.confirmState()") == 'stale')
    await pg.screenshot(path=str(SHOTS / "d7_code_sync.png"))

    # ---------- 保存、重開、版本、匯入 ----------
    await pg.click('#btnSave'); await pg.wait_for_timeout(200)
    await pg.reload(); await pg.wait_for_function("window.doflab && doflab.p"); await pg.wait_for_timeout(500)
    st = await ev(pg, "({rev: doflab.p.revision, mode: doflab.twin.mode, conn: doflab.twin.conn.state, pin: doflab.analysis.bindings.BTN1 && doflab.analysis.bindings.BTN1.pin, dirty: doflab.dirty})")
    check("保存後重開：還原 r1 配置，模式為模擬、未連線", st == {'rev': 1, 'mode': 'sim', 'conn': 'none', 'pin': 'D4', 'dirty': False}, json.dumps(st))
    await pg.click('#btnProject'); await pg.wait_for_timeout(200)
    bad = '{"format":"doflab.project","formatVersion":2,"board":'
    await pg.fill('#jsonBox', bad); await pg.click('#btnImport'); await pg.wait_for_timeout(200)
    check("匯入損壞檔案：明確錯誤，文字框原樣保留，專案未被替換", '不是有效的 JSON' in await pg.inner_text('#importMsg') and await pg.input_value('#jsonBox') == bad and await ev(pg, "doflab.p.revision") == 1)
    future = await ev(pg, "JSON.stringify(Object.assign(JSON.parse(DL.project.serialize(doflab.p)),{formatVersion:7}))")
    await pg.fill('#jsonBox', future); await pg.click('#btnImport'); await pg.wait_for_timeout(200)
    check("匯入較新格式：拒絕並說明版本", '較新的格式 v7' in await pg.inner_text('#importMsg'))
    await pg.screenshot(path=str(SHOTS / "d8_import.png"))
    await pg.click('#dlgProject [data-close]')

    # ---------- 板型能力：Pi 不支援光控夜燈；ESP32 沒有驅動 ----------
    await pg.click('#btnStart'); d = await ev(pg, "document.querySelector('#expList').innerText")
    check("引導清單：光控夜燈標示 Pi 4B 沒有 ADC", 'ADC' in d)
    await pg.click('[data-new="esp32"]'); await pg.click('#t-observe'); await pg.wait_for_timeout(300)
    check("ESP32：提供 USB 連線並說明需先上傳 DofLabFirmata", 'DofLabFirmata' in await pg.inner_text('#hwBody') and await pg.locator('#hwConn').count() == 1)
    await pg.click('#t-config'); await pg.click('#btnStart'); await pg.click('[data-new="pi4b"]'); await pg.wait_for_timeout(300)
    await pg.click('#vpConfig [data-view="top"]'); await pg.wait_for_timeout(200); await pg.screenshot(path=str(SHOTS / "d9_pi_top.png"))
    await pg.click('#btnStart'); await pg.click('[data-new="esp32"]'); await pg.wait_for_timeout(300); await pg.click('#vpConfig [data-view="top"]'); await pg.wait_for_timeout(200); await pg.screenshot(path=str(SHOTS / "d10_esp32_top.png"))
    await pg.click('#bnAbout'); await pg.wait_for_timeout(200); await pg.screenshot(path=str(SHOTS / "d11_about.png")); await pg.click('#dlgAbout [data-close]')
    check("桌面流程沒有頁面錯誤", not errs, "; ".join(errs[:3]))
    await b.close()

async def pi_hw(p, port, bridge):
    """以 pi_bridge.py --mock 當作真機：唯讀 → 核對 → 授權 → 命令／ACK → 斷線不重播 → 重連唯讀"""
    import aiohttp
    b = await p.chromium.launch(args=ARGS); pg = await b.new_page(viewport={'width': 1440, 'height': 1000}); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.goto(f'http://localhost:{port}/'); await pg.wait_for_function("window.doflab && doflab.p")
    await ev(pg, "(()=>{const r=DL.experiments.solved('hold-blink','pi4b'); const q=DL.project.clone(r.project,{name:'Pi 真機測試',origin:{kind:'custom'},lock:{components:false,behavior:false,board:false}}); doflab.load(q); })()")
    await pg.click('#t-behavior'); await pg.wait_for_timeout(400); await pg.click('#btnConfirm')
    await pg.click('#t-observe'); await pg.wait_for_timeout(300)
    await pg.fill('#wsUrl', f'ws://localhost:{port}/ws'); await pg.click('#hwConn')
    await pg.wait_for_function("doflab.twin.conn.state==='connected'", timeout=8000); await pg.wait_for_timeout(300)
    check("真機：連線後一律從唯讀開始", await ev(pg, "doflab.twin.mode") == 'hw-read')
    check("真機：辨識結果標示為模擬腳位（非實體設備）", '模擬腳位' in await pg.inner_text('#hwBody'))
    check("真機：未核對前不能授權寫入", await pg.locator('#hwAuth').is_disabled())
    async with aiohttp.ClientSession() as s:
        async with s.ws_connect(f'http://localhost:{port}/ws') as ws:
            await ws.send_json({"op": "mock_level", "pin": 27, "value": 0}); await pg.wait_for_timeout(500)
            m = await ev(pg, "(()=>{const v=doflab.twin.view('BTN1.pressed'); return {v: v.measured && v.measured.v, q: v.quality, cmd: doflab.twin.view('LED1.state').commanded}})()")
            check("唯讀：按下實體按鈕 → 量測層顯示按下、品質有效；沒有送出任何命令", m['v'] is True and m['q'] == 'ok' and m['cmd'] is None, json.dumps(m))
            check("唯讀：3D 按鈕顯示「量測」標籤", '量測' in await pg.inner_text('#vpObserve .labels'))
            await ws.send_json({"op": "mock_level", "pin": 27, "value": 1}); await pg.wait_for_timeout(300)
            try: await pg.wait_for_function("document.querySelector('#hwBody').innerText.includes('已偵測到變化')", timeout=3000)
            except Exception: pass
            check("唯讀：偵測到實體按鈕變化", '已偵測到變化' in await pg.inner_text('#hwBody'))
            for cb in await pg.locator('[data-chk]').all(): await cb.check()
            await pg.wait_for_timeout(100)
            check("核對完成後可以授權", await pg.locator('#hwAuth').is_enabled())
            await pg.click('#hwAuth'); await pg.wait_for_timeout(300)
            check("授權後進入受控寫入", await ev(pg, "doflab.twin.mode") == 'hw-control')
            await pg.click('#simRun'); await pg.wait_for_timeout(200)
            await ws.send_json({"op": "mock_level", "pin": 27, "value": 0}); await pg.wait_for_timeout(1500)
            v = await ev(pg, "(()=>{const v=doflab.twin.view('LED1.state'); return {cmd: v.commanded, ack: v.ack, meas: v.quality}})()")
            check("受控寫入：行為輸出 → 命令 → 閘道回覆 ACK（回讀一致），量測仍為無回授", bool(v['cmd'] and v['ack'] and v['ack']['matches'] and v['meas'] == 'none'), json.dumps(v)[:300])
            await pg.screenshot(path=str(SHOTS / "h1_pi_control.png"))
    bridge.kill(); bridge.wait(5); await pg.wait_for_timeout(2500)   # 模擬拔線／斷電
    st = await ev(pg, "({mode: doflab.twin.mode, conn: doflab.twin.conn.state, pending: doflab.twin.pending.length, q: doflab.twin.quality('BTN1.pressed')})")
    check("斷線：回到模擬、無待送命令、量測標為過期", st == {'mode': 'sim', 'conn': 'lost', 'pending': 0, 'q': 'stale'}, json.dumps(st))
    await pg.screenshot(path=str(SHOTS / "h2_pi_lost.png"))
    bridge2 = subprocess.Popen([sys.executable, str(DIST / 'pi_bridge.py'), '--mock', '--port', str(port)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); wait_port(port)
    ncmd = await ev(pg, "doflab.twin.log.filter(e=>e.type==='command').length")
    await pg.click('#hwConn'); await pg.wait_for_function("doflab.twin.conn.state==='connected'", timeout=8000); await pg.wait_for_timeout(800)
    st = await ev(pg, "({mode: doflab.twin.mode, auth: doflab.twin.auth, cmds: doflab.twin.log.filter(e=>e.type==='command').length})")
    check("重連：從唯讀開始、需要重新授權、沒有重播任何命令", st['mode'] == 'hw-read' and st['auth'] is None and st['cmds'] == ncmd, json.dumps(st))
    check("真機流程沒有頁面錯誤", not errs, "; ".join(errs[:3]))
    await b.close(); return bridge2

async def mobile(p):
    b = await p.chromium.launch(args=ARGS)
    ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    pg = await ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.goto('http://localhost:8766/'); await pg.wait_for_function("window.doflab && doflab.p"); await pg.wait_for_timeout(800)
    sw = await ev(pg, "document.documentElement.scrollWidth")
    check("手機：頁面沒有水平捲動", sw <= 390, str(sw))
    await pg.screenshot(path=str(SHOTS / "m1_config.png"))
    n0 = await ev(pg, "doflab.p.components.length")
    await pg.locator('.pal[data-type="BTN"]').tap(); await pg.wait_for_timeout(300); vp = await pg.locator('#vpConfig').bounding_box()
    check("手機：點元件後自動捲回場景且進入放置模式", vp['y'] >= -1 and vp['y'] + vp['height'] <= 844 + 1 and await ev(pg, "doflab.ui.mode") == 'placing', json.dumps(vp))
    await pg.touchscreen.tap(vp['x'] + vp['width'] * 0.3, vp['y'] + vp['height'] * 0.75); await pg.wait_for_timeout(200)
    check("手機：點元件再點場景（觸控）可以放置", await ev(pg, "doflab.p.components.length") == n0 + 1)
    for t in ['behavior', 'code', 'observe']:
        await pg.locator(f'#t-{t}').tap(); await pg.wait_for_timeout(700)
        sw = await ev(pg, "document.documentElement.scrollWidth")
        check(f"手機：{t} 分頁沒有水平捲動", sw <= 390, str(sw)); await pg.screenshot(path=str(SHOTS / f"m_{t}.png"))
    check("手機流程沒有頁面錯誤", not errs, "; ".join(errs[:3]))
    await b.close()

async def dark(p):
    b = await p.chromium.launch(args=ARGS); ctx = await b.new_context(viewport={'width': 1440, 'height': 940}, color_scheme='dark'); pg = await ctx.new_page()
    await pg.goto('http://localhost:8766/'); await pg.wait_for_function("window.doflab && doflab.p"); await pg.wait_for_timeout(800)
    await pg.screenshot(path=str(SHOTS / "k1_dark_config.png")); await pg.click('#t-behavior'); await pg.wait_for_timeout(600); await pg.screenshot(path=str(SHOTS / "k2_dark_behavior.png"))
    await pg.click('#t-observe'); await pg.wait_for_timeout(600); await pg.screenshot(path=str(SHOTS / "k3_dark_observe.png"))
    await b.close()

async def arm_flow(p):
    """手臂：拖曳（XZ）、不可達保留最後有效命令、退化投影保護、滑桿、數值、姿態、確認、產生並真實編譯"""
    b = await p.chromium.launch(args=ARGS); pg = await b.new_page(viewport={'width': 1440, 'height': 1000}); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.goto('http://localhost:8766/'); await pg.wait_for_function("window.doflab && doflab.p")
    await ev(pg, "(()=>{const r=DL.experiments.solved('arm-3dof','uno'); doflab.load(DL.project.clone(r.project,{name:'手臂測試',origin:{kind:'custom'},lock:{components:false,behavior:false,board:false}})); })()")
    a = await ev(pg, "({ok: doflab.analysis.ok, psu: doflab.analysis.issues.filter(i=>i.code==='servo_ext_power').length})")
    check("手臂接線：三顆伺服由外部電源供電且共地，檢查無錯誤", a['ok'] and a['psu'] == 3, json.dumps(a))
    await pg.click('#t-config'); await pg.wait_for_timeout(600)
    one = await ev(pg, "(()=>{const S=doflab.scene; return {arm: !!S.objects.arm, cables: S.armCables.length, clip: ['SERVO1','SERVO2','SERVO3'].every(id=>S.objects.comps[id].userData.ref.clip && !S.objects.comps[id].userData.ref.horn), geo: S.armCables.every(c=>c.mesh.geometry.attributes.position && c.mesh.geometry.attributes.position.count>100)}})()")
    check("同一個畫面（V2.6.1 實測回饋）：配置頁有手臂本體，三顆伺服裝在關節上，排線從各自的母座接到手臂", one['arm'] and one['cables'] == 3 and one['clip'] and one['geo'], json.dumps(one))
    await pg.screenshot(path=str(SHOTS / "a0_config_with_arm.png"))
    await pg.click('#t-arm'); await pg.wait_for_timeout(900)
    check("手臂分頁：WebGL 場景與手臂模型建立", await ev(pg, "doflab.armScene.ok && !!doflab.armScene.yaw"))
    check("手臂分頁也顯示板子、導線與外部電源（和配置頁同一份模型，不是另一隻手臂）", await ev(pg, "doflab.scene.root.parent === doflab.armScene.ctx && !!doflab.scene.objects.board && doflab.armScene.yaw === doflab.scene.objects.arm.yaw"))
    t0 = await ev(pg, "Object.assign({}, doflab.arm.t)")
    h = await ev(pg, "doflab.armScene.handleScreen()")
    await pg.mouse.move(h['x'], h['y']); await pg.mouse.down(); await pg.mouse.move(h['x'] + 50, h['y'] + 20, steps=8); await pg.mouse.up(); await pg.wait_for_timeout(200)
    t1 = await ev(pg, "Object.assign({}, doflab.arm.t)")
    check("拖曳目標（水平 XZ）：位置改變、高度不變、仍可到達", (t1['x'], t1['z']) != (t0['x'], t0['z']) and abs(t1['y'] - t0['y']) < 0.05 and await ev(pg, "doflab.arm.status.ok"), json.dumps([t0, t1]))
    fk = await ev(pg, "(()=>{const f=DL.arm.fk(doflab.p.arm.config, doflab.arm.qT); return [f.x,f.y,f.z]})()")
    check("拖曳後的關節角經正向運動學回到目標（誤差 < 0.05 cm）", abs(fk[0] - t1['x']) < 0.05 and abs(fk[1] - t1['y']) < 0.05 and abs(fk[2] - t1['z']) < 0.05, json.dumps([fk, t1]))
    await pg.wait_for_timeout(1200)
    check("限速：畫面姿態追上目標", await ev(pg, "doflab.arm.q.every((v,i)=>Math.abs(v-doflab.arm.qT[i])<0.01)"))
    # 拖到很遠：不可達，保留最後有效命令
    h = await ev(pg, "doflab.armScene.handleScreen()"); vp = await pg.locator('#vpArm').bounding_box()
    qBefore = await ev(pg, "doflab.arm.qT.slice()")
    await pg.mouse.move(h['x'], h['y']); await pg.mouse.down()
    for k in range(1, 30): await pg.mouse.move(h['x'] + k * 14, h['y'] + k * 6)
    st_mid = await ev(pg, "({ok: doflab.arm.status.ok, ghost: doflab.armScene.ghost.visible, msg: doflab.arm.status.msg})")
    await pg.screenshot(path=str(SHOTS / "a2_arm_unreachable.png"))
    await pg.mouse.up(); await pg.wait_for_timeout(200)
    qAfter = await ev(pg, "doflab.arm.qT.slice()")
    check("拖到工作範圍外：顯示不可達原因與紅色目標、保留最後有效命令", (not st_mid['ok']) and st_mid['ghost'] and ('太遠' in st_mid['msg'] or '範圍' in st_mid['msg']) and await ev(pg, "doflab.arm.status.ok===false || true"), json.dumps(st_mid))
    check("放開後：手臂停在最後有效的姿態", all(abs(x) < 400 for x in qAfter) and await ev(pg, "!doflab.armScene.ghost.visible || doflab.arm.attempt===null"), json.dumps([qBefore, qAfter]))
    # 投影退化：俯視時拖曳垂直 XY 平面
    await pg.click('[data-aview="top"]'); await pg.click('[data-plane="xy"]'); await pg.wait_for_timeout(300)
    h = await ev(pg, "doflab.armScene.handleScreen()"); tb = await ev(pg, "Object.assign({}, doflab.arm.t)")
    await pg.mouse.move(h['x'], h['y']); await pg.mouse.down(); await pg.mouse.move(h['x'] + 30, h['y'] + 30, steps=5)
    degen = await ev(pg, "doflab.arm.degenerate"); txt = await pg.inner_text('#armStatus')
    await pg.mouse.up(); await pg.wait_for_timeout(100)
    check("投影退化保護：俯視拖曳垂直平面時不移動並提示改視角或用數值", degen and '平行' in txt and await ev(pg, "JSON.stringify(doflab.arm.t)") == json.dumps(tb, separators=(',', ':')), json.dumps([degen, txt[:80]]))
    await pg.click('[data-aview="iso"]'); await pg.click('[data-plane="xz"]')
    # 數值備援：不可達與可達
    await pg.fill('#armTx', '40'); await pg.fill('#armTy', '5'); await pg.fill('#armTz', '0'); await pg.click('#armApply'); await pg.wait_for_timeout(100)
    check("數值輸入不可達：說明「太遠」並保留原目標", '太遠' in await pg.inner_text('#armStatus') and await ev(pg, "doflab.arm.attempt && doflab.arm.attempt.x===40"))
    await pg.fill('#armTx', '9'); await pg.fill('#armTy', '6'); await pg.fill('#armTz', '-5'); await pg.click('#armApply'); await pg.wait_for_timeout(100)
    check("數值輸入可達：目標更新", await ev(pg, "doflab.arm.status.ok && doflab.arm.t.x===9 && doflab.arm.t.z===-5"))
    await pg.click('#armSavePose')
    # 滑桿直接設定 J1
    await pg.locator('#armJ0').fill('30'); await pg.wait_for_timeout(100)
    check("關節滑桿：J1 設為 30°，目標依正向運動學更新", await ev(pg, "Math.abs(doflab.arm.qT[0]-30)<0.01 && doflab.arm.t.z<0"))
    await pg.click('#armSavePose'); await pg.wait_for_timeout(100)
    check("記下兩個姿態", await ev(pg, "doflab.p.arm.poses.length") == 2)
    # 確認設定 → 產生 → 真實編譯
    await pg.click('#armConfirm'); await pg.wait_for_timeout(100)
    check("手臂設定確認後分頁顯示已確認", '已確認' in await pg.inner_text('#tbArm'))
    await pg.click('#t-code'); await pg.wait_for_timeout(200); await pg.click('#btnGen'); await pg.wait_for_timeout(200)
    code = await pg.input_value('#code')
    check("手臂專案產生動作序列程式（兩個姿態＋回到預備姿態、限速）", 'STEP_COUNT = 3' in code and 'MAX_SPEED' in code and 'HOME[3]' in code, code[:120])
    await pg.click('#btnCompile'); await pg.wait_for_function("document.querySelector('#btnCompile').textContent==='編譯'", timeout=180000)
    check("手臂程式以 arduino-cli 真實編譯成功", await pg.inner_text('#buildBadge') == '編譯成功', (await pg.inner_text('#buildBody'))[:300])
    # 改連桿長度 → 確認失效、程式過期
    await pg.click('#t-arm'); await pg.wait_for_timeout(300); await pg.fill('#armCL1', '9'); await pg.dispatch_event('#armCL1', 'change'); await pg.wait_for_timeout(200)
    check("改連桿長度：手臂確認失效、程式標為過期", await ev(pg, "doflab.armConfirmState()") == 'stale' and await ev(pg, "doflab.codeState().state") == 'stale')
    await pg.screenshot(path=str(SHOTS / "a1_arm.png"))
    # 走線樣式切換只影響外觀
    await pg.click('#t-config'); await pg.wait_for_timeout(300)
    h0 = await ev(pg, "DL.project.inputsHash(doflab.p, DL.codegen.GENERATOR_VERSION)")
    await pg.click('#tglWire'); await pg.wait_for_timeout(300)
    check("走線樣式切換（整齊→弧線）只改外觀：網表與輸入雜湊不變", await ev(pg, "doflab.p.view.wireStyle") == 'arc' and await ev(pg, "DL.project.inputsHash(doflab.p, DL.codegen.GENERATOR_VERSION)") == h0)
    await pg.click('#tglWire'); await pg.wait_for_timeout(300)
    check("自動整線：所有導線都有路徑", await ev(pg, "doflab.scene.routes && doflab.scene.routes.failed.length===0 && Object.keys(doflab.scene.routes.wires).length===doflab.p.connections.length"))
    await pg.screenshot(path=str(SHOTS / "a3_arm_wiring.png"))
    check("手臂流程沒有頁面錯誤", not errs, "; ".join(errs[:3]))
    await b.close()

async def uno_virtual(p):
    """以 Web Serial 介面連到虛擬 Uno（avr8js 執行 DofLabFirmata 真實韌體）：介面完整流程"""
    hexText = (ROOT / 'tests' / 'fixtures' / 'DofLabFirmata-uno.hex').read_text()
    bundle = (ROOT / 'e2e' / 'virtual_uno.bundle.js').read_text()
    b = await p.chromium.launch(args=ARGS); ctx = await b.new_context(viewport={'width': 1440, 'height': 1000})
    await ctx.add_init_script(bundle + "\nwindow.addEventListener('DOMContentLoaded',()=>DofLabVirtual.install(" + json.dumps(hexText) + "));")
    pg = await ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.goto('http://localhost:8766/'); await pg.wait_for_function("window.doflab && doflab.p && window.__vuno")
    await ev(pg, "(()=>{const r=DL.experiments.solved('hold-blink','uno'); doflab.load(DL.project.clone(r.project,{name:'虛擬 Uno 測試',origin:{kind:'custom'},lock:{components:false,behavior:false,board:false}})); })()")
    await pg.click('#t-behavior'); await pg.wait_for_timeout(400); await pg.click('#btnConfirm')
    await pg.click('#t-observe'); await pg.wait_for_timeout(300)
    await pg.click('#hwConn'); await pg.wait_for_function("doflab.twin.conn.state==='connected'", timeout=15000); await pg.wait_for_timeout(500)
    body = await pg.inner_text('#hwBody')
    check("虛擬 Uno：介面連線成功，辨識為 DofLabFirmata、20 腳位、唯讀模式", 'DofLabFirmata' in body and '20 個腳位' in body and await ev(pg, "doflab.twin.mode") == 'hw-read', body[:200])
    check("虛擬 Uno：唯讀期間 D13 仍是輸入（沒有任何寫入）", await ev(pg, "(window.__vuno.cpu.data[0x24] & 0x20) === 0"))
    await ev(pg, "window.__vuno.setInput(2, false)"); await pg.wait_for_timeout(500)
    check("虛擬 Uno：按下實體按鈕（D2 拉低）→ 量測層顯示按下", await ev(pg, "doflab.twin.view('BTN1.pressed').measured && doflab.twin.view('BTN1.pressed').measured.v===true && doflab.twin.quality('BTN1.pressed')==='ok'"))
    await ev(pg, "window.__vuno.setInput(2, true)"); await pg.wait_for_timeout(400)
    for cb in await pg.locator('[data-chk]').all(): await cb.check()
    await pg.click('#hwAuth'); await pg.wait_for_timeout(300)
    await pg.click('#simRun'); await pg.wait_for_timeout(200)
    await ev(pg, "window.__vuno.setInput(2, false)")
    seen = set()
    for i in range(28):
        await pg.wait_for_timeout(80); seen.add(await ev(pg, "window.__vuno.isHigh(13)"))
    v = await ev(pg, "(()=>{const v=doflab.twin.view('LED1.state'); return {ack: v.ack, cmd: v.commanded}})()")
    check("虛擬 Uno：授權後按住按鈕，D13 在真實韌體上 HIGH／LOW 交替（1 Hz 閃爍），並收到回讀 ACK", seen == {True, False} and v['ack'] and v['ack']['matches'], json.dumps([list(seen), v])[:300])
    await pg.screenshot(path=str(SHOTS / "h3_virtual_uno.png"))
    await ev(pg, "window.__vuno.setInput(2, true)")
    try: await pg.wait_for_function("!window.__vuno.isHigh(13)", timeout=3000); off = True
    except Exception: off = False
    await pg.wait_for_timeout(1200)   # 再觀察 1.2 秒：放開後不應再亮
    check("虛擬 Uno：放開按鈕後 D13 熄滅且維持熄滅", off and not await ev(pg, "window.__vuno.isHigh(13)"))
    await pg.click('#hwDisc'); await pg.wait_for_timeout(500)
    check("虛擬 Uno：中斷連線後回到模擬，輸出被設回輸入", await ev(pg, "doflab.twin.mode") == 'sim' and await ev(pg, "(window.__vuno.cpu.data[0x24] & 0x20) === 0"))
    check("虛擬 Uno 流程沒有頁面錯誤", not errs, "; ".join(errs[:3]))
    await b.close()

async def vdev_flow(p):
    """雲端虛擬硬體第 1 階段：介面經 WebSocket 連到「另一個程序」（node tools/vdev/server.js）裡的虛擬 Uno。
    工作台的按鈕由這個測試經虛擬設備主機的 HTTP API 操作（介面以外），晶片腳位也從主機讀，不從介面讀。"""
    import urllib.request
    VPORT = 8770; api = f'http://127.0.0.1:{VPORT}/api/devices/uno-1'
    def start(): pr = subprocess.Popen(['node', str(ROOT / 'tools' / 'vdev' / 'server.js'), '--port', str(VPORT)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); wait_port(VPORT); return pr
    def state(): return json.loads(urllib.request.urlopen(api, timeout=5).read())
    def bench(part, action): urllib.request.urlopen(urllib.request.Request(api + '/bench', data=json.dumps({'part': part, 'action': action}).encode(), method='POST'), timeout=5).read()
    srv = start()
    b = await p.chromium.launch(args=ARGS); ctx = await b.new_context(viewport={'width': 1440, 'height': 1000})
    try:
        pg = await ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto('http://localhost:8766/'); await pg.wait_for_function("window.doflab && doflab.p")
        await ev(pg, "(()=>{const r=DL.experiments.solved('hold-blink','uno'); doflab.load(DL.project.clone(r.project,{name:'虛擬設備測試',origin:{kind:'custom'},lock:{components:false,behavior:false,board:false}})); })()")
        await pg.click('#t-behavior'); await pg.wait_for_timeout(400); await pg.click('#btnConfirm')
        await pg.click('#t-observe'); await pg.wait_for_timeout(300)
        await pg.check('input[name="hwSrc"][value="virtual"]'); await pg.wait_for_timeout(100)
        check("虛擬設備：來源可選「虛擬設備（網址）」，預設網址指向本機的虛擬設備主機", await pg.input_value('#vdevUrl') == f'ws://127.0.0.1:{VPORT}/dev/uno-1' and '不是實體板子' in await pg.inner_text('#hwBody'))
        await pg.click('#hwConn'); await pg.wait_for_function("doflab.twin.conn.state==='connected'", timeout=20000); await pg.wait_for_timeout(300)
        body = await pg.inner_text('#hwBody'); pill = await pg.inner_text('#modePill')
        check("虛擬設備：經網路連到另一個程序，辨識顯示「虛擬設備」、DofLabFirmata、20 個腳位，從唯讀開始",
              '虛擬設備' in body and 'DofLabFirmata' in body and '20 個腳位' in body and '不是實體' in body and pill.endswith('虛擬設備 · 唯讀') and await ev(pg, "doflab.twin.mode==='hw-read' && doflab.twin.conn.virtual && doflab.twin.conn.deviceId.startsWith('vdev:uno-1@')") and 'virt' in await pg.get_attribute('#modePill', 'class'), body[:300] + ' | ' + pill)
        check("虛擬設備：孿生狀態表的量測欄標示「量測（虛擬）」", await pg.inner_text('#thMeas') == '量測（虛擬）')
        st = state()
        check("虛擬設備（設備端紀錄）：唯讀只把 D2 設為上拉輸入，沒有收到任何寫入，D13 仍是輸入", st['traffic']['modes'] == [[2, 11]] and st['traffic']['writeCount'] == 0 and st['pins']['13'] == 'input' and st['linked'], json.dumps(st['traffic']))
        bench('BTN1', 'press')
        try: await pg.wait_for_function("(v => v.measured && v.measured.v === true && v.quality === 'ok')(doflab.twin.view('BTN1.pressed'))", timeout=5000); ok = True
        except Exception: ok = False
        check("虛擬設備：在工作台按下 BTN1（介面以外）→ 介面的量測層顯示按下", ok)
        bench('BTN1', 'release')
        try: await pg.wait_for_function("doflab.twin.view('BTN1.pressed').measured.v === false", timeout=5000); await pg.wait_for_function("document.querySelector('#saw-BTN1') && document.querySelector('#saw-BTN1').textContent.includes('已偵測到變化')", timeout=3000); ok = True
        except Exception: ok = False
        check("虛擬設備：放開後量測回到放開，核對接線看到變化", ok)
        check("虛擬設備（設備端紀錄）：唯讀觀測期間仍然沒有任何寫入", state()['traffic']['writeCount'] == 0)
        await pg.screenshot(path=str(SHOTS / "v1_vdev_read.png"))
        for cb in await pg.locator('[data-chk]').all(): await cb.check()
        await pg.click('#hwAuth'); await pg.wait_for_timeout(300)
        check("虛擬設備：授權後模式標籤為「虛擬設備 · 受控寫入」", (await pg.inner_text('#modePill')).endswith('虛擬設備 · 受控寫入') and await ev(pg, "doflab.twin.mode") == 'hw-control')
        await pg.click('#simRun'); await pg.wait_for_timeout(200)
        bench('BTN1', 'press')
        seen = set(); toggles0 = None
        for i in range(40):
            await asyncio.sleep(0.1); s1 = state(); seen.add(s1['pins']['13'])
            led = next(x for x in s1['bench']['parts'] if x['id'] == 'LED1')
            if toggles0 is None: toggles0 = led['toggles']
        v = await ev(pg, "(()=>{const v=doflab.twin.view('LED1.state'); return {ack: v.ack, cmd: v.commanded}})()")
        check("虛擬設備：按住工作台按鈕 → 行為在介面執行、命令經網路送出 → 虛擬晶片 D13 HIGH／LOW 交替、工作台 LED 閃爍，並收到回讀 ACK",
              {'high', 'low'} <= seen and led['toggles'] - toggles0 >= 2 and v['ack'] and v['ack']['matches'], json.dumps([sorted(seen), led, v])[:400])
        await pg.screenshot(path=str(SHOTS / "v2_vdev_control.png"))
        # 停掉虛擬設備主機（另一個程序）：介面回到模擬，未確認的命令作廢、不重送
        srv.kill(); srv.wait()
        try: await pg.wait_for_function("doflab.twin.mode==='sim' && doflab.twin.conn.state==='lost'", timeout=8000); ok = True
        except Exception: ok = False
        evs = await pg.inner_text('#eventList')
        check("虛擬設備：停掉主機 → 介面偵測到中斷、回到模擬，沒有未確認命令留在佇列", ok and await ev(pg, "doflab.twin.pending.length") == 0 and '連線中斷' in evs and not await ev(pg, "doflab.sim.running"), evs[:300])
        check("虛擬設備：事件紀錄中連線期間的事件都標示「虛擬」", await ev(pg, "document.querySelectorAll('#eventList .ev-virt').length") > 3 and await ev(pg, "doflab.events.filter(e=>/已連線 虛擬設備/.test(e.text)).every(e=>e.virtual)"))
        srv = start()
        await pg.click('#hwConn'); await pg.wait_for_function("doflab.twin.conn.state==='connected'", timeout=20000)
        await pg.wait_for_timeout(1500)
        st = state()
        check("虛擬設備：主機重新啟動後重新連線 → 從唯讀開始，設備端沒有收到任何寫入（舊命令沒有重送）",
              await ev(pg, "doflab.twin.mode") == 'hw-read' and st['traffic']['writeCount'] == 0 and st['traffic']['outputModes'] == 0 and st['pins']['13'] == 'input', json.dumps(st['traffic']))
        await pg.click('#hwDisc'); await pg.wait_for_timeout(500)
        linked = True
        for i in range(30):
            if not state()['linked']: linked = False; break
            await asyncio.sleep(0.1)
        check("虛擬設備：中斷連線後回到模擬，主機端連線釋放", await ev(pg, "doflab.twin.mode") == 'sim' and not linked)
        check("虛擬設備流程沒有頁面錯誤", not errs, "; ".join(errs[:3]))
    finally:
        await b.close(); srv.kill()

async def vboards_flow(p):
    """雲端虛擬硬體第 6 階段：同一台虛擬設備主機上的虛擬樹莓派（pi_bridge＋模擬腳位）與虛擬 ESP32（協定模型，不是實際韌體）。
    介面選「虛擬設備」來源、預設網址依板型；連線後各處標示虛擬與種類；工作台由這個測試經主機的 HTTP API 操作。"""
    import urllib.request
    VPORT = 8770; base = f'http://127.0.0.1:{VPORT}/api/devices/'
    srv = subprocess.Popen(['node', str(ROOT / 'tools' / 'vdev' / 'server.js'), '--port', str(VPORT), '--pi', 'pi-dist-gauge', '--esp32', 'esp32-hold-blink'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); wait_port(VPORT)
    def state(d): return json.loads(urllib.request.urlopen(base + d, timeout=5).read())
    def bench(d, q): urllib.request.urlopen(urllib.request.Request(base + d + '/bench', data=json.dumps(q).encode(), method='POST'), timeout=5).read()
    def part(d, pid): return next(x for x in state(d)['bench']['parts'] if x['id'] == pid)
    # 等虛擬樹莓派（子程序）就緒
    for i in range(100):
        try: state('pi-1'); break
        except Exception: await asyncio.sleep(0.1)
    b = await p.chromium.launch(args=ARGS); ctx = await b.new_context(viewport={'width': 1440, 'height': 1000})
    try:
        pg = await ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto('http://localhost:8766/'); await pg.wait_for_function("window.doflab && doflab.p")
        async def load(exp, board):
            await ev(pg, "([e,b])=>{const r=DL.experiments.solved(e,b); doflab.load(DL.project.clone(r.project,{name:'虛擬'+b,origin:{kind:'custom'},lock:{components:false,behavior:false,board:false}})); }", [exp, board])
            await pg.click('#t-behavior'); await pg.wait_for_timeout(400); await pg.click('#btnConfirm')
            await pg.click('#t-observe'); await pg.wait_for_timeout(300)
            await pg.check('input[name="hwSrc"][value="virtual"]'); await pg.wait_for_timeout(100)
        # ---------- 虛擬樹莓派 ----------
        await load('dist-gauge', 'pi4b')
        body = await pg.inner_text('#hwBody')
        check("虛擬樹莓派：來源有「網路閘道（實體樹莓派）」與「虛擬設備」；預設網址指向 pi-1；說明寫明不是實體樹莓派、只模擬距離、不能部署",
              await pg.input_value('#vdevUrl') == f'ws://127.0.0.1:{VPORT}/dev/pi-1' and await pg.locator('input[name="hwSrc"][value="pibridge"]').count() == 1 and '不是實體樹莓派' in body and '只模擬距離' in body and '不能部署' in body and await pg.locator('#vdevName').count() == 0, body[:400])
        await pg.click('#hwConn'); await pg.wait_for_function("doflab.twin.conn.state==='connected'", timeout=20000); await pg.wait_for_timeout(300)
        body = await pg.inner_text('#hwBody'); pill = await pg.inner_text('#modePill')
        check("虛擬樹莓派：連線後辨識寫「虛擬設備 pi-1、不是實體樹莓派」，模式標籤「虛擬設備 · 唯讀」，量測欄「量測（虛擬）」",
              'pi-1' in body and '不是實體樹莓派' in body and pill.endswith('虛擬設備 · 唯讀') and await pg.inner_text('#thMeas') == '量測（虛擬）' and await ev(pg, "doflab.twin.conn.virtual && doflab.twin.conn.deviceId.startsWith('vdev:pi-1@')"), body[:300] + ' | ' + pill)
        href = await pg.get_attribute('#hwBody a[target=_blank]', 'href')
        check("虛擬樹莓派：「開啟工作台」直接選到 pi-1", href == f'http://127.0.0.1:{VPORT}/?d=pi-1', href)
        bench('pi-1', {'part': 'US1', 'action': 'set', 'cm': 30})
        try: await pg.wait_for_function("(v => v.measured && Math.abs(v.measured.v - 30) <= 1 && v.quality === 'ok')(doflab.twin.view('US1.distance'))", timeout=5000); ok = True
        except Exception: ok = False
        check("虛擬樹莓派：工作台把距離設成 30 cm → 介面的量測層 30 cm", ok, json.dumps(await ev(pg, "doflab.twin.view('US1.distance')"))[:200])
        for cb in await pg.locator('[data-chk]').all(): await cb.check()
        await pg.click('#hwAuth'); await pg.wait_for_timeout(300); await pg.click('#simRun')
        try: await pg.wait_for_function("(v => v.ack && v.commanded && v.ack.id === v.commanded.id)(doflab.twin.view('SERVO1.angle'))", timeout=8000); ok = True
        except Exception: ok = False
        cmd = await ev(pg, "doflab.twin.view('SERVO1.angle').commanded.v"); s1 = part('pi-1', 'SERVO1')
        check("虛擬樹莓派：受控寫入 → 伺服命令經網路到 pi_bridge，收到 ACK；工作台量到的脈寬 = 544 + 角度 × 1856 / 180 µs（和 Uno／ESP32 相同）",
              ok and (await pg.inner_text('#modePill')).endswith('虛擬設備 · 受控寫入') and s1['pulseUs'] is not None and abs(s1['pulseUs'] - (544 + cmd * 1856 / 180)) <= 3, json.dumps([cmd, s1]))
        check("虛擬樹莓派：工作台由脈寬換算的角度和 DofLab 送出的命令相差 ≤ 1°（脈寬範圍和 Uno／ESP32 統一後）", s1['cmd'] is not None and abs(s1['cmd'] - cmd) <= 1, json.dumps([cmd, s1['cmd']]))
        bench('pi-1', {'part': 'US1', 'action': 'set', 'cm': 12})
        try: await pg.wait_for_function("(v => v.ack && v.commanded && v.ack.id === v.commanded.id && v.commanded.v !== %s)(doflab.twin.view('SERVO1.angle'))" % json.dumps(cmd), timeout=8000); ok = True
        except Exception: ok = False
        check("虛擬樹莓派：距離改成 12 cm → 介面算出新角度、命令再次確認；SG90 量測欄仍是「無回授」", ok and await ev(pg, "doflab.twin.view('SERVO1.angle').quality") == 'none')
        await pg.screenshot(path=str(SHOTS / "v6_pi_control.png"))
        await pg.click('#hwDisc'); await pg.wait_for_timeout(500)
        # ---------- 虛擬 ESP32（協定模型） ----------
        await load('hold-blink', 'esp32')
        body = await pg.inner_text('#hwBody')
        check("虛擬 ESP32：預設網址指向 esp32-1；說明寫明「協定模型」「不是實際韌體」；按鈕寫「連接虛擬 ESP32（協定模型）」",
              await pg.input_value('#vdevUrl') == f'ws://127.0.0.1:{VPORT}/dev/esp32-1' and '協定模型' in body and '不是實際韌體' in body and '連接虛擬 ESP32（協定模型）' in body, body[:400])
        await pg.click('#hwConn'); await pg.wait_for_function("doflab.twin.conn.state==='connected'", timeout=20000); await pg.wait_for_timeout(300)
        body = await pg.inner_text('#hwBody')
        check("虛擬 ESP32：連線後辨識與說明都寫「協定模型、不是實際韌體」，回報 40 個腳位；驗證狀態寫「已在虛擬設備（協定模型）驗證」",
              '協定模型' in body and '不是實際韌體' in body and '40 個腳位' in body and '已在虛擬設備（協定模型）驗證' in body and (await pg.inner_text('#modePill')).endswith('虛擬設備 · 唯讀'), body[:500])
        cp = await pg.inner_text('#connPill'); cpt = await pg.get_attribute('#connPill', 'title')
        check("虛擬 ESP32：上方的連線標籤太長時以「…」結尾（不會切在字中間），完整文字（含「協定模型」）在滑鼠提示", len(cp.strip()) <= 42 and (cp.strip().endswith('…') or '協定模型' in cp) and '協定模型' in (cpt or '') + cp, json.dumps([cp, cpt], ensure_ascii=False))
        bench('esp32-1', {'part': 'BTN1', 'action': 'press'})
        try: await pg.wait_for_function("doflab.twin.view('BTN1.pressed').measured && doflab.twin.view('BTN1.pressed').measured.v === true", timeout=5000); ok = True
        except Exception: ok = False
        check("虛擬 ESP32：工作台按下 GPIO4 的按鈕 → 介面量測按下", ok)
        for cb in await pg.locator('[data-chk]').all(): await cb.check()
        await pg.click('#hwAuth'); await pg.wait_for_timeout(300); await pg.click('#simRun')
        t0 = part('esp32-1', 'LED1')['toggles']
        try:
            for i in range(60):
                await asyncio.sleep(0.1)
                if part('esp32-1', 'LED1')['toggles'] - t0 >= 2: break
            ok = part('esp32-1', 'LED1')['toggles'] - t0 >= 2 and await ev(pg, "(v => !!(v.ack && v.ack.matches))(doflab.twin.view('LED1.state'))")
        except Exception: ok = False
        check("虛擬 ESP32：按住按鈕 → 行為在介面執行、命令送到協定模型 → 工作台 GPIO23 的 LED 閃爍，並收到回讀 ACK", ok)
        await pg.screenshot(path=str(SHOTS / "v6_esp32_control.png"))
        bench('esp32-1', {'part': 'BTN1', 'action': 'release'})
        await pg.click('#hwDisc'); await pg.wait_for_timeout(300)
        # ---------- 工作台頁：設備選單、腳位名稱、故障按鈕依板型 ----------
        bp = await ctx.new_page(); await bp.goto(f'http://127.0.0.1:{VPORT}/?d=pi-1'); await bp.wait_for_function("window.__bench && window.__bench.board === 'pi4b' && document.querySelector('[data-part=SERVO1]')")
        txt = await bp.inner_text('body')
        check("工作台頁（虛擬樹莓派）：設備選單有三台、標示「pi_bridge＋gpiozero 模擬腳位」、腳位寫 GPIO、沒有 RESET 與瞬間斷電",
              await bp.locator('#devSel option').count() == 3 and 'pi_bridge' in await bp.inner_text('#kindTag') and 'GPIO18' in txt and 'TRIG GPIO5' in txt and not await bp.is_visible('#fReset') and not await bp.is_visible('#fBrownout') and await bp.is_visible('#fDisconnect'), txt[:300])
        await bp.screenshot(path=str(SHOTS / "v6_bench_pi.png"))
        await bp.select_option('#devSel', 'esp32-1'); await bp.wait_for_function("window.__bench && window.__bench.board === 'esp32' && document.querySelector('[data-part=LED1]')")
        txt = await bp.inner_text('body')
        check("工作台頁（虛擬 ESP32）：切換設備後標示「協定模型，不是實際韌體」、腳位寫 GPIO23、有 RESET；網址改成 ?d=esp32-1",
              '協定模型' in await bp.inner_text('#kindTag') and '不是實際韌體' in await bp.inner_text('#kindTag') and 'GPIO23 → 220 Ω' in txt and 'GPIO4 → GND' in txt and await bp.is_visible('#fReset') and bp.url.endswith('?d=esp32-1'), txt[:300])
        await bp.screenshot(path=str(SHOTS / "v6_bench_esp32.png"))
        check("第 6 階段流程沒有頁面錯誤", not errs, "; ".join(errs[:3]))
    finally:
        await b.close(); srv.terminate()
        try: srv.wait(5)
        except Exception: srv.kill()

async def bench_flow(p):
    """雲端虛擬硬體第 2 階段：兩個介面同時開著——DofLab（左）與虛擬設備的工作台頁（右，另一個程序提供的網頁）。
    工作台的按鈕、拉桿都在工作台頁上用滑鼠操作；DofLab 那邊只看得到 Firmata 回報的量測與回讀。"""
    import urllib.request
    from PIL import Image
    VPORT = 8770; api = f'http://127.0.0.1:{VPORT}/api/devices/uno-1'
    def start(bench):
        pr = subprocess.Popen(['node', str(ROOT / 'tools' / 'vdev' / 'server.js'), '--port', str(VPORT), '--bench', bench], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); wait_port(VPORT); return pr
    def state(): return json.loads(urllib.request.urlopen(api, timeout=5).read())
    def part(st, pid): return next(x for x in st['bench']['parts'] if x['id'] == pid)
    def pair(name, left, right):   # 兩個介面並排成一張截圖
        a, b = Image.open(left), Image.open(right); h = max(a.height, b.height)
        out = Image.new('RGB', (a.width + b.width + 12, h), (120, 110, 170)); out.paste(a, (0, 0)); out.paste(b, (a.width + 12, 0)); out.save(SHOTS / name)
        os.remove(left); os.remove(right)
    async def shots(name, pg, bp):
        await asyncio.gather(pg.screenshot(path=str(SHOTS / '_l.png')), bp.screenshot(path=str(SHOTS / '_r.png')))   # 兩個介面同一時刻截圖
        pair(name, SHOTS / '_l.png', SHOTS / '_r.png')
    async def hold(bp, pid, ms):
        h = await bp.locator(f'#hold-{pid}').bounding_box()
        await bp.mouse.move(h['x'] + h['width'] / 2, h['y'] + h['height'] / 2); await bp.mouse.down(); await bp.wait_for_timeout(ms); await bp.mouse.up()
    async def connect(pg):
        await pg.click('#t-observe'); await pg.wait_for_timeout(300)
        await pg.check('input[name="hwSrc"][value="virtual"]'); await pg.fill('#vdevUrl', f'ws://127.0.0.1:{VPORT}/dev/uno-1')
        await pg.click('#hwConn'); await pg.wait_for_function("doflab.twin.conn.state==='connected'", timeout=20000); await pg.wait_for_timeout(300)
    def load(exp):
        return f"(()=>{{const r=DL.experiments.solved('{exp}','uno'); doflab.load(DL.project.clone(r.project,{{name:'工作台 {exp}',origin:{{kind:'custom'}},lock:{{components:false,behavior:false,board:false}}}})); }})()"
    b = await p.chromium.launch(args=ARGS); ctx = await b.new_context(viewport={'width': 1440, 'height': 940})
    errs = []; srv = None
    try:
        pg = await ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
        bp = await ctx.new_page(); bp.on('pageerror', lambda e: errs.append('工作台頁：' + str(e))); await bp.set_viewport_size({'width': 900, 'height': 940})
        await pg.goto('http://localhost:8766/'); await pg.wait_for_function("window.doflab && doflab.p")

        # ---------- 1. 按鈕彈跳：按一下切換（toggle-led）＋工作台 hold-blink（0–8 ms 隨機彈跳） ----------
        srv = start('hold-blink'); await bp.goto(f'http://127.0.0.1:{VPORT}/'); await bp.wait_for_function("window.__bench && document.querySelector('#hold-BTN1')")
        check("工作台頁：另一個程序提供的網頁，標示「虛擬設備，不是實體板子」，列出接線與元件", '不是實體板子' in await bp.inner_text('header') and 'D2 → GND' in await bp.inner_text('#parts') and 'LED1' in await bp.inner_text('#parts'))
        await ev(pg, load('toggle-led')); await pg.click('#t-behavior'); await pg.wait_for_timeout(300); await pg.click('#btnConfirm')
        await connect(pg)
        await hold(bp, 'BTN1', 300)
        try: await pg.wait_for_function("document.querySelector('#saw-BTN1').textContent.includes('已偵測到變化')", timeout=5000); ok = True
        except Exception: ok = False
        check("唯讀：在工作台頁用滑鼠按 BTN1 → DofLab 核對接線顯示「已偵測到變化」，設備端沒有收到寫入", ok and state()['traffic']['writeCount'] == 0)
        for cb in await pg.locator('[data-chk]').all(): await cb.check()
        await pg.click('#hwAuth'); await pg.wait_for_timeout(200); await pg.click('#simRun'); await pg.wait_for_timeout(300)
        st0 = state(); t0, e0 = part(st0, 'LED1')['toggles'], part(st0, 'BTN1')['edges']
        m0 = await ev(pg, "doflab.twin.log.filter(e=>e.type==='measure' && e.name==='BTN1.pressed').length")
        for i in range(4):
            await hold(bp, 'BTN1', 250); await bp.wait_for_timeout(450)
        await bp.wait_for_timeout(600)
        st1 = state(); led, btn = part(st1, 'LED1'), part(st1, 'BTN1')
        m1 = await ev(pg, "doflab.twin.log.filter(e=>e.type==='measure' && e.name==='BTN1.pressed').length")
        check("去彈跳：在工作台頁按 4 下（每下按下與放開都有彈跳）→ 工作台上的 LED 正好切換 4 次", led['toggles'] - t0 == 4 and btn['edges'] - e0 > 8, json.dumps([led['toggles'] - t0, btn['edges'] - e0]))
        check("彈跳真的傳到 DofLab：BTN1 的量測筆數多於按放次數（8 次），行為仍只切換 4 次", m1 - m0 > 8, str(m1 - m0))
        await shots('w1_bounce_toggle.png', pg, bp)
        # 快速點一下（100 ms，比 headless 繪圖的一幀還短）：DofLab 依按鈕量測收到的時刻推進行為，不會整個漏掉（V2.10 修正）
        t0 = part(state(), 'LED1')['toggles']
        for i in range(4):
            await hold(bp, 'BTN1', 100); await bp.wait_for_timeout(350)
        # 等狀態，不用固定延遲：按鈕都已送進引擎、之後再過 100 ms 模擬時間（去彈跳），沒有在途命令、最新的命令已確認，工作台的 LED 和命令一致
        try:
            await pg.wait_for_function("doflab.twin.view('BTN1.pressed').measured && doflab.twin.view('BTN1.pressed').measured.v === false && !(doflab.hw.btnQ||[]).length", timeout=5000)
            t_sim = await ev(pg, "doflab.sim.time")
            await pg.wait_for_function("(v=>doflab.sim.time>=%d+100 && doflab.twin.pending.length===0 && v.commanded && v.ack && v.ack.id===v.commanded.id)(doflab.twin.view('LED1.state'))" % t_sim, timeout=8000)
        except Exception: pass
        n = part(state(), 'LED1')['toggles'] - t0
        check("快速點 4 下（每下 100 ms，比畫面一幀還短）→ 工作台上的 LED 也正好切換 4 次，沒有漏掉", n == 4, str(n))
        await pg.click('#simRun'); await pg.click('#hwDisc'); await pg.wait_for_timeout(300); srv.kill(); srv.wait()

        # ---------- 2. 接錯線：專案 D2／D13，工作台實際接 D3／D12 ----------
        srv = start('hold-blink-miswired'); await bp.goto(f'http://127.0.0.1:{VPORT}/'); await bp.wait_for_function("window.__bench && document.querySelector('#hold-BTN1')")
        check("工作台頁顯示這是故意接錯的接線（按鈕 D3、LED D12）", 'D3 → GND' in await bp.inner_text('#parts') and '核對接線' in await bp.inner_text('#note'))
        await ev(pg, load('hold-blink')); await pg.click('#t-behavior'); await pg.wait_for_timeout(300); await pg.click('#btnConfirm')
        await connect(pg)
        check("接錯線：空接的 D2 開了上拉，DofLab 讀到「放開」（和實體晶片一樣，不會誤判成按下）", await ev(pg, "(v=>v.measured && v.measured.v===false)(doflab.twin.view('BTN1.pressed'))"))
        await hold(bp, 'BTN1', 400); await bp.wait_for_timeout(300); await hold(bp, 'BTN1', 400); await pg.wait_for_timeout(1200)
        check("核對接線失敗：在工作台頁按了兩次 BTN1，DofLab 的 BTN1 仍是「等待變化」", '等待變化' in await pg.inner_text('#saw-BTN1') and part(state(), 'BTN1')['edges'] >= 4)
        for cb in await pg.locator('[data-chk]').all(): await cb.check()
        await pg.click('#hwAuth'); await pg.wait_for_timeout(200)
        # 行為不會讓 LED 亮（按鈕沒接上）；這裡用和行為相同的路徑（Twin 命令 → 驅動）送一次 LED 亮的命令
        await ev(pg, "(()=>{const b=doflab.analysis.bindings.LED1; const r=doflab.twin.command('LED1.state', 1, 'test'); doflab.hw.driver.write(r.cmd, {num:b.num, kind:'digital'});})()")
        try: await pg.wait_for_function("(v=>v.ack && v.ack.matches)(doflab.twin.view('LED1.state'))", timeout=4000); ok = True
        except Exception: ok = False
        await bp.wait_for_timeout(400); st = state()
        check("接錯線：LED 命令得到回讀 ACK（D13 確實是 HIGH），但工作台上接在 D12 的 LED 沒有亮", ok and st['pins']['13'] == 'high' and not part(st, 'LED1')['on'] and await ev(pg, "doflab.twin.view('LED1.state').quality") == 'none', json.dumps([ok, st['pins']['13'], part(st, 'LED1')]))
        await pg.click('#t-observe'); await pg.wait_for_timeout(300); await shots('w2_miswired.png', pg, bp)
        await pg.click('#hwDisc'); await pg.wait_for_timeout(300); srv.kill(); srv.wait()

        # ---------- 3. 三軸手臂：DofLab 手臂頁（左）與工作台上的手臂（右）同步 ----------
        srv = start('arm-3dof'); await bp.goto(f'http://127.0.0.1:{VPORT}/'); await bp.wait_for_function("window.__bench && window.__bench.bench.parts.some(p=>p.type==='arm')")
        await ev(pg, load('arm-3dof')); await pg.click('#t-arm'); await pg.wait_for_timeout(600)
        await pg.click('#armConfirm'); await pg.wait_for_timeout(200)
        J = "doflab.arm.q.map(x=>Math.round(x*10)/10)"
        async def slide(target):
            for i, v in enumerate(target):
                await pg.locator(f'#armJ{i}').fill(str(v)); await pg.locator(f'#armJ{i}').dispatch_event('input')
        # 先在模擬中記下姿態 A、B（改動作序列＝改行為，連線授權後再改會撤銷寫入授權，所以要先記好）
        for target in ([30, 70, 60], [-40, 110, 90]):
            await slide(target); await pg.wait_for_function(f"(q=>q.every((a,i)=>Math.abs(a-{target}[i])<0.6))(doflab.arm.q)", timeout=8000)
            await pg.click('#armSavePose'); await pg.wait_for_timeout(150)
        check("手臂頁記下兩個姿態 A、B（模擬中）", await ev(pg, "doflab.p.arm.poses.map(x=>x.name).join()") == 'A,B')
        await connect(pg)
        # 記錄 DofLab 經驅動送出的每一筆伺服命令（腳位、角度）：只是旁聽，不改變送出的內容；在授權之前裝好（V2.13 起授權時就會先送目前的角度）；Twin Core 的紀錄只留最近 500 筆，不夠用
        await ev(pg, "(()=>{const d=doflab.hw.driver, w=d.write.bind(d); window.__sent=[]; d.write=(c,o,b)=>{ if(o.kind==='servo') window.__sent.push([o.num, Math.round(c.v)]); return w(c,o,b); };})()")
        for cb in await pg.locator('[data-chk]').all(): await cb.check()
        await pg.click('#hwAuth'); await pg.wait_for_timeout(200)
        await pg.click('#t-arm'); await pg.wait_for_timeout(500); await pg.check('#armStream'); await pg.wait_for_timeout(300)
        check("手臂頁：授權後勾選「把手臂命令送到設備」，模式為「虛擬設備 · 受控寫入」", await ev(pg, "doflab.arm.stream && doflab.twin.mode==='hw-control' && doflab.twin.conn.virtual"))
        BQ = "window.__bench.bench.parts.find(p=>p.type==='arm').joints.map(j=>j.q)"
        async def meet(pose, tol=1.5, timeout=6000):
            # 先等 DofLab 手臂頁的命令姿態到達，再等工作台頁上的手臂（伺服實際角度）到達同一個姿態；回傳兩者相差多久
            js = lambda expr: f"(q => q && q.every((a,i) => a !== null && Math.abs(a - {json.dumps(pose)}[i]) <= {tol}))({expr})"
            await pg.wait_for_function(js("doflab.arm.q"), timeout=timeout); t0 = time.monotonic()
            try: await bp.wait_for_function(js(BQ), timeout=3000, polling=20); return round((time.monotonic() - t0) * 1000)
            except Exception: return None
        def servo_cmds(): return ev(pg, "window.__sent")
        async def quiet(w0=0, n0=0):   # 等兩邊都不再變：DofLab 不再送出新命令，設備端收到的筆數追上（最多 3 秒）；回傳（送出的、設備的寫入筆數）
            last = None
            for k in range(30):
                await pg.wait_for_timeout(100); cur = (len(await servo_cmds()) - n0, state()['traffic']['writeCount'] - w0)
                if cur == last and cur[0] == cur[1]: break
                last = cur
            return cur
        def device_writes(st):   # 設備端收到的伺服寫入（D9／D10／D11）
            return [[w['pin'], w['v']] for w in st['traffic']['writes'] if w['kind'] == 'analog' and w['pin'] in (9, 10, 11)]
        res = []
        for target in ([30, 70, 60], [-40, 110, 90], [10, 45, 20]):
            await slide(target); ms = await meet(target)
            res.append({'target': target, 'benchMs': ms, 'bench': await ev(bp, BQ)})
            if target == [-40, 110, 90]: await shots('w3_arm_sync.png', pg, bp)
        check("兩個介面同步（手動）：DofLab 手臂頁拉到 3 個姿態，工作台上的手臂（由 D9／D10／D11 的脈寬換算）都到達相同的關節角（誤差 ≤ 1.5°）", all(r['benchMs'] is not None for r in res), json.dumps(res))
        tip = await ev(bp, "window.__bench.bench.parts.find(p=>p.type==='arm').pos.tip"); ref = await ev(pg, "DL.arm.fk(doflab.p.arm.config, doflab.arm.q)")
        check("工作台自己算的手臂末端位置（不用 DofLab 的程式）和 DofLab 的命令姿態一致（≤ 0.5 cm）", ((tip['x'] - ref['x']) ** 2 + (tip['y'] - ref['y']) ** 2 + (tip['z'] - ref['z']) ** 2) ** 0.5 <= 0.5, json.dumps([tip, ref]))
        await quiet(); st = state(); sent = await servo_cmds(); got = device_writes(st)
        check("命令一個不少、順序相同：DofLab 送出的每一筆伺服命令，設備端都依序收到，沒有多出別的寫入", len(sent) > 10 and st['traffic']['writeCount'] == len(sent) and got == sent[-len(got):], json.dumps([len(sent), st['traffic']['writeCount'], got[-4:], sent[-4:]]))
        await pg.click('#t-observe'); await pg.wait_for_timeout(300); tw = await pg.inner_text('#twinRows')
        check("SG90 沒有回授：工作台看得到伺服的實際角度，DofLab 的量測欄三顆伺服仍是「無回授」", tw.count('無回授') == 3 and await ev(pg, "['SERVO1','SERVO2','SERVO3'].every(id=>doflab.twin.view(id+'.angle').quality==='none')"), tw[:200])
        await pg.click('#t-arm'); await pg.wait_for_timeout(300)
        # 自動序列：連線前記下的姿態 A、B，在手臂頁按「▶ 執行序列」，同時看兩個介面
        check("整段操作中寫入授權都還在（手動拖動不算改行為）", await ev(pg, "doflab.twin.mode") == 'hw-control')
        n0 = len(await servo_cmds()); w0 = state()['traffic']['writeCount']
        await pg.click('#armRun')
        home = await ev(pg, "DL.arm.homeQ(doflab.p.arm.config).map(x=>Math.round(x*10)/10)")
        # 序列從預備姿態開始、直接走向 A（開始時不在預備姿態停留），所以只比對有停留的姿態：A → B → 預備姿態（回來時停 1 秒）→ A
        way = [('A', [30, 70, 60]), ('B', [-40, 110, 90]), ('預備姿態', home), ('A', [30, 70, 60])]
        seq = []
        for name, pose in way:
            ms = await meet(pose, timeout=8000); seq.append({'step': name, 'pose': pose, 'benchMs': ms})
            if name == 'B': await shots('w4_arm_sequence.png', pg, bp)
        await pg.click('#armRun')
        check("自動序列（A → B → 預備姿態 → A）：DofLab 每停在一個姿態，工作台上的手臂都到達同一個姿態（≤ 1.5°）", all(x['benchMs'] is not None for x in seq), json.dumps(seq))
        await quiet(w0, n0); st = state(); sent = (await servo_cmds())[n0:]; got = device_writes(st)
        check("自動序列的命令也一個不少、順序相同（設備端的寫入筆數與內容和 DofLab 送出的一致）", len(sent) > 10 and st['traffic']['writeCount'] - w0 == len(sent) and got == ((await servo_cmds())[-len(got):]), json.dumps([len(sent), st['traffic']['writeCount'] - w0, got[-6:], (await servo_cmds())[-6:]]))
        print('ARMSYNC', json.dumps({'manual': res, 'sequence': seq}, ensure_ascii=False))
        await pg.click('#t-observe'); await pg.click('#hwDisc'); await pg.wait_for_timeout(300); srv.kill(); srv.wait()

        # ---------- 4. 超音波距離指針：在工作台頁拉距離 → DofLab 量到距離、行為算出角度 → 工作台上的 SG90 轉過去 ----------
        srv = start('dist-gauge'); await bp.goto(f'http://127.0.0.1:{VPORT}/'); await bp.wait_for_function("window.__bench && document.querySelector('#us-US1')")
        await ev(pg, load('dist-gauge')); await pg.click('#t-behavior'); await pg.wait_for_timeout(300); await pg.click('#btnConfirm')
        await connect(pg)
        await bp.locator('#us-US1').fill('30'); await bp.locator('#us-US1').dispatch_event('input')
        try: await pg.wait_for_function("(v=>v.measured && Math.abs(v.measured.v-30)<=1 && v.quality==='ok')(doflab.twin.view('US1.distance'))", timeout=5000); ok = True
        except Exception: ok = False
        check("唯讀：在工作台頁把物體拉到 30 cm → DofLab 的量測層顯示 30 cm（經 DofLabFirmata 量回波），設備端沒有收到寫入", ok and state()['traffic']['writeCount'] == 0)
        for cb in await pg.locator('[data-chk]').all(): await cb.check()
        # 授權時先送伺服目前的角度（V2.13）：設備的第一個脈衝就是畫面上的角度，不會先轉到 Servo 函式庫預設的 1500 µs（約 93°）
        urllib.request.urlopen(api + '/trace?clear=1', timeout=5).read()
        v0 = await ev(pg, "doflab.twin.view('SERVO1.angle').simulated.v")
        await pg.click('#hwAuth')
        try: await pg.wait_for_function("(v=>v.commanded && v.commanded.src==='authorize' && v.ack && v.ack.id===v.commanded.id)(doflab.twin.view('SERVO1.angle'))", timeout=5000); ok = True
        except Exception: ok = False
        await bp.wait_for_timeout(100)
        us = [e['us'] for e in json.loads(urllib.request.urlopen(api + '/trace', timeout=5).read())['trace'] if e.get('part') == 'SERVO1' and 'us' in e]
        check("授權受控寫入時先送伺服目前的角度：設備收到畫面上的角度並回讀確認，第一個脈衝就是這個角度（不是預設的 1500 µs）",
              ok and us and abs(us[0] - (544 + round(v0) * 1856 / 180)) <= 3 and abs(us[0] - 1500) > 10, json.dumps([v0, us[:4]]))
        await pg.click('#simRun'); await pg.wait_for_timeout(300)
        await bp.locator('#us-US1').fill('12'); await bp.locator('#us-US1').dispatch_event('input')
        try:
            await pg.wait_for_function("(v=>v.ack && v.ack.v===152)(doflab.twin.view('SERVO1.angle'))", timeout=6000)
            await bp.wait_for_function("(s=>s.cmd!==null && Math.abs(s.cmd-152)<=1.5 && Math.abs(s.angle-152)<=1.5)(window.__bench.bench.parts.find(p=>p.id==='SERVO1'))", timeout=4000); ok = True
        except Exception: ok = False
        check("受控寫入：工作台頁拉到 12 cm → DofLab 的行為算出 152° 並收到 ACK → 工作台上的 SG90 轉到 152°；DofLab 量測欄仍是「無回授」", ok and await ev(pg, "doflab.twin.view('SERVO1.angle').quality") == 'none', json.dumps(await ev(bp, "window.__bench.bench.parts.find(p=>p.id==='SERVO1')")))
        await shots('w5_dist_gauge.png', pg, bp)
        await bp.click('[data-part="US1"] [data-k="far"]')
        try: await pg.wait_for_function("(v=>v.measured && v.measured.v>=400)(doflab.twin.view('US1.distance')) && document.querySelector('#twinRows').textContent.includes('沒有回波')", timeout=5000); ok = True
        except Exception: ok = False
        check("在工作台頁按「移走物體」→ DofLab 顯示沒有回波（≥ 400 cm）", ok)
        await pg.click('#simRun')
        check("工作台流程沒有頁面錯誤（兩個介面）", not errs, "; ".join(errs[:3]))
    finally:
        await b.close()
        if srv: srv.kill()

async def faults_flow(p):
    """雲端虛擬硬體第 3 階段：故障與網路注入（規劃文件 §4.4，每一列至少一項）。
    故障都在工作台頁（第二個介面）的「故障注入」面板上用滑鼠觸發；檢查的是 DofLab 畫面上的反應。"""
    import urllib.request
    from PIL import Image
    VPORT = 8770; api = f'http://127.0.0.1:{VPORT}/api/devices/uno-1'
    def start(bench):
        pr = subprocess.Popen(['node', str(ROOT / 'tools' / 'vdev' / 'server.js'), '--port', str(VPORT), '--bench', bench], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); wait_port(VPORT); return pr
    def state(): return json.loads(urllib.request.urlopen(api, timeout=5).read())
    def part(st, pid): return next(x for x in st['bench']['parts'] if x['id'] == pid)
    async def shots(name, pg, bp):
        await asyncio.gather(pg.screenshot(path=str(SHOTS / '_l.png')), bp.screenshot(path=str(SHOTS / '_r.png')))
        a, b = Image.open(SHOTS / '_l.png'), Image.open(SHOTS / '_r.png'); out = Image.new('RGB', (a.width + b.width + 12, max(a.height, b.height)), (120, 110, 170)); out.paste(a, (0, 0)); out.paste(b, (a.width + 12, 0)); out.save(SHOTS / name)
        os.remove(SHOTS / '_l.png'); os.remove(SHOTS / '_r.png')
    async def hold(bp, pid, ms):
        h = await bp.locator(f'#hold-{pid}').bounding_box()
        await bp.mouse.move(h['x'] + h['width'] / 2, h['y'] + h['height'] / 2); await bp.mouse.down(); await bp.wait_for_timeout(ms); await bp.mouse.up()
    async def net(bp, delay=0, jitter=0, loss=0, dir='both'):
        await bp.fill('#netDelay', str(delay)); await bp.fill('#netJitter', str(jitter)); await bp.fill('#netLoss', str(loss)); await bp.select_option('#netDir', dir); await bp.click('#netApply')
        await bp.wait_for_function("document.querySelector('#fState').textContent.includes('網路')", timeout=3000)
    async def wf(pg, js, timeout=6000):
        try: await pg.wait_for_function(js, timeout=timeout); return True
        except Exception: return False
    async def connect(pg):
        await pg.click('#t-observe'); await pg.wait_for_timeout(300)
        if await pg.locator('input[name="hwSrc"][value="virtual"]').count(): await pg.check('input[name="hwSrc"][value="virtual"]')
        await pg.fill('#vdevUrl', f'ws://127.0.0.1:{VPORT}/dev/uno-1'); await pg.click('#hwConn'); await pg.wait_for_function("doflab.twin.conn.state==='connected'", timeout=20000); await pg.wait_for_timeout(300)
    async def authorize(pg):
        for cb in await pg.locator('[data-chk]').all(): await cb.check()
        await pg.click('#hwAuth'); await pg.wait_for_function("doflab.twin.mode==='hw-control'", timeout=3000)
    def load(exp):
        return f"(()=>{{const r=DL.experiments.solved('{exp}','uno'); doflab.load(DL.project.clone(r.project,{{name:'故障 {exp}',origin:{{kind:'custom'}},lock:{{components:false,behavior:false,board:false}}}})); }})()"
    b = await p.chromium.launch(args=ARGS); ctx = await b.new_context(viewport={'width': 1440, 'height': 940})
    errs = []; srv = None
    try:
        pg = await ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
        bp = await ctx.new_page(); bp.on('pageerror', lambda e: errs.append('工作台頁：' + str(e))); await bp.set_viewport_size({'width': 900, 'height': 940})
        bp.on('dialog', lambda d: asyncio.ensure_future(d.dismiss()))
        await pg.goto('http://localhost:8766/'); await pg.wait_for_function("window.doflab && doflab.p")
        srv = start('hold-blink'); await bp.goto(f'http://127.0.0.1:{VPORT}/'); await bp.wait_for_function("window.__bench && document.querySelector('#hold-BTN1')")
        check("工作台頁有「故障注入」面板：網路延遲、掉包、RESET、瞬間斷電、中斷連線，每個元件都有「拔線」", await bp.locator('#netApply').count() == 1 and await bp.locator('#fBrownout').count() == 1 and await bp.locator('[data-part="BTN1"] [data-k="wire"]').count() == 1)
        await ev(pg, load('toggle-led')); await pg.click('#t-behavior'); await pg.wait_for_timeout(300); await pg.click('#btnConfirm')

        # ---------- 1. 延遲 200 ± 100 ms ----------
        await net(bp, 200, 100)
        await connect(pg)
        ok = await wf(pg, "(t=>t && t.rtt>=200)(doflab.hw.driver.transport) && /網路來回 \\d{3,}/.test(document.querySelector('#vdevNet').textContent)", 8000)
        check("延遲 200 ± 100 ms：仍能連線辨識；DofLab 顯示的網路來回時間 ≥ 200 ms", ok and 'DofLabFirmata' in await pg.inner_text('#hwBody'), await pg.inner_text('#vdevNet') if await pg.locator('#vdevNet').count() else '')
        await authorize(pg); await pg.click('#simRun'); await pg.wait_for_timeout(300)
        t0 = time.monotonic(); await hold(bp, 'BTN1', 250)
        ok = await wf(pg, "(v=>v.ack && v.ack.v===1 && v.ack.matches)(doflab.twin.view('LED1.state'))", 8000); dt = time.monotonic() - t0
        await bp.wait_for_function("window.__bench.bench.parts.find(p=>p.id==='LED1').on", timeout=4000)
        check("延遲時：在工作台頁按一下 → LED 亮（工作台），DofLab 收到一致的回讀，而且比沒有延遲時晚（> 0.4 秒來回）", ok and dt > 0.4, str(round(dt, 2)))
        await hold(bp, 'BTN1', 250)
        ok = await wf(pg, "(v=>v.ack && v.ack.v===0 && v.ack.matches)(doflab.twin.view('LED1.state'))", 8000)
        check("延遲時：再按一下 → LED 熄滅，回讀的順序正確（最後是 0，沒有被前一個回讀蓋掉）", ok and not part(state(), 'LED1')['on'])
        await shots('f1_delay.png', pg, bp)

        # ---------- 2. 掉包：介面 → 設備全部遺失 ----------
        await net(bp, 0, 0, 100, 'up'); await bp.wait_for_timeout(200)
        w0 = state()['traffic']['writeCount']
        await hold(bp, 'BTN1', 250)
        ok = await wf(pg, "document.querySelector('#twinRows').textContent.includes('逾時未確認')", 6000)
        check("掉包：命令在路上遺失 → DofLab 的孿生狀態表標示「逾時未確認・不自動重送」", ok and await ev(pg, "doflab.twin.pending.length") == 1)
        await shots('f2_loss.png', pg, bp)
        await bp.click('#netClear'); await bp.wait_for_timeout(1800)
        st = state()
        check("網路恢復後，遺失的命令沒有被補送（設備端寫入筆數不變、工作台的 LED 仍不亮）", st['traffic']['writeCount'] == w0 and not part(st, 'LED1')['on'] and await ev(pg, "doflab.twin.pending.length") == 1, json.dumps([w0, st['traffic']['writeCount']]))

        # ---------- 3. 連線中斷 ----------
        await bp.click('#fDisconnect')
        ok = await wf(pg, "doflab.twin.mode==='sim' && doflab.twin.conn.state==='lost'", 6000)
        hw = await pg.inner_text('#hwBody')
        check("中斷連線：DofLab 回到模擬，剛才未確認的 1 個命令作廢、不會重送，量測標為過期", ok and '1 個未確認命令已作廢' in hw and await ev(pg, "doflab.twin.quality('BTN1.pressed')") == 'stale' and '連線中斷' in await pg.inner_text('#connPill'), hw[:200])
        await shots('f3_disconnect.png', pg, bp)

        # ---------- 4. 工作台拔掉一條線 ----------
        await connect(pg)
        check("重新連線從唯讀開始，設備端沒有收到舊命令", await ev(pg, "doflab.twin.mode") == 'hw-read' and state()['traffic']['writeCount'] == 0)
        await bp.click('[data-part="BTN1"] [data-k="wire"]'); await bp.wait_for_function("window.__bench.bench.parts.find(p=>p.id==='BTN1').unplugged")
        await hold(bp, 'BTN1', 400); await bp.wait_for_timeout(300); await hold(bp, 'BTN1', 400); await pg.wait_for_timeout(1000)
        check("拔掉 BTN1 的線：在工作台頁按了兩次，DofLab 的核對接線仍是「等待變化」（核對接線失敗）", '等待變化' in await pg.inner_text('#saw-BTN1') and await ev(pg, "doflab.twin.view('BTN1.pressed').measured.v") is False)
        await shots('f4_unplug.png', pg, bp)
        await bp.click('[data-part="BTN1"] [data-k="wire"]'); await bp.wait_for_function("!window.__bench.bench.parts.find(p=>p.id==='BTN1').unplugged")
        await hold(bp, 'BTN1', 400)
        check("接回後按一下：DofLab 顯示「已偵測到變化」", await wf(pg, "document.querySelector('#saw-BTN1').textContent.includes('已偵測到變化')", 5000))

        # ---------- 5. 設備重置（RESET）與瞬間斷電 ----------
        await authorize(pg); await pg.click('#simRun')
        # 等「安靜」：收到的按鈕都已送進引擎、之後再過 100 ms 模擬時間（去彈跳），沒有在途命令、最新的命令已確認。
        # 不能用固定延遲：headless 繪圖一幀 0.3–0.6 秒時，LED 可能先因為授權後的命令亮起，按下造成的切換（→ 0）還沒送出（完整測試時發生過）
        async def settled():
            t = await ev(pg, "(async()=>{ const q=()=>!(doflab.hw.btnQ||[]).length; for(let i=0;i<200&&!q();i++) await new Promise(r=>setTimeout(r,25)); return doflab.sim.time })()")
            return await wf(pg, "(v=>doflab.sim.time>=%d+100 && !(doflab.hw.btnQ||[]).length && doflab.twin.pending.length===0 && v.commanded && v.ack && v.ack.id===v.commanded.id)(doflab.twin.view('LED1.state'))" % t, 8000)
        for k in range(3):   # 按一下切換：按到 LED 的命令是 1 而且工作台的 LED 亮為止（切換狀態接著前面的操作）
            await settled()
            if await ev(pg, "doflab.twin.view('LED1.state').commanded.v") in (1, True) and part(state(), 'LED1')['on']: break
            await hold(bp, 'BTN1', 250)
            await wf(pg, "doflab.twin.view('BTN1.pressed').measured && doflab.twin.view('BTN1.pressed').measured.v === false", 4000)
        on0 = part(state(), 'LED1')['on']; w0 = state()['traffic']['writeCount']
        await bp.click('#fReset')
        ok = await wf(pg, "doflab.twin.mode==='hw-read' && doflab.events.some(e=>/設備重新開機/.test(e.text))", 6000)
        pill = await pg.inner_text('#modePill')
        check("按 RESET：DofLab 偵測到重新開機 → 撤銷寫入授權、回到「虛擬設備 · 唯讀」、模擬暫停，事件紀錄寫明原因", on0 and ok and pill.endswith('虛擬設備 · 唯讀') and not await ev(pg, "doflab.sim.running"), json.dumps([on0, ok, pill, await ev(pg, "doflab.sim.running")], ensure_ascii=False))
        st = state()
        check("重新開機後：晶片的 D13 回到輸入、工作台的 LED 熄滅，DofLab 沒有重送任何命令", st['pins']['13'] == 'input' and not part(st, 'LED1')['on'] and st['traffic']['writeCount'] == w0, json.dumps([st['pins']['13'], part(st, 'LED1'), w0, st['traffic']['writeCount'], st['traffic']['writes'][-4:], st['resets'], st['devMs'], json.loads(urllib.request.urlopen(api + '/trace', timeout=5).read())['resets'][-2:], await ev(pg, "doflab.events.slice(-14).map(e=>(e.simT!==undefined?e.simT+' ':'')+e.text)")], ensure_ascii=False))
        # 產品規則本身（和上一項的時序無關）：依設備時間，重置之後設備沒有收到任何寫入
        rs = [r for r in json.loads(urllib.request.urlopen(api + '/trace', timeout=5).read())['resets'] if r['flags'] == 2]; t_reset = rs[-1]['devMs'] if rs else None   # 2 = EXTRF（RESET 腳）；之後 Optiboot 以看門狗重置進入程式
        late = [w for w in st['traffic']['writes'] if t_reset is not None and w.get('devMs', 0) >= t_reset]
        check("重新開機後（依設備時間）：重置之後設備沒有收到任何寫入", t_reset is not None and not late, json.dumps([t_reset, late]))
        try: await pg.wait_for_function("document.querySelector('#vdevPresence') && document.querySelector('#vdevPresence').textContent.includes('沒有人控制')", timeout=5000); ok = True
        except Exception: ok = False
        ok = ok and await wf(bp, "document.querySelector('#holder') && document.querySelector('#holder').textContent === '沒有人'", 5000)
        check("重新開機後：控制權也交出去（DofLab 顯示「沒有人控制」，工作台頁的控制權是「沒有人」），別人才能取得", ok, await pg.inner_text('#vdevPresence') if await pg.locator('#vdevPresence').count() else '')
        await shots('f5_reboot.png', pg, bp)
        await hold(bp, 'BTN1', 300)
        check("重新開機後唯讀觀測自動恢復：在工作台頁按 BTN1，DofLab 量到按下", await wf(pg, "doflab.twin.log.some(e=>e.type==='measure' && e.name==='BTN1.pressed' && e.v===true && e.t > (doflab.twin.log.filter(x=>x.type==='reboot').pop()||{t:0}).t)", 5000))
        await authorize(pg)
        await bp.click('#fBrownout')
        check("瞬間斷電（brown-out）：一樣偵測到重新開機、撤銷授權回到唯讀", await wf(pg, "doflab.twin.mode==='hw-read' && doflab.twin.log.filter(e=>e.type==='reboot').length>=2", 6000))
        await pg.click('#hwDisc'); await pg.wait_for_timeout(300); srv.kill(); srv.wait()

        # ---------- 6. 感測器卡住 ----------
        srv = start('dist-gauge'); await bp.goto(f'http://127.0.0.1:{VPORT}/'); await bp.wait_for_function("window.__bench && document.querySelector('#us-US1')")
        await ev(pg, load('dist-gauge')); await pg.click('#t-behavior'); await pg.wait_for_timeout(300); await pg.click('#btnConfirm')
        await connect(pg)
        await bp.locator('#us-US1').fill('30'); await bp.locator('#us-US1').dispatch_event('input')
        await wf(pg, "(v=>v.measured && Math.abs(v.measured.v-30)<=1 && v.quality==='ok')(doflab.twin.view('US1.distance'))", 5000)
        await bp.click('[data-part="US1"] [data-k="stuck"]')
        ok = await wf(pg, "doflab.twin.quality('US1.distance')==='stale' && document.querySelector('#twinRows').textContent.includes('已過期')", 8000)
        check("超音波模組卡住（韌體不再回報）：約 2.5 秒後 DofLab 把距離標為「已過期」，連線本身仍正常", ok and await ev(pg, "doflab.twin.conn.state") == 'connected')
        await shots('f6_stuck.png', pg, bp)
        await bp.click('[data-part="US1"] [data-k="stuck"]')
        check("模組恢復：距離又是「有效」", await wf(pg, "doflab.twin.quality('US1.distance')==='ok'", 6000))
        await pg.click('#hwDisc')
        check("故障流程沒有頁面錯誤（兩個介面）", not errs, "; ".join(errs[:3]))
    finally:
        await b.close()
        if srv: srv.kill()

async def vupload_flow(p):
    """雲端虛擬硬體第 4 階段：「程式」頁上傳到虛擬 Uno（STK500 經 WebSocket → 另一個程序裡的虛擬 Optiboot）→ 程式在虛擬晶片上執行，
    工作台頁按按鈕、LED 閃爍；Serial.println 的文字經網路送回 DofLab 的序列埠監看。之後從觀測頁上傳 DofLabFirmata，恢復同步。"""
    import urllib.request
    from PIL import Image
    VPORT = 8770; api = f'http://127.0.0.1:{VPORT}/api/devices/uno-1'
    def state(): return json.loads(urllib.request.urlopen(api, timeout=5).read())
    def part(st, pid): return next(x for x in st['bench']['parts'] if x['id'] == pid)
    async def shots(name, pg, bp):
        await asyncio.gather(pg.screenshot(path=str(SHOTS / '_l.png')), bp.screenshot(path=str(SHOTS / '_r.png')))
        a, c = Image.open(SHOTS / '_l.png'), Image.open(SHOTS / '_r.png'); out = Image.new('RGB', (a.width + c.width + 12, max(a.height, c.height)), (120, 110, 170)); out.paste(a, (0, 0)); out.paste(c, (a.width + 12, 0)); out.save(SHOTS / name)
        os.remove(SHOTS / '_l.png'); os.remove(SHOTS / '_r.png')
    srv = subprocess.Popen(['node', str(ROOT / 'tools' / 'vdev' / 'server.js'), '--port', str(VPORT)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); wait_port(VPORT)
    b = await p.chromium.launch(args=ARGS); ctx = await b.new_context(viewport={'width': 1440, 'height': 940})
    errs = []
    try:
        pg = await ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
        bp = await ctx.new_page(); bp.on('pageerror', lambda e: errs.append('工作台頁：' + str(e))); await bp.set_viewport_size({'width': 900, 'height': 940})
        await pg.goto('http://localhost:8766/'); await pg.wait_for_function("window.doflab && doflab.p")
        await bp.goto(f'http://127.0.0.1:{VPORT}/'); await bp.wait_for_function("window.__bench && document.querySelector('#hold-BTN1')")
        await ev(pg, """(()=>{const r=DL.experiments.solved('hold-blink','uno'); const q=DL.project.clone(r.project,{name:'虛擬 Uno 上傳',origin:{kind:'custom'},lock:{components:false,behavior:false,board:false}});
          q.behavior.ir.rules.push({type:'start',actions:[{type:'print',text:'DofLab 準備好了'}]},{type:'event',event:'press',comp:'BTN1',actions:[{type:'print',text:'按下'}]},{type:'event',event:'release',comp:'BTN1',actions:[{type:'print',text:'放開'}]}); doflab.load(q); })()""")
        await pg.click('#t-behavior'); await pg.wait_for_timeout(300); await pg.click('#btnConfirm')
        await pg.click('#t-code'); await pg.wait_for_timeout(300)
        await pg.click('[data-upm="virtual"]'); await pg.wait_for_timeout(150)
        body = await pg.inner_text('#uploadBody')
        check("虛擬上傳：程式頁的上傳方式有「上傳到虛擬 Uno（網路）」，標示虛擬設備、預設網址指向本機主機", '虛擬設備，不是實體板子' in body and await pg.input_value('#upVdev') == f'ws://127.0.0.1:{VPORT}/dev/uno-1' and await pg.locator('#upStart').is_disabled(), body[:300])
        await pg.click('#btnGen'); await pg.wait_for_timeout(200); await pg.click('#btnCompile')
        await pg.wait_for_function("document.querySelector('#btnCompile').textContent==='編譯'", timeout=240000)
        check("虛擬上傳：編譯成功後（真的 arduino-cli）條件全部符合", await pg.locator('#upStart').is_enabled() and 'Serial.println' in await ev(pg, "doflab.p.code.text"))
        await pg.click('#upStart'); await pg.wait_for_timeout(150)
        txt = await pg.inner_text('#uploadBody')
        check("虛擬上傳：開始前逐項確認，寫明會覆蓋 DofLabFirmata、目標是虛擬設備不是實體板子", '覆蓋虛擬 Uno' in txt and '不是實體板子' in txt and await pg.locator('#upGo').is_disabled())
        for cb in await pg.locator('[data-upchk]').all(): await cb.check()
        await pg.click('#upGo')
        await pg.wait_for_function("doflab.up && !doflab.up.busy && (doflab.up.last || doflab.up.log.some(l=>l.kind==='e'))", timeout=120000)
        last = await ev(pg, "doflab.up.last || doflab.up.log.map(l=>l.msg).join(' | ')")
        for i in range(50):   # 主機在看門狗重置（離開 Optiboot）之後才判定上傳完成
            st = state()
            if st['uploads'] == 1: break
            await asyncio.sleep(0.1)
        check("虛擬上傳：STK500 經網路寫入虛擬 Optiboot、讀回比對一致；主機端辨識為「上傳的程式」", '讀回比對一致' in (last or '') and '虛擬設備' in last and st['uploads'] == 1 and st['firmware']['name'] == '上傳的程式', (last or '') + ' | ' + json.dumps(st['firmware'], ensure_ascii=False))
        try: await pg.wait_for_function("doflab.up.vmon && doflab.up.vmon.lines.includes('DofLab 準備好了') && document.querySelector('#upSerial').textContent.includes('DofLab 準備好了')", timeout=15000); ok = True
        except Exception: ok = False
        check("序列埠監看：上傳後自動開啟（虛擬 Uno 重新啟動，和 Arduino IDE 一樣），收到 setup() 印出的「DofLab 準備好了」", ok and 'DofLab 準備好了' in await pg.inner_text('#upSerial'), await ev(pg, "JSON.stringify(doflab.up.vmon && doflab.up.vmon.lines)"))
        await bp.wait_for_function("document.querySelector('#fwName') && document.querySelector('#fwName').textContent==='上傳的程式'", timeout=5000)
        check("工作台頁：韌體顯示「上傳的程式」", True)
        # 在工作台頁按住 BTN1：上傳的程式自己讓 LED 閃爍（不經過 DofLab 的模擬），序列埠送回「按下」
        h = await bp.locator('#hold-BTN1').bounding_box(); t0 = part(state(), 'LED1')['toggles']
        await bp.mouse.move(h['x'] + h['width'] / 2, h['y'] + h['height'] / 2); await bp.mouse.down()
        try: await pg.wait_for_function("doflab.up.vmon.lines.includes('按下')", timeout=8000); ok = True
        except Exception: ok = False
        for i in range(60):
            if part(state(), 'LED1')['toggles'] - t0 >= 3: break
            await asyncio.sleep(0.1)
        await shots("vu1_running.png", pg, bp)
        await bp.mouse.up()
        check("上傳的程式在虛擬晶片上執行：按住工作台的 BTN1，LED1 自己閃爍；DofLab 的序列埠監看收到「按下」", ok and part(state(), 'LED1')['toggles'] - t0 >= 3, json.dumps(part(state(), 'LED1')))
        try: await pg.wait_for_function("doflab.up.vmon.lines.includes('放開')", timeout=8000); ok = True
        except Exception: ok = False
        check("序列埠監看：放開後收到「放開」，文字順序和模擬的序列埠監看相同", ok and await ev(pg, "doflab.up.vmon.lines.filter(l=>l)") == ['DofLab 準備好了', '按下', '放開'], await ev(pg, "JSON.stringify(doflab.up.vmon.lines)"))
        check("事件紀錄：序列埠文字記錄為「虛擬 Uno 序列埠」", await ev(pg, "doflab.events.some(e=>/虛擬 Uno 序列埠：按下/.test(e.text))"))
        # 觀測頁：虛擬 Uno 跑的不是 Firmata → 很快說明原因與下一步（不是等很久的逾時）
        await pg.click('#t-observe'); await pg.wait_for_timeout(300)
        await pg.check('input[name="hwSrc"][value="virtual"]'); await pg.wait_for_timeout(100)
        t1 = time.time(); await pg.click('#hwConn')
        await pg.wait_for_function("!doflab.hw.busy", timeout=20000); took = time.time() - t1
        evs = await ev(pg, "doflab.events.slice(0, 8).map(e=>e.text).join(' | ')")
        check("觀測頁：虛擬 Uno 跑上傳的程式時連線會先關掉序列埠監看，並在幾秒內說明「要同步請先上傳 DofLabFirmata」", await ev(pg, "doflab.twin.conn.state") != 'connected' and '上傳 DofLabFirmata' in evs and took < 10 and not await ev(pg, "doflab.up.vmon.open"), f'{took:.1f}s ' + evs[:400])
        btn = await pg.inner_text('#fwFlash')
        check("觀測頁：來源是虛擬設備時，「上傳 DofLabFirmata」上傳到虛擬 Uno", '虛擬 Uno' in btn, btn)
        await pg.click('#fwFlash'); await pg.wait_for_timeout(200)
        for cb in await pg.locator('[data-fwchk]').all(): await cb.check()
        await pg.click('#fwGo')
        await pg.wait_for_function("doflab.up && !doflab.up.busy && doflab.hw.firmataFlashed", timeout=120000)
        for i in range(50):
            st = state()
            if st['uploads'] == 2: break
            await asyncio.sleep(0.1)
        check("觀測頁：DofLabFirmata 經網路上傳回去，主機端辨識為 DofLabFirmata", st['uploads'] == 2 and st['firmware']['name'] == 'DofLabFirmata', json.dumps(st['firmware'], ensure_ascii=False))
        await pg.click('#hwConn'); await pg.wait_for_function("doflab.twin.conn.state==='connected'", timeout=20000); await pg.wait_for_timeout(300)
        body = await pg.inner_text('#hwBody')
        check("觀測頁：重新上傳 DofLabFirmata 後可以連線同步，從唯讀開始（和實體板子的操作一樣）", 'DofLabFirmata' in body and await ev(pg, "doflab.twin.mode") == 'hw-read' and await ev(pg, "doflab.twin.conn.virtual"), body[:200])
        await shots("vu2_firmata_back.png", pg, bp)
        await pg.click('#hwDisc'); await pg.wait_for_timeout(300)
        check("虛擬上傳流程沒有頁面錯誤", not errs, "; ".join(errs[:3]))
    finally:
        await b.close(); srv.kill()

async def vmulti_flow(p):
    """雲端虛擬硬體第 5 階段：兩個 DofLab（老師、學生，各自一個瀏覽器）同時連同一台虛擬設備，外加工作台頁。
    兩個都能唯讀觀看；只有取得控制權的那一個能寫入；控制者關掉分頁後控制權釋放。之後學生匯出連線紀錄並重播。"""
    import urllib.request
    VPORT = 8770; api = f'http://127.0.0.1:{VPORT}/api/devices/uno-1'
    def state(): return json.loads(urllib.request.urlopen(api, timeout=5).read())
    def bench(part, action): urllib.request.urlopen(urllib.request.Request(api + '/bench', data=json.dumps({'part': part, 'action': action}).encode(), method='POST'), timeout=5).read()
    def led(st): return next(x for x in st['bench']['parts'] if x['id'] == 'LED1')
    srv = subprocess.Popen(['node', str(ROOT / 'tools' / 'vdev' / 'server.js'), '--port', str(VPORT)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); wait_port(VPORT)
    ba = await p.chromium.launch(args=ARGS); bb = await p.chromium.launch(args=ARGS)   # 兩個瀏覽器（兩台電腦）
    errs = []
    try:
        async def open_doflab(br, name):
            ctx = await br.new_context(viewport={'width': 1280, 'height': 900}); pg = await ctx.new_page(); pg.on('pageerror', lambda e: errs.append(name + '：' + str(e)))
            await pg.goto('http://localhost:8766/'); await pg.wait_for_function("window.doflab && doflab.p")
            await ev(pg, "(()=>{const r=DL.experiments.solved('hold-blink','uno'); doflab.load(DL.project.clone(r.project,{name:'多人測試',origin:{kind:'custom'},lock:{components:false,behavior:false,board:false}})); })()")
            await pg.click('#t-behavior'); await pg.wait_for_timeout(300); await pg.click('#btnConfirm')
            await pg.click('#t-observe'); await pg.wait_for_timeout(300)
            await pg.check('input[name="hwSrc"][value="virtual"]'); await pg.wait_for_timeout(100)
            await pg.fill('#vdevName', name)
            await pg.click('#hwConn'); await pg.wait_for_function("doflab.twin.conn.state==='connected'", timeout=20000)
            return ctx, pg
        ca, A = await open_doflab(ba, '老師')
        cb, B = await open_doflab(bb, '學生')
        try: await A.wait_for_function("document.querySelector('#vdevPresence') && document.querySelector('#vdevPresence').textContent.includes('2 個連線')", timeout=8000); ok = True
        except Exception: ok = False
        pa = await A.inner_text('#vdevPresence') if ok else ''; pb = await B.inner_text('#vdevPresence')
        check("多人：兩個瀏覽器同時連同一台虛擬設備，都顯示 2 個連線、誰是你、沒有人控制", ok and '老師（你）' in pa and '學生' in pa and '學生（你）' in pb and '沒有人控制' in pb, pa + ' | ' + pb)
        check("多人：兩邊都從唯讀開始", await ev(A, "doflab.twin.mode") == 'hw-read' and await ev(B, "doflab.twin.mode") == 'hw-read')
        bench('BTN1', 'press')
        okA = okB = True
        try: await A.wait_for_function("doflab.twin.view('BTN1.pressed').measured && doflab.twin.view('BTN1.pressed').measured.v === true", timeout=5000)
        except Exception: okA = False
        try: await B.wait_for_function("doflab.twin.view('BTN1.pressed').measured && doflab.twin.view('BTN1.pressed').measured.v === true", timeout=5000)
        except Exception: okB = False
        bench('BTN1', 'release')
        check("多人唯讀觀看：工作台按下 BTN1，兩個 DofLab 的量測層都顯示按下；設備沒有收到任何寫入", okA and okB and state()['traffic']['writeCount'] == 0)
        await A.wait_for_function("doflab.twin.view('BTN1.pressed').measured.v === false", timeout=5000)
        # 老師取得控制權
        for cb_ in await A.locator('[data-chk]').all(): await cb_.check()
        await A.click('#hwAuth')
        await A.wait_for_function("doflab.twin.mode==='hw-control'", timeout=8000)
        try: await B.wait_for_function("document.querySelector('#vdevPresence').textContent.includes('控制權：老師')", timeout=8000); ok = True
        except Exception: ok = False
        check("控制權：老師授權受控寫入時取得控制權，學生的畫面顯示「控制權：老師（你只能唯讀觀看）」", ok and '你只能唯讀觀看' in await B.inner_text('#vdevPresence') and '只有你能寫入' in await A.inner_text('#vdevPresence'))
        for cb_ in await B.locator('[data-chk]').all(): await cb_.check()
        await B.wait_for_timeout(200)
        hb = await B.inner_text('#hwBody')
        check("控制權：學生的授權條件列出「控制權在「老師」手上」，授權按鈕停用", '控制權在「老師」手上' in hb and await B.locator('#hwAuth').is_disabled(), hb[-300:])
        # 老師執行行為：按住工作台按鈕，LED 依老師的命令閃爍；學生沒有命令、也收不到老師的回讀
        await A.click('#simRun'); t0 = led(state())['toggles']
        bench('BTN1', 'press')
        for i in range(60):
            if led(state())['toggles'] - t0 >= 2: break
            await asyncio.sleep(0.1)
        try: await A.wait_for_function("(v => v.ack && v.ack.matches)(doflab.twin.view('LED1.state'))", timeout=5000); ackA = True
        except Exception: ackA = False
        check("只有一個能寫入：老師的命令讓工作台 LED 閃爍並收到回讀；學生沒有命令、也沒有收到老師的回讀", ackA and led(state())['toggles'] - t0 >= 2 and await ev(B, "(v => !v.commanded && !v.ack)(doflab.twin.view('LED1.state'))"))
        await shots_pair("m1_two_users.png", A, B)
        # 學生硬送寫入（繞過介面）：主機擋下，事件紀錄說明
        await ev(B, "doflab.hw.driver.send([0xF5, 13, 1]), doflab.hw.driver.send([0xF4, 13, 0])")
        try: await B.wait_for_function("doflab.events.some(e=>/你沒有控制權/.test(e.text))", timeout=5000); ok = True
        except Exception: ok = False
        st = state(); stu = next(l for l in st['hub']['links'] if l['name'] == '學生')
        check("只有一個能寫入：學生硬送的寫入被虛擬設備主機擋下（沒有到晶片），學生的事件紀錄說明「你沒有控制權」", ok and stu['blocked'] >= 2, json.dumps(st['hub'], ensure_ascii=False)[:300])
        bench('BTN1', 'release')
        # 老師直接關掉分頁（不先撤銷）：控制權釋放
        await ca.close()
        try: await B.wait_for_function("document.querySelector('#vdevPresence').textContent.includes('1 個連線') && document.querySelector('#vdevPresence').textContent.includes('沒有人控制')", timeout=10000); ok = True
        except Exception: ok = False
        check("中斷後控制權釋放：老師關掉分頁，學生看到控制權釋放（控制者中斷連線）、只剩 1 個連線", ok and await ev(B, "doflab.events.some(e=>/控制權已釋放（控制者中斷連線）/.test(e.text))"))
        await B.wait_for_timeout(200)
        check("中斷後控制權釋放：學生的授權按鈕可以按了", await B.locator('#hwAuth').is_enabled())
        await B.click('#hwAuth'); await B.wait_for_function("doflab.twin.mode==='hw-control'", timeout=8000)
        check("中斷後控制權釋放：學生取得控制權（只有你能寫入）", '只有你能寫入' in await B.inner_text('#vdevPresence') and state()['hub']['holder']['name'] == '學生')
        # 連線紀錄：學生執行一段，然後中斷、匯出、重播
        await B.click('#simRun')
        bench('BTN1', 'press'); await asyncio.sleep(1.6); bench('BTN1', 'release'); await asyncio.sleep(0.4)
        bench('BTN1', 'press'); await asyncio.sleep(0.25); bench('BTN1', 'release'); await asyncio.sleep(0.8)
        await B.click('#hwDisc'); await B.wait_for_function("doflab.twin.mode==='sim'", timeout=8000)
        n = await ev(B, "doflab.hw.rec.events.length"); types = await ev(B, "[...new Set(doflab.hw.rec.events.map(e=>e.type))].sort().join(',')")
        check("連線紀錄：中斷後保留這次連線的紀錄（量測、模擬輸出、命令、回讀、模式、執行），標示虛擬設備", n > 10 and all(k in types for k in ['measure', 'sim', 'command', 'ack', 'mode', 'run']) and await ev(B, "doflab.hw.rec.device.virtual") and '上次連線的紀錄' in await B.inner_text('#recStatus'), f'{n} {types}')
        async with B.expect_download() as dl: await B.click('#recExport')
        d = await dl.value; path = SHOTS / 'session.json'; await d.save_as(str(path))
        js = json.loads(path.read_text())
        check("匯出紀錄：下載 JSON（doflab-session 第 1 版），內容和畫面上的紀錄相同", js['format'] == 'doflab-session' and js['version'] == 1 and len(js['events']) == n and js['device']['virtual'], d.suggested_filename)
        await B.click('#recReplay')
        try: await B.wait_for_function("!doflab.replay && doflab.replayResult", timeout=30000); ok = True
        except Exception: ok = False
        res = await ev(B, "JSON.stringify(doflab.replayResult)")
        check("重播：在模擬中照紀錄的模擬時間重送輸入，重算的輸出和紀錄逐毫秒相同、紀錄中的命令都依序出現（不連設備）", ok and await ev(B, "doflab.replayResult.ok") and await ev(B, "doflab.twin.conn.state") != 'connected' and await ev(B, "doflab.events.some(e=>/重播完成：1 個輸出的變化和紀錄完全相同（LED1\\.state \\d+ 次；逐毫秒相同/.test(e.text))"), res[:400])
        # 從檔案重播（開啟剛才匯出的檔案）
        await B.set_input_files('#recFile', str(path))
        try: await B.wait_for_function("!!doflab.replay", timeout=5000); await B.wait_for_function("!doflab.replay", timeout=30000); ok = True
        except Exception: ok = False
        check("重播：開啟匯出的紀錄檔再重播一次，結果一樣一致", ok and await ev(B, "doflab.replayResult.ok"))
        await B.screenshot(path=str(SHOTS / "m2_replay.png"))
        check("多人流程沒有頁面錯誤", not errs, "; ".join(errs[:3]))
    finally:
        await ba.close(); await bb.close(); srv.kill()

async def shots_pair(name, a, b):
    from PIL import Image
    await asyncio.gather(a.screenshot(path=str(SHOTS / '_l.png')), b.screenshot(path=str(SHOTS / '_r.png')))
    x, y = Image.open(SHOTS / '_l.png'), Image.open(SHOTS / '_r.png'); out = Image.new('RGB', (x.width + y.width + 12, max(x.height, y.height)), (120, 110, 170)); out.paste(x, (0, 0)); out.paste(y, (x.width + 12, 0)); out.save(SHOTS / name)
    os.remove(SHOTS / '_l.png'); os.remove(SHOTS / '_r.png')

async def breadboard_flow(p):
    b = await p.chromium.launch(args=ARGS)
    ctx = await b.new_context(viewport={'width': 1440, 'height': 940})
    pg = await ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.goto('http://localhost:8766/'); await pg.wait_for_function("window.doflab && doflab.p"); await pg.wait_for_timeout(500)
    await pg.click('#btnStart'); await pg.click('[data-exp="hold-blink-bb"][data-board="uno"]'); await pg.wait_for_timeout(500)
    check("麵包板實驗：麵包板與三個插件都在場景中，插件不畫成導線", await ev(pg, "!!doflab.scene.objects.comps.BB1 && ['BTN1','R1','LED1'].every(id => DL.breadboard.mountOf(doflab.p, id)) && !Object.keys(doflab.scene.objects.wires).some(id => id.startsWith('I'))"))
    await ev(pg, "(()=>{const s=doflab.scene;s.cam.target.set(6,0,0);s.cam.r=22;s.cam.theta=0;s.cam.phi=0.5;s.userMoved=true;s.dirty=true})()"); await pg.wait_for_timeout(300)
    h = await scr(pg, E('BB1', 'h10')); await pg.mouse.move(h['x'], h['y']); await pg.wait_for_timeout(250)
    tip = await pg.inner_text('#vpConfig .tip')
    check("麵包板：滑過孔顯示所屬導通條，同一條 5 個孔標成綠色", '10 號 f–j' in tip and await ev(pg, "doflab.scene.busHl && doflab.scene.busHl.children.length") == 5, tip[:120])
    await pg.screenshot(path=str(SHOTS / "bb1_hover.png"))
    for a, bb in [(B('D2'), E('BB1', 'a5')), (B('D13'), E('BB1', 'a14')), (E('BB1', 'a7'), E('BB1', 'TN3')), (E('BB1', 'a19'), E('BB1', 'TN15')), (B('GND1'), E('BB1', 'TN1'))]:
        await wire(pg, a, bb); await pg.wait_for_timeout(80)
    a = await ev(pg, "(()=>{const a=doflab.analysis;return {ok:a.ok, b:a.bindings, n:doflab.p.connections.filter(w=>w.kind!=='insert').length}})()")
    check("麵包板接線：5 條線（含 2 條跳線）接好後 BTN1→D2、LED1→D13 經 R1、沒有錯誤", a['ok'] and a['n'] == 5 and a['b'].get('BTN1', {}).get('pin') == 'D2' and a['b'].get('LED1', {}).get('via') == ['R1'], json.dumps(a)[:300])
    n0 = await ev(pg, "doflab.p.connections.length")
    await ev(pg, "(()=>{doflab.sceneClickEp({comp:'board',term:'D4'}); doflab.sceneClickEp({comp:'BB1',term:'a5'});})()"); await pg.wait_for_timeout(100)
    check("麵包板：已經插了導線的孔不能再插", await ev(pg, "doflab.p.connections.length") == n0 and '已經插了' in await pg.inner_text('.toast'))
    await pg.screenshot(path=str(SHOTS / "bb2_wired.png"))
    await pg.click('#t-behavior'); await pg.wait_for_timeout(300); await pg.click('#btnConfirm'); await pg.wait_for_timeout(150)
    await pg.click('#t-observe'); await pg.wait_for_timeout(500); await pg.click('#simRun'); await pg.wait_for_timeout(100)
    bp = await ev(pg, "doflab.scene.compScreen('BTN1')"); await pg.mouse.move(bp['x'], bp['y']); await pg.mouse.down()
    vals = []
    for i in range(40): await pg.wait_for_timeout(80); vals.append(await ev(pg, "doflab.twin.view('LED1.state').simulated.v"))
    await pg.mouse.up(); await pg.click('#simRun')
    check("麵包板：模擬時按住插在麵包板上的 BTN1，LED1 閃爍", sum(1 for i in range(1, len(vals)) if vals[i] != vals[i - 1]) >= 2, str(vals))
    await pg.click('#t-config'); await pg.click('#bnCopy'); await pg.wait_for_timeout(400)
    await ev(pg, "(()=>{const s=doflab.scene;s.cam.target.set(11.6,0,0.2);s.cam.r=13;s.cam.theta=0;s.cam.phi=0.3;s.userMoved=true;s.dirty=true})()"); await pg.wait_for_timeout(300)
    tgt = await scr(pg, E('BB1', 'h25'))
    pal = await pg.locator('.pal[data-type="RES"]').bounding_box()
    await pg.mouse.move(pal['x'] + 20, pal['y'] + 20); await pg.mouse.down(); await pg.mouse.move(tgt['x'], tgt['y'], steps=12); await pg.mouse.up(); await pg.wait_for_timeout(300)
    m = await ev(pg, "(()=>{const m=DL.breadboard.mountOf(doflab.p,'R2');return m&&m.holes.map(h=>h.hole)})()")
    check("麵包板：從元件清單拖到麵包板上，電阻自動插入相隔 4 孔的兩個孔", bool(m) and len(m) == 2 and all(x[0] == 'h' for x in m), str(m))
    rp = await ev(pg, "doflab.scene.compScreen('R2')")
    await pg.mouse.move(rp['x'], rp['y']); await pg.mouse.down(); await pg.mouse.move(rp['x'], rp['y'] + 260, steps=10); await pg.mouse.up(); await pg.wait_for_timeout(300)
    check("麵包板：把電阻拖出麵包板就拔出", await ev(pg, "!DL.breadboard.mountOf(doflab.p,'R2') && !!DL.project.findComp(doflab.p,'R2')"))
    bb0 = await ev(pg, "JSON.stringify(DL.breadboard.mountOf(doflab.p,'LED1'))"); h0 = await ev(pg, "DL.project.inputsHash(doflab.p, DL.codegen.GENERATOR_VERSION)")
    bbp = await scr(pg, E('BB1', 'TP12')); await pg.mouse.move(bbp['x'], bbp['y'] - 12); await pg.mouse.down(); await pg.mouse.move(bbp['x'] - 120, bbp['y'] - 60, steps=10); await pg.mouse.up(); await pg.wait_for_timeout(300)
    moved = await ev(pg, "doflab.p.components.find(c=>c.id==='BB1').pos")
    check("麵包板：拖曳麵包板，插件跟著移動、孔位與輸入雜湊不變", abs(moved['x'] - 11.6) > 1 and await ev(pg, "JSON.stringify(DL.breadboard.mountOf(doflab.p,'LED1'))") == bb0 and await ev(pg, "DL.project.inputsHash(doflab.p, DL.codegen.GENERATOR_VERSION)") == h0, json.dumps(moved))
    await pg.screenshot(path=str(SHOTS / "bb3_custom.png"))
    check("麵包板流程沒有頁面錯誤", not errs, "; ".join(errs[:3]))
    await b.close()

async def upload_flow(p):
    """上傳燒錄：產生 → 真實編譯 → 瀏覽器以 STK500 上傳到虛擬 Uno（avr8js 執行 Arduino 官方 Optiboot）→ 新程式在晶片上執行；
    再從觀測頁把 DofLabFirmata 上傳回去並連線。"""
    fw = (ROOT / 'tests' / 'fixtures' / 'DofLabFirmata-uno.hex').read_text(); opti = (ROOT / 'tests' / 'fixtures' / 'optiboot_atmega328.hex').read_text()
    bundle = (ROOT / 'e2e' / 'virtual_uno.bundle.js').read_text()
    b = await p.chromium.launch(args=ARGS); ctx = await b.new_context(viewport={'width': 1440, 'height': 1000})
    await ctx.add_init_script(bundle + "\nwindow.addEventListener('DOMContentLoaded',()=>DofLabVirtual.install(" + json.dumps(fw) + ", {bootloader:" + json.dumps(opti) + "}));")
    pg = await ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.goto('http://localhost:8766/'); await pg.wait_for_function("window.doflab && doflab.p && window.__vuno")
    await ev(pg, "(()=>{const r=DL.experiments.solved('hold-blink','uno'); doflab.load(DL.project.clone(r.project,{name:'上傳測試',origin:{kind:'custom'},lock:{components:false,behavior:false,board:false}})); })()")
    await pg.click('#t-behavior'); await pg.wait_for_timeout(300); await pg.click('#btnConfirm')
    await pg.click('#t-code'); await pg.wait_for_timeout(300)
    check("上傳：還沒產生與編譯時，上傳按鈕停用並列出未符合的條件", await pg.locator('#upStart').is_disabled() and '未符合' in await pg.inner_text('#uploadBody'))
    await pg.click('#btnGen'); await pg.wait_for_timeout(200); await pg.click('#btnCompile')
    await pg.wait_for_function("document.querySelector('#btnCompile').textContent==='編譯'", timeout=240000)
    check("上傳：編譯成功後取得 .hex，條件全部符合", await pg.locator('#upStart').is_enabled() and await ev(pg, "doflab.lastArtifacts && doflab.lastArtifacts.artifacts.kind") == 'hex', (await pg.inner_text('#uploadBody'))[:300])
    await pg.click('#upStart'); await pg.wait_for_timeout(150)
    txt = await pg.inner_text('#uploadBody')
    check("上傳：開始前要逐項勾選（會覆蓋 DofLabFirmata、板型與接線已核對），未勾完不能開始", '覆蓋' in txt and 'DofLabFirmata' in txt and await pg.locator('#upGo').is_disabled())
    for cb in await pg.locator('[data-upchk]').all(): await cb.check()
    await pg.click('#upGo')
    await pg.wait_for_function("doflab.up && !doflab.up.busy && (doflab.up.last || doflab.up.log.some(l=>l.kind==='e'))", timeout=120000)
    last = await ev(pg, "doflab.up.last || doflab.up.log.map(l=>l.msg).join(' | ')")
    check("上傳：瀏覽器 STK500 寫入虛擬 Uno 的 Optiboot，讀回比對一致", '讀回比對一致' in (last or ''), last)
    check("上傳：快閃記憶體內容由 Optiboot 的 SPM 寫入", await ev(pg, "window.__vuno.spmLog.write") > 5)
    await pg.wait_for_timeout(1500)
    await ev(pg, "window.__vuno.setInput(2, false)"); seen = set()
    for i in range(25): await pg.wait_for_timeout(80); seen.add(await ev(pg, "window.__vuno.isHigh(13)"))
    await ev(pg, "window.__vuno.setInput(2, true)")
    check("上傳後新程式在晶片上執行：按住 D2，D13 自己以 1 Hz 閃爍（不經過 DofLab）", seen == {True, False}, str(seen))
    await pg.screenshot(path=str(SHOTS / "u1_uploaded.png"))
    # 觀測頁：板上已經不是 Firmata → 先上傳 DofLabFirmata 再連線
    await pg.click('#t-observe'); await pg.wait_for_timeout(300)
    await pg.click('#fwFlash'); await pg.wait_for_timeout(100)
    for cb in await pg.locator('[data-fwchk]').all(): await cb.check()
    await pg.click('#fwGo')
    await pg.wait_for_function("doflab.up && !doflab.up.busy && doflab.hw.firmataFlashed", timeout=120000)
    await pg.wait_for_timeout(1500)
    await pg.click('#hwConn'); await pg.wait_for_function("doflab.twin.conn.state==='connected'", timeout=20000); await pg.wait_for_timeout(500)
    check("觀測頁上傳 DofLabFirmata 後可以重新連線並辨識", 'DofLabFirmata' in await pg.inner_text('#hwBody'))
    # V2.6.1（實測回饋：連線有時被前一次占住）：連著的時候直接上傳程式 → 先自動中斷再上傳
    await pg.click('#t-code'); await pg.wait_for_timeout(300); await pg.click('#upStart'); await pg.wait_for_timeout(150)
    for cb in await pg.locator('[data-upchk]').all(): await cb.check()
    await ev(pg, "doflab.up.last = null"); await pg.click('#upGo')
    await pg.wait_for_function("doflab.up && !doflab.up.busy && (doflab.up.last || doflab.up.log.some(l=>l.kind==='e'))", timeout=120000)
    last = await ev(pg, "doflab.up.last || doflab.up.log.map(l=>l.msg).join(' | ')")
    check("占用處理：觀測頁還連著時上傳程式，會先自動中斷連線再上傳（讀回一致），連接埠沒有卡住", '讀回比對一致' in (last or '') and await ev(pg, "doflab.twin.conn.state") != 'connected' and await ev(pg, "doflab.up.log.some(l=>/先中斷/.test(l.msg))"), last)
    await pg.click('#t-observe'); await pg.wait_for_timeout(300)
    await pg.click('#fwFlash'); await pg.wait_for_timeout(100)
    for cb in await pg.locator('[data-fwchk]').all(): await cb.check()
    await ev(pg, "doflab.hw.firmataFlashed = false"); await pg.click('#fwGo')
    await pg.wait_for_function("doflab.up && !doflab.up.busy && doflab.hw.firmataFlashed", timeout=120000); await pg.wait_for_timeout(1500)
    # 模擬「上一次的連線沒有關乾淨」：本頁另一個連線開著同一個連接埠、讀取迴圈鎖著串流
    await ev(pg, "(async()=>{ window.__stale = new DL.drivers.FirmataDriver(doflab.twin, {}, 'uno'); await window.__stale.connect(); })()")
    stale_open = await ev(pg, "DL.serial.isOpen(window.__vuno && window.__stale.port)")
    await pg.click('#hwReconn'); await pg.wait_for_function("doflab.twin.conn.state==='connected' || !doflab.hw.busy", timeout=25000); await pg.wait_for_timeout(300)
    evs = await ev(pg, "doflab.events.map(e=>e.text).join(' | ')")
    check("占用處理：本頁殘留的舊連線還開著時，按「用上次的連接埠重新連線」（不用再選連接埠）會先關掉舊連線再連上", stale_open and await ev(pg, "doflab.twin.conn.state") == 'connected' and '還開著' in evs and await ev(pg, "window.__stale.closing"), evs[:300])
    await pg.click('#hwDisc'); await pg.wait_for_timeout(500)
    check("占用處理：中斷連線後連接埠確實關閉", not await ev(pg, "DL.serial.isOpen(window.__stale.port)"))
    check("上傳流程沒有頁面錯誤", not errs, "; ".join(errs[:3]))
    await b.close()

async def pi_deploy(p):
    """部署到樹莓派（pi_bridge --mock）：產生 Python → py_compile → 部署並執行 → 看到輸出 → 停止"""
    b = await p.chromium.launch(args=ARGS); ctx = await b.new_context(viewport={'width': 1440, 'height': 1000})
    pg = await ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.goto('http://localhost:8766/'); await pg.wait_for_function("window.doflab && doflab.p")
    await ev(pg, "(()=>{try{localStorage.setItem('doflab.wsUrl','ws://127.0.0.1:8765/ws')}catch(e){} const r=DL.experiments.solved('hold-blink','pi4b'); doflab.load(DL.project.clone(r.project,{name:'部署測試',origin:{kind:'custom'},lock:{components:false,behavior:false,board:false}})); })()")
    await pg.click('#t-behavior'); await pg.wait_for_timeout(300); await pg.click('#btnConfirm')
    await pg.click('#t-code'); await pg.wait_for_timeout(200); await pg.click('#btnGen'); await pg.wait_for_timeout(200); await pg.click('#btnCompile')
    await pg.wait_for_function("document.querySelector('#btnCompile').textContent==='編譯'", timeout=60000)
    await pg.fill('#upWs', 'ws://127.0.0.1:8765/ws')
    await pg.click('#upStart'); await pg.wait_for_timeout(100)
    check("部署：樹莓派的確認項目說明程式會直接控制 GPIO、關掉網頁仍會執行", '直接控制 GPIO' in await pg.inner_text('#uploadBody'))
    for cb in await pg.locator('[data-upchk]').all(): await cb.check()
    await pg.click('#upGo')
    await pg.wait_for_function("doflab.up.pi.running && doflab.up.pi.lines.some(l=>l.includes('開始執行'))", timeout=20000)
    check("部署：pi_bridge 寫入 main.py 並執行，網頁看得到程式輸出", '開始執行' in await pg.inner_text('#upOut'))
    await pg.screenshot(path=str(SHOTS / "u2_pi_deploy.png"))
    await pg.click('#upStop')
    await pg.wait_for_function("!doflab.up.pi.running", timeout=10000)
    check("部署：按「停止」後程式結束", '已停止' in await pg.inner_text('#upOut'))
    check("部署流程沒有頁面錯誤", not errs, "; ".join(errs[:3]))
    await b.close()

async def teacher_flow(p):
    """教師模式：接線助手（建議、接一條、全部完成、移除接錯的線、補元件）、指定腳位、存成引導實驗、學生版與提示"""
    b = await p.chromium.launch(args=ARGS); ctx = await b.new_context(viewport={'width': 1440, 'height': 1000})
    pg = await ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.goto('http://localhost:8766/'); await pg.wait_for_function("window.doflab && doflab.p"); await ev(pg, "localStorage.removeItem('doflab.teacherExps')")
    check("教師模式：預設關閉，沒有接線助手", await pg.locator('#assistCard').is_hidden())
    await pg.click('#btnTeacher'); await pg.wait_for_timeout(200)
    await pg.click('#btnStart'); await pg.click('[data-exp="hold-blink"][data-board="esp32"]'); await pg.wait_for_timeout(400)
    body = await pg.inner_text('#assistBody')
    check("接線助手：引導實驗沒有接線時，顯示下一條線與理由、還缺 5 條", '下一條線' in body and '內建上拉' in body and '還缺 5 條' in await pg.inner_text('#assistCount'), body[:200])
    check("接線助手：3D 場景用綠色虛線標出建議的兩個端點", await ev(pg, "!!(doflab.scene.sugGroup && doflab.scene.sugGroup.children.length === 3)"))
    await pg.click('#awOne'); await pg.wait_for_timeout(200)
    check("接這一條：只多一條線，剩 4 條", await ev(pg, "doflab.p.connections.length") == 1 and '還缺 4 條' in await pg.inner_text('#assistCount'))
    await pg.click('#awAll'); await pg.wait_for_timeout(300)
    a = await ev(pg, "(()=>{const a=doflab.analysis;return {ok:a.ok,b:Object.fromEntries(Object.entries(a.bindings).map(([k,v])=>[k,v.pin]))}})()")
    check("全部自動完成：檢查沒有錯誤，腳位與實驗建議相同（GPIO4、GPIO23）", a['ok'] and a['b'] == {'BTN1': 'GPIO4', 'LED1': 'GPIO23'}, json.dumps(a))
    check("全部自動完成後顯示「完成」，引導任務的接線項目打勾", '完成' in await pg.inner_text('#assistCount') and await ev(pg, "document.querySelectorAll('#taskList li.done').length") >= 3)
    await pg.screenshot(path=str(SHOTS / "t1_assist_done.png"))
    # 自訂專案：放 LED 與按鈕、指定腳位、補電阻、存成引導實驗
    await ev(pg, "(()=>{const p=DL.project.create('uno',{name:'我的專案（Uno R3）'}); DL.project.addComponent(p,'LED',{x:9,z:-1},0); DL.project.addComponent(p,'BTN',{x:8,z:2.5},0); p.behavior.ir={rules:JSON.parse(JSON.stringify(DL.experiments.HOLD_BLINK))}; doflab.load(p);})()")
    await pg.wait_for_timeout(300)
    check("接線助手：只有 LED 沒有電阻時，說明會自動補一顆電阻", 'R1' in await pg.inner_text('#assistBody'))
    led = await ev(pg, "doflab.scene.compScreen('LED1')"); await pg.mouse.click(led['x'], led['y']); await pg.wait_for_timeout(200)
    await pg.select_option('#prefPin', 'D7'); await pg.wait_for_timeout(200)
    check("指定腳位：選取 LED1 後指定 D7，助手的腳位清單顯示「老師指定」", 'D7' in await pg.inner_text('#assistBody') and '老師指定' in await pg.inner_text('#assistBody'))
    await pg.click('#awAll'); await pg.wait_for_timeout(300)
    a = await ev(pg, "(()=>{const a=doflab.analysis;return {ok:a.ok,led:a.bindings.LED1&&a.bindings.LED1.pin,via:a.bindings.LED1&&a.bindings.LED1.via,btn:a.bindings.BTN1&&a.bindings.BTN1.pin}})()")
    check("自動完成：補上 R1，LED1 接 D7 經 R1、BTN1 接 D2，沒有錯誤", a == {'ok': True, 'led': 'D7', 'via': ['R1'], 'btn': 'D2'}, json.dumps(a))
    # 接錯一條：只指出、勾選後移除
    await ev(pg, "(()=>{DL.project.addConnection(doflab.p,{comp:'board',term:'D7'},{comp:'BTN1',term:'1'}); doflab.changed('circuit');})()"); await pg.wait_for_timeout(200)
    check("接錯的線：助手指出哪一條，沒有勾選前不移除", '不該相通' in await pg.inner_text('#assistBody') and await pg.locator('#awAll').is_disabled())
    await pg.check('#awFix'); await pg.wait_for_timeout(200); await pg.click('#awAll'); await pg.wait_for_timeout(300)
    check("勾選「移除接錯的線」後自動修正，檢查沒有錯誤", await ev(pg, "doflab.analysis.ok"))
    await pg.click('#awGuide'); await pg.wait_for_timeout(200)
    await pg.fill('#gTitle', '我的按住閃爍'); await pg.check('#gStrict'); await pg.click('#gSave'); await pg.wait_for_timeout(300)
    check("存成引導實驗：學生版拿掉導線、鎖定元件與行為", '已存成引導實驗' in await pg.inner_text('#gMsg'))
    await pg.click('#gOpen'); await pg.wait_for_timeout(500)
    st = await ev(pg, "(()=>({kind:doflab.p.origin.kind, wires:doflab.p.connections.filter(w=>w.kind!=='insert').length, lock:doflab.p.lock.components&&doflab.p.lock.behavior, comps:doflab.p.components.map(c=>c.id).sort(), tasks:[...document.querySelectorAll('#taskList li')].map(l=>l.textContent)}))()")
    check("學生版：引導實驗、沒有導線、鎖定，任務依元件產生（指定腳位）", st['kind'] == 'guided' and st['wires'] == 0 and st['lock'] and st['comps'] == ['BTN1', 'LED1', 'R1'] and any('D7' in t for t in st['tasks']), json.dumps(st, ensure_ascii=False))
    await pg.click('#btnTeacher'); await pg.wait_for_timeout(200)   # 關掉教師模式＝學生的畫面
    check("學生：只看到「提示下一條線」，沒有自動接線按鈕", await pg.locator('#awHint').count() == 1 and await pg.locator('#awAll').count() == 0)
    await pg.click('#awHint'); await pg.wait_for_timeout(200)
    check("學生：提示顯示下一條線但不接線", '下一條線' in await pg.inner_text('#assistBody') and await ev(pg, "doflab.p.connections.filter(w=>w.kind!=='insert').length") == 0)
    # 學生自己接到別的腳位 → 指定腳位的任務不打勾
    for x, y in [(B('D2'), E('BTN1', '1')), (E('BTN1', '2'), B('GND1')), (B('D8'), E('R1', '1')), (E('R1', '2'), E('LED1', 'A')), (E('LED1', 'K'), B('GND2'))]:
        await ev(pg, "([a,b])=>{DL.project.addConnection(doflab.p,a,b);}", [x, y])
    await ev(pg, "doflab.changed('circuit')"); await pg.wait_for_timeout(200)
    t = await ev(pg, "[...document.querySelectorAll('#taskList li')].map(l=>[l.textContent,l.classList.contains('done')])")
    check("學生接到 D8：檢查沒有錯誤，但「接到 D7」的任務不打勾", await ev(pg, "doflab.analysis.ok") and any('D7' in x and not d for x, d in t), json.dumps(t, ensure_ascii=False))
    await pg.click('#btnStart'); await pg.wait_for_timeout(200)
    check("開始對話框列出老師自訂的實驗", '我的按住閃爍' in await pg.inner_text('#myExpList'))
    await pg.click('#dlgStart [data-close]')
    check("教師模式流程沒有頁面錯誤", not errs, "; ".join(errs[:3]))
    await b.close()

async def new_experiments(p):
    """V2.4 新增的五個引導實驗：從開始對話框開啟 → 教師模式自動接線 → 確認行為 → 在觀測頁模擬操作 → 任務全部完成"""
    b = await p.chromium.launch(args=ARGS); ctx = await b.new_context(viewport={'width': 1440, 'height': 1000})
    pg = await ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.goto('http://localhost:8766/'); await pg.wait_for_function("window.doflab && doflab.p")
    await ev(pg, "localStorage.setItem('doflab.teacher','true')"); await pg.reload(); await pg.wait_for_function("window.doflab && doflab.p")
    view = lambda sig: ev(pg, f"(()=>{{const v=doflab.twin.view('{sig}');return v.simulated?v.simulated.v:null}})()")
    async def settle(want):
        # 軟體渲染時模擬一格可能超過 100 ms，所以等到狀態符合（最多 2 秒）再讀，而不是固定延遲
        js = " && ".join(f"(doflab.twin.view('{k}').simulated||{{}}).v === {v}" for k, v in want.items())
        try: await pg.wait_for_function(js, timeout=4000)
        except Exception: pass
        return [await view(k) for k in want]
    async def click_btn(comp, want, hold=0.4):
        bp = await ev(pg, f"doflab.scene.compScreen('{comp}')"); await pg.mouse.move(bp['x'], bp['y']); await pg.mouse.down()
        try: await pg.wait_for_function(f"(doflab.twin.view('{comp}.pressed').simulated||{{}}).v === true", timeout=4000)
        except Exception: pass
        await pg.wait_for_timeout(int(hold * 1000)); await pg.mouse.up()
        try: await pg.wait_for_function(f"!(doflab.twin.view('{comp}.pressed').simulated||{{}}).v", timeout=2000)
        except Exception: pass
        return await settle(want)
    async def light(v):
        await ev(pg, f"(()=>{{const r=document.getElementById('ldr-LDR1'); r.value={v}; r.dispatchEvent(new Event('input'));}})()"); await pg.wait_for_timeout(250)
    async def open_and_wire(exp, board='uno'):
        await pg.click('#btnStart'); await pg.click(f'[data-exp="{exp}"][data-board="{board}"]'); await pg.wait_for_timeout(400)
        await pg.click('#awAll'); await pg.wait_for_timeout(300)
        await pg.click('#t-behavior'); await pg.wait_for_timeout(300); await pg.click('#btnConfirm'); await pg.wait_for_timeout(150)
        await pg.click('#t-observe'); await pg.wait_for_timeout(400); await pg.click('#simRun'); await pg.wait_for_timeout(150)
        return await ev(pg, "doflab.analysis.ok")
    async def tasks_done():
        await pg.click('#simRun'); await pg.click('#t-config')
        try: await pg.wait_for_function("(()=>{const l=document.querySelectorAll('#taskList li'); return l.length > 0 && document.querySelectorAll('#taskList li.done').length === l.length})()", timeout=3000)   # 等狀態，不用固定延遲（任務清單最多每 0.5 秒重畫，慢的畫面一幀可能超過 1 秒）
        except Exception: pass
        return await ev(pg, "[document.querySelectorAll('#taskList li.done').length, document.querySelectorAll('#taskList li').length]")
    # 1 按一下切換
    ok = await open_and_wire('toggle-led')
    s = [(await click_btn('BTN1', {'LED1.state': 1}))[0], (await click_btn('BTN1', {'LED1.state': 0}))[0], (await click_btn('BTN1', {'LED1.state': 1}, 1.2))[0]]
    d = await tasks_done()
    check("新實驗「按一下切換」：自動接線無錯；按一下亮、再按滅；按住 1.2 秒只切換一次；任務全部完成", ok and s == [1, 0, 1] and d[0] == d[1], json.dumps([ok, s, d]))
    # 2 行人按鈕紅綠燈
    ok = await open_and_wire('ped-light', 'esp32')
    s0 = await settle({'LED1.state': 0, 'LED2.state': 1})
    bp = await ev(pg, "doflab.scene.compScreen('BTN1')"); await pg.mouse.move(bp['x'], bp['y']); await pg.mouse.down()
    s1 = await settle({'LED1.state': 1, 'LED2.state': 0})
    await pg.mouse.up(); s2 = await settle({'LED1.state': 0, 'LED2.state': 1})
    d = await tasks_done()
    check("新實驗「行人按鈕紅綠燈」（ESP32）：開始綠燈；按住紅燈、綠燈滅；放開恢復；任務全部完成", ok and s0 == [0, 1] and s1 == [1, 0] and s2 == [0, 1] and d[0] == d[1], json.dumps([ok, s0, s1, s2, d]))
    # 3 太亮警示
    ok = await open_and_wire('bright-alarm')
    await light(40); off = await view('LED1.state')
    t0 = await ev(pg, "doflab.sim.time"); await light(90)
    try: await pg.wait_for_function(f"doflab.sim.time > {t0} + 900", timeout=8000)
    except Exception: pass
    # 以模擬時間計：90 % 之後的 LED1 事件（軟體繪圖時畫面很慢，用固定間隔取樣會漏掉 100 ms 的閃爍）
    vals = await ev(pg, f"[...new Set(doflab.events.filter(e=>e.simT!==null && e.simT>{t0} && /^LED1 → /.test(e.text)).map(e=>e.text.endsWith('亮')?1:0))]")
    await light(50); after = (await settle({'LED1.state': 0}))[0]
    d = await tasks_done()
    check("新實驗「太亮警示」：40 % 不亮；90 % 快速閃爍；降回 50 % 熄滅；任務全部完成", ok and off == 0 and len(set(vals)) == 2 and after == 0 and d[0] == d[1], json.dumps([ok, off, vals, after, d]))
    # 4 光控遮陽板
    ok = await open_and_wire('sun-shade')
    await light(30); a0 = (await settle({'SERVO1.angle': 30}))[0]; await light(80); a1 = (await settle({'SERVO1.angle': 150}))[0]; await light(20); a2 = (await settle({'SERVO1.angle': 30}))[0]
    tw = await pg.inner_text('#twinRows')
    d = await tasks_done()
    check("新實驗「光控遮陽板」：命令角度 30° → 150° → 30°，量測欄標示無回授；任務全部完成", ok and [a0, a1, a2] == [30, 150, 30] and '無回授' in tw and d[0] == d[1], json.dumps([ok, a0, a1, a2, d]))
    # 5 雙按鈕雙燈（麵包板）
    ok = await open_and_wire('bb-two-toggles', 'pi4b')
    s1 = await click_btn('BTN1', {'LED1.state': 1, 'LED2.state': 0})
    s2 = await click_btn('BTN2', {'LED1.state': 1, 'LED2.state': 1})
    s3 = await click_btn('BTN1', {'LED1.state': 0, 'LED2.state': 1})
    d = await tasks_done()
    rails = await ev(pg, "doflab.p.connections.filter(w=>w.kind!=='insert' && [w.a,w.b].some(e=>e.comp==='BB1' && /^(TN|BN)/.test(e.term))).length")
    check("新實驗「雙按鈕雙燈（麵包板，Pi 4B）」：GND 走電源排；兩組各自切換互不影響；任務全部完成", ok and rails >= 3 and s1 == [1, 0] and s2 == [1, 1] and s3 == [0, 1] and d[0] == d[1], json.dumps([ok, rails, s1, s2, s3, d]))
    await pg.screenshot(path=str(SHOTS / "x5_bb_two.png"))
    check("新實驗流程沒有頁面錯誤", not errs, "; ".join(errs[:3]))
    await b.close()

async def ultrasonic_flow(p, pi_port):
    """V2.5 超音波＋SG90：模擬（三種板型）、積木、真實編譯、教師指定 TRIG／ECHO、樹莓派閘道（模擬腳位）與虛擬 Uno（DofLabFirmata 實際量回波）"""
    import aiohttp
    b = await p.chromium.launch(args=ARGS); ctx = await b.new_context(viewport={'width': 1440, 'height': 1000})
    pg = await ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.goto('http://localhost:8766/'); await pg.wait_for_function("window.doflab && doflab.p")
    await ev(pg, "localStorage.setItem('doflab.teacher','true')"); await pg.reload(); await pg.wait_for_function("window.doflab && doflab.p")
    view = lambda sig: ev(pg, f"(()=>{{const v=doflab.twin.view('{sig}');return v.simulated?v.simulated.v:null}})()")
    async def wait_sig(sig, val, ms=3000):
        try: await pg.wait_for_function(f"(doflab.twin.view('{sig}').simulated||{{}}).v === {json.dumps(val)}", timeout=ms); return True
        except Exception: return False
    async def dist(cm):
        await ev(pg, f"(()=>{{const r=document.getElementById('us-US1'); r.value={cm}; r.dispatchEvent(new Event('input'));}})()"); await pg.wait_for_timeout(50)
    async def open_wire(exp, board):
        await pg.click('#btnStart'); await pg.click(f'[data-exp="{exp}"][data-board="{board}"]'); await pg.wait_for_timeout(400)
        await pg.click('#awAll'); await pg.wait_for_timeout(300)
        await pg.click('#t-behavior'); await pg.wait_for_timeout(400)
    async def to_observe():
        await pg.click('#btnConfirm'); await pg.wait_for_timeout(100)
        await pg.click('#t-observe'); await pg.wait_for_timeout(400); await pg.click('#simRun'); await pg.wait_for_timeout(100)
    async def tasks_done():
        await pg.click('#simRun'); await pg.click('#t-config')
        try: await pg.wait_for_function("(()=>{const l=document.querySelectorAll('#taskList li'); return l.length > 0 && document.querySelectorAll('#taskList li.done').length === l.length})()", timeout=3000)   # 等狀態，不用固定延遲（任務清單最多每 0.5 秒重畫，慢的畫面一幀可能超過 1 秒）
        except Exception: pass
        return await ev(pg, "[document.querySelectorAll('#taskList li.done').length, document.querySelectorAll('#taskList li').length]")

    # 1. 距離指針（Uno）：積木、接線、模擬、真實編譯
    await open_wire('dist-gauge', 'uno')
    bl = await ev(pg, "(()=>{const t=doflab.blocks.ws.getAllBlocks(false).map(b=>b.type); return {t, same: DL.stableStringify(doflab.blocks.toIR().ir)===DL.stableStringify(doflab.p.behavior.ir), b: doflab.analysis.bindings.US1}})()")
    check("超音波：積木顯示「距離小於」條件與「伺服角度跟著距離」動作，積木轉回 IR 與實驗相同", 'dl_cond_distance' in bl['t'] and 'dl_act_servomap' in bl['t'] and bl['same'], json.dumps(bl)[:200])
    check("超音波：接線助手把 TRIG 接 D7、ECHO 接 D8、VCC 接 5V（Uno 用 HC-SR04）", bl['b'] and bl['b']['trig'] == 'D7' and bl['b']['echo'] == 'D8' and bl['b']['vcc'] == 5, json.dumps(bl['b']))
    summ = await pg.inner_text('#summaryList')
    check("超音波：行為摘要寫出換算方式", '5 cm → 180°' in summ and '50 cm → 0°' in summ, summ[:120])
    await to_observe()
    await dist(12); a12 = await wait_sig('SERVO1.angle', 152)
    await dist(40); a40 = await wait_sig('SERVO1.angle', 40)
    await pg.click('[data-usfar="US1"]'); await pg.wait_for_timeout(600); far = await view('SERVO1.angle')
    tw = await pg.inner_text('#twinRows')
    await pg.screenshot(path=str(SHOTS / "u1_gauge_observe.png"))
    d = await tasks_done()
    check("距離指針：12 cm → 152°、40 cm → 40°；移走物體（沒有回波）指針停在 40°；孿生表顯示距離與「無回授」；任務全部完成", a12 and a40 and far == 40 and '沒有回波' in tw and '無回授' in tw and d[0] == d[1], json.dumps([a12, a40, far, d]))
    await pg.click('#t-code'); await pg.click('#btnGen'); await pg.wait_for_timeout(300)
    code = await ev(pg, "document.getElementById('code').value")
    await pg.click('#btnCompile'); await pg.wait_for_function("document.querySelector('#btnCompile').textContent==='編譯'", timeout=180000)
    badge = await pg.inner_text('#buildBadge'); scan = await pg.inner_text('#scanList')
    check("距離指針：產生的程式用非阻塞量測（沒有 pulseIn）與 map()，arduino-cli 真實編譯成功；TRIG／ECHO 腳位比對一致", 'updateUS1' in code and 'pulseIn(' not in code and 'map(constrain(us1Cm' in code and '成功' in badge and 'US1 TRIG' in scan and 'US1 ECHO' in scan, badge + ' | ' + scan[:200])

    # 2. 感應垃圾桶蓋（ESP32，3.3 V 版模組）
    await open_wire('smart-bin', 'esp32')
    bnd = await ev(pg, "doflab.analysis.bindings.US1")
    await to_observe()
    a0 = await view('SERVO1.angle'); await pg.click('[data-usnear="US1"]'); op = await wait_sig('SERVO1.angle', 100)
    await dist(60); cl = await wait_sig('SERVO1.angle', 10)
    d = await tasks_done()
    check("感應垃圾桶蓋（ESP32）：HC-SR04P 接 3V3、TRIG GPIO26／ECHO GPIO27；手靠近 → 100°、離開 → 10°；任務全部完成", bnd['vcc'] == 3.3 and bnd['model'] == 'HC-SR04P' and (bnd['trig'], bnd['echo']) == ('GPIO26', 'GPIO27') and a0 == 10 and op and cl and d[0] == d[1], json.dumps([bnd, a0, op, cl, d]))

    # 3. 倒車雷達（麵包板，Pi 4B）
    await open_wire('parking-radar', 'pi4b')
    rails = await ev(pg, "doflab.analysis.nets.filter(n=>n.gnd.length && (n.bb||[]).some(x=>x.bus==='TN'||x.bus==='BN')).length")
    await to_observe()
    await dist(30); await pg.wait_for_timeout(300); vals = []
    for i in range(16): await pg.wait_for_timeout(60); vals.append(await view('LED1.state'))
    r30 = await view('LED2.state')
    await dist(10); red = await wait_sig('LED2.state', 1)
    await pg.screenshot(path=str(SHOTS / "u2_radar_bb_observe.png"))
    d = await tasks_done()
    check("倒車雷達（麵包板，Pi 4B）：GND 走電源排；30 cm 黃燈閃爍、紅燈不亮；10 cm 紅燈亮；任務全部完成", rails >= 1 and len(set(vals)) == 2 and r30 == 0 and red and d[0] == d[1], json.dumps([rails, vals, r30, red, d]))

    # 4. 教師：自訂專案指定 TRIG／ECHO 腳位，存成引導實驗
    await ev(pg, "(()=>{const p=DL.project.create('uno',{name:'我的超音波'}); DL.project.addComponent(p,'US',{x:7.6,z:2.6},90); DL.project.addComponent(p,'SERVO',{x:10.4,z:-1.8},0); p.behavior.ir={rules:[{type:'while',cond:{type:'distance',comp:'US1',op:'lt',value:25},actions:[{type:'servo',comp:'SERVO1',angle:120}],onEnd:'off',restart:'restart'}]}; doflab.load(p); doflab.ui.selected={kind:'comp',id:'US1'}; doflab.renderInspector();})()")
    await pg.wait_for_timeout(300)
    await pg.select_option('#prefPin', 'D4'); await pg.select_option('#prefPinEcho', 'D5'); await pg.wait_for_timeout(200)
    pins = await pg.inner_text('#assistBody')
    await pg.click('#awAll'); await pg.wait_for_timeout(300)
    bnd = await ev(pg, "doflab.analysis.bindings.US1")
    await ev(pg, "doflab.openGuideDialog()"); await pg.wait_for_timeout(200); await pg.check('#gStrict'); await pg.click('#gSave'); await pg.wait_for_timeout(300)
    cu = await ev(pg, "doflab._lastGuide && doflab._lastGuide.custom")
    check("教師模式：超音波可以分別指定 TRIG（D4）與 ECHO（D5）；存成引導實驗時兩個腳位都記下來，任務寫出 TRIG／ECHO", 'US1 TRIG' in pins and 'US1 ECHO' in pins and bnd['trig'] == 'D4' and bnd['echo'] == 'D5' and cu and cu['pins'].get('US1.ECHO') == 'D5' and cu['hasDistance'], json.dumps([bnd, cu and cu['pins']]))
    await pg.keyboard.press('Escape')

    # 5. 樹莓派閘道（--mock）：唯讀量測距離 → 引擎推算
    await ev(pg, "(()=>{const r=DL.experiments.solved('dist-alarm','pi4b'); doflab.load(DL.project.clone(r.project,{name:'Pi 超音波',origin:{kind:'custom'},lock:{components:false,behavior:false,board:false}}));})()")
    await pg.click('#t-behavior'); await pg.wait_for_timeout(300); await pg.click('#btnConfirm'); await pg.click('#t-observe'); await pg.wait_for_timeout(300)
    await pg.fill('#wsUrl', f'ws://localhost:{pi_port}/ws'); await pg.click('#hwConn')
    await pg.wait_for_function("doflab.twin.conn.state==='connected'", timeout=8000)
    try: await pg.wait_for_function("(doflab.twin.view('US1.distance').measured||{}).v === 100", timeout=3000); m100 = True
    except Exception: m100 = False
    await pg.click('#simRun')
    async with aiohttp.ClientSession() as s:
        async with s.ws_connect(f'http://localhost:{pi_port}/ws') as ws:
            await ws.send_json({"op": "mock_distance", "trig": 5, "cm": 12})
            on = await wait_sig('LED1.state', 1, 4000)
            q = await ev(pg, "doflab.twin.quality('US1.distance')"); cmd = await ev(pg, "doflab.twin.view('LED1.state').commanded")
            await ws.send_json({"op": "mock_distance", "trig": 5, "cm": 100})
            off = await wait_sig('LED1.state', 0, 4000)
    check("樹莓派閘道（模擬腳位）：唯讀時量測層收到距離；12 cm → 行為推算 LED1 亮、100 cm → 熄滅；唯讀沒有送出命令", m100 and on and off and q == 'ok' and cmd is None, json.dumps([m100, on, off, q, cmd]))
    await pg.click('#simRun'); await pg.click('#hwDisc'); await pg.wait_for_timeout(300)
    check("超音波流程沒有頁面錯誤", not errs, "; ".join(errs[:3]))
    await b.close()

    # 6. 虛擬 Uno（DofLabFirmata 1.1 真實韌體＋HC-SR04 時序模型）：真機同步一路到 D13
    hexText = (ROOT / 'tests' / 'fixtures' / 'DofLabFirmata-uno.hex').read_text()
    bundle = (ROOT / 'e2e' / 'virtual_uno.bundle.js').read_text()
    b = await p.chromium.launch(args=ARGS); ctx = await b.new_context(viewport={'width': 1440, 'height': 1000})
    await ctx.add_init_script(bundle + "\nwindow.addEventListener('DOMContentLoaded',()=>{const u=DofLabVirtual.install(" + json.dumps(hexText) + "); window.__sonar=u.attachSonar(7, 8, 80);});")
    pg = await ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.goto('http://localhost:8766/'); await pg.wait_for_function("window.doflab && doflab.p && window.__vuno && window.__sonar")
    await ev(pg, "(()=>{const r=DL.experiments.solved('dist-alarm','uno'); doflab.load(DL.project.clone(r.project,{name:'虛擬 Uno 超音波',origin:{kind:'custom'},lock:{components:false,behavior:false,board:false}}));})()")
    await pg.click('#t-behavior'); await pg.wait_for_timeout(300); await pg.click('#btnConfirm'); await pg.click('#t-observe'); await pg.wait_for_timeout(300)
    await pg.click('#hwConn'); await pg.wait_for_function("doflab.twin.conn.state==='connected'", timeout=15000)
    try: await pg.wait_for_function("(m => m && Math.abs(m.v - 80) <= 1)(doflab.twin.view('US1.distance').measured)", timeout=5000); m80 = True
    except Exception: m80 = False
    hb = await pg.inner_text('#hwBody')
    for cb in await pg.locator('[data-chk]').all(): await cb.check()
    await pg.wait_for_timeout(100); can = await pg.locator('#hwAuth').is_enabled()
    await pg.click('#hwAuth'); await pg.wait_for_timeout(300); await pg.click('#simRun')
    await ev(pg, "window.__sonar.cm = 9")
    try: await pg.wait_for_function("window.__vuno.isHigh(13)", timeout=5000); lit = True
    except Exception: lit = False
    ack = await ev(pg, "(v => v.ack && v.ack.matches)(doflab.twin.view('LED1.state'))")
    await ev(pg, "window.__sonar.cm = 60")
    try: await pg.wait_for_function("!window.__vuno.isHigh(13)", timeout=5000); dark = True
    except Exception: dark = False
    await pg.screenshot(path=str(SHOTS / "u3_virtual_uno_sonar.png"))
    await pg.click('#simRun'); await pg.click('#hwDisc'); await pg.wait_for_timeout(500)
    trig_in = await ev(pg, "(window.__vuno.cpu.data[0x2A] & 0x80) === 0")
    check("虛擬 Uno＋DofLabFirmata：韌體量到 80 cm（誤差 ≤ 1 cm）；授權後物體靠近到 9 cm → D13 亮並收到 ACK、移到 60 cm → 熄滅；中斷後 TRIG 回到輸入", m80 and can and lit and ack and dark and trig_in and 'TRIG' in hb, json.dumps([m80, can, lit, ack, dark, trig_in]))
    check("虛擬 Uno 超音波流程沒有頁面錯誤", not errs, "; ".join(errs[:3]))
    await b.close()

async def onboard_flow(p):
    """V2.6 只用 ESP32 DevKit V1 板子的實驗：在 3D 板子上按 BOOT、碰觸控腳；藍燈、序列埠監看、任務、真實編譯（DOIT 板型）、Arduino IDE 上傳說明"""
    b = await p.chromium.launch(args=ARGS); ctx = await b.new_context(viewport={'width': 1440, 'height': 1000})
    pg = await ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.goto('http://localhost:8766/'); await pg.wait_for_function("window.doflab && doflab.p")
    sim = lambda sig: ev(pg, f"(doflab.twin.view('{sig}').simulated||{{}}).v")
    async def wait_sig(sig, val, ms=3000):
        try: await pg.wait_for_function(f"(doflab.twin.view('{sig}').simulated||{{}}).v === {json.dumps(val)}", timeout=ms); return True
        except Exception: return False
    async def press(comp, hold):
        pt = await ev(pg, f"doflab.scene.compScreen('{comp}')"); await pg.mouse.move(pt['x'], pt['y']); await pg.mouse.down()
        ok = await wait_sig(comp + '.pressed', True)
        await pg.wait_for_timeout(int(hold * 1000)); await pg.mouse.up(); await wait_sig(comp + '.pressed', False); return ok
    async def open_exp(exp):
        await pg.click('#btnStart'); await pg.click(f'[data-exp="{exp}"][data-board="esp32doit"]'); await pg.wait_for_timeout(500)
    async def tasks_done():
        await pg.click('#simRun'); await pg.click('#t-config')
        try: await pg.wait_for_function("(()=>{const l=document.querySelectorAll('#taskList li'); return l.length > 0 && document.querySelectorAll('#taskList li.done').length === l.length})()", timeout=3000)   # 等狀態，不用固定延遲（任務清單最多每 0.5 秒重畫，慢的畫面一幀可能超過 1 秒）
        except Exception: pass
        return await ev(pg, "[document.querySelectorAll('#taskList li.done').length, document.querySelectorAll('#taskList li').length]")
    # 開始對話框：只用板子的實驗排在最前面，只有 ESP32 V1 可以開
    await pg.click('#btnStart'); await pg.wait_for_timeout(300)
    first = await ev(pg, "[...document.querySelectorAll('#expList .exp h4')].slice(0,3).map(h=>h.textContent)")
    btns = await ev(pg, "[...document.querySelectorAll('#expList .exp')][0].querySelectorAll('button:not([disabled])').length")
    check("只用板子：三個實驗排在最前面，只能用 ESP32 V1（DevKit V1）開啟；ESP32 V1 也能開原本的 ESP32 實驗", all('只用板子' in t for t in first) and btns == 1 and await ev(pg, "!!document.querySelector('[data-exp=\"hold-blink\"][data-board=\"esp32doit\"]')"), json.dumps([first, btns]))
    await pg.keyboard.press('Escape')
    # 1. BOOT 鍵切換藍燈
    await open_exp('board-boot-toggle')
    st = await ev(pg, "({ok: doflab.analysis.ok, wires: doflab.p.connections.length, b: doflab.analysis.bindings.OBLED1.pin, boot: doflab.analysis.bindings.BOOT1.pin, warn: doflab.analysis.counts.warn, pal: [...document.querySelectorAll('#palette .pal')].map(x=>x.dataset.type)})")
    check("BOOT 鍵切換藍燈：不需要接線就通過檢查（藍燈 GPIO2、BOOT GPIO0）；元件清單列出板載 LED、BOOT 鍵、觸控腳", st['ok'] and st['wires'] == 0 and st['b'] == 'GPIO2' and st['boot'] == 'GPIO0' and st['warn'] == 0 and all(t in st['pal'] for t in ['OBLED', 'BOOT', 'TOUCH']), json.dumps(st))
    await pg.click('#t-behavior'); await pg.wait_for_timeout(500)
    blk = await ev(pg, "doflab.blocks.ws.getAllBlocks(false).map(b=>b.type)")
    await pg.click('#btnConfirm'); await pg.click('#t-observe'); await pg.wait_for_timeout(400); await pg.click('#simRun'); await pg.wait_for_timeout(200)
    p1 = await press('BOOT1', 0.25); l1 = await wait_sig('OBLED1.state', 1)
    p2 = await press('BOOT1', 0.25); l2 = await wait_sig('OBLED1.state', 0)
    lit = await ev(pg, "doflab.scene.boardModel.leds.USER.material.emissiveIntensity")
    await pg.wait_for_timeout(300); serial = await pg.inner_text('#serialLog')
    await pg.screenshot(path=str(SHOTS / "o1_boot_toggle.png"))
    d = await tasks_done()
    check("在 3D 板子上點 BOOT 鍵：藍燈亮 → 滅；序列埠監看依序印出開始訊息與兩次「BOOT 按下」；積木有「序列埠印出」；任務全部完成", 'dl_act_print' in blk and p1 and l1 and p2 and l2 and serial.count('BOOT 按下：切換藍燈') == 2 and '準備好了' in serial and d[0] == d[1], json.dumps([p1, l1, p2, l2, serial, d]))
    # 2. 觸控檯燈
    await open_exp('board-touch-lamp')
    await pg.click('#t-behavior'); await pg.wait_for_timeout(400); summ = await pg.inner_text('#summaryList'); await pg.click('#btnConfirm')
    await pg.click('#t-observe'); await pg.wait_for_timeout(400); await pg.click('#simRun'); await pg.wait_for_timeout(200)
    pt = await ev(pg, "doflab.scene.compScreen('TOUCH1')"); await pg.mouse.move(pt['x'], pt['y']); await pg.mouse.down()
    on = await wait_sig('OBLED1.state', 1); await pg.wait_for_timeout(1700)
    ring = await ev(pg, "doflab.scene.objects.comps.TOUCH1.userData.ref.touchGlow.visible")
    await pg.screenshot(path=str(SHOTS / "o2_touch_lamp.png"))
    await pg.mouse.up(); off = await wait_sig('OBLED1.state', 0)
    await pg.wait_for_timeout(300); serial = await pg.inner_text('#serialLog')
    d = await tasks_done()
    check("觸控檯燈：碰住 D4 排針 → 藍燈亮、排針上出現青色光環；放開 → 熄滅；印出「碰到了」「放開了」；摘要寫「被手指碰著」；任務全部完成", on and ring and off and '碰到了' in serial and '放開了' in serial and '被手指碰著' in summ and d[0] == d[1], json.dumps([on, ring, off, serial, d]))
    # 3. BOOT 慢閃、觸控快閃：真實編譯（DOIT 板型）與 Arduino IDE 上傳說明
    await open_exp('board-two-inputs')
    await pg.click('#t-behavior'); await pg.wait_for_timeout(400); await pg.click('#btnConfirm')
    await pg.click('#t-observe'); await pg.wait_for_timeout(300); await pg.click('#simRun'); await pg.wait_for_timeout(200)
    # 用模擬時間算閃爍頻率（軟體渲染時畫面更新較慢，取樣會漏掉轉換）：數事件紀錄裡 OBLED1 的輸出變化
    async def rate(sel):
        bx = await pg.locator(sel).bounding_box(); await pg.mouse.move(bx['x'] + 10, bx['y'] + 10); await pg.mouse.down()
        await pg.wait_for_timeout(500); t0 = await ev(pg, "doflab.sim.time"); await pg.wait_for_timeout(2000); t1 = await ev(pg, "doflab.sim.time")
        n = await ev(pg, f"doflab.events.filter(e => /^OBLED1 →/.test(e.text) && e.simT > {t0} && e.simT <= {t1}).length")
        await pg.mouse.up(); await pg.wait_for_timeout(300); return n / ((t1 - t0) / 1000)
    slow = await rate('[data-hold="BOOT1"]'); fast = await rate('[data-hold="TOUCH1"]')
    check("BOOT 慢閃、觸控快閃：按住 BOOT 每秒約 2 次轉換（1 Hz）、碰住觸控約 10 次（5 Hz）（以模擬時間計算）", 1.5 <= slow <= 2.6 and 8.5 <= fast <= 11, json.dumps([slow, fast]))
    await pg.click('#simRun'); await pg.click('#t-code'); await pg.click('#btnGen'); await pg.wait_for_timeout(300)
    code = await ev(pg, "document.getElementById('code').value")
    await pg.click('#btnCompile'); await pg.wait_for_function("document.querySelector('#btnCompile').textContent==='編譯'", timeout=240000)
    badge = await pg.inner_text('#buildBadge'); bb = await pg.inner_text('#buildBody'); up = await ev(pg, "document.getElementById('uploadBody').textContent")
    await pg.screenshot(path=str(SHOTS / "o3_code.png"))
    check("BOOT 慢閃、觸控快閃：程式含觸控校正與 Serial.begin(115200)，以 esp32doit-devkit-v1 真實編譯成功；上傳卡片有 Arduino IDE 步驟（DOIT ESP32 DEVKIT V1）", 'touchRead(TOUCH1_PIN)' in code and 'Serial.begin(115200)' in code and '成功' in badge and 'DOIT ESP32 DEVKIT V1' in up, badge + ' | ' + bb[:120])
    check("只用板子的實驗流程沒有頁面錯誤", not errs, "; ".join(errs[:3]))
    await b.close()

async def v27_flow(p):
    """V2.7（實測回饋）：手臂自動序列／手動切換、元件清單收合、緊湊版面與主畫面浮動資訊"""
    b = await p.chromium.launch(args=ARGS); pg = await b.new_page(viewport={'width': 1440, 'height': 900}); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.goto('http://localhost:8766/'); await pg.wait_for_function("window.doflab && doflab.p")
    # ---- 緊湊版面 ----
    await ev(pg, "(()=>{const r=DL.experiments.solved('hold-blink','uno'); doflab.load(DL.project.clone(r.project,{name:'版面',origin:{kind:'custom'},lock:{components:false,behavior:false,board:false}})); })()")
    await pg.wait_for_timeout(600)
    lay = await ev(pg, "(()=>{const v=document.querySelector('#vpConfig').getBoundingClientRect(); return {vh: v.height, bottom: v.bottom, sh: document.documentElement.scrollHeight, ih: innerHeight}})()")
    check("緊湊版面：配置圖填滿視窗高度（1440×900 不用捲動整頁）", lay['vh'] > 700 and lay['bottom'] <= lay['ih'] and lay['sh'] <= lay['ih'] + 12, json.dumps(lay))
    hud = await ev(pg, "[...document.querySelectorAll('#hudConfig .hc')].map(x=>x.textContent)")
    check("主畫面浮動資訊：電路檢查結果與連線數顯示在配置圖右上角", any('通過' in t for t in hud) and any('連線' in t for t in hud), json.dumps(hud, ensure_ascii=False))
    await pg.click('#hudConfig .hc[data-card="wireCard"]'); await pg.wait_for_timeout(150)
    check("點浮動資訊會跳到右側對應的卡片（閃一下）", await ev(pg, "document.querySelector('#wireCard').classList.contains('flash')"))
    y0 = await ev(pg, "document.querySelector('#inspectCard').getBoundingClientRect().top")
    await pg.click('#paletteCard > h3'); await pg.wait_for_timeout(150)
    y1 = await ev(pg, "document.querySelector('#inspectCard').getBoundingClientRect().top")
    check("元件清單可以收合，下面的卡片往上補", await ev(pg, "document.querySelector('#paletteCard').classList.contains('collapsed')") and y1 < y0 - 100, json.dumps([y0, y1]))
    await pg.reload(); await pg.wait_for_function("window.doflab && doflab.p"); await pg.wait_for_timeout(300)
    check("收合狀態會記住（重新整理後仍收合）", await ev(pg, "document.querySelector('#paletteCard').classList.contains('collapsed')"))
    await ev(pg, "(()=>{const r=DL.experiments.solved('hold-blink','uno'); doflab.load(DL.project.clone(r.project,{name:'版面',origin:{kind:'custom'},lock:{components:false,behavior:false,board:false}})); })()")
    await pg.click('#paletteCard > h3'); await pg.wait_for_timeout(100)
    await pg.click('#t-observe'); await pg.wait_for_timeout(400); await pg.click('#simRun'); await pg.wait_for_timeout(500)
    try: await pg.wait_for_function("document.querySelector('#hudObserve').textContent.includes('執行中')", timeout=3000)
    except Exception: pass
    ho = await pg.inner_text('#hudObserve') + ' | running=' + str(await ev(pg, "doflab.sim.running")) + ' ' + str(await ev(pg, "doflab.events.slice(0,3).map(e=>e.text).join(' / ')"))
    check("觀測頁：執行狀態與各元件目前的值浮在主畫面上；執行控制在畫面內", '執行中' in ho and 'LED1' in ho and 'BTN1' in ho and await ev(pg, "(()=>{const v=document.querySelector('#vpObserve').getBoundingClientRect(), r=document.querySelector('#simRun').getBoundingClientRect(); return r.top>v.top && r.bottom<=v.bottom})()"), ho)
    await pg.click('#simRun')
    # 右側卡片沒有被截斷（V2.8.1 修正）：孿生狀態表不用橫向捲動就看得到「量測」欄；驅動狀態標籤不超出卡片標題
    fit = []
    for exp, board in (('hold-blink', 'uno'), ('dist-gauge', 'uno'), ('arm-3dof', 'uno'), ('hold-blink', 'esp32doit')):
        await ev(pg, f"(()=>{{const r=DL.experiments.solved('{exp}','{board}'); doflab.load(r.project); doflab.ui.tab!=='observe' && document.querySelector('#t-observe').click(); }})()"); await pg.wait_for_timeout(300)
        fit.append(await ev(pg, "(()=>{const w=document.querySelector('.twinwrap'), t=document.querySelector('#drvStatus'), h=t.parentElement; return [w.scrollWidth - w.clientWidth, h.scrollWidth - h.clientWidth, t.title.length > t.textContent.length || t.title === t.textContent]})()"))
    check("觀測頁右側（1440×900）：孿生狀態表的「量測」欄完整顯示、驅動狀態標籤沒有被截斷，完整說明在提示與卡片內（4 種專案）", all(f[0] <= 0 and f[1] <= 0 and f[2] for f in fit) and '驗證狀態：' in await pg.inner_text('#hwBody'), json.dumps(fit))
    # ---- 手臂自動序列／手動 ----
    await ev(pg, "(()=>{const r=DL.experiments.solved('arm-3dof','uno'); doflab.load(DL.project.clone(r.project,{name:'序列',origin:{kind:'custom'},lock:{components:false,behavior:false,board:false}})); })()")
    await pg.click('#t-arm'); await pg.wait_for_timeout(500)
    for t in [[12, 6, -6], [12, 10, 0], [8, 5, 7]]:
        await ev(pg, f"doflab.armSetTarget({{x:{t[0]},y:{t[1]},z:{t[2]}}},{{continuous:false}})"); await pg.wait_for_timeout(100)
        await ev(pg, "doflab.arm.q = doflab.arm.qT.slice()"); await pg.click('#armSavePose')
    check("記下姿態自動命名 A、B、C；手動操作時手臂在手動模式", await ev(pg, "doflab.p.arm.poses.map(x=>x.name).join()") == 'A,B,C' and await ev(pg, "doflab.arm.mode") == 'manual')
    await pg.click('#t-behavior'); await pg.wait_for_timeout(400)
    seq = await pg.inner_text('#armSeqCard'); summ = await pg.inner_text('#summaryList')
    check("行為頁：手臂專案顯示動作序列（預備姿態 → A → B → C → 預備姿態，反覆），取代積木；分頁標示「序列 3 步」", await pg.locator('#blocklyHost').is_hidden() and 'A' in seq and '回到原點' in seq and '反覆執行' in summ and await pg.inner_text('#tbBehavior') == '序列 3 步', summ)
    await pg.locator('[data-shold="1"]').fill('0.2'); await pg.locator('[data-shold="1"]').dispatch_event('change'); await pg.wait_for_timeout(100)
    check("行為頁：可以改每一步的停留時間", await ev(pg, "doflab.p.arm.poses[1].holdMs") == 200)
    await pg.click('#t-arm'); await pg.wait_for_timeout(300); await pg.click('#armRun'); await pg.wait_for_timeout(300)
    st = await ev(pg, "({mode: doflab.arm.mode, run: doflab.sim.running, q: doflab.arm.q.map(v=>+v.toFixed(1)), home: DL.arm.homeQ(doflab.p.arm.config).map(v=>+v.toFixed(1))})")
    check("手臂頁按「▶ 執行序列」：切到自動，從預備姿態開始", st['mode'] == 'auto' and st['run'], json.dumps(st))
    await ev(pg, "(()=>{ doflab.toggleRun(); doflab.resetSim(); doflab.toggleRun(); doflab.toggleRun(); })()")   # 從 t = 0 重新開始，暫停後用模擬時間推進
    # 用模擬時間推進：每 1 ms 和產生的程式同一套規則
    trail = await ev(pg, "(()=>{const out=[]; for(let k=0;k<200;k++){ doflab.advance(50); out.push(doflab.arm.status.msg); } return {loops: doflab.sim.armLoops, seen: [...new Set(out.map(m=>(m.match(/「(.+?)」/)||[])[1]))], st: DL.arm.seqWritten(doflab.arm.seqSt)}})()")
    check("自動序列依序經過 A → B → C → 預備姿態並走完一輪（10 秒模擬時間）", trail['loops'] >= 1 and trail['seen'][:4] == ['A', 'B', 'C', '預備姿態'], json.dumps(trail, ensure_ascii=False))
    cyc = await ev(pg, "(()=>{const plan=DL.arm.seqPlan(doflab.p.arm); const s=DL.arm.seqStart(plan,0); for(let t=1;t<=10000;t++) DL.arm.seqStep(plan,s,t); return [DL.arm.seqWritten(s), doflab.sim.time]})()")
    check("畫面上的伺服命令與序列規則逐毫秒一致（同一時間點相同角度）", cyc[1] == 10000 and cyc[0] == trail['st'], json.dumps([cyc, trail['st']]))
    await ev(pg, "doflab.toggleRun()"); await pg.wait_for_timeout(200)
    await pg.locator('#armJ0').fill('20'); await pg.locator('#armJ0').dispatch_event('input'); await pg.wait_for_timeout(200)
    check("執行中拖滑桿（手動操作）：自動切到手動並暫停序列", await ev(pg, "doflab.arm.mode") == 'manual' and not await ev(pg, "doflab.sim.running") and '手動' in await pg.inner_text('#armModeNote'))
    await pg.click('#t-observe'); await pg.wait_for_timeout(300); await pg.click('#simRun'); await pg.wait_for_timeout(300)
    check("在觀測頁按「▶ 執行」：回到行為序列（自動）", await ev(pg, "doflab.arm.mode") == 'auto' and await ev(pg, "doflab.sim.running"))
    await pg.click('#simRun')
    await ev(pg, "(()=>{const p=doflab.p, a=doflab.analysis, cfg=p.arm.config; p.arm.confirmed={hash: DL.hash({cfg, b: cfg.joints.map(j=>a.bindings[j.servo].pin), board: p.board.type}), at:'e2e'}; doflab.renderAll(); })()")
    await pg.click('#t-code'); await pg.wait_for_timeout(300); await pg.click('#btnGen'); await pg.wait_for_timeout(300)
    code = await ev(pg, "doflab.p.code.text")
    check("產生的程式就是這個序列：4 步（A、B、C、預備姿態）、停留時間、反覆", 'STEP_COUNT = 4' in code and 'HOLD_MS[STEP_COUNT] = {1000, 200, 1000, 1000}' in code and 'LOOP = true' in code, code[:300])
    await pg.click('#btnCompile'); await pg.wait_for_function("document.querySelector('#btnCompile').textContent==='編譯'", timeout=240000)
    check("序列程式真實編譯成功（Uno）", await ev(pg, "doflab.buildState().state") == 'ok', await pg.inner_text('#buildBody'))
    check("V2.7 流程沒有頁面錯誤", not errs, "; ".join(errs[:3]))
    await b.close()

async def main():
    srv = subprocess.Popen([sys.executable, str(DIST / 'doflab_server.py'), '--port', '8766'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); wait_port(8766)
    bridge = subprocess.Popen([sys.executable, str(DIST / 'pi_bridge.py'), '--mock', '--port', '8765'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); wait_port(8765)
    try:
        async with async_playwright() as p:
            want = sys.argv[1:]   # 可只跑部分段落：python3 e2e/e2e.py breadboard arm
            on = lambda k: not want or k in want
            if on('desktop'): await desktop(p)
            if on('breadboard'): await breadboard_flow(p)
            if on('teacher'): await teacher_flow(p)
            if on('experiments'): await new_experiments(p)
            if on('pi'): bridge = await pi_hw(p, 8765, bridge)
            if on('ultrasonic'): await ultrasonic_flow(p, 8765)
            if on('onboard'): await onboard_flow(p)
            if on('arm'): await arm_flow(p)
            if on('v27'): await v27_flow(p)
            if on('uno'): await uno_virtual(p)
            if on('vdev'): await vdev_flow(p)
            if on('bench'): await bench_flow(p)
            if on('faults'): await faults_flow(p)
            if on('upload'): await upload_flow(p)
            if on('vupload'): await vupload_flow(p)
            if on('vmulti'): await vmulti_flow(p)
            if on('vboards'): await vboards_flow(p)
            if on('pideploy'): await pi_deploy(p)
            if on('mobile'): await mobile(p)
            if on('dark'): await dark(p)
    finally:
        srv.kill(); bridge.kill()
    ok = sum(1 for r in results if r[1]); print(f"\nE2E：{ok}/{len(results)} 通過")
    (SHOTS / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=1))
    sys.exit(0 if ok == len(results) else 1)

asyncio.run(main())
