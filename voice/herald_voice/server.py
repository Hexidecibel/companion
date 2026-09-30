"""Herald voice service: HTTP on loopback, consumed only by the Companion daemon.

Endpoints (all bodies bounded; audio is never written to disk):
  GET    /health              engine readiness + voice list
  POST   /tts                 JSON {text, voice?, speed?} -> raw PCM16LE mono
                              (headers X-Sample-Rate, X-Synth-Ms, X-Audio-Ms)
  POST   /stt                 raw PCM16LE mono 16 kHz -> JSON {text, audioMs, sttMs, model}
  POST   /wake/{stream_id}    raw PCM16LE mono 16 kHz chunk -> JSON {detected, score, model}
  DELETE /wake/{stream_id}    drop that stream's detector state

The browser never talks to this service; the daemon authenticates clients and
proxies. Engines load in the background at startup so /health answers at once.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

import numpy as np
from aiohttp import web

from .config import Settings

log = logging.getLogger("herald_voice")

STREAM_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MAX_BODY = 4 * 1024 * 1024  # 4 MB covers 60 s of 16 kHz PCM16 with headroom


class Busy(Exception):
    pass


@dataclass
class EngineSlot:
    """One engine, its loader and a single-worker executor with a bounded queue."""

    name: str
    loader: Callable[[], Any]
    max_queue: int
    engine: Any = None
    error: Optional[str] = None
    loading: bool = False
    pending: int = 0
    executor: ThreadPoolExecutor = field(default=None)  # type: ignore[assignment]

    def __post_init__(self) -> None:
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix=f"hv-{self.name}")

    @property
    def ready(self) -> bool:
        return self.engine is not None

    async def load(self) -> None:
        if self.engine is not None or self.loading:
            return
        self.loading = True
        loop = asyncio.get_running_loop()
        try:
            self.engine = await loop.run_in_executor(self.executor, self.loader)
            self.error = None
        except Exception as exc:  # noqa: BLE001 - reported via /health
            self.error = f"{type(exc).__name__}: {exc}"
            log.error("%s: failed to load: %s", self.name, self.error)
        finally:
            self.loading = False

    async def run(self, fn: Callable[[Any], Any]) -> Any:
        if self.engine is None:
            raise web.HTTPServiceUnavailable(text=f"{self.name} engine not ready")
        if self.pending >= self.max_queue:
            raise Busy()
        self.pending += 1
        loop = asyncio.get_running_loop()
        try:
            return await loop.run_in_executor(self.executor, fn, self.engine)
        finally:
            self.pending -= 1

    def shutdown(self) -> None:
        self.executor.shutdown(wait=False, cancel_futures=True)


class WakeStreams:
    """Per-stream wake detectors (stateful), LRU-bounded with an idle TTL."""

    def __init__(self, factory: Callable[[], Any], max_streams: int, ttl_s: float):
        self._factory = factory
        self._max = max_streams
        self._ttl = ttl_s
        self._streams: "OrderedDict[str, tuple[Any, float]]" = OrderedDict()
        self._spare: list[Any] = []

    def get(self, sid: str) -> Any:
        """Called on the wake executor thread only."""
        now = time.monotonic()
        if sid in self._streams:
            det, _ = self._streams.pop(sid)
        else:
            while len(self._streams) >= self._max:
                _, (old, _) = self._streams.popitem(last=False)
                self._recycle(old)
            det = self._spare.pop() if self._spare else self._factory()
        self._streams[sid] = (det, now)
        return det

    def drop(self, sid: str) -> bool:
        item = self._streams.pop(sid, None)
        if item:
            self._recycle(item[0])
        return item is not None

    def sweep(self) -> int:
        now = time.monotonic()
        stale = [sid for sid, (_, ts) in self._streams.items() if now - ts > self._ttl]
        for sid in stale:
            self.drop(sid)
        return len(stale)

    def __len__(self) -> int:
        return len(self._streams)

    def _recycle(self, det: Any) -> None:
        try:
            det.reset()
        except Exception:  # noqa: BLE001
            return
        if len(self._spare) < 1:
            self._spare.append(det)


def pcm_from_body(body: bytes, max_seconds: float) -> np.ndarray:
    if len(body) % 2:
        raise web.HTTPBadRequest(text="PCM16 body must have an even byte length")
    if len(body) > max_seconds * 16000 * 2:
        raise web.HTTPRequestEntityTooLarge(max_size=int(max_seconds * 32000), actual_size=len(body))
    return np.frombuffer(body, dtype="<i2")


def create_app(
    settings: Settings,
    tts_loader: Callable[[], Any],
    stt_loader: Callable[[], Any],
    wake_factory: Callable[[], Any],
    preload: bool = True,
) -> web.Application:
    app = web.Application(client_max_size=MAX_BODY)
    tts = EngineSlot("tts", tts_loader, settings.max_queue)
    stt = EngineSlot("stt", stt_loader, settings.max_queue)
    # The wake "engine" is the stream table; detectors are created lazily per stream.
    wake = EngineSlot("wake", lambda: WakeStreams(wake_factory, settings.wake_max_streams, settings.wake_stream_ttl_s), settings.max_queue * 4)
    app["slots"] = {"tts": tts, "stt": stt, "wake": wake}
    app["settings"] = settings

    async def on_startup(app: web.Application) -> None:
        async def load_all() -> None:
            # Sequential: loading all three at once would spike every core.
            for slot in (tts, stt, wake):
                await slot.load()
            if wake.ready:
                # Build the first detector now so the first "Hey Jarvis" is fast.
                await wake.run(lambda streams: streams._spare.append(streams._factory()) if not streams._spare else None)

        async def sweeper() -> None:
            while True:
                await asyncio.sleep(15)
                if wake.ready:
                    try:
                        await wake.run(lambda s: s.sweep())
                    except Exception:  # noqa: BLE001
                        pass

        app["tasks"] = []
        if preload:
            app["tasks"].append(asyncio.create_task(load_all()))
        app["tasks"].append(asyncio.create_task(sweeper()))

    async def on_cleanup(app: web.Application) -> None:
        for t in app.get("tasks", []):
            t.cancel()
        for slot in app["slots"].values():
            slot.shutdown()

    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)

    def slot_state(slot: EngineSlot) -> dict:
        return {"ready": slot.ready, "loading": slot.loading, "error": slot.error, "pending": slot.pending}

    async def health(_req: web.Request) -> web.Response:
        tts_info: dict = slot_state(tts)
        if tts.ready:
            tts_info["voices"] = [v.as_json() for v in tts.engine.voices()]
            tts_info["defaultVoice"] = tts.engine.default_voice
            tts_info["sampleRate"] = tts.engine.sample_rate
        stt_info = slot_state(stt)
        stt_info["model"] = settings.stt_model
        wake_info = slot_state(wake)
        wake_info["models"] = list(settings.wake_models)
        wake_info["threshold"] = settings.wake_threshold
        wake_info["streams"] = len(wake.engine) if wake.ready else 0
        ok = tts.ready or stt.ready or wake.ready
        return web.json_response({"ok": ok, "tts": tts_info, "stt": stt_info, "wake": wake_info})

    async def post_tts(req: web.Request) -> web.Response:
        try:
            body = await req.json()
        except Exception:  # noqa: BLE001
            raise web.HTTPBadRequest(text="expected JSON")
        text = body.get("text") if isinstance(body, dict) else None
        if not isinstance(text, str) or not text.strip():
            raise web.HTTPBadRequest(text="text is required")
        text = text.strip()
        if len(text) > settings.tts_max_chars:
            raise web.HTTPRequestEntityTooLarge(max_size=settings.tts_max_chars, actual_size=len(text))
        voice = body.get("voice") if isinstance(body.get("voice"), str) else ""
        speed = body.get("speed", 1.0)
        speed = float(speed) if isinstance(speed, (int, float)) else 1.0
        speed = max(0.5, min(2.0, speed))
        t0 = time.monotonic()
        try:
            pcm = await tts.run(lambda e: e.synthesize(text, voice or e.default_voice, speed))
        except Busy:
            raise web.HTTPServiceUnavailable(text="tts busy")
        synth_ms = (time.monotonic() - t0) * 1000
        audio_ms = len(pcm) / tts.engine.sample_rate * 1000
        log.info("tts: %d chars -> %.0f ms audio in %.0f ms (rtf %.2f)", len(text), audio_ms, synth_ms, synth_ms / max(audio_ms, 1))
        return web.Response(
            body=pcm.tobytes(),
            content_type="audio/L16",
            headers={
                "X-Sample-Rate": str(tts.engine.sample_rate),
                "X-Synth-Ms": f"{synth_ms:.0f}",
                "X-Audio-Ms": f"{audio_ms:.0f}",
            },
        )

    async def post_stt(req: web.Request) -> web.Response:
        pcm = pcm_from_body(await req.read(), settings.stt_max_seconds)
        audio_ms = len(pcm) / 16
        if len(pcm) < 1600:  # < 100 ms: nothing to hear
            return web.json_response({"text": "", "audioMs": audio_ms, "sttMs": 0, "model": settings.stt_model})
        t0 = time.monotonic()
        try:
            text = await stt.run(lambda e: e.transcribe(pcm))
        except Busy:
            raise web.HTTPServiceUnavailable(text="stt busy")
        stt_ms = (time.monotonic() - t0) * 1000
        if settings.debug_transcripts:
            log.info("stt: %.0f ms audio in %.0f ms: %r", audio_ms, stt_ms, text)
        else:
            log.info("stt: %.0f ms audio in %.0f ms (%d chars)", audio_ms, stt_ms, len(text))
        return web.json_response({"text": text, "audioMs": round(audio_ms), "sttMs": round(stt_ms), "model": settings.stt_model})

    async def post_wake(req: web.Request) -> web.Response:
        sid = req.match_info["sid"]
        if not STREAM_ID.match(sid):
            raise web.HTTPBadRequest(text="bad stream id")
        pcm = pcm_from_body(await req.read(), 10.0)
        t0 = time.monotonic()
        try:
            score, name = await wake.run(lambda streams: streams.get(sid).feed(pcm))
        except Busy:
            raise web.HTTPServiceUnavailable(text="wake busy")
        detected = score >= settings.wake_threshold
        if detected:
            log.info("wake: %s detected (score %.3f) in %.0f ms", name, score, (time.monotonic() - t0) * 1000)
        return web.json_response({"detected": detected, "score": round(score, 4), "model": name})

    async def delete_wake(req: web.Request) -> web.Response:
        sid = req.match_info["sid"]
        if not STREAM_ID.match(sid):
            raise web.HTTPBadRequest(text="bad stream id")
        dropped = False
        if wake.ready:
            dropped = await wake.run(lambda streams: streams.drop(sid))
        return web.json_response({"dropped": dropped})

    app.router.add_get("/health", health)
    app.router.add_post("/tts", post_tts)
    app.router.add_post("/stt", post_stt)
    app.router.add_post("/wake/{sid}", post_wake)
    app.router.add_delete("/wake/{sid}", delete_wake)
    return app
