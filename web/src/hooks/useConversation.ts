import { useState, useEffect, useRef, useCallback } from 'react';
import { ConversationHighlight, SessionStatus } from '../types';
import { connectionManager } from '../services/ConnectionManager';
import {
  getCachedHighlights,
  setCachedHighlights,
  highlightsEqual,
} from '../services/SessionCache';
import { beginSwitch, isValid } from '../services/SessionGuard';

const POLL_INTERVAL = 5000;
const PAGE_SIZE = 50;

interface UseConversationReturn {
  highlights: ConversationHighlight[];
  status: SessionStatus | null;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
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
 * Keeps optimistic messages appended until server data includes a matching
 * user message (same content). No timer — messages stay until confirmed.
 */
function mergeWithOptimistic(
  prev: ConversationHighlight[],
  server: ConversationHighlight[],
): ConversationHighlight[] {
  const optimistic = prev.filter(isOptimistic);
  if (optimistic.length === 0) return server;

  // Check which optimistic messages are now confirmed by server data.
  const serverUserContent = new Set(
    server
      .filter((h) => h.type === 'user')
      .slice(-optimistic.length * 2)
      .map((h) => h.content.trim()),
  );

  const stillOptimistic = optimistic.filter(
    (o) => !serverUserContent.has(o.content.trim()),
  );

  if (stillOptimistic.length === 0) return server;

  // Insert optimistic messages at the correct position by timestamp
  // instead of always appending at the end
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

  const highlightsRef = useRef(highlights);
  highlightsRef.current = highlights;
  const epochRef = useRef(0);

  // Fetch highlights and status when session changes
  useEffect(() => {
    if (!serverId || !sessionId) {
      setHighlights([]);
      setStatus(null);
      setLoading(false);
      setError(null);
      setHasMore(false);
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
          setStatus(statusResponse.payload as SessionStatus);
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
      try {
        // Request at least as many items as currently loaded so load-more results aren't wiped
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
          const hasOptimistic = highlightsRef.current.some(isOptimistic);
          if (hasOptimistic || !highlightsEqual(payload.highlights, highlightsRef.current)) {
            const merged = mergeWithOptimistic(highlightsRef.current, payload.highlights);
            setHighlights(merged);
            setCachedHighlights(serverId!, sessionId!, merged);
          }
          setHasMore(payload.hasMore);
        }

        if (statusResponse.success && statusResponse.payload) {
          setStatus(statusResponse.payload as SessionStatus);
        }
      } catch {
        // Silently ignore poll errors
      }
    }

    fetchData().then(() => {
      if (!cancelled) {
        pollTimer = setInterval(pollUpdates, POLL_INTERVAL);
      }
    });

    // Listen for broadcast updates — only act on events for THIS session
    const unsubMessage = conn.onMessage((msg) => {
      if (cancelled || !isValid(serverId!, sessionId!, guardEpoch)) return;

      // Filter: only process broadcasts for this session (or unscoped ones)
      if (msg.sessionId && msg.sessionId !== sessionId) return;

      if (msg.type === 'conversation_update' && msg.payload) {
        // Broadcast received, re-fetch highlights
        pollUpdates();
      }
      if (msg.type === 'status_change' && msg.payload) {
        setStatus(msg.payload as SessionStatus);
      }
    });

    return () => {
      cancelled = true;
      if (pollTimer) clearInterval(pollTimer);
      unsubMessage();
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
      if (!serverId || !sessionId) return false;
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

  return { highlights, status, loading, loadingMore, hasMore, error, sendInput, cancelMessage, addOptimisticMessage, loadMore };
}
