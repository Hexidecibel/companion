import { useState, useEffect, useCallback } from 'react';
import { connectionManager } from '../services/ConnectionManager';
import { AUTO_APPROVE_KEY } from '../services/storageKeys';

const STORAGE_KEY = AUTO_APPROVE_KEY;

function getStoredState(serverId: string, sessionId: string): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return false;
    const map = JSON.parse(stored) as Record<string, boolean>;
    return map[`${serverId}:${sessionId}`] ?? false;
  } catch {
    return false;
  }
}

function setStoredState(serverId: string, sessionId: string, enabled: boolean): void {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const map = stored ? (JSON.parse(stored) as Record<string, boolean>) : {};
    map[`${serverId}:${sessionId}`] = enabled;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Silently ignore
  }
}

interface UseAutoApproveReturn {
  enabled: boolean;
  toggle: () => void;
  loading: boolean;
}

export function useAutoApprove(serverId: string | null, sessionId?: string | null): UseAutoApproveReturn {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!serverId || !sessionId) {
      setEnabled(false);
      return;
    }
    const stored = getStoredState(serverId, sessionId);
    setEnabled(stored);

    // Sync stored state to daemon on mount/session change
    if (stored) {
      const conn = connectionManager.getConnection(serverId);
      if (conn && conn.isConnected()) {
        conn.sendRequest('set_auto_approve', { enabled: true, sessionId }).catch(() => {});
      }
    }
  }, [serverId, sessionId]);

  const toggle = useCallback(async () => {
    if (!serverId || !sessionId || loading) return;

    const newState = !enabled;
    setLoading(true);

    const conn = connectionManager.getConnection(serverId);
    if (conn && conn.isConnected()) {
      try {
        await conn.sendRequest('set_auto_approve', { enabled: newState, sessionId });
      } catch {
        // Proceed anyway -- persist locally
      }
    }

    setEnabled(newState);
    setStoredState(serverId, sessionId, newState);
    setLoading(false);
  }, [serverId, sessionId, enabled, loading]);

  return { enabled, toggle, loading };
}
