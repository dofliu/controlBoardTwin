"""
DofLab 虛擬樹莓派的工作台（雲端虛擬硬體第 6 階段）

pi_bridge.py --bench 時載入：真正的 pi_bridge 程式（和接實體樹莓派時同一份）跑在 gpiozero 的模擬腳位上，
這裡是腳位「外面的世界」：按鈕（有彈跳）、LED、SG90、超音波、三軸手臂。和 tools/vdev/bench.js（虛擬 Uno 的工作台）
用同一套教學假設與同樣的狀態格式，所以工作台頁與測試可以共用；刻意不用 DofLab 的模擬程式。

和虛擬 Uno 不同的地方（要標示清楚）：
  * 虛擬 Uno 跑真的韌體機器碼；虛擬樹莓派跑的是真的 pi_bridge.py，但 GPIO 是 gpiozero 的模擬腳位（不是 BCM2711）。
  * 超音波是「距離層」的模型：pi_bridge 在模擬腳位上本來就不量回波時序，直接讀工作台給的距離（實體樹莓派用 gpiozero 的 DistanceSensor）。
  * SG90 由模擬腳位的 PWM（頻率與工作週期）算出脈寬，再用和 bench.js 相同的 SG90 假設（544 µs = 0°、2400 µs = 180°）換成角度。
"""
import json
import math
import pathlib
import random
import time

SERVO_MIN_US, SERVO_MAX_US = 544, 2400       # 與 tools/vdev/bench.js 相同的 SG90 教學假設
VCC, LED_VF = 3.3, 2.0                        # 樹莓派的 GPIO 是 3.3 V
TYPES = ("button", "led", "ultrasonic", "servo", "arm")
PRESET_DIR = pathlib.Path(__file__).resolve().parent / "benches"
BCM_PINS = range(2, 28)                       # 40 針排針上的 GPIO2–GPIO27


def load_spec(x):
    """名稱（benches/ 裡的預設）、檔案路徑、JSON 文字或物件 → 規格"""
    if isinstance(x, dict):
        return json.loads(json.dumps(x))
    s = str(x)
    if s.lstrip().startswith("{"):
        return json.loads(s)
    p = pathlib.Path(s) if ("/" in s or s.endswith(".json")) else PRESET_DIR / (s + ".json")
    if not p.exists():
        raise ValueError(f"找不到工作台「{s}」")
    return json.loads(p.read_text(encoding="utf-8"))


class PiBench:
    def __init__(self, hub, spec):
        self.hub = hub
        self.spec = load_spec(spec)
        if self.spec.get("board", "pi4b") != "pi4b":
            raise ValueError(f"工作台「{self.spec.get('id')}」是 {self.spec.get('board')} 用的，不是樹莓派")
        self.rand = random.Random(self.spec.get("seed", 1))
        self.factory = hub.Device.pin_factory
        self.t0 = time.monotonic()
        self.parts, self.log, self.trace = {}, [], []
        self.writes = 0                        # pi_bridge 實際執行的寫入命令數（設備端的紀錄）
        used = {}
        for p in self.spec["parts"]:
            if p["type"] not in TYPES:
                raise ValueError(f"虛擬樹莓派的工作台不支援元件類型 {p['type']}（{p['id']}）")
            pins = [p["trig"], p["echo"]] if p["type"] == "ultrasonic" else [] if p["type"] == "arm" else [p["pin"]]
            for n in pins:
                if n not in BCM_PINS:
                    raise ValueError(f"{p['id']} 的腳位 GPIO{n} 不在 GPIO2–GPIO27")
                if n in used:
                    raise ValueError(f"GPIO{n} 同時接了 {used[n]} 與 {p['id']}")
                used[n] = p["id"]
            self.parts[p["id"]] = dict(p)
        for p in self.parts.values():
            self.init(p)
        for p in self.parts.values():
            if p["type"] == "arm":
                for j in p["joints"]:
                    if self.parts.get(j["servo"], {}).get("type") != "servo":
                        raise ValueError(f"{p['id']} 的關節用到 {j['servo']}，但工作台上沒有這顆伺服")
        self.task = None

    # ---------- 時間與紀錄 ----------
    def now_ms(self):
        return (time.monotonic() - self.t0) * 1000

    def note(self, part, action, **extra):
        e = dict({"devMs": round(self.now_ms(), 1), "part": part, "action": action}, **extra)
        self.log.append(e); self.log = self.log[-100:]
        self.rec(e)

    def rec(self, e):
        self.trace.append(e); self.trace = self.trace[-20000:]

    def pin(self, n):
        return self.factory.pin(n)

    # ---------- 元件 ----------
    def init(self, p):
        t = p["type"]
        if t == "button":
            p.update(bounceMs=p.get("bounceMs", 8), pressed=False, level=True, edges=0, gen=0, unplugged=False)
            self.pin(p["pin"]).drive_high()          # 放開：上拉成高電位
        elif t == "led":
            p.update(ohm=p.get("ohm", 220), on=False, toggles=0, lastChangeMs=None, unplugged=False)
        elif t == "ultrasonic":
            p.update(cm=p.get("cm", 100), unplugged=False, stuck=False, reads=0)
            self.apply_cm(p)
        elif t == "servo":
            p.update(speed=p.get("speed", 600), cmd=None, angle=p.get("start"), pulseUs=None, lastPulseMs=None, lastMoveMs=None, pulses=0, unplugged=False, traceUs=None)
        elif t == "arm":
            p.update(H=p.get("H", 7), L1=p.get("L1", 8), L2=p.get("L2", 8))

    def apply_cm(self, p):
        # 拔線或卡住：pi_bridge 讀到的是「沒有回波」（400 cm）；cm 為 None：前方沒有物體
        cm = 400 if (p["unplugged"] or p["stuck"] or p["cm"] is None) else int(p["cm"])
        self.hub.mock_cm[p["trig"]] = cm

    def press(self, p, down):
        if p["pressed"] == down:
            return
        p["pressed"] = down
        if p["unplugged"]:
            self.note(p["id"], "press" if down else "release", unplugged=True); return
        p["gen"] += 1; gen = p["gen"]; target = not down
        n = 1 + self.rand.randrange(3) if p["bounceMs"] > 0 else 0      # 1–3 次來回
        times = sorted(self.rand.random() * p["bounceMs"] for _ in range(n * 2))
        loop = self.hub.loop

        def set_level(lv):
            if gen != p["gen"] or p["level"] == lv or p["unplugged"]:
                return
            p["level"] = lv; p["edges"] += 1
            pin = self.pin(p["pin"])
            pin.drive_high() if lv else pin.drive_low()

        set_level(target)
        for i, t in enumerate(times):
            loop.call_later(t / 1000, set_level, (not target) if i % 2 == 0 else target)
        loop.call_later((p["bounceMs"] + 0.01) / 1000, set_level, target)
        self.note(p["id"], "press" if down else "release", bounces=n)

    def act(self, q):
        p = self.parts.get(q.get("part"))
        if not p:
            raise ValueError(f"工作台上沒有元件 {q.get('part')}")
        a = q.get("action")
        if p["type"] == "button" and a in ("press", "release"):
            self.press(p, a == "press")
        elif p["type"] == "ultrasonic" and a == "set":
            cm = q.get("cm")
            p["cm"] = None if cm is None else max(2, min(400, int(cm)))
            self.apply_cm(p); self.note(p["id"], "set", cm=p["cm"])
        elif p["type"] == "ultrasonic" and a in ("stuck", "unstuck"):
            p["stuck"] = a == "stuck"; self.apply_cm(p); self.note(p["id"], a)
        elif p["type"] != "arm" and a in ("unplug", "plug"):
            p["unplugged"] = a == "unplug"
            if p["type"] == "button":
                p["gen"] += 1
                pin = self.pin(p["pin"])
                # 拔線：按鈕腳只剩內部上拉（高電位）；接回：照按住與否
                pin.drive_high() if (p["unplugged"] or not p["pressed"]) else pin.drive_low()
                p["level"] = p["unplugged"] or not p["pressed"]
            elif p["type"] == "ultrasonic":
                self.apply_cm(p)
            self.note(p["id"], a)
        else:
            raise ValueError(f"{p['id']}（{p['type']}）不能做「{a}」")
        return self.part_state(p)

    # gpiozero 的模擬腳位在設定上拉時會把電位拉回上拉的電位；實體按鈕按住時腳位仍是低電位，所以這裡把工作台的電位再加回去
    def reassert(self, n=None):
        for p in self.parts.values():
            if p["type"] == "button" and (n is None or p["pin"] == n):
                lv = True if p["unplugged"] else p["level"]
                pin = self.pin(p["pin"])
                if bool(pin.state) != lv:
                    pin.drive_high() if lv else pin.drive_low()

    # ---------- 讀腳位（每 5 ms） ----------
    def sense(self):
        now = self.now_ms()
        self.reassert()
        for p in self.parts.values():
            if p["type"] == "led":
                pin = self.pin(p["pin"])
                on = (not p["unplugged"]) and pin.function == "output" and pin.frequency is None and float(pin.state or 0) > 0.5
                if on != p["on"]:
                    p["on"] = on; p["toggles"] += 1; p["lastChangeMs"] = now
                    self.rec({"devMs": round(now, 3), "part": p["id"], "on": on})
            elif p["type"] == "servo":
                pin = self.pin(p["pin"])
                f = pin.frequency
                duty = float(pin.state or 0) if f else 0
                if p["unplugged"] or not f or duty <= 0:
                    continue                              # 沒有脈衝：SG90 停在原地
                us = duty / f * 1e6
                if not (400 <= us <= 2600):
                    continue
                self.move_servo(p)
                if p["traceUs"] is None or abs(us - p["traceUs"]) >= 4:
                    p["traceUs"] = us
                    self.rec({"devMs": round(now, 3), "part": p["id"], "us": round(us)})
                p["pulseUs"] = round(us); p["pulses"] += 1; p["lastPulseMs"] = now; p["lastMoveMs"] = now
                p["cmd"] = max(0.0, min(180.0, (us - SERVO_MIN_US) / (SERVO_MAX_US - SERVO_MIN_US) * 180))
                if p["angle"] is None:
                    p["angle"] = p["cmd"]

    def move_servo(self, p):
        if p["cmd"] is None or p["angle"] is None or p["lastMoveMs"] is None:
            return
        until = min(self.now_ms(), p["lastPulseMs"] + 60)
        dt = until - p["lastMoveMs"]
        if dt > 0:
            step = p["speed"] * dt / 1000; d = p["cmd"] - p["angle"]
            p["angle"] = p["cmd"] if abs(d) <= step else p["angle"] + math.copysign(step, d)
            p["lastMoveMs"] = until

    def powered(self, p):
        return p["lastPulseMs"] is not None and self.now_ms() - p["lastPulseMs"] < 60

    async def run(self):
        import asyncio
        while True:
            try:
                self.sense()
            except Exception as e:      # 工作台出錯不能讓閘道停掉
                print("工作台錯誤：", e)
            await asyncio.sleep(0.005)

    def start(self):
        import asyncio
        self.task = asyncio.ensure_future(self.run())

    # ---------- 狀態（格式與 tools/vdev/device.js 的 state() 相同，工作台頁共用） ----------
    def part_state(self, p):
        r1 = lambda x: None if x is None else round(x, 1)
        t = p["type"]
        if t == "button":
            return {"id": p["id"], "type": t, "pin": p["pin"], "pressed": p["pressed"], "level": "high" if p["level"] else "low", "edges": p["edges"], "bounceMs": p["bounceMs"], "unplugged": p["unplugged"]}
        if t == "led":
            mA = round((VCC - LED_VF) / p["ohm"] * 1000, 1) if p["on"] else 0
            return {"id": p["id"], "type": t, "pin": p["pin"], "ohm": p["ohm"], "on": p["on"], "mA": mA, "overCurrent": mA > 20, "toggles": p["toggles"], "lastChangeMs": p["lastChangeMs"], "unplugged": p["unplugged"]}
        if t == "ultrasonic":
            return {"id": p["id"], "type": t, "trig": p["trig"], "echo": p["echo"], "cm": p["cm"], "drop": 0, "pulses": None, "echoes": None, "dropped": 0, "unplugged": p["unplugged"], "stuck": p["stuck"], "model": "distance"}
        if t == "servo":
            self.move_servo(p)
            moving = p["cmd"] is not None and p["angle"] is not None and abs(p["cmd"] - p["angle"]) > 0.5 and self.powered(p)
            return {"id": p["id"], "type": t, "pin": p["pin"], "pulseUs": p["pulseUs"], "cmd": r1(p["cmd"]), "angle": r1(p["angle"]), "moving": moving, "powered": self.powered(p), "pulses": p["pulses"], "speed": p["speed"], "unplugged": p["unplugged"]}
        # 手臂：三顆伺服的實際角度 → 關節角 → 位置（和 bench.js 相同的換算）
        sv = [self.parts[j["servo"]] for j in p["joints"]]
        for s in sv:
            self.move_servo(s)
        q = [None if s["angle"] is None else (s["angle"] - j["zero"]) / j["dir"] for s, j in zip(sv, p["joints"])]
        cmd = [None if s["cmd"] is None else (s["cmd"] - j["zero"]) / j["dir"] for s, j in zip(sv, p["joints"])]
        pos = None
        if all(a is not None for a in q):
            q1, q2, q3 = (math.radians(a) for a in q)
            er, ey = p["L1"] * math.cos(q2), p["H"] + p["L1"] * math.sin(q2)
            tr, ty = er + p["L2"] * math.cos(q2 - q3), ey + p["L2"] * math.sin(q2 - q3)
            pos = {"yaw": q[0], "elbow": {"r": er, "y": ey}, "tip": {"r": tr, "y": ty, "x": tr * math.cos(q1), "z": -tr * math.sin(q1)}}
        return {"id": p["id"], "type": "arm", "H": p["H"], "L1": p["L1"], "L2": p["L2"],
                "joints": [{"servo": j["servo"], "name": j.get("name"), "q": None if a is None else round(a, 1), "cmd": None if c is None else round(c, 1)} for j, a, c in zip(p["joints"], q, cmd)], "pos": pos}

    def state(self, linked=0):
        pins = {}
        for n in BCM_PINS:
            pin = self.pin(n)
            pins[n] = "servo" if pin.frequency else (("high" if float(pin.state or 0) > 0.5 else "low") if pin.function == "output" else "input")
        return {"id": self.spec.get("device", "pi-1"), "kind": "virtual", "board": "pi4b",
                "firmware": {"name": "pi_bridge（模擬腳位）", "model": "gpio-mock"},
                "devMs": round(self.now_ms()), "realtime": 1, "linked": linked > 0, "links": linked, "resets": 0,
                "pins": pins,
                "bench": {"id": self.spec.get("id"), "name": self.spec.get("name"), "note": self.spec.get("note"), "parts": [self.part_state(p) for p in self.parts.values()], "log": self.log[-20:]},
                "traffic": {"writeCount": self.writes}}
