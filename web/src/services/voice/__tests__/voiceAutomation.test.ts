import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMMAND_WAIT_MS, ECHO_TAIL_MS, GATE_CHECK_EVERY_FRAMES, GATE_FIRST_CHECK_FRAMES, INTERRUPT_GRACE_MS, LISTEN_WAIT_MS,
  VoiceAutomation, type AutomationConfig,
} from '../voiceAutomation';
import { SpokenLog } from '../echoGuard';
import type { VadEvents, VadLike, VadSensitivity } from '../vadListener';
import { VoiceInputController } from '../voiceInput';
import { HybridTtsEngine } from '../../tts/hybridTtsEngine';
import type { AudioSink, TtsRequester } from '../../tts/serverTtsEngine';
import type { HeraldTransport } from '../../heraldTransport';
import type { TtsEngine } from '../../tts/types';

function fakeVad() {
  const vad: VadLike & { starts: number; pauses: number; events: VadEvents | null; sens: VadSensitivity | null } = {
    running: false,
    starts: 0,
    pauses: 0,
    events: null,
    sens: null,
    async start(events, s) {
      vad.starts++;
      vad.events = events;
      vad.sens = s;
      (vad as { running: boolean }).running = true;
    },
    pause() {
      vad.pauses++;
      (vad as { running: boolean }).running = false;
    },
    setSensitivity(s) {
      vad.sens = s;
    },
    destroy() {},
  };
  return vad;
}

function fakeTransport(sttText: string | string[] = 'actually, stop that') {
  const texts = Array.isArray(sttText) ? [...sttText] : null;
  const requests: Array<{ type: string; payload: any }> = [];
  const fired: any[] = [];
  const t: HeraldTransport = {
    isConnected: () => true,
    request: async (type, payload) => {
      requests.push({ type, payload });
      if (type === 'herald_voice_stream_end') return { type, success: true, payload: { text: (payload as any).action === 'transcribe' ? (texts ? texts.shift() ?? '' : sttText) : '', audioMs: 900, sttMs: 200, woke: true } };
      return { type, success: true, payload: {} };
    },
    onEvent: () => () => {},
    onConnectivity: () => () => {},
    fire: (_type, payload) => {
      fired.push(payload);
      return true;
    },
  };
  return { t, requests, fired };
}

const base: AutomationConfig = { available: true, micGranted: true, interrupt: true, sensitivity: 'normal', speaking: false };

/** Feed `n` VAD frames (32 ms each) and let any echo check settle. */
async function feed(vad: ReturnType<typeof fakeVad>, n: number, level = 0.2) {
  for (let i = 0; i < n; i++) vad.events!.onFrame(new Float32Array(512).fill(level), 0.9);
  await vi.advanceTimersByTimeAsync(0);
}

describe('VoiceAutomation (voice interrupt)', () => {
  let now = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    now = 10_000;
  });
  afterEach(() => vi.useRealTimers());

  function setup(stopSpeech: () => void = vi.fn(), sttText?: string | string[]) {
    const vad = fakeVad();
    const tr = fakeTransport(sttText);
    const onTranscript = vi.fn();
    const input = new VoiceInputController({
      mic: { permission: 'granted', start: async () => {}, stop: () => {} },
      getTransport: () => tr.t,
      onTranscript,
      onBargeIn: () => {},
      now: () => now,
    });
    const onWake = vi.fn();
    const auto = new VoiceAutomation({ vad, input, stopSpeech, now: () => now, getTransport: () => tr.t, onWake });
    return { vad, input, auto, onTranscript, stopSpeech, onWake, ...tr };
  }

  it('only runs the VAD while Herald speaks (plus a short grace), never without mic permission', async () => {
    const { vad, auto } = setup();
    auto.update(base);
    expect(vad.starts).toBe(0);
    auto.update({ ...base, speaking: true, micGranted: false });
    expect(vad.starts).toBe(0); // would prompt: never
    auto.update({ ...base, speaking: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(vad.starts).toBe(1);
    auto.update({ ...base, speaking: false });
    expect(vad.pauses).toBe(0); // grace period: user may answer right away
    now += INTERRUPT_GRACE_MS + 50;
    await vi.advanceTimersByTimeAsync(INTERRUPT_GRACE_MS + 50);
    expect(vad.pauses).toBe(1);
  });

  it('real speech stops Herald once a quick transcript shows it is not echo, then sends on pause', async () => {
    const { vad, auto, input, stopSpeech, onTranscript, requests } = setup();
    auto.update({ ...base, speaking: true });
    await vi.advanceTimersByTimeAsync(0);
    vad.events!.onSpeechStart();
    expect(stopSpeech).not.toHaveBeenCalled(); // a single loud frame is not enough
    vad.events!.onSpeechRealStart();
    expect(stopSpeech).not.toHaveBeenCalled(); // could be Herald's own voice: check first
    expect(input.state.phase).toBe('idle');
    await feed(vad, GATE_FIRST_CHECK_FRAMES);
    expect(stopSpeech).toHaveBeenCalledTimes(1);
    expect(input.state).toMatchObject({ phase: 'listening', source: 'interrupt' });
    await feed(vad, 1);
    expect(input.state.level).toBeGreaterThan(0);
    auto.update({ ...base, speaking: false }); // TTS stopped as a result
    vad.events!.onSpeechEnd(new Float32Array(16000));
    await vi.advanceTimersByTimeAsync(0);
    const ends = requests.filter((r) => r.type === 'herald_voice_stream_end');
    expect(ends).toHaveLength(2); // the quick check + the whole utterance
    expect(onTranscript).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledWith('actually, stop that', 'interrupt');
  });

  it('a misfire after real start drops back to idle without sending', async () => {
    const { vad, auto, input, onTranscript } = setup();
    auto.update({ ...base, speaking: true });
    await vi.advanceTimersByTimeAsync(0);
    vad.events!.onSpeechRealStart();
    vad.events!.onMisfire();
    expect(input.state.phase).toBe('idle');
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it('interrupt off, or push-to-talk in progress: speech is ignored', async () => {
    const off = setup();
    off.auto.update({ ...base, speaking: true, interrupt: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(off.vad.starts).toBe(0);

    const ptt = setup();
    ptt.auto.update({ ...base, speaking: true });
    await vi.advanceTimersByTimeAsync(0);
    await ptt.input.start('button');
    ptt.vad.events!.onSpeechRealStart();
    expect(ptt.stopSpeech).not.toHaveBeenCalled();
  });

  it('sensitivity changes reach the running VAD', async () => {
    const { vad, auto } = setup();
    auto.update({ ...base, speaking: true });
    await vi.advanceTimersByTimeAsync(0);
    auto.update({ ...base, speaking: true, sensitivity: 'low' });
    expect(vad.sens).toBe('low');
  });

  it('barge-in cancels BOTH the client playback queue and the server synthesis queue', async () => {
    const cancelServer = vi.fn();
    const requester: TtsRequester = { synth: () => new Promise(() => {}), cancel: cancelServer };
    const sink: AudioSink = { isRunning: () => true, resume: async () => true, currentTime: () => 0, play: () => ({ stop: () => {} }) };
    const web: TtsEngine = {
      id: 'webspeech', available: true, speaking: false, speak: vi.fn(), cancel: vi.fn(),
      getVoices: () => [], unlock: () => {}, on: () => () => {}, dispose: () => {},
    };
    const hybrid = new HybridTtsEngine(web, requester, sink);
    hybrid.setServerStatus(true, [{ id: 'af_heart', name: 'Heart', lang: 'en-US', gender: 'female' }], 'af_heart');
    hybrid.speak('First sentence of a long reply.');
    hybrid.speak('Second sentence.');
    expect(hybrid.speaking).toBe(true);

    const { vad, auto } = setup(() => hybrid.cancel());
    auto.update({ ...base, speaking: true });
    await vi.advanceTimersByTimeAsync(0);
    vad.events!.onSpeechRealStart();
    await feed(vad, GATE_FIRST_CHECK_FRAMES);
    expect(cancelServer).toHaveBeenCalledTimes(1);
    expect(web.cancel).toHaveBeenCalled();
    expect(hybrid.speaking).toBe(false);
  });
});

describe('VoiceAutomation (hands-free wake word)', () => {
  let now = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    now = 50_000;
  });
  afterEach(() => vi.useRealTimers());

  const hf: AutomationConfig = { ...base, interrupt: false, handsFree: true };
  const frame = () => new Float32Array(512).fill(0.1);

  function setup(sttText: string | string[] = 'Anything for me?') {
    const vad = fakeVad();
    const tr = fakeTransport(sttText);
    const onTranscript = vi.fn();
    const input = new VoiceInputController({
      mic: { permission: 'granted', start: async () => {}, stop: () => {} },
      getTransport: () => tr.t,
      onTranscript,
      onBargeIn: () => {},
      now: () => now,
    });
    const onWake = vi.fn();
    const auto = new VoiceAutomation({ vad, input, stopSpeech: vi.fn(), now: () => now, getTransport: () => tr.t, onWake });
    return { vad, input, auto, onTranscript, onWake, ...tr };
  }

  const streamId = (requests: Array<{ type: string; payload: any }>) =>
    requests.find((r) => r.type === 'herald_voice_stream_start')!.payload.streamId as string;

  it('listens continuously but sends audio only while someone talks, with pre-roll', async () => {
    const { vad, auto, fired, requests } = setup();
    auto.update(hf);
    await vi.advanceTimersByTimeAsync(0);
    expect(vad.starts).toBe(1);
    for (let i = 0; i < 40; i++) vad.events!.onFrame(frame(), 0.01); // silence: nothing sent
    expect(fired).toHaveLength(0);
    expect(requests).toHaveLength(0);
    vad.events!.onSpeechStart();
    expect(requests[0].payload.purpose).toBe('wake');
    // 20 pre-roll frames x 512 = 10240 samples -> six full 1600-sample chunks sent at once
    expect(fired).toHaveLength(6);
    for (let i = 0; i < 10; i++) vad.events!.onFrame(frame(), 0.9);
    expect(fired.every((f) => f.streamId === streamId(requests))).toBe(true);
  });

  it('"Hey Jarvis, anything for me?": chime on wake, then transcribe and send on pause', async () => {
    const { vad, auto, input, onWake, onTranscript, requests } = setup();
    auto.update(hf);
    await vi.advanceTimersByTimeAsync(0);
    vad.events!.onSpeechStart();
    for (let i = 0; i < 30; i++) vad.events!.onFrame(frame(), 0.9);
    auto.onVoiceEvent({ kind: 'wake', streamId: streamId(requests), score: 0.99, model: 'hey_jarvis' });
    expect(onWake).toHaveBeenCalledTimes(1);
    expect(input.state).toMatchObject({ phase: 'listening', source: 'wake' });
    vad.events!.onSpeechEnd(new Float32Array(16000));
    await vi.advanceTimersByTimeAsync(0);
    expect(requests.find((r) => r.type === 'herald_voice_stream_end')!.payload.action).toBe('transcribe');
    expect(onTranscript).toHaveBeenCalledWith('Anything for me?', 'wake');
    expect(input.state.phase).toBe('idle');
  });

  it('speech without the wake word is discarded, never transcribed', async () => {
    const { vad, auto, onTranscript, requests } = setup();
    auto.update(hf);
    await vi.advanceTimersByTimeAsync(0);
    vad.events!.onSpeechStart();
    vad.events!.onSpeechEnd(new Float32Array(8000));
    now += 700;
    await vi.advanceTimersByTimeAsync(700);
    expect(requests.find((r) => r.type === 'herald_voice_stream_end')!.payload.action).toBe('discard');
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it('a bare "Hey Jarvis" waits for the command as the next utterance', async () => {
    const { vad, auto, input, onTranscript, requests } = setup(['', 'What is blocked?']);
    auto.update(hf);
    await vi.advanceTimersByTimeAsync(0);
    vad.events!.onSpeechStart();
    auto.onVoiceEvent({ kind: 'wake', streamId: streamId(requests), score: 0.98, model: 'hey_jarvis' });
    vad.events!.onSpeechEnd(new Float32Array(8000));
    await vi.advanceTimersByTimeAsync(0);
    expect(auto.awaitingCommand).toBe(true);
    expect(input.state).toMatchObject({ phase: 'listening', source: 'wake' });
    // The command utterance goes straight to STT (no second wake word needed).
    vad.events!.onSpeechStart();
    const before = requests.filter((r) => r.type === 'herald_voice_stream_start').length;
    vad.events!.onSpeechEnd(new Float32Array(16000));
    await vi.advanceTimersByTimeAsync(0);
    const starts = requests.filter((r) => r.type === 'herald_voice_stream_start');
    expect(starts.length).toBe(before + 1);
    expect(starts[starts.length - 1].payload.purpose).toBe('stt');
    expect(onTranscript).toHaveBeenCalledWith('What is blocked?', 'wake');
  });

  it('the command wait times out back to idle', async () => {
    const { vad, auto, input, requests } = setup('');
    auto.update(hf);
    await vi.advanceTimersByTimeAsync(0);
    vad.events!.onSpeechStart();
    auto.onVoiceEvent({ kind: 'wake', streamId: streamId(requests), score: 0.98, model: 'hey_jarvis' });
    vad.events!.onSpeechEnd(new Float32Array(8000));
    await vi.advanceTimersByTimeAsync(0);
    now += COMMAND_WAIT_MS + 10;
    await vi.advanceTimersByTimeAsync(COMMAND_WAIT_MS + 10);
    expect(auto.awaitingCommand).toBe(false);
    expect(input.state.phase).toBe('idle');
  });

  it('turning hands-free off (e.g. revoked by another device) drops the stream and stops the VAD', async () => {
    const { vad, auto, requests } = setup();
    auto.update(hf);
    await vi.advanceTimersByTimeAsync(0);
    vad.events!.onSpeechStart();
    auto.update({ ...hf, handsFree: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(requests.find((r) => r.type === 'herald_voice_stream_end')!.payload.action).toBe('discard');
    expect(vad.pauses).toBe(1);
  });

  it('while Herald speaks with interrupt on, talking interrupts rather than waiting for a wake word', async () => {
    const { vad, auto, input, requests } = setup();
    auto.update({ ...hf, interrupt: true, speaking: true });
    await vi.advanceTimersByTimeAsync(0);
    vad.events!.onSpeechStart();
    expect(requests).toHaveLength(0); // no wake stream
    vad.events!.onSpeechRealStart();
    await feed(vad, GATE_FIRST_CHECK_FRAMES);
    expect(input.state.source).toBe('interrupt');
  });
});

describe('VoiceAutomation (barge-in while hands-free)', () => {
  let now = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    now = 90_000;
  });
  afterEach(() => vi.useRealTimers());

  function setup(sttText: string | string[] = 'stop') {
    const vad = fakeVad();
    const tr = fakeTransport(sttText);
    const onTranscript = vi.fn();
    const stopSpeech = vi.fn();
    const input = new VoiceInputController({
      mic: { permission: 'granted', start: async () => {}, stop: () => {} },
      getTransport: () => tr.t,
      onTranscript,
      onBargeIn: () => {},
      now: () => now,
    });
    const auto = new VoiceAutomation({ vad, input, stopSpeech, now: () => now, getTransport: () => tr.t, onWake: vi.fn() });
    return { vad, input, auto, onTranscript, stopSpeech, ...tr };
  }
  const streamId = (requests: Array<{ type: string; payload: any }>) =>
    requests.find((r) => r.type === 'herald_voice_stream_start')!.payload.streamId as string;

  // Regression: hands-free opens the mic itself, but micGranted only came from
  // the Permissions API or a push-to-talk. Where that API is missing (Firefox)
  // interrupt was never armed in hands-free mode, so talking over Herald did nothing.
  it('hands-free counts as mic permission: talking over Herald stops it', async () => {
    const { vad, auto, input, stopSpeech } = setup();
    auto.update({ ...base, micGranted: false, handsFree: true, speaking: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(auto.interruptArmed).toBe(true);
    vad.events!.onSpeechStart();
    vad.events!.onSpeechRealStart();
    await feed(vad, GATE_FIRST_CHECK_FRAMES);
    expect(stopSpeech).toHaveBeenCalledTimes(1);
    expect(input.state.source).toBe('interrupt');
  });

  it('without hands-free, no mic permission still means no interrupt (never prompts)', async () => {
    const { vad, auto } = setup();
    auto.update({ ...base, micGranted: false, speaking: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(auto.interruptArmed).toBe(false);
    expect(vad.starts).toBe(0);
  });

  // Regression: an utterance that began just before Herald started talking had
  // already opened a wake stream; its real start was then ignored, and the
  // echo of Herald's own voice could keep that segment open for the whole reply.
  it('a wake stream opened just before Herald spoke turns into an interrupt', async () => {
    const { vad, auto, input, stopSpeech, requests, onTranscript } = setup('shorter');
    auto.update({ ...base, handsFree: true, speaking: false });
    await vi.advanceTimersByTimeAsync(0);
    vad.events!.onSpeechStart(); // not armed yet: opens a wake stream
    expect(requests.some((r) => r.type === 'herald_voice_stream_start')).toBe(true);
    auto.update({ ...base, handsFree: true, speaking: true });
    vad.events!.onSpeechRealStart();
    await vi.advanceTimersByTimeAsync(0);
    expect(requests.find((r) => r.type === 'herald_voice_stream_end')!.payload.action).toBe('discard');
    await feed(vad, GATE_FIRST_CHECK_FRAMES);
    expect(stopSpeech).toHaveBeenCalledTimes(1);
    expect(input.state.source).toBe('interrupt');
    auto.update({ ...base, handsFree: true, speaking: false });
    vad.events!.onSpeechEnd(new Float32Array(8000));
    await vi.advanceTimersByTimeAsync(0);
    expect(onTranscript).toHaveBeenCalledWith('shorter', 'interrupt');
  });

  it('"Hey Jarvis" silences Herald even with talk-over interrupt switched off', async () => {
    const { vad, auto, stopSpeech, requests } = setup();
    auto.update({ ...base, interrupt: false, handsFree: true, speaking: true });
    await vi.advanceTimersByTimeAsync(0);
    vad.events!.onSpeechStart();
    expect(stopSpeech).not.toHaveBeenCalled();
    auto.onVoiceEvent({ kind: 'wake', streamId: streamId(requests), score: 0.97, model: 'hey_jarvis' });
    expect(stopSpeech).toHaveBeenCalledTimes(1);
  });

  it('a woken wake stream keeps its wake flow when talk-over starts (and Herald stops)', async () => {
    const { vad, auto, input, stopSpeech, requests } = setup('what is blocked');
    auto.update({ ...base, handsFree: true, speaking: false });
    await vi.advanceTimersByTimeAsync(0);
    vad.events!.onSpeechStart();
    auto.onVoiceEvent({ kind: 'wake', streamId: streamId(requests), score: 0.97, model: 'hey_jarvis' });
    auto.update({ ...base, handsFree: true, speaking: true });
    vad.events!.onSpeechRealStart();
    expect(stopSpeech).toHaveBeenCalled();
    expect(input.state.source).toBe('wake');
  });
});

describe('VoiceAutomation (remote-trigger listen)', () => {
  let now = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    now = 50_000;
  });
  afterEach(() => vi.useRealTimers());

  function setup(sttText: string | string[] = 'what finished?', vad = fakeVad()) {
    const tr = fakeTransport(sttText);
    const onTranscript = vi.fn();
    const input = new VoiceInputController({
      mic: { permission: 'granted', start: async () => {}, stop: () => {} },
      getTransport: () => tr.t,
      onTranscript,
      onBargeIn: () => {},
      now: () => now,
    });
    const onError = vi.fn();
    const auto = new VoiceAutomation({ vad, input, stopSpeech: vi.fn(), now: () => now, getTransport: () => tr.t, onError });
    auto.update({ ...base, interrupt: false });
    return { vad, input, auto, onTranscript, onError, ...tr };
  }

  it('starts the VAD, captures the next utterance and transcribes it as a trigger', async () => {
    const { vad, input, auto, onTranscript } = setup();
    expect(vad.starts).toBe(0);
    await expect(auto.listen()).resolves.toBe(true);
    expect(vad.starts).toBe(1);
    expect(input.state).toMatchObject({ phase: 'listening', source: 'trigger' });
    expect(auto.listenActive).toBe(true);
    vad.events!.onSpeechStart();
    vad.events!.onSpeechRealStart();
    vad.events!.onSpeechEnd(new Float32Array(16000));
    await vi.advanceTimersByTimeAsync(0);
    expect(onTranscript).toHaveBeenCalledWith('what finished?', 'trigger');
    expect(auto.listenActive).toBe(false);
    expect(vad.running).toBe(false); // nothing else wants it
  });

  it('a misfire keeps waiting; silence gives up after LISTEN_WAIT_MS', async () => {
    const { input, auto, onTranscript, vad } = setup();
    await auto.listen();
    vad.events!.onSpeechStart();
    vad.events!.onMisfire();
    expect(auto.listenActive).toBe(true);
    expect(input.state.phase).toBe('listening');
    await vi.advanceTimersByTimeAsync(LISTEN_WAIT_MS + 10);
    expect(auto.listenActive).toBe(false);
    expect(input.state).toMatchObject({ phase: 'idle', error: "Didn't hear anything" });
    expect(onTranscript).not.toHaveBeenCalled();
    expect(vad.running).toBe(false);
  });

  it('cancelListen drops the capture: nothing is transcribed', async () => {
    const { input, auto, onTranscript, vad, requests } = setup();
    await auto.listen();
    vad.events!.onSpeechStart();
    expect(auto.cancelListen()).toBe(true);
    vad.events!.onSpeechEnd(new Float32Array(16000));
    await vi.advanceTimersByTimeAsync(0);
    expect(onTranscript).not.toHaveBeenCalled();
    expect(requests.filter((r) => r.type === 'herald_voice_stream_end')).toHaveLength(0);
    expect(input.state.phase).toBe('idle');
    expect(auto.cancelListen()).toBe(false);
  });

  it('rejects when the mic cannot open, without the hands-free error path', async () => {
    const vad = fakeVad();
    vad.start = async () => {
      throw new Error('Permission denied');
    };
    const { auto, input, onError } = setup(undefined, vad);
    await expect(auto.listen()).rejects.toThrow(/Could not open the microphone: Permission denied/);
    expect(onError).not.toHaveBeenCalled();
    expect(auto.listenActive).toBe(false);
    expect(input.state.phase).toBe('idle');
  });

  it('push-to-talk in progress: listen declines', async () => {
    const { auto, input } = setup();
    await input.start('button');
    await expect(auto.listen()).resolves.toBe(false);
  });

  it('takes over an utterance hands-free was checking for the wake word', async () => {
    const { vad, auto, onTranscript, requests } = setup();
    auto.update({ ...base, interrupt: false, handsFree: true });
    await vi.advanceTimersByTimeAsync(0);
    vad.events!.onSpeechStart(); // opens a wake stream
    expect(requests.some((r) => r.type === 'herald_voice_stream_start' && r.payload.purpose === 'wake')).toBe(true);
    await expect(auto.listen()).resolves.toBe(true);
    vad.events!.onSpeechEnd(new Float32Array(16000));
    await vi.advanceTimersByTimeAsync(0);
    expect(onTranscript).toHaveBeenCalledWith('what finished?', 'trigger');
  });
});

describe('VoiceAutomation (self-echo gating)', () => {
  let now = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    now = 200_000;
  });
  afterEach(() => vi.useRealTimers());

  const SAID = 'Doc Upload Site shipped v2.28.0 to supdox.com.';

  function setup(sttText: string | string[]) {
    const vad = fakeVad();
    const tr = fakeTransport(sttText);
    const onTranscript = vi.fn();
    const stopSpeech = vi.fn();
    const log = new SpokenLog(() => now);
    const input = new VoiceInputController({
      mic: { permission: 'granted', start: async () => {}, stop: () => {} },
      getTransport: () => tr.t,
      onTranscript,
      onBargeIn: () => {},
      now: () => now,
    });
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const auto = new VoiceAutomation({ vad, input, stopSpeech, now: () => now, getTransport: () => tr.t, isEcho: (t) => log.isEcho(t), stripEcho: (t) => log.stripEcho(t), isBargeIn: (t) => log.isBargeIn(t) });
    return { vad, input, auto, onTranscript, stopSpeech, log, debug, ...tr };
  }

  async function heraldSays(s: ReturnType<typeof setup>, text = SAID) {
    s.log.setSpeaking(true);
    s.log.record(text);
    s.auto.update({ ...base, speaking: true });
    await vi.advanceTimersByTimeAsync(0);
  }

  it("Herald's own voice through the speakers never barges in and is never sent", async () => {
    const s = setup(['Doc Upload Site, shift V2.', 'Doc Upload Site, shift V2.', 'Doc Upload Site, shift V2 to sup docs.']);
    await heraldSays(s);
    s.vad.events!.onSpeechStart();
    s.vad.events!.onSpeechRealStart();
    await feed(s.vad, GATE_FIRST_CHECK_FRAMES);
    await feed(s.vad, GATE_CHECK_EVERY_FRAMES);
    expect(s.stopSpeech).not.toHaveBeenCalled();
    expect(s.input.state.phase).toBe('idle'); // never showed "listening"
    s.vad.events!.onSpeechEnd(new Float32Array(16000));
    await vi.advanceTimersByTimeAsync(0);
    expect(s.stopSpeech).not.toHaveBeenCalled();
    expect(s.onTranscript).not.toHaveBeenCalled();
    expect(s.debug).toHaveBeenCalled(); // logged at debug
    // Still listening for a real interruption.
    expect(s.vad.running).toBe(true);
  });

  it('"stop" said over the echo still cuts Herald off (re-checked while the speech goes on)', async () => {
    const s = setup(['Doc Upload Site shipped', 'Stop.', 'Stop.']);
    await heraldSays(s);
    s.vad.events!.onSpeechRealStart();
    await feed(s.vad, GATE_FIRST_CHECK_FRAMES);
    expect(s.stopSpeech).not.toHaveBeenCalled();
    await feed(s.vad, GATE_CHECK_EVERY_FRAMES);
    expect(s.stopSpeech).toHaveBeenCalledTimes(1);
    expect(s.input.state).toMatchObject({ phase: 'listening', source: 'interrupt' });
    s.auto.update({ ...base, speaking: false });
    s.vad.events!.onSpeechEnd(new Float32Array(32000));
    await vi.advanceTimersByTimeAsync(0);
    expect(s.onTranscript).toHaveBeenCalledWith('Stop.', 'interrupt');
  });

  it("the interruption is sent with Herald's own words cut out (real mixed transcript)", async () => {
    const s = setup(['Doc Upload Site shipped', 'wait tell Out4 to hold', 'Tailout4 to Halt. 28.0 to Supdocs.com']);
    await heraldSays(s);
    s.vad.events!.onSpeechRealStart();
    await feed(s.vad, GATE_FIRST_CHECK_FRAMES);
    await feed(s.vad, GATE_CHECK_EVERY_FRAMES);
    expect(s.stopSpeech).toHaveBeenCalledTimes(1);
    s.auto.update({ ...base, speaking: false });
    s.vad.events!.onSpeechEnd(new Float32Array(32000));
    await vi.advanceTimersByTimeAsync(0);
    expect(s.onTranscript).toHaveBeenCalledWith('Tailout4 to Halt.', 'interrupt');
  });

  it('a slow STT does not slow the cadence: the next check goes out as soon as one returns', async () => {
    const s = setup('Doc Upload Site shipped');
    let calls = 0;
    const release: Array<() => void> = [];
    (s.auto as unknown as { deps: { transcribe: (a: Float32Array) => Promise<string> } }).deps.transcribe = () => {
      calls++;
      return new Promise((r) => release.push(() => r('Doc Upload Site shipped')));
    };
    await heraldSays(s);
    s.vad.events!.onSpeechRealStart();
    await feed(s.vad, GATE_FIRST_CHECK_FRAMES);
    expect(calls).toBe(1);
    await feed(s.vad, GATE_CHECK_EVERY_FRAMES + 5); // frames keep coming while the check is slow
    expect(calls).toBe(1); // one at a time
    release.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    await feed(s.vad, 1);
    expect(calls).toBe(2);
  });

  it('a different sentence ("wait tell Out4 to hold") barges in', async () => {
    const s = setup('wait tell Out4 to hold');
    await heraldSays(s);
    s.vad.events!.onSpeechRealStart();
    await feed(s.vad, GATE_FIRST_CHECK_FRAMES);
    expect(s.stopSpeech).toHaveBeenCalledTimes(1);
  });

  it('a short utterance that ends before the first check is judged whole', async () => {
    const real = setup('wait');
    await heraldSays(real);
    real.vad.events!.onSpeechRealStart();
    await feed(real.vad, 3);
    real.vad.events!.onSpeechEnd(new Float32Array(8000));
    await vi.advanceTimersByTimeAsync(0);
    expect(real.stopSpeech).toHaveBeenCalledTimes(1);
    expect(real.onTranscript).toHaveBeenCalledWith('wait', 'interrupt');

    const echo = setup('Doc Upload');
    await heraldSays(echo);
    echo.vad.events!.onSpeechRealStart();
    echo.vad.events!.onSpeechEnd(new Float32Array(8000));
    await vi.advanceTimersByTimeAsync(0);
    expect(echo.stopSpeech).not.toHaveBeenCalled();
    expect(echo.onTranscript).not.toHaveBeenCalled();
  });

  it(`ignores speech for ${ECHO_TAIL_MS} ms after Herald stops (its last word still in the room)`, async () => {
    const s = setup('and what about billing');
    await heraldSays(s);
    s.log.setSpeaking(false);
    s.auto.update({ ...base, speaking: false });
    now += ECHO_TAIL_MS - 100;
    s.vad.events!.onSpeechRealStart();
    await feed(s.vad, GATE_FIRST_CHECK_FRAMES);
    expect(s.input.state.phase).toBe('idle');
    s.vad.events!.onSpeechEnd(new Float32Array(8000));
    await vi.advanceTimersByTimeAsync(0);
    expect(s.onTranscript).not.toHaveBeenCalled();
    // After the tail, still inside the reply grace: an answer is taken at once.
    now += 200;
    s.vad.events!.onSpeechRealStart();
    expect(s.input.state).toMatchObject({ phase: 'listening', source: 'interrupt' });
    s.vad.events!.onSpeechEnd(new Float32Array(8000));
    await vi.advanceTimersByTimeAsync(0);
    expect(s.onTranscript).toHaveBeenCalledWith('and what about billing', 'interrupt');
  });
});

describe("VoiceAutomation: instant talk-over with echo cancellation ('vad' mode)", () => {
  let now = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    now = 50_000;
  });
  afterEach(() => vi.useRealTimers());

  const HERALD_SAYS = 'three sessions need you and the deploy is waiting';

  function setup(sttText: string | string[]) {
    const vad = fakeVad();
    const tr = fakeTransport(sttText);
    const onTranscript = vi.fn();
    const input = new VoiceInputController({
      mic: { permission: 'granted', start: async () => {}, stop: () => {} },
      getTransport: () => tr.t,
      onTranscript,
      onBargeIn: () => {},
      now: () => now,
    });
    const stopSpeech = vi.fn();
    const onEchoHeard = vi.fn();
    const onFalseBargeIn = vi.fn();
    const onBargeInLatency = vi.fn();
    const auto = new VoiceAutomation({
      vad, input, stopSpeech, now: () => now, getTransport: () => tr.t,
      isEcho: (t) => HERALD_SAYS.includes(t.toLowerCase().replace(/[.,!?]/g, '').trim()) && t.trim().length > 0,
      onEchoHeard, onFalseBargeIn, onBargeInLatency,
    });
    return { vad, input, auto, onTranscript, stopSpeech, onEchoHeard, onFalseBargeIn, onBargeInLatency, ...tr };
  }

  it('stops Herald the moment the VAD confirms speech: no transcript round trip', async () => {
    const { vad, auto, stopSpeech, input, requests, onTranscript, onBargeInLatency } = setup('stop');
    auto.update({ ...base, speaking: true, bargeIn: 'vad' });
    await vi.advanceTimersByTimeAsync(0);
    vad.events!.onSpeechStart();
    now += 300; // the VAD's minimum speech time
    vad.events!.onSpeechRealStart();
    expect(stopSpeech).toHaveBeenCalledTimes(1);
    expect(input.state).toMatchObject({ phase: 'listening', source: 'interrupt' });
    expect(requests.filter((r) => r.type === 'herald_voice_stream_start')).toHaveLength(0); // no STT to decide
    expect(onBargeInLatency).toHaveBeenCalledWith(300, 'vad');
    // No gate checks while the user keeps talking either.
    await feed(vad, GATE_FIRST_CHECK_FRAMES + GATE_CHECK_EVERY_FRAMES * 3);
    expect(requests.filter((r) => r.type === 'herald_voice_stream_start')).toHaveLength(0);
    auto.update({ ...base, speaking: false, bargeIn: 'vad' });
    vad.events!.onSpeechEnd(new Float32Array(16000));
    await vi.advanceTimersByTimeAsync(0);
    expect(onTranscript).toHaveBeenCalledWith('stop', 'interrupt');
  });

  it("if the instant stop was Herald's own voice after all: nothing is sent and the setup is flagged", async () => {
    const { vad, auto, onTranscript, onFalseBargeIn, stopSpeech } = setup('the deploy is waiting');
    auto.update({ ...base, speaking: true, bargeIn: 'vad' });
    await vi.advanceTimersByTimeAsync(0);
    vad.events!.onSpeechStart();
    vad.events!.onSpeechRealStart();
    expect(stopSpeech).toHaveBeenCalledTimes(1);
    auto.update({ ...base, speaking: false, bargeIn: 'vad' });
    vad.events!.onSpeechEnd(new Float32Array(16000));
    await vi.advanceTimersByTimeAsync(0);
    expect(onTranscript).not.toHaveBeenCalled();
    expect(onFalseBargeIn).toHaveBeenCalledTimes(1);
  });

  it("gated mode reports the VAD hearing Herald through the canceller (evidence against 'vad')", async () => {
    const { vad, auto, stopSpeech, onEchoHeard, onFalseBargeIn } = setup('the deploy is waiting');
    auto.update({ ...base, speaking: true, bargeIn: 'gated' });
    await vi.advanceTimersByTimeAsync(0);
    vad.events!.onSpeechStart();
    vad.events!.onSpeechRealStart();
    await feed(vad, GATE_FIRST_CHECK_FRAMES);
    await feed(vad, GATE_CHECK_EVERY_FRAMES);
    expect(stopSpeech).not.toHaveBeenCalled();
    expect(onEchoHeard).toHaveBeenCalledTimes(1); // once per utterance
    expect(onFalseBargeIn).not.toHaveBeenCalled();
  });

  it('with Herald silent the mode makes no difference (grace period answers are instant anyway)', async () => {
    const { vad, auto, stopSpeech, input } = setup('yes');
    auto.update({ ...base, speaking: true, bargeIn: 'gated' });
    await vi.advanceTimersByTimeAsync(0);
    auto.update({ ...base, speaking: false, bargeIn: 'gated' });
    now += ECHO_TAIL_MS + 10;
    vad.events!.onSpeechStart();
    vad.events!.onSpeechRealStart();
    expect(input.state).toMatchObject({ phase: 'listening', source: 'interrupt' });
    expect(stopSpeech).toHaveBeenCalledTimes(1);
  });
});

describe('VoiceAutomation: words from the raw mic, detection on the cleaned one', () => {
  let now = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    now = 90_000;
  });
  afterEach(() => vi.useRealTimers());

  it('transcribes the RAW audio of a talk-over (the canceller clamps it during double-talk)', async () => {
    const { RawRing } = await import('../rawTap');
    const ring = new RawRing(16000 * 20);
    ring.push(new Float32Array(16000).fill(0.01)); // 1 s before the user spoke
    const vad = fakeVad();
    const heard: Float32Array[] = [];
    const input = new VoiceInputController({
      mic: { permission: 'granted', start: async () => {}, stop: () => {} },
      getTransport: () => fakeTransport().t,
      onTranscript: vi.fn(),
      onBargeIn: () => {},
      now: () => now,
    });
    const auto = new VoiceAutomation({
      vad, input, stopSpeech: vi.fn(), now: () => now,
      transcribe: async (a) => { heard.push(a); return 'stop'; },
      raw: () => ring,
    });
    auto.update({ ...base, speaking: true, bargeIn: 'vad' });
    await vi.advanceTimersByTimeAsync(0);
    vad.events!.onSpeechStart();
    ring.push(new Float32Array(8000).fill(0.5)); // the user's words, intact in the raw mic
    vad.events!.onSpeechRealStart();
    auto.update({ ...base, speaking: false, bargeIn: 'vad' });
    vad.events!.onSpeechEnd(new Float32Array(4000).fill(0.001)); // the cleaned version: clamped
    await vi.advanceTimersByTimeAsync(0);
    expect(heard).toHaveLength(1);
    const clip = heard[0];
    // Starts ~0.65 s before the VAD's onset (pre-roll + path latency) and holds the raw words.
    expect(clip.length).toBe(Math.round(16000 * 0.65) + 8000);
    expect(clip[clip.length - 1]).toBe(0.5);
  });
});
