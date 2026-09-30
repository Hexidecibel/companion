"""Speech engines behind small interfaces so each can be swapped (e.g. for a GPU
build) without touching the HTTP layer.

All engines are synchronous and CPU-bound; the server runs each one on its own
single-worker executor so calls to one engine are serialised and the event loop
stays free. Nothing here writes audio or transcripts to disk.
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass
from typing import Protocol

import numpy as np

from .config import Settings

log = logging.getLogger("herald_voice")


@dataclass(frozen=True)
class VoiceInfo:
    id: str
    name: str
    lang: str
    gender: str

    def as_json(self) -> dict:
        return {"id": self.id, "name": self.name, "lang": self.lang, "gender": self.gender}


class TtsEngine(Protocol):
    sample_rate: int
    default_voice: str

    def voices(self) -> list[VoiceInfo]: ...
    def synthesize(self, text: str, voice: str, speed: float) -> np.ndarray:
        """Return mono int16 PCM at `sample_rate`."""
        ...


class SttEngine(Protocol):
    model_name: str

    def transcribe(self, pcm16: np.ndarray) -> str:
        """`pcm16`: mono int16 at 16 kHz."""
        ...


class WakeDetector(Protocol):
    def feed(self, pcm16: np.ndarray) -> tuple[float, str]:
        """Feed a chunk; return (best score in this chunk, model name)."""
        ...

    def reset(self) -> None: ...


# ---------------------------------------------------------------------------
# Kokoro TTS
# ---------------------------------------------------------------------------

# Friendly labels for the English Kokoro voices. Order = picker order.
KOKORO_VOICES: list[tuple[str, str]] = [
    ("af_heart", "Heart"),
    ("af_bella", "Bella"),
    ("af_nicole", "Nicole"),
    ("af_aoede", "Aoede"),
    ("af_kore", "Kore"),
    ("af_sarah", "Sarah"),
    ("af_nova", "Nova"),
    ("af_sky", "Sky"),
    ("af_alloy", "Alloy"),
    ("af_jessica", "Jessica"),
    ("af_river", "River"),
    ("am_michael", "Michael"),
    ("am_fenrir", "Fenrir"),
    ("am_puck", "Puck"),
    ("am_echo", "Echo"),
    ("am_eric", "Eric"),
    ("am_liam", "Liam"),
    ("am_onyx", "Onyx"),
    ("am_adam", "Adam"),
    ("bf_emma", "Emma"),
    ("bf_isabella", "Isabella"),
    ("bf_alice", "Alice"),
    ("bf_lily", "Lily"),
    ("bm_george", "George"),
    ("bm_fable", "Fable"),
    ("bm_lewis", "Lewis"),
    ("bm_daniel", "Daniel"),
]


def kokoro_voice_info(voice_id: str, label: str) -> VoiceInfo:
    lang = "en-GB" if voice_id.startswith("b") else "en-US"
    gender = "female" if voice_id[1:2] == "f" else "male"
    accent = "British" if lang == "en-GB" else "American"
    return VoiceInfo(voice_id, f"{label} ({accent} {gender})", lang, gender)


class KokoroTts:
    sample_rate = 24000

    def __init__(self, settings: Settings):
        import onnxruntime as ort
        from kokoro_onnx import Kokoro

        model = settings.models_dir / settings.tts_model
        voices = settings.models_dir / settings.tts_voices_file
        so = ort.SessionOptions()
        so.intra_op_num_threads = settings.tts_threads
        so.inter_op_num_threads = 1
        sess = ort.InferenceSession(str(model), so, providers=["CPUExecutionProvider"])
        self._k = Kokoro.from_session(sess, str(voices))
        available = set(self._k.get_voices())
        self._voices = [kokoro_voice_info(v, n) for v, n in KOKORO_VOICES if v in available]
        ids = {v.id for v in self._voices}
        self.default_voice = settings.tts_default_voice if settings.tts_default_voice in ids else "af_heart"
        # Warm the graph so the first real sentence is not the slow one.
        self._k.create("Ready.", voice=self.default_voice, speed=1.0, lang="en-us")

    def voices(self) -> list[VoiceInfo]:
        return list(self._voices)

    def synthesize(self, text: str, voice: str, speed: float) -> np.ndarray:
        if voice not in {v.id for v in self._voices}:
            voice = self.default_voice
        lang = "en-gb" if voice.startswith("b") else "en-us"
        samples, sr = self._k.create(text, voice=voice, speed=speed, lang=lang)
        if sr != self.sample_rate:
            raise RuntimeError(f"unexpected sample rate {sr}")
        return float_to_pcm16(samples)


# ---------------------------------------------------------------------------
# faster-whisper STT
# ---------------------------------------------------------------------------

# Whisper's well-known phantom outputs on near-silence.
_PHANTOM = re.compile(
    r"^\s*(thank you\.?|thanks for watching!?|you|bye\.?|\.+|\[.*\]|\(.*\))\s*$", re.IGNORECASE
)


class WhisperStt:
    def __init__(self, settings: Settings):
        from faster_whisper import WhisperModel

        self.model_name = settings.stt_model
        self._beam = settings.stt_beam_size
        self._m = WhisperModel(
            settings.stt_model,
            device="cpu",
            compute_type=settings.stt_compute_type,
            cpu_threads=settings.stt_threads,
            download_root=str(settings.models_dir / "whisper"),
        )
        self._m.transcribe(np.zeros(16000, dtype=np.float32), beam_size=1, language="en")

    def transcribe(self, pcm16: np.ndarray) -> str:
        audio = pcm16.astype(np.float32) / 32768.0
        segments, _ = self._m.transcribe(
            audio,
            beam_size=self._beam,
            language="en",
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            condition_on_previous_text=False,
            without_timestamps=True,
        )
        text = " ".join(s.text.strip() for s in segments).strip()
        return "" if _PHANTOM.match(text) else text


# ---------------------------------------------------------------------------
# openWakeWord
# ---------------------------------------------------------------------------


class OpenWakeWord:
    """One stateful detector (openWakeWord keeps a rolling feature buffer)."""

    def __init__(self, models: tuple[str, ...]):
        from openwakeword.model import Model

        self._m = Model(wakeword_models=list(models), inference_framework="onnx")

    def feed(self, pcm16: np.ndarray) -> tuple[float, str]:
        best, name = 0.0, ""
        # predict() returns the max over the 80 ms frames in a longer chunk.
        for i in range(0, len(pcm16), 1280 * 8):
            scores = self._m.predict(pcm16[i : i + 1280 * 8])
            for k, v in scores.items():
                if float(v) > best:
                    best, name = float(v), k
        return best, name

    def reset(self) -> None:
        self._m.reset()


# ---------------------------------------------------------------------------


def float_to_pcm16(samples: np.ndarray) -> np.ndarray:
    return (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2")


def build_tts(settings: Settings) -> TtsEngine:
    if settings.tts_engine != "kokoro":
        raise ValueError(f"unknown TTS engine {settings.tts_engine!r}")
    t0 = time.monotonic()
    eng = KokoroTts(settings)
    log.info("tts: kokoro %s ready in %.1fs (%d threads)", settings.tts_model, time.monotonic() - t0, settings.tts_threads)
    return eng


def build_stt(settings: Settings) -> SttEngine:
    if settings.stt_engine != "faster-whisper":
        raise ValueError(f"unknown STT engine {settings.stt_engine!r}")
    t0 = time.monotonic()
    eng = WhisperStt(settings)
    log.info("stt: faster-whisper %s/%s ready in %.1fs (%d threads)", settings.stt_model, settings.stt_compute_type, time.monotonic() - t0, settings.stt_threads)
    return eng


def build_wake(settings: Settings) -> WakeDetector:
    return OpenWakeWord(settings.wake_models)
