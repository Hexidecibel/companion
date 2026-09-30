"""Runtime settings for the Herald voice service, read from the environment only.

Everything here is non-secret. Defaults are tuned for a CPU-only box: thread
counts are capped so synthesis and transcription never starve the host.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _int(name: str, default: int, lo: int, hi: int) -> int:
    try:
        v = int(os.environ.get(name, default))
    except ValueError:
        return default
    return max(lo, min(hi, v))


def _float(name: str, default: float, lo: float, hi: float) -> float:
    try:
        v = float(os.environ.get(name, default))
    except ValueError:
        return default
    return max(lo, min(hi, v))


def _flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


DEFAULT_MODELS_DIR = Path.home() / ".local" / "share" / "herald-voice" / "models"


@dataclass(frozen=True)
class Settings:
    host: str = "127.0.0.1"
    port: int = 9889
    models_dir: Path = DEFAULT_MODELS_DIR

    # TTS (Kokoro via kokoro-onnx)
    tts_engine: str = "kokoro"
    tts_model: str = "kokoro-v1.0.onnx"
    tts_voices_file: str = "voices-v1.0.bin"
    tts_default_voice: str = "af_heart"
    tts_threads: int = 6
    tts_max_chars: int = 600

    # STT (faster-whisper)
    stt_engine: str = "faster-whisper"
    stt_model: str = "base.en"
    stt_compute_type: str = "int8"
    stt_threads: int = 4
    stt_max_seconds: float = 60.0
    stt_beam_size: int = 1

    # Wake word (openWakeWord)
    wake_models: tuple[str, ...] = ("hey_jarvis",)
    wake_threshold: float = 0.5
    wake_max_streams: int = 4
    wake_stream_ttl_s: float = 60.0

    # Backpressure: requests queued per engine before we answer 503.
    max_queue: int = 8

    # Transcripts are user data: logged only when this is set.
    debug_transcripts: bool = False

    extra: dict = field(default_factory=dict)


def load_settings() -> Settings:
    host = os.environ.get("HERALD_VOICE_HOST", "127.0.0.1").strip() or "127.0.0.1"
    wake = tuple(
        w.strip() for w in os.environ.get("HERALD_WAKE_MODELS", "hey_jarvis").split(",") if w.strip()
    ) or ("hey_jarvis",)
    return Settings(
        host=host,
        port=_int("HERALD_VOICE_PORT", 9889, 1, 65535),
        models_dir=Path(os.environ.get("HERALD_VOICE_MODELS", str(DEFAULT_MODELS_DIR))).expanduser(),
        tts_engine=os.environ.get("HERALD_TTS_ENGINE", "kokoro"),
        tts_model=os.environ.get("HERALD_TTS_MODEL", "kokoro-v1.0.onnx"),
        tts_voices_file=os.environ.get("HERALD_TTS_VOICES", "voices-v1.0.bin"),
        tts_default_voice=os.environ.get("HERALD_TTS_VOICE", "af_heart"),
        tts_threads=_int("HERALD_TTS_THREADS", 6, 1, 8),
        stt_engine=os.environ.get("HERALD_STT_ENGINE", "faster-whisper"),
        stt_model=os.environ.get("HERALD_STT_MODEL", "base.en"),
        stt_compute_type=os.environ.get("HERALD_STT_COMPUTE", "int8"),
        stt_threads=_int("HERALD_STT_THREADS", 4, 1, 8),
        stt_beam_size=_int("HERALD_STT_BEAM", 1, 1, 5),
        wake_models=wake,
        wake_threshold=_float("HERALD_WAKE_THRESHOLD", 0.5, 0.05, 0.99),
        debug_transcripts=_flag("HERALD_DEBUG_TOOLS"),
    )
