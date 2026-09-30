import { describe, expect, it, vi } from 'vitest';
import { LOOP_MAX_SENDS, LOOP_WINDOW_MS, VoiceLoopBreaker } from '../voiceLoopBreaker';

function clock(start = 500_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('VoiceLoopBreaker', () => {
  it('pauses on the 4th hands-off send within 20 s (the production loop: 3-6 s apart)', () => {
    const c = clock();
    const b = new VoiceLoopBreaker(c.now);
    const onPause = vi.fn();
    b.subscribe(onPause);
    for (let i = 0; i < LOOP_MAX_SENDS; i++) {
      expect(b.allowSend()).toBe(true);
      c.advance(4000);
    }
    expect(b.allowSend()).toBe(false);
    expect(b.paused).toBe(true);
    expect(onPause).toHaveBeenCalledWith(true);
    c.advance(60_000);
    expect(b.allowSend()).toBe(false); // stays paused until a person shows up
  });

  it('any interaction resets the count and resumes', () => {
    const c = clock();
    const b = new VoiceLoopBreaker(c.now);
    b.allowSend();
    b.allowSend();
    b.allowSend();
    b.noteInteraction();
    expect(b.allowSend()).toBe(true);
    b.allowSend();
    b.allowSend();
    expect(b.allowSend()).toBe(false);
    b.resume();
    expect(b.paused).toBe(false);
    expect(b.allowSend()).toBe(true);
  });

  it('slow conversation never trips it', () => {
    const c = clock();
    const b = new VoiceLoopBreaker(c.now);
    for (let i = 0; i < 20; i++) {
      expect(b.allowSend()).toBe(true);
      c.advance(LOOP_WINDOW_MS / 3 + 1);
    }
  });
});
