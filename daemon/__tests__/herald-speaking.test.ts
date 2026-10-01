/**
 * One speaking device per Herald line (speakOn), the fleet-wide "Herald is
 * speaking" signal, remote stop, and the voice-send backstop.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SPEAKING_LIMITS, SpeakingTracker } from '../src/herald/voice/speaking';
import { HeraldVoiceService, VoiceError } from '../src/herald/voice/service';
import { HeraldService } from '../src/herald/service';
import { HeraldStore } from '../src/herald/store';
import { registerHeraldHandlers } from '../src/handlers/herald';
import type { ResolvedHeraldConfig } from '../src/herald/config';
import type { SessionSource } from '../src/herald/session-source';
import type { LlmChatResult, LlmProvider } from '../src/herald/llm/provider';
import type {
  HeraldDevicesSnapshot,
  HeraldEvent,
  HeraldMessage,
  HeraldSpeakingSignal,
} from '../src/herald/protocol';

// ---------------------------------------------------------------- tracker

function tracker(labels: Record<string, string> = { a: 'Phone', b: 'Mac' }) {
  let now = 1_000_000;
  const signals: HeraldSpeakingSignal[] = [];
  const t = new SpeakingTracker({
    broadcast: (s) => signals.push(s),
    labelOf: (id) => labels[id] ?? 'Unnamed device',
    now: () => now,
  });
  return {
    t,
    signals,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

describe('SpeakingTracker', () => {
  it('start, heartbeat, end: broadcast with label and remaining time, then a tail', () => {
    const { t, signals, advance, now } = tracker();
    t.report('a', { state: 'start', utteranceId: 'u1', approxEndAt: now() + 4000, sentAt: now() });
    expect(signals).toEqual([
      { active: true, deviceId: 'a', label: 'Phone', utteranceId: 'u1', remainingMs: 4000 },
    ]);
    expect(t.speakerId).toBe('a');
    expect(t.suppresses('b')).toBe(true);
    expect(t.suppresses('a')).toBe(false); // the speaker keeps its own AEC behaviour

    advance(1000);
    t.report('a', { state: 'start', utteranceId: 'u1', approxEndAt: 5000, sentAt: 2000 });
    expect(signals[1]).toMatchObject({ active: true, utteranceId: 'u1', remainingMs: 3000 });

    t.report('a', { state: 'end', utteranceId: 'u1' });
    expect(signals[2]).toMatchObject({ active: false, deviceId: 'a', remainingMs: 0 });
    expect(t.speakerId).toBeNull();
    // Tail: the room still rings.
    expect(t.suppresses('b')).toBe(true);
    advance(SPEAKING_LIMITS.tailMs - 1);
    expect(t.suppresses('b')).toBe(true);
    advance(2);
    expect(t.suppresses('b')).toBe(false);
  });

  it('a lost end times out after a missed heartbeat', () => {
    const { t, signals, advance } = tracker();
    t.report('a', { state: 'start', utteranceId: 'u1' });
    advance(SPEAKING_LIMITS.heartbeatTimeoutMs - 100);
    expect(t.suppresses('b')).toBe(true);
    advance(200);
    t.sweep();
    expect(t.speakerId).toBeNull();
    expect(signals[signals.length - 1]).toMatchObject({ active: false, deviceId: 'a' });
    advance(SPEAKING_LIMITS.tailMs + 1);
    expect(t.suppresses('b')).toBe(false);
  });

  it('heartbeats keep it alive up to the cap', () => {
    const { t, advance } = tracker();
    t.report('a', { state: 'start', utteranceId: 'u1' });
    for (let ms = 0; ms < SPEAKING_LIMITS.maxMs - 1000; ms += 1000) {
      advance(1000);
      t.report('a', { state: 'start', utteranceId: 'u1' });
    }
    expect(t.speakerId).toBe('a');
    advance(1001);
    t.report('a', { state: 'start', utteranceId: 'u1' });
    advance(1000);
    expect(t.speakerId).toBeNull();
  });

  it('an end for another utterance or device is ignored; a new start takes over', () => {
    const { t } = tracker();
    t.report('a', { state: 'start', utteranceId: 'u1' });
    t.report('a', { state: 'end', utteranceId: 'old' });
    t.report('b', { state: 'end', utteranceId: 'u1' });
    expect(t.speakerId).toBe('a');
    t.report('b', { state: 'start', utteranceId: 'u2' });
    expect(t.speakerId).toBe('b');
    expect(t.suppresses('a')).toBe(true);
  });

  it('rejects malformed reports; disconnect and stop end the window', () => {
    const { t } = tracker();
    expect(() => t.report('a', { state: 'loud', utteranceId: 'u' })).toThrow(/state/);
    expect(() => t.report('a', { state: 'start', utteranceId: 'bad id!' })).toThrow(/utteranceId/);
    expect(() => t.report('a', null)).toThrow();
    t.report('a', { state: 'start', utteranceId: 'u1' });
    t.clientGone('a');
    expect(t.speakerId).toBeNull();
    t.report('b', { state: 'start', utteranceId: 'u2' });
    t.stopped('b');
    expect(t.speakerId).toBeNull();
  });

  it('clamps absurd estimates', () => {
    const { t, signals } = tracker();
    t.report('a', { state: 'start', utteranceId: 'u1', approxEndAt: 1e12, sentAt: 0 });
    expect(signals[0].remainingMs).toBe(SPEAKING_LIMITS.maxRemainingMs);
  });
});

// ---------------------------------------------------------------- voice service: remote stop

function fakeClient() {
  return {
    baseUrl: 'http://127.0.0.1:9889',
    health: jest.fn(async () => ({ ok: true })),
    tts: jest.fn(),
    stt: jest.fn(),
    wake: jest.fn(),
    dropWake: jest.fn(async () => undefined),
  } as any;
}

describe('HeraldVoiceService speaking + remote stop', () => {
  function setup() {
    const signals: HeraldSpeakingSignal[] = [];
    const delivered: Array<[string, HeraldEvent]> = [];
    const svc = new HeraldVoiceService({
      client: fakeClient(),
      sendEvent: () => {},
      onSpeaking: (s) => signals.push(s),
      deliverEvent: (id, e) => {
        delivered.push([id, e]);
        return true;
      },
    });
    svc.setPresence('phone', { interacted: true, label: 'Phone' });
    svc.setPresence('mac', { interacted: false, label: 'Mac' });
    return { svc, signals, delivered };
  }

  it('broadcasts with the device label; "stop" from another device reaches the speaker', () => {
    const { svc, signals, delivered } = setup();
    svc.reportSpeaking('phone', { state: 'start', utteranceId: 'u1' });
    expect(signals[0]).toMatchObject({ active: true, deviceId: 'phone', label: 'Phone' });
    expect(svc.speakingSuppresses('mac')).toBe(true);
    expect(svc.speakingSuppresses('phone')).toBe(false);

    const res = svc.stopSpeaking('mac', {});
    expect(res).toEqual({ stopped: true, deviceId: 'phone' });
    expect(delivered).toEqual([['phone', { kind: 'stop_speaking', utteranceId: 'u1', by: 'Mac' }]]);
    // The window closes at once (receivers keep the tail).
    expect(signals[signals.length - 1]).toMatchObject({ active: false, deviceId: 'phone' });
  });

  it('nothing to stop when nobody is speaking; a named device that is not speaking still gets it', () => {
    const { svc, delivered } = setup();
    expect(svc.stopSpeaking('mac', {})).toEqual({ stopped: false });
    expect(delivered).toHaveLength(0);
    expect(svc.stopSpeaking('mac', { deviceId: 'phone' })).toEqual({
      stopped: true,
      deviceId: 'phone',
    });
    expect(delivered[0]).toEqual([
      'phone',
      { kind: 'stop_speaking', utteranceId: null, by: 'Mac' },
    ]);
    expect(svc.stopSpeaking('mac', { deviceId: 'ghost' })).toEqual({ stopped: false });
  });

  it('a malformed report is a bad_request VoiceError; a disconnect ends speaking', () => {
    const { svc, signals } = setup();
    expect(() => svc.reportSpeaking('phone', { state: 'x' })).toThrow(VoiceError);
    svc.reportSpeaking('phone', { state: 'start', utteranceId: 'u1' });
    svc.clientGone('phone');
    expect(signals[signals.length - 1]).toMatchObject({ active: false, deviceId: 'phone' });
  });

  it('WS handlers: herald_speaking and herald_stop_speaking', async () => {
    const { svc, delivered } = setup();
    const sent: any[] = [];
    const ctx: any = {
      heraldVoice: svc,
      config: { listeners: [{ port: 9877, token: 't', tls: false }] },
      send: (_ws: unknown, r: unknown) => sent.push(r),
    };
    const h = registerHeraldHandlers(ctx);
    const phone: any = { id: 'phone', ws: {}, isLocal: true, listenerPort: 9877, origin: null };
    const mac: any = { id: 'mac', ws: {}, isLocal: true, listenerPort: 9877, origin: null };
    await h.herald_speaking(phone, { state: 'start', utteranceId: 'u9' }, 'r1');
    await h.herald_speaking(phone, { state: 'nope', utteranceId: 'u9' }, 'r2');
    await h.herald_stop_speaking(mac, {}, 'r3');
    expect(sent[0]).toEqual({
      type: 'herald_speaking',
      success: true,
      payload: { ok: true },
      requestId: 'r1',
    });
    expect(sent[1]).toMatchObject({
      type: 'herald_speaking',
      success: false,
      payload: { code: 'bad_request' },
    });
    expect(sent[2]).toEqual({
      type: 'herald_stop_speaking',
      success: true,
      payload: { stopped: true, deviceId: 'phone' },
      requestId: 'r3',
    });
    expect(delivered[0][0]).toBe('phone');
  });
});

// ---------------------------------------------------------------- service: speakOn + backstop

function provider(texts: string[], gate?: Promise<void>): LlmProvider {
  return {
    name: 'fake',
    model: 'fake-1',
    async chat(r: { onText: (t: string) => void }) {
      if (gate) await gate;
      const t = texts.shift() || 'ok';
      r.onText(t);
      return { text: t, toolCalls: [], stopReason: 'end', usage: {} } as unknown as LlmChatResult;
    },
  } as unknown as LlmProvider;
}

const source = {
  serverId: 'local',
  listSessions: async () => [],
  getRecentTranscript: async () => null,
  getLiveChoice: async () => null,
  sessionExists: async () => true,
  sendText: async () => true,
  sendChoice: async () => true,
} as unknown as SessionSource;

const cfg: ResolvedHeraldConfig = {
  featureEnabled: true,
  displayName: 'Herald',
  provider: 'openai_compatible',
  baseUrl: 'http://x/v1',
  model: 'm',
  echoDelayMs: 80,
  requestTimeoutMs: 5000,
  maxTokens: 700,
  stateDir: '/tmp/unused',
  apiKey: null,
  brainConfigured: true,
};

async function waitFor(cond: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('HeraldService speakOn routing and the voice-send backstop', () => {
  let dir: string;
  let svc: HeraldService | null = null;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-speakon-'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'debug').mockImplementation(() => {});
  });
  afterEach(async () => {
    svc?.shutdown();
    svc = null;
    await new Promise((r) => setTimeout(r, 50));
    fs.rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function devices(ids: string[], active: string | null): HeraldDevicesSnapshot {
    return {
      activeDevice: active ? { id: active, label: active, pinned: false, reason: 'recent' } : null,
      devices: ids.map((id) => ({ id, label: id, handsFree: false })),
    };
  }

  async function make(opts: {
    snap: () => HeraldDevicesSnapshot | null;
    suppresses?: (id: string) => boolean;
    texts?: string[];
    gate?: Promise<void>;
  }) {
    const events: HeraldEvent[] = [];
    svc = new HeraldService({
      config: cfg,
      provider: provider(opts.texts ?? ['Out4 finished.', 'Sure.', 'Okay.'], opts.gate),
      sources: [source],
      store: new HeraldStore(dir, 10),
      broadcast: (e) => events.push(e),
      audit: () => {},
      pollIntervalMs: 60_000,
      devices: opts.snap,
      speakingSuppresses: opts.suppresses,
    });
    await svc.start();
    return { svc, events };
  }

  const heraldEnds = (events: HeraldEvent[]) =>
    events
      .filter((e): e is { kind: 'message_end'; message: HeraldMessage } => e.kind === 'message_end')
      .map((e) => e.message)
      .filter((m) => m.role === 'herald');
  const heraldStarts = (events: HeraldEvent[]) =>
    events
      .filter(
        (e): e is { kind: 'message_start'; message: HeraldMessage } => e.kind === 'message_start'
      )
      .map((e) => e.message)
      .filter((m) => m.role === 'herald');

  it('a reply is spoken on the device that sent the turn, not the active one', async () => {
    const { svc, events } = await make({ snap: () => devices(['phone', 'mac'], 'mac') });
    svc.send('anything new?', { mode: 'voice', clientId: 'phone' });
    await waitFor(() => !svc.getState().busy);
    expect(heraldStarts(events)[0].speakOn).toBe('phone');
    expect(heraldEnds(events)[0].speakOn).toBe('phone');
  });

  it('a typed message routes to its device too (voice off there = nobody speaks)', async () => {
    const { svc, events } = await make({ snap: () => devices(['phone', 'mac'], 'mac') });
    svc.send('anything new?', { mode: 'text', clientId: 'phone' });
    await waitFor(() => !svc.getState().busy);
    expect(heraldEnds(events)[0].speakOn).toBe('phone');
  });

  it('the asking device disconnects mid-reply: the active device, else nobody', async () => {
    let snap = devices(['phone', 'mac'], 'mac');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { svc, events } = await make({ snap: () => snap, gate });
    svc.send('anything new?', { mode: 'voice', clientId: 'phone' });
    await waitFor(() => heraldStarts(events).length > 0);
    expect(heraldStarts(events)[0].speakOn).toBe('phone');
    snap = devices(['mac'], 'mac');
    release();
    await waitFor(() => !svc.getState().busy);
    expect(heraldEnds(events)[0].speakOn).toBe('mac');

    let release2!: () => void;
    const gate2 = new Promise<void>((r) => (release2 = r));
    snap = devices(['phone', 'mac'], 'mac');
    svc.shutdown();
    const s2 = await make({ snap: () => snap, gate: gate2 });
    s2.svc.send('and now?', { mode: 'voice', clientId: 'phone' });
    await waitFor(() => heraldStarts(s2.events).length > 0);
    snap = devices([], null);
    release2();
    await waitFor(() => !s2.svc.getState().busy);
    expect(heraldEnds(s2.events)[0].speakOn).toBeNull();
  });

  it('legacy: a connection that is not a Herald device, or no voice layer, leaves speakOn absent', async () => {
    const a = await make({ snap: () => devices(['mac'], 'mac') });
    a.svc.send('anything new?', { mode: 'voice', clientId: 'old-client' });
    await waitFor(() => !a.svc.getState().busy);
    expect('speakOn' in heraldEnds(a.events)[0]).toBe(false);
    expect('speakOn' in heraldStarts(a.events)[0]).toBe(false);

    a.svc.shutdown();
    const b = await make({ snap: () => null });
    b.svc.send('anything new?', { mode: 'voice', clientId: 'phone' });
    await waitFor(() => !b.svc.getState().busy);
    expect('speakOn' in heraldEnds(b.events)[0]).toBe(false);
  });

  it('deterministic replies (usage, nothing new) route to the asker', async () => {
    const { svc, events } = await make({ snap: () => devices(['phone', 'mac'], 'mac') });
    svc.send('Brief me', { mode: 'voice', intent: 'brief', clientId: 'phone' });
    expect(heraldEnds(events).map((m) => [m.text, m.speakOn])).toEqual([['Nothing new.', 'phone']]);
  });

  it('speakOnFor: unasked lines go to the active device, else nobody', async () => {
    let snap: HeraldDevicesSnapshot | null = devices(['phone', 'mac'], 'mac');
    const { svc } = await make({ snap: () => snap });
    expect(svc.speakOnFor(null)).toBe('mac');
    snap = devices(['phone'], null);
    expect(svc.speakOnFor(null)).toBeNull();
    snap = null;
    expect(svc.speakOnFor(null)).toBeUndefined();
  });

  it('backstop: hands-off voice from a non-speaking device is dropped; a gesture, text, or the speaker itself pass', async () => {
    const speaking = new Set(['mac']); // mac is inside phone's speaking window
    const { svc } = await make({
      snap: () => devices(['phone', 'mac'], 'phone'),
      suppresses: (id) => speaking.has(id),
    });
    expect(svc.send('Out4 finished', { mode: 'voice', clientId: 'mac' })).toEqual({
      messageId: '',
      ignored: 'speaking',
    });
    expect(console.debug).toHaveBeenCalledWith(expect.stringMatching(/another device is speaking/));
    expect(svc.getState().messages).toHaveLength(0);

    const ok = svc.send('what is Out4 doing', { mode: 'voice', clientId: 'mac', gesture: true });
    expect(ok.ignored).toBeUndefined();
    await waitFor(() => !svc.getState().busy);
    expect(
      svc.send('typed while it talks', { mode: 'text', clientId: 'mac' }).ignored
    ).toBeUndefined();
    await waitFor(() => !svc.getState().busy);
    expect(
      svc.send('stop and tell me', { mode: 'voice', clientId: 'phone' }).ignored
    ).toBeUndefined();
  });
});
