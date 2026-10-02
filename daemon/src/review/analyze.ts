/**
 * Pure review analysis: trivial-change detection, heat, hunk ids, clipping.
 */

import { fnv1a } from '../herald/text';
import { isLockfile } from '../herald/danger';
import type { ReviewHunk, ReviewRiskLevel, ReviewTrivialKind } from './protocol';
import { REVIEW_LIMITS } from './protocol';
import { clipLines } from './diff-parse';

export interface HunkLike {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  section?: string;
  lines: string[];
}

export function isGeneratedPath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, '/').toLowerCase();
  return (
    /(^|\/)(dist|build)\//.test(p) ||
    /\.min\.[a-z0-9]+$/.test(p) ||
    /(^|\/)__snapshots__\//.test(p) ||
    p.endsWith('.snap')
  );
}

/** Every hunk only changes whitespace (removed == added once whitespace is stripped). */
export function isWhitespaceOnly(hunks: HunkLike[]): boolean {
  if (hunks.length === 0) return false;
  let changed = false;
  for (const h of hunks) {
    let removed = '';
    let added = '';
    for (const l of h.lines) {
      if (l.startsWith('-')) {
        removed += l.slice(1);
        changed = true;
      } else if (l.startsWith('+')) {
        added += l.slice(1);
        changed = true;
      }
    }
    if (removed.replace(/\s+/g, '') !== added.replace(/\s+/g, '')) return false;
  }
  return changed;
}

export function trivialKind(relPath: string, hunks: HunkLike[] | null): ReviewTrivialKind | undefined {
  if (isLockfile(relPath)) return 'lockfile';
  if (isGeneratedPath(relPath)) return 'generated';
  if (hunks && isWhitespaceOnly(hunks)) return 'whitespace';
  return undefined;
}

export function hunkTrivial(h: HunkLike): ReviewTrivialKind | undefined {
  return isWhitespaceOnly([h]) ? 'whitespace' : undefined;
}

/**
 * Heat 0..100: 25*log2(1+churn/10) + 15*min(edits,4) + {high:30, medium:15}
 * + 10 when changed in the last 10 minutes.
 */
export function heatScore(
  churn: number,
  edits: number,
  risk: ReviewRiskLevel | null,
  lastChangeAt: number | null,
  now: number
): number {
  let h = 25 * Math.log2(1 + Math.max(0, churn) / 10) + 15 * Math.min(Math.max(edits, 0), 4);
  if (risk === 'high') h += 30;
  else if (risk === 'medium') h += 15;
  if (lastChangeAt !== null && now - lastChangeAt < 10 * 60 * 1000) h += 10;
  return Math.max(0, Math.min(100, Math.round(h)));
}

/** Stable git hunk id: g<fnv1a(absPath + header + lines)>. */
export function gitHunkId(absPath: string, h: HunkLike): string {
  const header = `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
  return `g${fnv1a(`${absPath}\u0001${header}\u0001${h.lines.join('\n')}`)}`;
}

export function toReviewHunk(id: string, h: HunkLike): ReviewHunk {
  const { lines, clipped } = clipLines(h.lines, REVIEW_LIMITS.maxLineChars);
  const trivial = hunkTrivial(h);
  return {
    id,
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
    ...(h.section ? { section: h.section } : {}),
    lines,
    ...(trivial ? { trivial } : {}),
    ...(clipped ? { clipped: true } : {}),
  };
}

export function countHunkLines(hunks: HunkLike[]): number {
  let n = 0;
  for (const h of hunks) n += h.lines.length;
  return n;
}

export function addedLines(hunks: HunkLike[]): string[] {
  const out: string[] = [];
  for (const h of hunks) for (const l of h.lines) if (l.startsWith('+')) out.push(l.slice(1));
  return out;
}

export function removedLines(hunks: HunkLike[]): string[] {
  const out: string[] = [];
  for (const h of hunks) for (const l of h.lines) if (l.startsWith('-')) out.push(l.slice(1));
  return out;
}
