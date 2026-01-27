import { useState, useEffect, useCallback, useRef } from 'react';
import { ConversationMessage, ConversationHighlight, SessionStatus, ViewMode, OtherSessionActivity, TmuxSessionMissing } from '../types';
import { wsService } from '../services/websocket';

// Helper to check if highlights have actually changed
const highlightsEqual = (a: ConversationHighlight[], b: ConversationHighlight[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].content !== b[i].content) return false;
    // Also check if options changed (important for AskUserQuestion)
    const aOpts = a[i].options?.length || 0;
    const bOpts = b[i].options?.length || 0;
    if (aOpts !== bOpts) return false;
  }
  return true;
};

export function useConversation() {
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [highlights, setHighlights] = useState<ConversationHighlight[]>([]);
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('highlights');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(wsService.isConnected());
  const [otherSessionActivity, setOtherSessionActivity] = useState<OtherSessionActivity | null>(null);
  const [tmuxSessionMissing, setTmuxSessionMissing] = useState<TmuxSessionMissing | null>(null);
  const hasSubscribed = useRef(false);
  const lastSentTime = useRef<number>(0);
  const pendingMessages = useRef<Set<string>>(new Set());
  const sessionSwitching = useRef(false); // Flag to pause polling during switch

  // Track connection state
  useEffect(() => {
    const unsubscribe = wsService.onStateChange((state) => {
      const connected = state.status === 'connected';
      setIsConnected(connected);
      if (!connected) {
        hasSubscribed.current = false;
      }
    });
    return unsubscribe;
  }, []);

  // Subscribe to real-time updates
  useEffect(() => {
    const unsubscribe = wsService.onMessage((message) => {
      switch (message.type) {
        case 'conversation_update': {
          const updatePayload = message.payload as {
            messages: ConversationMessage[];
            highlights: ConversationHighlight[];
          };
          setMessages(updatePayload.messages || []);
          // Preserve pending messages on real-time updates too
          const serverHighlights = updatePayload.highlights || [];
          setHighlights(prev => {
            const pending = prev.filter(m => m.id.startsWith('pending-'));
            const now = Date.now();
            const stillPending = pending.filter(p => {
              const pendingTime = parseInt(p.id.replace('pending-', ''), 10);
              return (now - pendingTime) < 30000;
            });
            return [...serverHighlights, ...stillPending];
          });
          break;
        }

        case 'status_change': {
          const statusPayload = message.payload as SessionStatus;
          setStatus(statusPayload);
          break;
        }

        case 'other_session_activity': {
          const activityPayload = message.payload as OtherSessionActivity;
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
    if (clearFirst) {
      sessionSwitching.current = true;
      setHighlights([]);
      setMessages([]);
      setStatus(null);
    }

    setLoading(true);
    setError(null);

    try {
      // Subscribe to updates
      await wsService.sendRequest('subscribe');

      // Fetch current data based on view mode
      if (viewMode === 'highlights') {
        const response = await wsService.sendRequest('get_highlights');
        if (response.success && response.payload) {
          const payload = response.payload as { highlights: ConversationHighlight[] };
          setHighlights(payload.highlights || []);
        }
      } else {
        const response = await wsService.sendRequest('get_full');
        if (response.success && response.payload) {
          const payload = response.payload as { messages: ConversationMessage[] };
          setMessages(payload.messages || []);
        }
      }

      // Get status
      const statusResponse = await wsService.sendRequest('get_status');
      if (statusResponse.success && statusResponse.payload) {
        setStatus(statusResponse.payload as SessionStatus);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load conversation');
    } finally {
      setLoading(false);
      sessionSwitching.current = false;
    }
  }, [viewMode]);

  // Subscribe and refresh when connected or view mode changes
  useEffect(() => {
    if (isConnected && !hasSubscribed.current) {
      hasSubscribed.current = true;
      refresh();
    }
  }, [isConnected, viewMode, refresh]);

  // Poll for updates every 2 seconds when connected
  useEffect(() => {
    if (!isConnected) return;

    const pollInterval = setInterval(() => {
      // Skip polling during session switch to prevent stale data
      if (sessionSwitching.current || !wsService.isConnected()) return;

      // Poll conversation data
      wsService.sendRequest(viewMode === 'highlights' ? 'get_highlights' : 'get_full')
        .then(response => {
          // Skip if session switch started during request
          if (sessionSwitching.current) return;

          if (response.success && response.payload) {
            if (viewMode === 'highlights') {
              const payload = response.payload as { highlights: ConversationHighlight[] };
              const serverHighlights = payload.highlights || [];

              // Only update if data actually changed (prevents scroll jumping)
              setHighlights(prev => {
                const pending = prev.filter(m => m.id.startsWith('pending-'));
                const nonPending = prev.filter(m => !m.id.startsWith('pending-'));

                // Check if server data changed
                if (highlightsEqual(nonPending, serverHighlights) && pending.length === 0) {
                  return prev; // No change, keep same reference
                }

                // Keep pending messages for at least 30 seconds
                const now = Date.now();
                const stillPending = pending.filter(p => {
                  const pendingTime = parseInt(p.id.replace('pending-', ''), 10);
                  const age = now - pendingTime;
                  if (age < 30000) return true;
                  const inServer = serverHighlights.some(s =>
                    s.type === 'user' && s.content === p.content
                  );
                  return !inServer;
                });

                return [...serverHighlights, ...stillPending];
              });
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
          if (response.success && response.payload) {
            setStatus(response.payload as SessionStatus);
          }
        })
        .catch(() => { /* silent fail on poll */ });
    }, 2000); // Reduced to 2 seconds to reduce scroll interference

    return () => clearInterval(pollInterval);
  }, [isConnected, viewMode]);

  const sendInput = useCallback(async (input: string): Promise<boolean> => {
    if (!wsService.isConnected()) {
      setError('Not connected');
      return false;
    }

    // Optimistic update - show message immediately
    const optimisticMessage: ConversationHighlight = {
      id: `pending-${Date.now()}`,
      type: 'user',
      content: input,
      timestamp: Date.now(),
    };
    console.log(`[Optimistic] Adding pending message: ${input.substring(0, 30)}...`);
    setHighlights(prev => {
      console.log(`[Optimistic] Previous count: ${prev.length}, adding message`);
      return [...prev, optimisticMessage];
    });

    try {
      const response = await wsService.sendRequest('send_input', { input });
      if (!response.success) {
        // Remove optimistic message on failure
        setHighlights(prev => prev.filter(m => m.id !== optimisticMessage.id));

        // Check if this is a tmux session not found error
        if (response.error === 'tmux_session_not_found') {
          const payload = response.payload as TmuxSessionMissing;
          setTmuxSessionMissing(payload);
          return false;
        }

        setError(response.error || 'Failed to send input');
        return false;
      }
      // Keep optimistic message - it will be replaced by real update from server
      return true;
    } catch (err) {
      // Remove optimistic message on failure
      setHighlights(prev => prev.filter(m => m.id !== optimisticMessage.id));
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
      const response = await wsService.sendRequest('send_image', { base64, mimeType });
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

  // Upload image without sending (returns filepath)
  const uploadImage = useCallback(async (base64: string, mimeType: string): Promise<string | null> => {
    if (!wsService.isConnected()) {
      setError('Not connected');
      return null;
    }

    try {
      const response = await wsService.sendRequest('upload_image', { base64, mimeType });
      if (!response.success) {
        setError(response.error || 'Failed to upload image');
        return null;
      }
      const payload = response.payload as { filepath: string };
      return payload.filepath;
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
    error,
    refresh,
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
