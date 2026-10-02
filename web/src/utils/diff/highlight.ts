/**
 * Syntax highlighting for unified hunks, as per-line segments.
 *
 * hljs needs whole-side context to tokenize well (a string or comment that
 * spans lines), so each hunk is highlighted twice: once as the OLD side
 * (context + removed lines) and once as the NEW side (context + added lines).
 * The HTML is then split back into lines: spans open across a newline are
 * closed at the end of the line and reopened at the start of the next, which
 * here simply means each segment carries the full class stack in effect.
 * Word-diff ranges are merged in last by splitting segments at their edges.
 */
import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import scss from 'highlight.js/lib/languages/scss';
import bash from 'highlight.js/lib/languages/bash';
import sql from 'highlight.js/lib/languages/sql';
import kotlin from 'highlight.js/lib/languages/kotlin';
import swift from 'highlight.js/lib/languages/swift';
import ruby from 'highlight.js/lib/languages/ruby';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import ini from 'highlight.js/lib/languages/ini';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import markdown from 'highlight.js/lib/languages/markdown';
import type { Range } from './intraline';

const LANGS: Record<string, Parameters<typeof hljs.registerLanguage>[1]> = {
  typescript, javascript, python, rust, go, java, json, yaml, xml, css, scss, bash, sql,
  kotlin, swift, ruby, c, cpp, csharp, ini, dockerfile, markdown,
};
for (const [name, lang] of Object.entries(LANGS)) {
  if (!hljs.getLanguage(name)) hljs.registerLanguage(name, lang);
}

const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rs: 'rust', go: 'go', java: 'java',
  json: 'json', jsonc: 'json', yml: 'yaml', yaml: 'yaml',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
  css: 'css', scss: 'scss', sass: 'scss',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  sql: 'sql', kt: 'kotlin', kts: 'kotlin', swift: 'swift',
  rb: 'ruby', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp',
  ini: 'ini', toml: 'ini', cfg: 'ini', conf: 'ini', service: 'ini',
  md: 'markdown', mdx: 'markdown',
};

export function languageForPath(path: string): string | null {
  const name = (path.split('/').pop() ?? '').toLowerCase();
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'dockerfile';
  if (name === 'makefile') return 'bash';
  if (name.startsWith('.env')) return 'bash';
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  return EXT_TO_LANG[ext] ?? null;
}

export interface Segment {
  text: string;
  /** Space-separated hljs classes in effect (outermost first). */
  cls?: string;
  /** Inside a word-diff range. */
  mark?: boolean;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#x27': "'" };

function decode(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (ENTITIES[e] !== undefined) return ENTITIES[e];
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return m;
  });
}

/** Split hljs HTML into lines of segments, carrying open spans across newlines. */
export function splitHtmlLines(html: string): Segment[][] {
  const lines: Segment[][] = [[]];
  const stack: string[] = [];
  const re = /<span class="([^"]*)">|<\/span>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[1] !== undefined) {
      stack.push(m[1]);
    } else if (m[0] === '</span>') {
      stack.pop();
    } else if (m[2] !== undefined) {
      const text = decode(m[2]);
      const parts = text.split('\n');
      const cls = stack.length ? stack.join(' ') : undefined;
      parts.forEach((part, i) => {
        if (i > 0) lines.push([]);
        if (part) {
          const line = lines[lines.length - 1];
          const last = line[line.length - 1];
          if (last && last.cls === cls) last.text += part;
          else line.push(cls ? { text: part, cls } : { text: part });
        }
      });
    }
  }
  return lines;
}

/** Split segments at range edges and flag the parts inside a range. */
export function mergeMarks(segments: Segment[], ranges: Range[] | undefined): Segment[] {
  if (!ranges || ranges.length === 0) return segments;
  const out: Segment[] = [];
  let pos = 0;
  let ri = 0;
  for (const seg of segments) {
    let start = 0;
    const len = seg.text.length;
    while (start < len) {
      const abs = pos + start;
      while (ri < ranges.length && ranges[ri].end <= abs) ri++;
      const r = ranges[ri];
      let end: number;
      let mark = false;
      if (!r || r.start >= pos + len) {
        end = len;
      } else if (abs < r.start) {
        end = r.start - pos;
      } else {
        end = Math.min(len, r.end - pos);
        mark = true;
      }
      const piece: Segment = { text: seg.text.slice(start, end) };
      if (seg.cls) piece.cls = seg.cls;
      if (mark) piece.mark = true;
      out.push(piece);
      start = end;
    }
    pos += len;
  }
  return out;
}

const MAX_HIGHLIGHT_CHARS = 120_000;

function highlightSide(text: string, lang: string): Segment[][] | null {
  try {
    const html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    return splitHtmlLines(html);
  } catch {
    return null;
  }
}

/**
 * Per-hunk-line segments with syntax classes and word marks. Lines that
 * cannot be highlighted come back as a single plain (possibly marked) segment.
 */
export function highlightHunk(lines: string[], path: string, marks?: Map<number, Range[]>): Segment[][] {
  const lang = languageForPath(path);
  const plain = (i: number): Segment[] => {
    const body = lines[i].startsWith('\\') ? lines[i] : lines[i].slice(1);
    return mergeMarks(body ? [{ text: body }] : [], marks?.get(i));
  };
  const total = lines.reduce((n, l) => n + l.length + 1, 0);
  if (!lang || total > MAX_HIGHLIGHT_CHARS) return lines.map((_, i) => plain(i));

  const oldIdx: number[] = [];
  const newIdx: number[] = [];
  lines.forEach((l, i) => {
    const c = l[0];
    if (c === ' ' || c === '-' || c === undefined) oldIdx.push(i);
    if (c === ' ' || c === '+' || c === undefined) newIdx.push(i);
  });
  const oldHl = highlightSide(oldIdx.map((i) => lines[i].slice(1)).join('\n'), lang);
  const newHl = highlightSide(newIdx.map((i) => lines[i].slice(1)).join('\n'), lang);

  const out: Segment[][] = lines.map((_, i) => plain(i));
  const place = (idx: number[], hl: Segment[][] | null, want: (c: string) => boolean) => {
    if (!hl) return;
    idx.forEach((li, k) => {
      const c = lines[li][0] ?? ' ';
      if (!want(c)) return;
      out[li] = mergeMarks(hl[k] ?? [], marks?.get(li));
    });
  };
  place(oldIdx, oldHl, (c) => c === '-');
  place(newIdx, newHl, (c) => c === '+' || c === ' ');
  return out;
}
