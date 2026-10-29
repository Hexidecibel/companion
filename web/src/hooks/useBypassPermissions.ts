import { useState, useEffect, useCallback } from 'react';
import { connectionManager } from '../services/ConnectionManager';

interface UseBypassPermissionsReturn {
  enabled: boolean;
  toggle: () => void;
  loading: boolean;
  /**
   * Codex sessions: the switch shows how the session was LAUNCHED and cannot
   * change it (approvals are a launch flag, not a project setting).
   */
  readOnly: boolean;
  /** Why the switch is read-only (from the daemon). */
  note?: string;
}

interface BypassPayload {
  enabled?: boolean;
  readOnly?: boolean;
  note?: string;
  launchedWith?: 'bypass' | 'default' | 'unknown';
}

export function useBypassPermissions(serverId: string | null, sessionId?: string | null): UseBypassPermissionsReturn {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [note, setNote] = useState<string | undefined>(undefined);

  // Fetch current state from daemon on mount / session change
  useEffect(() => {
    setReadOnly(false);
    setNote(undefined);
    if (!serverId || !sessionId) {
      setEnabled(false);
      return;
    }

    const conn = connectionManager.getConnection(serverId);
    if (!conn?.isConnected()) return;

    conn.sendRequest('get_bypass_permissions', { sessionId })
      .then((res) => {
        const payload = res.payload as BypassPayload | undefined;
        setEnabled(payload?.enabled ?? false);
        setReadOnly(Boolean(payload?.readOnly));
        setNote(payload?.readOnly ? payload.note : undefined);
      })
      .catch(() => {
        setEnabled(false);
      });
  }, [serverId, sessionId]);

  const toggle = useCallback(async () => {
    if (!serverId || !sessionId || loading || readOnly) return;

    const newState = !enabled;
    setLoading(true);

    const conn = connectionManager.getConnection(serverId);
    if (conn?.isConnected()) {
      try {
        const res = await conn.sendRequest('set_bypass_permissions', { enabled: newState, sessionId });
        const payload = res.payload as BypassPayload | undefined;
        if (!res.success && payload?.readOnly) {
          // The daemon refused (a Codex session): show the real launch state.
          setEnabled(payload.enabled ?? false);
          setReadOnly(true);
          setNote(payload.note);
          setLoading(false);
          return;
        }
      } catch {
        // Continue — toggle the UI state anyway
      }
    }

    setEnabled(newState);
    setLoading(false);
  }, [serverId, sessionId, enabled, loading, readOnly]);

  return { enabled, toggle, loading, readOnly, note };
}
