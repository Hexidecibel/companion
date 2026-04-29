import { useState, useEffect, useRef, useCallback } from 'react';
import { ConversationHighlight, SessionStatus } from '../types';
import { connectionManager } from '../services/ConnectionManager';
import {
  getCachedHighlights,
  setCachedHighlights,
  highlightsEqual,
  highlightEqual,
} from '../services/SessionCache';
import { beginSwitch, isValid } from '../services/SessionGuard';
import { isMobileViewport } from '../utils/platform';

const POLL_INTERVAL = 30000;
const PAGE_SIZE = isMobileViewport() ? 20 : 50;

interface UseConversationReturn {
  highlights: ConversationHighlight[];
  status: SessionStatus | null;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  firstItemIndex: number;
  sendInput: (text: string, opts?: { skipOptimistic?: boolean }) => Promise<boolean>;
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

export function useConversation(
  serverId: string | null,
  sessionId: string | null,
  tmuxSessionName?: string,
): UseConversationReturn {
  const [highlights, setHighlights] = useState<ConversationHighlight[]>([]);
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [firstItemIndex, setFirstItemIndex] = useState(1_000_000);

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

    // Show cached data immediately
    const cached = getCachedHighlights(serverId, sessionId);
    if (cached) {
      setHighlights(cached);
      setLoading(false);
    } else {
      setLoading(true);
    }

    const conn = connectionManager.getConnection(serverId);
    if (!conn || !conn.isConnected()) {
      setError('Server not connected');
      setLoading(false);
      return;
    }

    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let pollInFlight = false;
    let pollDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    let unsubMessage: (() => void) | null = null;
    let unsubReconnect: (() => void) | null = null;

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
          const hasOptimistic = highlightsRef.current.some(isOptimistic);
          if (hasOptimistic || !highlightsEqual(payload.highlights, highlightsRef.current)) {
            const merged = mergeWithOptimistic(highlightsRef.current, payload.highlights);
            setHighlights(merged);
            setCachedHighlights(serverId!, sessionId!, merged);
          }
          setHasMore(payload.hasMore);
        }

        if (statusResponse.success && statusResponse.payload) {
          const ns = statusResponse.payload as SessionStatus;
          const cur = statusRef.current;
          if (!cur || ns.isRunning !== cur.isRunning || ns.isWaitingForInput !== cur.isWaitingForInput || ns.lastActivity !== cur.lastActivity || ns.currentActivity !== cur.currentActivity || ns.conversationId !== cur.conversationId || (ns.feedbackPrompt != null) !== (cur.feedbackPrompt != null)) {
            setStatus(ns);
          }
        }

        setError(null);
      } catch (err) {
        if (!cancelled && isValid(serverId!, sessionId!, guardEpoch)) {
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
        const pollLimit = Math.max(PAGE_SIZE, highlightsRef.current.length);
        const [hlResponse, statusResponse] = await Promise.all([
          conn.sendRequest('get_highlights', { limit: pollLimit, sessionId }),
          conn.sendRequest('get_status', { sessionId }),
        ]);

        if (cancelled || !isValid(serverId!, sessionId!, guardEpoch)) return;

        if (hlResponse.success && hlResponse.payload) {
          const payload = hlResponse.payload as {
            highlights: ConversationHighlight[];
            total: number;
            hasMore: boolean;
          };
          const serverData = payload.highlights;
          const hasOptimistic = highlightsRef.current.some(isOptimistic);

          setHighlights(prev => {
            // Filter out optimistic messages for comparison
            const prevReal = prev.filter(h => !isOptimistic(h));

            // Fast path: check if only new items appended or last item updated
            if (serverData.length >= prevReal.length && prevReal.length > 0) {
              // Check prefix stability (all items except possibly the last match by id)
              let prefixMatch = true;
              for (let i = 0; i < prevReal.length - 1; i++) {
                if (prevReal[i].id !== serverData[i]?.id) {
                  prefixMatch = false;
                  break;
                }
              }

              if (prefixMatch) {
                const lastIdx = prevReal.length - 1;
                const lastChanged = lastIdx >= 0 && serverData[lastIdx] &&
                  !highlightEqual(prevReal[lastIdx], serverData[lastIdx]);

                // No change at all — return same reference
                if (!lastChanged && serverData.length === prevReal.length) {
                  return prev;
                }

                // Build result preserving existing references where possible
                const result = [...prevReal];
                if (lastChanged && lastIdx >= 0) {
                  result[lastIdx] = serverData[lastIdx];
                }
                for (let i = prevReal.length; i < serverData.length; i++) {
                  result.push(serverData[i]);
                }
                const merged = mergeWithOptimistic(prev, result);
                setCachedHighlights(serverId!, sessionId!, merged);
                return merged;
              }
            }

            // Fallback: full replacement
            if (hasOptimistic || !highlightsEqual(serverData, prevReal)) {
              const merged = mergeWithOptimistic(prev, serverData);
              setCachedHighlights(serverId!, sessionId!, merged);
              return merged;
            }
            return prev;
          });

          setHasMore(payload.hasMore);
        }

        if (statusResponse.success && statusResponse.payload) {
          const ns = statusResponse.payload as SessionStatus;
          const cur = statusRef.current;
          if (!cur || ns.isRunning !== cur.isRunning || ns.isWaitingForInput !== cur.isWaitingForInput || ns.lastActivity !== cur.lastActivity || ns.currentActivity !== cur.currentActivity || ns.conversationId !== cur.conversationId || (ns.feedbackPrompt != null) !== (cur.feedbackPrompt != null)) {
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
        if (!cur || ns.isRunning !== cur.isRunning || ns.isWaitingForInput !== cur.isWaitingForInput || ns.lastActivity !== cur.lastActivity || ns.currentActivity !== cur.currentActivity || ns.conversationId !== cur.conversationId || (ns.feedbackPrompt != null) !== (cur.feedbackPrompt != null)) {
          setStatus(ns);
        }
      }
    });

    // On reconnect, the daemon-side per-client session subscription is lost
    // (a fresh socket means fresh state). Re-issue switchSession and refetch
    // so any "Server not connected" / fetch error banner clears automatically
    // and we pick up anything that arrived while the socket was down.
    unsubReconnect = conn.onReconnect(() => {
      if (cancelled || !isValid(serverId!, sessionId!, guardEpoch)) return;
      (async () => {
        try {
          await conn.switchSession(sessionId!);
          if (cancelled || !isValid(serverId!, sessionId!, guardEpoch)) return;
          await fetchData();
        } catch {
          // fetchData handles its own error state
        }
      })();
    });

    // Tell the daemon which session we're viewing, then fetch data.
    (async () => {
      // Tell daemon to filter broadcasts for this session
      await conn.switchSession(sessionId);
      if (cancelled || !isValid(serverId!, sessionId!, guardEpoch)) return;

      await fetchData();
      if (cancelled) return;

      pollTimer = setInterval(pollUpdates, POLL_INTERVAL);
    })();

    return () => {
      cancelled = true;
      if (pollTimer) clearInterval(pollTimer);
      if (pollDebounceTimer) clearTimeout(pollDebounceTimer);
      if (unsubMessage) unsubMessage();
      if (unsubReconnect) unsubReconnect();
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

  const sendInput = useCallback(
    async (text: string, opts?: { skipOptimistic?: boolean }): Promise<boolean> => {
      if (!serverId || (!sessionId && !tmuxSessionName)) return false;
      const conn = connectionManager.getConnection(serverId);
      if (!conn || !conn.isConnected()) return false;

      // Generate a unique client message ID for server-side tracking
      const clientMessageId = `sent-${Date.now()}-${++clientMessageCounter}`;

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
        return response.success;
      } catch {
        return false;
      }
    },
    [serverId, sessionId, tmuxSessionName],
  );

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

  return { highlights, status, loading, loadingMore, hasMore, error, firstItemIndex, sendInput, cancelMessage, addOptimisticMessage, loadMore };
}
