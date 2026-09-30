import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FRAME_SAMPLES, Framer, Resampler16k, float32ToInt16Frames, floatToInt16, int16ToBase64, meterLevel, rms16 } from '../pcm';
import { DEFAULT_CHORD, chordFromEvent, formatChord, isChordRelease, matchesChordDown, parseChord, shouldStartSpacePtt } from '../hotkeys';
import { VoiceUplink } from '../voiceUplink';
import { MIN_HOLD_MS, VoiceInputController, type MicLike } from '../voiceInput';
import { MicError, type MicFrame } from '../micCapture';
import type { HeraldTransport } from '../../heraldTransport';
import type { WebSocketResponse } from '../../../types';

function decode(b64: string): Int16Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

describe('PCM framing', () => {
  it('downsamples 48 kHz to 16 kHz seamlessly across arbitrary chunk sizes', () => {
    const r1 = new Resampler16k(48000);
    const r2 = new Resampler16k(48000);
    const input = Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i / 20));
    const whole = r1.process(input);
    const parts: number[] = [];
    for (let i = 0; i < input.length; i += 128) parts.push(...r2.process(input.subarray(i, i + 128)));
    expect(whole.length).toBe(1600);
    expect(parts.length).toBe(1600);
    parts.forEach((v, i) => expect(v).toBeCloseTo(whole[i], 6));
    // box average of 3
    expect(whole[0]).toBeCloseTo((input[0] + input[1] + input[2]) / 3, 6);
  });

  it('handles non-integer ratios (44.1 kHz) without drift', () => {
    const r = new Resampler16k(44100);
    let out = 0;
    for (let i = 0; i < 441; i++) out += r.process(new Float32Array(100)).length; // 1 s
    expect(Math.abs(out - 16000)).toBeLessThanOrEqual(1);
  });

  it('frames into exact 100 ms chunks and keeps the partial', () => {
    const f = new Framer();
    expect(f.push(new Int16Array(1000))).toHaveLength(0);
    const frames = f.push(new Int16Array(2500));
    expect(frames).toHaveLength(2);
    expect(frames.every((x) => x.length === FRAME_SAMPLES)).toBe(true);
    expect(f.flush().length).toBe(300);
    expect(f.flush().length).toBe(0);
  });

  it('clamps and converts float to PCM16, and round-trips base64 little-endian', () => {
    const pcm = floatToInt16(Float32Array.from([0, 1, -1, 2, -2, 0.5]));
    expect(Array.from(pcm)).toEqual([0, 32767, -32768, 32767, -32768, 16384]);
    expect(Array.from(decode(int16ToBase64(pcm)))).toEqual(Array.from(pcm));
    const frames = float32ToInt16Frames(new Float32Array(3300));
    expect(frames.map((x) => x.length)).toEqual([1600, 1600, 100]);
  });

  it('level meter is 0 in silence and saturates on loud input', () => {
    expect(rms16(new Int16Array(10))).toBe(0);
    expect(meterLevel(0)).toBe(0);
    expect(meterLevel(rms16(new Int16Array(10).fill(30000)))).toBe(1);
    expect(meterLevel(0.01)).toBeGreaterThan(0);
  });
});

const key = (code: string, mods: Partial<Record<'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'repeat', boolean>> = {}) => ({
  code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, repeat: false, ...mods,
});

describe('push-to-talk hotkeys never interfere with typing', () => {
  it('Space talks only in an empty composer, without modifiers or repeat', () => {
    const ctx = { enabled: true, composerEmpty: true };
    expect(shouldStartSpacePtt(key('Space'), ctx)).toBe(true);
    expect(shouldStartSpacePtt(key('Space'), { ...ctx, composerEmpty: false })).toBe(false);
    expect(shouldStartSpacePtt(key('Space'), { ...ctx, enabled: false })).toBe(false);
    expect(shouldStartSpacePtt(key('Space'), { ...ctx, isComposing: true })).toBe(false);
    expect(shouldStartSpacePtt(key('Space', { repeat: true }), ctx)).toBe(false);
    expect(shouldStartSpacePtt(key('Space', { shiftKey: true }), ctx)).toBe(false);
    expect(shouldStartSpacePtt(key('KeyA'), ctx)).toBe(false);
  });

  it('the global chord matches exactly', () => {
    const c = parseChord(DEFAULT_CHORD)!;
    expect(matchesChordDown(key('Space', { ctrlKey: true, shiftKey: true }), c)).toBe(true);
    expect(matchesChordDown(key('Space'), c)).toBe(false); // plain space typing
    expect(matchesChordDown(key('Space', { shiftKey: true }), c)).toBe(false);
    expect(matchesChordDown(key('Space', { ctrlKey: true }), c)).toBe(false);
    expect(matchesChordDown(key('Space', { ctrlKey: true, shiftKey: true, altKey: true }), c)).toBe(false);
    expect(matchesChordDown(key('KeyJ', { ctrlKey: true }), c)).toBe(false); // Ctrl+J still toggles the panel
    expect(isChordRelease({ code: 'Space' }, c)).toBe(true);
    expect(isChordRelease({ code: 'ShiftLeft' }, c)).toBe(true);
    expect(isChordRelease({ code: 'KeyA' }, c)).toBe(false);
  });

  it('refuses chords that would hijack typing, and round-trips labels', () => {
    expect(parseChord('Space')).toBeNull();
    expect(parseChord('Shift+A')).toBeNull();
    expect(parseChord('Ctrl+Shift+Space')).toEqual({ ctrl: true, shift: true, alt: false, meta: false, code: 'Space' });
    expect(formatChord(parseChord('alt+v')!)).toBe('Alt+V');
    expect(chordFromEvent(key('ShiftLeft', { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(chordFromEvent(key('KeyA'))).toBeNull();
    expect(formatChord(chordFromEvent(key('KeyM', { altKey: true }))!)).toBe('Alt+M');
  });
});

function fakeTransport(overrides: Partial<Record<string, (p: unknown) => WebSocketResponse | Promise<WebSocketResponse>>> = {}) {
  const fired: Array<{ type: string; payload: any }> = [];
  const requests: Array<{ type: string; payload: any }> = [];
  const t: HeraldTransport = {
    isConnected: () => true,
    request: async (type, payload) => {
      requests.push({ type, payload });
      const h = overrides[type];
      if (h) return h(payload);
      if (type === 'herald_voice_stream_end') return { type, success: true, payload: { text: 'hello there', audioMs: 1000, sttMs: 300, woke: false } };
      return { type, success: true, payload: { ok: true } };
    },
    onEvent: () => () => {},
    onConnectivity: () => () => {},
    fire: (type, payload) => {
      fired.push({ type, payload });
      return true;
    },
  };
  return { t, fired, requests };
}

describe('VoiceUplink', () => {
  it('opens, streams sequenced base64 chunks, and transcribes', async () => {
    const { t, fired, requests } = fakeTransport();
    const up = new VoiceUplink(t, 'stt');
    up.push(new Int16Array([1, 2, 3]));
    up.push(new Int16Array([4]));
    const res = await up.finish('transcribe');
    expect(requests[0]).toEqual({ type: 'herald_voice_stream_start', payload: { streamId: up.streamId, purpose: 'stt', sampleRate: 16000 } });
    expect(fired.map((f) => f.payload.seq)).toEqual([0, 1]);
    expect(Array.from(decode(fired[0].payload.pcm))).toEqual([1, 2, 3]);
    expect(requests[1]).toEqual({ type: 'herald_voice_stream_end', payload: { streamId: up.streamId, action: 'transcribe' } });
    expect(res.text).toBe('hello there');
    up.push(new Int16Array([9])); // after finish: dropped
    expect(fired).toHaveLength(2);
  });

  it('surfaces the daemon error code (service down)', async () => {
    const { t } = fakeTransport({
      herald_voice_stream_end: () => ({ type: 'x', success: false, error: 'Voice service unavailable', payload: { code: 'unavailable' } }),
    });
    const up = new VoiceUplink(t, 'stt');
    await expect(up.finish('transcribe')).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('a timed-out request becomes a timeout error, not a hang', async () => {
    const { t } = fakeTransport({ herald_voice_stream_end: () => Promise.reject(new Error('Request timeout')) });
    const up = new VoiceUplink(t, 'stt');
    await expect(up.finish('transcribe')).rejects.toMatchObject({ code: 'timeout' });
  });
});

function fakeMic(opts: { fail?: MicError; delay?: number } = {}) {
  let onFrame: ((f: MicFrame) => void) | null = null;
  const mic: MicLike & { emit: (n: number) => void; stops: number } = {
    permission: 'granted',
    stops: 0,
    start: async (cb) => {
      if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
      if (opts.fail) {
        mic.permission = opts.fail.permission;
        throw opts.fail;
      }
      onFrame = cb;
    },
    stop: () => {
      mic.stops++;
      onFrame = null;
    },
    emit: (n) => onFrame?.({ pcm: new Int16Array(n).fill(1000), level: 0.05 }),
  };
  return mic;
}

describe('VoiceInputController (push-to-talk)', () => {
  let now = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    now = 1000;
  });
  afterEach(() => vi.useRealTimers());

  function setup(mic = fakeMic(), transport = fakeTransport()) {
    const onTranscript = vi.fn();
    const onBargeIn = vi.fn();
    const c = new VoiceInputController({ mic, getTransport: () => transport.t, onTranscript, onBargeIn, now: () => now });
    return { c, mic, onTranscript, onBargeIn, ...transport };
  }

  it('hold -> speak -> release sends the transcript and barges in on Herald', async () => {
    const { c, mic, onTranscript, onBargeIn, fired } = setup();
    await c.start('button');
    expect(onBargeIn).toHaveBeenCalled();
    expect(c.state.phase).toBe('listening');
    mic.emit(1600);
    mic.emit(1600);
    expect(c.state.level).toBeGreaterThan(0);
    now += 1500;
    const p = c.stop();
    expect(c.state.phase).toBe('transcribing');
    await vi.advanceTimersByTimeAsync(100);
    await p;
    expect(fired).toHaveLength(2);
    expect(onTranscript).toHaveBeenCalledWith('hello there', 'button');
    expect(c.state.phase).toBe('idle');
    expect(mic.stops).toBe(1);
  });

  it('an accidental tap is discarded with a hint', async () => {
    const { c, onTranscript, requests } = setup();
    await c.start('space');
    now += MIN_HOLD_MS - 50;
    await c.stop();
    expect(onTranscript).not.toHaveBeenCalled();
    expect(c.state.error).toMatch(/Hold to talk/);
    await vi.advanceTimersByTimeAsync(10);
    expect(requests.find((r) => r.type === 'herald_voice_stream_end')?.payload.action).toBe('discard');
  });

  it('release before the mic opens still transcribes once it does', async () => {
    const { c, mic, onTranscript } = setup(fakeMic({ delay: 50 }));
    const started = c.start('chord');
    now += 400;
    await c.stop(); // while "starting"
    expect(c.state.phase).toBe('starting');
    mic.emit(1600);
    await vi.advanceTimersByTimeAsync(60);
    await started;
    await vi.advanceTimersByTimeAsync(200);
    expect(onTranscript).toHaveBeenCalledWith('hello there', 'chord');
  });

  it('permission denied is reported and leaves the controller idle', async () => {
    const { c } = setup(fakeMic({ fail: new MicError('Microphone permission denied.', 'denied') }));
    await c.start('button');
    expect(c.state.phase).toBe('idle');
    expect(c.state.permission).toBe('denied');
    expect(c.state.error).toMatch(/denied/);
  });

  it('voice service down -> clear unavailable message, no transcript', async () => {
    const { c, onTranscript } = setup(fakeMic(), fakeTransport({
      herald_voice_stream_end: () => ({ type: 'x', success: false, error: 'down', payload: { code: 'unavailable' } }),
    }));
    await c.start('button');
    now += 1000;
    const p = c.stop();
    await vi.advanceTimersByTimeAsync(100);
    await p;
    expect(onTranscript).not.toHaveBeenCalled();
    expect(c.state.error).toMatch(/unavailable/);
  });

  it('cancel drops the utterance', async () => {
    const { c, onTranscript, requests } = setup();
    await c.start('button');
    c.cancel();
    await vi.advanceTimersByTimeAsync(10);
    expect(c.state.phase).toBe('idle');
    expect(onTranscript).not.toHaveBeenCalled();
    expect(requests.find((r) => r.type === 'herald_voice_stream_end')?.payload.action).toBe('discard');
  });
});
