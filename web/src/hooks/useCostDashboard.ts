import { useState, useEffect, useCallback, useRef } from 'react';
import { CostDashboardData } from '../types';
import { connectionManager } from '../services/ConnectionManager';

type Period = '7d' | '30d';

interface UseCostDashboardReturn {
  data: CostDashboardData | null;
  loading: boolean;
  error: string | null;
  period: Period;
  setPeriod: (p: Period) => void;
  refresh: () => void;
}

export function useCostDashboard(serverId: string | null): UseCostDashboardReturn {
  const [data, setData] = useState<CostDashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>('7d');
  const mountedRef = useRef(true);

  const fetchData = useCallback(async () => {
    if (!serverId) return;

    const conn = connectionManager.getConnection(serverId);
    if (!conn || !conn.isConnected()) return;

    setLoading(true);
    setError(null);

    try {
      const response = await conn.sendRequest('get_cost_dashboard', { period }, 30000);
      if (!mountedRef.current) return;

      if (response.success && response.payload) {
        setData(response.payload as CostDashboardData);
      } else {
        setError(response.error || 'Failed to fetch cost data');
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
  }, [serverId, period]);

  useEffect(() => {
    mountedRef.current = true;
    fetchData();
    return () => { mountedRef.current = false; };
  }, [fetchData]);

  return { data, loading, error, period, setPeriod, refresh: fetchData };
}
