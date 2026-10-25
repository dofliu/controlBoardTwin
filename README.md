# DofLab V2.13 原型

從電路配置、行為設計、模擬測試，到真實設備同步的教學與開發平台。本版依《DofLab 規劃文件 v0.1》重新開發。

## 立即使用

| 情境 | 做法 |
|---|---|
| 只想看介面、模擬 | 直接用瀏覽器開 `dist/index.html`（Chrome／Edge／Safari 都可） |
| 要編譯程式、連接 Arduino Uno | 在電腦執行 `python3 dist/doflab_server.py`，開 `http://localhost:8766` |
| 要連接 Raspberry Pi 4B | 把 `dist/` 整個資料夾複製到樹莓派，執行 `python3 pi_bridge.py`，用同網路電腦開 `http://<樹莓派IP>:8765` |
| 沒有板子，想走完真機同步的流程 | 在 repo 執行 `npm ci && npm run vdev`（虛擬設備主機），「觀測」頁選「虛擬設備（網址）」連線（見下方「虛擬設備」） |

`dist/vendor/` 內含 three.js 與 Blockly，教室沒有網路也能使用（只有 Google 字型會退回系統字型）。

### 編譯服務（doflab_server.py）

需要 Python 3.9 以上與 `aiohttp`（`pip install aiohttp`），再依板型準備工具鏈：

- **Uno**：安裝 [arduino-cli](https://arduino.github.io/arduino-cli/)，執行 `arduino-cli core install arduino:avr`。伺服範例另需 `arduino-cli lib install Servo`。
- **ESP32**：`arduino-cli core install esp32:esp32`，並執行 `arduino-cli lib install ESP32Servo`。
- **Raspberry Pi**：不需要另外安裝，使用 `python3 -m py_compile`。它只檢查語法。

服務也負責上傳（見下方「上傳到板子」），只接受本機連線。

### Arduino Uno／ESP32 真機同步

1. 到「觀測」頁按「上傳 DofLabFirmata」（Uno 直接從瀏覽器上傳；ESP32 經編譯服務上傳）。也可以用 Arduino IDE 開啟 `dist/firmware/DofLabFirmata/DofLabFirmata.ino` 自己上傳（ESP32 需先安裝 ESP32Servo 函式庫）。
   - Uno 也可以用 StandardFirmata，但它開機時會把數位腳設為 OUTPUT LOW；DofLabFirmata 開機時腳位維持輸入，比較安全。
   - StandardFirmata 不支援 ESP32。
2. 從 `http://localhost:8766` 開啟 DofLab（Web Serial 需要 https 或 localhost）。
3. 到「觀測」頁按「連接 Arduino（USB）」或「連接 ESP32（USB）」，再依序完成：辨識、唯讀觀測、核對接線、授權受控寫入。
4. 連不上時（V2.6.1）：先關掉 Arduino IDE 的序列埠監控視窗與其他開著 DofLab 的分頁。本頁上一次沒關乾淨的連線會自動關閉；被其他程式占用時會自動重試並說明；板子沒回應時會自動重新啟動板子再試一次。上傳程式前會自動中斷觀測頁的連線，上傳後按「用上次的連接埠重新連線」即可。

### 虛擬設備：沒有板子也能走完數位孿生（V2.8；V2.9 加上工作台；V2.11 可以上傳程式；V2.12 多人與控制權；V2.13 虛擬樹莓派與 ESP32）

虛擬設備是**另一個程式**裡的虛擬 Uno：avr8js 執行真的 DofLabFirmata 機器碼，外面接著「工作台」——這塊虛擬板子實際接了哪些元件。介面經網路（WebSocket）連過去，送出與收到的 Firmata 位元組和接 USB 時完全相同。

```bash
npm ci
npm run vdev                              # = node tools/vdev/server.js，只聽本機 127.0.0.1:8770，工作台 hold-blink
npm run vdev -- --bench arm-3dof          # 換一個工作台（tools/vdev/benches/ 裡的預設，或自己寫的 .json）
```

| 工作台 `--bench` | 接線 | 搭配的引導實驗 |
|---|---|---|
| `hold-blink`（預設） | 按鈕 D2（0–8 ms 隨機彈跳）、LED D13 經 220 Ω | 按住閃爍、按一下切換 |
| `hold-blink-miswired` | 故意接錯：按鈕 D3、LED D12 | 練習「核對接線」：按按鈕畫面沒反應；LED 命令有 ACK 但 LED 不亮 |
| `night-light` | 光敏模組 A0（±1 % 雜訊）、LED D13 | 光控夜燈、太亮警示 |
| `dist-gauge` | 超音波 TRIG D7／ECHO D8、SG90 D9 | 超音波距離指針 |
| `arm-3dof` | 三顆 SG90 接 D9、D10、D11，裝成三軸手臂 | 三軸機械手臂 |

工作台頁（`http://127.0.0.1:8770/`，DofLab 連線後按「開啟工作台」）是**第二個介面**：在這裡按按鈕、拉亮度與距離、按「移走物體」，看 LED、SG90 的命令角與實際角度、三軸手臂的側視與俯視。DofLab 看不到這一頁，只看得到 Firmata 回報的量測與回讀；SG90 的實際角度只在工作台顯示（DofLab 的量測欄仍是「無回授」）。

1. 從 `http://localhost:8766`（`python3 dist/doflab_server.py`）或 `dist/index.html` 開啟 DofLab，板型選 Uno，載入「按住閃爍」並確認行為。
2. 「觀測」頁的真機連線選「虛擬設備（網址）」，網址 `ws://127.0.0.1:8770/dev/uno-1`，按「連接虛擬 Uno」。不需要 Web Serial。
3. 按「開啟工作台」（`http://127.0.0.1:8770/`），在工作台頁按住 BTN1：介面的量測層顯示按下（唯讀，不送任何命令）。
4. 核對接線、授權受控寫入、按「▶ 執行」，再到工作台按住 BTN1：工作台上的 LED 依虛擬晶片 D13 的實際電位閃爍。
5. 停掉 `npm run vdev`：介面回到模擬，未確認的命令作廢、不會重送；重新啟動後再連線，從唯讀開始。

畫面上一律標示「虛擬設備」（模式標籤是紫色虛線框、量測欄寫「量測（虛擬）」、事件紀錄有「虛擬」標籤）。這裡通過的只能寫「**已在虛擬設備驗證，未以實體設備驗證**」：電壓、電流、接觸不良、USB 驅動都沒有模擬。

設備狀態與工作台也可以用 HTTP 讀寫（測試就是這樣操作「介面以外」的世界）：

```bash
curl http://127.0.0.1:8770/api/devices/uno-1                                   # 腳位、工作台、設備收到的命令紀錄
curl -X POST -d '{"part":"BTN1","action":"press"}' http://127.0.0.1:8770/api/devices/uno-1/bench
curl -X POST -d '{"part":"US1","action":"set","cm":12}' http://127.0.0.1:8770/api/devices/uno-1/bench   # cm 為 null：移走物體
curl -X POST -d '{"part":"LDR1","action":"set","light":30}' http://127.0.0.1:8770/api/devices/uno-1/bench
```

**手臂的兩個介面同步**：用 `--bench arm-3dof` 啟動，DofLab 載入「三軸機械手臂」、確認手臂設定、連線並授權寫入，在「手臂」頁勾選「把手臂命令送到設備」。拖曳或執行序列時，工作台頁上的手臂跟著 D9／D10／D11 的脈寬轉動。工作台用自己的方式換算（脈寬 → 伺服角 → 關節角 → 末端位置），不用 DofLab 的程式；兩邊停下時的關節角相差在 1.5° 內。動作序列（姿態）要在連線授權**之前**記好：改序列等於改行為，會撤銷寫入授權。

**故障注入（V2.10）**：工作台頁上方的「故障注入」面板，或 `POST /api/devices/uno-1/fault`，用來看數位孿生遇到問題時怎麼反應：

| 故障 | 怎麼做 | DofLab 應有的反應（都有自動測試） |
|---|---|---|
| 網路延遲 200 ± 100 ms | 面板「網路延遲」「抖動」→ 套用 | 量測與回讀晚到，但順序正確；網路來回時間跟著變大 |
| 掉包（可選方向） | 面板「掉包（%）」與「方向」 | 遺失的命令在孿生狀態表標示「逾時未確認・不自動重送」，網路恢復後也不補送 |
| 中斷連線 | 「中斷網路連線」 | 回到模擬；未確認命令作廢、不重送；量測標為過期 |
| 設備重置／瞬間斷電 | 「按 RESET 鍵」「瞬間斷電（brown-out）」 | 從韌體的開機訊息偵測到重新開機 → 撤銷寫入授權、回到唯讀、恢復唯讀觀測；不重送 |
| 感測器卡住 | 超音波卡片「模組卡住」（ECHO 一直是高電位） | 約 2.5 秒沒有新讀值就標示「已過期」，連線本身仍正常 |
| 拔掉一條線 | 每個元件卡片的「拔掉 … 的線」 | 按了按鈕看不到變化（核對接線失敗）；LED 命令有回讀但 LED 不亮 |

```bash
curl -X POST -d '{"net":{"delayMs":200,"jitterMs":100,"loss":0.05,"dir":"both"}}' http://127.0.0.1:8770/api/devices/uno-1/fault   # null 清除
curl -X POST -d '{"fault":"reset"}' http://127.0.0.1:8770/api/devices/uno-1/fault          # 也可以 brownout、disconnect
curl -X POST -d '{"part":"BTN1","action":"unplug"}' http://127.0.0.1:8770/api/devices/uno-1/bench   # plug 接回；超音波另有 stuck／unstuck
```

注意：網路中斷時，設備上的輸出會停在最後的命令（Firmata 本身沒有「斷線就關掉輸出」的保護）；DofLab 回到模擬，但不會也不能去關掉設備上已經亮著的 LED。

**上傳程式與序列埠監看（V2.11）**：虛擬 Uno 裡有 Arduino 官方的 Optiboot 開機程式，可以像實體 Uno 一樣上傳自己的程式：

1. 「程式」頁產生並編譯（需要編譯服務）後，上傳方式選「上傳到虛擬 Uno（網路）」，逐項確認後按「上傳到虛擬 Uno」。瀏覽器用和 USB 相同的 STK500 上傳程式，只是位元組經 WebSocket 送到虛擬晶片：DTR 重置進入 Optiboot、逐頁寫入、讀回比對。
2. 上傳後自動開啟「序列埠監看」：和 Arduino IDE 一樣，開啟時虛擬 Uno 重新啟動（Optiboot 等約 1 秒後執行程式），`Serial.println` 的文字一行一行顯示，也記進事件紀錄。
3. 在工作台頁操作按鈕、亮度、距離：這時是**上傳的程式自己**在虛擬晶片上執行（不經過 DofLab 的模擬），工作台顯示 LED 與伺服。工作台頁的「韌體」會顯示「上傳的程式」。
4. 想回到同步：「觀測」頁來源選虛擬設備，按「上傳 DofLabFirmata（虛擬 Uno）」，再連線（和實體板子的操作一樣）。虛擬 Uno 跑的不是 Firmata 時，連線會在幾秒內說明原因，不會空等。

```bash
curl http://127.0.0.1:8770/api/devices/uno-1/trace        # 輸出軌跡：工作台的輸入操作、LED 亮滅、伺服脈寬變化（設備時間）、晶片重置紀錄
curl -X POST -d '{"part":"BTN1","action":"press","atDevMs":12345.5}' http://127.0.0.1:8770/api/devices/uno-1/bench   # 排定在設備時間執行
```

**多人與控制權（V2.12）**：同一台虛擬設備可以同時有好幾個 DofLab 連線（例如老師的電腦、學生的電腦），每個人都能唯讀觀看。

- 連線前在網址旁邊填上你的名稱（其他人會看到）；連線後「真機連線」第 1 步顯示「這台虛擬設備有 N 個連線：…· 控制權：…」。
- 「授權受控寫入」時向虛擬設備主機取得**唯一的控制權**；別人的畫面顯示「控制權：老師（你只能唯讀觀看）」，授權按鈕停用。
- 沒有控制權的連線送出的寫入（輸出、伺服、重新啟動、把別人的輸出腳位改成輸入）在主機就被擋下，不會到晶片，事件紀錄會說明。
- 控制權在「停止寫入」、中斷連線（包括直接關掉分頁）、設備重新開機、或控制者 10 秒沒有任何訊息時釋放。
- 查詢的回覆只送給問的人：別人連線時的交握不會讓你誤判「設備重新開機」，別人的回讀也不會變成你的確認。
- 上傳程式與序列埠監看需要獨占：有其他人連著時會說明，請其他人先中斷。工作台頁顯示目前的連線與控制者；`GET /api/devices/uno-1` 的 `hub` 欄位列出每個連線被擋下幾則訊息。

**連線紀錄：匯出與重播（V2.12）**：每次連上設備（實體或虛擬都可以）就自動記錄這次連線：量測、引擎實際收到的輸入、模擬算出的輸出、送出的命令與回讀、模式、執行／暫停。「事件與錯誤」卡片上：

- 「匯出紀錄」下載 JSON（格式 `doflab-session` 第 1 版）。
- 「重播剛才的紀錄」或「開啟紀錄檔…」：在模擬中照紀錄的模擬時間重送輸入、重算輸出，和紀錄比對；結果寫進事件紀錄（例如「1 個輸出的變化和紀錄完全相同（逐毫秒相同）；紀錄中送出的 7 個命令，7 個依序出現在重播的輸出中」）。重播不連設備、不送任何命令。可以用來確認「改了行為之後，同樣的輸入會不會得到不同的結果」。手臂專案的重播本版未包含。

**虛擬樹莓派與虛擬 ESP32（V2.13）**：同一台虛擬設備主機可以再加一台樹莓派、一台 ESP32：

```bash
npm run vdev -- --pi --esp32                          # uno-1＋pi-1（工作台 pi-hold-blink）＋esp32-1（工作台 esp32-hold-blink）
npm run vdev -- --pi pi-dist-gauge --esp32 esp32-arm-3dof
```

| | 虛擬 Uno | 虛擬 ESP32 | 虛擬樹莓派 |
|---|---|---|---|
| 晶片端是什麼 | avr8js 執行**真的** DofLabFirmata 機器碼 | **協定模型**：行為和 DofLabFirmata 相同的 JS 程式，**不是實際韌體**（不模擬 ESP32 的指令） | **真的** `pi_bridge.py`（和接實體樹莓派時同一份），GPIO 是 gpiozero 的模擬腳位 |
| 網址 | `ws://127.0.0.1:8770/dev/uno-1` | `…/dev/esp32-1` | `…/dev/pi-1` |
| 工作台預設 | `hold-blink` 等 5 個 | `esp32-hold-blink`、`esp32-night-light`、`esp32-dist-gauge`、`esp32-arm-3dof`、`esp32doit-boot`（DevKit V1 的 BOOT 鍵與藍燈） | `pi-hold-blink`、`pi-dist-gauge`、`pi-arm-3dof` |
| 超音波 | 回波時序 | 回波時序 | 只模擬距離（pi_bridge 在模擬腳位上直接讀距離） |
| 故障注入 | 全部 | 全部 | 網路延遲、掉包、中斷（沒有 RESET 與瞬間斷電） |
| 上傳程式 | 可以（Optiboot） | 不行 | 不能部署（說明原因） |
| 多人 | 控制權（V2.12） | 控制權（V2.12） | pi_bridge 依腳位分配：同一個腳位同時只有一個連線能用 |

觀測頁選「虛擬設備（網址）」時，預設網址依專案的板型；ESP32 的按鈕是「連接虛擬 ESP32（協定模型）」，連線結果、辨識、驗證狀態都寫「協定模型，不是實際韌體」。樹莓派的來源有「網路閘道（實體樹莓派）」與「虛擬設備」兩種。工作台頁（`http://127.0.0.1:8770/?d=pi-1`）上方可以切換設備，腳位依板型寫 D／A 或 GPIO。

ESP32 的協定模型怎麼確認「行為和韌體相同」：把模型換成 Uno 的腳位表，和虛擬 Uno 上的真韌體送同一段 Firmata 訊息，回覆逐位元組相同（`tests/vdev_esp32.test.js`）。它驗證的是協定，不是 ESP32 晶片：韌體在 ESP32 上的錯誤不會在這裡出現。觸控腳不支援同步。

目前的限制：只在本機、沒有通行碼；換工作台要重新啟動主機。後續階段（雲端部署）見 `docs/VIRTUAL_DEVICE_PLAN.md`。

### Raspberry Pi 4B 真機同步

```bash
sudo apt install python3-aiohttp python3-gpiozero python3-lgpio
python3 pi_bridge.py              # 實體 GPIO
python3 pi_bridge.py --mock       # 沒有樹莓派時，用模擬腳位測試流程
python3 pi_bridge.py --bench pi-hold-blink   # 虛擬樹莓派：模擬腳位外面接工作台（通常由 npm run vdev -- --pi 啟動）
```

## 只有一張 ESP32 板子（V2.6）

手邊只有 ESP32 DevKit V1（DOIT，30 腳、板上有藍色 LED 的那種），不需要任何零件也能做三個實驗：

| 實驗 | 用到 | 行為 |
|---|---|---|
| **BOOT 鍵切換藍燈** | BOOT 鍵、藍燈 | 每按一下 BOOT，藍燈切換亮滅；序列埠印出訊息 |
| **觸控檯燈** | D4 觸控腳、藍燈 | 手指碰住 D4 排針時藍燈亮，放開熄滅；序列埠印出「碰到了／放開了」 |
| **BOOT 慢閃、觸控快閃** | BOOT 鍵、D4 觸控腳、藍燈 | 按住 BOOT 慢閃（每 0.5 秒）、碰住 D4 快閃（每 0.1 秒），兩個都按時快閃 |

做法有兩種：

1. **用 DofLab**：板型選「ESP32 DevKit V1（DOIT）」，開始／實驗挑一個（不用接線），在「觀測」頁按 3D 板子上的 BOOT 鍵或碰 D4 排針試模擬，再到「程式」頁確認並產生程式。
2. **直接上傳範例**：`dist/examples/esp32-devkit-v1/` 裡有三個實驗產生好的 `.ino`，用 Arduino IDE 打開即可。

Arduino IDE 設定：開發板管理員安裝「esp32 by Espressif Systems」，板子選 **DOIT ESP32 DEVKIT V1**，序列埠監控視窗選 **115200** baud。上傳卡在 `Connecting....` 時，按住 BOOT 直到開始寫入再放開。觸控程式開機時會先量 0.1 秒的基準值，這段時間不要碰 D4。

這三個實驗只在模擬與編譯上驗證，還沒有在實體板子上試過；觸控的門檻（預設比基準低 40 %）可能需要依你的板子調整。

## 引導實驗

「開始／實驗」列出 18 個現成實驗，每個都鎖定元件與行為，學生只負責接線，完成後依任務清單逐項打勾。

| 實驗 | 元件 | 行為 | 板型 |
|---|---|---|---|
| 按住閃爍 | 按鈕、電阻、LED | 按住時 LED 1 Hz 閃爍，放開立即熄滅 | Uno／ESP32／Pi |
| 按住閃爍（麵包板） | 同上，插在麵包板 | 同上 | Uno／ESP32／Pi |
| 光控夜燈 | 光敏模組、電阻、LED | 亮度低於 30 % 時亮燈 | Uno／ESP32 |
| 伺服角度命令 | 按鈕、伺服 | 按下轉到 150°、放開回到 30° | Uno／ESP32／Pi |
| 三軸機械手臂 | 3 顆伺服、外部 5V 電源 | 拖曳目標點：逆運動學、限位、限速；手臂與控制板、導線在同一個 3D 畫面（V2.6.1）；動作序列 A → B → C → 原點反覆，按「執行」自動、手動操作即切到手動（V2.7） | Uno／ESP32／Pi |
| **按一下切換**（V2.4） | 按鈕、電阻、LED | 每按一下切換亮滅；按住不會連續切換 | Uno／ESP32／Pi |
| **行人按鈕紅綠燈**（V2.4） | 按鈕、紅綠 LED 各一與電阻 | 平時綠燈；按住時紅燈、綠燈滅；放開恢復 | Uno／ESP32／Pi |
| **太亮警示**（V2.4） | 光敏模組、電阻、黃 LED | 亮度超過 70 % 時快速閃爍 | Uno／ESP32 |
| **光控遮陽板**（V2.4） | 光敏模組、伺服 | 亮度超過 60 % 時伺服轉到 150°，否則回到 30° | Uno／ESP32 |
| **雙按鈕雙燈（麵包板）**（V2.4） | 2 按鈕、2 電阻、2 LED，插在麵包板 | 兩組各自切換；練習電源排共地 | Uno／ESP32／Pi |
| **距離警示燈**（V2.5） | 超音波、電阻、LED | 物體近於 20 cm 時 LED 亮 | Uno／ESP32／Pi |
| **感應垃圾桶蓋**（V2.5） | 超音波、SG90 | 手近於 15 cm 時伺服轉到 100°（開蓋），離開回到 10° | Uno／ESP32／Pi |
| **停車場柵欄**（V2.5） | 超音波、SG90、電阻、綠 LED | 車子近於 10 cm 時柵欄抬到 90°、綠燈亮 | Uno／ESP32／Pi |
| **超音波距離指針**（V2.5） | 超音波、SG90 | 60 cm 內伺服角度跟著距離（5 cm → 180°、50 cm → 0°），離開時停在最後位置 | Uno／ESP32／Pi |
| **倒車雷達（麵包板）**（V2.5） | 超音波、2 電阻、黃紅 LED，插在麵包板 | 近於 40 cm 黃燈閃爍，近於 15 cm 紅燈也亮 | Uno／ESP32／Pi |
| **BOOT 鍵切換藍燈**（V2.6） | 只用板子 | 每按一下 BOOT 切換藍燈 | ESP32 DevKit V1 |
| **觸控檯燈**（V2.6） | 只用板子 | 碰住 D4 時藍燈亮 | ESP32 DevKit V1 |
| **BOOT 慢閃、觸控快閃**（V2.6） | 只用板子 | 按住 BOOT 慢閃、碰住 D4 快閃 | ESP32 DevKit V1 |

表中標「ESP32」的實驗，在 ESP32 DevKit V1 上也能用（腳位由接線助手依 30 腳排針重新建議）。

- Raspberry Pi 沒有類比輸入（ADC），用到光敏模組的實驗不提供 Pi 版。
- 伺服角度是送出的命令，SG90 類伺服沒有位置回授，畫面的量測欄會標示「無回授」。

### 超音波測距模組

- 元件清單的「超音波測距」有兩種型號：**HC-SR04**（只能 5 V 供電）與 **HC-SR04P 類**（3.3–5 V 皆可）。ECHO 的高電位等於模組的 VCC，所以：
  - Uno：HC-SR04 接 5V 即可。
  - ESP32、樹莓派（3.3 V 邏輯）：用 HC-SR04P 類模組接 3V3。HC-SR04 接 5V 會被判定為錯誤（ECHO 5 V 會損壞腳位）；接分壓電阻的做法本版不分析。
- 3D 畫面中，HC-SR04 是藍色電路板，3.3 V 版（HC-SR04P 類）是綠色電路板。
- 接線：VCC、GND、TRIG（要能輸出）、ECHO（只能輸入的腳位也可以，例如 ESP32 的 GPIO34–39）。教師模式可以分別指定 TRIG 與 ECHO 腳位。
- 時序：每 60 ms 量一次，規則使用「上一次量到」的距離，所以反應會慢 60–120 ms；沒有回波或超過 4 m 一律當成 400 cm。
- 產生的 Arduino 程式不用 `pulseIn`（它會讓整個程式停住最多數十毫秒），所以閃爍、按鈕與伺服照常運作。V2.13 起 ECHO 的變化由腳位變化中斷記下時間（Uno：PCINT；ESP32：`attachInterrupt`），量到的回波寬度不受迴圈裡其他工作影響：在虛擬 Uno 上，隨機距離、三種迴圈工作量，每一次都量對（回波寬度誤差 ≤ 3 µs，1 cm ≈ 58 µs）。之前每一輪迴圈看一次 ECHO，有伺服的程式約 42 % 少 1 cm。ESP32 版只確認能編譯，沒有執行過。樹莓派版使用 gpiozero 的 `DistanceSensor`。
- 新積木：條件「量到的距離小於／大於 … cm」，動作「伺服角度跟著距離」（線性換算，與 Arduino 的 `map()` 相同）。
- 觀測頁用拉桿移動前方的物體（3D 畫面的橘色板，距離經過壓縮，只是示意），也可以按「移走物體」模擬沒有回波。
- 真機同步：Uno／ESP32 需要 **DofLabFirmata 1.1** 以上（觀測頁按「上傳 DofLabFirmata」即可）；StandardFirmata 沒有超音波功能，距離會顯示「不支援」。唯讀時韌體會每 60 ms 送一次 10 µs 的 TRIG 觸發脈衝，這是量距離必須的輸出。樹莓派經 `pi_bridge.py` 回報。

## 教師模式

按頁首的「教師模式」開啟。

- **接線助手**（「配置」頁右側）：
  - 依目前的元件推算還缺哪些線。「下一條線」會說明為什麼要這樣接，3D 場景用綠色虛線標出兩個端點。
  - 「接這一條」一次接一條，適合上課示範；「全部自動完成」一次接完。隨時都可以按，已經接對的線會保留。
  - 接錯的線只會指出來；勾選「移除接錯的線」才會移除。
  - 勾選「補上缺少的元件」時，LED 沒有限流電阻會自動加一顆（元件在麵包板上就插進麵包板），兩顆以上伺服會加外部 5V 電源。
- **指定腳位**：點選元件，在「選取項目」選腳位；自動接線會照著做。不相容或已被占用時會說明並改用建議腳位。
- **存成引導實驗**：在自訂專案按「存成引導實驗…」。學生版會拿掉所有導線、鎖定元件與行為，任務依元件自動產生；可以要求學生接到相同的腳位，也可以允許學生按「提示下一條線」（只提示，不會自動接線）。
  - 存過的實驗會列在「開始／實驗」裡；按「複製 JSON」交給學生，學生在「專案與版本」匯入即可。

## 上傳到板子

在「程式」頁產生並編譯成功後，右側「上傳到板子」會列出條件；全部符合、逐項勾選確認後才會上傳。

| 板型 | 方式 | 說明 |
|---|---|---|
| Uno | 用瀏覽器上傳（USB） | 需要電腦版 Chrome／Edge。瀏覽器讓板子重置進入 Optiboot，逐頁寫入後讀回比對。不需要編譯服務以外的工具 |
| Uno（虛擬） | 上傳到虛擬 Uno（網路） | 同一個 STK500 上傳經 WebSocket 送到虛擬設備主機（`npm run vdev`）；上傳後開序列埠監看。**虛擬設備，不是實體板子**（V2.11） |
| Uno、ESP32 | 用編譯服務上傳 | 由 `doflab_server.py` 呼叫 `arduino-cli upload`（Uno 用 avrdude、ESP32 用 esptool）。ESP32 若沒有自動進入下載模式，上傳開始時按住 BOOT |
| Raspberry Pi | 部署到樹莓派 | 透過 `pi_bridge.py` 存成 `~/doflab-deploy/main.py` 並執行；畫面顯示輸出，可以停止。關掉網頁後程式仍會繼續執行 |

- 上傳會覆蓋板上原本的程式，包括 DofLabFirmata。要回到「觀測」頁同步，請再按一次「上傳 DofLabFirmata」。
- 上傳前請先在「觀測」頁中斷連線，同一個連接埠不能同時使用。
- 沒有網路或工具裝在非標準位置時，可以用 `DOFLAB_ARDUINO_UPLOAD_PROPS` 指定上傳工具位置，以 `;` 分隔，對應 `arduino-cli upload --upload-property`。

## 麵包板

- 從元件清單拖出「麵包板」，再把 LED、電阻、按鈕、光敏模組拖到麵包板上，就會插入最近的孔；拖離麵包板就拔出。
- 導通規則和實物相同：同一號的 a–e 五孔相通、f–j 五孔相通，中間溝槽兩側不通；上下電源排整條相通。
- 滑過一個孔，整條導通條會標成綠色。導線要接到插著元件那一號的其他孔，不能直接接在元件腳上。
- 兩支腳插在同一條導通條會判定為短路；按鈕要跨在溝槽兩側。
- 引導實驗「按住閃爍（麵包板）」是現成的練習。

## 三自由度機械手臂

開啟引導實驗「三軸機械手臂」，或在有 3 顆伺服的專案裡到「手臂」頁啟用。

- 拖曳橘色球移動目標。「水平 XZ」維持高度不變；「垂直 XY」是面向你的垂直面，可以改變高度。
- 目標不可達時（太遠、太近、低於桌面、超出關節範圍、需要換解翻轉），手臂會保留最後有效的姿態並說明原因。
- 數值輸入與關節滑桿是拖曳的備援。
- 「記下目前姿態」後，「程式」頁可以產生姿態播放程式（限速移動，每個姿態停留 1 秒）。
- 尺寸、範圍、零位與方向都是教學假設，接實物前請逐軸量測並修改；伺服請用外部 5V 電源並與控制板共地。

## 原始碼結構

```
src/core/      與介面無關的核心（Node 與瀏覽器共用同一份檔案）
  boards.js        板型能力資料：Uno R3、ESP32-DevKitC V4、Pi 4B
  breadboard.js    麵包板：孔位、導通條、插入與拔出
  components.js    元件型錄：LED、電阻、按鈕、光敏模組、超音波測距模組、SG90 類伺服、外部 5V 電源
  project.js       專案格式 v2、場景座標與網表、保存／載入／升級、輸入雜湊
  netlist.js       網表分析與電路驗證
  behavior.js      行為 IR、驗證、行為摘要
  engine.js        行為引擎（模擬與真機控制共用）
  codegen.js       Arduino C++／Python 產生器、手改腳位比對
  twin.js          Twin Core：目標／命令／ACK／量測／模擬五層狀態
  session.js       連線紀錄的格式與重播比對（V2.12）
  experiments.js   引導實驗（含老師自訂的實驗）
  autowire.js      接線助手：推算缺少的連線、指定腳位、補元件
  arm.js           三自由度手臂：運動學、限位、連續性、限速、伺服映射
  routing.js       自動整線（A* 正交路由）
src/drivers/   transport.js（傳輸層：USB 序列埠、虛擬設備的 WebSocket）、Firmata 與 Pi 閘道（WebSocket）驅動；stk500.js（瀏覽器上傳到 Uno）
src/ui/        Three.js 場景與擬真模型（models.js）、Blockly 積木、五個分頁、手臂（arm.js）、上傳燒錄（upload.js）、連線紀錄的錄製／匯出／重播（record.js）、教師模式（teacher.js）
tools/         doflab_server.py（編譯服務）、pi_bridge.py（Pi 閘道 v2）、firmware/DofLabFirmata
tools/vdev/    虛擬設備主機：server.js（WebSocket＋HTTP）、hub.js（多人連線與控制權：Firmata 轉接）、netfault.js（網路故障注入）、device.js（每台設備一個 worker）、bench.js（工作台的元件模型）、bench.html（工作台頁）、benches/（工作台預設）、avrsim.js（虛擬 Uno：執行真實 hex，含 Optiboot 與自我燒錄；測試也用它）、esp32model.js（虛擬 ESP32 的協定模型，不是實際韌體）、pihost.js＋pi_bench.py（虛擬樹莓派：啟動 pi_bridge --bench 並轉接）
tests/avr/     pty_uno.js（讓 avrdude 經 pty 上傳到虛擬 Uno）
tests/         Node 單元與等價測試、Python 測試
e2e/           Playwright 端到端測試
```

建置：`npm ci && npm run build`，輸出到 `dist/`（建置產物不進 git）。也可以用 `npm test`（語法檢查＋建置＋Node＋Python 測試）。

開發說明（架構、規則、已知的坑）在 `CLAUDE.md`；「雲端虛擬硬體」的規劃與分階段驗收在 `docs/VIRTUAL_DEVICE_PLAN.md`（第 1 階段已完成）。

## 測試

```bash
node --test --test-concurrency=1 tests/*.test.js     # 198 項（需要 g++；虛擬硬體測試與第 4 階段驗收需要 arduino-cli 與 avr-nm；第 6 階段的虛擬樹莓派需要 Python 的 gpiozero 與 aiohttp）
python3 -m unittest discover -s tests -p "test_*.py" # 20 項（上傳端到端需要 avrdude 與 socat）
python3 e2e/e2e.py                                   # 266 項（需要 Playwright；可只跑部分段落，例如 python3 e2e/e2e.py experiments ultrasonic onboard v27 vdev bench faults vupload vmulti vboards）
```

### 示範影片

```bash
DEMO_OUT=/tmp/doflab-demo python3 e2e/demo_record.py 1 2 3 4 5 6 7   # 逐格錄製 7 章實際操作（每章輸出一個截圖資料夾）
python3 promo/gen_scenes.py                                           # 產生片頭、流程、測試結果、未驗證事項、片尾 5 個場景
```

- 錄影時，`e2e/demo_timeshim.js` 會接管網頁的時間與動畫排程，每格固定推進 40 ms，所以軟體渲染再慢，成片的動作速度也和真實操作一致。
- 第 6 章的虛擬 Uno 也跟著影格推進。
- 游標、字幕與章節卡由 `e2e/demo_overlay.js` 疊加，只在錄影時注入，不屬於產品。
- 成片的分鏡在 `promo/storyboard.json`。

沒有網路、使用系統 avr-gcc 或自行解壓的 ESP32 工具鏈時，可以用 `DOFLAB_ARDUINO_PROPS` 指定工具位置，以 `;` 分隔：

```bash
export DOFLAB_ARDUINO_PROPS="runtime.tools.avr-gcc.path=/usr;runtime.tools.ctags.path=/opt/ctags;runtime.tools.xtensa-esp32-elf-gcc.path=/opt/xtensa-esp32-elf;runtime.tools.esptool_py.path=/opt/esptool"
```

## 擴充方式

- **新增板型**：在 `boards.js` 加一筆能力資料（腳位、能力、電氣限制、工具鏈、3D 排針座標），再寫驅動與測試。只換外觀不算支援。
- **新增元件**：在 `components.js` 加端子與參數，並在 `netlist.js` 補上這個元件的檢查規則。沒有檢查規則的元件，一律會標示為「未檢查」。
- **新增行為積木**：依序更新 `behavior.js`（IR）、`engine.js`、`codegen.js`（兩種語言）與 `blocks.js`，最後重跑等價測試。
