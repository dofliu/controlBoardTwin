/* DofLab — 板型能力資料（capability descriptors）
 * 每塊板子描述：腳位、能力、電氣限制、程式語言與工具鏈、3D 排針座標。
 * 新增板型 = 在這裡加一筆資料 + 驅動 + 測試；不要把板子規則散落在介面裡。
 * 座標單位：公分（scene units）。板子中心在原點，X 向右、Z 向下（俯視）。
 */
(function (root) {
  const DL = (root.DL = root.DL || {});

  // caps: din 數位輸入、dout 數位輸出、pullup 內建上拉、pwm、adc、servo（可產生伺服脈波）
  function gpio(id, num, caps, extra) {
    return Object.assign({ id, label: id, kind: 'gpio', num, caps, notes: [] }, extra || {});
  }
  function power(id, volts, extra) { return Object.assign({ id, label: id, kind: 'power', volts, caps: [], notes: [] }, extra || {}); }
  function gnd(id, extra) { return Object.assign({ id, label: 'GND', kind: 'gnd', caps: [], notes: [] }, extra || {}); }
  function other(id, label, note) { return { id, label: label || id, kind: 'other', caps: [], notes: note ? [note] : [] }; }

  /* ---------------- Arduino Uno R3 ---------------- */
  const P = 0.254;
  const uno = (() => {
    const pins = [];
    const D = ['din', 'dout', 'pullup', 'servo'];
    for (let n = 0; n <= 13; n++) {
      const caps = D.slice();
      if ([3, 5, 6, 9, 10, 11].includes(n)) caps.push('pwm');
      const notes = [];
      if (n === 0 || n === 1) notes.push({ level: 'warn', text: `D${n} 是 USB 序列埠（${n === 0 ? 'RX' : 'TX'}），接元件會干擾上傳與 Serial／Firmata 通訊。` });
      if (n === 13) notes.push({ level: 'info', text: 'D13 也接到板上的 L 指示燈。' });
      pins.push(gpio('D' + n, n, caps, { notes }));
    }
    for (let a = 0; a <= 5; a++) {
      const notes = a >= 4 ? [{ level: 'info', text: `A${a} 同時是 I²C 的 ${a === 4 ? 'SDA' : 'SCL'}。` }] : [];
      pins.push(gpio('A' + a, 14 + a, ['din', 'dout', 'pullup', 'adc', 'servo'], { code: 'A' + a, notes }));
    }
    pins.push(power('5V', 5), power('3V3', 3.3, { label: '3.3V', maxmA: 50 }), power('VIN', null, { label: 'VIN' }));
    pins.push(gnd('GND1'), gnd('GND2'), gnd('GND3'));
    pins.push(other('AREF'), other('IOREF'), other('RESET'));
    // 3D 排針：上緣數位排針、下緣電源與類比排針
    const W = 6.86, H = 5.34;
    // 依 Uno R3 機構圖（英吋，從 USB 那一側的板緣量起）：D8 與 D7 之間是 0.16 吋（不是 0.1 吋）的著名間距
    const topIn = { SCL: 0.74, SDA: 0.84, AREF: 0.94, GND3: 1.04, D13: 1.14, D12: 1.24, D11: 1.34, D10: 1.44, D9: 1.54, D8: 1.64, D7: 1.8, D6: 1.9, D5: 2.0, D4: 2.1, D3: 2.2, D2: 2.3, D1: 2.4, D0: 2.5 };
    const botIn = { NC: 1.1, IOREF: 1.2, RESET: 1.3, '3V3': 1.4, '5V': 1.5, GND1: 1.6, GND2: 1.7, VIN: 1.8, A0: 2.0, A1: 2.1, A2: 2.2, A3: 2.3, A4: 2.4, A5: 2.5 };
    const layout = {}, layoutExtra = {};   // layoutExtra：排母上有、但本版不提供接線的位置（SCL／SDA 與 A5／A4 相同、NC 未連接）
    for (const [id, inch] of Object.entries(topIn)) (['SCL', 'SDA'].includes(id) ? layoutExtra : layout)[id] = { x: -W / 2 + inch * 2.54, z: -H / 2 + 0.254, side: 'top' };
    for (const [id, inch] of Object.entries(botIn)) (id === 'NC' ? layoutExtra : layout)[id] = { x: -W / 2 + inch * 2.54, z: H / 2 - 0.254, side: 'bottom' };
    return {
      id: 'uno', name: 'Arduino Uno R3', short: 'Uno R3', mcu: 'ATmega328P', logicV: 5, maxPinmA: 20, absMaxPinmA: 40,
      adcBits: 10, lang: 'arduino', fqbn: 'arduino:avr:uno', libs: { servo: 'Servo' },
      driver: 'firmata', firmataPins: 20, capabilityVersion: '2026.10-1',
      size: { w: W, h: H, t: 0.16 }, color: '#1d5a8a', pins, layout, layoutExtra,
      onboard: { led: 'D13' }, features: { led: { x: 29.5 / 10 - W / 2, z: H / 2 - 4.56 } },
      notes: ['5V 邏輯；單一腳位建議 20 mA 以下（絕對上限 40 mA）。']
    };
  })();

  /* ---------------- ESP32-DevKitC V4 ---------------- */
  // ESP32-WROOM-32 的腳位能力（DevKitC V4 與 DevKit V1 共用）；internal：不在排針上的腳位（例如 DevKit V1 的 GPIO0 只接到 BOOT 鍵）
  function esp32Pins(internal) {
    const pins = [];
    const strap = { 0: '開機模式腳（strapping），上電時被拉低會進入下載模式。', 2: '開機模式腳（strapping），接到會拉低的元件可能影響上傳。', 5: '開機模式腳（strapping）。', 12: '開機模式腳（MTDI），上電時為高電位會把快閃記憶體電壓設錯，避免接上拉。', 15: '開機模式腳（MTDO），影響開機訊息輸出。' };
    const adc2 = [0, 2, 4, 12, 13, 14, 15, 25, 26, 27];
    const adc1 = [32, 33, 34, 35, 36, 39];
    const nums = [0, 1, 2, 3, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33, 34, 35, 36, 39];
    for (const n of nums) {
      const inputOnly = n >= 34;
      const caps = inputOnly ? ['din'] : ['din', 'dout', 'pullup', 'pwm', 'servo'];
      if (adc1.includes(n) || adc2.includes(n)) caps.push('adc');
      const notes = [];
      if (inputOnly) notes.push({ level: 'info', text: `GPIO${n} 只能當輸入，而且沒有內建上拉／下拉電阻。` });
      if (strap[n]) notes.push({ level: 'warn', text: strap[n] });
      if (adc2.includes(n)) notes.push({ level: 'info', text: `GPIO${n} 屬於 ADC2，開啟 Wi-Fi 時無法讀類比值。` });
      if (n === 1 || n === 3) notes.push({ level: 'warn', text: `GPIO${n} 是 USB 序列埠（${n === 1 ? 'TX0' : 'RX0'}），接元件會干擾上傳與序列監控。` });
      const label = n === 36 ? 'VP' : n === 39 ? 'VN' : n === 1 ? 'TX' : n === 3 ? 'RX' : String(n);
      if ([4, 0, 2, 15, 13, 12, 14, 27, 33, 32].includes(n)) caps.push('touch');   // 電容式觸控 T0–T9
      pins.push(gpio('GPIO' + n, n, caps, { label: n === 36 || n === 39 || n === 1 || n === 3 ? `${label}(${n})` : 'IO' + n, notes, internal: (internal || []).includes(n) }));
    }
    return pins;
  }
  const esp32 = (() => {
    const pins = esp32Pins();
    pins.push(power('3V3', 3.3, { label: '3V3' }), power('5V', 5, { label: '5V', notes: [{ level: 'info', text: '5V 來自 USB，只能供電，不能接到任何 GPIO。' }] }));
    pins.push(gnd('GND1'), gnd('GND2'), gnd('GND3'));
    pins.push(other('EN', 'EN', '重置腳'));
    for (const n of [6, 7, 8, 9, 10, 11]) pins.push(other('FLASH' + n, ['CLK', 'D0', 'D1', 'D2', 'D3', 'CMD'][n - 6], `GPIO${n} 接內部快閃記憶體，不可使用。`));
    const W = 5.5, H = 2.8;
    const left = ['3V3', 'EN', 'GPIO36', 'GPIO39', 'GPIO34', 'GPIO35', 'GPIO32', 'GPIO33', 'GPIO25', 'GPIO26', 'GPIO27', 'GPIO14', 'GPIO12', 'GND1', 'GPIO13', 'FLASH9', 'FLASH10', 'FLASH11', '5V'];
    const right = ['GND2', 'GPIO23', 'GPIO22', 'GPIO1', 'GPIO3', 'GPIO21', 'GND3', 'GPIO19', 'GPIO18', 'GPIO5', 'GPIO17', 'GPIO16', 'GPIO4', 'GPIO0', 'GPIO2', 'GPIO15', 'FLASH8', 'FLASH7', 'FLASH6'];
    const layout = {};
    // 板子橫放：天線在左（-X），USB 在右（+X）。上排＝J2，下排＝J3。
    // 兩排相距 1 吋（25.4 mm），所以 DevKitC 插在一般麵包板上會蓋住所有孔
    left.forEach((id, i) => { layout[id] = { x: -W / 2 + 0.45 + i * P, z: -1.27, side: 'top' }; });
    right.forEach((id, i) => { layout[id] = { x: -W / 2 + 0.45 + i * P, z: 1.27, side: 'bottom' }; });
    return {
      id: 'esp32', name: 'ESP32-DevKitC V4', short: 'ESP32', mcu: 'ESP32-WROOM-32', logicV: 3.3, maxPinmA: 20, absMaxPinmA: 40,
      adcBits: 12, lang: 'arduino', fqbn: 'esp32:esp32:esp32', libs: { servo: 'ESP32Servo' },
      driver: 'firmata', firmataPins: 40, capabilityVersion: '2026.10-1',
      size: { w: W, h: H, t: 0.16 }, color: '#2b2f36', pins, layout, family: 'esp32',
      onboard: { boot: 'GPIO0' }, features: { boot: { x: W / 2 - 0.85, z: 0.55 } },
      notes: ['3.3V 邏輯，GPIO 不耐 5V。', '真機同步需先上傳 DofLabFirmata 韌體（StandardFirmata 不支援 ESP32）。', '板上有 BOOT 鍵（GPIO0）；沒有可程式控制的 LED。']
    };
  })();

  /* ---------------- ESP32 DevKit V1（DOIT，30 腳，ESP32-WROOM-32） ----------------
   * 板上：藍色 LED 接 GPIO2（HIGH 亮）、紅色電源燈、EN（重置）與 BOOT（GPIO0，按下 = LOW，板上有上拉電阻）兩顆按鍵。
   * GPIO0 不在排針上；兩排相距 0.9 吋（22.86 mm）。 */
  const esp32doit = (() => {
    const pins = esp32Pins([0]).filter(p => ![6, 7, 8, 9, 10, 11].includes(p.num));
    for (const p of pins) if (p.num === 2) p.notes.push({ level: 'info', text: 'GPIO2 接到板上的藍色 LED（HIGH 亮）。' });
    for (const p of pins) if (p.num === 0) { p.label = 'GPIO0（BOOT）'; p.notes.push({ level: 'info', text: 'GPIO0 只接到板上的 BOOT 鍵，不在排針上。' }); }
    pins.push(power('3V3', 3.3, { label: '3V3' }), power('5V', 5, { label: 'VIN', notes: [{ level: 'info', text: 'VIN：接 USB 時約 5 V，只能供電，不能接到任何 GPIO。' }] }));
    pins.push(gnd('GND1'), gnd('GND2'));
    pins.push(other('EN', 'EN', '重置腳'));
    const W = 5.14, H = 2.83;
    // 天線在左（-X），micro-USB 在右（+X）
    const top = ['GPIO23', 'GPIO22', 'GPIO1', 'GPIO3', 'GPIO21', 'GPIO19', 'GPIO18', 'GPIO5', 'GPIO17', 'GPIO16', 'GPIO4', 'GPIO2', 'GPIO15', 'GND2', '3V3'];
    const bottom = ['EN', 'GPIO36', 'GPIO39', 'GPIO34', 'GPIO35', 'GPIO32', 'GPIO33', 'GPIO25', 'GPIO26', 'GPIO27', 'GPIO14', 'GPIO12', 'GPIO13', 'GND1', '5V'];
    const layout = {};
    top.forEach((id, i) => { layout[id] = { x: -W / 2 + 1.2 + i * P, z: -1.143, side: 'top' }; });
    bottom.forEach((id, i) => { layout[id] = { x: -W / 2 + 1.2 + i * P, z: 1.143, side: 'bottom' }; });
    for (const p of pins) if (p.kind === 'gpio' && p.num !== 0 && p.num !== 36 && p.num !== 39 && p.num !== 1 && p.num !== 3) p.label = 'D' + p.num;   // 板上絲印：D2、D4…
    return {
      id: 'esp32doit', name: 'ESP32 DevKit V1（DOIT，30 腳）', short: 'ESP32 V1', mcu: 'ESP32-WROOM-32', logicV: 3.3, maxPinmA: 20, absMaxPinmA: 40,
      adcBits: 12, lang: 'arduino', fqbn: 'esp32:esp32:esp32doit-devkit-v1', libs: { servo: 'ESP32Servo' },
      driver: 'firmata', firmataPins: 40, capabilityVersion: '2026.10-1', family: 'esp32',
      size: { w: W, h: H, t: 0.16 }, color: '#1f2a44', pins, layout,
      onboard: { led: 'GPIO2', boot: 'GPIO0' },
      features: { led: { x: W / 2 - 1.05, z: 0.42 }, pwr: { x: W / 2 - 1.05, z: -0.42 }, boot: { x: W / 2 - 0.62, z: 0.66 }, en: { x: W / 2 - 0.62, z: -0.66 } },
      notes: ['3.3V 邏輯，GPIO 不耐 5V。', '板上：藍色 LED（GPIO2）、BOOT 鍵（GPIO0）、EN 重置鍵；觸控腳（T0 = D4 等）用手指碰排針即可。', '腳位編號與 ESP32-DevKitC 相同，程式可以共用。']
    };
  })();

  /* ---------------- Raspberry Pi 4 Model B ---------------- */
  const pi4 = (() => {
    const map = {
      1: '3V3', 2: '5V', 3: 2, 4: '5V', 5: 3, 6: 'GND', 7: 4, 8: 14, 9: 'GND', 10: 15, 11: 17, 12: 18, 13: 27, 14: 'GND', 15: 22, 16: 23, 17: '3V3', 18: 24, 19: 10, 20: 'GND',
      21: 9, 22: 25, 23: 11, 24: 8, 25: 'GND', 26: 7, 27: 'ID_SD', 28: 'ID_SC', 29: 5, 30: 'GND', 31: 6, 32: 12, 33: 13, 34: 'GND', 35: 19, 36: 16, 37: 26, 38: 20, 39: 'GND', 40: 21
    };
    const pins = []; const layout = {};
    const W = 8.5, H = 5.6;
    let g = 0, v3 = 0, v5 = 0;
    for (let phys = 1; phys <= 40; phys++) {
      const m = map[phys]; let pin;
      if (typeof m === 'number') {
        const caps = ['din', 'dout', 'pullup', 'servo'];
        if ([12, 13, 18, 19].includes(m)) caps.push('pwm');
        const notes = [];
        if (m === 2 || m === 3) notes.push({ level: 'info', text: `GPIO${m} 是 I²C，板上有固定 1.8 kΩ 上拉電阻。` });
        if (m === 14 || m === 15) notes.push({ level: 'info', text: `GPIO${m} 是 UART（${m === 14 ? 'TXD' : 'RXD'}）。` });
        if ([7, 8, 9, 10, 11].includes(m)) notes.push({ level: 'info', text: `GPIO${m} 屬於 SPI0。` });
        pin = gpio('GPIO' + m, m, caps, { label: 'GPIO' + m, phys, notes });
      } else if (m === 'GND') pin = gnd('GND' + (++g), { phys });
      else if (m === '3V3') pin = power('3V3_' + (++v3), 3.3, { label: '3.3V', phys });
      else if (m === '5V') pin = power('5V_' + (++v5), 5, { label: '5V', phys, notes: [{ level: 'info', text: '5V 只能供電，不能接到任何 GPIO。' }] });
      else pin = other(m, m, 'HAT EEPROM 專用，請勿使用。');
      pin.phys = phys;
      pins.push(pin);
      const col = Math.floor((phys - 1) / 2);
      // 40 針排針置中於兩個安裝孔（3.5 mm、61.5 mm）之間：第 1 腳在 x = 32.5 − 9.5 × 2.54 ≈ 8.37 mm
      layout[pin.id] = { x: -W / 2 + 0.837 + col * P, z: -H / 2 + (phys % 2 ? 0.477 : 0.223), side: 'top' };
    }
    return {
      id: 'pi4b', name: 'Raspberry Pi 4 Model B', short: 'Pi 4B', mcu: 'BCM2711（Linux 單板電腦）', logicV: 3.3, maxPinmA: 16, absMaxPinmA: 16,
      adcBits: 0, lang: 'python', fqbn: null, libs: { servo: 'gpiozero.AngularServo' },
      driver: 'pibridge', capabilityVersion: '2026.10-1',
      size: { w: W, h: H, t: 0.14 }, color: '#2f7a4a', pins, layout,
      notes: ['Linux 單板電腦，不是微控制器；程式以 Python 在作業系統上執行，時間精度受排程影響。', '3.3V 邏輯，GPIO 不耐 5V；沒有內建類比輸入（ADC）。', '與 Raspberry Pi Pico（RP2040 微控制器）是不同板型，需另建能力資料。']
    };
  })();

  const BOARDS = { uno, esp32, esp32doit, pi4b: pi4 };
  for (const b of Object.values(BOARDS)) {
    b.pinById = {};
    for (const p of b.pins) b.pinById[p.id] = p;
    b.codeName = p => (b.lang === 'python' ? String(p.num) : p.code || String(p.num));
    b.pinLabel = p => (b.id === 'pi4b' && p.kind === 'gpio' ? `GPIO${p.num}（pin ${p.phys}）` : p.label);
  }

  DL.boards = BOARDS;
  DL.boardList = ['uno', 'esp32', 'esp32doit', 'pi4b'];
  DL.boardFamily = id => (BOARDS[id] && BOARDS[id].family) || id;   // 同一顆晶片的不同開發板（ESP32 DevKitC／DevKit V1）共用實驗與建議腳位
  if (typeof module !== 'undefined') module.exports = DL;
})(typeof globalThis !== 'undefined' ? globalThis : this);
