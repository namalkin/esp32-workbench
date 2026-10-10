# ESP32 Workbench

Сборка и прошивка ESP32 из браузера. Нужен только Docker: Arduino IDE, Python и драйверы-утилиты
не нужны. После первой сборки образа работает **без интернета**.

- **Сборка** — PlatformIO внутри контейнера (тулчейны ESP32 и ESP32-C3 уже в образе).
- **Прошивка** — прямо из браузера через WebSerial ([esptool-js](https://github.com/espressif/esptool-js),
  вшит в образ). Docker не нужен доступ к USB, поэтому одинаково работает на Windows, macOS и Linux.
- **Serial-монитор**, кнопка Reset, отправка строк в плату.
- Прошивка любого своего `.bin` по адресу.

## Запуск

```sh
git clone https://github.com/namalkin/esp32-workbench.git
cd esp32-workbench
docker compose up -d --build
```

Открой **http://localhost:8090** в **Chrome** или **Edge**. Safari и Firefox WebSerial не умеют.
Страницу нужно открывать именно как `localhost` на том компьютере, к которому подключена плата:
браузеры дают доступ к USB только на `localhost` или по https.

Первая сборка образа качает около 1–2 ГБ (PlatformIO и тулчейны), дальше интернет не нужен.

## Как пользоваться

1. Подключи плату по USB и нажми **Выбрать порт** (CP210x / CH340 / Espressif USB).
2. В списке проектов: **Собрать**, **Прошить** или **Собрать и прошить**.
3. После прошивки сам откроется Serial-монитор (115200).

Если плата не входит в режим прошивки: зажми **BOOT**, нажми «Прошить», отпусти BOOT, когда пойдёт запись.

Адреса и файлы (bootloader, partitions, приложение) берутся у PlatformIO, так что в проектах не нужны
никакие дополнительные скрипты.

## Свои проекты

Проекты лежат в `projects/` — по папке на проект, в каждой свой `platformio.ini`.
Можно указать любую папку:

```sh
cp .env.example .env
# в .env:  PROJECTS_DIR=/Users/me/esp32   или   PROJECTS_DIR=D:/projects/esp32
docker compose up -d
```

Новый проект с мигалкой создаётся из интерфейса (блок «Новый проект»).

Чтобы собирать офлайн, используй в проектах `platform = espressif32@6.9.0` — именно она вшита в образ.
Другая версия платформы или библиотеки из `lib_deps` скачаются при первой сборке (нужен интернет).
Новую плату добавь в [warmup/platformio.ini](warmup/platformio.ini) и пересобери образ.

Сборка из терминала, без браузера:

```sh
docker compose run --rm app pio run -d /projects/blink
```

## macOS

Нужен Docker Desktop (или Colima) и Chrome. На старых Mac с неофициальной macOS
(например Ventura через OpenCore Legacy Patcher) свежий Docker Desktop может не встать —
тогда подойдёт более старая версия Docker Desktop или Colima.

## Устройство

| Путь | Что |
|---|---|
| `app/server.py` | HTTP-сервер на стандартной библиотеке Python: список проектов, `pio run`, отдача файлов прошивки |
| `app/static/` | Интерфейс; прошивка и монитор — WebSerial прямо из браузера |
| `warmup/` | Пустой проект, которым при сборке образа прогреваются тулчейны |
