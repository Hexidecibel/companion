import { useState, useEffect, useCallback, useRef } from 'react';
import { UsageDashboardData } from '../types';
import { connectionManager } from '../services/ConnectionManager';

interface UseUsageReturn {
  data: UsageDashboardData | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useUsage(serverId: string | null): UseUsageReturn {
  const [data, setData] = useState<UsageDashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const fetchData = useCallback(async () => {
    if (!serverId) return;

    const conn = connectionManager.getConnection(serverId);
    if (!conn || !conn.isConnected()) return;

    setLoading(true);
    setError(null);

    try {
      const response = await conn.sendRequest('get_oauth_usage', {}, 15000);
      if (!mountedRef.current) return;

      if (response.success && response.payload) {
        setData(response.payload as UsageDashboardData);
      } else {
        setError(response.error || 'Failed to fetch usage data');
      }
    } catch {
      if (mountedRef.current) {
        setError('Failed to connect to server');
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [serverId]);

  useEffect(() => {
    mountedRef.current = true;
    fetchData();

    // Auto-refresh every 3 minutes
    const interval = setInterval(fetchData, 3 * 60 * 1000);

    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [fetchData]);

  return { data, loading, error, refresh: fetchData };
}
