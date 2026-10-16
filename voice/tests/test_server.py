"""Endpoint tests with fake engines (no models needed). Run: bin/herald-voice test"""

from __future__ import annotations

import asyncio

import numpy as np
import pytest

from herald_voice.config import Settings
from herald_voice.engines import VoiceInfo
from herald_voice.server import create_app


class FakeTts:
    sample_rate = 24000
    default_voice = "af_heart"

    def __init__(self):
        self.calls = []

    def voices(self):
        return [VoiceInfo("af_heart", "Heart (American female)", "en-US", "female")]

    def synthesize(self, text, voice, speed):
        self.calls.append((text, voice, speed))
        return np.zeros(2400, dtype="<i2")  # 100 ms


class FakeStt:
    model_name = "fake"
    last_hints: dict = {}

    def transcribe(self, pcm16, prompt=None, hotwords=None):
        FakeStt.last_hints = {"prompt": prompt, "hotwords": hotwords}
        return f"heard {len(pcm16)} samples"


class FakeWake:
    def __init__(self):
        self.fed = 0

    def feed(self, pcm16):
        self.fed += len(pcm16)
        # "Detects" once it has heard a full second on this stream.
        return (0.9 if self.fed >= 16000 else 0.1), "hey_jarvis"

    def reset(self):
        self.fed = 0


def make_app(**kw):
    s = Settings(**kw)
    tts = FakeTts()
    app = create_app(s, tts_loader=lambda: tts, stt_loader=FakeStt, wake_factory=FakeWake, preload=True)
    app["fake_tts"] = tts
    return app


async def ready(client):
    for _ in range(100):
        r = await client.get("/health")
        body = await r.json()
        if body["tts"]["ready"] and body["stt"]["ready"] and body["wake"]["ready"]:
            return body
        await asyncio.sleep(0.02)
    raise AssertionError("engines never became ready")


async def test_health_lists_voices(aiohttp_client):
    client = await aiohttp_client(make_app())
    body = await ready(client)
    assert body["ok"] is True
    assert body["tts"]["defaultVoice"] == "af_heart"
    assert body["tts"]["voices"][0]["id"] == "af_heart"
    assert body["wake"]["models"] == ["hey_jarvis"]


async def test_tts_returns_pcm_with_headers(aiohttp_client):
    app = make_app()
    client = await aiohttp_client(app)
    await ready(client)
    r = await client.post("/tts", json={"text": "Hello there.", "voice": "af_heart", "speed": 9})
    assert r.status == 200
    assert r.headers["X-Sample-Rate"] == "24000"
    assert len(await r.read()) == 4800
    # speed is clamped
    assert app["fake_tts"].calls[-1] == ("Hello there.", "af_heart", 2.0)


async def test_tts_validation(aiohttp_client):
    client = await aiohttp_client(make_app(tts_max_chars=10))
    await ready(client)
    assert (await client.post("/tts", json={"text": "  "})).status == 400
    assert (await client.post("/tts", data=b"nope")).status == 400
    assert (await client.post("/tts", json={"text": "x" * 11})).status == 413


async def test_stt_transcribes_and_rejects_bad_bodies(aiohttp_client):
    client = await aiohttp_client(make_app(stt_max_seconds=1.0))
    await ready(client)
    pcm = np.zeros(8000, dtype="<i2").tobytes()
    r = await client.post("/stt", data=pcm)
    body = await r.json()
    assert body["text"] == "heard 8000 samples"
    assert body["audioMs"] == 500
    # too short -> empty, no engine call
    assert (await (await client.post("/stt", data=b"\0\0" * 10)).json())["text"] == ""
    assert (await client.post("/stt", data=b"\0\0\0")).status == 400
    assert (await client.post("/stt", data=b"\0\0" * 17000)).status == 413


async def test_wake_is_stateful_per_stream(aiohttp_client):
    client = await aiohttp_client(make_app())
    await ready(client)
    half = np.zeros(8000, dtype="<i2").tobytes()
    a1 = await (await client.post("/wake/a", data=half)).json()
    b1 = await (await client.post("/wake/b", data=half)).json()
    a2 = await (await client.post("/wake/a", data=half)).json()
    assert not a1["detected"] and not b1["detected"]
    assert a2["detected"] and a2["model"] == "hey_jarvis"
    assert (await (await client.delete("/wake/a")).json())["dropped"] is True
    a3 = await (await client.post("/wake/a", data=half)).json()
    assert not a3["detected"]  # fresh state after drop
    assert (await client.post("/wake/bad id!", data=half)).status in (400, 404)


async def test_wake_logs_detection_and_best_score_per_stream(aiohttp_client, caplog):
    client = await aiohttp_client(make_app())
    await ready(client)
    half = np.zeros(8000, dtype="<i2").tobytes()
    caplog.set_level("INFO", logger="herald_voice")
    await client.post("/wake/quiet", data=half)
    await client.delete("/wake/quiet")
    await client.post("/wake/hit", data=half)
    await client.post("/wake/hit", data=half)
    await client.delete("/wake/hit")
    text = "\n".join(r.getMessage() for r in caplog.records)
    assert "wake: stream quiet ended, best score 0.100 (threshold" in text
    assert "wake: hey_jarvis detected (score 0.900)" in text
    assert "wake: stream hit ended, best score 0.900" in text and ", detected" in text


async def test_wake_streams_are_bounded(aiohttp_client):
    app = make_app(wake_max_streams=2)
    client = await aiohttp_client(app)
    await ready(client)
    chunk = np.zeros(1280, dtype="<i2").tobytes()
    for sid in ("s1", "s2", "s3", "s4"):
        await client.post(f"/wake/{sid}", data=chunk)
    body = await (await client.get("/health")).json()
    assert body["wake"]["streams"] == 2


async def test_not_ready_is_503(aiohttp_client):
    s = Settings()
    app = create_app(s, tts_loader=FakeTts, stt_loader=FakeStt, wake_factory=FakeWake, preload=False)
    client = await aiohttp_client(app)
    assert (await client.post("/tts", json={"text": "hi"})).status == 503
    assert (await client.post("/stt", data=b"\0\0" * 2000)).status == 503


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def test_stt_passes_vocabulary_hints(aiohttp_client):
    client = await aiohttp_client(make_app())
    await ready(client)
    pcm = np.zeros(8000, dtype="<i2").tobytes()
    FakeStt.last_hints = {}
    r = await client.post("/stt?prompt=Herald%2C%20Jarvis.%20Sessions%3A%20Out4.&hotwords=Herald%20Out4", data=pcm)
    assert (await r.json())["text"] == "heard 8000 samples"
    assert FakeStt.last_hints == {"prompt": "Herald, Jarvis. Sessions: Out4.", "hotwords": "Herald Out4"}
    # Oversized hints are clipped, never rejected.
    r = await client.post("/stt?prompt=" + "a" * 5000, data=pcm)
    assert r.status == 200
    assert len(FakeStt.last_hints["prompt"]) == 800
    assert FakeStt.last_hints["hotwords"] is None


def test_prompt_echo_guard():
    from herald_voice.engines import echoes_prompt

    prompt = "Herald, Jarvis. Sessions: Out4, Doc Upload Site, Companion. tmux, deploy, Haiku."
    assert echoes_prompt("Sessions: Out4, Doc Upload Site.", prompt)
    assert echoes_prompt("tmux, deploy, Haiku", prompt) is False  # three words: could be real
    assert not echoes_prompt("Companion.", prompt)
    assert not echoes_prompt("Tell Out4 to hold the refunds.", prompt)
    assert not echoes_prompt("Doc Upload Site deploy", None)


# ---------------------------------------------------------------------------
# Idle unload (HERALD_VOICE_IDLE_UNLOAD_S)


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def make_idle_app(idle=60.0):
    clock = Clock()
    loads = {"tts": 0, "stt": 0, "wake": 0}

    def tts_loader():
        loads["tts"] += 1
        return FakeTts()

    def stt_loader():
        loads["stt"] += 1
        return FakeStt()

    def wake_factory():
        loads["wake"] += 1
        return FakeWake()

    app = create_app(
        Settings(idle_unload_s=idle),
        tts_loader=tts_loader,
        stt_loader=stt_loader,
        wake_factory=wake_factory,
        preload=True,
        clock=clock,
        sweep_interval_s=0.01,
    )
    return app, clock, loads


async def wait_for(cond, n=200):
    for _ in range(n):
        if cond():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("condition never became true")


async def test_idle_engines_unload_stay_healthy_and_reload_on_use(aiohttp_client):
    app, clock, loads = make_idle_app(60.0)
    client = await aiohttp_client(app)
    await ready(client)
    slots = app["slots"]
    assert all(s.loaded for s in slots.values())

    clock.t += 30  # not idle long enough
    await asyncio.sleep(0.05)
    assert all(s.loaded for s in slots.values())

    clock.t += 61
    await wait_for(lambda: not any(s.loaded for s in slots.values()))
    body = await (await client.get("/health")).json()
    for k in ("tts", "stt", "wake"):
        assert body[k]["ready"] is True, k
        assert body[k]["loaded"] is False and body[k]["idleUnloaded"] is True
    # Voices stay listed while unloaded (the daemon's voice picker needs them).
    assert body["tts"]["voices"][0]["id"] == "af_heart"
    assert body["tts"]["sampleRate"] == 24000

    # Next request reloads transparently.
    r = await client.post("/tts", json={"text": "hello"})
    assert r.status == 200 and r.headers["X-Sample-Rate"] == "24000"
    assert loads["tts"] == 2 and slots["tts"].loaded
    r = await client.post("/stt", data=np.zeros(16000, dtype="<i2").tobytes())
    assert r.status == 200 and loads["stt"] == 2
    r = await client.post("/wake/s1", data=np.zeros(1600, dtype="<i2").tobytes())
    assert r.status == 200 and slots["wake"].loaded
    # Only the reloaded ones are loaded; the rest stay unloaded until used.
    body = await (await client.get("/health")).json()
    assert body["tts"]["loaded"] is True and body["tts"]["idleUnloaded"] is False


async def test_concurrent_requests_share_one_reload(aiohttp_client):
    app, clock, loads = make_idle_app(60.0)
    client = await aiohttp_client(app)
    await ready(client)
    clock.t += 120
    await wait_for(lambda: not app["slots"]["tts"].loaded)
    rs = await asyncio.gather(*[client.post("/tts", json={"text": f"hi {i}"}) for i in range(4)])
    assert [r.status for r in rs] == [200] * 4
    assert loads["tts"] == 2


async def test_wake_housekeeping_does_not_keep_engines_loaded(aiohttp_client):
    app, clock, _ = make_idle_app(60.0)
    client = await aiohttp_client(app)
    await ready(client)
    # A dropped stream is housekeeping, not use.
    await client.delete("/wake/nobody")
    clock.t += 61
    await wait_for(lambda: not app["slots"]["wake"].loaded)


async def test_zero_disables_idle_unload(aiohttp_client):
    app, clock, _ = make_idle_app(0.0)
    client = await aiohttp_client(app)
    await ready(client)
    clock.t += 10**6
    await asyncio.sleep(0.05)
    assert all(s.loaded for s in app["slots"].values())


def test_status_reports_unloaded_as_ready(tmp_path):
    import json
    import os
    import subprocess
    import sys

    eng = {"ready": True, "loaded": False, "idleUnloaded": True, "loading": False, "error": None}
    health = {
        "ok": True,
        "tts": {**eng, "voices": [{"id": "af_heart"}], "defaultVoice": "af_heart"},
        "stt": {**eng, "model": "base.en"},
        "wake": {**eng, "models": ["hey_jarvis"], "threshold": 0.5},
    }
    script = os.path.join(os.path.dirname(__file__), "..", "herald_voice", "status.py")
    r = subprocess.run(
        [sys.executable, script],
        input=json.dumps(health),
        capture_output=True,
        text=True,
        env={**os.environ, "PID": "1", "OWNER": "1", "PORT": "9889", "CPU": "0", "RSS": "1 MB"},
    )
    assert r.returncode == 0, r.stdout
    assert "HEALTHY" in r.stdout and "idle, unloaded" in r.stdout
