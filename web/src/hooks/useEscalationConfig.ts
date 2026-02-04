import { useState, useCallback } from 'react';
import { connectionManager } from '../services/ConnectionManager';

export interface EscalationConfig {
  events: {
    waiting_for_input: boolean;
    error_detected: boolean;
    session_completed: boolean;
    worker_waiting: boolean;
    worker_error: boolean;
    work_group_ready: boolean;
  };
  pushDelaySeconds: number;
  rateLimitSeconds: number;
  quietHours: {
    enabled: boolean;
    start: string;
    end: string;
  };
}

interface UseEscalationConfigReturn {
  config: EscalationConfig | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  update: (updates: Partial<EscalationConfig>) => Promise<boolean>;
}

const DEFAULT_CONFIG: EscalationConfig = {
  events: {
    waiting_for_input: true,
    error_detected: true,
    session_completed: false,
    worker_waiting: true,
    worker_error: true,
    work_group_ready: true,
  },
  pushDelaySeconds: 300,
  rateLimitSeconds: 60,
  quietHours: {
    enabled: false,
    start: '22:00',
    end: '08:00',
  },
};

export function useEscalationConfig(serverId: string | null): UseEscalationConfigReturn {
  const [config, setConfig] = useState<EscalationConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!serverId) return;
    const conn = connectionManager.getConnection(serverId);
    if (!conn || !conn.isConnected()) return;

    setLoading(true);
    setError(null);
    try {
      const response = await conn.sendRequest('get_escalation_config');
      if (response.success && response.payload) {
        const payload = response.payload as { config: EscalationConfig };
        setConfig(payload.config ?? DEFAULT_CONFIG);
      } else {
        setError(response.error ?? 'Failed to fetch escalation config');
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  const update = useCallback(async (updates: Partial<EscalationConfig>): Promise<boolean> => {
    if (!serverId) return false;
    const conn = connectionManager.getConnection(serverId);
    if (!conn || !conn.isConnected()) return false;

    try {
      const response = await conn.sendRequest('update_escalation_config', updates);
      if (response.success && response.payload) {
        const payload = response.payload as { config: EscalationConfig };
        setConfig(payload.config);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, [serverId]);

  return { config, loading, error, refresh, update };
}
