import { describe, expect, it } from 'vitest';
import { TONES, toneDuration } from '../chime';

describe('signature earcon', () => {
  const freqs = (k: keyof typeof TONES) => TONES[k].map((n) => Math.round(n.freq));

  it('blocked and finished share the G-C-E motif (rising vs falling)', () => {
    expect(freqs('blocked').slice(0, 3)).toEqual([784, 1047, 1319]);
    expect(freqs('finished')).toEqual([1319, 1047, 784]);
  });

  it('blocked is more insistent than finished: extra struck note and more energy', () => {
    const energy = (k: keyof typeof TONES) => TONES[k].reduce((a, n) => a + n.gain * n.dur, 0);
    expect(TONES.blocked.length).toBeGreaterThan(TONES.finished.length);
    expect(Math.max(...TONES.blocked.map((n) => n.gain))).toBeGreaterThan(Math.max(...TONES.finished.map((n) => n.gain)));
    expect(energy('blocked')).toBeGreaterThan(energy('finished'));
  });

  it('every tone is short (well under a second and a half)', () => {
    for (const k of Object.keys(TONES) as Array<keyof typeof TONES>) expect(toneDuration(k)).toBeLessThan(1.5);
  });

  it('risk: two rising notes then a short off-motif third, softer than blocked', () => {
    const r = TONES.risk;
    expect(r).toHaveLength(3);
    expect(r[1].freq).toBeGreaterThan(r[0].freq);
    expect(r[2].freq).toBeLessThan(r[1].freq);
    expect(r[2].freq).toBeGreaterThan(r[0].freq);
    expect(r[2].dur).toBeLessThan(r[1].dur);
    const peak = (k: 'risk' | 'blocked') => Math.max(...TONES[k].map((n) => n.gain));
    expect(peak('risk')).toBeLessThan(peak('blocked'));
  });
});
