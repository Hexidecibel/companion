import { describe, expect, it, vi } from 'vitest';
import type { HeraldTtsRequest, HeraldTtsResult } from '../../../types/herald';
import {
  ServerTtsEngine,
  TtsRequestError,
  decodePcm16,
  splitForFastStart,
  type AudioSink,
  type TtsRequester,
} from '../serverTtsEngine';
import { HybridTtsEngine } from '../hybridTtsEngine';
import type { TtsEngine, TtsEvent } from '../types';
import { pickVoice, voicesForPicker } from '../voices';

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** base64 PCM16 of `n` samples. */
function audio(n: number): string {
  return btoa(String.fromCharCode(...new Uint8Array(n * 2)));
}

interface Pending {
  req: HeraldTtsRequest;
  resolve: (r: HeraldTtsResult) => void;
  reject: (e: Error) => void;
}

function fakeRequester() {
  const pending: Pending[] = [];
  const cancel = vi.fn();
  const requester: TtsRequester = {
    synth: (req) => new Promise((resolve, reject) => pending.push({ req, resolve, reject })),
    cancel,
  };
  const reply = (i: number, samples = 2400) =>
    pending[i].resolve({ audio: audio(samples), sampleRate: 24000, audioMs: samples / 24, synthMs: 10 });
  return { requester, pending, cancel, reply };
}

function fakeSink(running = true) {
  let t = 0;
  const scheduled: Array<{ when: number; dur: number; stopped: boolean; end: () => void }> = [];
  const sink: AudioSink = {
    isRunning: () => running,
    resume: async () => running,
    currentTime: () => t,
    play: (pcm, sr, when, onEnded) => {
      const item = { when, dur: pcm.length / sr, stopped: false, end: onEnded };
      scheduled.push(item);
      return { stop: () => { item.stopped = true; } };
    },
  };
  return { sink, scheduled, advance: (s: number) => { t += s; } };
}

function setup() {
  const r = fakeRequester();
  const s = fakeSink();
  const fallback = vi.fn();
  const engine = new ServerTtsEngine(r.requester, s.sink, fallback, () => 0);
  engine.setStatus(true, [{ id: 'af_heart', name: 'Heart', lang: 'en-US', gender: 'female' }], 'af_heart');
  const events: TtsEvent[] = [];
  engine.on((e) => events.push(e));
  return { ...r, ...s, fallback, engine, events };
}

describe('ServerTtsEngine', () => {
  it('plays chunks in queue order on a gapless timeline, whatever the arrival order', async () => {
    const { engine, pending, reply, scheduled } = setup();
    engine.speak('First sentence.', { rate: 1.1, voiceId: 'neural:af_heart' });
    engine.speak('Second sentence.');
    engine.speak('Third sentence.');
    expect(pending.map((p) => p.req.text)).toEqual(['First sentence.', 'Second sentence.', 'Third sentence.']);
    expect(pending[0].req).toEqual({ text: 'First sentence.', voice: 'af_heart', speed: 1.1 });
    reply(2);
    reply(1);
    await flush();
    expect(scheduled).toHaveLength(0); // head not ready yet
    reply(0);
    await flush();
    expect(scheduled).toHaveLength(3);
    // gapless: each starts exactly where the previous ends
    expect(scheduled[1].when).toBeCloseTo(scheduled[0].when + scheduled[0].dur, 9);
    expect(scheduled[2].when).toBeCloseTo(scheduled[1].when + scheduled[1].dur, 9);
    expect(engine.speaking).toBe(true);
    scheduled.forEach((x) => x.end());
    expect(engine.speaking).toBe(false);
  });

  it('barge-in stops playback, drops the client queue and cancels server synthesis', async () => {
    const { engine, reply, scheduled, cancel, pending } = setup();
    engine.speak('One.');
    engine.speak('Two.');
    reply(0);
    await flush();
    expect(scheduled).toHaveLength(1);
    engine.cancel();
    expect(scheduled[0].stopped).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1); // "Two." was still pending on the server
    expect(engine.speaking).toBe(false);
    // A late reply for the cancelled sentence must never play.
    reply(1);
    await flush();
    expect(scheduled).toHaveLength(1);
    expect(pending).toHaveLength(2);
  });

  it('service unavailable mid-reply: failed + later sentences go to the fallback in order', async () => {
    vi.useFakeTimers();
    try {
      const { engine, reply, pending, fallback, cancel } = setup();
      engine.speak('One.');
      engine.speak('Two.');
      engine.speak('Three.');
      reply(0);
      pending[1].reject(new TtsRequestError('Voice service unavailable', 'unavailable'));
      await flush();
      expect(engine.available).toBe(false);
      expect(cancel).toHaveBeenCalled();
      expect(fallback).not.toHaveBeenCalled(); // waits for scheduled audio to finish
      vi.advanceTimersByTime(200);
      expect(fallback.mock.calls.map((c) => c[0])).toEqual(['Two.', 'Three.']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a server-side "cancelled" reply is skipped, not treated as an outage', async () => {
    const { engine, reply, pending, scheduled, fallback } = setup();
    engine.speak('One.');
    engine.speak('Two.');
    pending[0].reject(new TtsRequestError('cancelled', 'cancelled'));
    reply(1);
    await flush();
    expect(scheduled).toHaveLength(1);
    expect(fallback).not.toHaveBeenCalled();
    expect(engine.available).toBe(true);
  });

  it('autoplay-blocked sink drops the backlog and reports blocked', async () => {
    const r = fakeRequester();
    const s = fakeSink(false);
    const engine = new ServerTtsEngine(r.requester, s.sink, vi.fn());
    engine.setStatus(true, [{ id: 'af_heart', name: 'Heart', lang: 'en-US', gender: 'female' }], 'af_heart');
    const events: TtsEvent[] = [];
    engine.on((e) => events.push(e));
    engine.speak('Hello.');
    r.reply(0);
    await flush();
    expect(events.some((e) => e.type === 'blocked')).toBe(true);
    expect(s.scheduled).toHaveLength(0);
    expect(engine.speaking).toBe(false);
  });

  it('splits only a long opening sentence at a clause boundary', () => {
    expect(splitForFastStart('Short one.')).toEqual(['Short one.']);
    expect(
      splitForFastStart('Two sessions finished cleanly, and the companion session is waiting on your approval.'),
    ).toEqual(['Two sessions finished cleanly,', 'and the companion session is waiting on your approval.']);
    // no usable boundary
    expect(splitForFastStart('a'.repeat(100))).toEqual(['a'.repeat(100)]);
    const idleSplit = setup();
    idleSplit.engine.speak('Two sessions finished cleanly, and the companion session is waiting on your approval.');
    expect(idleSplit.pending).toHaveLength(2);
  });

  it('decodes little-endian PCM16', () => {
    const b64 = btoa(String.fromCharCode(0x01, 0x00, 0xff, 0xff, 0x00, 0x80));
    expect(Array.from(decodePcm16(b64))).toEqual([1, -1, -32768]);
  });
});

function fakeWeb(): TtsEngine & { spoken: Array<[string, unknown]> } {
  const spoken: Array<[string, unknown]> = [];
  return {
    id: 'webspeech', available: true, speaking: false, spoken,
    speak: (t, o) => { spoken.push([t, o?.voiceId ?? null]); },
    cancel: vi.fn(), getVoices: () => [{ id: 'Samantha', name: 'Samantha', lang: 'en-US', local: true, isDefault: true }],
    unlock: vi.fn(), on: () => () => {}, dispose: vi.fn(),
  };
}

describe('HybridTtsEngine', () => {
  it('routes neural voices to the server and browser voices to Web Speech', () => {
    const web = fakeWeb();
    const r = fakeRequester();
    const h = new HybridTtsEngine(web, r.requester, fakeSink().sink);
    // service down: everything goes to the browser, neural ids are stripped
    h.speak('A.', { voiceId: 'neural:af_heart' });
    expect(web.spoken).toEqual([['A.', null]]);
    h.setServerStatus(true, [{ id: 'af_heart', name: 'Heart', lang: 'en-US', gender: 'female' }], 'af_heart');
    h.speak('B.', { voiceId: 'neural:af_heart' });
    h.speak('C.', { voiceId: null });
    h.speak('D.', { voiceId: 'Samantha' });
    expect(r.pending.map((p) => p.req.text)).toEqual(['B.', 'C.']);
    expect(web.spoken[web.spoken.length - 1]).toEqual(['D.', 'Samantha']);
    h.cancel();
    expect(web.cancel).toHaveBeenCalled();
  });

  it('lists neural voices first and auto-picks the neural default', () => {
    const h = new HybridTtsEngine(fakeWeb(), fakeRequester().requester, fakeSink().sink);
    h.setServerStatus(true, [
      { id: 'af_heart', name: 'Heart', lang: 'en-US', gender: 'female' },
      { id: 'am_michael', name: 'Michael', lang: 'en-US', gender: 'male' },
    ], 'af_heart');
    const voices = h.getVoices();
    expect(voices.map((v) => v.id)).toEqual(['neural:af_heart', 'neural:am_michael', 'Samantha']);
    expect(pickVoice(voices, null)?.id).toBe('neural:af_heart');
    expect(pickVoice(voices, 'Samantha')?.id).toBe('Samantha');
    const groups = voicesForPicker(voices);
    expect(groups.neural).toHaveLength(2);
    expect(groups.recommended.map((v) => v.id)).toEqual(['Samantha']);
  });
});
