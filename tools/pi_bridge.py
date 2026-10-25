#!/usr/bin/env python3
"""
DofLab — Raspberry Pi GPIO 閘道（協定 v2）

在樹莓派上執行：
  http://<樹莓派IP>:8765/      提供 index.html（從這裡開，可避開 https 頁面不能連 ws:// 的限制）
  ws://<樹莓派IP>:8765/ws      DofLab 透過 WebSocket 讀取輸入、在授權後寫入輸出

安全規則（伺服器端強制，不只靠網頁）：
  * 連線一開始是唯讀：只能 watch（設定輸入＋上拉並回報），write/servo 一律拒絕
  * authorize 列出的腳位才能寫；revoke 或斷線時所有輸出關閉並釋放
  * 每個命令有 id；重複 id 只回覆先前的 ack，不再執行（去重）
  * 不保存、也不重播斷線前的命令

訊息（JSON）：
  → {"op":"hello","client":"doflab","proto":2}
  ← {"op":"hello","proto":2,"board":"pi4b","model":"...","host":"...","mock":false}
  → {"op":"watch","pins":[{"pin":27,"pull":"up"}]}
  ← {"op":"input","pin":27,"value":0|1,"seq":12,"t":1729...}     value 為實際電位（上拉時按下 = 0）
  → {"op":"authorize","outputs":[{"pin":17,"kind":"digital"},{"pin":18,"kind":"servo"}]}
  ← {"op":"authorized","outputs":[...]}
  → {"op":"write","id":"c1-5","pin":17,"value":1}    ← {"op":"ack","id":"c1-5","pin":17,"value":1,"kind":"digital"}
  → {"op":"servo","id":"c1-6","pin":18,"angle":90}   ← {"op":"ack","id":"c1-6","pin":18,"value":90,"kind":"servo"}
  → {"op":"revoke"}      → {"op":"ping","t":...}  ← {"op":"pong","t":...}
  → {"op":"sonar","sensors":[{"trig":5,"echo":6}]}   超音波（唯讀）：每 100 ms 回報一次距離
  ← {"op":"distance","trig":5,"cm":37,"seq":13,"t":...}   cm 為整數；沒有回波或超出 4 m 時為 400
     TRIG 是量距離必須的觸發輸出，只能接到超音波模組；ECHO 必須是 3.3 V（HC-SR04P 類或加分壓）

部署（把 DofLab 產生的 Python 程式放到樹莓派上執行，相當於 Arduino 的「上傳」）：
  → {"op":"deploy","id":"d1","code":"...","pins":[17,27],"confirm":true}
  ← {"op":"deployed","id":"d1","path":".../main.py","pid":1234,"bytes":2048}
  ← {"op":"proc","stream":"out"|"err","line":"..."}        程式的輸出，逐行轉送
  ← {"op":"proc_exit","code":0,"reason":"stopped"|"exited"}
  → {"op":"stop"}        → {"op":"status"}  ← {"op":"status","running":{...}|null}
  規則：必須 confirm:true；先用 py_compile 檢查語法；部署前釋放這個連線自己的腳位；
        程式用到的腳位在它執行期間不能被任何連線讀寫；一次只執行一個部署的程式；閘道結束時一併停止。

安裝：sudo apt install python3-aiohttp python3-gpiozero python3-lgpio
執行：python3 pi_bridge.py            （真的控制 GPIO）
      python3 pi_bridge.py --mock     （任何電腦都能跑，用 gpiozero 模擬腳位；只供測試）
      python3 pi_bridge.py --bench pi-hold-blink   （虛擬樹莓派：模擬腳位＋工作台 tools/vdev/pi_bench.py；
                                                    通常由虛擬設備主機 tools/vdev/server.js --pi 啟動，不必自己執行）
"""
import argparse
import asyncio
import json
import os
import pathlib
import py_compile
import signal
import socket
import sys
import tempfile
import time
from collections import OrderedDict

from aiohttp import web, WSMsgType

HERE = pathlib.Path(__file__).resolve().parent
PROTO = 2
DEPLOY_NO_BENCH = "虛擬樹莓派不支援部署：部署的程式會在另一個程序執行，接不到工作台的模擬腳位。請用「觀測」頁的同步，或在實體樹莓派上部署。"


def board_model(mock):
    if mock:
        return "MockFactory（模擬腳位）"
    try:
        return pathlib.Path("/proc/device-tree/model").read_text().strip("\x00\n ")
    except OSError:
        return "未知（讀不到 /proc/device-tree/model）"


class Session:
    """一個網頁連線＝一個 session；session 結束時釋放它建立的所有裝置。"""

    def __init__(self, hub, ws):
        self.hub, self.ws = hub, ws
        self.inputs = {}       # pin -> DigitalInputDevice
        self.outputs = {}      # pin -> (kind, device)
        self.acks = OrderedDict()
        self.seq = 0
        self.sonars = {}       # trig -> (echo, DistanceSensor 或 None（模擬）)
        self.sonar_task = None

    async def send(self, obj):
        if not self.ws.closed:
            await self.ws.send_str(json.dumps(obj))

    def push_input(self, pin):
        dev = self.inputs.get(pin)
        if not dev:
            return
        self.seq += 1
        level = 0 if dev.is_active else 1       # pull_up=True 時 active = 低電位
        msg = {"op": "input", "pin": pin, "value": level, "seq": self.seq, "t": int(time.time() * 1000)}
        asyncio.ensure_future(self.send(msg))

    def watch(self, pins):
        for item in pins:
            pin = int(item["pin"])
            if pin in self.outputs:
                raise ValueError(f"GPIO{pin} 已授權為輸出，不能同時當輸入")
            if pin in self.sonar_pins():
                raise ValueError(f"GPIO{pin} 正在給超音波模組使用")
            if pin in self.inputs:
                self.push_input(pin)
                continue
            self.hub.claim(pin, self)
            dev = self.hub.In(pin, pull_up=item.get("pull", "up") == "up", bounce_time=None)
            dev.when_activated = lambda p=pin: self.hub.loop.call_soon_threadsafe(self.push_input, p)
            dev.when_deactivated = lambda p=pin: self.hub.loop.call_soon_threadsafe(self.push_input, p)
            self.inputs[pin] = dev
            if self.hub.bench:
                self.hub.bench.reassert(pin)         # 虛擬樹莓派：工作台上的按鈕若正按著，腳位仍是低電位
            self.push_input(pin)

    def sonar_pins(self):
        return {p for trig, (echo, dev) in self.sonars.items() for p in (trig, echo)}

    def sonar(self, sensors):
        """超音波：建立 DistanceSensor（模擬腳位時改用 hub.mock_cm 的值），之後每 100 ms 回報一次"""
        for item in sensors:
            trig, echo = int(item["trig"]), int(item["echo"])
            if trig == echo:
                raise ValueError("TRIG 與 ECHO 不能是同一個腳位")
            if trig in self.sonars:
                continue
            for pin in (trig, echo):
                if pin in self.outputs or pin in self.inputs or pin in self.sonar_pins():
                    raise ValueError(f"GPIO{pin} 已經被其他用途使用")
            self.hub.claim(trig, self); self.hub.claim(echo, self)
            dev = None if self.hub.mock else self.hub.Distance(echo=echo, trigger=trig, max_distance=4, queue_len=3)
            self.sonars[trig] = (echo, dev)
        if self.sonars and not self.sonar_task:
            self.sonar_task = asyncio.ensure_future(self._sonar_loop())

    def read_cm(self, trig):
        echo, dev = self.sonars[trig]
        if dev is None:
            return int(self.hub.mock_cm.get(trig, 100))
        d = dev.distance
        cm = 400 if d is None else int(d * 100)
        return 400 if cm >= 400 else cm

    async def _sonar_loop(self):
        while self.sonars and not self.ws.closed:
            for trig in list(self.sonars):
                self.seq += 1
                await self.send({"op": "distance", "trig": trig, "cm": self.read_cm(trig), "seq": self.seq, "t": int(time.time() * 1000)})
            await asyncio.sleep(0.1)

    def authorize(self, outputs):
        granted = []
        for o in outputs:
            pin, kind = int(o["pin"]), o.get("kind", "digital")
            if pin in self.inputs:
                raise ValueError(f"GPIO{pin} 正在當輸入，不能授權為輸出")
            if pin in self.sonar_pins():
                raise ValueError(f"GPIO{pin} 正在給超音波模組使用，不能授權為輸出")
            if pin in self.outputs:
                granted.append({"pin": pin, "kind": self.outputs[pin][0]})
                continue
            self.hub.claim(pin, self)
            if kind == "servo":
                dev = self.hub.Servo(pin, min_angle=0, max_angle=180, min_pulse_width=0.000544, max_pulse_width=0.0024, initial_angle=None)   # 544–2400 µs：和 Uno／ESP32 的 Servo 函式庫相同（V2.13 統一）
            else:
                dev = self.hub.Out(pin, initial_value=False)
            self.outputs[pin] = (kind, dev)
            granted.append({"pin": pin, "kind": kind})
        return granted

    def command(self, m):
        cid = str(m.get("id", ""))
        if not cid:
            raise ValueError("命令缺少 id")
        if cid in self.acks:                      # 去重：同一個 id 只執行一次
            return dict(self.acks[cid], dup=True)
        pin = int(m["pin"])
        if pin not in self.outputs:
            raise PermissionError(f"GPIO{pin} 沒有授權寫入（目前為唯讀）")
        kind, dev = self.outputs[pin]
        if m["op"] == "servo":
            if kind != "servo":
                raise ValueError(f"GPIO{pin} 不是伺服輸出")
            angle = max(0, min(180, float(m["angle"])))
            dev.angle = angle
            value = dev.angle                       # 回讀命令值（不是實測角度）
        else:
            if kind != "digital":
                raise ValueError(f"GPIO{pin} 不是數位輸出")
            dev.value = 1 if int(m["value"]) else 0
            value = int(dev.value)                  # 回讀輸出暫存值（不證明 LED 真的亮）
        ack = {"op": "ack", "id": cid, "pin": pin, "value": value, "kind": kind}
        if self.hub.bench:
            self.hub.bench.writes += 1                # 虛擬樹莓派：設備端的寫入紀錄（給工作台頁與測試）
        self.acks[cid] = ack
        while len(self.acks) > 256:
            self.acks.popitem(last=False)
        return ack

    def revoke(self):
        for pin, (kind, dev) in list(self.outputs.items()):
            try:
                if kind == "digital":
                    dev.off()
                else:
                    dev.detach()
                dev.close()
            finally:
                self.hub.release(pin, self)
        self.outputs.clear()

    def close(self):
        self.revoke()
        if self.sonar_task:
            self.sonar_task.cancel(); self.sonar_task = None
        for trig, (echo, dev) in list(self.sonars.items()):
            if dev is not None:
                dev.close()
            self.hub.release(trig, self); self.hub.release(echo, self)
        self.sonars.clear()
        for pin, dev in list(self.inputs.items()):
            dev.close()
            self.hub.release(pin, self)
        self.inputs.clear()


class Deployed:
    """部署中的程式：一個子行程，輸出逐行轉送給部署它的連線"""
    def __init__(self, proc, path, pins, session):
        self.proc, self.path, self.pins, self.session = proc, path, pins, session
        self.started = time.time(); self.stopping = False

    def info(self):
        return {"pid": self.proc.pid, "path": str(self.path), "pins": self.pins, "since": int(self.started * 1000)}


class Hub:
    def __init__(self, loop, mock, deploy_dir=None, bench=None):
        from gpiozero import Device, DigitalInputDevice, DigitalOutputDevice, AngularServo, DistanceSensor
        if mock:
            from gpiozero.pins.mock import MockFactory, MockPWMPin
            Device.pin_factory = MockFactory(pin_class=MockPWMPin)
        self.Device, self.In, self.Out, self.Servo, self.Distance = Device, DigitalInputDevice, DigitalOutputDevice, AngularServo, DistanceSensor
        self.mock_cm = {}      # 模擬腳位時的超音波距離（測試用，trig -> cm）
        self.loop, self.mock = loop, mock
        self.owner = {}
        self.deploy_dir = pathlib.Path(deploy_dir or (pathlib.Path.home() / "doflab-deploy"))
        self.running = None
        self.sessions = 0
        self.bench = None
        if bench is not None:                  # 虛擬樹莓派：模擬腳位外面接工作台（tools/vdev/pi_bench.py）
            sys.path.insert(0, str(HERE / "vdev"))
            from pi_bench import PiBench
            self.bench = PiBench(self, bench)

    async def deploy(self, session, code, pins):
        if self.bench:
            raise RuntimeError(DEPLOY_NO_BENCH)
        if self.running:
            raise RuntimeError("已經有一個部署的程式在執行，請先停止它")
        pins = [int(p) for p in pins or []]
        busy = [p for p in pins if self.owner.get(p) not in (None, session)]
        if busy:
            raise RuntimeError("GPIO" + "、GPIO".join(map(str, busy)) + " 正被另一個連線使用，不能部署")
        # 語法檢查：不通過就不覆蓋原本的 main.py
        with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8") as f:
            f.write(code); tmp = f.name
        try:
            py_compile.compile(tmp, doraise=True)
        except py_compile.PyCompileError as e:
            raise ValueError("語法錯誤，沒有部署：" + str(e.msg).replace(tmp, "main.py"))
        finally:
            os.unlink(tmp)
        session.close()                       # 程式要使用 GPIO：先放掉這個連線自己的腳位
        self.deploy_dir.mkdir(parents=True, exist_ok=True)
        path = self.deploy_dir / "main.py"
        path.write_text(code, encoding="utf-8")
        env = dict(os.environ, PYTHONUNBUFFERED="1")
        if self.mock:
            env["GPIOZERO_PIN_FACTORY"] = "mock"
        proc = await asyncio.create_subprocess_exec(sys.executable, "-u", str(path), cwd=str(self.deploy_dir), env=env,
                                                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, start_new_session=True)
        d = self.running = Deployed(proc, path, pins, session)
        for p in pins:
            self.owner[p] = d
        for stream, name in ((proc.stdout, "out"), (proc.stderr, "err")):
            asyncio.ensure_future(self._pump(d, stream, name))
        asyncio.ensure_future(self._wait(d))
        return {"path": str(path), "pid": proc.pid, "bytes": len(code.encode("utf-8"))}

    async def _pump(self, d, stream, name):
        while True:
            line = await stream.readline()
            if not line:
                break
            if d.session:
                await d.session.send({"op": "proc", "stream": name, "line": line.decode("utf-8", "replace").rstrip("\n")[:500]})

    async def _wait(self, d):
        code = await d.proc.wait()
        for p in d.pins:
            if self.owner.get(p) is d:
                del self.owner[p]
        if self.running is d:
            self.running = None
        if d.session:
            await d.session.send({"op": "proc_exit", "code": code, "reason": "stopped" if d.stopping else "exited"})

    async def stop(self):
        d = self.running
        if not d:
            return False
        d.stopping = True
        try:
            os.killpg(d.proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            await asyncio.wait_for(d.proc.wait(), 3)
        except asyncio.TimeoutError:
            os.killpg(d.proc.pid, signal.SIGKILL)
            await d.proc.wait()
        await asyncio.sleep(0)
        return True

    def claim(self, pin, session):
        if isinstance(self.owner.get(pin), Deployed):
            raise RuntimeError(f"GPIO{pin} 正被部署的程式使用；請先停止程式")
        if self.owner.get(pin) not in (None, session):
            raise RuntimeError(f"GPIO{pin} 正被另一個連線使用")
        self.owner[pin] = session

    def release(self, pin, session):
        if self.owner.get(pin) is session:
            del self.owner[pin]


async def index(request):
    page = HERE / "index.html"
    if not page.exists():
        return web.Response(text="找不到 index.html，請把它放在 pi_bridge.py 同一個資料夾。", status=404)
    return web.FileResponse(page)


async def ws_handler(request):
    hub: Hub = request.app["hub"]
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)
    s = Session(hub, ws)
    hub.sessions += 1
    print(f"[連線] {request.remote}")
    try:
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            m = {}
            try:
                m = json.loads(msg.data)
                op = m.get("op")
                if op == "hello":
                    h = {"op": "hello", "proto": PROTO, "board": "pi4b", "model": board_model(hub.mock), "host": socket.gethostname(), "mock": hub.mock, "deploy": True, "running": hub.running.info() if hub.running else None}
                    if hub.bench:   # 虛擬樹莓派：明確標示，介面據此顯示「虛擬設備」
                        h.update(virtual=True, kind="virtual", model="虛擬樹莓派（pi_bridge＋gpiozero 模擬腳位＋工作台）", device=hub.bench.spec.get("device", "pi-1"),
                                 bench=hub.bench.spec.get("id"), benchName=hub.bench.spec.get("name"), deploy=False, deployWhy=DEPLOY_NO_BENCH)
                    await s.send(h)
                elif op == "ping":
                    await s.send({"op": "pong", "t": m.get("t")})
                elif op == "watch":
                    s.watch(m.get("pins", []))
                elif op == "sonar":
                    s.sonar(m.get("sensors", []))
                elif op == "authorize":
                    await s.send({"op": "authorized", "outputs": s.authorize(m.get("outputs", []))})
                elif op in ("write", "servo"):
                    await s.send(s.command(m))
                elif op == "revoke":
                    s.revoke()
                elif op == "deploy":
                    if m.get("confirm") is not True:
                        raise PermissionError("部署會讓程式直接控制 GPIO，必須由使用者確認（confirm: true）")
                    r = await hub.deploy(s, str(m.get("code", "")), m.get("pins", []))
                    await s.send(dict(r, op="deployed", id=m.get("id")))
                elif op == "stop":
                    if hub.running and hub.running.session is not s:
                        hub.running.session = s          # 接手輸出
                    if not await hub.stop():
                        await s.send({"op": "proc_exit", "code": None, "reason": "not_running"})
                elif op == "status":
                    await s.send({"op": "status", "running": hub.running.info() if hub.running else None})
                elif op == "mock_distance" and hub.mock:
                    # 測試用：模擬超音波前方物體的距離（cm）
                    hub.mock_cm[int(m["trig"])] = max(0, min(400, int(m["cm"])))
                elif op == "mock_level" and hub.mock:
                    # 測試用：模擬實體按鈕。value 0 = 低電位（上拉時表示按下）
                    pin = hub.Device.pin_factory.pin(int(m["pin"]))
                    pin.drive_low() if int(m["value"]) == 0 else pin.drive_high()
                else:
                    await s.send({"op": "error", "message": f"不支援的指令 {op}"})
            except Exception as e:  # 單一指令失敗不中斷連線
                await s.send({"op": "error", "id": m.get("id"), "message": str(e)})
    finally:
        hub.sessions -= 1
        s.close()                   # 斷線：關閉並釋放這個連線的所有輸出與輸入，不保留待執行命令
        if hub.running and hub.running.session is s:
            hub.running.session = None   # 部署的程式繼續執行（像 Arduino 上傳後一樣），之後的連線可以停止它
        print(f"[離線] {request.remote}")
    return ws


# 虛擬樹莓派的工作台 API（只在 --bench 時有）：狀態、操作、輸出軌跡；格式和 tools/vdev 的虛擬 Uno 相同
async def bench_state(request):
    hub = request.app["hub"]
    return web.json_response(hub.bench.state(hub.sessions), dumps=lambda o: json.dumps(o, ensure_ascii=False))


async def bench_act(request):
    hub = request.app["hub"]
    try:
        q = await request.json()
        hub.bench.act(q)
        return web.json_response(hub.bench.state(hub.sessions), dumps=lambda o: json.dumps(o, ensure_ascii=False))
    except Exception as e:
        return web.json_response({"error": str(e)}, status=400, dumps=lambda o: json.dumps(o, ensure_ascii=False))


async def bench_trace(request):
    b = request.app["hub"].bench
    t = {"trace": list(b.trace), "resets": [], "devMs": round(b.now_ms())}
    if request.query.get("clear") == "1":
        b.trace.clear()
    return web.json_response(t, dumps=lambda o: json.dumps(o, ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser(description="DofLab Raspberry Pi GPIO 閘道")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--mock", action="store_true", help="不接硬體，用 gpiozero MockFactory 模擬腳位（只供測試）")
    ap.add_argument("--deploy-dir", default=None, help="部署程式存放的資料夾（預設 ~/doflab-deploy）")
    ap.add_argument("--bench", default=None, help="虛擬樹莓派：模擬腳位外面接的工作台（tools/vdev/benches 的名稱、.json 路徑或 JSON 文字）；隱含 --mock")
    ap.add_argument("--exit-with-parent", action="store_true", help="父程序（虛擬設備主機）結束時跟著結束，避免留下孤兒程序")
    args = ap.parse_args()
    if args.bench:
        args.mock = True
    ppid = os.getppid()

    async def watch_parent():
        while True:
            await asyncio.sleep(0.5)
            if os.getppid() != ppid:       # 父程序不在了（被收養）：模擬腳位，沒有要安全關閉的硬體
                os._exit(0)

    async def on_startup(app):
        app["hub"] = Hub(asyncio.get_running_loop(), args.mock, args.deploy_dir, args.bench)
        if app["hub"].bench:
            app["hub"].bench.start()
        if args.exit_with_parent:
            app["parent"] = asyncio.get_running_loop().create_task(watch_parent())

    async def on_cleanup(app):
        await app["hub"].stop()       # 閘道結束：一併停止部署的程式

    app = web.Application()
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    app.router.add_get("/", index)
    app.router.add_get("/index.html", index)
    if (HERE / "vendor").is_dir():
        app.router.add_static("/vendor", HERE / "vendor")   # 離線用的 three.js 與 Blockly
    app.router.add_get("/ws", ws_handler)
    if args.bench:
        app.router.add_get("/api/bench", bench_state)
        app.router.add_post("/api/bench", bench_act)
        app.router.add_get("/api/trace", bench_trace)
    bench_name = (json.loads(args.bench).get("id") or "自訂") if args.bench and args.bench.lstrip().startswith("{") else args.bench
    print(f"DofLab Pi 閘道：http://{socket.gethostname()}.local:{args.port}  {'（虛擬樹莓派：模擬腳位＋工作台 ' + bench_name + '）' if args.bench else '（模擬腳位）' if args.mock else ''}", flush=True)
    web.run_app(app, host=args.host, port=args.port, print=None)


if __name__ == "__main__":
    main()
