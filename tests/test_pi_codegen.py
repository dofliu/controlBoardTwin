"""產生的 Raspberry Pi 程式：在 gpiozero MockFactory 與虛擬時鐘上執行，逐輪和模擬引擎比較。
驗證的是程式邏輯；不代表實體樹莓派的時序（Linux 排程會讓迴圈間隔變長）。"""
import json, subprocess, sys, time, types, pathlib, unittest
HERE = pathlib.Path(__file__).parent

class Stop(Exception): pass

class PiCodegen(unittest.TestCase):
    def test_hold_blink_matches_engine(self):
        data = json.loads(subprocess.check_output(["node", str(HERE / "pi_equiv.js")]))
        from gpiozero import Device
        from gpiozero.pins.mock import MockFactory
        Device.pin_factory = MockFactory()
        clock = {"ms": 0}
        btn = Device.pin_factory.pin(27); led = Device.pin_factory.pin(17)
        held = lambda t: any(a <= t < b for a, b in data["press"])
        got = []
        fake = types.ModuleType("time")
        fake.monotonic = lambda: clock["ms"] / 1000.0
        def sleep(s):
            got.append([clock["ms"], 1 if led.state else 0])
            clock["ms"] += round(s * 1000)
            if clock["ms"] > 3000: raise Stop()
            (btn.drive_low if held(clock["ms"]) else btn.drive_high)()
        fake.sleep = sleep
        btn.drive_high()
        ns = {"__name__": "doflab_main"}
        sys.modules["time"], real = fake, sys.modules["time"]
        try:
            exec(compile(data["code"], "main.py", "exec"), ns)
            with self.assertRaises(Stop): ns["main"]()
        finally:
            sys.modules["time"] = real
        exp = {t: v for t, v in data["exp"]}
        self.assertGreater(len(got), 500)
        for t, v in got:
            self.assertEqual(v, exp[t], f"t={t} ms：Python={v} 引擎={exp[t]}")
        # 文件範例：1 Hz、放開即滅、再按從亮開始
        g = dict((t, v) for t, v in got)
        self.assertEqual(g[120], 1); self.assertEqual(g[620], 0); self.assertEqual(g[1120], 1); self.assertEqual(g[1320], 0); self.assertEqual(g[1720], 1)

    def run_generic(self, exp, press, outs, T):
        """新實驗：在 MockFactory 上執行產生的 Python，逐輪和引擎比較多個輸出"""
        data = json.loads(subprocess.check_output(["node", str(HERE / "pi_equiv.js"), json.dumps({"exp": exp, "press": press, "outs": outs, "T": T})]))
        from gpiozero import Device
        from gpiozero.pins.mock import MockFactory
        Device.pin_factory = MockFactory()
        clock = {"ms": 0}
        btns = {k: Device.pin_factory.pin(data["pins"][k]) for k in press}
        leds = [Device.pin_factory.pin(data["pins"][k]) for k in outs]
        held = lambda k, t: any(a <= t < b for a, b in press[k])
        got = []
        fake = types.ModuleType("time"); fake.monotonic = lambda: clock["ms"] / 1000.0
        def sleep(s):
            got.append([clock["ms"], [1 if x.state else 0 for x in leds]])
            clock["ms"] += round(s * 1000)
            if clock["ms"] > T: raise Stop()
            for k, pin in btns.items(): (pin.drive_low if held(k, clock["ms"]) else pin.drive_high)()
        fake.sleep = sleep
        for pin in btns.values(): pin.drive_high()
        ns = {"__name__": "doflab_main"}
        sys.modules["time"], real = fake, sys.modules["time"]
        try:
            exec(compile(data["code"], "main.py", "exec"), ns)
            with self.assertRaises(Stop): ns["main"]()
        finally:
            sys.modules["time"] = real
        exp_map = {t: v for t, v in data["exp"]}
        self.assertGreater(len(got), T // 10)
        for t, v in got:
            self.assertEqual(v, exp_map[t], f"{exp} t={t} ms：Python={v} 引擎={exp_map[t]}")
        return dict((t, v) for t, v in got)

    def test_new_experiments_match_engine(self):
        g = self.run_generic("toggle-led", {"BTN1": [[100, 300], [600, 800], [1000, 2000]]}, ["LED1"], 2400)
        self.assertEqual(g[200], [1]); self.assertEqual(g[700], [0]); self.assertEqual(g[1500], [1]); self.assertEqual(g[2300], [1])
        g = self.run_generic("ped-light", {"BTN1": [[200, 700]]}, ["LED1", "LED2"], 1200)
        self.assertEqual(g[100], [0, 1]); self.assertEqual(g[400], [1, 0]); self.assertEqual(g[900], [0, 1])
        g = self.run_generic("bb-two-toggles", {"BTN1": [[100, 250], [900, 1050]], "BTN2": [[500, 650]]}, ["LED1", "LED2"], 1400)
        self.assertEqual(g[200], [1, 0]); self.assertEqual(g[600], [1, 1]); self.assertEqual(g[1100], [0, 1])

    def test_ultrasonic_experiments_match_engine(self):
        """超音波實驗：用假的 DistanceSensor（回傳指定距離）取代 gpiozero 的量測，其餘照產生的程式執行，逐輪和引擎比較。
        驗證的是「每 60 ms 讀一次、用上一次結果」的程式邏輯；不代表實體 HC-SR04P 的量測誤差。"""
        import gpiozero
        from gpiozero import Device
        from gpiozero.pins.mock import MockFactory, MockPWMPin
        cases = [
            ("dist-alarm", {"US1": [[0, 120], [300, 12], [900, None], [1300, 19]]}, ["LED1"]),
            ("parking-radar", {"US1": [[0, 120], [205, 35], [700, 9], [1200, 60]]}, ["LED1", "LED2"]),
            ("parking-gate", {"US1": [[0, 80], [300, 6], [800, 30]]}, ["SERVO1", "LED1"]),
            ("dist-gauge", {"US1": [[0, 100], [200, 27], [500, 5], [800, 49], [1100, None]]}, ["SERVO1"]),
        ]
        for exp, dist, outs in cases:
            T = 1600
            data = json.loads(subprocess.check_output(["node", str(HERE / "pi_equiv.js"), json.dumps({"exp": exp, "dist": dist, "outs": outs, "T": T})]))
            Device.pin_factory = MockFactory(pin_class=MockPWMPin)
            clock = {"ms": 0}; made = []
            def cm_at(t):
                cm = 400
                for x, v in dist["US1"]:
                    if t >= x: cm = 400 if v is None else v
                return cm
            class FakeDistance:
                def __init__(self, echo, trigger, max_distance=1, queue_len=9):
                    self.echo, self.trigger, self.max = echo, trigger, max_distance; made.append(self)
                @property
                def distance(self):
                    return min(self.max, (cm_at(clock["ms"]) + 0.5) / 100)   # 0.5 cm：落在整數公分中間，避免浮點捨入
            led_pins = {k: Device.pin_factory.pin(data["pins"][k]) for k in outs}
            got = []
            def val(k):
                pin = led_pins[k]
                if k.startswith("SERVO"):
                    # 由 PWM 脈寬換回角度（0.5–2.4 ms 對應 0–180°）
                    w = pin.state * 20.0 if pin.frequency else None
                    return None if w is None else round((w - 0.5) * 180 / 1.9)
                return 1 if pin.state else 0
            fake = types.ModuleType("time"); fake.monotonic = lambda: clock["ms"] / 1000.0
            def sleep(s):
                got.append([clock["ms"], [val(k) for k in outs]])
                clock["ms"] += round(s * 1000)
                if clock["ms"] > T: raise Stop()
            fake.sleep = sleep
            ns = {"__name__": "doflab_main"}
            sys.modules["time"], real = fake, sys.modules["time"]
            real_ds = gpiozero.DistanceSensor; gpiozero.DistanceSensor = FakeDistance
            try:
                exec(compile(data["code"], "main.py", "exec"), ns)
                with self.assertRaises(Stop): ns["main"]()
            finally:
                sys.modules["time"] = real; gpiozero.DistanceSensor = real_ds
            self.assertEqual((made[0].echo, made[0].trigger), (data["pins"]["US1.ECHO"], data["pins"]["US1"]))
            exp_map = {t: v for t, v in data["exp"]}
            self.assertGreater(len(got), T // 10)
            for t, v in got:
                self.assertEqual(v, exp_map[t], f"{exp} t={t} ms：Python={v} 引擎={exp_map[t]}")
            g = dict((t, v) for t, v in got)
            if exp == "dist-alarm": self.assertEqual(g[200], [0]); self.assertEqual(g[500], [1]); self.assertEqual(g[1200], [0])
            if exp == "parking-gate": self.assertEqual(g[500], [90, 1]); self.assertEqual(g[1100], [0, 0])
            if exp == "dist-gauge": self.assertEqual(g[400], [92]); self.assertEqual(g[700], [180]); self.assertEqual(g[1500], [4])


if __name__ == "__main__":
    unittest.main()
