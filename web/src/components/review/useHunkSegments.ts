/**
 * Highlighted + word-diffed segments for a file's hunks, computed lazily:
 * only while the file is expanded, one hunk per idle slot (so a big file never
 * blocks a frame), memoized by hunk id (ids are stable across fetches).
 */
import { useEffect, useState } from 'react';
import type { ReviewHunk } from '../../types/review';
import { computeIntraline } from '../../utils/diff/intraline';
import { highlightHunk, type Segment } from '../../utils/diff/highlight';

const CACHE_MAX = 400;
const cache = new Map<string, Segment[][]>();

function cacheKey(h: ReviewHunk, path: string): string {
  return `${path}\u0000${h.id}\u0000${h.lines.length}`;
}

export function segmentsFor(h: ReviewHunk, path: string): Segment[][] {
  const key = cacheKey(h, path);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const segs = highlightHunk(h.lines, path, computeIntraline(h.lines));
  cache.set(key, segs);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return segs;
}

type IdleHandle = number;
const ric: (cb: () => void) => IdleHandle =
  typeof window !== 'undefined' && 'requestIdleCallback' in window
    ? (cb) => (window as unknown as { requestIdleCallback: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback(cb, { timeout: 200 })
    : (cb) => setTimeout(cb, 16) as unknown as number;
const cic: (h: IdleHandle) => void =
  typeof window !== 'undefined' && 'cancelIdleCallback' in window
    ? (h) => (window as unknown as { cancelIdleCallback: (h: number) => void }).cancelIdleCallback(h)
    : (h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>);

export function useHunkSegments(hunks: ReviewHunk[] | null, path: string, enabled: boolean): Map<string, Segment[][]> {
  const [map, setMap] = useState<Map<string, Segment[][]>>(() => new Map());

  useEffect(() => {
    if (!enabled || !hunks || hunks.length === 0) return;
    // Cached hunks land synchronously; the rest one per idle slot.
    const ready = new Map<string, Segment[][]>();
    const todo: ReviewHunk[] = [];
    for (const h of hunks) {
      const hit = cache.get(cacheKey(h, path));
      if (hit) ready.set(h.id, hit);
      else todo.push(h);
    }
    setMap(ready);
    if (todo.length === 0) return;
    let handle: IdleHandle | null = null;
    let cancelled = false;
    const step = () => {
      handle = null;
      if (cancelled) return;
      const h = todo.shift();
      if (!h) return;
      const segs = segmentsFor(h, path);
      setMap((m) => {
        const next = new Map(m);
        next.set(h.id, segs);
        return next;
      });
      if (todo.length) handle = ric(step);
    };
    handle = ric(step);
    return () => {
      cancelled = true;
      if (handle != null) cic(handle);
    };
  }, [hunks, path, enabled]);

  return map;
}
