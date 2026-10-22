#!/usr/bin/env python3
"""
DofLab — 本機編譯服務（在你的電腦上執行）

  python3 doflab_server.py            然後開 http://localhost:8766
  （Web Serial 需要 https 或 localhost，所以從這裡開也能連 Arduino）

功能：
  GET  /                 提供 index.html
  GET  /api/info         回報可用的工具鏈與版本
  POST /api/compile      {"board":"uno"|"esp32"|"pi4b","code":"..."}
                         → 呼叫正式工具鏈，回傳原始輸出、行號診斷、結束碼，以及可上傳的檔案
                           （Uno：.hex；ESP32：開機程式／分割表／boot_app0／應用程式四個 .bin 與位址）
  GET  /api/ports        列出這台電腦上的序列埠（arduino-cli board list）
  POST /api/upload       {"board","code","port","confirm":true} → 編譯後用 arduino-cli upload 上傳
                         （Uno 用 avrdude、ESP32 用 esptool；必須 confirm:true，伺服器只接受本機連線）

工具鏈：
  Uno / ESP32：arduino-cli（需先安裝對應 core：arduino:avr、esp32:esp32；ESP32 另需 ESP32Servo 函式庫）
  Raspberry Pi：python3 -m py_compile（只檢查 Python 語法，不檢查硬體或執行結果）
上傳會覆蓋板上原本的程式（包括 DofLabFirmata）。只有在使用者明確確認後才執行。
額外的上傳參數可用 DOFLAB_ARDUINO_UPLOAD_PROPS 傳入（以 ; 分隔，對應 arduino-cli upload --upload-property）。

額外的 arduino-cli 建置參數可用環境變數 DOFLAB_ARDUINO_PROPS 傳入（以 ; 分隔），
例如沒有網路、使用系統 avr-gcc 時：
  DOFLAB_ARDUINO_PROPS="runtime.tools.avr-gcc.path=/usr;runtime.tools.ctags.path=/opt/ctags"
"""
import argparse
import base64
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import time

from aiohttp import web

HERE = pathlib.Path(__file__).resolve().parent
FQBN = {"uno": "arduino:avr:uno", "esp32": "esp32:esp32:esp32"}
DIAG_ARDUINO = re.compile(r"^(?P<file>[^:\n]*?sketch\.ino):(?P<line>\d+):(?:(?P<col>\d+):)?\s*(?P<sev>fatal error|error|warning|note):\s*(?P<msg>.*)$", re.M)
DIAG_PY = re.compile(r'File "[^"]*", line (?P<line>\d+)')


def run(cmd, timeout=180, cwd=None):
    t0 = time.time()
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=cwd)
        return p.returncode, p.stdout + p.stderr, int((time.time() - t0) * 1000)
    except FileNotFoundError:
        return 127, f"找不到指令：{cmd[0]}", 0
    except subprocess.TimeoutExpired as e:
        return 124, (e.stdout or "") + (e.stderr or "") + f"\n編譯逾時（{timeout} 秒）", timeout * 1000


def arduino_version():
    if not shutil.which("arduino-cli"):
        return None
    code, out, _ = run(["arduino-cli", "version"], timeout=20)
    m = re.search(r"Version:\s*(\S+)", out)
    return m.group(1) if m else out.strip()[:80]


NO_CLI = "找不到 arduino-cli。請先安裝 https://arduino.github.io/arduino-cli/ 並執行 arduino-cli core install "


def _build(board, code, d):
    """在暫存資料夾 d 編譯；回傳 (結束碼, 輸出, 毫秒, 輸出資料夾)"""
    sk = pathlib.Path(d) / "sketch"
    sk.mkdir()
    (sk / "sketch.ino").write_text(code, encoding="utf-8")
    outdir = pathlib.Path(d) / "out"
    cmd = ["arduino-cli", "compile", "--fqbn", FQBN[board], "--warnings", "default", "--output-dir", str(outdir)]
    for prop in filter(None, os.environ.get("DOFLAB_ARDUINO_PROPS", "").split(";")):
        cmd += ["--build-property", prop]
    cmd.append(str(sk))
    rc, out, ms = run(cmd)
    out = "\n".join(l for l in out.splitlines() if not l.startswith("Error initializing instance"))   # 離線時 arduino-cli 的索引警告
    out = re.sub(r"\x1b\[[0-9;]*m", "", out)
    return rc, out, ms, outdir


def _artifacts(board, out, outdir):
    """編譯產物：瀏覽器端上傳要用的檔案"""
    if board == "uno":
        hexf = outdir / "sketch.ino.hex"
        return {"kind": "hex", "hex": hexf.read_text()} if hexf.exists() else None
    m = re.search(r"^esp32:esp32\s+\S+\s+(\S+)", out, re.M)
    files = [(0x1000, "sketch.ino.bootloader.bin"), (0x8000, "sketch.ino.partitions.bin"), (0xE000, None), (0x10000, "sketch.ino.bin")]
    res = []
    for off, name in files:
        f = outdir / name if name else (pathlib.Path(m.group(1)) / "tools" / "partitions" / "boot_app0.bin" if m else None)
        if not f or not f.exists():
            return None
        res.append({"offset": off, "name": f.name, "b64": base64.b64encode(f.read_bytes()).decode()})
    return {"kind": "esp32", "flashMode": "dio", "flashFreq": "40m", "files": res}


def compile_arduino(board, code):
    if not shutil.which("arduino-cli"):
        return {"ok": False, "exitCode": 127, "toolchain": None, "raw": NO_CLI + FQBN[board].rsplit(":", 1)[0], "diagnostics": []}
    with tempfile.TemporaryDirectory(prefix="doflab-") as d:
        rc, out, ms, outdir = _build(board, code, d)
        arts = _artifacts(board, out, outdir) if rc == 0 else None
    diags = [{"line": int(m["line"]), "col": int(m["col"]) if m["col"] else None, "severity": "error" if "error" in m["sev"] else m["sev"], "message": m["msg"]} for m in DIAG_ARDUINO.finditer(out)]
    plat = re.search(r"^(\S+:\S+)\s+(\S+)\s+\S+", out[out.find("Used platform"):] if "Used platform" in out else "", re.M)
    size = re.search(r"Sketch uses (\d+) bytes \((\d+)%\)", out)
    return {"ok": rc == 0, "exitCode": rc, "durationMs": ms,
            "toolchain": {"name": "arduino-cli", "version": arduino_version(), "fqbn": FQBN[board], "platform": plat.group(0).split()[:2] if plat else None},
            "size": {"bytes": int(size.group(1)), "percent": int(size.group(2))} if size else None,
            "raw": out.strip(), "diagnostics": diags, "artifacts": arts}


PORT_RE = re.compile(r"^(/dev/[\w./-]+|COM\d+|/tmp/[\w./-]+)$")


def list_ports():
    if not shutil.which("arduino-cli"):
        return {"ok": False, "raw": NO_CLI, "ports": []}
    rc, out, _ = run(["arduino-cli", "board", "list", "--format", "json"], timeout=30)
    data = None
    for start in (0, out.find("{"), out.find("[")):
        try:
            data = json.loads(out[start:]) if start >= 0 else None
            break
        except Exception:
            continue
    if data is None:
        return {"ok": False, "raw": out.strip()[:2000], "ports": []}
    items = data.get("detected_ports", []) if isinstance(data, dict) else data
    ports = []
    for it in items or []:
        pt = it.get("port", it)
        boards = [{"name": b.get("name"), "fqbn": b.get("fqbn")} for b in (it.get("matching_boards") or it.get("boards") or [])]
        ports.append({"address": pt.get("address"), "protocol": pt.get("protocol"), "label": pt.get("protocol_label") or pt.get("label") or "", "boards": boards})
    return {"ok": rc == 0, "ports": [p for p in ports if p["address"]]}


def upload_arduino(board, code, port):
    if not shutil.which("arduino-cli"):
        return {"ok": False, "exitCode": 127, "raw": NO_CLI + FQBN[board].rsplit(":", 1)[0], "stage": "toolchain"}
    if not PORT_RE.match(port or ""):
        return {"ok": False, "exitCode": 2, "raw": f"連接埠名稱看起來不正確：{port!r}", "stage": "port"}
    with tempfile.TemporaryDirectory(prefix="doflab-up-") as d:
        rc, out, ms, outdir = _build(board, code, d)
        if rc != 0:
            return {"ok": False, "exitCode": rc, "raw": out.strip(), "stage": "compile", "durationMs": ms}
        cmd = ["arduino-cli", "upload", "-p", port, "--fqbn", FQBN[board], "--input-dir", str(outdir), "--verify"]
        for prop in filter(None, os.environ.get("DOFLAB_ARDUINO_UPLOAD_PROPS", "").split(";")):
            cmd += ["--upload-property", prop]
        cmd.append(str(pathlib.Path(d) / "sketch"))
        rc2, out2, ms2 = run(cmd, timeout=240)
    out2 = re.sub(r"\x1b\[[0-9;]*m", "", out2)
    return {"ok": rc2 == 0, "exitCode": rc2, "raw": out2.strip(), "stage": "upload", "durationMs": ms + ms2, "port": port, "fqbn": FQBN[board]}


def compile_python(code):
    with tempfile.TemporaryDirectory(prefix="doflab-") as d:
        f = pathlib.Path(d) / "main.py"
        f.write_text(code, encoding="utf-8")
        rc, out, ms = run([sys.executable, "-m", "py_compile", str(f)], timeout=30)
    out = out.replace(str(f), "main.py")
    diags = []
    if rc != 0:
        m = DIAG_PY.search(out)
        last = [l for l in out.strip().splitlines() if l.strip()]
        diags.append({"line": int(m["line"]) if m else None, "col": None, "severity": "error", "message": last[-1] if last else out})
    return {"ok": rc == 0, "exitCode": rc, "durationMs": ms, "toolchain": {"name": "python3 -m py_compile", "version": sys.version.split()[0], "note": "只檢查語法；不檢查 gpiozero 是否安裝、腳位或執行結果"}, "raw": out.strip() or "語法檢查通過。", "diagnostics": diags}


async def api_info(request):
    return web.json_response({"arduino_cli": arduino_version(), "python": sys.version.split()[0], "boards": {"uno": FQBN["uno"], "esp32": FQBN["esp32"], "pi4b": "python3 -m py_compile"}})


async def api_compile(request):
    try:
        body = await request.json()
        board, code = body["board"], body["code"]
    except Exception:
        return web.json_response({"ok": False, "raw": "請求格式錯誤：需要 JSON {board, code}", "diagnostics": []}, status=400)
    if len(code) > 200_000:
        return web.json_response({"ok": False, "raw": "程式太大（超過 200 KB）", "diagnostics": []}, status=413)
    if board in FQBN:
        res = await request.app.loop.run_in_executor(None, compile_arduino, board, code)
    elif board == "pi4b":
        res = await request.app.loop.run_in_executor(None, compile_python, code)
    else:
        return web.json_response({"ok": False, "raw": f"不支援的板型 {board}", "diagnostics": []}, status=400)
    res["board"] = board
    return web.json_response(res)


async def api_ports(request):
    return web.json_response(await request.app.loop.run_in_executor(None, list_ports))


async def api_upload(request):
    try:
        body = await request.json()
        board, code, port = body["board"], body["code"], body.get("port", "")
    except Exception:
        return web.json_response({"ok": False, "raw": "請求格式錯誤：需要 JSON {board, code, port, confirm}"}, status=400)
    if body.get("confirm") is not True:
        return web.json_response({"ok": False, "raw": "上傳會覆蓋板上原本的程式，必須由使用者確認（confirm: true）。", "stage": "confirm"}, status=400)
    if board not in FQBN:
        return web.json_response({"ok": False, "raw": f"{board} 不能用這個方式上傳（Raspberry Pi 請用 pi_bridge 部署）。"}, status=400)
    if len(code) > 200_000:
        return web.json_response({"ok": False, "raw": "程式太大（超過 200 KB）"}, status=413)
    res = await request.app.loop.run_in_executor(None, upload_arduino, board, code, port)
    res["board"] = board
    return web.json_response(res)


async def index(request):
    page = HERE / "index.html"
    if not page.exists():
        return web.Response(text="找不到 index.html", status=404)
    return web.FileResponse(page)


@web.middleware
async def local_cors(request, handler):
    resp = await handler(request) if request.method != "OPTIONS" else web.Response()
    origin = request.headers.get("Origin", "")
    if re.match(r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$", origin):
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp


def main():
    ap = argparse.ArgumentParser(description="DofLab 本機編譯服務")
    ap.add_argument("--port", type=int, default=8766)
    ap.add_argument("--host", default="127.0.0.1", help="預設只接受本機連線")
    args = ap.parse_args()
    app = web.Application(middlewares=[local_cors])
    app.router.add_get("/", index)
    app.router.add_get("/index.html", index)
    if (HERE / "vendor").is_dir():
        app.router.add_static("/vendor", HERE / "vendor")   # 離線用的 three.js 與 Blockly
    app.router.add_get("/api/info", api_info)
    app.router.add_post("/api/compile", api_compile)
    app.router.add_get("/api/ports", api_ports)
    app.router.add_post("/api/upload", api_upload)
    for path in ("/api/compile", "/api/upload"):
        app.router.add_route("OPTIONS", path, lambda r: web.Response())
    print(f"DofLab：http://localhost:{args.port}　arduino-cli：{arduino_version() or '未安裝'}")
    web.run_app(app, host=args.host, port=args.port, print=None)


if __name__ == "__main__":
    main()
