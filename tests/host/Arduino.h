// 主機端測試用的 Arduino 介面替身：只用來驗證「產生的程式邏輯」與模擬引擎一致，
// 不代表真實板子的時序或電氣行為。
#pragma once
#include <cstdint>
#include <cstdio>
#define HIGH 1
#define LOW 0
#define INPUT 0
#define OUTPUT 1
#define INPUT_PULLUP 2
#define A0 14
#define A1 15
#define A2 16
#define A3 17
#define A4 18
#define A5 19
typedef uint8_t byte;
extern unsigned long long __us; extern int __din[64]; extern int __dout[64]; extern int __adc[64]; extern int __mode[64];
int __sonarRead(int p, int *v); void __sonarWrite(int p, int v);   // 超音波模組的替身（harness.cpp）
inline unsigned long millis(){ return (unsigned long)(__us / 1000); }
inline unsigned long micros(){ return (unsigned long)__us; }
inline void delayMicroseconds(unsigned int n){ __us += n; }
inline int digitalRead(int p){ int v; if (__sonarRead(p, &v)) return v; return __din[p]; }
inline void digitalWrite(int p,int v){ __dout[p]=v; __sonarWrite(p, v); }
inline void pinMode(int p,int m){ __mode[p]=m; }
inline int analogRead(int p){ return __adc[p]; }
inline long map(long x, long in_min, long in_max, long out_min, long out_max){ return (x - in_min) * (out_max - out_min) / (in_max - in_min) + out_min; }
template<class T> inline T constrain(T x, T a, T b){ return x < a ? a : (x > b ? b : x); }
// ESP32：電容式觸控（讀值越小表示碰得越實）、delay、Serial（印到 stderr："SERIAL <millis> <文字>"）
extern int __touch[64];
inline int touchRead(int p){ return __touch[p]; }
inline void delay(unsigned long ms){ __us += (unsigned long long)ms * 1000; }
struct __SerialStub { void begin(long){} void println(const char *s){ fprintf(stderr, "SERIAL %lu %s\n", (unsigned long)(__us / 1000), s); } };
extern __SerialStub Serial;
// 中斷（V2.13：超音波的 ECHO 用腳位變化中斷量回波寬度）。harness.cpp 在 ECHO 變化的那一刻呼叫：
//   ESP32 → attachInterrupt 登記的函式；Uno → 那個腳位所屬的 ISR(PCINTx_vect)（D0–D7：PCINT2、D8–D13：PCINT0、A0–A5：PCINT1）
#define CHANGE 1
#define IRAM_ATTR
inline int digitalPinToInterrupt(int p){ return p; }
extern void (*__isr[64])();
inline void attachInterrupt(int p, void (*f)(), int){ __isr[p] = f; }
inline void noInterrupts(){} inline void interrupts(){}
#define ISR(vec) void vec()
void PCINT0_vect() __attribute__((weak)); void PCINT1_vect() __attribute__((weak)); void PCINT2_vect() __attribute__((weak));
#define bit(n) (1 << (n))
extern uint8_t PCICR, PCIFR, __pcmsk[3];
inline int __pcgrp(int p){ return p <= 7 ? 2 : p <= 13 ? 0 : 1; }
#define digitalPinToPCICRbit(p) (__pcgrp(p))
#define digitalPinToPCMSK(p) (&__pcmsk[__pcgrp(p)])
#define digitalPinToPCMSKbit(p) ((p) <= 7 ? (p) : (p) <= 13 ? (p) - 8 : (p) - 14)
