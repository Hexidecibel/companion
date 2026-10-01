/**
 * Pronunciation lexicon for Herald's voice: the last step of the speech
 * normaliser (`normalizeForSpeech`). Pure, so every rule is unit-tested.
 *
 *   versions   "v2.28.0" -> "version two point twenty-eight" (a trailing ".0" is
 *              dropped), "2.0.7" -> "two point oh point seven". Kokoro reads raw
 *              versions as "V2, 28.0" / "2, 0.7"; the words come back from
 *              Whisper as "version 2.28" / "2.0.7".
 *   glued      session names with digits glued on: "Out4" -> "Out four".
 *   acronyms   APK, AUQ, PR, CI ... spelled with hyphens ("A-P-K"): spaced
 *              letters ("the A P K") get read as the article "uh". Round-trip
 *              tested through Kokoro + Whisper.
 *   user       the user's own list (Advanced > Pronunciations), persisted on the
 *              hub so it follows them to every device. Applied first: it wins.
 */

export interface Pronunciation {
  /** What appears in the text (a word or short phrase; matched case-insensitively, whole words). */
  from: string;
  /** How to say it. */
  to: string;
}

export const MAX_PRONUNCIATIONS = 50;
export const MAX_PRONUNCIATION_FROM = 40;
export const MAX_PRONUNCIATION_TO = 80;

// ---------------------------------------------------------------------------
// Numbers

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** 0..999999 in words ("twenty-eight", "one hundred five"). Larger: the digits as-is. */
export function numberToWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 999_999) return String(n);
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '');
  if (n < 1000) {
    const rest = n % 100;
    return `${ONES[Math.floor(n / 100)]} hundred${rest ? ` ${numberToWords(rest)}` : ''}`;
  }
  const rest = n % 1000;
  return `${numberToWords(Math.floor(n / 1000))} thousand${rest ? ` ${numberToWords(rest)}` : ''}`;
}

/** One version component: "0" -> "oh", "07" -> "oh seven", "28" -> "twenty-eight". */
function versionPart(p: string): string {
  if (/^0+$/.test(p)) return 'oh';
  if (p.length > 1 && p.startsWith('0')) return `oh ${versionPart(p.replace(/^0+/, ''))}`;
  return numberToWords(Number(p));
}

/** Words for a version's numbers ("2.28.0" -> "two point twenty-eight"). */
export function speakVersion(numbers: string): string {
  const parts = numbers.split('.');
  // "2.28.0" is said "two point twenty-eight": a trailing patch zero adds nothing.
  if (parts.length >= 3 && /^0+$/.test(parts[parts.length - 1])) parts.pop();
  return parts.map(versionPart).join(' point ');
}

// v1.2 / v2.28.0 / 2.0.7 / 1.2.3.4 (with a v). Not inside words, paths, IPs or longer dotted runs.
const VERSION_RE = /(?<![\w.\/-])([vV])?(\d{1,6}(?:\.\d{1,6}){1,3})(?![\w-]|\.\d)/g;

function speakVersions(s: string): string {
  return s.replace(VERSION_RE, (m: string, v: string | undefined, nums: string, offset: number, whole: string) => {
    const parts = nums.split('.');
    // A plain "3.5" is a decimal (TTS reads it fine); four bare parts is an IP.
    if (!v && (parts.length < 3 || parts.length > 3)) return m;
    const words = speakVersion(nums);
    if (!v) return words;
    const before = whole.slice(Math.max(0, offset - 9), offset);
    return /\bversion\s+$/i.test(before) ? words : `version ${words}`;
  });
}

// ---------------------------------------------------------------------------
// Words with digits glued on: "Out4" -> "Out four", "base64" -> "base sixty-four".

const GLUED_RE = /\b([A-Za-z]{2,})(\d{1,3})\b/g;

function splitGlued(s: string): string {
  return s.replace(GLUED_RE, (_m, word: string, digits: string) => {
    const n = Number(digits);
    // Short numbers read better as words; "py311" stays "py 311".
    const spoken = digits.length <= 2 && !(digits.length === 2 && digits.startsWith('0')) ? numberToWords(n) : digits;
    return `${word} ${spoken}`;
  });
}

// ---------------------------------------------------------------------------
// Built-in acronyms and jargon

interface Rule {
  re: RegExp;
  to: string;
}

/** Case-sensitive (an acronym is caps); `tmux` matches any case. */
export const BUILTIN_PRONUNCIATIONS: ReadonlyArray<{ from: string; to: string; anyCase?: boolean }> = [
  { from: 'APKs', to: "A-P-K's" },
  { from: 'APK', to: 'A-P-K' },
  { from: 'AUQs', to: "A-U-Q's" },
  { from: 'AUQ', to: 'A-U-Q' },
  { from: 'PRs', to: "P-R's" },
  { from: 'PR', to: 'P-R' },
  { from: 'CI', to: 'C-I' },
  { from: 'HAProxy', to: 'H.A. proxy', anyCase: true },
  { from: 'tmux', to: 'tee-mux', anyCase: true },
  { from: 'TTS', to: 'T-T-S' },
  { from: 'STT', to: 'S-T-T' },
  { from: 'AEC', to: 'A-E-C' },
  { from: 'CLI', to: 'C-L-I' },
  { from: 'UI', to: 'U-I' },
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word boundaries that also work for terms starting or ending in a symbol ("C++", ".env"). */
function wordRe(from: string, flags: string): RegExp {
  return new RegExp(`(?<![\\w])${escapeRe(from)}(?![\\w])`, flags);
}

const BUILTIN_RULES: Rule[] = BUILTIN_PRONUNCIATIONS.map((p) => ({ re: wordRe(p.from, p.anyCase ? 'gi' : 'g'), to: p.to }));

// ---------------------------------------------------------------------------
// The user's list

/** Clean a user list: trimmed, bounded, no blanks, one entry per `from` (last wins), longest first. */
export function sanitizePronunciations(raw: unknown): Pronunciation[] {
  if (!Array.isArray(raw)) return [];
  const byKey = new Map<string, Pronunciation>();
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    if (typeof r.from !== 'string' || typeof r.to !== 'string') continue;
    const from = r.from.replace(/\s+/g, ' ').trim().slice(0, MAX_PRONUNCIATION_FROM);
    const to = r.to.replace(/\s+/g, ' ').trim().slice(0, MAX_PRONUNCIATION_TO);
    if (!from || !to || !/[\p{L}\p{N}]/u.test(from)) continue;
    const key = from.toLowerCase();
    byKey.delete(key);
    byKey.set(key, { from, to });
  }
  return [...byKey.values()].slice(-MAX_PRONUNCIATIONS);
}

let userRules: Rule[] = [];
let userKey = '';

/** The user's pronunciations (from Herald state). Cheap to call with the same list again. */
export function setUserPronunciations(list: readonly Pronunciation[] | null | undefined): void {
  const clean = sanitizePronunciations(list ?? []);
  const key = JSON.stringify(clean);
  if (key === userKey) return;
  userKey = key;
  // Longest first, so "Doc Upload Site" wins over "Doc".
  userRules = clean
    .slice()
    .sort((a, b) => b.from.length - a.from.length)
    .map((p) => ({ re: wordRe(p.from, 'gi'), to: p.to }));
}

export function getUserPronunciations(): Pronunciation[] {
  return userKey ? (JSON.parse(userKey) as Pronunciation[]) : [];
}

// ---------------------------------------------------------------------------

/**
 * Apply the lexicon to already-normalised text. `user` overrides the global
 * list (tests); every rule is whole-word, so "PRINT" or "CIRCLE" are untouched.
 */
export function applyPronunciations(input: string, user?: readonly Pronunciation[]): string {
  let s = input;
  const rules = user ? sanitizePronunciations(user).sort((a, b) => b.from.length - a.from.length).map((p) => ({ re: wordRe(p.from, 'gi'), to: p.to })) : userRules;
  // The user's words first: they win over every built-in rule. Protected from
  // later rules with placeholders, so "my v2.0.1" mapping is not re-spoken.
  const held: string[] = [];
  for (const r of rules) {
    s = s.replace(r.re, () => {
      held.push(r.to);
      return `\u0000${held.length - 1}\u0000`;
    });
  }
  s = speakVersions(s);
  for (const r of BUILTIN_RULES) s = s.replace(r.re, r.to);
  s = splitGlued(s);
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => held[Number(i)] ?? '');
}
