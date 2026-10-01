/**
 * Pure text helpers for speaking Herald replies: a streaming sentence chunker
 * and a normaliser that turns chat-flavoured text into something a speech
 * engine reads naturally. No DOM, no engine: fully unit-testable.
 */

import { applyPronunciations } from './pronounce';

// ---------------------------------------------------------------------------
// Normaliser
// ---------------------------------------------------------------------------

const KEY_NAMES: Record<string, string> = {
  cmd: 'Command',
  command: 'Command',
  ctrl: 'Control',
  control: 'Control',
  alt: 'Alt',
  opt: 'Option',
  option: 'Option',
  shift: 'Shift',
  meta: 'Meta',
  super: 'Super',
  win: 'Windows',
  esc: 'Escape',
  del: 'Delete',
  enter: 'Enter',
  return: 'Return',
  tab: 'Tab',
  space: 'Space',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
};

const MAGNITUDE: Record<string, string> = { k: 'thousand', m: 'million', b: 'billion', bn: 'billion' };

function hostOf(url: string): string {
  try {
    const u = new URL(url.startsWith('www.') ? `https://${url}` : url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function linkPhrase(url: string): string {
  const host = hostOf(url);
  return host ? `a link to ${host}` : 'a link';
}

function money(whole: string, cents: string | undefined, mag: string | undefined): string {
  const w = whole.replace(/,/g, '');
  if (mag) {
    const word = MAGNITUDE[mag.toLowerCase()];
    const num = cents ? `${w}.${cents}` : w;
    return `${num} ${word} dollars`;
  }
  const dollars = `${whole} ${w === '1' ? 'dollar' : 'dollars'}`;
  if (!cents || /^0+$/.test(cents)) return dollars;
  const c = cents.length === 1 ? `${cents}0` : cents.slice(0, 2);
  const cn = String(parseInt(c, 10));
  return `${dollars} and ${cn} ${cn === '1' ? 'cent' : 'cents'}`;
}

/** Turn a markdown-ish chat line into plain, speakable text. */
export function normalizeForSpeech(input: string): string {
  let s = input;

  // Fenced code blocks are never read aloud (open, unterminated fences too).
  s = s.replace(/```[\s\S]*?(```|$)/g, ' ');
  // Markdown images and links: keep the label only.
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, '$1');
  // Bare URLs: say where they go, never spell them out.
  s = s.replace(/\b(?:https?:\/\/|www\.)[^\s<>()"'`]+[^\s<>()"'`.,;:!?]/gi, (u) => linkPhrase(u));
  // Inline code: drop the ticks, keep the words.
  s = s.replace(/`+([^`]*)`+/g, '$1');
  s = s.replace(/`/g, '');
  // Headings, blockquotes, list bullets, numbered list markers at line starts.
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  s = s.replace(/^\s*>\s?/gm, '');
  s = s.replace(/^\s*[-*+•]\s+/gm, '');
  s = s.replace(/^\s*(\d+)[.)]\s+/gm, '$1, ');
  // Horizontal rules, table borders.
  s = s.replace(/^\s*([-*_=])\1{2,}\s*$/gm, ' ');
  s = s.replace(/^\s*\|?(\s*:?-{2,}:?\s*\|)+\s*:?-*:?\s*$/gm, ' ');
  s = s.replace(/\s*\|\s*/g, ', ');
  // Emphasis markers (bold/italic/strike). Underscores only at word edges so
  // snake_case survives until the identifier pass below.
  s = s.replace(/(\*\*|__)(.+?)\1/g, '$2');
  s = s.replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, '$1$2');
  s = s.replace(/~~(.+?)~~/g, '$1');
  s = s.replace(/\*+/g, '');

  // Keyboard chords: Cmd+J, Ctrl+Shift+P, Esc.
  s = s.replace(
    /\b((?:cmd|command|ctrl|control|alt|opt|option|shift|meta|super|win)(?:\s*\+\s*[A-Za-z0-9]+)+)\b/gi,
    (chord) =>
      chord
        .split(/\s*\+\s*/)
        .map((k) => KEY_NAMES[k.toLowerCase()] ?? (k.length === 1 ? k.toUpperCase() : k))
        .join(' '),
  );
  s = s.replace(/\bEsc\b/g, 'Escape');

  // Money: $412.82, $1,200, $3.5k, $2M.
  s = s.replace(
    /\$(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:\s?(k|m|bn|b)(?![a-z]))?/gi,
    (_m, whole: string, cents: string | undefined, mag: string | undefined) => money(whole, cents, mag),
  );
  // Absolute file paths: the file name carries the meaning.
  s = s.replace(/(?:^|(?<=[\s(]))(?:~|\.{1,2})?\/(?:[\w.@-]+\/)+([\w.@-]+)/g, '$1');
  // Issue / PR numbers.
  s = s.replace(/(^|\s)#(\d+)\b/g, '$1number $2');
  // Common symbols and shorthand.
  s = s.replace(/\s*(?:->|=>|→)\s*/g, ' to ');
  s = s.replace(/\s*<-\s*/g, ' from ');
  s = s.replace(/\s+&\s+/g, ' and ');
  s = s.replace(/~(?=\d)/g, 'about ');
  s = s.replace(/\be\.g\.,?/gi, 'for example,');
  s = s.replace(/\bi\.e\.,?/gi, 'that is,');
  s = s.replace(/\betc\./gi, 'etcetera.');
  s = s.replace(/\bvs\.?(?=\s)/gi, 'versus');
  s = s.replace(/(\d)\s?x\b/g, '$1 times');
  // snake_case identifiers read better as words.
  s = s.replace(/\b([a-z][a-z0-9]*)(?:_([a-z0-9]+))+\b/gi, (m) => m.replace(/_/g, ' '));
  // Pronunciation lexicon: versions, "Out4", acronyms, the user's own list.
  s = applyPronunciations(s);

  // Emoji and pictographs.
  s = s.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '');
  // Whitespace: newlines become pauses, runs collapse.
  s = s.replace(/\s*\n+\s*/g, '. ').replace(/([.!?:;,])\s*\.(?=\s|$)/g, '$1');
  s = s.replace(/\s{2,}/g, ' ').trim();
  s = s.replace(/^[.,;:]\s*/, '');
  return s;
}

/** True when the normalised text has anything a listener would hear. */
export function isSpeakable(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

// ---------------------------------------------------------------------------
// Sentence chunker
// ---------------------------------------------------------------------------

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'st', 'sr', 'jr', 'vs', 'etc', 'e.g', 'i.e', 'eg', 'ie',
  'inc', 'ltd', 'co', 'approx', 'no', 'fig', 'min', 'max', 'avg', 'est', 'dept',
]);

/** Soft limit: past this a long run-on gets split at a comma or space. */
const MAX_CHUNK = 220;

function isAbbreviation(text: string, dotIndex: number): boolean {
  const before = text.slice(0, dotIndex);
  const m = /([A-Za-z.]+)$/.exec(before);
  if (!m) return false;
  const word = m[1].toLowerCase().replace(/^\.+/, '');
  if (ABBREVIATIONS.has(word)) return true;
  // Single initials ("J. R. R.") read as one phrase.
  return /^[a-z]$/i.test(word) && word === word.toUpperCase();
}

/**
 * Index just past the first sentence boundary in `text`, or -1 when there is
 * no complete sentence yet. A boundary needs following whitespace, so "3.5",
 * "v1.2" and "example.com" never split, and a trailing "." waits for more text.
 */
export function findSentenceEnd(text: string): number {
  let inFence = false;
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('```', i)) {
      inFence = !inFence;
      i += 2;
      continue;
    }
    if (inFence) continue;
    const ch = text[i];
    if (ch === '\n') {
      // A blank line (paragraph) or a list/heading line ends a chunk.
      let j = i;
      while (j < text.length && text[j] === '\n') j++;
      if (j >= text.length) return -1; // wait: might be the start of more lines
      if (j - i >= 2 || /^\s*([-*+•]|\d+[.)]|#{1,6})\s/.test(text.slice(j))) return j;
      continue;
    }
    if (ch === '.' || ch === '!' || ch === '?' || ch === '…') {
      let j = i + 1;
      while (j < text.length && /[.!?…"'”’)\]]/.test(text[j])) j++;
      if (j >= text.length) return -1;
      if (!/\s/.test(text[j])) continue;
      if (ch === '.' && isAbbreviation(text, i)) continue;
      return j;
    }
  }
  return -1;
}

function splitLong(text: string): [string, string] | null {
  if (text.length <= MAX_CHUNK) return null;
  if ((text.match(/```/g)?.length ?? 0) % 2 === 1) return null; // inside a code fence
  const window = text.slice(0, MAX_CHUNK);
  const soft = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '), window.lastIndexOf(' - '));
  const cut = soft > 60 ? soft + 1 : window.lastIndexOf(' ');
  if (cut <= 0) return null;
  return [text.slice(0, cut), text.slice(cut)];
}

/**
 * Incremental sentence splitter for streamed text. `push` returns every
 * sentence completed by the new delta; `flush` returns whatever is left.
 * Output is raw (un-normalised) text so markdown spanning a split is intact.
 */
export class SentenceChunker {
  private buf = '';

  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    for (;;) {
      const end = findSentenceEnd(this.buf);
      if (end !== -1) {
        out.push(this.buf.slice(0, end).trim());
        this.buf = this.buf.slice(end);
        continue;
      }
      const long = splitLong(this.buf);
      if (long) {
        out.push(long[0].trim());
        this.buf = long[1];
        continue;
      }
      break;
    }
    return out.filter(Boolean);
  }

  flush(): string[] {
    const rest = this.buf.trim();
    this.buf = '';
    return rest ? [rest] : [];
  }

  /** Characters consumed so far (pushed text minus the pending remainder). */
  get pending(): string {
    return this.buf;
  }

  reset(): void {
    this.buf = '';
  }
}

/** Split a whole text into speakable chunks (non-streaming convenience). */
export function chunkText(text: string): string[] {
  const c = new SentenceChunker();
  return [...c.push(text), ...c.flush()];
}
