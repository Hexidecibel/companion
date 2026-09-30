import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INTERRUPT_GRACE_MS, VoiceAutomation, type AutomationConfig } from '../voiceAutomation';
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

function fakeTransport() {
  const requests: Array<{ type: string; payload: any }> = [];
  const fired: any[] = [];
  const t: HeraldTransport = {
    isConnected: () => true,
    request: async (type, payload) => {
      requests.push({ type, payload });
      if (type === 'herald_voice_stream_end') return { type, success: true, payload: { text: 'actually, stop that', audioMs: 900, sttMs: 200, woke: false } };
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

  function setup(stopSpeech: () => void = vi.fn()) {
    const vad = fakeVad();
    const tr = fakeTransport();
    const onTranscript = vi.fn();
    const input = new VoiceInputController({
      mic: { permission: 'granted', start: async () => {}, stop: () => {} },
      getTransport: () => tr.t,
      onTranscript,
      onBargeIn: () => {},
      now: () => now,
    });
    const auto = new VoiceAutomation({ vad, input, stopSpeech, now: () => now });
    return { vad, input, auto, onTranscript, stopSpeech, ...tr };
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
