"""ESP32 Workbench: список PlatformIO-проектов, сборка и отдача файлов прошивки браузеру.

Прошивает сам браузер (esptool-js + WebSerial) — USB в Docker не нужен.
Только стандартная библиотека Python.
"""
import configparser
import json
import os
import re
import subprocess
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PROJECTS = Path(os.environ.get("PROJECTS_DIR", "/projects")).resolve()
STATIC = Path(__file__).parent / "static"
PORT = int(os.environ.get("PORT", "8090"))

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
}

# Встроенный USB вместо CP210x/CH340: Serial идёт через него
USB_CDC = ["-DARDUINO_USB_MODE=1", "-DARDUINO_USB_CDC_ON_BOOT=1"]

# Платы для «Нового проекта»; их тулчейны прогреты в warmup/platformio.ini — собираются офлайн.
# led: пин светодиода для шаблона-мигалки (LED_BUILTIN — из описания платы, у S3 это RGB).
BOARDS = {
    "esp32dev": {"title": "ESP32 · DevKit v1 (WROOM-32)", "led": "2", "flags": []},
    "esp32cam": {"title": "ESP32 · ESP32-CAM (AI-Thinker)", "led": "33", "flags": []},
    "esp32-s3-devkitc-1": {"title": "ESP32-S3 · DevKitC / SuperMini", "led": "LED_BUILTIN", "flags": USB_CDC},
    "lolin_s2_mini": {"title": "ESP32-S2 · Mini (Lolin)", "led": "15", "flags": []},
    "esp32-c3-devkitm-1": {"title": "ESP32-C3 · SuperMini / DevKitM", "led": "8", "flags": USB_CDC},
}
# Любая другая плата платформы espressif32 (id как в docs.platformio.org)
OTHER_BOARD = {"led": "LED_BUILTIN", "flags": []}

build_lock = threading.Lock()
metadata_cache: dict[tuple[str, str], tuple[float, list[dict]]] = {}


def read_config(ini: Path) -> configparser.ConfigParser | None:
    cfg = configparser.ConfigParser(interpolation=None, strict=False)
    try:
        cfg.read(ini, encoding="utf-8")
    except (configparser.Error, UnicodeDecodeError):
        return None
    return cfg


def firmware_bin(project: Path, env: str) -> Path:
    return project / ".pio" / "build" / env / "firmware.bin"


def find_projects() -> list[dict]:
    inis = [PROJECTS / "platformio.ini", *PROJECTS.glob("*/platformio.ini"), *PROJECTS.glob("*/*/platformio.ini")]
    result = []
    for ini in sorted(p for p in inis if p.is_file() and ".pio" not in p.parts):
        cfg = read_config(ini)
        if cfg is None:
            continue
        project = ini.parent
        envs = []
        for section in cfg.sections():
            if not section.startswith("env:"):
                continue
            env = section[4:]
            fw = firmware_bin(project, env)
            envs.append({
                "name": env,
                "board": cfg.get(section, "board", fallback=cfg.get("env", "board", fallback="")),
                "built": fw.stat().st_mtime if fw.exists() else None,
            })
        rel = project.relative_to(PROJECTS).as_posix()
        result.append({"id": rel, "name": project.name if rel != "." else PROJECTS.name, "envs": envs})
    return result


def resolve_project(project_id: str) -> Path | None:
    project = (PROJECTS / project_id).resolve()
    if project != PROJECTS and PROJECTS not in project.parents:
        return None
    return project if (project / "platformio.ini").is_file() else None


def flash_images(project: Path, env: str) -> list[dict]:
    """Файлы и адреса для прошивки — берём у PlatformIO, а не угадываем по чипу."""
    fw = firmware_bin(project, env)
    if not fw.exists():
        raise FileNotFoundError("Сначала собери проект")
    key = (str(project), env)
    mtime = fw.stat().st_mtime
    cached = metadata_cache.get(key)
    if cached and cached[0] == mtime:
        return cached[1]
    out = subprocess.run(
        ["pio", "project", "metadata", "-d", str(project), "-e", env, "--json-output"],
        capture_output=True, text=True, timeout=120,
    )
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip() or out.stdout.strip() or "pio project metadata упал")
    extra = json.loads(out.stdout)[env].get("extra") or {}
    images = [{"offset": i["offset"], "path": i["path"]} for i in extra.get("flash_images", [])]
    images.append({"offset": extra.get("application_offset", "0x10000" if images else "0x0"), "path": str(fw)})
    for image in images:
        image["name"] = Path(image["path"]).name
        image["size"] = Path(image["path"]).stat().st_size
    metadata_cache[key] = (mtime, images)
    return images


def new_project(name: str, board: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", name):
        raise ValueError("Имя: латиница, цифры, - и _, до 40 символов")
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,60}", board):
        raise ValueError("Плата: id из PlatformIO, например esp32-s3-devkitc-1")
    project = PROJECTS / name
    if project.exists():
        raise ValueError("Такая папка уже есть")
    spec = BOARDS.get(board, OTHER_BOARD)
    flags = "".join(f"\n    {f}" for f in spec["flags"])
    ini = (
        f"[env:{board}]\n"
        "platform = espressif32@6.9.0\n"
        f"board = {board}\n"
        "framework = arduino\n"
        "monitor_speed = 115200\n"
        + (f"build_flags ={flags}\n" if flags else "")
    )
    led = spec["led"]
    led_decl = (
        "#ifdef LED_BUILTIN\nconstexpr int kLed = LED_BUILTIN;\n#else\nconstexpr int kLed = 2;  // поправь под свою плату\n#endif\n"
        if led == "LED_BUILTIN" else f"constexpr int kLed = {led};\n"
    )
    main = (
        "#include <Arduino.h>\n\n"
        f"{led_decl}\n"
        "void setup() {\n"
        "    Serial.begin(115200);\n"
        "    pinMode(kLed, OUTPUT);\n"
        "}\n\n"
        "void loop() {\n"
        "    digitalWrite(kLed, !digitalRead(kLed));\n"
        "    Serial.println(\"tick\");\n"
        "    delay(500);\n"
        "}\n"
    )
    (project / "src").mkdir(parents=True)
    (project / "platformio.ini").write_text(ini, encoding="utf-8")
    (project / "src" / "main.cpp").write_text(main, encoding="utf-8")
    return name


class Handler(BaseHTTPRequestHandler):
    server_version = "esp32-workbench"

    def log_message(self, fmt, *args):
        print(self.address_string(), fmt % args, flush=True)

    def send(self, code=200, body=b"", ctype="text/plain; charset=utf-8"):
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, data, code=200):
        self.send(code, json.dumps(data, ensure_ascii=False), "application/json; charset=utf-8")

    def query(self) -> dict[str, str]:
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        return {k: v[0] for k, v in q.items()}

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return {}

    def project_env(self, params: dict) -> tuple[Path, str] | None:
        project = resolve_project(params.get("project", ""))
        env = params.get("env", "")
        if project is None or not re.fullmatch(r"[\w.-]+", env):
            self.send(404, "Проект не найден")
            return None
        return project, env

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/":
            return self.serve_static("index.html")
        if path.startswith("/static/"):
            return self.serve_static(path[len("/static/"):])
        if path == "/api/projects":
            return self.send_json({"projects": find_projects(), "boards": {k: v["title"] for k, v in BOARDS.items()}})
        if path == "/api/images":
            found = self.project_env(self.query())
            if not found:
                return
            try:
                images = flash_images(*found)
            except FileNotFoundError as e:
                return self.send(409, str(e))
            except Exception as e:  # noqa: BLE001 — текст ошибки нужен в интерфейсе
                return self.send(500, str(e))
            return self.send_json([{k: i[k] for k in ("offset", "name", "size")} for i in images])
        if path == "/api/image":
            params = self.query()
            found = self.project_env(params)
            if not found:
                return
            try:
                image = flash_images(*found)[int(params.get("i", "-1"))]
            except (FileNotFoundError, IndexError, ValueError):
                return self.send(404, "Файл прошивки не найден")
            return self.send(200, Path(image["path"]).read_bytes(), "application/octet-stream")
        self.send(404, "Не найдено")

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/build":
            found = self.project_env(self.read_json())
            if found:
                self.build(*found)
            return
        if path == "/api/new":
            data = self.read_json()
            try:
                name = new_project(str(data.get("name", "")), str(data.get("board", "")))
            except ValueError as e:
                return self.send(400, str(e))
            return self.send_json({"id": name})
        self.send(404, "Не найдено")

    def serve_static(self, rel: str):
        file = (STATIC / rel).resolve()
        if STATIC.resolve() not in file.parents or not file.is_file():
            return self.send(404, "Не найдено")
        self.send(200, file.read_bytes(), MIME.get(file.suffix, "application/octet-stream"))

    def build(self, project: Path, env: str):
        """Лог `pio run` построчно; последняя строка — `__EXIT__ <код>`."""
        if not build_lock.acquire(blocking=False):
            return self.send(409, "Уже идёт другая сборка")
        proc = None
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            proc = subprocess.Popen(
                ["pio", "run", "-d", str(project), "-e", env],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            )
            for line in proc.stdout:
                self.wfile.write(line)
                self.wfile.flush()
            self.wfile.write(f"\n__EXIT__ {proc.wait()}\n".encode())
        except (BrokenPipeError, ConnectionResetError):
            if proc and proc.poll() is None:
                proc.kill()  # вкладку закрыли — сборку не продолжаем
        finally:
            build_lock.release()


if __name__ == "__main__":
    print(f"ESP32 Workbench: http://localhost:{PORT}  (проекты: {PROJECTS})", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
