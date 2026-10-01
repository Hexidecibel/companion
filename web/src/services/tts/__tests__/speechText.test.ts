import { describe, it, expect } from 'vitest';
import { SentenceChunker, chunkText, findSentenceEnd, isSpeakable, normalizeForSpeech } from '../speechText';

describe('SentenceChunker', () => {
  it('emits sentences as soon as they complete across deltas', () => {
    const c = new SentenceChunker();
    expect(c.push('Two sessions fin')).toEqual([]);
    expect(c.push('ished. One is ')).toEqual(['Two sessions finished.']);
    expect(c.push('blocked! Want')).toEqual(['One is blocked!']);
    expect(c.push(' details?')).toEqual([]); // no trailing space yet: might continue
    expect(c.flush()).toEqual(['Want details?']);
    expect(c.flush()).toEqual([]);
  });

  it('does not split decimals, versions, hosts, or abbreviations', () => {
    expect(chunkText('Coverage is 93.5 percent on v1.2 at example.com today. Next.')).toEqual([
      'Coverage is 93.5 percent on v1.2 at example.com today.',
      'Next.',
    ]);
    expect(chunkText('Ask Dr. Smith, e.g. about it. Done.')).toEqual(['Ask Dr. Smith, e.g. about it.', 'Done.']);
    expect(chunkText('It cost $412.82 total. Fine.')).toEqual(['It cost $412.82 total.', 'Fine.']);
  });

  it('splits on paragraph breaks and list items', () => {
    expect(chunkText('Here is the status:\n- api is done\n- web is blocked\n\nThat is all')).toEqual([
      'Here is the status:',
      '- api is done',
      '- web is blocked',
      'That is all',
    ]);
  });

  it('keeps closing quotes and brackets with the sentence', () => {
    expect(chunkText('He said "ship it." Then left.')).toEqual(['He said "ship it."', 'Then left.']);
  });

  it('breaks very long run-ons at a soft boundary', () => {
    const long = `${'word '.repeat(30)}and then, ${'more '.repeat(40)}end`;
    const chunks = chunkText(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const ch of chunks) expect(ch.length).toBeLessThanOrEqual(221);
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(long.replace(/\s+/g, ' '));
  });

  it('never splits inside a code fence', () => {
    expect(findSentenceEnd('```\nfoo. bar\n')).toBe(-1);
    expect(chunkText('Run this. ```\na. b\n``` Done.')).toEqual(['Run this.', '```\na. b\n``` Done.']);
  });
});

describe('normalizeForSpeech', () => {
  const n = normalizeForSpeech;

  it('strips markdown emphasis, headings, bullets and inline code', () => {
    expect(n('## Status\n**api** is _done_ and `npm test` passes')).toBe('Status. api is done and npm test passes');
    expect(n('- one\n- two')).toBe('one. two');
    expect(n('Use ~~old~~ new')).toBe('Use old new');
  });

  it('drops fenced code blocks entirely', () => {
    expect(n('Run:\n```bash\nnpm run build\n```\nthen reload.')).toBe('Run: then reload.');
    expect(n('Partial ```js\nconst x = 1')).toBe('Partial');
  });

  it('says where links go instead of spelling URLs', () => {
    expect(n('See https://github.com/foo/bar/pull/12 for details.')).toBe('See a link to github.com for details.');
    expect(n('Docs: www.example.org/x.')).toBe('Docs: a link to example.org.');
    expect(n('Read [the plan](https://x.io/plan).')).toBe('Read the plan.');
  });

  it('reads money naturally', () => {
    expect(n('Spend is $412.82 today.')).toBe('Spend is 412 dollars and 82 cents today.');
    expect(n('$1 and $1,200 and $3.50')).toBe('1 dollar and 1,200 dollars and 3 dollars and 50 cents');
    expect(n('Raised $2.5M.')).toBe('Raised 2.5 million dollars.');
    expect(n('Budget $5k')).toBe('Budget 5 thousand dollars');
  });

  it('reads keyboard chords', () => {
    expect(n('Press Cmd+J to open.')).toBe('Press Command J to open.');
    expect(n('Try Ctrl+Shift+P or Esc.')).toBe('Try Control Shift P or Escape.');
  });

  it('shortens paths and cleans symbols', () => {
    expect(n('Edited /home/hexi/src/web/App.tsx today')).toBe('Edited App.tsx today');
    expect(n('PR #42 -> merged')).toBe('P-R number 42 to merged');
    expect(n('api & web, ~5 min')).toBe('api and web, about 5 min');
    expect(n('rename user_id first')).toBe('rename user id first');
    expect(n('All green ✅🎉')).toBe('All green');
  });

  it('flags unspeakable leftovers', () => {
    expect(isSpeakable(n('```\ncode\n```'))).toBe(false);
    expect(isSpeakable(n('---'))).toBe(false);
    expect(isSpeakable(n('OK.'))).toBe(true);
  });
});
