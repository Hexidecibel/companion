import { useState, useEffect, useRef, useCallback } from 'react';
import { ConversationHighlight, SessionStatus } from '../types';
import { connectionManager } from '../services/ConnectionManager';
import {
  getCachedHighlights,
  setCachedHighlights,
  highlightEqual,
} from '../services/SessionCache';
import { beginSwitch, isValid } from '../services/SessionGuard';
import { loadConversation, saveConversation } from '../services/offlineCache';
import { isMobileViewport } from '../utils/platform';

const POLL_INTERVAL = 30000;
const PAGE_SIZE = isMobileViewport() ? 20 : 50;
/** When a poll's tail no longer overlaps what we have, refetch at most this many. */
const GAP_REFETCH_LIMIT = 200;

/**
 * Result of a send: true = delivered (or queued while offline), false = not
 * sent (refused / failed before it left), 'uncertain' = it went out but no
 * answer came back (timeout / connection lost): the daemon may have typed it.
 */
export type SendOutcome = boolean | 'uncertain';

interface UseConversationReturn {
  highlights: ConversationHighlight[];
  status: SessionStatus | null;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  firstItemIndex: number;
  sendInput: (text: string, opts?: { skipOptimistic?: boolean }) => Promise<boolean>;
  /** Like sendInput, but tells a timeout ('uncertain') apart from a failure. */
  sendInputDetailed: (text: string, opts?: { skipOptimistic?: boolean }) => Promise<SendOutcome>;
  /** The server connection is live (false = showing cached data). */
  connected: boolean;
  /** Why the last send was refused by the daemon's input guard (unsent draft / typing). */
  sendError: string | null;
  clearSendError: () => void;
  cancelMessage: (clientMessageId: string) => Promise<string | null>;
  addOptimisticMessage: (text: string) => void;
  loadMore: () => void;
}

let clientMessageCounter = 0;

/**
 * Identify optimistic messages added client-side (not yet in server data).
 */
function isOptimistic(h: ConversationHighlight): boolean {
  return h.id.startsWith('sent-') || h.id.startsWith('terminal-');
}

/** A fresh status differs from what we show in a way the UI renders. */
export function statusChanged(cur: SessionStatus | null, ns: SessionStatus): boolean {
  return (
    !cur ||
    ns.isRunning !== cur.isRunning ||
    ns.isWaitingForInput !== cur.isWaitingForInput ||
    ns.lastActivity !== cur.lastActivity ||
    ns.currentActivity !== cur.currentActivity ||
    ns.conversationId !== cur.conversationId ||
    (ns.feedbackPrompt != null) !== (cur.feedbackPrompt != null) ||
    (ns.backgroundWork?.agents ?? 0) !== (cur.backgroundWork?.agents ?? 0) ||
    (ns.backgroundWork?.shells ?? 0) !== (cur.backgroundWork?.shells ?? 0)
  );
}

/** A get_status answer for another session (a late reply after a switch) is not ours. */
function statusIsFor(response: { sessionId?: string }, sessionId: string): boolean {
  return !response.sessionId || response.sessionId === sessionId;
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Merge a server page into what we already show, by stable id: unchanged
 * messages keep their object identity (memoized bubbles skip re-rendering
 * markdown), and if the tail overlaps the current list the older messages
 * already loaded are kept. Returns `prev` itself when nothing changed, and
 * `null` when the page does not overlap `prev` at all (a gap).
 */
export function mergeTail(
  prev: ConversationHighlight[],
  tail: ConversationHighlight[],
): ConversationHighlight[] | null {
  if (prev.length === 0) return tail;
  if (tail.length === 0) return prev.length === 0 ? prev : tail;
  const start = prev.findIndex((h) => h.id === tail[0].id);
  if (start === -1) {
    // The page begins before (or at a different place than) our list: if it
    // contains our first message it is a superset, else it is a gap.
    const prevIds = new Set(prev.map((h) => h.id));
    if (!tail.some((h) => prevIds.has(h.id))) return null;
  }
  const head = start === -1 ? [] : prev.slice(0, start);
  const byId = new Map(prev.map((h) => [h.id, h]));
  let changed = start === -1 || prev.length - start !== tail.length;
  const merged = tail.map((h, i) => {
    const old = byId.get(h.id);
    if (old && highlightEqual(old, h) && sameJson(old, h)) {
      if (!changed && prev[start + i] !== old) changed = true;
      return old;
    }
    changed = true;
    return h;
  });
  return changed ? [...head, ...merged] : prev;
}

/**
 * Merge server highlights with locally-sent optimistic messages.
 * Drops optimistic messages that match server data by content or ID.
 * Inserts remaining ones at the correct chronological position.
 */
function mergeWithOptimistic(
  prev: ConversationHighlight[],
  server: ConversationHighlight[],
): ConversationHighlight[] {
  const optimistic = prev.filter(isOptimistic);
  if (optimistic.length === 0) return server;

  // If a compaction occurred after optimistic messages were created,
  // the conversation was summarized and optimistic messages were consumed.
  const oldestOptTime = Math.min(...optimistic.map((o) => o.timestamp));
  const hasRecentCompaction = server.some(
    (h) => h.isCompaction && h.timestamp > oldestOptTime,
  );
  if (hasRecentCompaction) return server;

  // Match optimistic messages against server data by content or ID
  const serverUserIds = new Set(
    server.filter((h) => h.type === 'user').map((h) => h.id),
  );
  const serverUserContent = new Set(
    server
      .filter((h) => h.type === 'user')
      .slice(-optimistic.length * 2)
      .map((h) => h.content.trim()),
  );

  const stillOptimistic = optimistic.filter(
    (o) =>
      !serverUserIds.has(o.id) && !serverUserContent.has(o.content.trim()),
  );

  if (stillOptimistic.length === 0) return server;

  // Insert optimistic messages at the correct position by timestamp
  const merged = [...server];
  for (const opt of stillOptimistic) {
    let insertIdx = merged.length;
    for (let i = merged.length - 1; i >= 0; i--) {
      if (merged[i].timestamp <= opt.timestamp) {
        insertIdx = i + 1;
        break;
      }
      if (i === 0) insertIdx = 0;
    }
    merged.splice(insertIdx, 0, opt);
  }
  return merged;
}

/**
 * User-facing text for a refused send: the daemon's input guard declines to
 * type over an unsent draft in the terminal or while someone is typing there.
 * Other failures return null (the input bar keeps the text, as before).
 */
export function describeSendError(error: string | undefined, payload?: unknown): string | null {
  const message = (payload as { message?: unknown } | undefined)?.message;
  if (error === 'prompt_has_draft' || error === 'user_typing') {
    if (typeof message === 'string' && message) return message;
    return error === 'prompt_has_draft'
      ? 'Not sent: the prompt has an unsent draft in the terminal. Send or clear it there, then try again.'
      : 'Not sent: someone is typing in the terminal right now. Try again in a moment.';
  }
  return null;
}

export function useConversation(
  serverId: string | null,
  sessionId: string | null,
  tmuxSessionName?: string,
): UseConversationReturn {
  const [highlights, setHighlights] = useState<ConversationHighlight[]>([]);
  /** Why the last send was refused (the daemon's input guard), shown as a banner. */
  const [sendError, setSendError] = useState<string | null>(null);
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [firstItemIndex, setFirstItemIndex] = useState(1_000_000);
  const [connected, setConnected] = useState(false);

  const highlightsRef = useRef(highlights);
  highlightsRef.current = highlights;
  const statusRef = useRef(status);
  statusRef.current = status;
  const epochRef = useRef(0);

  // Fetch highlights and status when session changes
  useEffect(() => {
    if (!serverId || !sessionId) {
      setHighlights([]);
      setStatus(null);
      setLoading(false);
      setError(null);
      setHasMore(false);
      setFirstItemIndex(1_000_000);
      return;
    }

    const guardEpoch = beginSwitch(serverId, sessionId);
    epochRef.current = guardEpoch;
    // The previous session's status must never show for this one (an old
    // "Waiting for input" banner stayed up until this session's first answer).
    setStatus(null);
    statusRef.current = null;

    // Show cached data immediately: memory first, then the offline cache.
    const cached = getCachedHighlights(serverId, sessionId);
    let cancelled = false;
    setError(null);
    if (cached) {
      setHighlights(cached);
      setLoading(false);
    } else {
      setHighlights([]);
      setLoading(true);
      void loadConversation(serverId, sessionId).then((row) => {
        if (cancelled || !row || row.highlights.length === 0 || !isValid(serverId, sessionId, guardEpoch)) return;
        // Only while nothing fresher arrived: never replace live data with cache.
        if (highlightsRef.current.length > 0) return;
        setHighlights(row.highlights);
        setLoading(false);
        setError(null);
      });
    }

    const remember = (list: ConversationHighlight[]) => {
      setCachedHighlights(serverId, sessionId, list);
      saveConversation(serverId, sessionId, list.filter((h) => !isOptimistic(h)));
    };

    const conn = connectionManager.getConnection(serverId);
    if (!conn) {
      // No connection object at all (server removed): show cache if any.
      setConnected(false);
      setLoading(false);
      if (!cached) setError('Server not connected');
      return () => { cancelled = true; };
    }

    const hadCache = !!cached;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let pollInFlight = false;
    let pollDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    let unsubMessage: (() => void) | null = null;
    let unsubState: (() => void) | null = null;
    // Tracks whether we've already subscribed + fetched for the current live
    // socket. Reset whenever the socket drops so the next 'connected' transition
    // re-activates this session (re-subscribe + refetch) without the user having
    // to recreate it.
    let activatedForConnection = false;

    async function fetchData() {
      if (!conn || cancelled) return;

      try {
        const [hlResponse, statusResponse] = await Promise.all([
          conn.sendRequest('get_highlights', { limit: PAGE_SIZE, sessionId }),
          conn.sendRequest('get_status', { sessionId }),
        ]);

        if (cancelled || !isValid(serverId!, sessionId!, guardEpoch)) return;

        if (hlResponse.success && hlResponse.payload) {
          const payload = hlResponse.payload as {
            highlights: ConversationHighlight[];
            total: number;
            hasMore: boolean;
          };
          const prev = highlightsRef.current;
          const prevReal = prev.filter((h) => !isOptimistic(h));
          // Merge by id instead of swapping in a whole new list (a reconnect
          // used to re-render every bubble); a gap replaces it.
          const real = mergeTail(prevReal, payload.highlights) ?? payload.highlights;
          const merged = real === prevReal && prev.length === prevReal.length
            ? prev
            : mergeWithOptimistic(prev, real);
          if (!(merged.length === prev.length && merged.every((h, i) => h === prev[i]))) {
            setHighlights(merged);
          }
          remember(merged);
          setHasMore(typeof payload.total === 'number' ? payload.total > real.length : payload.hasMore);
        }

        if (statusResponse.success && statusResponse.payload && statusIsFor(statusResponse, sessionId!)) {
          const ns = statusResponse.payload as SessionStatus;
          const cur = statusRef.current;
          if (statusChanged(cur, ns)) {
            setStatus(ns);
          }
        }

        setError(null);
      } catch (err) {
        // A failed refresh keeps whatever we already show (cache / last good).
        if (!cancelled && isValid(serverId!, sessionId!, guardEpoch) && highlightsRef.current.length === 0) {
          setError(err instanceof Error ? err.message : 'Failed to load conversation');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    // Poll for updates
    async function pollUpdates() {
      if (!conn || cancelled || !isValid(serverId!, sessionId!, guardEpoch)) return;
      if (pollInFlight) return;
      pollInFlight = true;
      try {
        // Only the tail: a poll used to re-download everything loaded so far.
        const [hlResponse, statusResponse] = await Promise.all([
          conn.sendRequest('get_highlights', { limit: PAGE_SIZE, sessionId }),
          conn.sendRequest('get_status', { sessionId }),
        ]);

        if (cancelled || !isValid(serverId!, sessionId!, guardEpoch)) return;

        if (hlResponse.success && hlResponse.payload) {
          let payload = hlResponse.payload as {
            highlights: ConversationHighlight[];
            total: number;
            hasMore: boolean;
          };
          const prevReal0 = highlightsRef.current.filter((h) => !isOptimistic(h));
          if (mergeTail(prevReal0, payload.highlights) === null) {
            // More new messages than one page since we last looked: one capped refetch.
            const wide = await conn.sendRequest('get_highlights', { limit: GAP_REFETCH_LIMIT, sessionId });
            if (cancelled || !isValid(serverId!, sessionId!, guardEpoch)) return;
            if (wide.success && wide.payload) payload = wide.payload as typeof payload;
          }
          const serverData = payload.highlights;
          const realLen = (mergeTail(highlightsRef.current.filter((h) => !isOptimistic(h)), serverData) ?? serverData).length;

          setHighlights(prev => {
            const prevReal = prev.filter(h => !isOptimistic(h));
            const real = mergeTail(prevReal, serverData) ?? serverData;
            const hasOptimistic = prev.length !== prevReal.length;
            if (real === prevReal && !hasOptimistic) return prev;
            const merged = mergeWithOptimistic(prev, real);
            if (merged.length === prev.length && merged.every((h, i) => h === prev[i])) return prev;
            remember(merged);
            return merged;
          });

          setHasMore(typeof payload.total === 'number' && realLen > 0
            ? payload.total > realLen
            : payload.hasMore);
        }

        if (statusResponse.success && statusResponse.payload && statusIsFor(statusResponse, sessionId!)) {
          const ns = statusResponse.payload as SessionStatus;
          const cur = statusRef.current;
          if (statusChanged(cur, ns)) {
            setStatus(ns);
          }
        }
      } catch {
        // Silently ignore poll errors
      } finally {
        pollInFlight = false;
      }
    }

    // Register the broadcast listener BEFORE any async work so we don't miss
    // conversation_update messages that arrive during switchSession/fetchData.
    unsubMessage = conn.onMessage((msg) => {
      if (cancelled || !isValid(serverId!, sessionId!, guardEpoch)) return;

      // Strict filter: session-scoped messages must match exactly (reject null/undefined too)
      if (msg.type === 'conversation_update' || msg.type === 'status_change' || msg.type === 'compaction') {
        if (msg.sessionId !== sessionId) return;
      }

      if (msg.type === 'conversation_update' && msg.payload) {
        if (pollDebounceTimer) clearTimeout(pollDebounceTimer);
        pollDebounceTimer = setTimeout(() => {
          pollDebounceTimer = null;
          pollUpdates();
        }, 300);
      }
      if (msg.type === 'status_change' && msg.payload) {
        const ns = msg.payload as SessionStatus;
        const cur = statusRef.current;
        if (statusChanged(cur, ns)) {
          setStatus(ns);
        }
      }
    });

    // Subscribe to this session on the daemon and load it. Safe to call on every
    // (re)connection — the daemon-side per-client subscription is lost whenever
    // the socket is replaced, so we must re-issue switchSession + refetch to pick
    // up anything that arrived while we were down and to clear any stale error.
    async function activate() {
      if (!conn || cancelled || !isValid(serverId!, sessionId!, guardEpoch)) return;
      try {
        // Tell daemon to filter broadcasts for this session
        await conn.switchSession(sessionId!);
        if (cancelled || !isValid(serverId!, sessionId!, guardEpoch)) return;

        await fetchData();
        if (cancelled) return;

        // Reuse an existing poll interval across reconnects so timers can't stack.
        if (!pollTimer) pollTimer = setInterval(pollUpdates, POLL_INTERVAL);
      } catch {
        // fetchData handles its own error state
      }
    }

    // Drive (re)activation off the connection state. onStateChange fires
    // immediately with the current state, so this handles the initial mount
    // (connected OR still reconnecting), the cold-start case where the socket
    // wasn't up yet (no prior connection => onReconnect would never fire), and
    // every subsequent drop/restore — all without recreating the session.
    unsubState = conn.onStateChange((state) => {
      if (cancelled || !isValid(serverId!, sessionId!, guardEpoch)) return;

      setConnected(state.status === 'connected');
      if (state.status === 'connected') {
        if (!activatedForConnection) {
          activatedForConnection = true;
          setError(null);
          activate();
        }
        return;
      }

      // Lost (or never had) a live socket. Forget the previous activation so the
      // next 'connected' transition re-subscribes and refetches.
      activatedForConnection = false;

      if (state.status === 'disconnected') {
        // Truly idle with no retry scheduled — nudge a reconnect so we don't sit
        // dead. (We deliberately skip 'error': the WS layer drives it straight
        // back to 'reconnecting' with its own backoff, so nudging here would just
        // busy-loop on a persistent auth failure.)
        conn.connect();
      }

      // 'connecting' / 'reconnecting' are transient and the WS layer is already
      // retrying — keep showing cached data; surface a soft notice only when we
      // have nothing cached to display so the user isn't staring at a blank view.
      if (!hadCache && highlightsRef.current.length === 0) {
        setLoading(false);
        setError('Reconnecting…');
      }
    });

    return () => {
      cancelled = true;
      if (pollTimer) clearInterval(pollTimer);
      if (pollDebounceTimer) clearTimeout(pollDebounceTimer);
      if (unsubMessage) unsubMessage();
      if (unsubState) unsubState();
    };
  }, [serverId, sessionId]);

  const loadMore = useCallback(() => {
    if (!serverId || !sessionId || loadingMore || !hasMore) return;

    const conn = connectionManager.getConnection(serverId);
    if (!conn || !conn.isConnected()) return;

    const guardEpoch = epochRef.current;
    setLoadingMore(true);

    conn
      .sendRequest('get_highlights', {
        limit: PAGE_SIZE,
        offset: highlights.length,
        sessionId,
      })
      .then((response) => {
        if (!isValid(serverId, sessionId, guardEpoch)) return;
        if (response.success && response.payload) {
          const payload = response.payload as {
            highlights: ConversationHighlight[];
            total: number;
            hasMore: boolean;
          };
          const prependCount = payload.highlights.length;
          setFirstItemIndex(prev => prev - prependCount);
          setHighlights((prev) => [...payload.highlights, ...prev]);
          setHasMore(payload.hasMore);
        }
      })
      .catch(() => {
        // Silently ignore
      })
      .finally(() => {
        setLoadingMore(false);
      });
  }, [serverId, sessionId, loadingMore, hasMore, highlights.length]);

  const sendInputDetailed = useCallback(
    async (text: string, opts?: { skipOptimistic?: boolean }): Promise<SendOutcome> => {
      if (!serverId || (!sessionId && !tmuxSessionName)) return false;
      const conn = connectionManager.getConnection(serverId);
      if (!conn) return false;
      // Generate a unique client message ID for server-side tracking
      const clientMessageId = `sent-${Date.now()}-${++clientMessageCounter}`;

      if (!conn.isConnected()) {
        // Don't silently swallow the send. Kick an immediate reconnect (cancels
        // any pending backoff) so the socket — and this session's subscription
        // via the onStateChange activate path — recovers right away. Queue the
        // input so it is delivered once we re-authenticate instead of dropped.
        conn.connect();
        conn.sendQueued({
          type: 'send_input',
          payload: {
            input: text,
            sessionId,
            tmuxSessionName: tmuxSessionName || sessionId,
            clientMessageId,
          },
        });
        const isSlashCmd = text.startsWith('/');
        if (!opts?.skipOptimistic && !isSlashCmd) {
          setHighlights((prev) => [
            ...prev,
            {
              id: clientMessageId,
              type: 'user' as const,
              content: text,
              timestamp: Date.now(),
              isWaitingForChoice: false,
            },
          ]);
        }
        return true;
      }

      try {
        const response = await conn.sendRequest('send_input', {
          input: text,
          sessionId,
          tmuxSessionName: tmuxSessionName || sessionId,
          clientMessageId,
        });
        const isSlashCommand = text.startsWith('/');
        if (response.success && !opts?.skipOptimistic && !isSlashCommand) {
          // Optimistic display — show immediately as confirmed message.
          // Tracked by 'sent-' ID prefix for dedup when server data catches up.
          // Skipped for option/choice selections (skipOptimistic) and slash commands
          // since neither echo back as user messages in the JSONL.
          setHighlights((prev) => [
            ...prev,
            {
              id: clientMessageId,
              type: 'user' as const,
              content: text,
              timestamp: Date.now(),
              isWaitingForChoice: false,
            },
          ]);
        }
        setSendError(response.success ? null : describeSendError(response.error, response.payload));
        return response.success;
      } catch (err) {
        // The request left (timeout / socket died before the answer): the
        // daemon may already have typed it, so this is NOT a plain failure.
        const msg = err instanceof Error ? err.message : '';
        if (msg === 'Request timeout' || msg === 'Connection lost') return 'uncertain';
        return false;
      }
    },
    [serverId, sessionId, tmuxSessionName],
  );

  const sendInput = useCallback(
    async (text: string, opts?: { skipOptimistic?: boolean }): Promise<boolean> =>
      (await sendInputDetailed(text, opts)) === true,
    [sendInputDetailed],
  );

  const clearSendError = useCallback(() => setSendError(null), []);

  const cancelMessage = useCallback(
    async (clientMessageId: string): Promise<string | null> => {
      if (!serverId || !sessionId) return null;
      const conn = connectionManager.getConnection(serverId);
      if (!conn || !conn.isConnected()) return null;

      // Find the message content before removing
      const msg = highlightsRef.current.find(h => h.id === clientMessageId);
      const originalText = msg?.content || null;

      try {
        await conn.sendRequest('cancel_input', {
          clientMessageId,
          sessionId,
          tmuxSessionName: tmuxSessionName || sessionId,
        });

        // Remove the optimistic message from local state
        setHighlights((prev) => prev.filter(h => h.id !== clientMessageId));
      } catch {
        // Still remove locally even if server request fails
        setHighlights((prev) => prev.filter(h => h.id !== clientMessageId));
      }

      return originalText;
    },
    [serverId, sessionId, tmuxSessionName],
  );

  const addOptimisticMessage = useCallback((text: string) => {
    const id = `terminal-${Date.now()}-${++clientMessageCounter}`;
    setHighlights((prev) => [
      ...prev,
      {
        id,
        type: 'user' as const,
        content: text,
        timestamp: Date.now(),
        isWaitingForChoice: false,
      },
    ]);
  }, []);

  return { highlights, status, loading, loadingMore, hasMore, error, firstItemIndex, sendInput, sendInputDetailed, connected, sendError, clearSendError, cancelMessage, addOptimisticMessage, loadMore };
}
