#include "Arduino.h"
#include <cstdlib>
#include <vector>
unsigned long __now=0; int __din[64]; int __dout[64]; int __adc[64]; int __mode[64]; int __servo[64];
#include "sketch.inc"
// stdin: T, then lines "t kind pin value" (kind d=digital raw level, a=adc) sorted by t; output pins list
int main(){
  for(int i=0;i<64;i++){__din[i]=1;__dout[i]=0;__adc[i]=0;__servo[i]=-1;}
  int T,nev; if(scanf("%d %d",&T,&nev)!=2) return 1;
  std::vector<long> et(nev); std::vector<char> ek(nev); std::vector<int> ep(nev), ev(nev);
  for(int i=0;i<nev;i++){ scanf("%ld %c %d %d",&et[i],&ek[i],&ep[i],&ev[i]); }
  int nout; scanf("%d",&nout); std::vector<int> op(nout); std::vector<char> ok(nout);
  for(int i=0;i<nout;i++) scanf(" %c %d",&ok[i],&op[i]);
  // 第一次 loop 前先套用 t=0 的輸入
  size_t k=0; while(k<(size_t)nev && et[k]<=0){ if(ek[k]=='d') __din[ep[k]]=ev[k]; else __adc[ep[k]]=ev[k]; k++; }
  setup();
  for(long t=0;t<=T;t++){
    __now=t;
    while(k<(size_t)nev && et[k]<=t){ if(ek[k]=='d') __din[ep[k]]=ev[k]; else __adc[ep[k]]=ev[k]; k++; }
    loop();
    for(int i=0;i<nout;i++) printf("%d%c", ok[i]=='s'?__servo[op[i]]:__dout[op[i]], i+1<nout?' ':'\n');
  }
}
