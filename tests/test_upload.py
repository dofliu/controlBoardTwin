"""上傳燒錄（編譯服務端）：
- /api/compile 回傳可上傳的檔案（Uno 的 .hex；ESP32 的四個 .bin 與燒錄位址）
- /api/upload 必須 confirm:true；連接埠名稱檢查
- 端到端：arduino-cli upload → 真正的 avrdude → pty → 虛擬 Uno（avr8js 執行 Arduino 官方 Optiboot）
  上傳完成後，新程式在虛擬晶片上執行：按住 D2 時 D13 閃爍。
限制：pty 沒有 DTR 訊號，測試工具在「閒置後第一個位元組」模擬一次外部重置；實體 Uno 由 USB 晶片的 DTR 觸發。
ESP32 沒有可用的模擬器，只驗證檔案與位址，不驗證實際燒錄。"""
import base64, json, os, pathlib, shutil, socket, subprocess, sys, tempfile, time, unittest, urllib.request, urllib.error
ROOT = pathlib.Path(__file__).resolve().parent.parent

def call(port, path, body=None):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body).encode() if body is not None else None, headers={"Content-Type": "application/json"})
    try: return json.loads(urllib.request.urlopen(req, timeout=400).read())
    except urllib.error.HTTPError as e: return json.loads(e.read())

def gen(exp, board):
    js = f"const {{DL,solved}}=require('{ROOT}/tests/helpers.js');process.stdout.write(DL.codegen.generate(solved('{exp}','{board}')).code)"
    return subprocess.check_output(["node", "-e", js]).decode()

HAVE = all(shutil.which(x) for x in ["arduino-cli", "avrdude", "socat", "node"])

class Upload(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        s = socket.socket(); s.bind(("127.0.0.1", 0)); cls.port = s.getsockname()[1]; s.close()
        env = dict(os.environ)
        # 測試環境的 avrdude 由系統套件提供：用一個資料夾把它排成 arduino-cli 預期的 bin/ 與 etc/ 結構
        cls.tools = pathlib.Path(tempfile.mkdtemp(prefix="dl-avrdude-"))
        if shutil.which("avrdude"):
            (cls.tools / "bin").mkdir(); (cls.tools / "etc").mkdir()
            os.symlink(shutil.which("avrdude"), cls.tools / "bin" / "avrdude")
            for conf in ["/etc/avrdude.conf", "/usr/etc/avrdude.conf"]:
                if os.path.exists(conf): os.symlink(conf, cls.tools / "etc" / "avrdude.conf"); break
        env["DOFLAB_ARDUINO_UPLOAD_PROPS"] = f"runtime.tools.avrdude.path={cls.tools}"
        cls.proc = subprocess.Popen([sys.executable, str(ROOT / "tools" / "doflab_server.py"), "--port", str(cls.port)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
        for _ in range(50):
            try: socket.create_connection(("127.0.0.1", cls.port), 0.2).close(); break
            except OSError: time.sleep(0.1)
    @classmethod
    def tearDownClass(cls): cls.proc.terminate(); cls.proc.wait(5); shutil.rmtree(cls.tools, ignore_errors=True)

    @unittest.skipUnless(shutil.which("arduino-cli"), "沒有 arduino-cli")
    def test_compile_returns_uno_hex(self):
        r = call(self.port, "/api/compile", {"board": "uno", "code": gen("hold-blink", "uno")})
        self.assertTrue(r["ok"], r["raw"][-800:])
        a = r["artifacts"]; self.assertEqual(a["kind"], "hex")
        lines = [l for l in a["hex"].splitlines() if l]
        self.assertTrue(lines[0].startswith(":") and lines[-1] == ":00000001FF")

    @unittest.skipUnless(shutil.which("arduino-cli"), "沒有 arduino-cli")
    def test_compile_returns_esp32_images(self):
        r = call(self.port, "/api/compile", {"board": "esp32", "code": gen("hold-blink", "esp32")})
        if not r["ok"] and "esp32" in r["raw"] and "not found" in r["raw"].lower(): self.skipTest("沒有 esp32 core")
        self.assertTrue(r["ok"], r["raw"][-800:])
        files = r["artifacts"]["files"]
        self.assertEqual([f["offset"] for f in files], [0x1000, 0x8000, 0xE000, 0x10000])
        boot = base64.b64decode(files[0]["b64"]); app = base64.b64decode(files[3]["b64"])
        self.assertEqual(boot[0], 0xE9); self.assertEqual(app[0], 0xE9)    # ESP 映像檔的魔術位元組
        self.assertEqual(len(base64.b64decode(files[1]["b64"])), 3072)

    def test_upload_requires_confirm_and_valid_port(self):
        r = call(self.port, "/api/upload", {"board": "uno", "code": "void setup(){}void loop(){}", "port": "/dev/ttyACM0"})
        self.assertFalse(r["ok"]); self.assertEqual(r.get("stage"), "confirm")
        r = call(self.port, "/api/upload", {"board": "pi4b", "code": "x=1", "port": "/dev/ttyACM0", "confirm": True})
        self.assertFalse(r["ok"]); self.assertIn("pi_bridge", r["raw"])
        if shutil.which("arduino-cli"):
            r = call(self.port, "/api/upload", {"board": "uno", "code": "void setup(){}void loop(){}", "port": "; rm -rf /", "confirm": True})
            self.assertFalse(r["ok"]); self.assertEqual(r.get("stage"), "port")

    def test_ports_endpoint(self):
        r = call(self.port, "/api/ports")
        self.assertIn("ports", r); self.assertIsInstance(r["ports"], list)

    @unittest.skipUnless(HAVE, "需要 arduino-cli、avrdude、socat、node")
    def test_upload_to_virtual_uno_through_avrdude(self):
        d = tempfile.mkdtemp(prefix="dl-pty-"); a, b = f"{d}/ttyA", f"{d}/ttyB"
        socat = subprocess.Popen(["socat", f"pty,raw,echo=0,link={a}", f"pty,raw,echo=0,link={b}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for _ in range(50):
                if os.path.exists(a) and os.path.exists(b): break
                time.sleep(0.1)
            uno = subprocess.Popen(["node", str(ROOT / "tests" / "avr" / "pty_uno.js"), b], stdout=subprocess.PIPE, stderr=open(f"{d}/uno.err", "w"), env=dict(os.environ, PTY_DEBUG="1"))
            time.sleep(0.8)
            r = call(self.port, "/api/upload", {"board": "uno", "code": gen("hold-blink", "uno"), "port": a, "confirm": True})
            self.assertTrue(r["ok"], r["raw"][-1500:])
            self.assertEqual(r["stage"], "upload")
            try: out, err = uno.communicate(timeout=60)
            except subprocess.TimeoutExpired: uno.kill(); self.fail("虛擬 Uno 沒有回報結果：" + open(f"{d}/uno.err").read()[-1500:])
            res = json.loads(out.decode().strip().splitlines()[-1])
            self.assertTrue(res["ok"], res)
            self.assertGreaterEqual(res["pagesWritten"], 5)
            self.assertEqual(res["blink"], [False, True], "上傳後的新程式：按住 D2 時 D13 閃爍")
            self.assertTrue(res["offAfterRelease"])
        finally:
            socat.terminate(); shutil.rmtree(d, ignore_errors=True)

if __name__ == "__main__":
    unittest.main()
