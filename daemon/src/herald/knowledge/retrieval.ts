/**
 * Best-section retrieval over markdown for Herald's knowledge tools.
 *
 *   - chunkMarkdown: split a document by headings into sections that carry their
 *     heading path ("Port Registry > Next available ports"). Oversized sections
 *     are split again at blank lines so one giant section can't eat the budget.
 *   - rankChunks: keyword overlap with heading matches weighted up, a phrase
 *     bonus, and a mild length penalty. Deterministic; no model involved.
 *   - focusChunk: for markdown tables, keep the header plus only the rows that
 *     match (a 100-row port registry becomes the 2 rows about Jellyfin).
 *   - selectWithinBudget: top chunks until the character budget (~2.5k tokens).
 *   - FileChunkCache: parsed chunks per file, invalidated on mtime/size change.
 */

import * as fs from 'fs';
import { safeReadText } from './redact';

/** Result budget: ~2.5k tokens at ~4 chars/token. */
export const RESULT_BUDGET_CHARS = 10_000;
const MAX_CHUNK_CHARS = 2400;
const MAX_SECTIONS_RETURNED = 6;

export interface Chunk {
  /** Source file (absolute path). */
  source: string;
  /** Heading path, outermost first. Empty for a preamble. */
  headings: string[];
  text: string;
}

export interface ScoredChunk extends Chunk {
  score: number;
}

const STOPWORDS = new Set(
  (
    'a an and are as at be by can do does for from how i in is it its me my of on or ' +
    'our so that the their them there these this to up was we what when where which who ' +
    'why will with you your please tell show give get find about any some all know need ' +
    'use using used should would could want'
  ).split(' ')
);

/** Lowercased keyword tokens (keeps numbers and dotted/dashed names like "cush.rocks"). */
export function tokenize(s: string): string[] {
  const raw = (s || '').toLowerCase().match(/[a-z0-9][a-z0-9._-]*[a-z0-9]|[a-z0-9]/g) || [];
  const out: string[] = [];
  for (const t of raw) {
    if (STOPWORDS.has(t)) continue;
    out.push(t);
    // "cush-tools" also matches "cush" and "tools"; "aj's" is handled by the split.
    if (/[._-]/.test(t)) {
      for (const part of t.split(/[._-]+/))
        if (part.length > 1 && !STOPWORDS.has(part)) out.push(part);
    }
  }
  return Array.from(new Set(out));
}

/** Light stemming so "tunnels" matches "tunnel" and "deploying" matches "deploy". */
function stem(t: string): string {
  if (t.length > 5 && t.endsWith('ing')) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith('ed')) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('es') && /(?:s|x|ch|sh)es$/.test(t)) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

export function chunkMarkdown(source: string, text: string): Chunk[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const chunks: Chunk[] = [];
  const stack: Array<{ level: number; title: string }> = [];
  let buf: string[] = [];
  let inFence = false;

  const flush = () => {
    const body = buf.join('\n').trim();
    buf = [];
    if (!body) return;
    const headings = stack.map((h) => h.title);
    for (const piece of splitLarge(body)) chunks.push({ source, headings, text: piece });
  };

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence ? line.match(HEADING) : null;
    if (m) {
      flush();
      const level = m[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title: cleanHeading(m[2]) });
      continue;
    }
    buf.push(line);
  }
  flush();
  // A heading with no body of its own still deserves to be findable.
  if (chunks.length === 0 && stack.length) {
    chunks.push({ source, headings: stack.map((h) => h.title), text: '' });
  }
  return chunks;
}

function cleanHeading(h: string): string {
  return h
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]|\u{FE0F}/gu, '')
    .replace(/[*_`]/g, '')
    .trim();
}

/** Split an oversized section at blank lines, never inside a table or code fence. */
function splitLarge(body: string): string[] {
  if (body.length <= MAX_CHUNK_CHARS) return [body];
  const blocks: string[] = [];
  let cur: string[] = [];
  let curLen = 0;
  let inFence = false;
  /** Header (+ separator) of the table being read, repeated into each split piece. */
  let tableHead: string[] = [];
  let prevWasRow = false;
  const push = (line: string) => {
    cur.push(line);
    curLen += line.length + 1;
  };
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const isTableRow = !inFence && /^\s*\|/.test(line);
    if (isTableRow && !prevWasRow) tableHead = [line];
    else if (isTableRow && tableHead.length === 1 && /^\s*\|[\s:|-]+\|\s*$/.test(line))
      tableHead.push(line);
    else if (isTableRow && curLen >= MAX_CHUNK_CHARS) {
      // Split an oversized table between rows, repeating its header.
      blocks.push(cur.join('\n').trim());
      cur = [];
      curLen = 0;
      for (const h of tableHead) push(h);
    }
    prevWasRow = isTableRow;
    if (!inFence && !isTableRow && line.trim() === '' && curLen >= MAX_CHUNK_CHARS / 2) {
      blocks.push(cur.join('\n').trim());
      cur = [];
      curLen = 0;
      continue;
    }
    push(line);
  }
  if (cur.join('').trim()) blocks.push(cur.join('\n').trim());
  // Pack small neighbours back together up to the chunk size.
  const out: string[] = [];
  for (const b of blocks) {
    const last = out[out.length - 1];
    if (last !== undefined && last.length + b.length + 2 <= MAX_CHUNK_CHARS)
      out[out.length - 1] = `${last}\n\n${b}`;
    else out.push(b);
  }
  return out;
}

function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1 && n < 20) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

/** Score one chunk against query terms. 0 = no overlap. */
export function scoreChunk(chunk: Chunk, terms: string[], phrase: string): number {
  if (terms.length === 0) return 0;
  const heading = chunk.headings.join(' > ').toLowerCase();
  const body = chunk.text.toLowerCase();
  const sourceName = chunk.source.toLowerCase();
  let score = 0;
  let matched = 0;
  for (const t of terms) {
    const s = stem(t);
    const inBody = countOccurrences(body, s);
    const inHeading = countOccurrences(heading, s);
    const inSource = sourceName.includes(s) ? 1 : 0;
    if (inBody || inHeading || inSource) matched++;
    // Diminishing returns on repeats; headings count triple; long terms are rarer.
    const weight = s.length >= 5 || /\d/.test(s) ? 1.4 : 1;
    score += weight * (Math.log2(1 + inBody) + 3 * Math.min(inHeading, 2) + 0.5 * inSource);
  }
  if (matched === 0) return 0;
  // Coverage matters more than repetition: a chunk matching every term wins.
  score *= 0.5 + matched / terms.length;
  if (phrase.length > 4 && (body.includes(phrase) || heading.includes(phrase))) score += 4;
  // Mild length normalization so giant sections don't win on volume alone.
  score /= 1 + Math.max(0, chunk.text.length - 1500) / 6000;
  return score;
}

export function rankChunks(chunks: Chunk[], query: string): ScoredChunk[] {
  const terms = tokenize(query);
  const phrase = query.toLowerCase().replace(/\s+/g, ' ').trim();
  return chunks
    .map((c) => ({ ...c, score: scoreChunk(c, terms, phrase) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
}

/**
 * Tables: keep the header row + separator + rows that mention a query term (or the
 * whole table when no row does). Other text passes through unchanged.
 */
export function focusChunk(text: string, query: string): string {
  return focusChunkInfo(text, query).text;
}

export function focusChunkInfo(
  text: string,
  query: string,
  headings: string[] = []
): { text: string; tableRows: number; rowHits: number } {
  // Terms already answered by the heading ("port" under "Port Registry") don't
  // pick rows: otherwise every "Gluetun port" row rides along with Jellyfin.
  const heading = headings.join(' ').toLowerCase();
  const all = tokenize(query).map(stem);
  const specific = all.filter((t) => !heading.includes(t));
  const terms = specific.length ? specific : all;
  let tableRows = 0;
  let rowHits = 0;
  if (!terms.length || !/^\s*\|.*\|\s*$/m.test(text)) return { text, tableRows, rowHits };
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!/^\s*\|/.test(lines[i])) {
      out.push(lines[i]);
      i++;
      continue;
    }
    const table: string[] = [];
    while (i < lines.length && /^\s*\|/.test(lines[i])) table.push(lines[i++]);
    const hasSep = table.length > 1 && /^\s*\|[\s:|-]+\|\s*$/.test(table[1]);
    const head = hasSep ? table.slice(0, 2) : table.slice(0, 1);
    const rows = table.slice(head.length);
    const hits = rows.filter((r) => {
      const low = r.toLowerCase();
      return terms.some((t) => t.length > 1 && low.includes(t));
    });
    tableRows += rows.length;
    rowHits += hits.length;
    if (hits.length === 0 || hits.length === rows.length) out.push(...table);
    else out.push(...head, ...hits, `| (${rows.length - hits.length} other rows omitted) |`);
  }
  return { text: out.join('\n'), tableRows, rowHits };
}

export interface SelectedSection {
  source: string;
  section: string;
  text: string;
}

/** Top chunks, focused and clipped, until the character budget is spent. */
export function selectWithinBudget(
  ranked: ScoredChunk[],
  query: string,
  budget = RESULT_BUDGET_CHARS,
  maxSections = MAX_SECTIONS_RETURNED,
  displaySource: (p: string) => string = (p) => p
): { sections: SelectedSection[]; truncated: boolean } {
  const sections: SelectedSection[] = [];
  let used = 0;
  let truncated = false;
  for (const c of ranked) {
    if (sections.length >= maxSections) {
      truncated = true;
      break;
    }
    // Scores fall off fast; don't pad the answer with weak matches.
    if (sections.length > 0 && c.score < ranked[0].score * 0.25) break;
    const section = c.headings.join(' > ') || '(top of file)';
    const focused = focusChunkInfo(c.text, query, c.headings);
    // A slice of a big table where no row matches only matched via its heading:
    // once something better is in hand it is noise (the other 100 port rows).
    if (sections.length > 0 && focused.tableRows > 0 && focused.rowHits === 0) continue;
    let text = focused.text;
    const overhead = section.length + 80;
    const room = budget - used - overhead;
    if (room < 200) {
      truncated = true;
      break;
    }
    if (text.length > room) {
      text = `${text.slice(0, room - 1).trimEnd()}…`;
      truncated = true;
    }
    sections.push({ source: displaySource(c.source), section, text });
    used += text.length + overhead;
  }
  return { sections, truncated };
}

// ---------------------------------------------------------------------------
// Cache

interface CacheEntry {
  mtimeMs: number;
  size: number;
  chunks: Chunk[];
  checkedAt: number;
}

/** Parsed chunks per file, re-read only when mtime or size changes. */
export class FileChunkCache {
  private entries = new Map<string, CacheEntry>();
  private statTtlMs: number;
  private maxEntries: number;
  private extraHomes: string[];

  constructor(opts: { statTtlMs?: number; maxEntries?: number; extraHomes?: string[] } = {}) {
    this.statTtlMs = opts.statTtlMs ?? 5000;
    this.maxEntries = opts.maxEntries ?? 2000;
    this.extraHomes = opts.extraHomes || [];
  }

  /** Chunks for a file, or null when it is missing / denied / unreadable. */
  async get(file: string, now = Date.now()): Promise<Chunk[] | null> {
    const e = this.entries.get(file);
    if (e && now - e.checkedAt < this.statTtlMs) return e.chunks;
    if (e) {
      try {
        const st = await fs.promises.stat(file);
        if (st.mtimeMs === e.mtimeMs && st.size === e.size) {
          e.checkedAt = now;
          return e.chunks;
        }
      } catch {
        this.entries.delete(file);
        return null;
      }
    }
    const read = await safeReadText(file, { extraHomes: this.extraHomes });
    if (!read) {
      this.entries.delete(file);
      return null;
    }
    const chunks = chunkMarkdown(file, read.text);
    this.entries.delete(file);
    this.entries.set(file, { mtimeMs: read.mtimeMs, size: read.size, chunks, checkedAt: now });
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return chunks;
  }

  get size(): number {
    return this.entries.size;
  }
}
