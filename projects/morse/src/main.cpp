// Морзянка: принимает строку из Serial и мигает ей светодиодом.
// Понимает латиницу, кириллицу и цифры; пока ничего не прислали — каждые 10 с мигает SOS.
#include <Arduino.h>

constexpr int kLed = 2;      // синий светодиод на ESP32 DevKit v1
constexpr int kUnitMs = 120;  // длительность точки; тире = 3 точки

struct Letter {
    const char* utf8;  // буква в UTF-8 (кириллица — 2 байта)
    const char* code;
};

const Letter kAlphabet[] = {
    {"A", ".-"},   {"B", "-..."}, {"C", "-.-."}, {"D", "-.."},  {"E", "."},    {"F", "..-."},
    {"G", "--."},  {"H", "...."}, {"I", ".."},   {"J", ".---"}, {"K", "-.-"},  {"L", ".-.."},
    {"M", "--"},   {"N", "-."},   {"O", "---"},  {"P", ".--."}, {"Q", "--.-"}, {"R", ".-."},
    {"S", "..."},  {"T", "-"},    {"U", "..-"},  {"V", "...-"}, {"W", ".--"},  {"X", "-..-"},
    {"Y", "-.--"}, {"Z", "--.."},
    {"А", ".-"},   {"Б", "-..."}, {"В", ".--"},  {"Г", "--."},  {"Д", "-.."},  {"Е", "."},
    {"Ё", "."},    {"Ж", "...-"}, {"З", "--.."}, {"И", ".."},   {"Й", ".---"}, {"К", "-.-"},
    {"Л", ".-.."}, {"М", "--"},   {"Н", "-."},   {"О", "---"},  {"П", ".--."}, {"Р", ".-."},
    {"С", "..."},  {"Т", "-"},    {"У", "..-"},  {"Ф", "..-."}, {"Х", "...."}, {"Ц", "-.-."},
    {"Ч", "---."}, {"Ш", "----"}, {"Щ", "--.-"}, {"Ъ", "--.--"}, {"Ы", "-.--"}, {"Ь", "-..-"},
    {"Э", "..-.."}, {"Ю", "..--"}, {"Я", ".-.-"},
    {"0", "-----"}, {"1", ".----"}, {"2", "..---"}, {"3", "...--"}, {"4", "....-"},
    {"5", "....."}, {"6", "-...."}, {"7", "--..."}, {"8", "---.."}, {"9", "----."},
};

// Строчные буквы -> заглавные (латиница и кириллица в UTF-8)
String toUpper(const String& s) {
    String out;
    for (size_t i = 0; i < s.length(); ++i) {
        uint8_t c = s[i];
        if (c >= 'a' && c <= 'z') {
            out += char(c - 32);
        } else if (c == 0xD0 && i + 1 < s.length() && uint8_t(s[i + 1]) >= 0xB0 && uint8_t(s[i + 1]) <= 0xBF) {
            out += char(0xD0);  // а..п: D0 B0..BF -> D0 90..9F
            out += char(uint8_t(s[++i]) - 0x20);
        } else if (c == 0xD1 && i + 1 < s.length() && uint8_t(s[i + 1]) >= 0x80 && uint8_t(s[i + 1]) <= 0x8F) {
            out += char(0xD0);  // р..я: D1 80..8F -> D0 A0..AF
            out += char(uint8_t(s[++i]) + 0x20);
        } else if (c == 0xD1 && i + 1 < s.length() && uint8_t(s[i + 1]) == 0x91) {
            out += "Ё";
            ++i;
        } else {
            out += char(c);
        }
    }
    return out;
}

const char* findCode(const String& text, size_t pos, size_t& len) {
    for (const Letter& l : kAlphabet) {
        size_t n = strlen(l.utf8);
        if (text.length() - pos >= n && memcmp(text.c_str() + pos, l.utf8, n) == 0) {
            len = n;
            return l.code;
        }
    }
    len = (uint8_t(text[pos]) >= 0xC0) ? 2 : 1;  // неизвестный символ — пропускаем целиком
    return nullptr;
}

void flash(int units) {
    digitalWrite(kLed, HIGH);
    delay(units * kUnitMs);
    digitalWrite(kLed, LOW);
    delay(kUnitMs);
}

void sendMorse(const String& raw) {
    String text = toUpper(raw);
    Serial.printf("> %s\n  ", raw.c_str());
    for (size_t i = 0; i < text.length();) {
        if (text[i] == ' ') {
            Serial.print("/ ");
            delay(kUnitMs * 6);  // между словами 7 точек, одна уже прошла после символа
            ++i;
            continue;
        }
        size_t len;
        const char* code = findCode(text, i, len);
        i += len;
        if (!code) continue;
        for (const char* p = code; *p; ++p) flash(*p == '-' ? 3 : 1);
        Serial.printf("%s ", code);
        delay(kUnitMs * 2);  // между буквами 3 точки
    }
    Serial.println("\n  готово");
}

void setup() {
    Serial.begin(115200);
    pinMode(kLed, OUTPUT);
    delay(500);
    Serial.println("\nМорзянка готова! Напиши текст в мониторе и нажми «Отправить».");
}

void loop() {
    static String line;
    static uint32_t lastActivity = 0;

    while (Serial.available()) {
        char c = Serial.read();
        if (c == '\r') continue;
        if (c == '\n') {
            line.trim();
            if (line.length()) sendMorse(line);
            line = "";
            lastActivity = millis();
        } else {
            line += c;
        }
    }

    if (millis() - lastActivity > 10000) {
        sendMorse("SOS");
        lastActivity = millis();
    }
}
