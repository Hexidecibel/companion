import { useState, useCallback } from 'react';
import { connectionManager } from '../services/ConnectionManager';

export interface NotificationHistoryEntry {
  id: string;
  timestamp: number;
  eventType: string;
  sessionId?: string;
  sessionName?: string;
  preview: string;
  tier: 'browser' | 'push' | 'both';
  acknowledged: boolean;
}

interface UseNotificationHistoryReturn {
  entries: NotificationHistoryEntry[];
  total: number;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  clear: () => Promise<boolean>;
}

export function useNotificationHistory(serverId: string | null): UseNotificationHistoryReturn {
  const [entries, setEntries] = useState<NotificationHistoryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!serverId) return;
    const conn = connectionManager.getConnection(serverId);
    if (!conn || !conn.isConnected()) return;

    setLoading(true);
    setError(null);
    try {
      const response = await conn.sendRequest('get_notification_history', { limit: 100 });
      if (response.success && response.payload) {
        const payload = response.payload as { entries: NotificationHistoryEntry[]; total: number };
        setEntries(payload.entries ?? []);
        setTotal(payload.total ?? 0);
      } else {
        setError(response.error ?? 'Failed to fetch history');
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  const clear = useCallback(async (): Promise<boolean> => {
    if (!serverId) return false;
    const conn = connectionManager.getConnection(serverId);
    if (!conn || !conn.isConnected()) return false;

    try {
      const response = await conn.sendRequest('clear_notification_history');
      if (response.success) {
        setEntries([]);
        setTotal(0);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, [serverId]);

  return { entries, total, loading, error, refresh, clear };
}
