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
extern unsigned long __now; extern int __din[64]; extern int __dout[64]; extern int __adc[64]; extern int __mode[64];
inline unsigned long millis(){ return __now; }
inline int digitalRead(int p){ return __din[p]; }
inline void digitalWrite(int p,int v){ __dout[p]=v; }
inline void pinMode(int p,int m){ __mode[p]=m; }
inline int analogRead(int p){ return __adc[p]; }
