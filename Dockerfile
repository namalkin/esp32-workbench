# ESP32 Workbench: сборка (PlatformIO) + прошивка из браузера (esptool-js, WebSerial).
# Интернет нужен только для `docker compose build`; дальше всё работает офлайн.

# esptool-js вшиваем в образ, чтобы страница не ходила в CDN
FROM node:20-alpine AS esptool
ARG ESPTOOL_JS_VERSION=0.6.1
RUN cd /tmp && npm pack esptool-js@${ESPTOOL_JS_VERSION} && tar xzf esptool-js-${ESPTOOL_JS_VERSION}.tgz

FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

ARG PLATFORMIO_VERSION=6.1.19
RUN pip install --no-cache-dir platformio==${PLATFORMIO_VERSION}

# Без телеметрии и проверок обновлений — офлайн pio не должен ничего ждать из сети
ENV PLATFORMIO_SETTING_ENABLE_TELEMETRY=No \
    PLATFORMIO_SETTING_CHECK_PLATFORMIO_INTERVAL=3650 \
    PLATFORMIO_SETTING_CHECK_PRUNE_SYSTEM_THRESHOLD=0 \
    PYTHONUNBUFFERED=1

# Прогреваем тулчейны: собираем пустой проект под каждую плату из warmup/platformio.ini
COPY warmup/ /opt/warmup/
RUN pio run -d /opt/warmup && rm -rf /opt/warmup/.pio

COPY app/ /app/
COPY --from=esptool /tmp/package/bundle.js /app/static/vendor/esptool-bundle.js
COPY --from=esptool /tmp/package/LICENSE /app/static/vendor/esptool-js.LICENSE

EXPOSE 8090
CMD ["python", "/app/server.py"]
