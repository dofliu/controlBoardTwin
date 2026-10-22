"""pi_bridge.py v2（--mock）：唯讀、授權、去重、撤銷、斷線釋放；部署程式（語法檢查、確認、腳位保留、輸出轉送、停止）。"""
import asyncio, json, subprocess, sys, time, unittest, pathlib, socket, tempfile, shutil
import aiohttp
TOOLS = pathlib.Path(__file__).resolve().parent.parent / "tools"

def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p

class Bridge(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = free_port()
        cls.deploy = tempfile.mkdtemp(prefix="dl-deploy-")
        cls.proc = subprocess.Popen([sys.executable, str(TOOLS / "pi_bridge.py"), "--mock", "--port", str(cls.port), "--host", "127.0.0.1", "--deploy-dir", cls.deploy], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        for _ in range(50):
            try: socket.create_connection(("127.0.0.1", cls.port), 0.2).close(); break
            except OSError: time.sleep(0.1)
    @classmethod
    def tearDownClass(cls): cls.proc.terminate(); cls.proc.wait(5); shutil.rmtree(cls.deploy, ignore_errors=True)

    def run_async(self, coro): return asyncio.run(coro)

    def test_protocol(self):
        async def go():
            async with aiohttp.ClientSession() as s:
                async with s.ws_connect(f"http://127.0.0.1:{self.port}/ws") as ws:
                    async def rx(op=None):
                        while True:
                            m = await asyncio.wait_for(ws.receive_json(), 3)
                            if op is None or m["op"] == op: return m
                    await ws.send_json({"op": "hello", "client": "test", "proto": 2})
                    h = await rx("hello"); self.assertEqual(h["proto"], 2); self.assertTrue(h["mock"])
                    # 唯讀：寫入被拒絕
                    await ws.send_json({"op": "write", "id": "c1-1", "pin": 17, "value": 1})
                    e = await rx("error"); self.assertIn("沒有授權", e["message"])
                    # 讀取輸入與序號
                    await ws.send_json({"op": "watch", "pins": [{"pin": 27, "pull": "up"}]})
                    i0 = await rx("input"); self.assertEqual(i0["value"], 1)
                    await ws.send_json({"op": "mock_level", "pin": 27, "value": 0})
                    i1 = await rx("input"); self.assertEqual(i1["value"], 0); self.assertGreater(i1["seq"], i0["seq"])
                    # 不能把輸入腳授權成輸出
                    await ws.send_json({"op": "authorize", "outputs": [{"pin": 27, "kind": "digital"}]})
                    e = await rx("error"); self.assertIn("正在當輸入", e["message"])
                    # 授權後寫入 → ACK（回讀值）
                    await ws.send_json({"op": "authorize", "outputs": [{"pin": 17, "kind": "digital"}, {"pin": 18, "kind": "servo"}]})
                    a = await rx("authorized"); self.assertEqual(len(a["outputs"]), 2)
                    await ws.send_json({"op": "write", "id": "c1-2", "pin": 17, "value": 1})
                    k = await rx("ack"); self.assertEqual((k["id"], k["value"]), ("c1-2", 1))
                    await ws.send_json({"op": "servo", "id": "c1-3", "pin": 18, "angle": 150})
                    k = await rx("ack"); self.assertAlmostEqual(k["value"], 150, delta=1)
                    # 去重：同一個 id 不再執行
                    await ws.send_json({"op": "write", "id": "c1-2", "pin": 17, "value": 0})
                    k = await rx("ack"); self.assertTrue(k.get("dup")); self.assertEqual(k["value"], 1)
                    await ws.send_json({"op": "write", "id": "c1-4", "pin": 17, "value": 0})
                    k = await rx("ack"); self.assertEqual(k["value"], 0)
                    # 撤銷後拒絕寫入
                    await ws.send_json({"op": "revoke"})
                    await ws.send_json({"op": "write", "id": "c1-5", "pin": 17, "value": 1})
                    e = await rx("error"); self.assertIn("沒有授權", e["message"])
                # 斷線後腳位被釋放：新連線可以重新授權同一腳位，且從唯讀開始
                async with s.ws_connect(f"http://127.0.0.1:{self.port}/ws") as ws2:
                    await ws2.send_json({"op": "write", "id": "c2-1", "pin": 17, "value": 1})
                    m = await asyncio.wait_for(ws2.receive_json(), 3); self.assertEqual(m["op"], "error")
                    await ws2.send_json({"op": "authorize", "outputs": [{"pin": 17, "kind": "digital"}]})
                    m = await asyncio.wait_for(ws2.receive_json(), 3); self.assertEqual(m["op"], "authorized")
        self.run_async(go())

    def test_deploy(self):
        root = pathlib.Path(__file__).resolve().parent.parent
        js = f"const {{DL,solved}}=require('{root}/tests/helpers.js');process.stdout.write(DL.codegen.generate(solved('hold-blink','pi4b')).code)"
        code = subprocess.check_output(["node", "-e", js]).decode()
        async def go():
            async with aiohttp.ClientSession() as s:
                async with s.ws_connect(f"http://127.0.0.1:{self.port}/ws") as ws:
                    async def rx(op, t=8):
                        while True:
                            m = await asyncio.wait_for(ws.receive_json(), t)
                            if m["op"] == op or (m["op"] == "error" and op != "proc"): return m
                    await ws.send_json({"op": "hello", "client": "test", "proto": 2})
                    h = await rx("hello"); self.assertTrue(h["deploy"]); self.assertIsNone(h["running"])
                    # 沒有確認：拒絕
                    await ws.send_json({"op": "deploy", "id": "d0", "code": code, "pins": [17, 27]})
                    e = await rx("deployed"); self.assertEqual(e["op"], "error"); self.assertIn("確認", e["message"])
                    # 語法錯誤：拒絕，不寫入 main.py
                    await ws.send_json({"op": "deploy", "id": "d1", "code": "def broken(:\n", "pins": [], "confirm": True})
                    e = await rx("deployed"); self.assertEqual(e["op"], "error"); self.assertIn("語法錯誤", e["message"])
                    self.assertFalse((pathlib.Path(self.deploy) / "main.py").exists())
                    # 正確部署：寫入、啟動、轉送輸出
                    await ws.send_json({"op": "deploy", "id": "d2", "code": code, "pins": [17, 27], "confirm": True})
                    d = await rx("deployed"); self.assertEqual(d["op"], "deployed", d); self.assertGreater(d["pid"], 0)
                    self.assertEqual((pathlib.Path(self.deploy) / "main.py").read_text(encoding="utf-8"), code)
                    line = await rx("proc"); self.assertIn("開始執行", line["line"])
                    # 執行中：程式用到的腳位不能被連線讀寫；不能同時部署第二個
                    await ws.send_json({"op": "watch", "pins": [{"pin": 27, "pull": "up"}]})
                    e = await rx("error"); self.assertIn("部署的程式", e["message"])
                    await ws.send_json({"op": "deploy", "id": "d3", "code": code, "pins": [17, 27], "confirm": True})
                    e = await rx("deployed"); self.assertEqual(e["op"], "error"); self.assertIn("已經有一個", e["message"])
                # 斷線後程式繼續執行；新連線看得到並可以停止
                async with s.ws_connect(f"http://127.0.0.1:{self.port}/ws") as ws2:
                    await ws2.send_json({"op": "hello", "client": "test", "proto": 2})
                    h = await asyncio.wait_for(ws2.receive_json(), 3); self.assertIsNotNone(h["running"]); self.assertEqual(h["running"]["pins"], [17, 27])
                    await ws2.send_json({"op": "stop"})
                    while True:
                        m = await asyncio.wait_for(ws2.receive_json(), 6)
                        if m["op"] == "proc_exit": break
                    self.assertEqual(m["reason"], "stopped")
                    await ws2.send_json({"op": "watch", "pins": [{"pin": 27, "pull": "up"}]})
                    m = await asyncio.wait_for(ws2.receive_json(), 3); self.assertEqual(m["op"], "input", "停止後腳位釋放")
        self.run_async(go())

if __name__ == "__main__":
    unittest.main()
