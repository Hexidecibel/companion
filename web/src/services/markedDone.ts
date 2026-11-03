/**
 * "Mark done": a per-device manual override for when the automatic
 * needs_you / done classification is wrong. A marked session reads as viewed
 * and done (Quiet section, not in Needs-you counts or nextWaiting) until it has
 * anything new: more activity, working again, or a different prompt. A mark
 * never hides a NEW question. Saved in localStorage as
 * { [missionKey]: { at, lastActivity, signature? } }.
 */
import type { SessionSummary } from '../types';
import { missionKey, parseMissionKey } from './missionOrder';

export const MARKED_DONE_KEY = 'companion_marked_done';

export interface DoneMark {
  /** When it was marked (ms). */
  at: number;
  /** The session's lastActivity when marked. */
  lastActivity: number;
  /** Signature of the prompt that was live when marked, if any. */
  signature?: string;
}

type Marks = Record<string, DoneMark>;

let cache: Marks | null = null;
let version = 0;
const listeners = new Set<() => void>();

function load(): Marks {
  if (cache) return cache;
  let parsed: Marks = {};
  try {
    const raw = localStorage.getItem(MARKED_DONE_KEY);
    const v = raw ? JSON.parse(raw) : null;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, m] of Object.entries(v as Record<string, unknown>)) {
        const mark = m as Partial<DoneMark> | null;
        if (mark && typeof mark.at === 'number' && typeof mark.lastActivity === 'number') {
          parsed[k] = {
            at: mark.at,
            lastActivity: mark.lastActivity,
            ...(typeof mark.signature === 'string' ? { signature: mark.signature } : {}),
          };
        }
      }
    }
  } catch {
    parsed = {};
  }
  cache = parsed;
  return cache;
}

function save(next: Marks, notify: boolean): void {
  cache = next;
  try {
    localStorage.setItem(MARKED_DONE_KEY, JSON.stringify(next));
  } catch {
    // blocked / full: in-memory only
  }
  if (notify) {
    version++;
    for (const l of listeners) l();
  }
}

/** Does this mark still hold for the session as it is now? Pure. */
export function markApplies(mark: DoneMark, s: SessionSummary): boolean {
  if (s.status === 'working') return false;
  if (s.lastActivity > mark.lastActivity) return false;
  if (s.pendingPrompt && s.pendingPrompt.signature !== mark.signature) return false;
  return true;
}

export function markDone(serverId: string, s: SessionSummary, now = Date.now()): void {
  const mark: DoneMark = {
    at: now,
    lastActivity: s.lastActivity,
    ...(s.pendingPrompt ? { signature: s.pendingPrompt.signature } : {}),
  };
  save({ ...load(), [missionKey(serverId, s.id)]: mark }, true);
}

export function unmarkDone(serverId: string, sessionId: string): void {
  const key = missionKey(serverId, sessionId);
  const marks = load();
  if (!(key in marks)) return;
  const next = { ...marks };
  delete next[key];
  save(next, true);
}

export function getDoneMark(serverId: string, sessionId: string): DoneMark | undefined {
  return load()[missionKey(serverId, sessionId)];
}

/**
 * Is the session marked done right now? A mark the session has outgrown is
 * removed on the spot (without a change notification: callers are usually
 * rendering, and the answer is already "no").
 */
export function isMarkedDone(serverId: string, s: SessionSummary): boolean {
  const key = missionKey(serverId, s.id);
  const marks = load();
  const mark = marks[key];
  if (!mark) return false;
  if (markApplies(mark, s)) return true;
  const next = { ...marks };
  delete next[key];
  save(next, false);
  return false;
}

/**
 * Drop marks for sessions that are gone. Only servers whose summary is known
 * are pruned, so a server that is reconnecting keeps its marks.
 */
export function pruneMarkedDone(liveKeys: Set<string>, knownServerIds: Set<string>): void {
  const marks = load();
  let changed = false;
  const next: Marks = {};
  for (const [key, mark] of Object.entries(marks)) {
    const ref = parseMissionKey(key);
    if (ref && knownServerIds.has(ref.serverId) && !liveKeys.has(key)) {
      changed = true;
      continue;
    }
    next[key] = mark;
  }
  if (changed) save(next, true);
}

export function onMarkedDoneChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Bumps on every mark / unmark / prune (for useSyncExternalStore). */
export function getMarkedDoneVersion(): number {
  return version;
}

/** Tests: forget the in-memory copy. */
export function resetMarkedDoneCache(): void {
  cache = null;
}
