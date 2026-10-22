#pragma once
extern int __servo[64];
class Servo { int pin=-1; public: void attach(int p){pin=p;} void write(int a){ if(pin>=0) __servo[pin]=a; } };
