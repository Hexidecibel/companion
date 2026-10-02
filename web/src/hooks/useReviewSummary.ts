import { useMemo, useSyncExternalStore } from 'react';
import type { ReviewSummary } from '../types/review';
import { ensureReviewStore, reviewStore } from '../services/reviewStore';

const subscribe = (cb: () => void) => ensureReviewStore().subscribe(cb);
const tick = () => reviewStore.getTick();

/** Live review summary for one session (null until known / unsupported). */
export function useReviewSummary(serverId: string | null | undefined, sessionId: string | null | undefined): ReviewSummary | null {
  useSyncExternalStore(subscribe, tick, tick);
  return reviewStore.get(serverId, sessionId);
}

/** All summaries on a server, keyed by sessionId (sidebar pills). */
export function useReviewSummaries(serverId: string | null | undefined): Map<string, ReviewSummary> {
  const t = useSyncExternalStore(subscribe, tick, tick);
  return useMemo(() => {
    void t;
    const out = new Map<string, ReviewSummary>();
    if (!serverId) return out;
    for (const s of reviewStore.all(serverId)) out.set(s.sessionId, s);
    return out;
  }, [serverId, t]);
}

/** Whether the server's daemon speaks Code Review (null = not known yet). */
export function useReviewSupported(serverId: string | null | undefined): boolean | null {
  useSyncExternalStore(subscribe, tick, tick);
  return reviewStore.supported(serverId);
}
