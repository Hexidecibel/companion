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
    // Said aloud but not written: "supdox.com" is "supdox dot com", "2.28" is "2 point 28".
    .replace(/(\p{L})\.(?=\p{L})/gu, '$1 dot ')
    .replace(/(\p{N})\.(?=\p{N})/gu, '$1 point ')
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

/**
 * Same word by sound: equal keys, or one key is the other plus an -s / -ed
 * ending ("deploy"/"deployed", "check"/"checks").
 */
export function keysMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return (
    short.length >= 2 &&
    long.length === short.length + 1 &&
    long.startsWith(short) &&
    (long.endsWith('2') || long.endsWith('3'))
  );
}

/** Whisper repeats itself on echo ("hey, hey", "doc upload site doc upload site"): say it once. */
function collapseRepeats(words: string[]): string[] {
  const out: string[] = [];
  for (const w of words) {
    out.push(w);
    for (let n = 1; n <= 4 && n * 2 <= out.length; n++) {
      const a = out.slice(out.length - 2 * n, out.length - n).join(' ');
      const b = out.slice(out.length - n).join(' ');
      if (a === b) {
        out.length -= n;
        break;
      }
    }
  }
  return out;
}

/** Transcript words that carry meaning, repeats collapsed. */
function contentWords(words: string[]): string[] {
  const deduped = collapseRepeats(words);
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
      dp[i][j] = keysMatch(tk[i - 1], sk[j - 1])
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const hit = new Array<boolean>(n).fill(false);
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (keysMatch(tk[i - 1], sk[j - 1])) {
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
  // "stop" / "wait" that Herald did not say itself: a person is talking.
  if (hasUnsaidInterruptWord(transcript, spokenTexts)) return false;
  const score = echoScore(transcript, spoken);
  const compactT = echoWords(transcript).join('');
  if (compactT.length >= 8 && echoWords(spoken).join('').includes(compactT)) return true;
  const required = score.total <= 2 ? score.total : Math.ceil(score.total * threshold);
  return score.matched >= required;
}

/** The transcript has "stop", "wait"... that Herald itself did not say. */
export function hasUnsaidInterruptWord(transcript: string, spokenTexts: string[]): boolean {
  const said = new Set(echoWords(spokenTexts.join(' ')));
  return echoWords(transcript).some((w) => INTERRUPT_WORDS.has(w) && !said.has(w));
}

/** Fraction of content words at or below which a transcript is "mostly new words". */
export const BARGE_IN_MAX_MATCHED = 0.3;

/**
 * A partial transcript of what the mic heard WHILE Herald was talking: is it
 * clearly a person? Stricter than "not echo", because Whisper fills truncated
 * echo in with plausible words ("still waiting for a few minutes to get
 * started") or its vocabulary hints. Yes when it has an interrupt word Herald
 * did not say, or at least two content words and mostly (70%+) words Herald did
 * not say.
 */
export function isClearBargeIn(transcript: string, spokenTexts: string[]): boolean {
  const spoken = spokenTexts
    .map((x) => x.trim())
    .filter(Boolean)
    .join(' . ');
  if (!spoken) return contentWords(echoWords(transcript)).length > 0;
  if (hasUnsaidInterruptWord(transcript, spokenTexts)) return true;
  const score = echoScore(transcript, spoken);
  if (score.total < 2) return false;
  return score.matched / score.total <= BARGE_IN_MAX_MATCHED;
}

/**
 * Remove Herald's own words from a transcript that is known to contain the
 * user (a confirmed interruption through the speakers mixes both): runs of two
 * or more consecutive words that match the spoken text in order are cut. Returns
 * '' when nothing of the user's is left.
 */
export function stripEcho(transcript: string, spokenTexts: string[]): string {
  const spoken = spokenTexts
    .map((x) => x.trim())
    .filter(Boolean)
    .join(' . ');
  const words = transcript.split(/\s+/).filter(Boolean);
  if (!spoken || words.length === 0) return transcript.trim();
  const toks: Array<{ word: number; key: string }> = [];
  words.forEach((w, i) => {
    for (const t of echoWords(w)) toks.push({ word: i, key: soundKey(t) });
  });
  const sk = echoWords(spoken).map(soundKey);
  const n = toks.length;
  const m = sk.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = keysMatch(toks[i - 1].key, sk[j - 1])
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const hit = new Array<boolean>(n).fill(false);
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (keysMatch(toks[i - 1].key, sk[j - 1])) {
      hit[i - 1] = true;
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
    else j--;
  }
  // A word is Herald's when all of its tokens matched; punctuation-only words are neutral.
  const state: Array<'echo' | 'user' | 'none'> = words.map(() => 'none');
  toks.forEach((t, k) => {
    if (!hit[k]) state[t.word] = 'user';
    else if (state[t.word] === 'none') state[t.word] = 'echo';
  });
  const drop = new Array<boolean>(words.length).fill(false);
  let k = 0;
  while (k < words.length) {
    if (state[k] !== 'echo') {
      k++;
      continue;
    }
    let end = k;
    let count = 0;
    while (end < words.length && state[end] !== 'user') {
      if (state[end] === 'echo') count++;
      end++;
    }
    if (count >= 2) for (let x = k; x < end; x++) drop[x] = true;
    k = end;
  }
  const kept = words.filter((_, x) => !drop[x]);
  const content = contentWords(echoWords(kept.join(' ')));
  if (content.length === 0) return '';
  // Echo was cut out and one stray word is left ("...waiting on YouTube"):
  // a Whisper remnant, not a message, unless it is "stop" / "wait".
  const cut = kept.length < words.length;
  if (cut && content.length < 2 && !hasUnsaidInterruptWord(kept.join(' '), spokenTexts)) return '';
  return kept
    .join(' ')
    .replace(/^[\s,.;:!?-]+/, '')
    .trim();
}
