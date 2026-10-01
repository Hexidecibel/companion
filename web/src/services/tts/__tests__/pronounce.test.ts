import { afterEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_PRONUNCIATIONS,
  MAX_PRONUNCIATIONS,
  applyPronunciations,
  getUserPronunciations,
  numberToWords,
  sanitizePronunciations,
  setUserPronunciations,
  speakVersion,
} from '../pronounce';
import { normalizeForSpeech } from '../speechText';

const p = (s: string) => applyPronunciations(s, []);

afterEach(() => setUserPronunciations([]));

describe('numberToWords', () => {
  it.each([
    [0, 'zero'], [7, 'seven'], [13, 'thirteen'], [20, 'twenty'], [28, 'twenty-eight'], [99, 'ninety-nine'],
    [100, 'one hundred'], [105, 'one hundred five'], [342, 'three hundred forty-two'], [2026, 'two thousand twenty-six'],
    [999_999, 'nine hundred ninety-nine thousand nine hundred ninety-nine'],
  ])('%d -> %s', (n, w) => {
    expect(numberToWords(n)).toBe(w);
  });

  it('out of range or not an integer: digits as-is', () => {
    expect(numberToWords(1_000_000)).toBe('1000000');
    expect(numberToWords(-1)).toBe('-1');
    expect(numberToWords(1.5)).toBe('1.5');
  });
});

describe('versions', () => {
  it.each([
    ['v2.28.0', 'version two point twenty-eight'],
    ['2.0.7', 'two point oh point seven'],
    ['v2.0.7', 'version two point oh point seven'],
    ['v1.2', 'version one point two'],
    ['V3.12', 'version three point twelve'],
    ['v10.4.1', 'version ten point four point one'],
    ['2.0.0', 'two point oh'],
    ['1.07.3', 'one point oh seven point three'],
    ['v1.2.3.4', 'version one point two point three point four'],
  ])('%s -> %s', (raw, said) => {
    expect(p(raw)).toBe(said);
  });

  it('in a sentence, with sentence punctuation after it', () => {
    expect(p('Released v2.28.0.')).toBe('Released version two point twenty-eight.');
    expect(p('Bumped to 2.0.7, then tagged.')).toBe('Bumped to two point oh point seven, then tagged.');
    expect(p('Is 2.0.7 out?')).toBe('Is two point oh point seven out?');
    expect(p('(v2.1.0)')).toBe('(version two point one)');
  });

  it('never says "version version"', () => {
    expect(p('Version v2.28.0 is live')).toBe('Version two point twenty-eight is live');
    expect(p('version 2.0.7 is live')).toBe('version two point oh point seven is live');
  });

  it('leaves decimals, IPs, ports, paths and hashes alone', () => {
    expect(p('Coverage is 93.5 percent')).toBe('Coverage is 93.5 percent');
    expect(p('Python 3.12 is fine')).toBe('Python 3.12 is fine');
    expect(p('Ping 192.168.1.17 first')).toBe('Ping 192.168.1.17 first');
    expect(p('Listening on 10.0.0.1:9877')).toBe('Listening on 10.0.0.1:9877');
    expect(p('see lib/2.0.7/x')).toBe('see lib/2.0.7/x');
    expect(p('build-2.0.7 failed')).toBe('build-2.0.7 failed');
    expect(p('a.2.0.7 b')).toBe('a.2.0.7 b');
    expect(p('1.2.3.4.5')).toBe('1.2.3.4.5');
  });

  it('speakVersion drops only a trailing patch zero', () => {
    expect(speakVersion('2.28.0')).toBe('two point twenty-eight');
    expect(speakVersion('2.0')).toBe('two point oh');
    expect(speakVersion('0.9.0')).toBe('oh point nine');
  });
});

describe('words with digits glued on', () => {
  it.each([
    ['Out4 finished', 'Out four finished'],
    ['Out42 is blocked', 'Out forty-two is blocked'],
    ['the base64 blob', 'the base sixty-four blob'],
    ['UTF8 only', 'UTF eight only'],
    ['py311 venv', 'py 311 venv'],
    ['phase07 starts', 'phase 07 starts'],
  ])('%s -> %s', (raw, said) => {
    expect(p(raw)).toBe(said);
  });

  it('leaves single letters, numbers-first, hashes and long numbers alone', () => {
    expect(p('x86 build')).toBe('x86 build');
    expect(p('the 4K screen')).toBe('the 4K screen');
    expect(p('commit a2ce9a5 landed')).toBe('commit a2ce9a5 landed');
    expect(p('ES2015 syntax')).toBe('ES2015 syntax');
    expect(p('100ms later')).toBe('100ms later');
  });
});

describe('acronyms and jargon', () => {
  it.each([
    ['Built the APK.', 'Built the A-P-K.'],
    ['Two APKs signed', "Two A-P-K's signed"],
    ['The AUQ is open', 'The A-U-Q is open'],
    ['Restart tmux', 'Restart tee-mux'],
    ['Restart Tmux now', 'Restart tee-mux now'],
    ['Reload HAProxy', 'Reload H.A. proxy'],
    ['Open a PR', 'Open a P-R'],
    ['Three PRs open', "Three P-R's open"],
    ['CI is green', 'C-I is green'],
    ['The CLI and UI', 'The C-L-I and U-I'],
  ])('%s -> %s', (raw, said) => {
    expect(p(raw)).toBe(said);
  });

  it('only whole words, and acronyms only in caps', () => {
    expect(p('PRINT the CIRCLE of APKINFO')).toBe('PRINT the CIRCLE of APKINFO');
    expect(p('the pr and ci folders')).toBe('the pr and ci folders');
    expect(p('tmuxinator')).toBe('tmuxinator');
  });

  it('every built-in entry changes its own word', () => {
    for (const b of BUILTIN_PRONUNCIATIONS) expect(p(`x ${b.from} y`)).toBe(`x ${b.to} y`);
  });
});

describe('the user list', () => {
  it('whole words, any case, wins over the built-ins', () => {
    const user = [{ from: 'k8s', to: 'kates' }, { from: 'PR', to: 'pull request' }];
    expect(applyPronunciations('Deploy K8s and open a PR', user)).toBe('Deploy kates and open a pull request');
  });

  it('a user replacement is not re-processed by the built-ins', () => {
    expect(applyPronunciations('ship Out4', [{ from: 'Out4', to: 'Out4 the app' }])).toBe('ship Out4 the app');
  });

  it('multi-word entries and symbols; the longest entry wins', () => {
    const user = [{ from: 'Doc', to: 'dock' }, { from: 'Doc Upload Site', to: 'the uploader' }, { from: 'C++', to: 'C plus plus' }];
    expect(applyPronunciations('Doc Upload Site and Doc in C++.', user)).toBe('the uploader and dock in C plus plus.');
  });

  it('setUserPronunciations feeds normalizeForSpeech', () => {
    setUserPronunciations([{ from: 'Kokoro', to: 'ko-ko-ro' }]);
    expect(normalizeForSpeech('**Kokoro** is up')).toBe('ko-ko-ro is up');
    expect(getUserPronunciations()).toEqual([{ from: 'Kokoro', to: 'ko-ko-ro' }]);
    setUserPronunciations(null);
    expect(normalizeForSpeech('Kokoro is up')).toBe('Kokoro is up');
  });

  it('sanitizePronunciations trims, bounds, drops blanks and duplicates (last wins)', () => {
    const raw = [
      { from: '  Out4 ', to: ' Out for ' },
      { from: '', to: 'x' },
      { from: 'y', to: '   ' },
      { from: '...', to: 'dots' },
      { from: 'out4', to: 'Out four' },
      'junk',
      null,
      { from: 1, to: 'x' },
      { from: 'a'.repeat(100), to: 'b'.repeat(200) },
    ];
    const clean = sanitizePronunciations(raw);
    expect(clean).toEqual([
      { from: 'out4', to: 'Out four' },
      { from: 'a'.repeat(40), to: 'b'.repeat(80) },
    ]);
    expect(sanitizePronunciations('nope')).toEqual([]);
    const many = Array.from({ length: 80 }, (_, i) => ({ from: `w${i}x`, to: 'y' }));
    expect(sanitizePronunciations(many)).toHaveLength(MAX_PRONUNCIATIONS);
  });
});

describe('through the whole speech normaliser', () => {
  it.each([
    ['**Out4** shipped `v2.28.0` to prod.', 'Out four shipped version two point twenty-eight to prod.'],
    ['Install the APK (2.0.7) via `tmux`.', 'Install the A-P-K (two point oh point seven) via tee-mux.'],
    ['PR #42 -> merged, CI green', 'P-R number 42 to merged, C-I green'],
    ['Answer the AUQ on Out4.', 'Answer the A-U-Q on Out four.'],
  ])('%s', (raw, said) => {
    expect(normalizeForSpeech(raw)).toBe(said);
  });
});
