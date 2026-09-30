import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMAND_WAIT_MS, INTERRUPT_GRACE_MS, VoiceAutomation, type AutomationConfig } from '../voiceAutomation';
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

  it('real speech stops Herald, shows listening, and sends the utterance on pause', async () => {
    const { vad, auto, input, stopSpeech, onTranscript, fired } = setup();
    auto.update({ ...base, speaking: true });
    await vi.advanceTimersByTimeAsync(0);
    vad.events!.onSpeechStart();
    expect(stopSpeech).not.toHaveBeenCalled(); // a single loud frame is not enough
    vad.events!.onSpeechRealStart();
    expect(stopSpeech).toHaveBeenCalledTimes(1);
    expect(input.state).toMatchObject({ phase: 'listening', source: 'interrupt' });
    vad.events!.onFrame(new Float32Array(512).fill(0.2), 0.9);
    expect(input.state.level).toBeGreaterThan(0);
    auto.update({ ...base, speaking: false }); // TTS stopped as a result
    vad.events!.onSpeechEnd(new Float32Array(16000));
    await vi.advanceTimersByTimeAsync(0);
    expect(fired.length).toBe(10); // 1 s = ten 100 ms frames
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
    expect(input.state.source).toBe('interrupt');
  });
});
