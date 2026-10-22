# DofLab V2.4 原型

從電路配置、行為設計、模擬測試，到真實設備同步的教學與開發平台。本版依《DofLab 規劃文件 v0.1》重新開發。

## 立即使用

| 情境 | 做法 |
|---|---|
| 只想看介面、模擬 | 直接用瀏覽器開 `dist/index.html`（Chrome／Edge／Safari 都可） |
| 要編譯程式、連接 Arduino Uno | 在電腦執行 `python3 dist/doflab_server.py`，開 `http://localhost:8766` |
| 要連接 Raspberry Pi 4B | 把 `dist/` 整個資料夾複製到樹莓派，執行 `python3 pi_bridge.py`，用同網路電腦開 `http://<樹莓派IP>:8765` |

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

### Raspberry Pi 4B 真機同步

```bash
sudo apt install python3-aiohttp python3-gpiozero python3-lgpio
python3 pi_bridge.py              # 實體 GPIO
python3 pi_bridge.py --mock       # 沒有樹莓派時，用模擬腳位測試流程
```

## 引導實驗

「開始／實驗」列出 10 個現成實驗，每個都鎖定元件與行為，學生只負責接線，完成後依任務清單逐項打勾。

| 實驗 | 元件 | 行為 | 板型 |
|---|---|---|---|
| 按住閃爍 | 按鈕、電阻、LED | 按住時 LED 1 Hz 閃爍，放開立即熄滅 | Uno／ESP32／Pi |
| 按住閃爍（麵包板） | 同上，插在麵包板 | 同上 | Uno／ESP32／Pi |
| 光控夜燈 | 光敏模組、電阻、LED | 亮度低於 30 % 時亮燈 | Uno／ESP32 |
| 伺服角度命令 | 按鈕、伺服 | 按下轉到 150°、放開回到 30° | Uno／ESP32／Pi |
| 三軸機械手臂 | 3 顆伺服、外部 5V 電源 | 拖曳目標點：逆運動學、限位、限速 | Uno／ESP32／Pi |
| **按一下切換**（V2.4） | 按鈕、電阻、LED | 每按一下切換亮滅；按住不會連續切換 | Uno／ESP32／Pi |
| **行人按鈕紅綠燈**（V2.4） | 按鈕、紅綠 LED 各一與電阻 | 平時綠燈；按住時紅燈、綠燈滅；放開恢復 | Uno／ESP32／Pi |
| **太亮警示**（V2.4） | 光敏模組、電阻、黃 LED | 亮度超過 70 % 時快速閃爍 | Uno／ESP32 |
| **光控遮陽板**（V2.4） | 光敏模組、伺服 | 亮度超過 60 % 時伺服轉到 150°，否則回到 30° | Uno／ESP32 |
| **雙按鈕雙燈（麵包板）**（V2.4） | 2 按鈕、2 電阻、2 LED，插在麵包板 | 兩組各自切換；練習電源排共地 | Uno／ESP32／Pi |

- Raspberry Pi 沒有類比輸入（ADC），用到光敏模組的實驗不提供 Pi 版。
- 伺服角度是送出的命令，SG90 類伺服沒有位置回授，畫面的量測欄會標示「無回授」。

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
  components.js    元件型錄：LED、電阻、按鈕、光敏模組、SG90 類伺服、外部 5V 電源
  project.js       專案格式 v2、場景座標與網表、保存／載入／升級、輸入雜湊
  netlist.js       網表分析與電路驗證
  behavior.js      行為 IR、驗證、行為摘要
  engine.js        行為引擎（模擬與真機控制共用）
  codegen.js       Arduino C++／Python 產生器、手改腳位比對
  twin.js          Twin Core：目標／命令／ACK／量測／模擬五層狀態
  experiments.js   引導實驗（含老師自訂的實驗）
  autowire.js      接線助手：推算缺少的連線、指定腳位、補元件
  arm.js           三自由度手臂：運動學、限位、連續性、限速、伺服映射
  routing.js       自動整線（A* 正交路由）
src/drivers/   Firmata（Web Serial）與 Pi 閘道（WebSocket）驅動；stk500.js（瀏覽器上傳到 Uno）
src/ui/        Three.js 場景與擬真模型（models.js）、Blockly 積木、五個分頁、手臂（arm.js）、上傳燒錄（upload.js）、教師模式（teacher.js）
tools/         doflab_server.py（編譯服務）、pi_bridge.py（Pi 閘道 v2）、firmware/DofLabFirmata
tests/avr/     虛擬 Uno（avr8js）：執行真實 hex（含 Optiboot 開機程式與自我燒錄），驗證驅動、產生的程式與上傳
tests/         Node 單元與等價測試、Python 測試
e2e/           Playwright 端到端測試
```

建置：`npm install && node build.js`，輸出到 `dist/`。

## 測試

```bash
node --test --test-concurrency=1 tests/*.test.js     # 79 項（需要 g++；虛擬硬體測試需要 arduino-cli 與 avr-nm）
python3 -m unittest discover -s tests -p "test_*.py" # 14 項（上傳端到端需要 avrdude 與 socat）
python3 e2e/e2e.py                                   # 124 項（需要 Playwright；可只跑部分段落，例如 python3 e2e/e2e.py breadboard experiments）
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
