/**
 * Version numbers in speech recognition. Whisper (base.en) hears "2.0.7" said
 * aloud as "two or seven", "2 0 7" or "two point oh point seven". Two halves:
 *
 *  - `versionsIn` / `recentVersions`: the versions in recent session text
 *    (Herald's conversation, session gists, inbox headlines). They go into the
 *    STT vocabulary hints, which already makes Whisper write "2.0.7" more often.
 *  - `normalizeSpokenVersions`: a transcript's spoken number run becomes the
 *    version ONLY when it spells a version from that list exactly, so ordinary
 *    numbers ("two or three tests") are left alone unless such a version exists.
 *
 * Pure; unit-tested in daemon/__tests__/herald-voice-hints.test.ts.
 */

/** v-prefixed 2-4 parts, or a bare 3-part (semver-like) number. Not in words, paths or IPs. */
const VERSION_IN_TEXT =
  /(?<![\w./-])(v|V|version\s+|release\s+)?(\d{1,4}(?:\.\d{1,4}){1,3})(?![\w-]|\.\d)/g;

export const MAX_HINT_VERSIONS = 8;

/** Versions written in a text, without a "v" ("v2.28.0" -> "2.28.0"), in order of appearance. */
export function versionsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(VERSION_IN_TEXT)) {
    const parts = m[2].split('.');
    const marked = !!m[1];
    if (parts.length === 3 || (marked && parts.length >= 2)) out.push(m[2]);
  }
  return out;
}

/** Distinct versions from texts given NEWEST first, at most `max`. */
export function recentVersions(
  textsNewestFirst: Iterable<string>,
  max = MAX_HINT_VERSIONS
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of textsNewestFirst) {
    if (!t) continue;
    for (const v of versionsIn(t)) {
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(v);
      if (out.length >= max) return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Spoken numbers -> a known version

const DIGIT_WORDS: Record<string, number> = {
  zero: 0,
  oh: 0,
  o: 0,
  nought: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
};
const TEEN_WORDS: Record<string, number> = {
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const TENS_WORDS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
const SEP_WORDS = new Set(['point', 'dot']);

type Tok =
  | { t: 'num'; v: number; parts?: string[]; start: number; end: number }
  | { t: 'tens'; v: number; start: number; end: number }
  /** `point` / `dot` / "." separate parts; "," and "-" only glue ("2, 0.7", "two-oh-seven"). */
  | { t: 'sep'; dot: boolean; hyphen: boolean; start: number; end: number }
  | { t: 'or'; start: number; end: number }
  | { t: 'other'; start: number; end: number };

function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  const re = /(\d+(?:\.\d+)*)|([A-Za-z]+)|([.,-])|(\S)/g;
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (m[1]) {
      const parts = m[1].split('.');
      out.push({
        t: 'num',
        v: Number(parts[0]),
        parts: parts.length > 1 ? parts : undefined,
        start,
        end,
      });
    } else if (m[2]) {
      const w = m[2].toLowerCase();
      if (w in DIGIT_WORDS) out.push({ t: 'num', v: DIGIT_WORDS[w], start, end });
      else if (w in TEEN_WORDS) out.push({ t: 'num', v: TEEN_WORDS[w], start, end });
      else if (w in TENS_WORDS) out.push({ t: 'tens', v: TENS_WORDS[w], start, end });
      else if (SEP_WORDS.has(w)) out.push({ t: 'sep', dot: true, hyphen: false, start, end });
      else if (w === 'or') out.push({ t: 'or', start, end });
      else out.push({ t: 'other', start, end });
    } else if (m[3]) {
      out.push({ t: 'sep', dot: m[3] === '.', hyphen: m[3] === '-', start, end });
    } else {
      out.push({ t: 'other', start, end });
    }
  }
  return out;
}

interface Comp {
  v: number;
  start: number;
  end: number;
}

interface Run {
  comps: Comp[];
  /** A spoken / written point ("point", ".") appeared between components. */
  dotted: boolean;
  /** One written number with dots ("2.07"): its digits, for the digits-only match. */
  digits: string | null;
  /** "or" stood in for "oh". */
  usedOr: boolean;
}

const isNumberish = (t: Tok | undefined): boolean => !!t && (t.t === 'num' || t.t === 'tens');

/** Maximal runs of number-ish tokens, parsed into components. */
function runs(toks: Tok[]): Run[] {
  const out: Run[] = [];
  let i = 0;
  while (i < toks.length) {
    if (!isNumberish(toks[i])) {
      i++;
      continue;
    }
    const run: Run = { comps: [], dotted: false, digits: null, usedOr: false };
    let numTokens = 0;
    let lastNum: Tok | null = null;
    while (i < toks.length) {
      const t = toks[i];
      if (t.t === 'num') {
        numTokens++;
        lastNum = t;
        if (t.parts) {
          run.dotted = true;
          for (const p of t.parts) run.comps.push({ v: Number(p), start: t.start, end: t.end });
        } else {
          run.comps.push({ v: t.v, start: t.start, end: t.end });
        }
        i++;
      } else if (t.t === 'tens') {
        numTokens++;
        lastNum = t;
        // "twenty eight" / "twenty-eight" is one component.
        const hy = toks[i + 1]?.t === 'sep' && (toks[i + 1] as { hyphen: boolean }).hyphen;
        const j = hy ? i + 2 : i + 1;
        const ones = toks[j];
        if (ones && ones.t === 'num' && !ones.parts && ones.v >= 1 && ones.v <= 9) {
          run.comps.push({ v: t.v + ones.v, start: t.start, end: ones.end });
          i = j + 1;
        } else {
          run.comps.push({ v: t.v, start: t.start, end: t.end });
          i++;
        }
      } else if (t.t === 'sep' || t.t === 'or') {
        // Separators and "or" only count BETWEEN numbers.
        if (!isNumberish(toks[i + 1])) break;
        if (t.t === 'or') {
          run.comps.push({ v: 0, start: t.start, end: t.end });
          run.usedOr = true;
        } else if (t.dot) {
          run.dotted = true;
        }
        i++;
      } else {
        break;
      }
    }
    if (numTokens === 1 && lastNum?.t === 'num' && lastNum.parts)
      run.digits = lastNum.parts.join('');
    if (run.comps.length) out.push(run);
  }
  return out;
}

function sameNumbers(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** The known version a run of components spells, or null. */
function matchKnown(run: Run, comps: Comp[], known: readonly string[]): string | null {
  const vals = comps.map((c) => c.v);
  for (const k of known) {
    const parts = k.split('.').map(Number);
    // Spoken versions drop a trailing ".0" ("version two point twenty-eight").
    const short = parts.length >= 3 && parts[parts.length - 1] === 0 ? parts.slice(0, -1) : null;
    const hit = sameNumbers(vals, parts) || (!!short && sameNumbers(vals, short));
    if (!hit) continue;
    // Without a spoken / written point, only a 3+ part run counts ("two oh seven").
    if (!run.dotted && vals.length < 3) continue;
    // "one or two" is only a version when every part is a single digit and the
    // "or" sits where the zero is (the "two oh seven" mishearing).
    if (run.usedOr && !(parts.every((p) => p < 10) && parts.includes(0))) continue;
    return k;
  }
  return null;
}

/**
 * Rewrite spoken versions in a transcript as the known version they spell
 * ("two point oh point seven" -> "2.0.7", "two or seven" -> "2.0.7" when 2.0.7
 * is known). Anything that does not spell a known version is left alone.
 */
export function normalizeSpokenVersions(transcript: string, known: readonly string[]): string {
  if (!transcript || known.length === 0) return transcript;
  const edits: Array<{ start: number; end: number; to: string }> = [];
  for (const run of runs(tokenize(transcript))) {
    const n = run.comps.length;
    let done = false;
    // Longest sub-run first: "version 2 point 0 point 7 3 times" still finds it.
    for (let len = n; len >= 2 && !done; len--) {
      for (let from = 0; from + len <= n && !done; from++) {
        const comps = run.comps.slice(from, from + len);
        // Never cut through one written number ("2.0.7" is not "2.0" + "7").
        const before = run.comps[from - 1];
        const after = run.comps[from + len];
        if (
          (before && before.start === comps[0].start) ||
          (after && after.end === comps[comps.length - 1].end)
        )
          continue;
        const k = matchKnown(run, comps, known);
        if (!k) continue;
        const start = comps[0].start;
        const end = comps[comps.length - 1].end;
        if (transcript.slice(start, end) !== k) edits.push({ start, end, to: k });
        done = true;
      }
    }
    // "2.07" written by Whisper for a known 2.0.7: same digits, one dotted number.
    if (!done && run.digits) {
      const k = known.find(
        (v) =>
          v.split('.').length >= 3 &&
          v.replace(/\./g, '') === run.digits &&
          !known.includes(transcript.slice(run.comps[0].start, run.comps[0].end))
      );
      if (k) edits.push({ start: run.comps[0].start, end: run.comps[n - 1].end, to: k });
    }
  }
  let out = transcript;
  for (const e of edits.sort((a, b) => b.start - a.start))
    out = out.slice(0, e.start) + e.to + out.slice(e.end);
  return out;
}
