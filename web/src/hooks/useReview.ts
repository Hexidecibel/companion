import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReviewGetRequest, ReviewGetResponse, ReviewScope, ReviewView } from '../types/review';
import { reviewErrorMessage, reviewRequester, type ReviewRequestFn } from '../services/reviewApi';

export const REVIEW_REFETCH_DEBOUNCE_MS = 500;

export interface UseReviewOptions {
  serverId: string | null | undefined;
  sessionId: string | null | undefined;
  scope: ReviewScope;
  view: ReviewView;
  turnId?: string;
  /** Only fetch while the drawer is open. */
  open: boolean;
  /** Current summary version: a change schedules a debounced refetch. */
  version: number | null | undefined;
  /** Injected for tests; defaults to the live connection. */
  request?: ReviewRequestFn;
}

export interface UseReviewResult {
  data: ReviewGetResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
  /** Number of completed fetches (lets the UI pulse "updated"). */
  generation: number;
}

/**
 * Fetches `review_get` for the open drawer. Refetches when the summary version
 * moves, debounced 500 ms, with a single request in flight: anything asked for
 * while a request is running collapses into one trailing request.
 */
export function useReview(opts: UseReviewOptions): UseReviewResult {
  const { serverId, sessionId, scope, view, turnId, open, version } = opts;
  const request = useMemo(() => opts.request ?? reviewRequester(serverId), [opts.request, serverId]);

  const [data, setData] = useState<ReviewGetResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  const key = sessionId ? `${serverId}|${sessionId}|${scope}|${view}|${turnId ?? ''}` : '';
  const keyRef = useRef(key);
  keyRef.current = key;
  const inFlight = useRef(false);
  const rerun = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  const run = useCallback(async () => {
    if (!sessionId) return;
    if (inFlight.current) {
      rerun.current = true;
      return;
    }
    inFlight.current = true;
    const myKey = keyRef.current;
    const req: ReviewGetRequest = { sessionId, scope, view, ...(turnId ? { turnId } : {}) };
    try {
      const res = await request<ReviewGetResponse>('review_get', req, 20000);
      if (alive.current && keyRef.current === myKey) {
        setData(res);
        setError(null);
        setGeneration((g) => g + 1);
      }
    } catch (err) {
      if (alive.current && keyRef.current === myKey) setError(reviewErrorMessage(err));
    } finally {
      inFlight.current = false;
      if (alive.current) setLoading(false);
    }
    if (rerun.current && alive.current) {
      rerun.current = false;
      void runRef.current();
    }
  }, [request, sessionId, scope, view, turnId]);
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, []);

  // Session / scope / view change while open: fetch now. A different session
  // drops what we had; a scope/view switch keeps it until the answer lands.
  const sessionKey = `${serverId}|${sessionId}`;
  const lastSession = useRef(sessionKey);
  useEffect(() => {
    if (lastSession.current !== sessionKey) {
      lastSession.current = sessionKey;
      setData(null);
      setError(null);
    }
    if (!open || !sessionId) return;
    setLoading(true);
    if (inFlight.current) rerun.current = true;
    else void run();
  }, [open, key, sessionKey, sessionId, run]);

  // Summary moved: one debounced refetch.
  const firstVersion = useRef(true);
  useEffect(() => {
    if (firstVersion.current) {
      firstVersion.current = false;
      return;
    }
    if (!open || !sessionId || version == null) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void runRef.current();
    }, REVIEW_REFETCH_DEBOUNCE_MS);
  }, [version, open, sessionId]);

  const refresh = useCallback(() => { void runRef.current(); }, []);

  return { data, loading, error, refresh, generation };
}
