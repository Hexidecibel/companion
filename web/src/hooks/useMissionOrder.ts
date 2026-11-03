import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ServerSummary, SessionSummary } from '../types';
import {
  loadMissionOrder, saveMissionOrder, onMissionOrderChange, reconcileOrder, moveInOrder, missionKey,
} from '../services/missionOrder';

export interface MissionEntry {
  key: string;
  serverId: string;
  session: SessionSummary;
}

/**
 * All sessions on all servers in the saved Mission Control order (new ones at
 * the end, most recently active first among a batch). Shared by the overview
 * and the desktop Mod+Alt+1..9 jump keys.
 */
export function useMissionOrder(summaries: Map<string, ServerSummary>) {
  const saved = useSyncExternalStore(onMissionOrderChange, loadMissionOrder, loadMissionOrder);

  const { order, byKey } = useMemo(() => {
    const byKey = new Map<string, MissionEntry>();
    const live: { key: string; lastActivity: number }[] = [];
    for (const [serverId, summary] of summaries) {
      for (const session of summary.sessions) {
        const key = missionKey(serverId, session.id);
        if (byKey.has(key)) continue;
        byKey.set(key, { key, serverId, session });
        live.push({ key, lastActivity: session.lastActivity });
      }
    }
    live.sort((a, b) => b.lastActivity - a.lastActivity);
    const order = reconcileOrder(saved, live.map((l) => l.key), new Set(summaries.keys()));
    return { order, byKey };
  }, [summaries, saved]);

  // Remember new sessions' slots (no-op when unchanged).
  useEffect(() => {
    saveMissionOrder(order);
  }, [order]);

  const entries = useMemo(
    () => order.map((k) => byKey.get(k)).filter((e): e is MissionEntry => !!e),
    [order, byKey],
  );

  /** Move one step past the next visible key (default: every live session; a section passes its own keys). */
  const move = useCallback((key: string, dir: -1 | 1, visible?: Set<string>) => {
    saveMissionOrder(moveInOrder(order, key, dir, visible ?? new Set(byKey.keys())));
  }, [order, byKey]);

  return { entries, move };
}
