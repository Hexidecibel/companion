import { describe, expect, it } from 'vitest';
import { highlightHunk, languageForPath, mergeMarks, splitHtmlLines } from '../highlight';

describe('splitHtmlLines', () => {
  it('closes and reopens spans across newlines', () => {
    const html = 'a <span class="hljs-comment">/* one\ntwo */</span> b\n<span class="hljs-string">&quot;x&quot;</span>';
    const lines = splitHtmlLines(html);
    expect(lines).toEqual([
      [{ text: 'a ' }, { text: '/* one', cls: 'hljs-comment' }],
      [{ text: 'two */', cls: 'hljs-comment' }, { text: ' b' }],
      [{ text: '"x"', cls: 'hljs-string' }],
    ]);
  });

  it('keeps nested classes in the stack', () => {
    const lines = splitHtmlLines('<span class="a">x<span class="b">y\nz</span></span>');
    expect(lines).toEqual([[{ text: 'x', cls: 'a' }, { text: 'y', cls: 'a b' }], [{ text: 'z', cls: 'a b' }]]);
  });
});

describe('mergeMarks', () => {
  it('splits segments at range edges across segment boundaries', () => {
    const segs = [{ text: 'const ', cls: 'k' }, { text: 'x = 1;' }];
    expect(mergeMarks(segs, [{ start: 4, end: 7 }])).toEqual([
      { text: 'cons', cls: 'k' },
      { text: 't ', cls: 'k', mark: true },
      { text: 'x', mark: true },
      { text: ' = 1;' },
    ]);
  });
});

describe('highlightHunk', () => {
  it('maps both sides back onto hunk lines and merges word marks', () => {
    const lines = [' const a = 1;', '-const b = 2;', '+const b = 3;'];
    const out = highlightHunk(lines, 'x.ts', new Map([[1, [{ start: 10, end: 11 }]], [2, [{ start: 10, end: 11 }]]]));
    expect(out).toHaveLength(3);
    expect(out.map((l) => l.map((s) => s.text).join(''))).toEqual(['const a = 1;', 'const b = 2;', 'const b = 3;']);
    expect(out[0][0].cls).toContain('hljs-keyword');
    expect(out[1].find((s) => s.mark)?.text).toBe('2');
    expect(out[2].find((s) => s.mark)?.text).toBe('3');
  });

  it('falls back to plain segments for unknown languages', () => {
    expect(languageForPath('notes.xyz')).toBeNull();
    expect(highlightHunk(['+hello'], 'notes.xyz')).toEqual([[{ text: 'hello' }]]);
  });
});
