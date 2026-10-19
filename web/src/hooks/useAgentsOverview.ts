/**
 * The all-sessions Agents model, live: follows every server's subagents through
 * the shared `agentsStore` (released on unmount) and re-derives the page model
 * on every delta plus a slow clock (elapsed times), never while hidden.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ServerSummary } from '../types';
import { agentsStore, type AgentsServerState } from '../services/agentsStore';
import { buildAgentsOverview, type AgentsOverview } from '../services/agentsOverview';

const CLOCK_MS = 15_000;

function useSlowClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') setNow(Date.now());
    };
    const t = setInterval(tick, CLOCK_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);
  return now;
}

export function useAgentsServers(): AgentsServerState[] {
  useEffect(() => agentsStore.retain(), []);
  return useSyncExternalStore(agentsStore.subscribe, agentsStore.getSnapshot);
}

export function useAgentsOverview(summaries?: Map<string, ServerSummary>): {
  overview: AgentsOverview;
  servers: AgentsServerState[];
  loaded: boolean;
} {
  const servers = useAgentsServers();
  const clock = useSlowClock();
  const overview = useMemo(
    () =>
      buildAgentsOverview(
        servers
          .filter((s) => !s.unsupported)
          .map((s) => ({
            serverId: s.serverId,
            serverName: s.serverName,
            agents: s.agents,
            labels: s.labels,
            sessions: summaries?.get(s.serverId)?.sessions,
          })),
        Math.max(clock, Date.now()),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [servers, summaries, clock],
  );
  return { overview, servers, loaded: servers.length === 0 || servers.some((s) => s.loaded) };
}
