# syntax=docker/dockerfile:1.7
#
# Herald voice service (Kokoro TTS, faster-whisper STT, openWakeWord), CPU.
# The optional "voice" profile in docker-compose.yml. Models are NOT in the
# image: the first start downloads them into the /models volume (~500 MB).
FROM python:3.12-slim-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates libgomp1 tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt /app/requirements.txt
# openwakeword --no-deps: its Linux metadata pins tflite-runtime (no 3.12
# wheel); the ONNX backend is used instead (same as bin/herald-voice install).
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-compile -r requirements.txt \
 && pip install --no-compile --no-deps "openwakeword>=0.6" \
 && python -c "import openwakeword.utils as u; u.download_models(model_names=['hey_jarvis'])" \
 && find /usr/local/lib/python3.12 -name '__pycache__' -prune -exec rm -rf {} +

COPY herald_voice /app/herald_voice
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod 755 /app/docker-entrypoint.sh \
 && useradd -m -u 1000 -s /usr/sbin/nologin herald \
 && mkdir -p /models && chown herald:herald /models

# Same caps as production (bin/herald-voice): keep the host responsive.
ENV HERALD_VOICE_HOST=0.0.0.0 \
    HERALD_VOICE_PORT=9889 \
    HERALD_VOICE_MODELS=/models \
    HERALD_TTS_THREADS=6 \
    HERALD_STT_THREADS=4 \
    HERALD_STT_MODEL=base.en \
    OMP_NUM_THREADS=4 \
    OPENBLAS_NUM_THREADS=2 \
    MKL_NUM_THREADS=2 \
    PYTHONUNBUFFERED=1

USER herald
EXPOSE 9889
VOLUME ["/models"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=600s --retries=3 \
  CMD ["python", "-c", "import json,sys,urllib.request as u; d=json.load(u.urlopen('http://127.0.0.1:9889/health', timeout=4)); sys.exit(0 if all(d[k]['ready'] for k in ('tts','stt','wake')) else 1)"]
ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker-entrypoint.sh"]
