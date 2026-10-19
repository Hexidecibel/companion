import { useState, useEffect } from 'react';
import { ServerSummary, ConnectionState } from '../types';
import { connectionManager } from '../services/ConnectionManager';
import { getServers } from '../services/storage';
import {
  initOfflineCache,
  getCachedSummaries,
  saveSummary,
  onOfflineCacheLoaded,
  forgetServer,
} from '../services/offlineCache';

const POLL_INTERVAL = 5000;
/** A session status event re-polls that server after this (coalesces bursts). */
const EVENT_REPOLL_DELAY = 250;
/** Broadcasts that mean some session's status changed on that server. */
const STATUS_EVENTS = new Set(['status_change', 'other_session_activity', 'session_completed']);

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Merge a fresh summary into the previous one by stable keys: unchanged
 * sessions keep their object identity (memoized rows do not re-render) and an
 * entirely unchanged summary returns `prev` itself.
 */
export function mergeSummary(prev: ServerSummary | undefined, next: ServerSummary): ServerSummary {
  if (!prev) return next;
  const prevById = new Map(prev.sessions.map((s) => [s.id, s]));
  let changed =
    prev.sessions.length !== next.sessions.length ||
    !sameJson({ ...prev, sessions: [] }, { ...next, sessions: [] });
  const sessions = next.sessions.map((s, i) => {
    const old = prevById.get(s.id);
    if (old && sameJson(old, s)) {
      if (prev.sessions[i] !== old) changed = true; // reordered
      return old;
    }
    changed = true;
    return s;
  });
  return changed ? { ...next, sessions } : prev;
}

/** Server ids the app still knows about (saved list + live connections). */
function knownServerIds(): Set<string> {
  const ids = new Set(getServers().map((s) => s.id));
  for (const snap of connectionManager.getSnapshots()) ids.add(snap.serverId);
  return ids;
}

function seedFromCache(): Map<string, ServerSummary> {
  const known = knownServerIds();
  const seeded = new Map<string, ServerSummary>();
  for (const [id, row] of getCachedSummaries()) {
    if (known.has(id)) seeded.set(id, row.summary);
  }
  return seeded;
}

/**
 * Polls `get_server_summary` on every connected server every 5 s and returns a
 * Map<serverId, ServerSummary>, stale-while-revalidate:
 *  - starts from the offline cache (last good summary per server), so the
 *    session list renders before (or without) a connection;
 *  - a failed refresh or a disconnect keeps the last good summary;
 *  - one request in flight per server (per connection), out-of-order answers
 *    are discarded, and the Map keeps its identity when nothing changed;
 *  - re-polls a server right away when it (re)connects, and shortly after a
 *    session status event from it (a poll already in flight is followed by
 *    one more, so a change during it is never left for the next interval).
 */
export function useAllServerSummaries(): Map<string, ServerSummary> {
  const [summaries, setSummaries] = useState<Map<string, ServerSummary>>(seedFromCache);

  useEffect(() => {
    let cancelled = false;
    /** serverId -> the connection generation (lastConnected) that request was sent on. */
    const inFlight = new Map<string, number>();
    const issued = new Map<string, number>();
    const applied = new Map<string, number>();
    const lastStatus = new Map<string, ConnectionState['status']>();
    /** Servers that asked for a poll while one was in flight. */
    const repoll = new Set<string>();
    const eventTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const messageSubs = new Map<string, { conn: unknown; unsub: () => void }>();

    const apply = (serverId: string, fresh: ServerSummary) => {
      setSummaries((prev) => {
        const old = prev.get(serverId);
        const merged = mergeSummary(old, fresh);
        if (merged === old) return prev;
        const next = new Map(prev);
        next.set(serverId, merged);
        return next;
      });
    };

    const prune = () => {
      const known = knownServerIds();
      setSummaries((prev) => {
        let next: Map<string, ServerSummary> | null = null;
        for (const id of prev.keys()) {
          if (known.has(id)) continue;
          if (!next) next = new Map(prev);
          next.delete(id);
          void forgetServer(id);
        }
        return next ?? prev;
      });
    };

    async function pollServer(serverId: string) {
      const conn = connectionManager.getConnection(serverId);
      if (!conn || !conn.isConnected()) return;
      const generation = conn.getState().lastConnected ?? 0;
      // One request at a time per server. A request still pending from an
      // older connection (generation) does not block the new one.
      if (inFlight.has(serverId) && inFlight.get(serverId) === generation) {
        repoll.add(serverId);
        return;
      }
      inFlight.set(serverId, generation);
      const seq = (issued.get(serverId) ?? 0) + 1;
      issued.set(serverId, seq);
      try {
        const response = await conn.sendRequest('get_server_summary');
        if (cancelled) return;
        if (seq < (applied.get(serverId) ?? 0)) return; // an older answer arriving late
        if (response.success && response.payload) {
          applied.set(serverId, seq);
          const fresh = response.payload as ServerSummary;
          if (!Array.isArray(fresh.sessions)) return;
          saveSummary(serverId, fresh);
          apply(serverId, fresh);
        }
        // A failed refresh keeps the last good summary.
      } catch {
        // Timeout / dropped connection: keep the last good summary.
      } finally {
        if (inFlight.get(serverId) === generation) inFlight.delete(serverId);
        if (!cancelled && repoll.delete(serverId)) void pollServer(serverId);
      }
    }

    function schedulePoll(serverId: string) {
      if (eventTimers.has(serverId)) return;
      eventTimers.set(serverId, setTimeout(() => {
        eventTimers.delete(serverId);
        if (!cancelled) void pollServer(serverId);
      }, EVENT_REPOLL_DELAY));
    }

    /** Listen on each server's connection for session status broadcasts. */
    function syncMessageSubs() {
      const live = new Set<string>();
      for (const snap of connectionManager.getSnapshots()) {
        const conn = connectionManager.getConnection(snap.serverId);
        if (!conn || typeof conn.onMessage !== 'function') continue;
        live.add(snap.serverId);
        const cur = messageSubs.get(snap.serverId);
        if (cur && cur.conn === conn) continue;
        cur?.unsub();
        const serverId = snap.serverId;
        const unsub = conn.onMessage((msg) => {
          if (STATUS_EVENTS.has(msg.type)) schedulePoll(serverId);
        });
        messageSubs.set(serverId, { conn, unsub });
      }
      for (const [id, sub] of [...messageSubs]) {
        if (!live.has(id)) { sub.unsub(); messageSubs.delete(id); }
      }
    }

    function pollAll() {
      for (const snap of connectionManager.getSnapshots()) {
        if (snap.state.status === 'connected') void pollServer(snap.serverId);
      }
    }

    // Cached summaries that finish loading after mount fill servers we have no
    // live answer for yet (never overwrite fresher data).
    void initOfflineCache();
    const unsubCache = onOfflineCacheLoaded(() => {
      if (cancelled) return;
      const known = knownServerIds();
      setSummaries((prev) => {
        let next: Map<string, ServerSummary> | null = null;
        for (const [id, row] of getCachedSummaries()) {
          if (prev.has(id) || !known.has(id)) continue;
          if (!next) next = new Map(prev);
          next.set(id, row.summary);
        }
        return next ?? prev;
      });
    });

    for (const snap of connectionManager.getSnapshots()) lastStatus.set(snap.serverId, snap.state.status);
    syncMessageSubs();
    pollAll();
    const timer = setInterval(pollAll, POLL_INTERVAL);

    // Re-poll a server only when it transitions to connected; prune servers
    // that were removed from the app.
    const unsub = connectionManager.onChange((snapshots) => {
      for (const snap of snapshots) {
        const before = lastStatus.get(snap.serverId);
        lastStatus.set(snap.serverId, snap.state.status);
        if (snap.state.status === 'connected' && before !== 'connected') void pollServer(snap.serverId);
      }
      for (const id of [...lastStatus.keys()]) {
        if (!snapshots.some((s) => s.serverId === id)) lastStatus.delete(id);
      }
      syncMessageSubs();
      prune();
    });

    return () => {
      cancelled = true;
      clearInterval(timer);
      unsub();
      unsubCache();
      for (const t of eventTimers.values()) clearTimeout(t);
      for (const sub of messageSubs.values()) sub.unsub();
    };
  }, []);

  return summaries;
}
