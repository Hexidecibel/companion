import { useState, useEffect, useRef } from 'react';
import { SubAgent, ConversationHighlight } from '../types';
import { connectionManager } from '../services/ConnectionManager';

const POLL_RUNNING = 3000;
const POLL_DONE = 10000;

interface UseSubAgentDetailReturn {
  agent: SubAgent | null;
  highlights: ConversationHighlight[];
  loading: boolean;
}

export function useSubAgentDetail(
  serverId: string | null,
  agentId: string | null,
): UseSubAgentDetailReturn {
  const [agent, setAgent] = useState<SubAgent | null>(null);
  const [highlights, setHighlights] = useState<ConversationHighlight[]>([]);
  const [loading, setLoading] = useState(false);
  const mountedRef = useRef(true);
  const agentStatusRef = useRef<string>('running');

  useEffect(() => {
    mountedRef.current = true;

    if (!serverId || !agentId) {
      setAgent(null);
      setHighlights([]);
      setLoading(false);
      return;
    }

    setLoading(true);

    async function fetchDetail() {
      const conn = connectionManager.getConnection(serverId!);
      if (!conn || !conn.isConnected()) return;

      try {
        const response = await conn.sendRequest('get_agent_detail', { agentId });
        if (!mountedRef.current) return;

        if (response.success && response.payload) {
          const payload = response.payload as {
            agent: SubAgent;
            highlights: ConversationHighlight[];
          };
          setAgent(payload.agent);
          setHighlights(payload.highlights);
          agentStatusRef.current = payload.agent.status;
        }
      } catch {
        // Silently ignore
      } finally {
        if (mountedRef.current) {
          setLoading(false);
        }
      }
    }

    fetchDetail();

    const timer = setInterval(() => {
      fetchDetail();
    }, agentStatusRef.current === 'running' ? POLL_RUNNING : POLL_DONE);

    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, [serverId, agentId]);

  return { agent, highlights, loading };
}
