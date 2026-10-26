"""虛擬樹莓派（pi_bridge.py --bench，雲端虛擬硬體第 6 階段）：工作台規格、標示虛擬、按鈕彈跳、超音波（距離層）、SG90 脈寬、不能部署。
這些都是「已在虛擬設備驗證，未以實體設備驗證」：GPIO 是 gpiozero 的模擬腳位，不是 BCM2711。"""
import asyncio, json, subprocess, sys, time, unittest, pathlib, socket
import aiohttp
TOOLS = pathlib.Path(__file__).resolve().parent.parent / "tools"
BENCHES = TOOLS / "vdev" / "benches"


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def start(bench):
    port = free_port()
    proc = subprocess.Popen([sys.executable, str(TOOLS / "pi_bridge.py"), "--bench", bench, "--port", str(port), "--host", "127.0.0.1"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    for _ in range(100):
        if proc.poll() is not None:
            return proc, None
        try:
            socket.create_connection(("127.0.0.1", port), 0.2).close(); return proc, port
        except OSError:
            time.sleep(0.1)
    return proc, None


def stop(proc):
    if proc.poll() is None:
        proc.terminate(); proc.wait(5)
    out = proc.stdout.read().decode(); proc.stdout.close(); return out


class PiBenchSpec(unittest.TestCase):
    def test_presets_and_errors(self):
        """每個樹莓派的工作台預設都能啟動；腳位超出 GPIO2–27、重複腳位、別的板型的規格都在啟動時明確拒絕"""
        names = sorted(p.stem for p in BENCHES.glob("*.json") if json.loads(p.read_text(encoding="utf-8")).get("board") == "pi4b")
        self.assertGreaterEqual(len(names), 3, names)
        for name in names:
            proc, port = start(name)
            try:
                if port is None: self.fail(f"{name} 沒有啟動：{stop(proc)}")
                st = asyncio.run(get(port, "/api/bench"))
                self.assertEqual(st["bench"]["id"], name); self.assertEqual(st["board"], "pi4b"); self.assertEqual(st["kind"], "virtual")
            finally:
                stop(proc)
        bad = [({"board": "pi4b", "parts": [{"id": "B", "type": "button", "pin": 30}]}, "GPIO2–GPIO27"),
               ({"board": "pi4b", "parts": [{"id": "A", "type": "button", "pin": 5}, {"id": "B", "type": "led", "pin": 5}]}, "同時接了"),
               ({"board": "pi4b", "parts": [{"id": "R", "type": "ldr", "pin": 5}]}, "不支援元件類型"),
               ({"board": "esp32", "parts": []}, "不是樹莓派")]
        for spec, msg in bad:
            proc, port = start(json.dumps(spec))
            proc.wait(5) if port is None else None
            out = stop(proc)
            self.assertIsNone(port, f"應該拒絕：{spec}"); self.assertIn(msg, out, spec)


async def get(port, path):
    async with aiohttp.ClientSession() as s:
        async with s.get(f"http://127.0.0.1:{port}{path}") as r:
            return await r.json()


async def post(port, path, body):
    async with aiohttp.ClientSession() as s:
        async with s.post(f"http://127.0.0.1:{port}{path}", json=body) as r:
            return r.status, await r.json()


class VirtualPi(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = json.loads((BENCHES / "pi-dist-gauge.json").read_text(encoding="utf-8"))
        spec["parts"].append({"id": "BTN1", "type": "button", "pin": 27, "bounceMs": 8})
        spec["parts"].append({"id": "LED1", "type": "led", "pin": 22})
        cls.proc, cls.port = start(json.dumps(spec))
        assert cls.port, stop(cls.proc)

    @classmethod
    def tearDownClass(cls): stop(cls.proc)

    def test_session(self):
        """識別標示虛擬、不能部署（說明原因）；按鈕彈跳傳到介面；超音波讀工作台的距離；伺服的脈寬（544–2400 µs，和 Uno／ESP32 相同）"""
        port = self.port
        async def go():
            async with aiohttp.ClientSession() as s:
                async with s.ws_connect(f"http://127.0.0.1:{port}/ws") as ws:
                    async def rx(op, pred=lambda m: True, n=200):
                        for _ in range(n):
                            m = await asyncio.wait_for(ws.receive_json(), 3)
                            if m["op"] == op and pred(m): return m
                        self.fail(f"沒有收到 {op}")
                    await ws.send_json({"op": "hello", "client": "test", "proto": 2})
                    h = await rx("hello")
                    self.assertTrue(h["virtual"]); self.assertEqual(h["kind"], "virtual"); self.assertIn("虛擬樹莓派", h["model"])
                    self.assertFalse(h["deploy"]); self.assertIn("虛擬樹莓派不支援部署", h["deployWhy"])
                    await ws.send_json({"op": "deploy", "id": "d1", "code": "print(1)\n", "pins": [], "confirm": True})
                    e = await rx("error"); self.assertIn("虛擬樹莓派不支援部署", e["message"])
                    # 按鈕：彈跳（1–3 次來回）會變成多筆 input；最後停在按下（0）
                    await ws.send_json({"op": "watch", "pins": [{"pin": 27, "pull": "up"}]})
                    first = await rx("input", lambda m: m["pin"] == 27); self.assertEqual(first["value"], 1, "上拉、沒按：讀到 1")
                    await post(port, "/api/bench", {"part": "BTN1", "action": "press"})
                    vals = []
                    try:
                        while True:
                            m = await asyncio.wait_for(ws.receive_json(), 0.5)
                            if m["op"] == "input" and m["pin"] == 27: vals.append(m["value"])
                    except asyncio.TimeoutError:
                        pass
                    self.assertTrue(vals and vals[-1] == 0, vals)
                    st = await get(port, "/api/bench"); b = next(p for p in st["bench"]["parts"] if p["id"] == "BTN1")
                    self.assertTrue(b["pressed"]); self.assertEqual(b["level"], "low"); self.assertGreaterEqual(b["edges"], 3)
                    # 超音波：距離層的模型
                    await ws.send_json({"op": "sonar", "sensors": [{"trig": 5, "echo": 6}]})
                    await rx("distance", lambda m: m["cm"] == 100)
                    await post(port, "/api/bench", {"part": "US1", "action": "set", "cm": 30})
                    await rx("distance", lambda m: m["cm"] == 30)
                    await post(port, "/api/bench", {"part": "US1", "action": "set", "cm": None})
                    await rx("distance", lambda m: m["cm"] == 400)
                    # 伺服：授權後寫 90° → ACK；工作台量到的脈寬是 1472 µs（544 + 90 × 1856 / 180，和 Uno／ESP32 相同）
                    await ws.send_json({"op": "authorize", "outputs": [{"pin": 18, "kind": "servo"}]}); await rx("authorized")
                    for a, us in ((90, 1472), (0, 544), (180, 2400)):
                        await ws.send_json({"op": "servo", "id": f"s{a}", "pin": 18, "angle": a})
                        await rx("ack", lambda m: m["id"] == f"s{a}")
                        for _ in range(50):
                            sv = next(p for p in (await get(port, "/api/bench"))["bench"]["parts"] if p["id"] == "SERVO1")
                            if sv["pulseUs"] is not None and abs(sv["pulseUs"] - us) <= 2: break
                            await asyncio.sleep(0.02)
                        self.assertLessEqual(abs(sv["pulseUs"] - us), 2, sv)
                    tr = await get(port, "/api/trace")
                    self.assertTrue(any(e.get("part") == "SERVO1" and "us" in e for e in tr["trace"]))
                    st = await get(port, "/api/bench"); self.assertGreaterEqual(st["traffic"]["writeCount"], 3)
        asyncio.run(go())

    def test_guard(self):
        """斷線保護：有輸出時，每秒 ping 一次就一直維持；3 秒沒有任何訊息 → pi_bridge 關掉輸出並送出 guard（連線本身還在）"""
        port = self.port
        async def go():
            async with aiohttp.ClientSession() as s:
                async with s.ws_connect(f"http://127.0.0.1:{port}/ws") as ws:
                    async def rx(op, n=400, t=6):
                        for _ in range(n):
                            m = await asyncio.wait_for(ws.receive_json(), t)
                            if m["op"] == op: return m
                    await ws.send_json({"op": "hello", "client": "test", "proto": 2}); await rx("hello")
                    await ws.send_json({"op": "authorize", "outputs": [{"pin": 18, "kind": "servo"}]}); await rx("authorized")
                    await ws.send_json({"op": "servo", "id": "g1", "pin": 18, "angle": 120}); await rx("ack")
                    for _ in range(5):   # 有 ping：不會觸發
                        await asyncio.sleep(0.9); await ws.send_json({"op": "ping", "t": 0})
                    sv = next(p for p in (await get(port, "/api/bench"))["bench"]["parts"] if p["id"] == "SERVO1")
                    self.assertTrue(sv["powered"], sv)
                    t0 = time.monotonic()
                    g = await rx("guard", t=6)   # 不再送任何訊息
                    dt = time.monotonic() - t0
                    self.assertIn("斷線保護", g["message"]); self.assertTrue(2.5 <= dt <= 4.5, dt)
                    await asyncio.sleep(0.2)
                    sv = next(p for p in (await get(port, "/api/bench"))["bench"]["parts"] if p["id"] == "SERVO1")
                    self.assertFalse(sv["powered"], f"伺服不再收到脈衝：{sv}")
                    self.assertLessEqual(abs(sv["angle"] - 120), 1.5, f"停在原地，沒有轉到 0°：{sv}")
                    await ws.send_json({"op": "servo", "id": "g2", "pin": 18, "angle": 30})
                    e = await rx("error")
                    self.assertIn("沒有授權", e["message"], f"授權已經撤銷，命令不會執行：{e}")
        asyncio.run(go())

    def test_pwm(self):
        """PWM（V2.14 的訊號測試）：授權成 pwm、寫工作週期 0–255、回讀 ACK；工作台量到工作週期與 1 kHz；同一個腳位改回數位輸出；不是 pwm 的腳位拒絕 pwm 命令"""
        port = self.port
        async def go():
            async with aiohttp.ClientSession() as s:
                async def led():
                    return next(p for p in (await get(port, "/api/bench"))["bench"]["parts"] if p["id"] == "LED1")
                async with s.ws_connect(f"http://127.0.0.1:{port}/ws") as ws:
                    async def rx(op, n=400):
                        for _ in range(n):
                            m = await asyncio.wait_for(ws.receive_json(), 6)
                            if m["op"] == op: return m
                    await ws.send_json({"op": "hello", "client": "test", "proto": 2}); h = await rx("hello")
                    self.assertTrue(h.get("pwm"), "hello 回報支援 PWM")
                    await ws.send_json({"op": "authorize", "outputs": [{"pin": 22, "kind": "pwm"}]}); await rx("authorized")
                    for v in (64, 191, 255, 0):
                        await ws.send_json({"op": "pwm", "id": f"p{v}", "pin": 22, "value": v}); a = await rx("ack")
                        self.assertEqual((a["kind"], a["value"]), ("pwm", v), a)
                        for _ in range(50):
                            l = await led()
                            if l["duty"] is not None and abs(l["duty"] - v / 255) < 0.01: break
                            await asyncio.sleep(0.02)
                        self.assertTrue(l["duty"] is not None and abs(l["duty"] - v / 255) < 0.01 and l["pwmHz"] == 1000, l)
                        self.assertEqual(l["on"], v > 0, l)
                    await ws.send_json({"op": "pwm", "id": "p300", "pin": 22, "value": 300}); a = await rx("ack"); self.assertEqual(a["value"], 255, "超過 255 限制為 255")
                    await ws.send_json({"op": "authorize", "outputs": [{"pin": 22, "kind": "digital"}]}); await rx("authorized")
                    await ws.send_json({"op": "write", "id": "d1", "pin": 22, "value": 1}); a = await rx("ack"); self.assertEqual((a["kind"], a["value"]), ("digital", 1))
                    for _ in range(50):
                        l = await led()
                        if l["duty"] is None and l["on"]: break
                        await asyncio.sleep(0.02)
                    self.assertTrue(l["duty"] is None and l["on"], f"改回數位輸出：{l}")
                    await ws.send_json({"op": "pwm", "id": "p2", "pin": 22, "value": 10}); e = await rx("error"); self.assertIn("不是 PWM 輸出", e["message"])
        asyncio.run(go())

    def test_bad_bench_action(self):
        """工作台操作錯誤回 400（不是讓 pi_bridge 當掉）"""
        code, r = asyncio.run(post(self.port, "/api/bench", {"part": "NOPE", "action": "press"}))
        self.assertEqual(code, 400); self.assertIn("NOPE", r["error"])


if __name__ == "__main__":
    unittest.main()
