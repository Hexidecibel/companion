import { describe, expect, it, vi } from 'vitest';
import { ECHO_WINDOW_MS, SHORT_ECHO_WINDOW_MS, SpokenLog, recordingEngine } from '../echoGuard';
import type { TtsEngine, TtsEvent } from '../../tts/types';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('SpokenLog', () => {
  it('drops what Herald just said, in the real distorted form', () => {
    const c = clock();
    const log = new SpokenLog(c.now);
    log.setSpeaking(true);
    log.record('Doc Upload Site shipped v2.28.0 to supdox.com.');
    c.advance(3000);
    expect(log.isEcho('Doc Upload Site, shift V2.')).toBe(true);
    log.setSpeaking(false);
    c.advance(2000);
    expect(log.isEcho('Doc Upload')).toBe(true);
    expect(log.isEcho('wait tell Out4 to hold')).toBe(false);
    expect(log.isEcho('stop')).toBe(false);
  });

  it('forgets after the window (a long reply counts from its first sentence)', () => {
    const c = clock();
    const log = new SpokenLog(c.now);
    log.setSpeaking(true);
    log.record('Doc Upload Site shipped v2.28.0.');
    c.advance(ECHO_WINDOW_MS + 5000);
    log.record('And the billing session is still waiting on you.');
    // Still the same utterance: its first sentence still counts.
    expect(log.isEcho('Doc upload site shipped')).toBe(true);
    log.setSpeaking(false);
    c.advance(ECHO_WINDOW_MS + 1);
    expect(log.isEcho('Doc upload site shipped')).toBe(false);
    expect(log.recent()).toEqual([]);
  });

  it('a pause between sentences is the same utterance; a stop keeps it for the window', () => {
    const c = clock();
    const log = new SpokenLog(c.now);
    log.record('Doc Upload Site shipped v2.28.0 to supdox.com, and all the deploy checks passed on the first try.');
    log.setSpeaking(true);
    c.advance(9000);
    log.setSpeaking(false); // next sentence still being synthesised
    log.record('The billing session is still waiting on you to pick an option.');
    c.advance(800);
    log.setSpeaking(true);
    c.advance(3000);
    // Straddles both sentences; the first was queued 12.8 s ago.
    expect(log.isEcho('On the first try, the billing session.')).toBe(true);
    log.setSpeaking(false);
    c.advance(ECHO_WINDOW_MS - 1000);
    expect(log.isEcho('all the deploy checks passed')).toBe(true);
    c.advance(2000);
    expect(log.isEcho('all the deploy checks passed')).toBe(false);
  });

  it('one or two words only count as echo while (or right after) Herald talks', () => {
    const c = clock();
    const log = new SpokenLog(c.now);
    log.setSpeaking(true);
    log.record('Hi, I am Herald.');
    expect(log.isEcho('Hi.')).toBe(true);
    log.setSpeaking(false);
    c.advance(SHORT_ECHO_WINDOW_MS - 100);
    expect(log.isEcho('Hi.')).toBe(true);
    c.advance(200);
    expect(log.isEcho('Hi.')).toBe(false); // an answer, not an echo
    expect(log.isEcho('Hi, I am Herald')).toBe(true); // long: still within the window
  });

  it('minTokens exempts short deliberate captures', () => {
    const c = clock();
    const log = new SpokenLog(c.now);
    log.setSpeaking(true);
    log.record('Should I restart it, yes or no?');
    expect(log.isEcho('yes', { minTokens: 3 })).toBe(false);
    expect(log.isEcho('should I restart it yes or no', { minTokens: 3 })).toBe(true);
  });

  it('nothing said: nothing is echo', () => {
    const log = new SpokenLog(clock().now);
    expect(log.isEcho('Doc Upload')).toBe(false);
  });
});

describe('recordingEngine', () => {
  it('records every sentence and the speaking state, passing everything through', () => {
    let listener: ((e: TtsEvent) => void) | null = null;
    const inner: TtsEngine = {
      id: 'fake', available: true, speaking: false,
      speak: vi.fn(), cancel: vi.fn(), getVoices: () => [], unlock: vi.fn(),
      on: (l) => { listener = l; return () => {}; }, dispose: vi.fn(),
    };
    const c = clock();
    const log = new SpokenLog(c.now);
    const eng = recordingEngine(inner, log);
    eng.speak('Doc Upload Site shipped.', { rate: 1 });
    expect(inner.speak).toHaveBeenCalledWith('Doc Upload Site shipped.', { rate: 1 });
    listener!({ type: 'speaking', speaking: true });
    expect(log.isSpeaking).toBe(true);
    eng.cancel();
    expect(inner.cancel).toHaveBeenCalled();
    expect(eng.id).toBe('fake');
    expect(log.isEcho('doc upload site')).toBe(true);
  });
});
