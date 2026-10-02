/**
 * Live edit stream for one session while `on`: sends review_watch {live:true}
 * (again after every reconnect), collects review_live events newest first, and
 * stops watching (live:false) when turned off or unmounted.
 */
import { useEffect, useState } from 'react';
import type { ReviewEdit, ReviewLiveEvent, ReviewWatchRequest } from '../types/review';
import type { WebSocketResponse } from '../types';
import type { ReviewRequestFn } from '../services/reviewApi';
import { connectionManager } from '../services/ConnectionManager';

export const LIVE_FEED_MAX = 40;

export interface LiveEntry {
  edit: ReviewEdit;
  phase: ReviewLiveEvent['phase'];
  at: number;
}

export interface LiveEventSource {
  onMessage: (h: (m: WebSocketResponse) => void) => () => void;
  onReconnect: (h: () => void) => () => void;
}

export function liveSourceFor(serverId: string): LiveEventSource | null {
  const conn = connectionManager.getConnection(serverId);
  if (!conn) return null;
  return { onMessage: (h) => conn.onMessage(h), onReconnect: (h) => conn.onReconnect(h) };
}

/** Merge one event: an edit's later phase replaces its earlier row in place. */
export function applyLiveEvent(list: LiveEntry[], ev: ReviewLiveEvent, now = Date.now()): LiveEntry[] {
  const i = list.findIndex((e) => e.edit.id === ev.edit.id);
  const entry: LiveEntry = { edit: ev.edit, phase: ev.phase, at: now };
  if (i >= 0) {
    const next = list.slice();
    next[i] = entry;
    return next;
  }
  return [entry, ...list].slice(0, LIVE_FEED_MAX);
}

export function useReviewLive(opts: {
  serverId: string;
  sessionId: string;
  on: boolean;
  request: ReviewRequestFn;
  source?: LiveEventSource | null;
}): { entries: LiveEntry[]; error: string | null } {
  const { serverId, sessionId, on, request } = opts;
  const [entries, setEntries] = useState<LiveEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setEntries([]); }, [serverId, sessionId]);

  useEffect(() => {
    if (!on) return;
    const source = opts.source !== undefined ? opts.source : liveSourceFor(serverId);
    const watch = (live: boolean) => {
      const req: ReviewWatchRequest = { sessionId, live };
      return request('review_watch', req).then(() => setError(null)).catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      });
    };
    void watch(true);
    const offMsg = source?.onMessage((m) => {
      if (m.type !== 'review_live') return;
      const ev = m.payload as ReviewLiveEvent | undefined;
      if (!ev || ev.sessionId !== sessionId || !ev.edit) return;
      setEntries((list) => applyLiveEvent(list, ev));
    });
    const offRe = source?.onReconnect(() => { void watch(true); });
    return () => {
      offMsg?.();
      offRe?.();
      void watch(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, serverId, sessionId, request]);

  return { entries, error };
}
