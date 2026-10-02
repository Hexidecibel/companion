import { useState, useEffect, useCallback, useRef } from 'react';
import { FileChange } from '../types';
import { connectionManager } from '../services/ConnectionManager';

interface UseCodeReviewReturn {
  fileChanges: FileChange[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useCodeReview(
  serverId: string | null,
  sessionId: string | null,
): UseCodeReviewReturn {
  const [fileChanges, setFileChanges] = useState<FileChange[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  // Single request in flight; a refetch asked for meanwhile runs once after it.
  const inFlightRef = useRef(false);
  const rerunRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchDiff = useCallback(async () => {
    if (!serverId || !sessionId) {
      setFileChanges([]);
      return;
    }

    const conn = connectionManager.getConnection(serverId);
    if (!conn || !conn.isConnected()) return;

    if (inFlightRef.current) {
      rerunRef.current = true;
      return;
    }
    inFlightRef.current = true;

    try {
      const response = await conn.sendRequest('get_session_diff', { sessionId });
      if (!mountedRef.current) return;
      if (response.success && response.payload) {
        const payload = response.payload as { fileChanges: FileChange[]; sessionId: string };
        setFileChanges(payload.fileChanges);
        setError(null);
      } else if (!response.success) {
        setError(response.error || 'Failed to load code review');
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to load code review');
      }
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) {
        setLoading(false);
      }
    }
    if (rerunRef.current && mountedRef.current) {
      rerunRef.current = false;
      void fetchDiffRef.current();
    }
  }, [serverId, sessionId]);
  const fetchDiffRef = useRef(fetchDiff);
  fetchDiffRef.current = fetchDiff;

  useEffect(() => {
    mountedRef.current = true;

    if (!serverId || !sessionId) {
      setFileChanges([]);
      setLoading(false);
      setError(null);
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
        // Debounce: a JSONL flush emits many updates; the daemon path is costly.
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
          debounceRef.current = null;
          void fetchDiff();
        }, 500);
      }
    });

    return () => {
      unsub();
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [serverId, sessionId, fetchDiff]);

  return { fileChanges, loading, error, refresh: fetchDiff };
}
