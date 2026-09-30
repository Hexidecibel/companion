import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PcmJitterBuffer, TARGET_MS, MAX_MS } from '../pcmJitter';

// A plain function, not vi.fn: the spy's result tracking leaves an unhandled
// derived promise when an async implementation rejects.
const calls: unknown[][] = [];
let invokeImpl: (cmd: string, args?: any) => Promise<unknown> = async () => null;
const invoke = Object.assign((cmd: string, args?: unknown) => {
  calls.push([cmd, args]);
  return invokeImpl(cmd, args);
}, {
  mockReset: () => { calls.length = 0; invokeImpl = async () => null; },
  mockImplementation: (f: typeof invokeImpl) => { invokeImpl = f; },
});
class FakeChannel<T> {
  onmessage: (m: T) => void = () => {};
}
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
  Channel: FakeChannel,
  addPluginListener: vi.fn(async () => ({ unregister: async () => {} })),
}));

import { AndroidNativeMic, base64ToInt16 } from '../nativeAudio';

describe('PcmJitterBuffer', () => {
  it('primes to the target, upsamples 16 kHz -> 48 kHz without gaps, re-primes on underflow', () => {
    const j = new PcmJitterBuffer(16000, 48000);
    const out = new Float32Array(128);
    j.push(new Int16Array(160).fill(16384)); // 10 ms: below the target
    j.pull(out);
    expect(out.every((v) => v === 0)).toBe(true);
    j.push(new Int16Array((16000 * TARGET_MS) / 1000).fill(16384));
    j.pull(out);
    expect(out.every((v) => Math.abs(v - 0.5) < 1e-6)).toBe(true);
    // 3 output samples per input sample.
    const before = j.queued;
    j.pull(out);
    expect(before - j.queued).toBeGreaterThanOrEqual(42);
    expect(before - j.queued).toBeLessThanOrEqual(43);
    for (let i = 0; i < 100; i++) j.pull(out);
    expect(j.underflows).toBe(1);
    expect(out[out.length - 1]).toBe(0);
  });

  it('trims a growing backlog back to the target (native clock running fast)', () => {
    const j = new PcmJitterBuffer(16000, 48000);
    j.push(new Int16Array((16000 * (MAX_MS + 50)) / 1000));
    expect(j.trims).toBe(1);
    expect(j.queued).toBe((16000 * TARGET_MS) / 1000);
  });

  it('interpolates linearly between input samples', () => {
    const j = new PcmJitterBuffer(16000, 32000);
    const ramp = Int16Array.from({ length: 2000 }, (_, i) => i * 10);
    j.push(ramp);
    const out = new Float32Array(8);
    j.pull(out);
    expect(Array.from(out).map((v) => Math.round(v * 32768))).toEqual([0, 5, 10, 15, 20, 25, 30, 35]);
  });
});

describe('Android native mic', () => {
  beforeEach(() => invoke.mockReset());

  function fakeCtx() {
    const posted: Int16Array[] = [];
    class Node {
      port = { postMessage: (m: Int16Array) => posted.push(m) };
      context: unknown;
      constructor(ctx: unknown) { this.context = ctx; }
    }
    (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode = Node;
    const ctx = { audioWorklet: { addModule: vi.fn(async () => {}) } } as unknown as AudioContext;
    return { ctx, posted };
  }

  it('starts native capture with the Bluetooth preference and relays PCM into the graph', async () => {
    const { ctx, posted } = fakeCtx();
    let channel: FakeChannel<{ pcm?: string }> | null = null;
    invoke.mockImplementation(async (cmd: string, args: { onAudio: FakeChannel<{ pcm?: string }> }) => {
      if (cmd === 'plugin:herald-native|start_capture') {
        channel = args.onAudio;
        return { sampleRate: 16000, aec: false, device: 'Phone microphone', deviceType: 'builtin-mic' };
      }
      return null;
    });
    const mic = new AndroidNativeMic();
    const r = await mic.open(ctx, { avoidBluetooth: true });
    expect(calls[0]).toEqual(['plugin:herald-native|start_capture', expect.objectContaining({ aec: false, avoidBluetooth: true })]);
    expect(r).toMatchObject({ mode: 'in-graph', label: 'Phone microphone', kind: 'builtin' });
    channel!.onmessage({ pcm: btoa(String.fromCharCode(0x00, 0x40, 0x00, 0xc0)) });
    expect(Array.from(posted[0])).toEqual([16384, -16384]);
    mic.close();
    // After close, late chunks are ignored.
    channel!.onmessage({ pcm: btoa('\x01\x00') });
    expect(posted).toHaveLength(1);
  });

  it('reports a permission refusal as NotAllowedError (the mic UI says so)', async () => {
    const { ctx } = fakeCtx();
    // Tauri rejects with a plain string.
    invoke.mockImplementation(async () => { throw 'Microphone permission denied'; });
    let err: unknown = null;
    try {
      await new AndroidNativeMic().open(ctx, { avoidBluetooth: true });
    } catch (e) {
      err = e;
    }
    expect((err as Error).name).toBe('NotAllowedError');
  });

  it('decodes little-endian PCM16', () => {
    expect(Array.from(base64ToInt16(btoa('\xff\x7f\x00\x80')))).toEqual([32767, -32768]);
  });
});
