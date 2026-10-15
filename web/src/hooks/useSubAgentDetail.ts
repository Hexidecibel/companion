/**
 * One agent's conversation highlights (get_agent_detail). Only fetched while
 * `enabled` (an expanded tile / the focused agent). Polls every 3 s while the
 * agent runs, stops once it has finished (a `version` change refetches), and
 * backs off to 10 s while disconnected. The interval is re-decided after every
 * fetch (it used to be fixed at 3 s from a ref, also for finished agents).
 */
import { useState, useEffect, useRef } from 'react';
import type { SubAgent, ConversationHighlight, WebSocketResponse } from '../types';
import { connectionManager } from '../services/ConnectionManager';

export const POLL_RUNNING = 3000;
export const POLL_DISCONNECTED = 10000;

export interface DetailTransport {
  isConnected: () => boolean;
  request: (type: string, payload: unknown) => Promise<WebSocketResponse>;
}

interface UseSubAgentDetailReturn {
  agent: SubAgent | null;
  highlights: ConversationHighlight[];
  loading: boolean;
}

export interface SubAgentDetailOptions {
  /** Fetch at all (default true). */
  enabled?: boolean;
  /** Changes (e.g. the summary version) trigger a refetch, also for finished agents. */
  version?: number;
  transport?: DetailTransport | null;
}

function transportFor(serverId: string): DetailTransport | null {
  const conn = connectionManager.getConnection(serverId);
  if (!conn) return null;
  return { isConnected: () => conn.isConnected(), request: (t, p) => conn.sendRequest(t, p) };
}

/** Next poll delay after a fetch; null = stop polling. */
export function nextDetailDelay(connected: boolean, status: SubAgent['status'] | null): number | null {
  if (!connected) return POLL_DISCONNECTED;
  if (status === null || status === 'running') return POLL_RUNNING;
  return null;
}

export function useSubAgentDetail(
  serverId: string | null,
  agentId: string | null,
  opts: SubAgentDetailOptions = {},
): UseSubAgentDetailReturn {
  const { enabled = true, version } = opts;
  const [agent, setAgent] = useState<SubAgent | null>(null);
  const [highlights, setHighlights] = useState<ConversationHighlight[]>([]);
  const [loading, setLoading] = useState(false);
  const transportRef = useRef(opts.transport);
  transportRef.current = opts.transport;
  const sigRef = useRef('');

  // Runs before the fetch effect below (declaration order).
  useEffect(() => {
    sigRef.current = '';
  }, [serverId, agentId]);

  useEffect(() => {
    if (!serverId || !agentId || !enabled) {
      if (!enabled) setLoading(false);
      if (!serverId || !agentId) {
        setAgent(null);
        setHighlights([]);
        setLoading(false);
      }
      return;
    }
    const t = transportRef.current !== undefined ? transportRef.current : transportFor(serverId);
    if (!t) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let status: SubAgent['status'] | null = null;
    if (!sigRef.current) setLoading(true);

    const fetchDetail = async () => {
      if (!alive) return;
      const connected = t.isConnected();
      if (connected) {
        try {
          const res = await t.request('get_agent_detail', { agentId });
          if (!alive) return;
          if (res.success && res.payload) {
            const p = res.payload as { agent: SubAgent; highlights: ConversationHighlight[] };
            status = p.agent.status;
            const last = p.highlights[p.highlights.length - 1];
            const sig = `${p.agent.status}|${p.highlights.length}|${last?.id ?? ''}|${last?.content?.length ?? 0}`;
            if (sig !== sigRef.current) {
              sigRef.current = sig;
              setAgent(p.agent);
              setHighlights(p.highlights);
            }
          }
        } catch {
          // ignore; retried below
        } finally {
          if (alive) setLoading(false);
        }
      }
      if (!alive) return;
      const delay = nextDetailDelay(t.isConnected(), status);
      if (delay !== null) timer = setTimeout(fetchDetail, delay);
    };
    void fetchDetail();

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [serverId, agentId, enabled, version]);

  return { agent, highlights, loading };
}
