import { useState, useEffect, useRef } from 'react';
import { SubAgent } from '../types';
import { connectionManager } from '../services/ConnectionManager';

const POLL_INTERVAL = 5000;

interface UseSubAgentsReturn {
  agents: SubAgent[];
  runningCount: number;
  completedCount: number;
  totalAgents: number;
  loading: boolean;
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
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    if (!serverId || !sessionId) {
      setAgents([]);
      setRunningCount(0);
      setCompletedCount(0);
      setTotalAgents(0);
      setLoading(false);
      return;
    }

    setLoading(true);

    async function fetchAgents() {
      const conn = connectionManager.getConnection(serverId!);
      if (!conn || !conn.isConnected()) return;

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
        }
      } catch {
        // Silently ignore
      } finally {
        if (mountedRef.current) {
          setLoading(false);
        }
      }
    }

    fetchAgents();
    const timer = setInterval(fetchAgents, POLL_INTERVAL);

    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, [serverId, sessionId]);

  return { agents, runningCount, completedCount, totalAgents, loading };
}
