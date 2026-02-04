import { useState, useEffect, useCallback, useRef } from 'react';
import { ConversationMessage, ConversationHighlight, SessionStatus, ViewMode, OtherSessionActivity, TmuxSessionMissing } from '../types';
import { wsService } from '../services/websocket';
import { sessionGuard } from '../services/sessionGuard';

// Page size for paginated highlights
const HIGHLIGHTS_PAGE_SIZE = 30;

// Track how many items were prepended via infinite scroll (loadMore)
// This is module-level so it persists across re-renders but resets on session switch
let prependedCount = 0;

// Module-level session cache: sessionId -> { highlights, timestamp }
const sessionCache = new Map<string, { highlights: ConversationHighlight[]; timestamp: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCachedHighlights(sessionId: string | null): ConversationHighlight[] | null {
  if (!sessionId) return null;
  const entry = sessionCache.get(sessionId);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    sessionCache.delete(sessionId);
    return null;
  }
  return entry.highlights;
}

function setCachedHighlights(sessionId: string | null, highlights: ConversationHighlight[]): void {
  if (!sessionId) return;
  sessionCache.set(sessionId, { highlights, timestamp: Date.now() });
}

// Helper to check if highlights have actually changed
const highlightsEqual = (a: ConversationHighlight[], b: ConversationHighlight[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].content !== b[i].content) return false;
    // Check if options changed (important for AskUserQuestion)
    const aOpts = a[i].options?.length || 0;
    const bOpts = b[i].options?.length || 0;
    if (aOpts !== bOpts) return false;
    // Check if tool call statuses changed (pending -> running -> completed)
    const aTools = a[i].toolCalls;
    const bTools = b[i].toolCalls;
    if ((aTools?.length || 0) !== (bTools?.length || 0)) return false;
    if (aTools && bTools) {
      for (let j = 0; j < aTools.length; j++) {
        if (aTools[j].status !== bTools[j].status) return false;
      }
    }
  }
  return true;
};

export function useConversation() {
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  // Initialize from cache if a session is already active (e.g., navigating back)
  const [highlights, setHighlights] = useState<ConversationHighlight[]>(() => {
    const currentId = sessionGuard.getCurrentSessionId();
    return getCachedHighlights(currentId) || [];
  });
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('highlights');
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(wsService.isConnected());
  const [otherSessionActivity, setOtherSessionActivity] = useState<OtherSessionActivity | null>(null);
  const [tmuxSessionMissing, setTmuxSessionMissing] = useState<TmuxSessionMissing | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const hasSubscribed = useRef(false);
  const sessionSwitching = useRef(false); // Flag to pause polling during switch
  const totalHighlights = useRef(0);

  // Track connection state
  useEffect(() => {
    const unsubscribe = wsService.onStateChange((state) => {
      const connected = state.status === 'connected';
      setIsConnected(connected);
      if (!connected) {
        hasSubscribed.current = false;
        // Don't clear cache - stale data is better than a loading spinner
        // Cache has its own TTL (5 min) for freshness
      }
    });
    return unsubscribe;
  }, []);

  // Subscribe to real-time updates with session validation
  useEffect(() => {
    const unsubscribe = wsService.onMessage((message) => {
      // Validate session context for data messages
      const messageSessionId = message.sessionId;

      switch (message.type) {
        case 'conversation_update': {
          // CRITICAL: Reject updates for wrong session
          if (!sessionGuard.isValid(messageSessionId)) {
            console.log(`useConversation: Rejecting conversation_update for session ${messageSessionId}`);
            return;
          }
          const updatePayload = message.payload as {
            messages: ConversationMessage[];
            highlights: ConversationHighlight[];
          };
          setMessages(updatePayload.messages || []);
          // Push sends ALL highlights from current conversation file.
          // If user scrolled back (loadMore prepended items), preserve those
          // older items and only replace the current-file portion.
          const serverHighlights = updatePayload.highlights || [];
          setHighlights(prev => {
            if (prependedCount > 0 && prev.length > serverHighlights.length) {
              // Keep the prepended (older file) items, replace the rest
              const olderPart = prev.slice(0, prependedCount);
              const merged = [...olderPart, ...serverHighlights];
              if (highlightsEqual(prev, merged)) return prev;
              return merged;
            }
            if (highlightsEqual(prev, serverHighlights)) return prev;
            return serverHighlights;
          });
          break;
        }

        case 'status_change': {
          // CRITICAL: Reject status for wrong session
          if (!sessionGuard.isValid(messageSessionId)) {
            console.log(`useConversation: Rejecting status_change for session ${messageSessionId}`);
            return;
          }
          const statusPayload = message.payload as SessionStatus;
          setStatus(statusPayload);
          break;
        }

        case 'other_session_activity': {
          // Only show notification if activity is for a DIFFERENT session
          const activityPayload = message.payload as OtherSessionActivity;
          const currentId = sessionGuard.getCurrentSessionId();
          if (activityPayload.sessionId === currentId) {
            // Activity is for the session we're already viewing - ignore
            return;
          }
          setOtherSessionActivity(activityPayload);
          break;
        }
      }
    });

    return unsubscribe;
  }, []);

  // Fetch initial data when connected
  // clearFirst: if true, clears existing data before fetching (useful for session switch)
  const refresh = useCallback(async (clearFirst: boolean = false) => {
    if (!wsService.isConnected()) {
      return;
    }

    // Clear old data first to prevent showing stale content during switch
    let hasData = false;
    if (clearFirst) {
      sessionSwitching.current = true;
      prependedCount = 0; // Reset infinite scroll tracking on session switch
      setMessages([]);
      setStatus(null);
      // Auto-dismiss other-session notification if we're switching to that session
      setOtherSessionActivity(prev => {
        if (prev && prev.sessionId === sessionGuard.getCurrentSessionId()) {
          return null;
        }
        return prev;
      });

      // Check session cache for instant display
      const cachedSessionId = sessionGuard.getCurrentSessionId();
      const cached = getCachedHighlights(cachedSessionId);
      if (cached) {
        setHighlights(cached);
        hasData = true;
      } else {
        setHighlights([]);
      }
    } else {
      // Non-clear refresh: check if we already have highlights showing
      hasData = highlightsCountRef.current > 0;
    }

    // Only show loading spinner when we have nothing to display
    if (!hasData) {
      setLoading(true);
    }
    setError(null);

    // Get current session context for validation
    const { sessionId: expectedSessionId } = sessionGuard.getContext();

    try {
      // Fire subscribe in background (don't block on it)
      wsService.sendRequest('subscribe', { sessionId: expectedSessionId }).catch(() => {});

      // Fire data and status in parallel
      const dataRequest = viewMode === 'highlights'
        ? wsService.sendRequest('get_highlights', { limit: HIGHLIGHTS_PAGE_SIZE }, 30000)
        : wsService.sendRequest('get_full', undefined, 30000);
      const statusRequest = wsService.sendRequest('get_status', undefined, 30000);

      const [dataResponse, statusResponse] = await Promise.all([dataRequest, statusRequest]);

      // Apply data response
      if (dataResponse.success && dataResponse.payload && sessionGuard.isValid(dataResponse.sessionId)) {
        if (viewMode === 'highlights') {
          const payload = dataResponse.payload as { highlights: ConversationHighlight[]; total: number; hasMore: boolean };
          setHighlights(payload.highlights || []);
          totalHighlights.current = payload.total ?? (payload.highlights?.length || 0);
          setHasMore(payload.hasMore ?? false);
          // Update cache
          setCachedHighlights(sessionGuard.getCurrentSessionId(), payload.highlights || []);
        } else {
          const payload = dataResponse.payload as { messages: ConversationMessage[] };
          setMessages(payload.messages || []);
        }
      } else if (dataResponse.sessionId && !sessionGuard.isValid(dataResponse.sessionId)) {
        console.log(`useConversation: Discarding data response for wrong session ${dataResponse.sessionId}`);
      }

      // Apply status response
      if (statusResponse.success && statusResponse.payload && sessionGuard.isValid(statusResponse.sessionId)) {
        setStatus(statusResponse.payload as SessionStatus);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load conversation');
    } finally {
      setLoading(false);
      sessionSwitching.current = false;
    }
  }, [viewMode]);

  // Load older highlights (pagination - scroll up)
  // Use a ref for highlights count to avoid re-creating this callback on every poll
  const highlightsCountRef = useRef(0);
  highlightsCountRef.current = highlights.length;

  const loadMore = useCallback(async () => {
    if (!wsService.isConnected() || loadingMore || !hasMore || viewMode !== 'highlights') return;

    setLoadingMore(true);
    try {
      const currentCount = highlightsCountRef.current;
      const response = await wsService.sendRequest('get_highlights', {
        limit: HIGHLIGHTS_PAGE_SIZE,
        offset: currentCount,
      }, 30000);

      if (sessionSwitching.current) return;
      if (!sessionGuard.isValid(response.sessionId)) return;

      if (response.success && response.payload) {
        const payload = response.payload as { highlights: ConversationHighlight[]; total: number; hasMore: boolean };
        const olderHighlights = payload.highlights || [];

        if (olderHighlights.length > 0) {
          // Prepend older highlights and track count for conversation_update merging
          prependedCount += olderHighlights.length;
          setHighlights(prev => {
            return [...olderHighlights, ...prev];
          });
          totalHighlights.current = payload.total;
          setHasMore(payload.hasMore ?? false);
        } else {
          setHasMore(false);
        }
      }
    } catch {
      // Silent fail on load more
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, viewMode]);

  // Track subscription state - SessionView handles the actual refresh
  useEffect(() => {
    if (isConnected && !hasSubscribed.current) {
      hasSubscribed.current = true;
    }
  }, [isConnected]);

  // Poll for updates every 5 seconds when connected
  useEffect(() => {
    if (!isConnected) return;

    const pollInterval = setInterval(() => {
      // Skip polling during session switch to prevent stale data
      if (sessionSwitching.current || !wsService.isConnected()) return;

      // Poll conversation data - always request latest page
      const pollRequest = viewMode === 'highlights'
        ? wsService.sendRequest('get_highlights', { limit: HIGHLIGHTS_PAGE_SIZE })
        : wsService.sendRequest('get_full');

      pollRequest
        .then(response => {
          // Skip if session switch started during request
          if (sessionSwitching.current) return;

          // CRITICAL: Validate response is for current session
          if (!sessionGuard.isValid(response.sessionId)) {
            console.log(`useConversation: Discarding poll response for wrong session ${response.sessionId}`);
            return;
          }

          if (response.success && response.payload) {
            if (viewMode === 'highlights') {
              const payload = response.payload as { highlights: ConversationHighlight[]; total: number; hasMore: boolean };
              const serverHighlights = payload.highlights || [];
              totalHighlights.current = payload.total ?? serverHighlights.length;

              // Only update the tail (most recent) portion of highlights
              setHighlights(prev => {
                if (prev.length <= HIGHLIGHTS_PAGE_SIZE) {
                  // We only have one page - replace entirely if changed
                  if (highlightsEqual(prev, serverHighlights)) return prev;
                  return serverHighlights;
                }
                // We have older highlights loaded too - replace only the tail
                const olderPart = prev.slice(0, prev.length - HIGHLIGHTS_PAGE_SIZE);
                const merged = [...olderPart, ...serverHighlights];
                if (highlightsEqual(prev, merged)) return prev;
                return merged;
              });

              // Update hasMore based on total
              setHasMore(payload.hasMore ?? false);

              // Cache only the latest page (not scroll-back content)
              const sessionId = sessionGuard.getCurrentSessionId();
              if (sessionId) {
                setCachedHighlights(sessionId, serverHighlights);
              }
            } else {
              const payload = response.payload as { messages: ConversationMessage[] };
              setMessages(payload.messages || []);
            }
          }
        })
        .catch(() => { /* silent fail on poll */ });

      // Also poll status for real-time activity updates
      wsService.sendRequest('get_status')
        .then(response => {
          if (sessionSwitching.current) return;

          // CRITICAL: Validate response is for current session
          if (!sessionGuard.isValid(response.sessionId)) {
            return;
          }

          if (response.success && response.payload) {
            const newStatus = response.payload as SessionStatus;
            // Only update if status actually changed
            setStatus(prev => {
              if (prev &&
                  prev.isWaitingForInput === newStatus.isWaitingForInput &&
                  prev.currentActivity === newStatus.currentActivity &&
                  prev.lastActivity === newStatus.lastActivity) {
                return prev; // No change
              }
              return newStatus;
            });
          }
        })
        .catch(() => { /* silent fail on poll */ });
    }, 5000); // 5 seconds to reduce re-renders

    return () => clearInterval(pollInterval);
  }, [isConnected, viewMode]);

  const sendInput = useCallback(async (input: string): Promise<boolean> => {
    if (!wsService.isConnected()) {
      setError('Not connected');
      return false;
    }

    // No optimistic update - wait for server confirmation
    // This avoids duplicate/flicker issues from deduplication race conditions
    try {
      const response = await wsService.sendRequest('send_input', { input });
      if (!response.success) {
        // Check if this is a tmux session not found error
        if (response.error === 'tmux_session_not_found') {
          const payload = response.payload as TmuxSessionMissing;
          setTmuxSessionMissing(payload);
          return false;
        }

        setError(response.error || 'Failed to send input');
        return false;
      }
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send input');
      return false;
    }
  }, []);

  const sendImage = useCallback(async (base64: string, mimeType: string): Promise<boolean> => {
    if (!wsService.isConnected()) {
      setError('Not connected');
      return false;
    }

    try {
      const response = await wsService.sendRequest('send_image', { base64, mimeType }, 60000);
      if (!response.success) {
        setError(response.error || 'Failed to send image');
        return false;
      }
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send image');
      return false;
    }
  }, []);

  // Upload image via HTTP POST (more reliable than WebSocket for large payloads)
  const uploadImage = useCallback(async (base64: string, mimeType: string): Promise<string | null> => {
    const serverInfo = wsService.getServerInfo();
    if (!serverInfo) {
      setError('Not connected');
      return null;
    }

    try {
      const protocol = serverInfo.useTls ? 'https' : 'http';
      const url = `${protocol}://${serverInfo.host}:${serverInfo.port}/upload`;

      // Convert base64 to binary for HTTP upload
      const binaryString = atob(base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': mimeType,
          'Authorization': `Bearer ${serverInfo.token}`,
        },
        body: bytes,
      });

      const result = await response.json();
      if (!result.success) {
        setError(result.error || 'Failed to upload image');
        return null;
      }
      return result.filepath;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload image');
      return null;
    }
  }, []);

  // Send message with image paths combined
  const sendWithImages = useCallback(async (imagePaths: string[], message: string): Promise<boolean> => {
    if (!wsService.isConnected()) {
      setError('Not connected');
      return false;
    }

    try {
      const response = await wsService.sendRequest('send_with_images', { imagePaths, message });
      if (!response.success) {
        setError(response.error || 'Failed to send message with images');
        return false;
      }
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message with images');
      return false;
    }
  }, []);

  const toggleViewMode = useCallback(() => {
    setViewMode((prev) => (prev === 'highlights' ? 'full' : 'highlights'));
  }, []);

  const dismissOtherSessionActivity = useCallback(() => {
    setOtherSessionActivity(null);
  }, []);

  const dismissTmuxSessionMissing = useCallback(() => {
    setTmuxSessionMissing(null);
  }, []);

  const recreateTmuxSession = useCallback(async (): Promise<boolean> => {
    if (!tmuxSessionMissing || !wsService.isConnected()) {
      return false;
    }

    try {
      const response = await wsService.sendRequest('recreate_tmux_session', {
        sessionName: tmuxSessionMissing.sessionName,
      });
      if (response.success) {
        setTmuxSessionMissing(null);
        // Refresh to get the new session state
        refresh(true);
        return true;
      } else {
        setError(response.error || 'Failed to recreate session');
        return false;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to recreate session');
      return false;
    }
  }, [tmuxSessionMissing, refresh]);

  return {
    messages,
    highlights,
    status,
    viewMode,
    loading,
    loadingMore,
    hasMore,
    error,
    refresh,
    loadMore,
    sendInput,
    sendImage,
    uploadImage,
    sendWithImages,
    toggleViewMode,
    setViewMode,
    currentData: viewMode === 'highlights' ? highlights : messages,
    otherSessionActivity,
    dismissOtherSessionActivity,
    tmuxSessionMissing,
    dismissTmuxSessionMissing,
    recreateTmuxSession,
  };
}
