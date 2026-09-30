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

    def transcribe(self, pcm16):
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
