/**
 * When this device last looked at each session, so a Mission Control tile can
 * show an "unseen" dot when the session did something since. Saved in
 * localStorage as { [missionKey]: ms }. A session never opened on this device
 * counts as seen up to the moment this store was first used, so the first
 * launch does not light up every tile.
 */
import { missionKey } from './missionOrder';

export const LAST_VIEWED_KEY = 'companion_last_viewed';
/** Keep at most this many entries (oldest dropped). */
export const LAST_VIEWED_MAX = 300;

interface Stored {
  baseline: number;
  seen: Record<string, number>;
}

let cache: Stored | null = null;
const listeners = new Set<() => void>();

function load(now: number): Stored {
  if (cache) return cache;
  let parsed: Stored | null = null;
  try {
    const raw = localStorage.getItem(LAST_VIEWED_KEY);
    const v = raw ? JSON.parse(raw) : null;
    if (v && typeof v === 'object' && typeof v.baseline === 'number' && v.seen && typeof v.seen === 'object') {
      parsed = { baseline: v.baseline, seen: { ...v.seen } };
    }
  } catch {
    parsed = null;
  }
  if (!parsed) {
    parsed = { baseline: now, seen: {} };
    persist(parsed);
  }
  cache = parsed;
  return cache;
}

function persist(data: Stored): void {
  try {
    localStorage.setItem(LAST_VIEWED_KEY, JSON.stringify(data));
  } catch {
    // blocked / full: in-memory only
  }
}

export function getLastViewed(serverId: string, sessionId: string, now = Date.now()): number {
  const d = load(now);
  return d.seen[missionKey(serverId, sessionId)] ?? d.baseline;
}

export function markViewed(serverId: string, sessionId: string, now = Date.now()): void {
  const d = load(now);
  const seen = { ...d.seen, [missionKey(serverId, sessionId)]: now };
  const keys = Object.keys(seen);
  if (keys.length > LAST_VIEWED_MAX) {
    keys.sort((a, b) => seen[a] - seen[b]);
    for (const key of keys.slice(0, keys.length - LAST_VIEWED_MAX)) delete seen[key];
  }
  cache = { baseline: d.baseline, seen };
  persist(cache);
  for (const l of listeners) l();
}

/** Did the session do something since this device last looked at it? */
export function isUnseen(serverId: string, sessionId: string, lastActivity: number, now = Date.now()): boolean {
  return lastActivity > getLastViewed(serverId, sessionId, now);
}

export function onLastViewedChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Tests: forget the in-memory copy. */
export function resetLastViewedCache(): void {
  cache = null;
}
