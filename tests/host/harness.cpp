#include "Arduino.h"
#include <cstdlib>
#include <vector>
unsigned long long __us=0; int __din[64]; int __dout[64]; int __adc[64]; int __mode[64]; int __servo[64]; int __touch[64]; __SerialStub Serial;
// 超音波模組替身（HC-SR04 的時序）：TRIG 高電位 ≥ 10 µs 後拉低 → 460 µs 後 ECHO 變高，
// 高電位寬度 = 距離 × 58 µs（再加 29 µs，落在整數公分的中間，避免輪詢誤差造成差 1 cm）
struct Sonar { int trig, echo, cm; unsigned long long hi, rise, fall; bool high; };
std::vector<Sonar> __sonars;
int __sonarRead(int p, int *v){ for (auto &s : __sonars) if (s.echo == p) { *v = (__us >= s.rise && __us < s.fall) ? 1 : 0; return 1; } return 0; }
void __sonarWrite(int p, int v){ for (auto &s : __sonars) if (s.trig == p) { if (v && !s.high) { s.high = true; s.hi = __us; } else if (!v && s.high) { s.high = false; if (__us - s.hi >= 10) { s.rise = __us + 460; s.fall = s.rise + (unsigned long long)s.cm * 58 + 29; } } } }
#include "sketch.inc"
// stdin: T, then lines "t kind pin value" (kind d=digital raw level, a=adc, u=超音波距離 cm，pin 為 TRIG) sorted by t; output pins list;
//        可選：超音波數量與每顆的「TRIG ECHO」腳位。有超音波時每 1 ms 呼叫 loop() 約 100 次（每次 10 µs），才量得到回波寬度。
int main(){
  for(int i=0;i<64;i++){__din[i]=1;__dout[i]=0;__adc[i]=0;__servo[i]=-1;__touch[i]=60;}   // 觸控：沒碰時約 60
  int T,nev; if(scanf("%d %d",&T,&nev)!=2) return 1;
  std::vector<long> et(nev); std::vector<char> ek(nev); std::vector<int> ep(nev), ev(nev);
  for(int i=0;i<nev;i++){ scanf("%ld %c %d %d",&et[i],&ek[i],&ep[i],&ev[i]); }
  int nout; scanf("%d",&nout); std::vector<int> op(nout); std::vector<char> ok(nout);
  for(int i=0;i<nout;i++) scanf(" %c %d",&ok[i],&op[i]);
  int ns=0; if(scanf("%d",&ns)!=1) ns=0;
  for(int i=0;i<ns;i++){ Sonar s; scanf("%d %d",&s.trig,&s.echo); s.cm=400; s.hi=0; s.rise=s.fall=0; s.high=false; __sonars.push_back(s); }
  auto apply=[&](size_t i){ if(ek[i]=='d') __din[ep[i]]=ev[i]; else if(ek[i]=='a') __adc[ep[i]]=ev[i]; else if(ek[i]=='t') __touch[ep[i]]=ev[i]; else for(auto &s:__sonars) if(s.trig==ep[i]) s.cm=ev[i]; };
  // 第一次 loop 前先套用 t=0 的輸入
  size_t k=0; while(k<(size_t)nev && et[k]<=0){ apply(k); k++; }
  setup();
  for(long t=0;t<=T;t++){
    if(__us < (unsigned long long)t*1000) __us=(unsigned long long)t*1000;
    while(k<(size_t)nev && et[k]<=t){ apply(k); k++; }
    if(ns){ while(__us < (unsigned long long)(t+1)*1000){ loop(); __us+=10; } }
    else { __us=(unsigned long long)t*1000; loop(); }
    for(int i=0;i<nout;i++) printf("%d%c", ok[i]=='s'?__servo[op[i]]:__dout[op[i]], i+1<nout?' ':'\n');
  }
}
