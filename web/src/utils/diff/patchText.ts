/** Plain-text helpers for review hunks: headers, numbering, copyable patches. */
import type { ReviewHunk } from '../../types/review';

export type LineKind = 'add' | 'del' | 'ctx' | 'meta';

export interface NumberedLine {
  index: number;
  kind: LineKind;
  oldNo: number | null;
  newNo: number | null;
  /** Line text without its prefix character. */
  text: string;
}

export function lineKind(line: string): LineKind {
  const c = line[0];
  if (c === '+') return 'add';
  if (c === '-') return 'del';
  if (c === '\\') return 'meta';
  return 'ctx';
}

export function numberHunk(h: ReviewHunk): NumberedLine[] {
  let o = h.oldStart;
  let n = h.newStart;
  return h.lines.map((line, index) => {
    const kind = lineKind(line);
    const text = kind === 'meta' ? line : line.slice(1);
    if (kind === 'add') return { index, kind, oldNo: null, newNo: n++, text };
    if (kind === 'del') return { index, kind, oldNo: o++, newNo: null, text };
    if (kind === 'meta') return { index, kind, oldNo: null, newNo: null, text };
    return { index, kind, oldNo: o++, newNo: n++, text };
  });
}

export function hunkHeader(h: ReviewHunk): string {
  const range = (start: number, len: number) => (len === 1 ? `${start}` : `${start},${len}`);
  return `@@ -${range(h.oldStart, h.oldLines)} +${range(h.newStart, h.newLines)} @@${h.section ? ` ${h.section}` : ''}`;
}

export function hunkPatch(path: string, hunks: ReviewHunk[]): string {
  const body = hunks.map((h) => [hunkHeader(h), ...h.lines].join('\n')).join('\n');
  return `--- a/${path}\n+++ b/${path}\n${body}\n`;
}

export function hunkStats(h: ReviewHunk): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const l of h.lines) {
    if (l[0] === '+') additions++;
    else if (l[0] === '-') deletions++;
  }
  return { additions, deletions };
}

/** "src/a.ts:12-18" (new-side range; a pure deletion uses the old side). */
export function hunkLocation(path: string, h: ReviewHunk): string {
  const useNew = h.newLines > 0;
  const start = useNew ? h.newStart : h.oldStart;
  const len = useNew ? h.newLines : h.oldLines;
  return len > 1 ? `${path}:${start}-${start + len - 1}` : `${path}:${start}`;
}

/**
 * Unchanged lines between hunks (old-side numbering). gaps[i] = lines hidden
 * before hunk i; gaps[0] = lines above the first hunk.
 */
export function hunkGaps(hunks: ReviewHunk[]): number[] {
  const gaps: number[] = [];
  let prevEnd = 1;
  for (const h of hunks) {
    const start = h.oldLines === 0 ? h.oldStart + 1 : h.oldStart;
    gaps.push(Math.max(0, start - prevEnd));
    prevEnd = h.oldStart + h.oldLines;
    if (h.oldLines === 0) prevEnd = h.oldStart + 1;
  }
  return gaps;
}

export function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

export function dirName(path: string): string {
  const i = path.lastIndexOf('/');
  return i > 0 ? path.slice(0, i) : '';
}
