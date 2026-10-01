import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FLEET_HEARTBEAT_TIMEOUT_MS,
  FLEET_MAX_MS,
  FLEET_TAIL_MS,
  FleetSpeakingTracker,
  GESTURE_TTL_MS,
  GestureLedger,
  SPEAKING_HEARTBEAT_MS,
  SpeakingReporter,
  estimateSpeechMs,
  fleetDecision,
  isStopUtterance,
  reportingEngine,
  shouldSpeakLine,
  stopAfterWake,
} from '../fleetSpeaking';
import { HeraldSpeechController } from '../../tts/heraldSpeech';
import { VoiceAutomation, ECHO_TAIL_MS, FLEET_STOP_CHECKS_MS, FOLLOW_UP_MS, GATE_FIRST_CHECK_FRAMES, type AutomationConfig } from '../voiceAutomation';
import { VoiceInputController, type VoiceInputSource } from '../voiceInput';
import type { VadEvents, VadLike } from '../vadListener';
import type { HeraldTransport } from '../../heraldTransport';
import type { TtsEngine, TtsEvent, TtsSpeakOptions, TtsVoice } from '../../tts/types';
import type { HeraldEvent, HeraldMessage, HeraldSpeakingReport, HeraldSpeakingSignal } from '../../../types/herald';

// ---------------------------------------------------------------- speakOn

class MockEngine implements TtsEngine {
  readonly id = 'mock';
  available = true;
  spoken: string[] = [];
  cancels = 0;
  playing = false;
  private ls = new Set<(e: TtsEvent) => void>();
  get speaking() { return this.playing; }
  speak(text: string, _opts?: TtsSpeakOptions) { this.spoken.push(text); }
  cancel() { this.cancels++; }
  getVoices(): TtsVoice[] { return []; }
  unlock() {}
  on(l: (e: TtsEvent) => void) { this.ls.add(l); return () => this.ls.delete(l); }
  emit(e: TtsEvent) { for (const l of this.ls) l(e); }
  dispose() {}
}

const line = (id: string, text: string, speakOn?: string | null, streaming = false): HeraldMessage => ({
  id, role: 'herald', text, createdAt: 1, streaming, ...(speakOn !== undefined ? { speakOn } : {}),
});

describe('shouldSpeakLine', () => {
  it('speaks only on the named device; absent routing or unknown self = every device (legacy)', () => {
    expect(shouldSpeakLine({ speakOn: 'a' }, 'a')).toBe(true);
    expect(shouldSpeakLine({ speakOn: 'a' }, 'b')).toBe(false);
    expect(shouldSpeakLine({ speakOn: null }, 'a')).toBe(false);
    expect(shouldSpeakLine({}, 'a')).toBe(true);
    expect(shouldSpeakLine({ speakOn: 'a' }, null)).toBe(true);
  });
});

describe('HeraldSpeechController + speakOn', () => {
  let engine: MockEngine;
  let self: string | null;
  let ctl: HeraldSpeechController;
  const push = (e: HeraldEvent) => ctl.handleEvent(e, 'push');

  beforeEach(() => {
    engine = new MockEngine();
    self = 'phone';
    ctl = new HeraldSpeechController(engine, {
      isEnabled: () => true, isVisible: () => true, speakOptions: () => ({ rate: 1 }), selfId: () => self,
    });
  });

  it('only the named device speaks; the others stay silent (but can still show it)', () => {
    push({ kind: 'message_start', message: line('r1', '', 'phone', true) });
    push({ kind: 'message_delta', messageId: 'r1', delta: 'Docs finished. ' });
    push({ kind: 'message_end', message: line('r1', 'Docs finished.', 'phone') });
    expect(engine.spoken).toEqual(['Docs finished.']);

    push({ kind: 'message_start', message: line('r2', '', 'mac', true) });
    push({ kind: 'message_delta', messageId: 'r2', delta: 'Docs is blocked. ' });
    push({ kind: 'message_end', message: line('r2', 'Docs is blocked.', 'mac') });
    push({ kind: 'message_end', message: line('r3', 'Nobody says this.', null) });
    expect(engine.spoken).toEqual(['Docs finished.']);
  });

  it('a line for another device stops what this one is still saying (one voice)', () => {
    push({ kind: 'message_start', message: line('r1', '', 'phone', true) });
    push({ kind: 'message_delta', messageId: 'r1', delta: 'First. Second sentence still going' });
    const before = engine.cancels;
    push({ kind: 'message_start', message: line('r2', '', 'mac', true) });
    expect(engine.cancels).toBe(before + 1);
    push({ kind: 'message_end', message: line('r1', 'First. Second sentence still going.', 'phone') });
    expect(engine.spoken).toEqual(['First.']);
  });

  it('also cuts the queued tail of a reply that already finished streaming', () => {
    push({ kind: 'message_end', message: line('r1', 'One. Two. Three.', 'phone') });
    engine.playing = true; // sentences still queued
    const before = engine.cancels;
    push({ kind: 'message_start', message: line('r2', '', 'mac', true) });
    expect(engine.cancels).toBe(before + 1);
  });

  it('the asking device disconnected mid-reply: the hub hands it over at message_end', () => {
    push({ kind: 'message_start', message: line('r1', '', 'mac', true) });
    push({ kind: 'message_delta', messageId: 'r1', delta: 'Docs is done. Tests pass.' });
    expect(engine.spoken).toEqual([]);
    push({ kind: 'message_end', message: line('r1', 'Docs is done. Tests pass.', 'phone') });
    expect(engine.spoken).toEqual(['Docs is done.', 'Tests pass.']);
  });

  it('legacy: no speakOn, or no self id (older hub), speaks as before', () => {
    push({ kind: 'message_end', message: line('r1', 'Old hub line.') });
    expect(engine.spoken).toEqual(['Old hub line.']);
    self = null;
    push({ kind: 'message_end', message: line('r2', 'Unknown self.', 'mac') });
    expect(engine.spoken).toEqual(['Old hub line.', 'Unknown self.']);
  });

  it('with routing, a delta without its start is never spoken (cannot know the target)', () => {
    push({ kind: 'message_delta', messageId: 'zz', delta: 'Orphan delta. ' });
    expect(engine.spoken).toEqual([]);
  });
});

// ---------------------------------------------------------------- receiver

const sig = (over: Partial<HeraldSpeakingSignal> = {}): HeraldSpeakingSignal => ({
  active: true, deviceId: 'phone', label: 'Phone', utteranceId: 'u1', remainingMs: 2000, ...over,
});

describe('FleetSpeakingTracker', () => {
  let now = 0;
  let t: FleetSpeakingTracker;
  beforeEach(() => {
    vi.useFakeTimers();
    now = 1_000_000;
    t = new FleetSpeakingTracker(() => now);
  });
  afterEach(() => vi.useRealTimers());

  it('start -> remote speaker + suppressed; end -> tail, then free', () => {
    const seen: Array<string | null> = [];
    t.subscribe((r) => seen.push(r ? r.label : null));
    t.handle(sig(), 'mac');
    expect(t.remote).toEqual({ deviceId: 'phone', label: 'Phone', utteranceId: 'u1' });
    expect(t.suppressed()).toBe(true);
    t.handle(sig({ active: false }), 'mac');
    expect(t.remote).toBeNull();
    expect(t.suppressed()).toBe(true); // the room still rings
    now += FLEET_TAIL_MS - 1;
    expect(t.suppressed()).toBe(true);
    now += 2;
    expect(t.suppressed()).toBe(false);
    expect(seen).toEqual(['Phone', null]);
  });

  it('heartbeats keep it; a missed heartbeat ends it (lost end)', () => {
    t.handle(sig(), 'mac');
    for (let i = 0; i < 5; i++) {
      now += 1000;
      t.handle(sig(), 'mac');
    }
    expect(t.remote).not.toBeNull();
    now += FLEET_HEARTBEAT_TIMEOUT_MS + 1;
    expect(t.remote).toBeNull();
    expect(t.suppressed()).toBe(true);
    now += FLEET_TAIL_MS;
    expect(t.suppressed()).toBe(false);
  });

  it('the indicator clears by itself on a heartbeat timeout', async () => {
    const seen: Array<string | null> = [];
    t.subscribe((r) => seen.push(r ? r.deviceId : null));
    t.handle(sig(), 'mac');
    now += FLEET_HEARTBEAT_TIMEOUT_MS + 60;
    await vi.advanceTimersByTimeAsync(FLEET_HEARTBEAT_TIMEOUT_MS + 60);
    expect(seen).toEqual(['phone', null]);
  });

  it('caps one utterance', () => {
    t.handle(sig(), 'mac');
    for (let ms = 0; ms <= FLEET_MAX_MS; ms += 1000) {
      now += 1000;
      t.handle(sig(), 'mac');
    }
    expect(t.remote).toBeNull();
  });

  it("ignores this device's own signal (it has AEC), and it ends any other track", () => {
    t.handle(sig({ deviceId: 'mac' }), 'mac');
    expect(t.remote).toBeNull();
    expect(t.suppressed()).toBe(false);
    t.handle(sig(), 'mac');
    t.handle(sig({ deviceId: 'mac', utteranceId: 'u2' }), 'mac');
    expect(t.remote).toBeNull();
  });

  it("an end for someone else's utterance does not end the current one", () => {
    t.handle(sig(), 'mac');
    t.handle(sig({ active: false, deviceId: 'pc' }), 'mac');
    expect(t.remote?.deviceId).toBe('phone');
  });
});

// ---------------------------------------------------------------- suppression matrix

describe('fleetDecision (suppression matrix)', () => {
  const ALL: VoiceInputSource[] = ['button', 'space', 'chord', 'global', 'trigger', 'interrupt', 'followup', 'wake'];

  it('nobody else speaking: everything is allowed', () => {
    for (const s of ALL) expect(fleetDecision(s, 'what is new', false)).toBe('allow');
  });

  it('another device speaking: gestures pass, hands-off captures drop', () => {
    const got = Object.fromEntries(ALL.map((s) => [s, fleetDecision(s, 'Out4 finished the deploy', true)]));
    expect(got).toEqual({
      button: 'allow', space: 'allow', chord: 'allow', global: 'allow', trigger: 'allow',
      interrupt: 'drop', followup: 'drop', wake: 'drop',
    });
  });

  it('wake + stop is the one hands-off exception', () => {
    expect(fleetDecision('wake', 'stop', true)).toBe('stop');
    expect(fleetDecision('wake', 'Hey Jarvis, stop talking', true)).toBe('stop');
    expect(fleetDecision('wake', 'be quiet', true)).toBe('stop');
    expect(fleetDecision('wake', "Jarvis said Out4's tests stopped", true)).toBe('drop');
    expect(fleetDecision('followup', 'stop', true)).toBe('drop');
    expect(fleetDecision('interrupt', 'stop', true)).toBe('drop');
    expect(isStopUtterance('Hey Jarvis stop')).toBe(true);
    expect(isStopUtterance('Hey Jarvis')).toBe(false);
  });
});

describe('stopAfterWake (stop said over another device)', () => {
  it('finds "Jarvis, stop" inside a longer transcript; needs the name; only right after it', () => {
    expect(stopAfterWake('the weather is sunny and warm hey Jarvis stop tomorrow will be')).toBe(true);
    expect(stopAfterWake('Hey Jarvis, be quiet.')).toBe(true);
    expect(stopAfterWake('Jarvis, stop talking please')).toBe(true);
    expect(stopAfterWake('Hey Jarvis, the weather is sunny. Stop by later.')).toBe(false);
    expect(stopAfterWake('wait, the deploy is still running')).toBe(false); // no wake word
    expect(stopAfterWake('stop')).toBe(false);
    expect(stopAfterWake('')).toBe(false);
  });
});

describe('GestureLedger', () => {
  it('a gesture transcript flags the next send once; a hands-off one clears it; it expires', () => {
    let now = 0;
    const g = new GestureLedger(() => now);
    g.note('chord');
    expect(g.take()).toBe(true);
    expect(g.take()).toBe(false);
    g.note('trigger');
    g.note('followup');
    expect(g.take()).toBe(false);
    g.note('button');
    now += GESTURE_TTL_MS;
    expect(g.take()).toBe(false);
  });
});

// ---------------------------------------------------------------- speaker

describe('SpeakingReporter', () => {
  let now = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    now = 5_000_000;
  });
  afterEach(() => vi.useRealTimers());

  function setup(enabled = true) {
    const sent: HeraldSpeakingReport[] = [];
    let n = 0;
    const r = new SpeakingReporter({ send: (x) => sent.push(x), enabled: () => enabled, now: () => now, newId: () => `u${++n}` });
    return { r, sent };
  }

  it('start with an end estimate, a heartbeat every second, then end', async () => {
    const { r, sent } = setup();
    r.queued('Out4 finished the deploy and the tests passed.', 1);
    r.setSpeaking(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ state: 'start', utteranceId: 'u1', sentAt: now });
    expect(sent[0].approxEndAt! - now).toBe(estimateSpeechMs('Out4 finished the deploy and the tests passed.', 1));
    now += SPEAKING_HEARTBEAT_MS;
    await vi.advanceTimersByTimeAsync(SPEAKING_HEARTBEAT_MS);
    now += SPEAKING_HEARTBEAT_MS;
    await vi.advanceTimersByTimeAsync(SPEAKING_HEARTBEAT_MS);
    expect(sent.map((s) => s.state)).toEqual(['start', 'start', 'start']);
    expect(sent.every((s) => s.utteranceId === 'u1')).toBe(true);
    r.setSpeaking(false);
    expect(sent[sent.length - 1]).toMatchObject({ state: 'end', utteranceId: 'u1' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toHaveLength(4); // no heartbeat after the end
    r.setSpeaking(true);
    expect(sent[4].utteranceId).toBe('u2');
  });

  it('cut playback brings the estimate back to now; disabled (older hub) sends nothing', () => {
    const a = setup();
    a.r.queued('A long sentence with quite a few words in it to say.', 1);
    a.r.cancelled();
    a.r.setSpeaking(true);
    expect(a.sent[0].approxEndAt).toBe(now);
    const b = setup(false);
    b.r.setSpeaking(true);
    b.r.setSpeaking(false);
    expect(b.sent).toHaveLength(0);
  });

  it('reportingEngine feeds the reporter from the engine', () => {
    const { r, sent } = setup();
    const engine = new MockEngine();
    const wrapped = reportingEngine(engine, r);
    wrapped.speak('Hello there.', { rate: 1 });
    expect(engine.spoken).toEqual(['Hello there.']);
    engine.emit({ type: 'speaking', speaking: true });
    expect(sent[0].state).toBe('start');
    wrapped.cancel();
    expect(engine.cancels).toBe(1);
    engine.emit({ type: 'speaking', speaking: false });
    expect(sent[sent.length - 1].state).toBe('end');
  });
});

// ---------------------------------------------------------------- automation during another device's speech

function fakeVad() {
  const vad: VadLike & { events: VadEvents | null } = {
    running: false,
    events: null,
    async start(events) {
      vad.events = events;
      (vad as { running: boolean }).running = true;
    },
    pause() {
      (vad as { running: boolean }).running = false;
    },
    setSensitivity() {},
    destroy() {},
  };
  return vad;
}

function fakeTransport(sttText: string) {
  const requests: Array<{ type: string; payload: any }> = [];
  const t: HeraldTransport = {
    isConnected: () => true,
    request: async (type, payload) => {
      requests.push({ type, payload });
      if (type === 'herald_voice_stream_end') return { type, success: true, payload: { text: (payload as any).action === 'transcribe' ? sttText : '', audioMs: 900, sttMs: 200, woke: true } };
      return { type, success: true, payload: {} };
    },
    onEvent: () => () => {},
    onConnectivity: () => () => {},
    fire: () => true,
  };
  return { t, requests };
}

describe('VoiceAutomation while another device speaks', () => {
  let now = 0;
  let suppressed = true;
  beforeEach(() => {
    vi.useFakeTimers();
    now = 200_000;
    suppressed = true;
  });
  afterEach(() => vi.useRealTimers());
  const base: AutomationConfig = { available: true, micGranted: true, interrupt: true, sensitivity: 'normal', speaking: false };

  function setup(sttText: string) {
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
    const onFleetStop = vi.fn();
    const stopSpeech = vi.fn();
    const auto = new VoiceAutomation({
      vad, input, stopSpeech, now: () => now, getTransport: () => tr.t, onWake, onFleetStop,
      fleetSuppressed: () => suppressed,
    });
    return { vad, input, auto, onTranscript, onWake, onFleetStop, stopSpeech, ...tr };
  }
  const streamId = (requests: Array<{ type: string; payload: any }>) =>
    requests.find((r) => r.type === 'herald_voice_stream_start')!.payload.streamId as string;

  it('no talk-over capture in the grace period after this device spoke', async () => {
    const { vad, auto, input, onTranscript } = setup('Out4 finished');
    auto.update({ ...base, speaking: true });
    auto.update({ ...base, speaking: false });
    now += ECHO_TAIL_MS + 10;
    await vi.advanceTimersByTimeAsync(0);
    vad.events!.onSpeechRealStart();
    await vi.advanceTimersByTimeAsync(0);
    expect(input.state.phase).toBe('idle');
    vad.events!.onSpeechEnd(new Float32Array(16000));
    await vi.advanceTimersByTimeAsync(0);
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it('the speaking device itself keeps barge-in (its AEC removes Herald)', async () => {
    const { vad, auto, input } = setup('wait');
    auto.update({ ...base, speaking: true });
    await vi.advanceTimersByTimeAsync(0);
    vad.events!.onSpeechRealStart();
    for (let i = 0; i < GATE_FIRST_CHECK_FRAMES; i++) vad.events!.onFrame(new Float32Array(512).fill(0.2), 0.9);
    await vi.advanceTimersByTimeAsync(0);
    expect(input.state.source).toBe('interrupt');
  });

  it('the follow-up window will not open, and an open one closes on speech', async () => {
    const { vad, auto, input } = setup('and the tests?');
    auto.update({ ...base, interrupt: false });
    expect(auto.followUp(FOLLOW_UP_MS)).toBe(false);
    suppressed = false;
    expect(auto.followUp(FOLLOW_UP_MS)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    suppressed = true;
    vad.events!.onSpeechStart();
    expect(input.state.phase).toBe('idle');
    expect(auto.followUpWaiting).toBe(false);
  });

  it('a wake word stays quiet; "Hey Jarvis, stop" stops the other device', async () => {
    const { vad, auto, input, onWake, onFleetStop, onTranscript, requests } = setup('stop');
    auto.update({ ...base, interrupt: false, handsFree: true });
    await vi.advanceTimersByTimeAsync(0);
    vad.events!.onSpeechStart();
    auto.onVoiceEvent({ kind: 'wake', streamId: streamId(requests), score: 0.99, model: 'hey_jarvis' });
    expect(onWake).not.toHaveBeenCalled();
    expect(input.state.phase).toBe('idle');
    vad.events!.onSpeechEnd(new Float32Array(16000));
    await vi.advanceTimersByTimeAsync(0);
    expect(onFleetStop).toHaveBeenCalledTimes(1);
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it('"Jarvis, stop" over continuous remote speech acts before the utterance ends', async () => {
    const vad = fakeVad();
    const tr = fakeTransport('');
    const input = new VoiceInputController({
      mic: { permission: 'granted', start: async () => {}, stop: () => {} },
      getTransport: () => tr.t, onTranscript: vi.fn(), onBargeIn: () => {}, now: () => now,
    });
    const onFleetStop = vi.fn();
    const heard = ['the weather today is sunny and', 'sunny and warm hey jarvis stop with a light'];
    const transcribe = vi.fn(async () => heard.shift() ?? '');
    const auto = new VoiceAutomation({
      vad, input, stopSpeech: vi.fn(), now: () => now, getTransport: () => tr.t, onFleetStop, transcribe,
      fleetSuppressed: () => suppressed,
    });
    auto.update({ ...base, interrupt: false, handsFree: true });
    await vi.advanceTimersByTimeAsync(0);
    vad.events!.onSpeechStart();
    for (let i = 0; i < 40; i++) vad.events!.onFrame(new Float32Array(512).fill(0.1), 0.9);
    auto.onVoiceEvent({ kind: 'wake', streamId: streamId(tr.requests), score: 0.99, model: 'hey_jarvis' });
    now += FLEET_STOP_CHECKS_MS[0];
    await vi.advanceTimersByTimeAsync(FLEET_STOP_CHECKS_MS[0]);
    expect(onFleetStop).not.toHaveBeenCalled();
    now += FLEET_STOP_CHECKS_MS[1] - FLEET_STOP_CHECKS_MS[0];
    await vi.advanceTimersByTimeAsync(FLEET_STOP_CHECKS_MS[1] - FLEET_STOP_CHECKS_MS[0]);
    expect(onFleetStop).toHaveBeenCalledTimes(1); // still mid-utterance
    // The utterance ends later: no second stop.
    vad.events!.onSpeechEnd(new Float32Array(16000));
    await vi.advanceTimersByTimeAsync(5000);
    expect(onFleetStop).toHaveBeenCalledTimes(1);
    expect(transcribe).toHaveBeenCalledTimes(2);
  });

  it("Herald's own \"Jarvis\" on another device wakes nothing and sends nothing", async () => {
    const { vad, auto, onWake, onFleetStop, onTranscript, requests } = setup('Jarvis, Out4 finished the deploy');
    auto.update({ ...base, interrupt: false, handsFree: true });
    await vi.advanceTimersByTimeAsync(0);
    vad.events!.onSpeechStart();
    auto.onVoiceEvent({ kind: 'wake', streamId: streamId(requests), score: 0.9, model: 'hey_jarvis' });
    vad.events!.onSpeechEnd(new Float32Array(16000));
    await vi.advanceTimersByTimeAsync(0);
    expect(onWake).not.toHaveBeenCalled();
    expect(onFleetStop).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
    expect(auto.awaitingCommand).toBe(false);
  });

  it('a gesture still works: a trigger listen captures and delivers', async () => {
    const { vad, auto, onTranscript } = setup('what is Out4 doing');
    auto.update({ ...base, interrupt: false });
    expect(await auto.listen()).toBe(true);
    vad.events!.onSpeechStart();
    vad.events!.onSpeechEnd(new Float32Array(16000));
    await vi.advanceTimersByTimeAsync(0);
    expect(onTranscript).toHaveBeenCalledWith('what is Out4 doing', 'trigger');
  });
});
