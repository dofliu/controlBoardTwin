"""doflab_server.py 編譯服務：呼叫真正的 arduino-cli（Uno）與 py_compile（Pi）。
ESP32 需要 esp32:esp32 core，本環境無法安裝，因此只確認服務會如實回報失敗而不是假裝成功。"""
import json, os, subprocess, sys, time, unittest, pathlib, socket, urllib.request
ROOT = pathlib.Path(__file__).resolve().parent.parent

def post(port, board, code):
    req = urllib.request.Request(f"http://127.0.0.1:{port}/api/compile", data=json.dumps({"board": board, "code": code}).encode(), headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=300).read())

def gen(exp, board):
    js = f"const {{DL,solved}}=require('{ROOT}/tests/helpers.js');process.stdout.write(DL.codegen.generate(solved('{exp}','{board}')).code)"
    return subprocess.check_output(["node", "-e", js]).decode()

class Compile(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        s = socket.socket(); s.bind(("127.0.0.1", 0)); cls.port = s.getsockname()[1]; s.close()
        cls.proc = subprocess.Popen([sys.executable, str(ROOT / "tools" / "doflab_server.py"), "--port", str(cls.port)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(50):
            try: socket.create_connection(("127.0.0.1", cls.port), 0.2).close(); break
            except OSError: time.sleep(0.1)
    @classmethod
    def tearDownClass(cls): cls.proc.terminate(); cls.proc.wait(5)

    def test_uno_generated_sketches_compile(self):
        for exp in ["hold-blink", "servo-cmd", "night-light", "toggle-led", "ped-light", "bright-alarm", "sun-shade", "bb-two-toggles", "dist-alarm", "smart-bin", "parking-gate", "dist-gauge", "parking-radar"]:
            r = post(self.port, "uno", gen(exp, "uno"))
            self.assertTrue(r["ok"], exp + "\n" + r["raw"][-1500:])
            self.assertEqual(r["toolchain"]["fqbn"], "arduino:avr:uno"); self.assertTrue(r["size"]["bytes"] > 0)

    def test_uno_error_has_line_numbers(self):
        code = gen("hold-blink", "uno").replace("digitalWrite(LED1_PIN, led1 ? HIGH : LOW);", "digitalWrit(LED1_PIN, led1 ? HIGH : LOW);")
        line = next(i + 1 for i, l in enumerate(code.split("\n")) if "digitalWrit(" in l)
        r = post(self.port, "uno", code)
        self.assertFalse(r["ok"]); self.assertNotEqual(r["exitCode"], 0)
        self.assertTrue(any(d["line"] == line and d["severity"] == "error" for d in r["diagnostics"]), r["diagnostics"])
        self.assertIn("digitalWrit", r["raw"])

    def test_pi_py_compile(self):
        for exp in ["hold-blink", "servo-cmd", "toggle-led", "ped-light", "bb-two-toggles", "dist-alarm", "smart-bin", "parking-gate", "dist-gauge", "parking-radar"]:
            r = post(self.port, "pi4b", gen(exp, "pi4b")); self.assertTrue(r["ok"], exp + " " + r["raw"])
        r = post(self.port, "pi4b", "def main(:\n    pass\n"); self.assertFalse(r["ok"]); self.assertEqual(r["diagnostics"][0]["line"], 1)

    def test_esp32_generated_sketches_compile(self):
        """有 esp32:esp32 core 時必須真的編譯成功；沒有時要如實回報失敗，不能假裝成功。"""
        r = post(self.port, "esp32", gen("hold-blink", "esp32"))
        if not r["ok"] and ("not found" in r["raw"] or "not installed" in r["raw"]):
            self.assertNotEqual(r["exitCode"], 0); self.skipTest("這台機器沒有 ESP32 core（已確認服務如實回報失敗）")
        for exp in ["hold-blink", "servo-cmd", "night-light", "toggle-led", "ped-light", "bright-alarm", "sun-shade", "bb-two-toggles", "dist-alarm", "smart-bin", "parking-gate", "dist-gauge", "parking-radar"]:
            r = post(self.port, "esp32", gen(exp, "esp32"))
            self.assertTrue(r["ok"], exp + "\n" + r["raw"][-1500:]); self.assertEqual(r["toolchain"]["fqbn"], "esp32:esp32:esp32")

    def test_esp32doit_board_only_experiments_compile(self):
        """ESP32 DevKit V1（esp32:esp32:esp32doit-devkit-v1）：只用板子的三個實驗（板載 LED、BOOT、觸控、Serial）與一般實驗都要真的編譯成功"""
        r = post(self.port, "esp32doit", gen("board-boot-toggle", "esp32doit"))
        if not r["ok"] and ("not found" in r["raw"] or "not installed" in r["raw"]):
            self.skipTest("這台機器沒有 ESP32 core")
        for exp in ["board-boot-toggle", "board-touch-lamp", "board-two-inputs", "hold-blink", "dist-gauge"]:
            r = post(self.port, "esp32doit", gen(exp, "esp32doit"))
            self.assertTrue(r["ok"], exp + "\n" + r["raw"][-1500:]); self.assertEqual(r["toolchain"]["fqbn"], "esp32:esp32:esp32doit-devkit-v1")

    def test_esp32_error_has_line_numbers(self):
        code = gen("hold-blink", "esp32").replace("pinMode(BTN1_PIN, INPUT_PULLUP);", "pinMode(BTN1_PIN, INPUT_PULLUPX);")
        r = post(self.port, "esp32", code)
        if "not found" in r["raw"] or "not installed" in r["raw"]: self.skipTest("沒有 ESP32 core")
        line = next(i + 1 for i, l in enumerate(code.split("\n")) if "INPUT_PULLUPX" in l)
        self.assertFalse(r["ok"]); self.assertTrue(any(d["line"] == line for d in r["diagnostics"]), r["diagnostics"])

if __name__ == "__main__":
    unittest.main()
