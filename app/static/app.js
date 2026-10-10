// Прошивка и монитор идут прямо из браузера через WebSerial; сервер только собирает и отдаёт файлы.
import { ESPLoader, Transport } from "./vendor/esptool-bundle.js";

const $ = (s) => document.querySelector(s);
const logEl = $("#log");
const monEl = $("#monitor");
const MAX_LOG = 200_000;

let port = null;     // выбранный SerialPort
let monitor = null;  // { stop, reader, finished }
let busy = false;    // идёт сборка или прошивка

// ---------- вывод ----------

function print(el, text) {
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  el.textContent += text;
  if (el.textContent.length > MAX_LOG) el.textContent = el.textContent.slice(-MAX_LOG * 0.75);
  if (atBottom) el.scrollTop = el.scrollHeight;
}
const say = (text) => print(logEl, text.endsWith("\n") ? text : text + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setProgress(fraction) {
  $("#progress").hidden = fraction == null;
  $("#progress-bar").style.width = `${Math.round((fraction ?? 0) * 100)}%`;
}

function setBusy(value) {
  busy = value;
  document.querySelectorAll("[data-busy]").forEach((b) => (b.disabled = value));
  $("#btn-erase").disabled = value;
  $("#bin-form button").disabled = value;
}

document.querySelectorAll("[data-clear]").forEach((b) =>
  b.addEventListener("click", () => ($("#" + b.dataset.clear).textContent = "")));

// ---------- порт ----------

const USB_NAMES = { 0x10c4: "CP210x", 0x1a86: "CH340", 0x303a: "Espressif USB", 0x0403: "FTDI" };

function updatePort() {
  $("#port-dot").classList.toggle("on", !!port);
  if (!port) {
    $("#port-name").textContent = "не выбрана";
    $("#chip").textContent = "";
    return;
  }
  const { usbVendorId: vid, usbProductId: pid } = port.getInfo();
  $("#port-name").textContent = USB_NAMES[vid] || (vid ? `USB ${vid.toString(16)}:${(pid || 0).toString(16)}` : "Serial-порт");
}

async function choosePort() {
  await stopMonitor();
  port = await navigator.serial.requestPort();
  updatePort();
  return port;
}

const ensurePort = () => (port ? Promise.resolve(port) : choosePort());

if ("serial" in navigator) {
  // Порт, разрешённый раньше, браузер отдаёт без диалога
  navigator.serial.getPorts().then((ports) => {
    if (ports.length === 1 && !port) {
      port = ports[0];
      updatePort();
    }
  });
  navigator.serial.addEventListener("disconnect", (e) => {
    if (e.target === port) {
      say("🔌 Плата отключена");
      port = null;
      updatePort();
    }
  });
} else {
  $("#no-serial").hidden = false;
}

$("#btn-port").addEventListener("click", () => choosePort().catch(() => {}));

// ---------- монитор ----------

function setMonitorUi(open) {
  $("#btn-monitor").textContent = open ? "Закрыть" : "Открыть";
  $("#mon-baud").disabled = open;
}

async function startMonitor() {
  if (monitor) return;
  await ensurePort();
  await port.open({ baudRate: Number($("#mon-baud").value) });
  const state = { stop: false, reader: null };
  monitor = state;
  setMonitorUi(true);
  state.finished = (async () => {
    const decoder = new TextDecoder();
    try {
      while (!state.stop && port?.readable) {
        state.reader = port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await state.reader.read();
            if (done) break;
            print(monEl, decoder.decode(value, { stream: true }));
          }
        } finally {
          state.reader.releaseLock();
        }
      }
    } catch (e) {
      if (!state.stop) print(monEl, `\n[порт: ${e.message}]\n`);
    }
    try { await port?.close(); } catch { /* уже закрыт */ }
    if (monitor === state) monitor = null;
    setMonitorUi(false);
  })();
}

async function stopMonitor() {
  const state = monitor;
  if (!state) return;
  state.stop = true;
  await state.reader?.cancel().catch(() => {});
  await state.finished;
}

$("#btn-monitor").addEventListener("click", () =>
  (monitor ? stopMonitor() : startMonitor()).catch((e) => say("❌ " + e.message)));

// RTS тянет EN к земле — так же перезагружает кнопка EN на DevKit
$("#btn-reset").addEventListener("click", async () => {
  if (busy) return;
  try {
    await startMonitor();
    await port.setSignals({ dataTerminalReady: false, requestToSend: true });
    await sleep(120);
    await port.setSignals({ requestToSend: false });
  } catch (e) {
    say("❌ " + e.message);
  }
});

$("#send-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!monitor || !port?.writable) return say("Сначала открой монитор");
  const writer = port.writable.getWriter();
  try {
    await writer.write(new TextEncoder().encode($("#send-text").value + "\n"));
    $("#send-text").value = "";
  } finally {
    writer.releaseLock();
  }
});

// ---------- прошивка ----------

const SAFE_BAUD = 115200;

async function runLoader(action, baudrate) {
  const transport = new Transport(port, false);
  try {
    const loader = new ESPLoader({
      transport,
      baudrate,
      terminal: { clean() {}, writeLine: (d) => say(d), write: (d) => print(logEl, d) },
    });
    say(`\n▶ Подключаюсь к загрузчику (${baudrate})…`);
    const chip = await loader.main();
    $("#chip").textContent = `· ${chip}`;
    await action(loader);
    await loader.after("hard_reset");
  } finally {
    try { await transport.disconnect(); } catch { /* порт уже закрыт */ }
  }
}

async function withLoader(action) {
  if (busy) return false;
  setBusy(true);
  const reopen = !!monitor || $("#auto-monitor").checked;
  const chosen = Number($("#flash-baud").value);
  // CP210x на Windows через WebSerial часто ловит мусор после смены скорости — тогда повторяем на 115200
  const attempts = chosen > SAFE_BAUD ? [chosen, SAFE_BAUD] : [chosen];
  let ok = false;
  try {
    await ensurePort();
    await stopMonitor();
    for (const [i, baud] of attempts.entries()) {
      try {
        await runLoader(action, baud);
        ok = true;
        break;
      } catch (e) {
        say("❌ " + (e?.message || e));
        if (i < attempts.length - 1) {
          say(`↻ Повторяю на ${attempts[i + 1]}…`);
          setProgress(null);
          await sleep(500);
        }
      }
    }
    if (!ok) say("Если не подключается: зажми BOOT на плате, нажми «Прошить» и отпусти BOOT, когда пойдёт запись.");
  } catch (e) {
    say("❌ " + (e?.message || e));  // порт не выбран
  } finally {
    setProgress(null);
    setBusy(false);
  }
  if (ok && reopen) await startMonitor().catch((e) => say("Монитор: " + e.message));
  return ok;
}

function flash(images) {
  return withLoader(async (loader) => {
    for (const img of images) say(`  ${img.name} → 0x${img.address.toString(16)} (${img.data.length} байт)`);
    await loader.writeFlash({
      fileArray: images.map(({ data, address }) => ({ data, address })),
      flashMode: "keep",
      flashFreq: "keep",
      flashSize: "keep",
      eraseAll: false,
      compress: true,
      reportProgress: (index, written, total) => setProgress((index + written / total) / images.length),
    });
    say("✅ Прошито, перезагружаю плату");
  });
}

$("#btn-erase").addEventListener("click", () => {
  if (!confirm("Стереть всю flash-память платы?")) return;
  withLoader(async (loader) => {
    say("Стираю… (до минуты)");
    await loader.eraseFlash();
    say("✅ Flash стёрта");
  });
});

$("#bin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const file = $("#bin-file").files[0];
  const address = parseInt($("#bin-addr").value, 16);
  if (!file || Number.isNaN(address)) return say("Выбери файл и адрес (например 0x0)");
  flash([{ name: file.name, address, data: new Uint8Array(await file.arrayBuffer()) }]);
});

// ---------- проекты ----------

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) throw new Error(await res.text());
  return res;
}

const query = (project, env) => `project=${encodeURIComponent(project)}&env=${encodeURIComponent(env)}`;

async function build(project, env) {
  say(`\n▶ Сборка ${project} [${env}]`);
  const res = await fetch("/api/build", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project, env }),
  });
  if (!res.ok) {
    say("❌ " + (await res.text()));
    return false;
  }
  // Печатаем построчно, чтобы служебная строка __EXIT__ не попала в лог
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let code = null;
  const flushLines = (final) => {
    const lines = pending.split("\n");
    pending = final ? "" : lines.pop();
    for (const line of lines) {
      const m = line.match(/^__EXIT__ (-?\d+)$/);
      if (m) code = Number(m[1]);
      else print(logEl, line + "\n");
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    flushLines(false);
  }
  flushLines(true);
  say(code === 0 ? "✅ Собрано" : `❌ Сборка не удалась (код ${code ?? "?"})`);
  return code === 0;
}

async function flashProject(project, env) {
  const meta = await (await api(`/api/images?${query(project, env)}`)).json();
  const images = await Promise.all(meta.map(async (m, i) => ({
    name: m.name,
    address: parseInt(m.offset, 16),
    data: new Uint8Array(await (await api(`/api/image?${query(project, env)}&i=${i}`)).arrayBuffer()),
  })));
  return flash(images);
}

async function run(steps) {
  if (busy) return;
  try {
    for (const step of steps) if ((await step()) === false) break;
  } catch (e) {
    say("❌ " + e.message);
    setBusy(false);
  }
  loadProjects();
}

function formatTime(ts) {
  return new Date(ts * 1000).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function renderProject(p) {
  const el = document.createElement("div");
  el.className = "project";
  const options = p.envs.map((e) => `<option value="${e.name}">${e.name}${e.board ? ` · ${e.board}` : ""}</option>`).join("");
  el.innerHTML = `
    <div class="project-title"><b></b><span class="badge"></span></div>
    <div class="row">
      <select ${p.envs.length < 2 ? "hidden" : ""}>${options}</select>
      <button data-busy data-act="build">Собрать</button>
      <button data-busy data-act="flash">Прошить</button>
      <button data-busy data-act="both">Собрать и прошить</button>
    </div>`;
  el.querySelector("b").textContent = p.id === "." ? p.name : p.id;
  const select = el.querySelector("select");
  const badge = el.querySelector(".badge");
  const showBadge = () => {
    const env = p.envs.find((e) => e.name === select.value);
    badge.textContent = env?.built ? `собран ${formatTime(env.built)}` : "не собран";
    badge.classList.toggle("ok", !!env?.built);
  };
  select.addEventListener("change", showBadge);
  showBadge();
  el.addEventListener("click", (e) => {
    const act = e.target.dataset?.act;
    if (!act) return;
    const env = select.value;
    const doBuild = async () => {
      setBusy(true);
      try { return await build(p.id, env); } finally { setBusy(false); }
    };
    const doFlash = () => flashProject(p.id, env);
    run(act === "build" ? [doBuild] : act === "flash" ? [doFlash] : [doBuild, doFlash]);
  });
  return el;
}

async function loadProjects() {
  const box = $("#projects");
  try {
    const { projects, boards } = await (await api("/api/projects")).json();
    box.replaceChildren(...projects.filter((p) => p.envs.length).map(renderProject));
    if (!box.children.length) box.innerHTML = `<p class="muted">В папке проектов нет platformio.ini. Создай новый ниже.</p>`;
    const boardSelect = $("#new-board");
    if (!boardSelect.options.length) {
      for (const [id, title] of Object.entries(boards)) boardSelect.add(new Option(title, id));
      boardSelect.add(new Option("Другая…", ""));
    }
    setBusy(busy);
  } catch (e) {
    box.innerHTML = `<p class="muted">Сервер недоступен: ${e.message}</p>`;
  }
}

$("#btn-refresh").addEventListener("click", loadProjects);

$("#new-board").addEventListener("change", (e) => {
  const other = e.target.value === "";
  $("#new-custom").hidden = !other;
  $("#new-custom").required = other;
  $("#new-hint").hidden = !other;
});

$("#new-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const board = form.get("board") || form.get("custom").trim();
  try {
    await api("/api/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: form.get("name"), board }),
    });
    say(`✅ Создан проект ${form.get("name")} (${board})`);
    e.target.reset();
    $("#new-board").dispatchEvent(new Event("change"));
    loadProjects();
  } catch (err) {
    say("❌ " + err.message);
  }
});

loadProjects();
