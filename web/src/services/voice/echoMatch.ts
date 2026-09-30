/**
 * Self-echo matching: is a speech transcript most likely Herald's own voice,
 * picked up by the microphone from the speakers and transcribed?
 *
 * MIRRORED FILE: web/src/services/voice/echoMatch.ts and
 * daemon/src/herald/voice/echo-match.ts must stay byte-identical (enforced by
 * web/src/services/voice/__tests__/echoMatchMirror.test.ts). Pure, no imports.
 *
 * Whisper distorts what it hears through a speaker ("shipped v2.28.0" comes
 * back as "shift V2."), so words are compared by a coarse sound key (a
 * Soundex-like consonant skeleton), numbers are spelled out, and the transcript
 * only has to appear IN ORDER within what was spoken (a longest common
 * subsequence), not contiguously.
 */

export interface EchoMatchOptions {
  /** Fraction of transcript words that must be found in order (default 0.6). */
  threshold?: number;
  /** Transcripts with fewer content words than this are never called echo (default 1). */
  minTokens?: number;
}

export interface EchoScore {
  /** Content words in the transcript. */
  total: number;
  /** Of those, found in order in the spoken text. */
  matched: number;
  /** Transcript words not found (original spelling). */
  unmatched: string[];
}

export const ECHO_THRESHOLD = 0.6;

/** Words too common to count as evidence either way. */
const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'to',
  'of',
  'and',
  'or',
  'is',
  'it',
  'its',
  'in',
  'on',
  'at',
  'for',
  'i',
  'im',
  'be',
  'are',
  'was',
  'so',
  'uh',
  'um',
  'as',
  'by',
  'with',
]);

/**
 * Words a person says to cut Herald off. One of these in the transcript that
 * Herald did NOT say means a real person is talking (even over the echo).
 */
const INTERRUPT_WORDS = new Set([
  'stop',
  'wait',
  'hold',
  'pause',
  'cancel',
  'quiet',
  'shush',
  'shut',
  'enough',
  'hang',
  'nevermind',
]);

const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function numberWords(digits: string): string[] {
  const n = Number(digits);
  if (digits.length > 1 && digits.startsWith('0'))
    return digits.split('').map((d) => ONES[Number(d)]);
  if (!Number.isFinite(n) || n >= 1000) return digits.split('').map((d) => ONES[Number(d)]);
  const out: string[] = [];
  let rest = n;
  if (rest >= 100) {
    out.push(ONES[Math.floor(rest / 100)], 'hundred');
    rest %= 100;
    if (rest === 0) return out;
  }
  if (rest < 20) out.push(ONES[rest]);
  else {
    out.push(TENS[Math.floor(rest / 10)]);
    if (rest % 10) out.push(ONES[rest % 10]);
  }
  return out;
}

/** Lower-cased words, punctuation dropped, letter/digit runs split, numbers spelled out. */
export function echoWords(text: string): string[] {
  const s = text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/(\p{L})(\p{N})/gu, '$1 $2')
    .replace(/(\p{N})(\p{L})/gu, '$1 $2');
  const raw = s.match(/[\p{L}\p{N}]+/gu) ?? [];
  const out: string[] = [];
  for (const w of raw) {
    if (/^\d+$/.test(w)) out.push(...numberWords(w));
    else out.push(w);
  }
  return out;
}

const CODES: Record<string, string> = {
  b: '1',
  f: '1',
  p: '1',
  v: '1',
  c: '2',
  g: '2',
  j: '2',
  k: '2',
  q: '2',
  s: '2',
  x: '2',
  z: '2',
  d: '3',
  t: '3',
  l: '4',
  m: '5',
  n: '5',
  r: '6',
};

/**
 * Coarse sound key (Soundex-like): the first letter (after spelling
 * normalisation, all vowels as "A") plus the consonant skeleton by sound class,
 * so "shipped" and "shift", "site" and "sight" share a key.
 */
export function soundKey(word: string): string {
  let w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return word.toLowerCase();
  w = w
    .replace(/^(kn|gn|pn)/, 'n')
    .replace(/^wr/, 'r')
    .replace(/^wh/, 'w')
    .replace(/^x/, 's')
    .replace(/ph/g, 'f')
    .replace(/gh/g, '')
    .replace(/tch/g, 's')
    .replace(/sch/g, 'sk')
    .replace(/[sc]h/g, 's')
    .replace(/th/g, 't')
    .replace(/dg/g, 'j')
    .replace(/ck/g, 'k')
    .replace(/c(?=[eiy])/g, 's');
  if (!w) return 'H';
  const first = w[0];
  let key = /[aeiouy]/.test(first) ? 'A' : first.toUpperCase();
  let last = CODES[first] ?? '';
  for (let i = 1; i < w.length && key.length < 6; i++) {
    const c = CODES[w[i]];
    if (!c) continue; // vowels, h, w, y
    if (c !== last) key += c;
    last = c;
  }
  return key;
}

/** Transcript words that carry meaning; Whisper's stutters ("hey, hey") collapsed. */
function contentWords(words: string[]): string[] {
  const deduped = words.filter((w, i) => i === 0 || w !== words[i - 1]);
  const content = deduped.filter((w) => !STOPWORDS.has(w));
  return content.length > 0 ? content : deduped;
}

/** How much of `transcript` appears, in order and by sound, in `spoken`. */
export function echoScore(transcript: string, spoken: string): EchoScore {
  const t = contentWords(echoWords(transcript));
  const s = echoWords(spoken);
  const tk = t.map(soundKey);
  const sk = s.map(soundKey);
  const n = tk.length;
  const m = sk.length;
  if (n === 0 || m === 0) return { total: n, matched: 0, unmatched: t.slice() };
  // LCS table (transcripts are short; spoken text is a few sentences).
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] =
        tk[i - 1] === sk[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const hit = new Array<boolean>(n).fill(false);
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (tk[i - 1] === sk[j - 1]) {
      hit[i - 1] = true;
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
    else j--;
  }
  return { total: n, matched: dp[n][m], unmatched: t.filter((_, k) => !hit[k]) };
}

/**
 * True when `transcript` is most likely Herald's own speech (any of
 * `spokenTexts`, e.g. the sentences queued or played in the last few seconds).
 * Echo = at least `threshold` of the transcript's content words appear in order
 * (by sound) in one spoken text, or the transcript is a near-substring of it.
 * Never echo: an interrupt word ("stop", "wait") that Herald did not say.
 */
export function isLikelyEcho(
  transcript: string,
  spokenTexts: string[],
  opts: EchoMatchOptions = {}
): boolean {
  const threshold = opts.threshold ?? ECHO_THRESHOLD;
  const minTokens = Math.max(1, opts.minTokens ?? 1);
  const words = contentWords(echoWords(transcript));
  if (words.length < minTokens) return false;
  const spoken = spokenTexts
    .map((x) => x.trim())
    .filter(Boolean)
    .join(' . ');
  if (!spoken) return false;
  const score = echoScore(transcript, spoken);
  if (score.unmatched.some((w) => INTERRUPT_WORDS.has(w))) return false;
  const compactT = echoWords(transcript).join('');
  if (compactT.length >= 8 && echoWords(spoken).join('').includes(compactT)) return true;
  const required = score.total <= 2 ? score.total : Math.ceil(score.total * threshold);
  return score.matched >= required;
}
