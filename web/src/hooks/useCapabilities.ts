import { useState, useCallback, useEffect } from 'react';
import { connectionManager } from '../services/ConnectionManager';
import { DaemonCapabilities } from '../types';

interface UseCapabilitiesReturn {
  caps: DaemonCapabilities | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useCapabilities(serverId: string | null): UseCapabilitiesReturn {
  const [caps, setCaps] = useState<DaemonCapabilities | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!serverId) return;
    const conn = connectionManager.getConnection(serverId);
    if (!conn || !conn.isConnected()) {
      setError('Not connected');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await conn.sendRequest('get_capabilities');
      if (response.success && response.payload) {
        const payload = response.payload as DaemonCapabilities;
        setCaps(payload);
      } else {
        setError(response.error ?? 'Failed to fetch capabilities');
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  // Auto-load on mount / serverId change
  useEffect(() => {
    if (serverId) {
      refresh();
    } else {
      setCaps(null);
    }
  }, [serverId, refresh]);

  return { caps, loading, error, refresh };
}
