import { useState, useEffect, useRef } from 'react';
import { SubAgent } from '../types';
import { connectionManager } from '../services/ConnectionManager';

const POLL_FAST = 2000;
const POLL_SLOW = 5000;

interface UseSubAgentsReturn {
  agents: SubAgent[];
  runningCount: number;
  completedCount: number;
  totalAgents: number;
  loading: boolean;
  error: string | null;
}

export function useSubAgents(
  serverId: string | null,
  sessionId: string | null,
): UseSubAgentsReturn {
  const [agents, setAgents] = useState<SubAgent[]>([]);
  const [runningCount, setRunningCount] = useState(0);
  const [completedCount, setCompletedCount] = useState(0);
  const [totalAgents, setTotalAgents] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const runningRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;

    if (!serverId || !sessionId) {
      setAgents([]);
      setRunningCount(0);
      setCompletedCount(0);
      setTotalAgents(0);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    let timer: ReturnType<typeof setTimeout>;

    async function fetchAgents() {
      const conn = connectionManager.getConnection(serverId!);
      if (!conn || !conn.isConnected()) {
        scheduleNext();
        return;
      }

      try {
        const response = await conn.sendRequest('get_agent_tree', { sessionId });
        if (!mountedRef.current) return;

        if (response.success && response.payload) {
          const payload = response.payload as {
            agents: SubAgent[];
            totalAgents: number;
            runningCount: number;
            completedCount: number;
          };
          setAgents(payload.agents);
          setRunningCount(payload.runningCount);
          setCompletedCount(payload.completedCount);
          setTotalAgents(payload.totalAgents);
          runningRef.current = payload.runningCount;
          setError(null);
        } else if (!response.success) {
          setError(response.error || 'Failed to load agents');
        }
      } catch (err) {
        if (mountedRef.current) {
          setError(err instanceof Error ? err.message : 'Failed to load agents');
        }
      } finally {
        if (mountedRef.current) {
          setLoading(false);
          scheduleNext();
        }
      }
    }

    function scheduleNext() {
      if (!mountedRef.current) return;
      const interval = runningRef.current > 0 ? POLL_FAST : POLL_SLOW;
      timer = setTimeout(fetchAgents, interval);
    }

    fetchAgents();

    return () => {
      mountedRef.current = false;
      clearTimeout(timer);
    };
  }, [serverId, sessionId]);

  return { agents, runningCount, completedCount, totalAgents, loading, error };
}
