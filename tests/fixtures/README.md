# 測試用韌體

| 檔案 | 來源 | 授權 |
|---|---|---|
| `optiboot_atmega328.hex` | Arduino AVR core 1.8.6 內附的 Optiboot 開機程式（`bootloaders/optiboot/`），未修改 | GPL v2（Optiboot 專案） |
| `StandardFirmata-2.5.9-uno.hex` | Firmata 2.5.9 範例 StandardFirmata，以 arduino-cli 為 Uno 編譯 | LGPL 2.1（Firmata 專案） |
| `DofLabFirmata-uno.hex` | 本專案 `tools/firmware/DofLabFirmata/DofLabFirmata.ino`，以 arduino-cli 為 Uno 編譯；`tests/upload_avr.test.js` 會確認它與原始碼的編譯結果一致 | 同本專案 |

這些 hex 只在虛擬晶片（avr8js）上執行，用來驗證驅動、產生的程式與上傳流程；`DofLabFirmata-uno.hex` 另內嵌在網頁中，供「觀測」頁一鍵上傳。
