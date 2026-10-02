import { describe, expect, it } from 'vitest';
import { computeIntraline, pairBlocks, wordDiff, INTRALINE_MAX_LINE_CHARS, INTRALINE_MAX_HUNK_LINES } from '../intraline';

const text = (line: string, ranges: Array<{ start: number; end: number }> | undefined) =>
  (ranges ?? []).map((r) => line.slice(1).slice(r.start, r.end));

describe('intraline', () => {
  it('pairs each - block with the + block that follows it', () => {
    const lines = [' a', '-b', '-c', '+B', ' d', '-e', ' f', '+g'];
    expect(pairBlocks(lines)).toEqual([{ removed: [1, 2], added: [3] }]);
  });

  it('marks only the changed words', () => {
    const lines = ['-  const window = recent.slice(-3);', '+  const window = recent.slice(-5);'];
    const m = computeIntraline(lines);
    expect(text(lines[0], m.get(0))).toEqual(['3']);
    expect(text(lines[1], m.get(1))).toEqual(['5']);
  });

  it('aligns lines by similarity so an inserted line does not shift pairings', () => {
    const lines = [
      '-  const window = recent.slice(-3);',
      '-  return window.some((r) => similarity(r, norm) > 0.8);',
      '+  // Compare against the last five utterances.',
      '+  const window = recent.slice(-5);',
      '+  return window.some((r) => similarity(r, norm) > threshold);',
    ];
    const m = computeIntraline(lines);
    expect(m.has(2)).toBe(false);
    expect(text(lines[3], m.get(3))).toEqual(['5']);
    expect(text(lines[4], m.get(4))).toEqual(['threshold']);
  });

  it('skips pairs that are rewrites, not edits', () => {
    const lines = ['-alpha beta gamma delta', '+totally unrelated words here'];
    expect(wordDiff('alpha beta gamma delta', 'totally unrelated words here').similarity).toBeLessThan(0.3);
    expect(computeIntraline(lines).size).toBe(0);
  });

  it('skips lines over the length cap', () => {
    const long = 'x'.repeat(INTRALINE_MAX_LINE_CHARS + 1);
    expect(computeIntraline([`-${long}a`, `+${long}b`]).size).toBe(0);
  });

  it('skips hunks over the line cap', () => {
    const lines = Array.from({ length: INTRALINE_MAX_HUNK_LINES + 1 }, (_, i) => (i % 2 ? '+foo 2' : '-foo 1'));
    expect(computeIntraline(lines).size).toBe(0);
  });
});
