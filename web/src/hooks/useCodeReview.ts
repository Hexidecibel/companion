import { useState, useEffect, useCallback, useRef } from 'react';
import { FileChange } from '../types';
import { connectionManager } from '../services/ConnectionManager';

interface UseCodeReviewReturn {
  fileChanges: FileChange[];
  loading: boolean;
  refresh: () => void;
}

export function useCodeReview(
  serverId: string | null,
  sessionId: string | null,
): UseCodeReviewReturn {
  const [fileChanges, setFileChanges] = useState<FileChange[]>([]);
  const [loading, setLoading] = useState(false);
  const mountedRef = useRef(true);

  const fetchDiff = useCallback(async () => {
    if (!serverId || !sessionId) {
      setFileChanges([]);
      return;
    }

    const conn = connectionManager.getConnection(serverId);
    if (!conn || !conn.isConnected()) return;

    try {
      const response = await conn.sendRequest('get_session_diff', { sessionId });
      if (!mountedRef.current) return;
      if (response.success && response.payload) {
        const payload = response.payload as { fileChanges: FileChange[]; sessionId: string };
        setFileChanges(payload.fileChanges);
      }
    } catch {
      // Silently ignore
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [serverId, sessionId]);

  useEffect(() => {
    mountedRef.current = true;

    if (!serverId || !sessionId) {
      setFileChanges([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    fetchDiff();

    return () => {
      mountedRef.current = false;
    };
  }, [serverId, sessionId, fetchDiff]);

  // Auto-refresh when conversation updates (e.g. Write/Edit tool completes)
  useEffect(() => {
    if (!serverId || !sessionId) return;

    const conn = connectionManager.getConnection(serverId);
    if (!conn) return;

    const unsub = conn.onMessage((msg) => {
      if (!mountedRef.current) return;
      if (msg.sessionId && msg.sessionId !== sessionId) return;

      if (msg.type === 'conversation_update') {
        fetchDiff();
      }
    });

    return unsub;
  }, [serverId, sessionId, fetchDiff]);

  return { fileChanges, loading, refresh: fetchDiff };
}
