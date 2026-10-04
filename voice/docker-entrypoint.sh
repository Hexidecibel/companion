#!/bin/bash
# Fetch the models into /models once, then serve (nice 10, capped threads).
set -euo pipefail
M="${HERALD_VOICE_MODELS:-/models}"
KOKORO_BASE="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
mkdir -p "$M"
for f in kokoro-v1.0.onnx voices-v1.0.bin; do
  if [ ! -s "$M/$f" ]; then
    echo "Downloading $f (first start only)..."
    curl -fsSL --retry 3 -o "$M/$f.part" "$KOKORO_BASE/$f"
    mv "$M/$f.part" "$M/$f"
  fi
done
if [ ! -d "$M/whisper" ] || [ -z "$(ls -A "$M/whisper" 2>/dev/null)" ]; then
  echo "Downloading Whisper ${HERALD_STT_MODEL:-base.en} (first start only)..."
  OMP_NUM_THREADS=2 python -c "
from faster_whisper import WhisperModel
WhisperModel('${HERALD_STT_MODEL:-base.en}', device='cpu', compute_type='int8', cpu_threads=2, download_root='$M/whisper')
" >/dev/null
fi
# Models are local now: never reach the network at runtime.
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
echo "Herald voice: serving on ${HERALD_VOICE_HOST}:${HERALD_VOICE_PORT} (TTS ${HERALD_TTS_THREADS} / STT ${HERALD_STT_THREADS} threads, nice 10)"
cd /app
exec nice -n 10 python -m herald_voice
