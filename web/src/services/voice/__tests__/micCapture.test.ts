/**
 * MicCapture device handling: which mic is opened (and how), and what happens
 * when devices change under it. The audio graph and getUserMedia are fakes;
 * the device lists are real-world shapes (Chrome's "Default - " entries).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MicCapture, micConstraints, type ExternalMicSource, type MicEvent } from '../micCapture';
import type { HeraldAudioGraph, GraphAecMode } from '../audioGraph';

interface FakeTrack {
  label: string;
  readyState: 'live' | 'ended';
  deviceId: string;
  listeners: Array<() => void>;
  getSettings(): { deviceId: string };
  addEventListener(t: string, cb: () => void): void;
  stop(): void;
  end(): void;
}

function track(label: string, deviceId: string): FakeTrack {
  const t: FakeTrack = {
    label,
    deviceId,
    readyState: 'live',
    listeners: [],
    getSettings: () => ({ deviceId }),
    addEventListener: (_t, cb) => t.listeners.push(cb),
    stop: () => { t.readyState = 'ended'; },
    end: () => { t.readyState = 'ended'; t.listeners.forEach((l) => l()); },
  };
  return t;
}

type Dev = { kind: string; label: string; deviceId: string; groupId: string };
const input = (label: string, deviceId: string, groupId = deviceId): Dev => ({ kind: 'audioinput', label, deviceId, groupId });

function fakeEnv(opts: { aecOk?: boolean } = {}) {
  let devices: Dev[] = [];
  let permitted = false;
  const opened: Array<{ constraints: MediaStreamConstraints; track: FakeTrack }> = [];
  const md = {
    enumerateDevices: vi.fn(async () => devices.map((d) => (permitted ? d : { ...d, label: '' }))),
    getUserMedia: vi.fn(async (c: MediaStreamConstraints) => {
      permitted = true;
      const audio = c.audio as MediaTrackConstraints;
      const want = (audio.deviceId as { exact?: string } | undefined)?.exact;
      const real = devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default');
      const def = devices.find((d) => d.deviceId === 'default');
      const dev = want ? real.find((d) => d.deviceId === want) : real.find((d) => def && d.groupId === def.groupId) ?? real[0];
      if (!dev) throw Object.assign(new Error('gone'), { name: want ? 'OverconstrainedError' : 'NotFoundError' });
      const t = track(dev.label, dev.deviceId);
      opened.push({ constraints: c, track: t });
      return { getAudioTracks: () => [t], getTracks: () => [t] } as unknown as MediaStream;
    }),
  };
  const attached: Array<{ mode: GraphAecMode }> = [];
  const graph = {
    context: () => ({ createMediaStreamSource: () => ({ disconnect() {} }), sampleRate: 48000 }),
    ensureAec: vi.fn(async () => opts.aecOk !== false),
    attachMic: vi.fn((_n: unknown, mode: GraphAecMode) => attached.push({ mode })),
    detachMic: vi.fn(),
    resetAec: vi.fn(),
    cleanedStream: () => ({}) as MediaStream,
    cleanedBus: () => null,
  } as unknown as HeraldAudioGraph;
  return {
    md,
    graph,
    opened,
    attached,
    setDevices: (d: Dev[]) => { devices = d; },
  };
}

const flush = async () => {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
    for (let j = 0; j < 10; j++) await Promise.resolve();
  }
};

describe('MicCapture device handling', () => {
  let env: ReturnType<typeof fakeEnv>;
  const mics: MicCapture[] = [];
  const saved = { md: Object.getOwnPropertyDescriptor(navigator, 'mediaDevices'), awn: (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode };

  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode = class {};
  });
  afterEach(async () => {
    await flush();
    mics.splice(0).forEach((m) => m.release());
    if (saved.md) Object.defineProperty(navigator, 'mediaDevices', saved.md);
    else delete (navigator as { mediaDevices?: unknown }).mediaDevices;
    (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode = saved.awn;
  });

  function make(opts: { aecOk?: boolean } = {}) {
    env = fakeEnv(opts);
    Object.defineProperty(navigator, 'mediaDevices', { value: env.md, configurable: true });
    const mic = new MicCapture(env.graph);
    mics.push(mic);
    const events: MicEvent[] = [];
    mic.on((e) => events.push(e));
    return { mic, events };
  }

  it('opens the mic raw for in-graph cancellation, or browser-processed when the canceller is missing', async () => {
    expect(micConstraints('in-graph').audio).toMatchObject({ echoCancellation: false, noiseSuppression: false, autoGainControl: false });
    expect(micConstraints('browser', 'x').audio).toMatchObject({ echoCancellation: true, deviceId: { exact: 'x' } });

    const a = make();
    env.setDevices([input('Default - Yeti Stereo Microphone', 'default', 'y'), input('Yeti Stereo Microphone', 'y')]);
    await a.mic.acquire();
    expect(env.opened[0].constraints.audio).toMatchObject({ echoCancellation: false });
    expect(env.attached[0].mode).toBe('in-graph');
    expect(a.mic.mode).toBe('in-graph');

    const b = make({ aecOk: false });
    env.setDevices([input('Yeti Stereo Microphone', 'y')]);
    await b.mic.acquire();
    expect(env.opened[0].constraints.audio).toMatchObject({ echoCancellation: true });
    expect(b.mic.mode).toBe('browser');
  });

  it('first open (no labels yet) uses the default, then moves off a Bluetooth headset mic', async () => {
    const { mic, events } = make();
    env.setDevices([
      input('Default - AirPods Pro (Bluetooth)', 'default', 'air'),
      input('AirPods Pro (Bluetooth)', 'air'),
      input('MacBook Pro Microphone (Built-in)', 'mbp'),
    ]);
    await mic.acquire();
    expect((env.opened[0].constraints.audio as MediaTrackConstraints).deviceId).toBeUndefined();
    await flush();
    expect(env.opened).toHaveLength(2);
    expect(env.opened[1].constraints.audio).toMatchObject({ deviceId: { exact: 'mbp' } });
    expect(env.opened[0].track.readyState).toBe('ended'); // Bluetooth mic released: back to A2DP
    expect(mic.label).toBe('MacBook Pro Microphone (Built-in)');
    expect(events.find((e) => e.type === 'switched')).toMatchObject({ reason: 'avoid-bluetooth', kind: 'builtin' });
  });

  it('with labels already visible (permission granted earlier) opens the right mic first time', async () => {
    const { mic } = make();
    env.setDevices([input('Default - AirPods Pro', 'default', 'air'), input('AirPods Pro', 'air'), input('MacBook Pro Microphone', 'mbp')]);
    await mic.acquire(); // grants
    mic.release();
    env.opened.length = 0;
    await mic.acquire();
    expect(env.opened[0].constraints.audio).toMatchObject({ deviceId: { exact: 'mbp' } });
  });

  it('devicechange: the OS default moved to a new mic -> re-open on it', async () => {
    const { mic, events } = make();
    env.setDevices([input('Default - MacBook Pro Microphone', 'default', 'mbp'), input('MacBook Pro Microphone', 'mbp')]);
    await mic.acquire();
    await flush();
    expect(env.opened).toHaveLength(1);
    env.setDevices([input('Default - Yeti Stereo Microphone', 'default', 'y'), input('MacBook Pro Microphone', 'mbp'), input('Yeti Stereo Microphone', 'y')]);
    await mic.reevaluate('device-change');
    expect(env.opened).toHaveLength(2);
    expect(mic.label).toBe('Yeti Stereo Microphone');
    expect(events[events.length - 1]).toMatchObject({ type: 'switched', reason: 'device-change' });
    // Nothing changed: no re-open.
    await mic.reevaluate('device-change');
    expect(env.opened).toHaveLength(2);
  });

  it('devicechange: Bluetooth headset connects and becomes the default -> stays on the built-in mic', async () => {
    const { mic } = make();
    env.setDevices([input('Default - MacBook Pro Microphone', 'default', 'mbp'), input('MacBook Pro Microphone', 'mbp')]);
    await mic.acquire();
    await flush();
    env.setDevices([input('Default - AirPods Pro', 'default', 'air'), input('AirPods Pro', 'air'), input('MacBook Pro Microphone', 'mbp')]);
    await mic.reevaluate('device-change');
    expect(env.opened[env.opened.length - 1].constraints.audio).toMatchObject({ deviceId: { exact: 'mbp' } });
    expect(mic.label).toBe('MacBook Pro Microphone');
  });

  it('the mic in use is unplugged mid-capture: re-open on what is left and say so', async () => {
    const { mic, events } = make();
    env.setDevices([input('Default - Yeti Stereo Microphone', 'default', 'y'), input('Yeti Stereo Microphone', 'y'), input('MacBook Pro Microphone', 'mbp')]);
    await mic.acquire();
    mic.retain(); // the VAD is listening
    await flush();
    env.setDevices([input('Default - MacBook Pro Microphone', 'default', 'mbp'), input('MacBook Pro Microphone', 'mbp')]);
    env.opened[0].track.end();
    await flush();
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['lost', 'switched']));
    expect(events.find((e) => e.type === 'lost')).toMatchObject({ label: 'Yeti Stereo Microphone' });
    expect(mic.label).toBe('MacBook Pro Microphone');
    expect(mic.isOpen).toBe(true);
  });

  it('warns once when the only mic is a Bluetooth headset', async () => {
    const { mic, events } = make();
    env.setDevices([input('AirPods Pro (Bluetooth)', 'air')]);
    await mic.acquire();
    await flush();
    await mic.reevaluate('device-change');
    expect(events.filter((e) => e.type === 'only-bluetooth')).toHaveLength(1);
  });

  it('setting off: the Bluetooth mic is used as is', async () => {
    const { mic } = make();
    mic.setMicPrefs({ avoidBluetoothMic: false });
    env.setDevices([input('Default - AirPods Pro', 'default', 'air'), input('AirPods Pro', 'air'), input('MacBook Pro Microphone', 'mbp')]);
    await mic.acquire();
    await flush();
    expect(env.opened).toHaveLength(1);
    expect(mic.label).toBe('AirPods Pro');
    // Turning it on re-opens on the built-in mic.
    mic.setMicPrefs({ avoidBluetoothMic: true });
    await flush();
    expect(mic.label).toBe('MacBook Pro Microphone');
  });

  it('native capture (Android) is used when registered; a failure falls back to the WebView mic', async () => {
    const { mic } = make();
    env.setDevices([input('Default', 'default', 'd'), input('Speakerphone', 'sp', 'd')]);
    const ok: ExternalMicSource = {
      open: vi.fn(async () => ({ node: {} as AudioNode, mode: 'in-graph' as GraphAecMode, label: 'Phone microphone', kind: 'builtin' as const })),
      close: vi.fn(),
    };
    mic.setExternalSource(ok);
    await mic.acquire();
    expect(env.md.getUserMedia).not.toHaveBeenCalled();
    expect(mic.label).toBe('Phone microphone');
    mic.release();
    expect(ok.close).toHaveBeenCalled();

    const broken: ExternalMicSource = { open: vi.fn(async () => { throw new Error('plugin missing'); }), close: vi.fn() };
    mic.setExternalSource(broken);
    await mic.acquire();
    expect(env.md.getUserMedia).toHaveBeenCalledTimes(1);
  });
});
