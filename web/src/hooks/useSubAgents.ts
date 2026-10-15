/**
 * Subagents of one session for the dispatch panel.
 *
 * Newer daemons: one `subagent_list`, then `subagent_watch` live deltas
 * (`subagent_update`, coalesced by the daemon), re-listed on reconnect and as a
 * 15 s safety net. Older daemons (no subagent_list): the original
 * `get_agent_tree` poll (2 s while running, 5 s idle). Either way React state is
 * only set when what the panel shows actually changed.
 */
import { useState, useEffect, useRef } from 'react';
import type { SubAgent, WebSocketResponse } from '../types';
import type { SubagentListResponse, SubagentSummary, SubagentUpdateEvent } from '../types/subagents';
import { connectionManager } from '../services/ConnectionManager';
import { applyUpdate, listSignature, panelVisible, summaryToSubAgent } from '../services/subagents';

const POLL_FAST = 2000;
const POLL_SLOW = 5000;
export const SAFETY_RELIST_MS = 15000;
const RETRY_MS = 2000;

export interface SubAgentsTransport {
  isConnected: () => boolean;
  request: (type: string, payload: unknown) => Promise<WebSocketResponse>;
  onMessage: (h: (m: WebSocketResponse) => void) => () => void;
  onReconnect: (h: () => void) => () => void;
}

function transportFor(serverId: string): SubAgentsTransport | null {
  const conn = connectionManager.getConnection(serverId);
  if (!conn) return null;
  return {
    isConnected: () => conn.isConnected(),
    request: (type, payload) => conn.sendRequest(type, payload),
    onMessage: (h) => conn.onMessage(h),
    onReconnect: (h) => conn.onReconnect(h),
  };
}

interface UseSubAgentsReturn {
  agents: SubAgent[];
  runningCount: number;
  completedCount: number;
  totalAgents: number;
  loading: boolean;
  error: string | null;
  /** 'watch' = live deltas from the tracker; 'legacy' = get_agent_tree polling. */
  mode: 'watch' | 'legacy' | null;
}

interface Snapshot {
  agents: SubAgent[];
  runningCount: number;
  completedCount: number;
  totalAgents: number;
}

const EMPTY: Snapshot = { agents: [], runningCount: 0, completedCount: 0, totalAgents: 0 };

function isUnknownType(res: WebSocketResponse): boolean {
  return !res.success && /unknown message type/i.test(res.error || '');
}

export function useSubAgents(
  serverId: string | null,
  sessionId: string | null,
  transport?: SubAgentsTransport | null,
): UseSubAgentsReturn {
  const [snap, setSnap] = useState<Snapshot>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'watch' | 'legacy' | null>(null);
  const sigRef = useRef('');
  const transportRef = useRef(transport);
  transportRef.current = transport;

  useEffect(() => {
    sigRef.current = '';
    setSnap(EMPTY);
    setError(null);
    setMode(null);
    if (!serverId || !sessionId) {
      setLoading(false);
      return;
    }
    const t = transportRef.current !== undefined ? transportRef.current : transportFor(serverId);
    if (!t) {
      setLoading(false);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let currentMode: 'watch' | 'legacy' | null = null;
    let summaries = new Map<string, SubagentSummary>();
    let running = 0;
    setLoading(true);

    const publish = (agents: SubAgent[], counts?: { running: number; completed: number }) => {
      if (!alive) return;
      const sig = listSignature(agents);
      if (sig === sigRef.current) return;
      sigRef.current = sig;
      const r = counts ? counts.running : agents.filter((a) => a.status === 'running').length;
      running = r;
      setSnap({
        agents,
        runningCount: r,
        completedCount: counts ? counts.completed : agents.length - r,
        totalAgents: agents.length,
      });
    };

    const publishSummaries = () => {
      const now = Date.now();
      const agents = [...summaries.values()]
        .filter((s) => panelVisible(s, now))
        .sort((a, b) => b.lastEntryAt - a.lastEntryAt)
        .map(summaryToSubAgent);
      publish(agents);
    };

    const arm = (ms: number, fn: () => void) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(fn, ms);
    };

    const pollLegacy = async () => {
      if (!alive) return;
      if (!t.isConnected()) {
        arm(POLL_SLOW, pollLegacy);
        return;
      }
      try {
        const res = await t.request('get_agent_tree', { sessionId });
        if (!alive) return;
        if (res.success && res.payload) {
          const p = res.payload as { agents: SubAgent[]; runningCount: number; completedCount: number };
          publish(p.agents, { running: p.runningCount, completed: p.completedCount });
          setError(null);
        } else if (!res.success) setError(res.error || 'Failed to load agents');
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'Failed to load agents');
      } finally {
        if (alive) {
          setLoading(false);
          arm(running > 0 ? POLL_FAST : POLL_SLOW, pollLegacy);
        }
      }
    };

    const watch = (live: boolean) =>
      t.request('subagent_watch', { sessionId, live }).catch(() => undefined);

    const list = async () => {
      if (!alive) return;
      if (!t.isConnected()) {
        arm(RETRY_MS, list);
        return;
      }
      try {
        const res = await t.request('subagent_list', { sessionId });
        if (!alive) return;
        if (isUnknownType(res) || (!res.success && (res.payload as { code?: string } | undefined)?.code === 'unavailable')) {
          // Older daemon (or tracker off): the original polling path.
          currentMode = 'legacy';
          setMode('legacy');
          void pollLegacy();
          return;
        }
        if (res.success && res.payload) {
          const p = res.payload as SubagentListResponse;
          summaries = new Map(p.agents.map((a) => [a.agentId, a]));
          publishSummaries();
          setError(null);
          if (currentMode !== 'watch') {
            currentMode = 'watch';
            setMode('watch');
            void watch(true);
          }
        } else setError(res.error || 'Failed to load agents');
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'Failed to load agents');
      } finally {
        if (alive) setLoading(false);
        if (alive && currentMode !== 'legacy') arm(currentMode === 'watch' ? SAFETY_RELIST_MS : RETRY_MS, list);
      }
    };

    const offMsg = t.onMessage((m) => {
      if (m.type !== 'subagent_update' || currentMode !== 'watch') return;
      const ev = m.payload as SubagentUpdateEvent | undefined;
      if (!ev || ev.sessionId !== sessionId) return;
      const next = applyUpdate(summaries, ev);
      if (next === summaries) return;
      summaries = next;
      publishSummaries();
    });
    const offRe = t.onReconnect(() => {
      if (currentMode === 'legacy') return;
      currentMode = currentMode === 'watch' ? null : currentMode;
      void list();
    });

    void list();

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      offMsg();
      offRe();
      if (currentMode === 'watch') void watch(false);
    };
  }, [serverId, sessionId]);

  return { ...snap, loading, error, mode };
}

