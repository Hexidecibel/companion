/**
 * Mission Control tile order, saved per device. Tiles keep their place: new
 * sessions join at the end, removed ones drop out, and the user moves a tile
 * with long-press "Move up / down". Nothing reorders on its own, so a tile
 * never jumps under the user's finger.
 */

export const MISSION_ORDER_KEY = 'companion_mission_order';

/** Stable key for a session on a server (JSON, so ids may hold any character). */
export function missionKey(serverId: string, sessionId: string): string {
  return JSON.stringify([serverId, sessionId]);
}

export function parseMissionKey(key: string): { serverId: string; sessionId: string } | null {
  try {
    const v = JSON.parse(key);
    if (Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string') {
      return { serverId: v[0], sessionId: v[1] };
    }
  } catch {
    // not a mission key
  }
  return null;
}

/**
 * Saved order + the live sessions -> the order to show. Saved keys stay in
 * place, live keys not seen before go at the end (in the given order), and
 * keys whose session is gone are dropped, except for servers that are not in
 * the summaries at all (offline / still loading): those keep their slot so the
 * tiles come back where they were.
 */
export function reconcileOrder(saved: string[], live: string[], knownServerIds: Set<string>): string[] {
  const liveSet = new Set(live);
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const k of saved) {
    if (seen.has(k)) continue;
    const ref = parseMissionKey(k);
    if (!ref) continue;
    if (liveSet.has(k) || !knownServerIds.has(ref.serverId)) {
      kept.push(k);
      seen.add(k);
    }
  }
  for (const k of live) {
    if (!seen.has(k)) {
      kept.push(k);
      seen.add(k);
    }
  }
  return kept;
}

/**
 * Move a key one step up (-1) or down (1) past the next VISIBLE key (keys of
 * offline servers in between are skipped over). Returns the same array when
 * it cannot move.
 */
export function moveInOrder(order: string[], key: string, dir: -1 | 1, visible?: Set<string>): string[] {
  const from = order.indexOf(key);
  if (from < 0) return order;
  let to = from + dir;
  while (to >= 0 && to < order.length && visible && !visible.has(order[to])) to += dir;
  if (to < 0 || to >= order.length) return order;
  const next = [...order];
  next[from] = order[to];
  next[to] = key;
  return next;
}

// --- Store (localStorage + subscribers, shared by Dashboard and MissionControl) ---

let cache: string[] | null = null;
const listeners = new Set<() => void>();

export function loadMissionOrder(): string[] {
  if (cache) return cache;
  let parsed: string[] = [];
  try {
    const raw = localStorage.getItem(MISSION_ORDER_KEY);
    const v = raw ? JSON.parse(raw) : [];
    if (Array.isArray(v)) parsed = v.filter((x): x is string => typeof x === 'string');
  } catch {
    parsed = [];
  }
  cache = parsed;
  return cache;
}

export function saveMissionOrder(order: string[]): void {
  const prev = loadMissionOrder();
  if (prev.length === order.length && prev.every((k, i) => k === order[i])) return;
  cache = order;
  try {
    localStorage.setItem(MISSION_ORDER_KEY, JSON.stringify(order));
  } catch {
    // storage full / blocked: the order still holds for this run
  }
  for (const l of listeners) l();
}

export function onMissionOrderChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Tests: forget the in-memory copy. */
export function resetMissionOrderCache(): void {
  cache = null;
}
