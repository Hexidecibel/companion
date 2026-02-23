import { useState, useEffect, useCallback } from 'react';
import { connectionManager } from '../services/ConnectionManager';

interface UseBypassPermissionsReturn {
  enabled: boolean;
  toggle: () => void;
  loading: boolean;
}

export function useBypassPermissions(serverId: string | null, sessionId?: string | null): UseBypassPermissionsReturn {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(false);

  // Fetch current state from daemon on mount / session change
  useEffect(() => {
    if (!serverId || !sessionId) {
      setEnabled(false);
      return;
    }

    const conn = connectionManager.getConnection(serverId);
    if (!conn?.isConnected()) return;

    conn.sendRequest('get_bypass_permissions', { sessionId })
      .then((res) => {
        const payload = res.payload as { enabled?: boolean } | undefined;
        setEnabled(payload?.enabled ?? false);
      })
      .catch(() => {
        setEnabled(false);
      });
  }, [serverId, sessionId]);

  const toggle = useCallback(async () => {
    if (!serverId || !sessionId || loading) return;

    const newState = !enabled;
    setLoading(true);

    const conn = connectionManager.getConnection(serverId);
    if (conn?.isConnected()) {
      try {
        await conn.sendRequest('set_bypass_permissions', { enabled: newState, sessionId });
      } catch {
        // Continue — toggle the UI state anyway
      }
    }

    setEnabled(newState);
    setLoading(false);
  }, [serverId, sessionId, enabled, loading]);

  return { enabled, toggle, loading };
}
