import { useState, useEffect, useCallback, useRef } from 'react';
import { ConversationMessage, ConversationHighlight, SessionStatus, ViewMode } from '../types';
import { wsService } from '../services/websocket';

export function useConversation() {
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [highlights, setHighlights] = useState<ConversationHighlight[]>([]);
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('highlights');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(wsService.isConnected());
  const hasSubscribed = useRef(false);

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
          setHighlights(updatePayload.highlights || []);
          break;
        }

        case 'status_change': {
          const statusPayload = message.payload as SessionStatus;
          setStatus(statusPayload);
          break;
        }
      }
    });

    return unsubscribe;
  }, []);

  // Fetch initial data when connected
  const refresh = useCallback(async () => {
    if (!wsService.isConnected()) {
      return;
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
    }
  }, [viewMode]);

  // Subscribe and refresh when connected or view mode changes
  useEffect(() => {
    if (isConnected && !hasSubscribed.current) {
      hasSubscribed.current = true;
      refresh();
    }
  }, [isConnected, viewMode, refresh]);

  const sendInput = useCallback(async (input: string): Promise<boolean> => {
    if (!wsService.isConnected()) {
      setError('Not connected');
      return false;
    }

    try {
      const response = await wsService.sendRequest('send_input', { input });
      if (!response.success) {
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
  };
}
