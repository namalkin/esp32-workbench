#include <Arduino.h>

constexpr int kLed = 2;  // синий светодиод на ESP32 DevKit v1

void setup() {
    Serial.begin(115200);
    pinMode(kLed, OUTPUT);
}

void loop() {
    digitalWrite(kLed, HIGH);
    delay(200);
    digitalWrite(kLed, LOW);
    delay(800);
    Serial.printf("Привет от ESP32! Прошло %lu мс\n", millis());
}
