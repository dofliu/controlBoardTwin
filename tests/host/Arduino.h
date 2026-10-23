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
