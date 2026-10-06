import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { HeraldBabysit } from '../types/herald';
import { babysitForSession, babysitStore, type BabysitSnapshot } from '../services/babysit';

export function useBabysitSnapshot(): BabysitSnapshot {
  return useSyncExternalStore(babysitStore.subscribe, babysitStore.get, babysitStore.get);
}

export interface SessionBabysit {
  /**
   * Babysitting can be used for this session: it lives on the Herald hub and
   * the hub reports briefs. False for sessions on any other server and for
   * older hubs: render nothing then.
   */
  available: boolean;
  connected: boolean;
  /** The session's active brief, else its most recently ended one (kept about an hour). */
  babysit: HeraldBabysit | null;
  active: boolean;
  skewMs: number | null;
}

/** The babysit brief of one session, matched against the Herald hub. */
export function useBabysit(serverId: string | null | undefined, sessionId: string | null | undefined): SessionBabysit {
  const snap = useBabysitSnapshot();
  return useMemo(() => {
    const available = !!serverId && !!sessionId && snap.supported && serverId === snap.hostId;
    const babysit = available ? babysitForSession(snap, serverId, sessionId) : null;
    return { available, connected: snap.connected, babysit, active: babysit?.status === 'active', skewMs: snap.skewMs };
  }, [snap, serverId, sessionId]);
}

/** Local time, re-read every `intervalMs` while `active` (for "26 min left"). */
export function useBabysitClock(active: boolean, intervalMs = 20_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs]);
  return now;
}
