# DofLab：給 Claude Code 的專案說明

DofLab 是多板教學平台（Arduino Uno R3、ESP32 DevKitC／DevKit V1、Raspberry Pi 4B）：3D 電路配置 → 視覺積木行為 → 產生程式（C++／Python）→ 模擬 → 真機同步（數位孿生）。依《DofLab 規劃文件 v0.1》開發（規劃文件本身不在 repo 裡；需要時請使用者提供，放到 `docs/`）。

目前版本：**V2.14 原型**（2026-10-26）。使用者是劉老師，介面、註解、文件、回覆一律用**繁體中文**。

## 下一個工作

**雲端虛擬硬體第 7 階段（上雲端）要等使用者決定**（主機、帳號、費用、通行碼；規則 4 預設不公開部署）。規劃與分階段驗收在 `docs/VIRTUAL_DEVICE_PLAN.md`。已完成：第 1 階段（V2.8，虛擬 Uno 經 WebSocket：`tools/vdev/`、`src/drivers/transport.js`）、第 2 階段（V2.9，工作台：`bench.js`、`bench.html`、`benches/`）、第 3 階段（V2.10，故障與網路注入：`netfault.js`、`/fault`）、第 4 階段（V2.11，上傳與序列埠：虛擬 Optiboot、`DL.transport.wsSerialPort`、`/trace`、`atDevMs`）、第 5 階段（V2.12，多人與控制權：`tools/vdev/hub.js`、協定 2 的 `lock`／`presence`；連線紀錄：`src/core/session.js`、`src/ui/record.js`；E2E `vmulti`）、第 6 階段（V2.13，虛擬樹莓派：`pi_bridge.py --bench`＋`tools/vdev/pi_bench.py`＋`pihost.js`；虛擬 ESP32 協定模型：`tools/vdev/esp32model.js`；驗收 `tests/vdev_sync.test.js`；E2E `vboards`）。V2.14 另加：觀測頁「訊號測試」（`src/ui/testsig.js`）、PWM 輸出（DofLabFirmata 1.3）、訊號波形的暫停與 A／B 比較（`src/ui/wave.js`）、工作台自動產生輸入；E2E `tsig`。待使用者決定：老師強制收回控制權（第 7 階段）。

---

## 必須遵守的規則（使用者訂的）

1. **四種標示**，所有文件、狀態表、回覆都要用：**已確認需求**、**設計提案**、**已實作**、**未驗證**（另有「未包含」）。
2. **不宣稱沒驗證過的事。** 「在虛擬晶片／模擬上通過」≠「在實體設備上驗證」，要分開寫。虛擬設備做好後一律寫「已在虛擬設備驗證，未以實體設備驗證」。
3. **SG90 的角度是命令值，不是量測值。** 三線伺服沒有回授；畫面與孿生狀態的量測欄固定「無回授」。
4. **預設限制**（除非使用者在該次工作階段明確同意）：不公開部署、不改權限、不建立新帳號、不呼叫付費服務、**不操作真實設備**（包含上傳到插在電腦上的板子）。
5. 改完要讓測試通過，並同步更新：`README.md`、`ACCEPTANCE.md`（驗收紀錄）、`src/ui/main.js` 的 `DL.ui.STATUS`（介面上的版本狀態表）、版本號（`src/ui/body.html` 的 `.ver`、`README.md` 與 `ACCEPTANCE.md` 標題、`package.json`）。

## 實體設備實測紀錄（使用者回報，不是 Claude 測的）

| 日期 | 設備 | 結果 |
|---|---|---|
| 2026-10-23 | ESP32 DevKit V1（DOIT，WROOM-32，藍燈 GPIO2） | 連線、上傳程式、BOOT 鍵即時同步、藍燈顯示：正常。連線偶爾失敗（前一次連線占住連接埠）→ V2.6.1 已修正處理方式，**尚未再次實測** |

尚未在實體設備上試過：Uno、樹莓派、SG90／三軸手臂、超音波、光敏模組、ESP32 觸控門檻、手機實機、Uno 以外的上傳流程細節。

---

## 架構

單一 HTML 頁面，由 `build.js` 把 `src/` 全部內嵌：
- `dist/app.html`：CDN 版（發佈成 claude.ai artifact 用的就是這個）
- `dist/index.html`＋`dist/vendor/`：離線版（教室沒網路也能用）
- `dist/` 是建置產物，**不進 git**（`npm run build` 重新產生）

| 目錄 | 內容 |
|---|---|
| `src/core/` | 與畫面無關的核心，**瀏覽器與 Node 共用**：`boards`（板型、腳位能力）、`components`（元件型錄）、`breadboard`、`project`（專案格式、`inputsHash`）、`netlist`（電路檢查、綁定）、`behavior`（行為 IR、驗證、摘要）、`engine`（模擬引擎）、`codegen`（C++／Python 產生器，`GENERATOR_VERSION`）、`autowire`（接線助手）、`routing`（整齊走線）、`experiments`（引導實驗）、`arm`（三軸手臂 IK、動作序列 `seqPlan／seqStep`）、`twin`（Twin Core 五層狀態）、`session`（連線紀錄的格式與重播比對）、`testsig`（訊號測試的數值 `DL.testsig`、波形擷取與存檔格式 `DL.wave`） |
| `src/ui/` | 只在瀏覽器：`app`（主程式、配置、行為、程式頁、可收合卡片、HUD）、`scene`（Three.js 3D 場景）、`models`（程序化 3D 模型）、`observe`（模擬、觀測、真機連線）、`arm`（手臂頁）、`blocks`（Blockly）、`upload`、`record`（連線紀錄的錄製、匯出、重播）、`wave`（訊號波形：記錄、暫停往回看、A／B 比較）、`testsig`（觀測頁的「訊號測試」卡片）、`teacher`、`main`（啟動與版本狀態表）、`body.html`、`styles.css` |
| `src/drivers/` | `transport.js`：傳輸層 `WebSerialTransport`（含 `DL.serial` 連接埠占用處理）、`WebSocketTransport`（虛擬設備）；`drivers.js`：`FirmataDriver`（Firmata，只透過傳輸物件收送位元組）、`PiBridgeDriver`（WebSocket）、`driverFor(board, source)`；`stk500.js`：瀏覽器上傳 Uno |
| `tools/` | `doflab_server.py`（本機編譯／上傳服務，aiohttp，port 8766）、`pi_bridge.py`（樹莓派閘道，`--mock` 用模擬腳位，port 8765）、`firmware/DofLabFirmata/`（DofLabFirmata 1.3，含超音波擴充 `F0 62`／`F0 63`、斷線保護 `F0 64`、PWM 模式 03）、`vdev/`（虛擬設備主機，Node，port 8770：`server.js` WebSocket＋HTTP、`hub.js` 多人連線與控制權（Firmata 轉接）、`netfault.js` 網路故障注入、`device.js` 每台一個 worker、`bench.js` 工作台的元件模型、`bench.html` 工作台頁、`benches/*.json` 工作台預設（`--bench`）、`avrsim.js` avr8js 虛擬 Uno，跑真的 .hex、含 Optiboot；測試也用它。虛擬設備載入 Optiboot，可以經 WebSocket 用 STK500 上傳；`esp32model.js` 虛擬 ESP32 的**協定模型**（照 DofLabFirmata 的 ESP32 分支寫的 JS，不是實際韌體；介面和 VirtualUno 相同）；`pihost.js`＋`pi_bench.py` 虛擬樹莓派：主機啟動 `pi_bridge.py --bench` 子程序並轉接） |
| `tests/` | Node 測試 `*.test.js`、Python 測試 `test_*.py`、`host/`（g++ 主機替身：Arduino.h、Servo.h、harness.cpp）、`avr/pty_uno.js`（avrdude 經 pty 上傳到虛擬 Uno）、`fixtures/`（韌體 .hex） |
| `e2e/` | `e2e.py`（Playwright 瀏覽器測試，可只跑某些段落）、`virtual_entry.js`（瀏覽器內的虛擬 Uno，用 esbuild 打包成 `virtual_uno.bundle.js`，不進 git） |
| `docs/` | 規劃文件 |
| `promo/` | 介紹影片的場景來源 |

### 重要的設計約定

- **模組格式**：每個檔案是 `(function (root) { const DL = root.DL = root.DL || {}; … })(globalThis)`，掛在 `DL` 上；core 檔案結尾 `if (typeof module !== 'undefined') module.exports = DL;`。
- **程式與模擬一致**：模擬引擎、產生的 C++、產生的 Python 用同一套時序規則（1 ms 一輪、去彈跳、閃爍相位、超音波每 60 ms、手臂序列每 1 ms 且用 32 位元浮點數）。改其中一邊就要改另外兩邊，並跑等價測試（`tests/equivalence.test.js`、`arm_seq.test.js`、`ultrasonic.test.js`、`onboard.test.js`、Python 的 `test_pi_codegen.py`）。
- **改了產生器的輸出就調 `GENERATOR_VERSION`**（`src/core/codegen.js`）；`inputsHash` 會讓舊程式顯示「過期」。
- **行為確認**：產生程式前，使用者要先在行為頁確認摘要；接線、參數、行為一改就要重新確認。手臂專案改成確認「手臂設定」。
- **Twin Core 五層**：target／commanded／ack／measured／simulated 不混用；斷線不重送未確認的命令；重連一律從唯讀開始。設備重新開機（`twin.rebooted()`，由驅動從「沒問過的韌體名稱」判斷）視同斷線處理；`define(name, {periodic: true})` 的訊號超過 staleMs 沒有新讀值就過期。
- **回讀（ACK）配對**：`FirmataDriver.lastCmdByPin` 是每個腳位一條在途佇列，回讀給最早一個值相同的命令；畫面上最新命令未確認時不顯示上一個命令的確認。
- **虛擬設備的多人連線**（`tools/vdev/hub.js`）：寫入只有控制者能送（主機擋下別人的寫入）；查詢的回覆只送給問的人（否則別人的交握會被誤判成重新開機）。DofLab 在「授權受控寫入」時才取得控制權（`FirmataDriver.acquire()`），撤銷時交出；新增會改變設備的 Firmata 訊息時，要在 `Hub.judge()` 歸類。
- **連線紀錄的時間**：重播與比對用模擬時間（`st`），不用實際時間（headless 一幀超過 1 秒時模擬時間會截斷）。
- **虛擬設備一律標示**：`twin.connected(id, info, {virtual: true})`、`DL.modeLabel(mode, virtual)`；介面各處（模式標籤、量測欄、3D 標籤、事件紀錄）都要分得出虛擬與實體。工作台（`tools/vdev/bench.js`、`pi_bench.py`）**不可以** require `src/core/engine.js`。三種虛擬設備也要分得出來：虛擬 Uno＝avr8js 跑真韌體；虛擬 ESP32＝**協定模型，不是實際韌體**（hello 的 `model: 'protocol'`）；虛擬樹莓派＝真的 pi_bridge＋gpiozero 模擬腳位（hello 的 `virtual: true`）。改 DofLabFirmata 的行為時要同步改 `esp32model.js`，並跑 `tests/vdev_esp32.test.js`（模型換成 Uno 腳位表和真韌體逐位元組比對）。
- **伺服脈寬**：三種板子都是 544–2400 µs（Uno／ESP32 是 Servo 函式庫預設；樹莓派的 `pi_bridge.py` 與產生的 Python 程式在 V2.13 統一）。要改就三邊一起改，並跑等價測試。授權受控寫入時先送伺服目前的角度（`FirmataDriver.authorize` 的 `initial`：設成伺服模式和寫入角度同一次傳送），否則韌體會先輸出 1500 µs。E2E 若要旁聽 `driver.write`，參數有三個（`cmd, out, before`），要一起傳下去，並在授權之前裝好。
- **超音波（Uno／ESP32 的 C++）**：ECHO 用腳位變化中斷記下時間（Uno：PCINT，`ISR(PCINTx_vect)` 依腳位分組；ESP32：`attachInterrupt`），迴圈只看量完了沒有；不用 `pulseIn`。主機替身（`tests/host/`）在 ECHO 變化的那一刻呼叫中斷處理。量測的時序規則（每 60 ms、用上一次的結果、400 cm）和引擎、Python 相同。
- **斷線保護**：DofLabFirmata 1.2（`OUTPUT_GUARD_MS` 3 秒）、`esp32model.js`、`pi_bridge.py`（`OUTPUT_GUARD_S`）在有輸出、太久沒收到訊息時自己關掉輸出並通知（`F0 64 F7`／`guard`）；虛擬設備主機在控制者斷線或逾時時關掉他的輸出（`Hub.guardOff`）。DofLab 的心跳（每秒）就是讓設備知道連線還在；改心跳間隔要一起看。改韌體要重新編譯 `tests/fixtures/DofLabFirmata-uno.hex`（觀測頁內建的就是它）。
- **訊號測試與 PWM（V2.14）**：訊號測試的每一次寫入都走 Twin Core（`twin.command(sig, v, 'test')`），不另開寫入路徑；和「▶ 執行」不同時進行。數值規則（鋸齒到頂先寫終點、三角兩端都寫到）在 `src/core/testsig.js`，工作台的自動產生輸入（`bench.js`、`pi_bench.py`）用同一套，改一邊要改三邊並跑 `tests/testsig.test.js`。PWM 用 `LED.pwm` 訊號（同一個腳位，授權時一起授權，測試時才 `setKind` 切換）；Uno 有伺服時 D9／D10 不能 PWM（Timer1）。波形記「變化」：命令與量測依 Twin Core 事件的時刻，模擬層每幀取樣；時間用 `Date.now()`。虛擬設備主機的 HTTP API 新增工作台參數時，`server.js` 的 `apiBench` 與 `pihost.js` 都要轉過去（V2.14 漏過一次）。
- **3D 場景只在有變化時重畫**（`scene.dirty`，最多 1 秒補畫一次）：改了 3D 物件要設 `this.dirty = true`。
- **手臂**：三顆伺服裝在手臂模型的關節上（配置頁與手臂頁共用 `DL.models.arm`，手臂頁借用配置頁場景的 `root`）。兩種模式：自動（行為頁的動作序列，按「▶ 執行」）與手動（拖曳、滑桿、輸入）。

---

## 指令

```bash
npm ci                 # 安裝 three、blockly、avr8js、esbuild
npm run check          # 所有 src/*.js 語法檢查（改完一定要跑）
npm run build          # 產生 dist/
npm run test:node      # Node 測試（目前 215 項，含第 4 階段驗收的 15 個子測試、第 6 階段驗收的 27 個子測試；沒有 arduino-cli 時會略過 11 項；沒有 Python 的 gpiozero／aiohttp 時略過虛擬樹莓派）
npm run test:py        # Python 測試（23 項；沒有 arduino-cli、avrdude、socat 時會略過）
npm run test:e2e       # 建置＋打包＋瀏覽器測試（286 項，約 27 分鐘）
python3 e2e/e2e.py onboard v27   # 只跑部分段落：desktop breadboard teacher experiments pi ultrasonic onboard arm v27 uno vdev bench faults upload vupload vmulti vboards tsig pideploy mobile dark
DOFLAB_SYNC_ONLY=dist-alarm node --test tests/vdev_sync.test.js   # 第 6 階段驗收只跑某些實驗
npm run vdev                     # 虛擬設備主機（node tools/vdev/server.js），ws://127.0.0.1:8770/dev/uno-1，工作台 http://127.0.0.1:8770/
npm run vdev -- --bench arm-3dof # 換工作台：hold-blink（預設）、hold-blink-miswired、night-light、dist-gauge、arm-3dof
npm run vdev -- --pi --esp32     # 再加虛擬樹莓派 pi-1（工作台 pi-*）與虛擬 ESP32 esp32-1（協定模型，工作台 esp32-*）
python3 dist/doflab_server.py    # 本機編譯服務，開 http://localhost:8766
python3 tools/pi_bridge.py --mock
```

完整測試需要的工具：Node 22、g++、Python 3.9+（`pip install aiohttp gpiozero playwright`）、arduino-cli 1.1.1＋`arduino:avr` 1.8.6＋`esp32:esp32` 2.0.17、Servo 1.2.2、ESP32Servo 1.1.2、avr-nm、avrdude、socat。Playwright 用系統的 Chromium。
在沒有網路的環境，arduino-cli 的工具路徑可以用環境變數 `DOFLAB_ARDUINO_PROPS`（`key=value;key=value`，會變成 `--build-property`）指定；一般電腦不需要。

CI（`.github/workflows/ci.yml`）只跑不需要 Arduino 工具鏈的部分。2026-10-23 在 GitHub 上第一次執行並通過（PR dofliu/controlBoardTwin#1）。

## 已知的坑

- **E2E 不要用固定延遲取樣。** headless Chromium 的軟體繪圖一幀可能 300 ms 以上；請等狀態（`wait_for_function`）或用模擬時間（`doflab.sim.time`、`doflab.events` 的 `simT`）判斷。
- 測試用的 port 8766／8765／8770 卡住時用 `fuser -k 8766/tcp 8765/tcp 8770/tcp`，**不要** `pkill -f`。
- avr8js 0.20.1 寫入 UCSR0B 會清掉 RXC，`VirtualUno.boot()` 已照實體晶片修正（否則約每 0.5 秒遺失一個收到的位元組）；空接、開了內部上拉的腳位 avr8js 讀成 LOW，也已修正成 HIGH（V2.9）。升級 avr8js 時要重新確認這兩點。
- 真機模式的按鈕量測依收到的時刻排隊（`noteButtonEvent`／`feedButtons`），模擬推進到那一毫秒才生效；不要改回「每一幀讀一次」，否則畫面慢時短按會被漏掉。
- 手臂連線授權後**不要再記姿態**：改動作序列＝改行為，會撤銷寫入授權（產品規則）。E2E 要先記好姿態再連線。
- 比對兩個介面時不要用固定的時間門檻：headless 繪圖下 DofLab 一幀可能 0.3–0.6 秒，手臂命令每一幀送一次。等狀態（兩邊都到達同一個姿態），並比對設備端收到的命令筆數與內容。
- Python 的 Playwright 版本要和 `/opt/pw-browsers` 的瀏覽器版本一致（例如系統的 Node 版 playwright 1.63.0 → `pip install playwright==1.63.0`），否則會要求下載瀏覽器。
- esbuild 打包 `e2e/virtual_entry.js` 需要 `--external:fs`（`npm run bundle:e2e` 已包含）。
- 在單行的程式碼中間插入 `// 註解` 會吃掉後面的程式碼；行內註解用 `/* */`，改完跑 `npm run check`。
- gpiozero 的模擬腳位：建立有上拉的輸入時會把電位拉回高，虛擬樹莓派的工作台在 pi_bridge 開始監看後要再設一次按鈕電位（`PiBench.reassert`）。
- 協定模型（`esp32model.js`）的排程要**進位**到下一個時間單位：四捨五入會讓喚醒比預定時間早一點點，等待中的超音波量測就停了（V2.13 發現）。
- 協定模型比較時間要用時間單位（`cycle`），不要用毫秒相減：浮點數會讓「剛好 3000 ms」變成 2999.9999…（斷線保護約五分之一不觸發，V2.13 發現）。
- 停止伺服（`detachServo`）不能停在脈衝中間，否則會送出被截短的脈衝；Uno 的韌體先等腳位變 LOW；ESP32 先把 LEDC 工作週期寫 0、等一個週期再拆腳位（未以實體 ESP32 驗證）。協定模型的 `detachServo` 讓正在送的脈衝送完。
- Web Serial 的連接埠要先等讀取迴圈結束才能關閉（`FirmataDriver._disconnect`）；虛擬連接埠（`avrsim.webSerialPort()`）已經和 Chrome 一樣嚴格，可以拿來重現占用問題。
- 介面文字與註解都是繁體中文；元件 ID（LED1、BTN1、SERVO1…）與程式碼保留英文。

## 歷史

- git 歷史從 V2.4 開始（之前的 V1–V2.3 只有 zip，不在 repo）。2026-10-23 整理 repo 時把 `node_modules/`、`dist/`、打包檔從歷史中移除。
- 各版新增內容見 `ACCEPTANCE.md`（最新的在最上面）。
