import {
  VoiceRequestError,
  VoiceServiceClient,
  VoiceUnavailableError,
} from '../src/herald/voice/client';
import { HeraldVoiceService, VoiceError } from '../src/herald/voice/service';
import { stripWakePhrase } from '../src/herald/voice/wake-phrase';
import { registerHeraldHandlers } from '../src/handlers/herald';
import { resolveVoiceUrl } from '../src/herald/config';

const pcm = (samples: number) => Buffer.alloc(samples * 2).toString('base64');
const flush = () => new Promise((r) => setImmediate(r));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    baseUrl: 'http://127.0.0.1:9889',
    health: jest.fn(async () => ({
      ok: true,
      tts: { ready: true, voices: [{ id: 'af_heart', name: 'Heart', lang: 'en-US', gender: 'female' }], defaultVoice: 'af_heart', sampleRate: 24000 },
      stt: { ready: true, model: 'base.en' },
      wake: { ready: true, models: ['hey_jarvis'] },
    })),
    tts: jest.fn(async (text: string) => ({ pcm: Buffer.from(text), sampleRate: 24000, synthMs: 5, audioMs: 100 })),
    stt: jest.fn(async () => ({ text: 'Hey Jarvis, anything for me?', audioMs: 1000, sttMs: 40 })),
    wake: jest.fn(async () => ({ detected: false, score: 0.01, model: 'hey_jarvis' })),
    dropWake: jest.fn(async () => undefined),
    ...overrides,
  } as any;
}

function makeService(client = fakeClient()) {
  const events: Array<[string, any]> = [];
  const svc = new HeraldVoiceService({ client, sendEvent: (id, e) => events.push([id, e]) });
  return { svc, client, events };
}

describe('VoiceServiceClient', () => {
  it('maps connection failures and timeouts to VoiceUnavailableError', async () => {
    const refused = new VoiceServiceClient('http://x', (async () => {
      throw new TypeError('fetch failed');
    }) as any);
    await expect(refused.health()).rejects.toBeInstanceOf(VoiceUnavailableError);

    const hang = new VoiceServiceClient(
      'http://x',
      ((_u: string, init: RequestInit) =>
        new Promise((_res, rej) => {
          init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        })) as any,
      { health: 20, tts: 20, stt: 20, wake: 20 }
    );
    const t0 = Date.now();
    await expect(hang.stt(Buffer.alloc(4))).rejects.toThrow('timed out');
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('503 is unavailable, other HTTP errors are request errors, caller abort is cancelled', async () => {
    const mk = (status: number) =>
      new VoiceServiceClient('http://x', (async () => new Response('nope', { status })) as any);
    await expect(mk(503).tts('hi', null, 1)).rejects.toBeInstanceOf(VoiceUnavailableError);
    await expect(mk(413).tts('hi', null, 1)).rejects.toBeInstanceOf(VoiceRequestError);

    const ctrl = new AbortController();
    const slow = new VoiceServiceClient(
      'http://x',
      ((_u: string, init: RequestInit) =>
        new Promise((_res, rej) => {
          init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' })));
        })) as any
    );
    const p = slow.tts('hi', null, 1, ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ status: 499 });
  });

  it('decodes TTS audio and timing headers', async () => {
    const c = new VoiceServiceClient('http://x', (async () =>
      new Response(new Uint8Array([1, 0, 2, 0]), {
        status: 200,
        headers: { 'x-sample-rate': '24000', 'x-synth-ms': '120', 'x-audio-ms': '300' },
      })) as any);
    const a = await c.tts('Hello.', 'af_heart', 1);
    expect(a.pcm.length).toBe(4);
    expect(a).toMatchObject({ sampleRate: 24000, synthMs: 120, audioMs: 300 });
  });
});

describe('HeraldVoiceService TTS', () => {
  it('synthesizes in request order, one in flight per client', async () => {
    const gates: Array<ReturnType<typeof deferred<any>>> = [];
    const client = fakeClient({
      tts: jest.fn((text: string) => {
        const d = deferred<any>();
        gates.push(d);
        return d.promise.then(() => ({ pcm: Buffer.from(text), sampleRate: 24000, synthMs: 1, audioMs: 1 }));
      }),
    });
    const { svc } = makeService(client);
    const order: string[] = [];
    const p1 = svc.synthesize('c1', { text: 'One.' }).then((r) => order.push(Buffer.from(r.audio, 'base64').toString()));
    const p2 = svc.synthesize('c1', { text: 'Two.' }).then((r) => order.push(Buffer.from(r.audio, 'base64').toString()));
    await flush();
    expect(client.tts).toHaveBeenCalledTimes(1);
    gates[0].resolve(null);
    await p1;
    await flush();
    expect(client.tts).toHaveBeenCalledTimes(2);
    gates[1].resolve(null);
    await Promise.all([p1, p2]);
    expect(order).toEqual(['One.', 'Two.']);
  });

  it('cancel (barge-in) aborts the in-flight request and rejects the queue', async () => {
    let aborted = false;
    const client = fakeClient({
      tts: jest.fn(
        (_t: string, _v: unknown, _s: number, signal: AbortSignal) =>
          new Promise((_res, rej) => {
            signal.addEventListener('abort', () => {
              aborted = true;
              rej(new VoiceRequestError('cancelled', 499));
            });
          })
      ),
    });
    const { svc } = makeService(client);
    const a = svc.synthesize('c1', { text: 'First.' });
    const b = svc.synthesize('c1', { text: 'Second.' });
    await flush();
    expect(svc.cancelTts('c1')).toBe(2);
    await expect(a).rejects.toMatchObject({ code: 'cancelled' });
    await expect(b).rejects.toMatchObject({ code: 'cancelled' });
    expect(aborted).toBe(true);
    expect(client.tts).toHaveBeenCalledTimes(1);
  });

  it('validates input and clamps speed / voice', async () => {
    const { svc, client } = makeService();
    await expect(svc.synthesize('c1', { text: '  ' })).rejects.toBeInstanceOf(VoiceError);
    await expect(svc.synthesize('c1', { text: 'x'.repeat(601) })).rejects.toMatchObject({ code: 'bad_request' });
    await svc.synthesize('c1', { text: 'Hi.', speed: 9, voice: '../etc' });
    expect(client.tts).toHaveBeenLastCalledWith('Hi.', null, 2, expect.anything());
  });

  it('service down -> unavailable, then fails fast until the next probe', async () => {
    const client = fakeClient({
      tts: jest.fn(async () => {
        throw new VoiceUnavailableError();
      }),
      health: jest.fn(async () => {
        throw new VoiceUnavailableError();
      }),
    });
    const { svc } = makeService(client);
    await expect(svc.synthesize('c1', { text: 'Hi.' })).rejects.toMatchObject({ code: 'unavailable' });
    const st = await svc.status('c1');
    expect(st.available).toBe(false);
    await expect(svc.synthesize('c1', { text: 'Again.' })).rejects.toMatchObject({ code: 'unavailable' });
    expect(client.tts).toHaveBeenCalledTimes(1);
  });

  it('status probes health once for concurrent callers', async () => {
    const { svc, client } = makeService();
    const [a, b] = await Promise.all([svc.status('c1'), svc.status('c2')]);
    expect(client.health).toHaveBeenCalledTimes(1);
    expect(a.tts.defaultVoice).toBe('af_heart');
    expect(b.available).toBe(true);
  });
});

describe('HeraldVoiceService streams', () => {
  it('buffers PCM chunks and transcribes on end', async () => {
    const client = fakeClient({ stt: jest.fn(async (b: Buffer) => ({ text: ` ${b.length} bytes `, audioMs: 0, sttMs: 30 })) });
    const { svc } = makeService(client);
    svc.startStream('c1', { streamId: 's1', purpose: 'stt', sampleRate: 16000 });
    svc.pushAudio('c1', { streamId: 's1', seq: 0, pcm: pcm(1600) });
    svc.pushAudio('c1', { streamId: 's1', seq: 1, pcm: pcm(1600) });
    svc.pushAudio('c2', { streamId: 's1', seq: 2, pcm: pcm(1600) }); // not the owner: ignored
    const r = await svc.endStream('c1', { streamId: 's1', action: 'transcribe' });
    expect(r).toEqual({ text: '6400 bytes', audioMs: 200, sttMs: 30, woke: false });
    expect(svc.openStreams).toBe(0);
  });

  it('rejects malformed framing and enforces caps', async () => {
    const { svc, events } = makeService();
    expect(() => svc.startStream('c1', { streamId: 'bad id', purpose: 'stt', sampleRate: 16000 })).toThrow(VoiceError);
    expect(() => svc.startStream('c1', { streamId: 'a', purpose: 'stt', sampleRate: 48000 })).toThrow('16000');
    svc.startStream('c1', { streamId: 'odd', purpose: 'stt', sampleRate: 16000 });
    svc.pushAudio('c1', { streamId: 'odd', seq: 0, pcm: Buffer.alloc(3).toString('base64') });
    expect(events.pop()).toEqual(['c1', { kind: 'stream_error', streamId: 'odd', error: 'audio chunk must be PCM16' }]);
    svc.startStream('c1', { streamId: 'big', purpose: 'stt', sampleRate: 16000 });
    svc.pushAudio('c1', { streamId: 'big', seq: 0, pcm: pcm(40000) });
    expect(events.pop()![1]).toMatchObject({ kind: 'stream_error', error: 'audio chunk too large' });
    for (const id of ['x1', 'x2', 'x3']) svc.startStream('c1', { streamId: id, purpose: 'stt', sampleRate: 16000 });
    expect(() => svc.startStream('c1', { streamId: 'x4', purpose: 'stt', sampleRate: 16000 })).toThrow('Too many');
  });

  it('utterances over 60 s are cut off', () => {
    const { svc, events } = makeService();
    svc.startStream('c1', { streamId: 'long', purpose: 'stt', sampleRate: 16000 });
    for (let i = 0; i < 31; i++) svc.pushAudio('c1', { streamId: 'long', seq: i, pcm: pcm(32000) });
    expect(events.at(-1)![1]).toMatchObject({ kind: 'stream_error', error: 'utterance too long' });
    expect(svc.openStreams).toBe(0);
  });

  it('idle streams are swept', () => {
    let now = 1000;
    const events: any[] = [];
    const svc = new HeraldVoiceService({ client: fakeClient(), sendEvent: (_c, e) => events.push(e), now: () => now });
    svc.startStream('c1', { streamId: 's', purpose: 'stt', sampleRate: 16000 });
    now += 25_000;
    svc.sweep();
    expect(events[0]).toMatchObject({ kind: 'stream_error', error: 'stream idle' });
  });
});

describe('HeraldVoiceService wake word', () => {
  it('coalesces chunks while a check is in flight and emits wake once', async () => {
    const gates: Array<ReturnType<typeof deferred<any>>> = [];
    const client = fakeClient({
      wake: jest.fn(() => {
        const d = deferred<any>();
        gates.push(d);
        return d.promise;
      }),
    });
    const { svc, events } = makeService(client);
    svc.startStream('c1', { streamId: 'w', purpose: 'wake', sampleRate: 16000 });
    svc.pushAudio('c1', { streamId: 'w', seq: 0, pcm: pcm(1280) });
    svc.pushAudio('c1', { streamId: 'w', seq: 1, pcm: pcm(1280) });
    svc.pushAudio('c1', { streamId: 'w', seq: 2, pcm: pcm(1280) });
    expect(client.wake).toHaveBeenCalledTimes(1);
    gates[0].resolve({ detected: false, score: 0.1, model: 'hey_jarvis' });
    await flush();
    await flush();
    expect(client.wake).toHaveBeenCalledTimes(2);
    expect((client.wake.mock.calls[1][1] as Buffer).length).toBe(1280 * 2 * 2); // two coalesced chunks
    gates[1].resolve({ detected: true, score: 0.97, model: 'hey_jarvis' });
    await flush();
    await flush();
    expect(events).toEqual([['c1', { kind: 'wake', streamId: 'w', score: 0.97, model: 'hey_jarvis' }]]);
    // After waking, audio keeps buffering but is not re-checked.
    svc.pushAudio('c1', { streamId: 'w', seq: 3, pcm: pcm(1280) });
    expect(client.wake).toHaveBeenCalledTimes(2);
    const r = await svc.endStream('c1', { streamId: 'w', action: 'transcribe' });
    expect(r).toMatchObject({ text: 'Anything for me?', woke: true });
    expect(client.dropWake).toHaveBeenCalledWith('w');
  });

  it('an un-woken wake stream never runs STT', async () => {
    const { svc, client } = makeService();
    svc.startStream('c1', { streamId: 'w2', purpose: 'wake', sampleRate: 16000 });
    svc.pushAudio('c1', { streamId: 'w2', seq: 0, pcm: pcm(1280) });
    await flush();
    const r = await svc.endStream('c1', { streamId: 'w2', action: 'transcribe' });
    expect(r).toMatchObject({ text: '', woke: false });
    expect(client.stt).not.toHaveBeenCalled();
  });
});

describe('hands-free arbitration', () => {
  it('only one client holds hands-free; the previous owner is told to stand down', () => {
    const { svc, events } = makeService();
    expect(svc.setHandsFree('phone', true)).toEqual({ owner: true });
    expect(svc.setHandsFree('laptop', true)).toEqual({ owner: true });
    expect(events).toEqual([['phone', { kind: 'handsfree_revoked' }]]);
    expect(svc.handsFreeClient).toBe('laptop');
    // A stale "off" from the revoked device must not release the new owner.
    svc.setHandsFree('phone', false);
    expect(svc.handsFreeClient).toBe('laptop');
    svc.clientGone('laptop');
    expect(svc.handsFreeClient).toBeNull();
  });

  it('status reports ownership per client', async () => {
    const { svc } = makeService();
    svc.setHandsFree('a', true);
    expect((await svc.status('a')).handsFreeOwner).toBe(true);
    expect((await svc.status('b')).handsFreeOwner).toBe(false);
  });
});

describe('stripWakePhrase', () => {
  it.each([
    ['Hey Jarvis, anything for me?', 'Anything for me?'],
    ['hey jarvis. what is blocked', 'What is blocked'],
    ['Jarvis what finished', 'What finished'],
    ['Hey, Jarvis!', ''],
    ['Hey Jervis, status', 'Status'],
    ['Anything for me?', 'Anything for me?'],
    ['Hey there Jarvis', 'Hey there Jarvis'],
  ])('%s -> %s', (input, out) => {
    expect(stripWakePhrase(input)).toBe(out);
  });
});

describe('voice config + handlers', () => {
  it('resolves the voice URL (env > config > default), null when disabled', () => {
    expect(resolveVoiceUrl(undefined, {})).toBe('http://127.0.0.1:9889');
    expect(resolveVoiceUrl({ voice_url: 'http://gpu.local:9889/' }, {})).toBe('http://gpu.local:9889');
    expect(resolveVoiceUrl({ voice_url: 'http://a:1' }, { HERALD_VOICE_URL: 'http://b:2' })).toBe('http://b:2');
    expect(resolveVoiceUrl({ voice_enabled: false }, {})).toBeNull();
    expect(resolveVoiceUrl({ voice_url: 'ftp://x' }, {})).toBeNull();
  });

  function setup(heraldVoice: any) {
    const sent: any[] = [];
    const ctx: any = { herald: {}, heraldVoice, config: { listeners: [] }, send: (_ws: unknown, r: unknown) => sent.push(r) };
    const client: any = { id: 'c1', ws: {} };
    return { h: registerHeraldHandlers(ctx), sent, client };
  }

  it('voice disabled -> clear error, audio chunks stay silent without a requestId', async () => {
    const { h, sent, client } = setup(null);
    await h.herald_voice_status(client, {}, 'r1');
    h.herald_voice_audio(client, { streamId: 's', pcm: '' });
    expect(sent).toEqual([
      { type: 'herald_voice_status', success: false, error: 'Herald voice is not enabled on this daemon', requestId: 'r1' },
    ]);
  });

  it('voice errors carry a code so the client can fall back', async () => {
    const { h, sent, client } = setup({
      synthesize: async () => {
        throw new VoiceError('Voice service unavailable', 'unavailable');
      },
      pushAudio: jest.fn(),
    });
    await h.herald_tts(client, { text: 'hi' }, 't');
    expect(sent[0]).toEqual({
      type: 'herald_tts',
      success: false,
      error: 'Voice service unavailable',
      payload: { code: 'unavailable' },
      requestId: 't',
    });
  });

  it('hands-free and cancel route to the service with the client id', async () => {
    const svc = { setHandsFree: jest.fn(() => ({ owner: true })), cancelTts: jest.fn(() => 3) };
    const { h, sent, client } = setup(svc);
    await h.herald_handsfree(client, { on: true }, 'a');
    await h.herald_tts_cancel(client, {}, 'b');
    expect(svc.setHandsFree).toHaveBeenCalledWith('c1', true);
    expect(sent[1].payload).toEqual({ cancelled: 3 });
  });
});

describe('STT vocabulary hints', () => {
  it('each transcription carries the current hints; a failing hint source never fails STT', async () => {
    const client = fakeClient({ stt: jest.fn(async () => ({ text: 'Tell Out4 to hold', audioMs: 0, sttMs: 20 })) });
    let hints: any = { prompt: 'Herald, Jarvis. Sessions: Out4.', hotwords: 'Herald Jarvis Out4' };
    const svc = new HeraldVoiceService({ client, sendEvent: () => {}, sttHints: () => hints });
    svc.startStream('c1', { streamId: 's1', purpose: 'stt', sampleRate: 16000 });
    svc.pushAudio('c1', { streamId: 's1', seq: 0, pcm: pcm(1600) });
    await svc.endStream('c1', { streamId: 's1', action: 'transcribe' });
    expect(client.stt.mock.calls[0][2]).toEqual(hints);

    hints = { prompt: 'Herald, Jarvis. Sessions: Doc Upload Site.', hotwords: 'Doc Upload Site' };
    svc.startStream('c1', { streamId: 's2', purpose: 'stt', sampleRate: 16000 });
    svc.pushAudio('c1', { streamId: 's2', seq: 0, pcm: pcm(1600) });
    await svc.endStream('c1', { streamId: 's2', action: 'transcribe' });
    expect(client.stt.mock.calls[1][2].prompt).toContain('Doc Upload Site'); // follows the sessions

    const broken = new HeraldVoiceService({
      client,
      sendEvent: () => {},
      sttHints: () => {
        throw new Error('boom');
      },
    });
    broken.startStream('c1', { streamId: 's3', purpose: 'stt', sampleRate: 16000 });
    broken.pushAudio('c1', { streamId: 's3', seq: 0, pcm: pcm(1600) });
    await expect(broken.endStream('c1', { streamId: 's3', action: 'transcribe' })).resolves.toMatchObject({ text: 'Tell Out4 to hold' });
    expect(client.stt.mock.calls[2][2]).toBeNull();
  });

  it('a spoken version from the hints comes back written ("two or seven" -> 2.0.7); versions never reach the service', async () => {
    const client = fakeClient({ stt: jest.fn(async () => ({ text: 'Is two or seven on the phone?', audioMs: 0, sttMs: 20 })) });
    const svc = new HeraldVoiceService({ client, sendEvent: () => {}, sttHints: () => ({ prompt: 'p', hotwords: 'h', versions: ['2.0.7'] }) });
    svc.startStream('c1', { streamId: 'v1', purpose: 'stt', sampleRate: 16000 });
    svc.pushAudio('c1', { streamId: 'v1', seq: 0, pcm: pcm(1600) });
    await expect(svc.endStream('c1', { streamId: 'v1', action: 'transcribe' })).resolves.toMatchObject({ text: 'Is 2.0.7 on the phone?' });
    const urls: string[] = [];
    const c = new VoiceServiceClient('http://v', (async (u: string) => {
      urls.push(u);
      return new Response(JSON.stringify({ text: 'x', audioMs: 1, sttMs: 1 }), { status: 200 });
    }) as any);
    await c.stt(Buffer.alloc(4), undefined, { prompt: 'p', versions: ['2.0.7'] });
    expect(new URL(urls[0]).searchParams.has('versions')).toBe(false);
  });

  it('the HTTP client sends hints as query parameters, and nothing when there are none', async () => {
    const urls: string[] = [];
    const c = new VoiceServiceClient('http://v', (async (u: string) => {
      urls.push(u);
      return new Response(JSON.stringify({ text: 'x', audioMs: 1, sttMs: 1 }), { status: 200 });
    }) as any);
    await c.stt(Buffer.alloc(4), undefined, { prompt: 'Herald, Out4.', hotwords: 'Out4 tmux' });
    await c.stt(Buffer.alloc(4));
    const q = new URL(urls[0]).searchParams;
    expect(q.get('prompt')).toBe('Herald, Out4.');
    expect(q.get('hotwords')).toBe('Out4 tmux');
    expect(urls[1]).toBe('http://v/stt');
  });
});

describe('announcer arbitration (which device plays inbox tones)', () => {
  it('the most recently used device wins; the others are told to stand down', () => {
    let t = 1000;
    const events: Array<[string, any]> = [];
    const svc = new HeraldVoiceService({ client: fakeClient(), sendEvent: (id, e) => events.push([id, e]), now: () => t });
    expect(svc.setPresence('phone', { interacted: false })).toEqual({ announcer: true, clientId: 'phone' });
    t += 10;
    // Neither was used yet: the newest device takes over.
    expect(svc.setPresence('desk', { interacted: false })).toMatchObject({ announcer: true });
    expect(events).toContainEqual(['phone', { kind: 'announcer', owner: false }]);
    t += 10;
    expect(svc.setPresence('phone', { interacted: true })).toMatchObject({ announcer: true });
    expect(events).toContainEqual(['desk', { kind: 'announcer', owner: false }]);
    t += 10;
    // Seeing the desk again does not beat the phone the user actually touched.
    expect(svc.setPresence('desk', { interacted: false })).toMatchObject({ announcer: false });
    expect(svc.announcerClient).toBe('phone');
  });

  it('hands-free wins; when that device leaves, the next most recent takes over', () => {
    let t = 1000;
    const events: Array<[string, any]> = [];
    const svc = new HeraldVoiceService({ client: fakeClient(), sendEvent: (id, e) => events.push([id, e]), now: () => t });
    svc.setPresence('laptop', { interacted: true });
    t += 10;
    svc.setPresence('kitchen', { interacted: false });
    expect(svc.announcerClient).toBe('laptop');
    svc.setHandsFree('kitchen', true);
    expect(svc.announcerClient).toBe('kitchen');
    expect(events).toContainEqual(['kitchen', { kind: 'announcer', owner: true }]);
    svc.clientGone('kitchen');
    expect(svc.announcerClient).toBe('laptop');
    expect(events).toContainEqual(['laptop', { kind: 'announcer', owner: true }]);
    svc.clientGone('laptop');
    expect(svc.announcerClient).toBeNull();
  });

});

describe('claiming the active device', () => {
  function setup() {
    let t = 1000;
    const events: Array<[string, any]> = [];
    const snaps: any[] = [];
    const svc = new HeraldVoiceService({
      client: fakeClient(),
      sendEvent: (id, e) => events.push([id, e]),
      onDevices: (s) => snaps.push(s),
      now: () => t,
    });
    const tick = (ms = 10) => {
      t += ms;
    };
    return { svc, events, snaps, tick };
  }

  it('labels devices and exposes the active one (why it is active)', () => {
    const { svc, snaps, tick } = setup();
    svc.setPresence('a', {
      interacted: true,
      label: '  Chrome\non   Windows ',
      deviceKey: 'win-pc-000001',
    });
    tick();
    svc.setPresence('b', { interacted: false, label: 'Companion app on Android' });
    tick();
    svc.setPresence('c', { interacted: false }); // an older client: no label
    const snap = svc.devicesSnapshot();
    expect(snap.devices).toEqual([
      { id: 'a', label: 'Chrome on Windows', handsFree: false },
      { id: 'b', label: 'Companion app on Android', handsFree: false },
      { id: 'c', label: 'Unnamed device', handsFree: false },
    ]);
    expect(snap.activeDevice).toEqual({
      id: 'a',
      label: 'Chrome on Windows',
      pinned: false,
      reason: 'recent',
    });
    expect(snaps[snaps.length - 1]).toEqual(snap);
    // Presence refreshes that change nothing are not re-broadcast.
    const n = snaps.length;
    tick();
    svc.setPresence('b', { interacted: false, label: 'Companion app on Android' });
    expect(snaps).toHaveLength(n);
    // A rename is.
    svc.setPresence('b', { interacted: false, label: 'Pixel' });
    expect(snaps).toHaveLength(n + 1);
    svc.setPresence('b', { interacted: false, label: 'x'.repeat(200) });
    expect(svc.devicesSnapshot().devices.find((d) => d.id === 'b')!.label).toHaveLength(60);
  });

  it('a claim makes that device active and stands the old one down', () => {
    const { svc, events, tick } = setup();
    svc.setPresence('desk', { interacted: true, label: 'Desk' });
    tick();
    svc.setPresence('phone', { interacted: false, label: 'Phone' });
    expect(svc.announcerClient).toBe('desk');
    const snap = svc.claimDevice('phone', { pin: false });
    expect(svc.announcerClient).toBe('phone');
    expect(snap.activeDevice).toEqual({
      id: 'phone',
      label: 'Phone',
      pinned: false,
      reason: 'claimed',
    });
    expect(events).toContainEqual(['desk', { kind: 'announcer', owner: false }]);
    expect(events).toContainEqual(['phone', { kind: 'announcer', owner: true }]);
  });

  it('an unpinned claim yields to activity elsewhere; a pinned one does not', () => {
    const { svc, tick } = setup();
    svc.setPresence('desk', { interacted: true });
    tick();
    svc.setPresence('phone', { interacted: false });
    svc.claimDevice('phone', { pin: false });
    tick();
    svc.setPresence('desk', { interacted: true });
    expect(svc.announcerClient).toBe('desk');

    svc.claimDevice('phone', { pin: true });
    for (let i = 0; i < 5; i++) {
      tick();
      svc.setPresence('desk', { interacted: true });
    }
    expect(svc.announcerClient).toBe('phone');
    expect(svc.devicesSnapshot().activeDevice).toMatchObject({
      id: 'phone',
      pinned: true,
      reason: 'claimed',
    });
  });

  it('a pinned claim beats hands-free, and another claim moves it', () => {
    const { svc, tick } = setup();
    svc.setPresence('kitchen', { interacted: false });
    svc.setPresence('desk', { interacted: false });
    svc.setHandsFree('kitchen', true);
    expect(svc.announcerClient).toBe('kitchen');
    svc.claimDevice('desk', { pin: true });
    expect(svc.announcerClient).toBe('desk');
    expect(svc.devicesSnapshot().devices.find((d) => d.id === 'kitchen')!.handsFree).toBe(true);
    tick();
    svc.claimDevice('desk', { pin: true, deviceId: 'kitchen' }); // switch from the menu on another device
    expect(svc.devicesSnapshot().activeDevice).toMatchObject({ id: 'kitchen', pinned: true });
  });

  it('pinned device disconnects: automatic arbitration; a quick reconnect gets its pin back', () => {
    const { svc, tick } = setup();
    svc.setPresence('desk', { interacted: true, deviceKey: 'desk-key-0001' });
    tick();
    svc.setPresence('phone', { interacted: true, deviceKey: 'phone-key-001' });
    svc.claimDevice('desk', { pin: true });
    svc.clientGone('desk');
    expect(svc.announcerClient).toBe('phone');
    expect(svc.devicesSnapshot().activeDevice).toMatchObject({
      id: 'phone',
      reason: 'recent',
      pinned: false,
    });
    tick(5000);
    svc.setPresence('desk-2', { interacted: false, deviceKey: 'desk-key-0001' }); // same browser, new socket
    expect(svc.announcerClient).toBe('desk-2');
    expect(svc.devicesSnapshot().activeDevice).toMatchObject({ pinned: true, reason: 'claimed' });

    svc.clientGone('desk-2');
    tick(61_000); // too late: stays automatic
    svc.setPresence('desk-3', { interacted: false, deviceKey: 'desk-key-0001' });
    expect(svc.announcerClient).toBe('phone');
  });

  it('claims by label (case-insensitive) or id; unknown devices are refused', () => {
    const { svc, tick } = setup();
    svc.setPresence('a', { interacted: true, label: 'Windows PC' });
    tick();
    svc.setPresence('b', { interacted: false, label: 'Work Mac' });
    expect(svc.claimByName('work mac', true)).toBe('b');
    expect(svc.devicesSnapshot().activeDevice).toMatchObject({ id: 'b', pinned: true });
    expect(svc.claimByName('a', false)).toBe('a');
    expect(svc.claimByName('Toaster', true)).toBeNull();
    expect(svc.announcerClient).toBe('a');
    expect(() => svc.claimDevice('a', { pin: true, deviceId: 'ghost' })).toThrow(VoiceError);
    expect(() => svc.claimDevice('stranger', { pin: true })).toThrow(/presence/);
  });

  it('herald_claim_device routes to the service with the client id', async () => {
    const claimDevice = jest.fn(() => ({ activeDevice: null, devices: [] }));
    const sent: any[] = [];
    const ctx: any = {
      herald: {},
      heraldVoice: { claimDevice },
      send: (_ws: unknown, m: unknown) => sent.push(m),
      config: { listeners: [] },
    };
    const h = registerHeraldHandlers(ctx);
    await h.herald_claim_device({ id: 'c7', ws: {} } as any, { pin: true }, 'q');
    expect(claimDevice).toHaveBeenCalledWith('c7', { pin: true });
    expect(sent[0]).toMatchObject({ type: 'herald_claim_device', success: true, requestId: 'q' });
  });

  it('herald_presence routes to the service with the client id', async () => {
    const setPresence = jest.fn(() => ({ announcer: true }));
    const sent: any[] = [];
    const ctx: any = { herald: {}, heraldVoice: { setPresence }, send: (_ws: unknown, m: unknown) => sent.push(m), config: { listeners: [] } };
    const h = registerHeraldHandlers(ctx);
    await h.herald_presence({ id: 'c9', ws: {} } as any, { interacted: true }, 'p');
    expect(setPresence).toHaveBeenCalledWith('c9', { interacted: true });
    expect(sent[0]).toMatchObject({ type: 'herald_presence', success: true, payload: { announcer: true } });
  });
});
