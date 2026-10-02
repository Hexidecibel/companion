/**
 * Intraline (word) diffs for a unified hunk.
 *
 * Each block of consecutive `-` lines is paired with the block of `+` lines
 * that immediately follows it; lines inside the pair are aligned in order by
 * best similarity (see computeIntraline). Each pair is diffed with
 * jsdiff's diffWordsWithSpace and the changed ranges are returned per line, in
 * the line's own coordinates (prefix character excluded).
 *
 * Skipped (no word marks, the row colour alone carries it):
 *   - lines longer than MAX_LINE_CHARS,
 *   - hunks longer than MAX_HUNK_LINES,
 *   - pairs whose similarity is below MIN_SIMILARITY (a rewrite, not an edit:
 *     marking nearly every word is noise).
 */
import { diffWordsWithSpace } from 'diff';

export const INTRALINE_MAX_LINE_CHARS = 500;
export const INTRALINE_MAX_HUNK_LINES = 400;
export const INTRALINE_MIN_SIMILARITY = 0.3;
/** How many added lines ahead a removed line may look for its partner. */
export const INTRALINE_LOOKAHEAD = 6;

export interface Range {
  start: number;
  end: number;
}

/** Map from hunk line index to the changed ranges in that line's text. */
export type IntralineMarks = Map<number, Range[]>;

export function pairBlocks(lines: string[]): Array<{ removed: number[]; added: number[] }> {
  const out: Array<{ removed: number[]; added: number[] }> = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith('-')) {
      const removed: number[] = [];
      while (i < lines.length && lines[i].startsWith('-')) removed.push(i++);
      // A "\ No newline" marker may sit between the blocks.
      while (i < lines.length && lines[i].startsWith('\\')) i++;
      const added: number[] = [];
      while (i < lines.length && lines[i].startsWith('+')) added.push(i++);
      if (added.length > 0) out.push({ removed, added });
    } else {
      i++;
    }
  }
  return out;
}

/** Similarity 0..1: share of characters left unchanged by the word diff. */
export function wordDiff(a: string, b: string): { similarity: number; removed: Range[]; added: Range[] } {
  const parts = diffWordsWithSpace(a, b);
  const removed: Range[] = [];
  const added: Range[] = [];
  let ia = 0;
  let ib = 0;
  let same = 0;
  for (const p of parts) {
    const n = p.value.length;
    if (p.added) {
      pushRange(added, ib, ib + n);
      ib += n;
    } else if (p.removed) {
      pushRange(removed, ia, ia + n);
      ia += n;
    } else {
      same += n;
      ia += n;
      ib += n;
    }
  }
  const total = a.length + b.length;
  const similarity = total === 0 ? 1 : (2 * same) / total;
  return { similarity, removed, added };
}

function pushRange(list: Range[], start: number, end: number): void {
  if (end <= start) return;
  const last = list[list.length - 1];
  if (last && last.end === start) last.end = end;
  else list.push({ start, end });
}

export function computeIntraline(lines: string[]): IntralineMarks {
  const marks: IntralineMarks = new Map();
  if (lines.length > INTRALINE_MAX_HUNK_LINES) return marks;
  for (const { removed, added } of pairBlocks(lines)) {
    // Within the paired blocks, align lines in order: each removed line takes
    // the most similar later added line (a monotonic greedy match), so an
    // inserted comment line does not shift every pairing after it.
    let nextJ = 0;
    for (const ri of removed) {
      const a = lines[ri].slice(1);
      if (a.length > INTRALINE_MAX_LINE_CHARS) continue;
      let best: { j: number; d: ReturnType<typeof wordDiff> } | null = null;
      for (let j = nextJ; j < added.length && j < nextJ + INTRALINE_LOOKAHEAD; j++) {
        const b = lines[added[j]].slice(1);
        if (b.length > INTRALINE_MAX_LINE_CHARS || a === b) continue;
        const d = wordDiff(a, b);
        if (d.similarity >= INTRALINE_MIN_SIMILARITY && (!best || d.similarity > best.d.similarity)) best = { j, d };
      }
      if (!best) continue;
      nextJ = best.j + 1;
      if (best.d.removed.length) marks.set(ri, best.d.removed);
      if (best.d.added.length) marks.set(added[best.j], best.d.added);
    }
  }
  return marks;
}
