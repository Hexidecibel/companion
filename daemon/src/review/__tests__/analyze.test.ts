import { isWhitespaceOnly, trivialKind, heatScore, gitHunkId } from '../analyze';

describe('analyze', () => {
  it('whitespace-only hunks', () => {
    expect(isWhitespaceOnly([{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-  a = 1;', '+a  =  1;'] }])).toBe(true);
    expect(isWhitespaceOnly([{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a = 1;', '+a = 2;'] }])).toBe(false);
    expect(isWhitespaceOnly([])).toBe(false);
  });

  it('lockfile and generated are trivial', () => {
    expect(trivialKind('web/package-lock.json', null)).toBe('lockfile');
    expect(trivialKind('dist/index.js', null)).toBe('generated');
    expect(trivialKind('src/__snapshots__/a.snap', null)).toBe('generated');
    expect(trivialKind('src/app.min.js', null)).toBe('generated');
    expect(trivialKind('src/a.ts', null)).toBeUndefined();
  });

  it('heat orders risky, churny, recent files first', () => {
    const now = 1_000_000_000;
    const risky = heatScore(10, 1, 'high', now - 60_000, now);
    const big = heatScore(400, 3, null, now - 3_600_000, now);
    const small = heatScore(2, 1, null, now - 3_600_000, now);
    expect(risky).toBeGreaterThan(small);
    expect(big).toBeGreaterThan(small);
    expect(heatScore(100000, 10, 'high', now, now)).toBe(100);
    expect(small).toBeGreaterThanOrEqual(0);
  });

  it('git hunk ids are stable and content-addressed', () => {
    const h = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] };
    expect(gitHunkId('/p/a', h)).toBe(gitHunkId('/p/a', { ...h }));
    expect(gitHunkId('/p/a', h)).not.toBe(gitHunkId('/p/b', h));
    expect(gitHunkId('/p/a', h)).toMatch(/^g[0-9a-z]+$/);
  });
});
