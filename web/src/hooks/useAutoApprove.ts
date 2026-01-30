import { useState, useEffect, useCallback } from 'react';
import { connectionManager } from '../services/ConnectionManager';

const STORAGE_KEY = 'companion_auto_approve';

function getStoredState(serverId: string): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return false;
    const map = JSON.parse(stored) as Record<string, boolean>;
    return map[serverId] ?? false;
  } catch {
    return false;
  }
}

function setStoredState(serverId: string, enabled: boolean): void {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const map = stored ? (JSON.parse(stored) as Record<string, boolean>) : {};
    map[serverId] = enabled;
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

export function useAutoApprove(serverId: string | null): UseAutoApproveReturn {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!serverId) {
      setEnabled(false);
      return;
    }
    setEnabled(getStoredState(serverId));
  }, [serverId]);

  const toggle = useCallback(async () => {
    if (!serverId || loading) return;

    const newState = !enabled;
    setLoading(true);

    const conn = connectionManager.getConnection(serverId);
    if (conn && conn.isConnected()) {
      try {
        await conn.sendRequest('set_auto_approve', { enabled: newState });
      } catch {
        // Proceed anyway -- persist locally
      }
    }

    setEnabled(newState);
    setStoredState(serverId, newState);
    setLoading(false);
  }, [serverId, enabled, loading]);

  return { enabled, toggle, loading };
}
