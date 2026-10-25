/*
 * DofLabFirmata — DofLab 用的精簡 Firmata 相容韌體（Arduino Uno、ESP32-DevKitC）
 *
 * 與 StandardFirmata 的差異：
 *   - 開機時所有腳位維持「輸入、無上拉」，不會自行改成輸出（StandardFirmata 會設為 OUTPUT LOW）
 *   - 開機不閃燈，立刻回報版本，連線較快
 *   - 只實作 DofLab 需要的訊息：版本、韌體名稱、能力、類比對應、腳位模式、數位回報、
 *     類比回報、設定腳位值、伺服角度、腳位狀態回讀（作為 ACK）、系統重設
 *   - DofLab 擴充（韌體版本 1.1 起）：超音波測距（HC-SR04 類）
 *       設定 F0 62 <trig> <echo> F7（trig = 7F 表示全部停止）
 *       回報 F0 63 <trig> <cm 低 7 位元> <cm 高 7 位元> F7（每 60 ms 量一次，量完就回報；沒有回波 = 400）
 *       不用 pulseIn：每一輪 loop 看一次 ECHO，所以量測時序列埠與其他回報照常運作
 *   - 斷線保護（韌體版本 1.2 起）：有輸出（數位輸出或伺服）時，OUTPUT_GUARD_MS 內沒有收到任何位元組，就把輸出關掉——
 *       數位輸出寫 LOW 再改成輸入、伺服停止送脈衝並改成輸入（不寫角度，否則會轉到 0°），然後送出 F0 64 F7。
 *       DofLab 每秒送一次查詢（心跳），所以正常連線時不會觸發；分頁關掉、電腦睡眠、網路斷了時，輸出不會停在最後的命令。
 *       超音波的觸發與輸入回報不受影響。
 * 序列埠 57600 bps。協定版本回報為 2.6；韌體名稱 DofLabFirmata、版本 1.2。
 * 授權：MIT（DofLab 原型）
 */
#if defined(ARDUINO_ARCH_ESP32)
  #include <ESP32Servo.h>
  #define TOTAL_PINS 40
  static bool pinValid(uint8_t p) { return (p <= 5) || (p >= 12 && p <= 19) || (p >= 21 && p <= 23) || (p >= 25 && p <= 27) || (p >= 32 && p <= 36) || p == 39; }
  static bool pinInputOnly(uint8_t p) { return p >= 34; }
  static int8_t pinToAnalog(uint8_t p) { const uint8_t a[] = {32, 33, 34, 35, 36, 39}; for (uint8_t i = 0; i < 6; i++) if (a[i] == p) return i; return -1; }
  static uint8_t analogToPin(uint8_t ch) { const uint8_t a[] = {32, 33, 34, 35, 36, 39}; return a[ch]; }
  #define ADC_BITS 12
  #define MAX_SERVOS 8
#else
  #include <Servo.h>
  #define TOTAL_PINS 20
  static bool pinValid(uint8_t p) { return p < TOTAL_PINS; }
  static bool pinInputOnly(uint8_t p) { return false; }
  static int8_t pinToAnalog(uint8_t p) { return p >= 14 ? (int8_t)(p - 14) : -1; }
  static uint8_t analogToPin(uint8_t ch) { return 14 + ch; }
  #define ADC_BITS 10
  #define MAX_SERVOS 6
#endif
#define ANALOG_CHANNELS 6

enum { M_INPUT = 0, M_OUTPUT = 1, M_ANALOG = 2, M_SERVO = 4, M_PULLUP = 0x0B, M_SONAR = 0x0C, M_UNSET = 0x7F };
#define MAX_SONARS 2
#define SONAR_PERIOD_MS 60
#define SONAR_TIMEOUT_US 30000UL
#define SONAR_MAX_CM 400
#define OUTPUT_GUARD_MS 3000   // 斷線保護：有輸出時這麼久沒收到位元組就關掉輸出（DofLab 每 1 秒送一次心跳）
unsigned long lastRx = 0;
struct Sonar { bool on; uint8_t trig, echo, state; unsigned long due, t0; };
Sonar sonar[MAX_SONARS];
uint8_t pinMode_[TOTAL_PINS];
uint8_t pinState_[TOTAL_PINS];   // 輸出值或伺服角度
int servoOf[TOTAL_PINS];
Servo servos[MAX_SERVOS];
uint8_t reportPort[(TOTAL_PINS + 7) / 8];
uint8_t lastPort[(TOTAL_PINS + 7) / 8];
uint8_t reportAnalog = 0;
unsigned long lastAnalog = 0;
uint8_t buf[32]; uint8_t blen = 0; bool sysex = false; uint8_t cmd = 0; uint8_t need = 0;

void sendVersion() { Serial.write(0xF9); Serial.write(2); Serial.write(6); }
void sendFirmware() {
  const char *name = "DofLabFirmata";
  Serial.write(0xF0); Serial.write(0x79); Serial.write(1); Serial.write(2);   // 韌體版本 1.2（1.1 起支援超音波、1.2 起有斷線保護）
  for (const char *c = name; *c; c++) { Serial.write(*c & 0x7F); Serial.write(0); }
  Serial.write(0xF7);
}
uint8_t readPort(uint8_t port) {
  uint8_t v = 0;
  for (uint8_t i = 0; i < 8; i++) {
    uint8_t p = port * 8 + i;
    if (p >= TOTAL_PINS || !pinValid(p)) continue;
    if (pinMode_[p] == M_INPUT || pinMode_[p] == M_PULLUP) { if (digitalRead(p)) v |= 1 << i; }
    else if (pinMode_[p] == M_OUTPUT && pinState_[p]) v |= 1 << i;
  }
  return v;
}
void sendPort(uint8_t port) { uint8_t v = readPort(port); Serial.write(0x90 | port); Serial.write(v & 0x7F); Serial.write(v >> 7); lastPort[port] = v; }

void detachServo(uint8_t p) { if (servoOf[p] >= 0) { servos[servoOf[p]].detach(); servoOf[p] = -1; } }
void setMode(uint8_t p, uint8_t m) {
  if (p >= TOTAL_PINS || !pinValid(p)) return;
  if (pinInputOnly(p) && (m == M_OUTPUT || m == M_SERVO || m == M_PULLUP)) return;   // 只能輸入的腳位：拒絕
  if (m != M_SERVO) detachServo(p);
  if (m == M_INPUT) pinMode(p, INPUT);
  else if (m == M_PULLUP) pinMode(p, INPUT_PULLUP);
  else if (m == M_OUTPUT) { digitalWrite(p, LOW); pinMode(p, OUTPUT); pinState_[p] = 0; }
  else if (m == M_ANALOG) { if (pinToAnalog(p) < 0) return; pinMode(p, INPUT); }
  else if (m == M_SERVO) {
    if (servoOf[p] < 0) { for (uint8_t i = 0; i < MAX_SERVOS; i++) { bool used = false; for (uint8_t q = 0; q < TOTAL_PINS; q++) if (servoOf[q] == i) used = true; if (!used) { servoOf[p] = i; break; } } }
    if (servoOf[p] < 0) return;
    servos[servoOf[p]].attach(p, 544, 2400);
  } else return;
  pinMode_[p] = m;
}
void setValue(uint8_t p, int v) {
  if (p >= TOTAL_PINS) return;
  if (pinMode_[p] == M_OUTPUT) { pinState_[p] = v ? 1 : 0; digitalWrite(p, v ? HIGH : LOW); }
  else if (pinMode_[p] == M_SERVO && servoOf[p] >= 0) { if (v > 180) v = 180; pinState_[p] = v; servos[servoOf[p]].write(v); }
}
void sendSonar(uint8_t i, int cm) { Serial.write(0xF0); Serial.write(0x63); Serial.write(sonar[i].trig); Serial.write(cm & 0x7F); Serial.write((cm >> 7) & 0x7F); Serial.write(0xF7); }
void sonarStop() {
  for (uint8_t i = 0; i < MAX_SONARS; i++) if (sonar[i].on) {
    sonar[i].on = false;
    pinMode(sonar[i].trig, INPUT); pinMode_[sonar[i].trig] = M_INPUT; pinMode_[sonar[i].echo] = M_INPUT;
  }
}
// 設定超音波：TRIG 設為輸出（LOW）、ECHO 設為輸入；這兩個腳位不再出現在數位回報裡
void sonarConfig(uint8_t trig, uint8_t echo) {
  if (trig == 0x7F) { sonarStop(); return; }
  if (trig >= TOTAL_PINS || echo >= TOTAL_PINS || !pinValid(trig) || !pinValid(echo) || trig == echo || pinInputOnly(trig)) return;
  int8_t slot = -1;
  for (uint8_t i = 0; i < MAX_SONARS; i++) if (sonar[i].on && sonar[i].trig == trig) slot = i;
  for (uint8_t i = 0; i < MAX_SONARS && slot < 0; i++) if (!sonar[i].on) slot = i;
  if (slot < 0) return;
  detachServo(trig); detachServo(echo);
  digitalWrite(trig, LOW); pinMode(trig, OUTPUT); pinMode(echo, INPUT);
  pinMode_[trig] = M_SONAR; pinMode_[echo] = M_SONAR;
  sonar[slot].on = true; sonar[slot].trig = trig; sonar[slot].echo = echo; sonar[slot].state = 0; sonar[slot].due = millis();
}
// 與 DofLab 產生的程式相同的非阻塞量測
void sonarUpdate() {
  unsigned long now = millis();
  for (uint8_t i = 0; i < MAX_SONARS; i++) {
    Sonar &s = sonar[i]; if (!s.on) continue;
    if (s.state == 1) {
      if (digitalRead(s.echo) == HIGH) { s.t0 = micros(); s.state = 2; }
      else if (micros() - s.t0 > SONAR_TIMEOUT_US) { sendSonar(i, SONAR_MAX_CM); s.state = 0; }
    } else if (s.state == 2) {
      unsigned long w = micros() - s.t0;
      if (digitalRead(s.echo) == LOW) { unsigned long cm = w / 58; sendSonar(i, cm > SONAR_MAX_CM ? SONAR_MAX_CM : (int)cm); s.state = 0; }
      else if (w > SONAR_TIMEOUT_US) { sendSonar(i, SONAR_MAX_CM); s.state = 0; }
    }
    if (s.state == 0 && (long)(now - s.due) >= 0 && digitalRead(s.echo) == LOW) {
      s.due = now + SONAR_PERIOD_MS;
      digitalWrite(s.trig, HIGH); delayMicroseconds(10); digitalWrite(s.trig, LOW);
      s.t0 = micros(); s.state = 1;
    }
  }
}

// 斷線保護：關掉所有輸出（和 DofLab 撤銷授權時做的事相同），有關掉東西才通知
void outputGuard() {
  if (millis() - lastRx < OUTPUT_GUARD_MS) return;
  bool any = false;
  for (uint8_t p = 0; p < TOTAL_PINS; p++) {
    if (pinMode_[p] != M_OUTPUT && pinMode_[p] != M_SERVO) continue;
    any = true;
    if (pinMode_[p] == M_OUTPUT) digitalWrite(p, LOW);
    detachServo(p); pinMode(p, INPUT); pinMode_[p] = M_INPUT; pinState_[p] = 0;
  }
  if (any) { Serial.write(0xF0); Serial.write(0x64); Serial.write(0xF7); }
}

void resetAll() {
  sonarStop();
  for (uint8_t p = 0; p < TOTAL_PINS; p++) { if (pinMode_[p] == M_SERVO) detachServo(p); if (pinValid(p) && pinMode_[p] != M_UNSET && p > 1) pinMode(p, INPUT); pinMode_[p] = pinValid(p) ? M_INPUT : M_UNSET; pinState_[p] = 0; servoOf[p] = -1; }
  for (uint8_t i = 0; i < sizeof(reportPort); i++) { reportPort[i] = 0; lastPort[i] = 0; }
  reportAnalog = 0;
}

void handleSysex() {
  uint8_t c = buf[0];
  if (c == 0x79) sendFirmware();
  else if (c == 0x6B) {                 // CAPABILITY_QUERY
    Serial.write(0xF0); Serial.write(0x6C);
    for (uint8_t p = 0; p < TOTAL_PINS; p++) {
      if (pinValid(p) && p > 1) {
        Serial.write(M_INPUT); Serial.write(1);
        if (!pinInputOnly(p)) { Serial.write(M_OUTPUT); Serial.write(1); Serial.write(M_PULLUP); Serial.write(1); Serial.write(M_SERVO); Serial.write(14); }
        if (pinToAnalog(p) >= 0) { Serial.write(M_ANALOG); Serial.write(ADC_BITS); }
      }
      Serial.write(0x7F);
    }
    Serial.write(0xF7);
  } else if (c == 0x69) {               // ANALOG_MAPPING_QUERY
    Serial.write(0xF0); Serial.write(0x6A);
    for (uint8_t p = 0; p < TOTAL_PINS; p++) { int8_t a = pinToAnalog(p); Serial.write(a >= 0 ? a : 0x7F); }
    Serial.write(0xF7);
  } else if (c == 0x6D && blen >= 2) {  // PIN_STATE_QUERY → 回讀
    uint8_t p = buf[1]; if (p >= TOTAL_PINS) return;
    int st = pinMode_[p] == M_OUTPUT ? (digitalRead(p) ? 1 : 0) : pinState_[p];
    if (pinMode_[p] == M_INPUT || pinMode_[p] == M_PULLUP) st = digitalRead(p);
    Serial.write(0xF0); Serial.write(0x6E); Serial.write(p); Serial.write(pinMode_[p]); Serial.write(st & 0x7F); if (st > 127) Serial.write(st >> 7); Serial.write(0xF7);
  } else if (c == 0x62 && blen >= 2) {  // DofLab 擴充：超音波設定
    sonarConfig(buf[1], blen >= 3 ? buf[2] : 0x7F);
  } else if (c == 0x6F && blen >= 3) {  // EXTENDED_ANALOG
    int v = buf[2] | (blen > 3 ? buf[3] << 7 : 0); setValue(buf[1], v);
  }
}
void handleMsg() {
  uint8_t hi = cmd & 0xF0, lo = cmd & 0x0F;
  if (cmd == 0xF4) setMode(buf[0], buf[1]);
  else if (cmd == 0xF5) setValue(buf[0], buf[1]);
  else if (hi == 0xD0) { if (lo < sizeof(reportPort)) { reportPort[lo] = buf[0]; if (buf[0]) sendPort(lo); } }
  else if (hi == 0xC0) { if (lo < ANALOG_CHANNELS) { if (buf[0]) reportAnalog |= 1 << lo; else reportAnalog &= ~(1 << lo); } }
  else if (hi == 0xE0) setValue(lo, buf[0] | (buf[1] << 7));
  else if (hi == 0x90) { for (uint8_t i = 0; i < 8; i++) { uint8_t p = lo * 8 + i; if (p < TOTAL_PINS && pinMode_[p] == M_OUTPUT) setValue(p, ((buf[0] | buf[1] << 7) >> i) & 1); } }
}
void parse(uint8_t b) {
  if (sysex) { if (b == 0xF7) { sysex = false; handleSysex(); } else if (blen < sizeof(buf)) buf[blen++] = b; return; }
  if (b == 0xF0) { sysex = true; blen = 0; return; }
  if (b & 0x80) {
    cmd = b; blen = 0;
    if (b == 0xF9) { sendVersion(); need = 0; return; }
    if (b == 0xFF) { resetAll(); need = 0; return; }
    uint8_t hi = b & 0xF0;
    need = (b == 0xF4 || b == 0xF5 || hi == 0xE0 || hi == 0x90) ? 2 : (hi == 0xC0 || hi == 0xD0) ? 1 : 0;
    return;
  }
  if (!need) return;
  buf[blen++] = b;
  if (blen >= need) { handleMsg(); need = 0; blen = 0; }
}

void setup() {
  Serial.begin(57600);
  for (uint8_t p = 0; p < TOTAL_PINS; p++) { pinMode_[p] = pinValid(p) ? M_INPUT : M_UNSET; pinState_[p] = 0; servoOf[p] = -1; }
  for (uint8_t i = 0; i < MAX_SONARS; i++) sonar[i].on = false;
#if defined(ARDUINO_ARCH_ESP32)
  analogReadResolution(ADC_BITS);
#endif
  sendVersion(); sendFirmware();
}

void loop() {
  while (Serial.available()) { parse(Serial.read()); lastRx = millis(); }
  outputGuard();
  sonarUpdate();
  for (uint8_t port = 0; port < sizeof(reportPort); port++) if (reportPort[port]) { uint8_t v = readPort(port); if (v != lastPort[port]) sendPort(port); }
  unsigned long now = millis();
  if (reportAnalog && now - lastAnalog >= 50) {
    lastAnalog = now;
    for (uint8_t ch = 0; ch < ANALOG_CHANNELS; ch++) if (reportAnalog & (1 << ch)) { int v = analogRead(analogToPin(ch)); Serial.write(0xE0 | ch); Serial.write(v & 0x7F); Serial.write(v >> 7); }
  }
}
