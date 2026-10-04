import { useMemo, useSyncExternalStore } from 'react';
import type { StuckFinding, StuckSettings } from '../types/stuck';
import { ensureStuckStore, stuckStore } from '../services/stuckStore';

const subscribe = (cb: () => void) => ensureStuckStore().subscribe(cb);
const tick = () => stuckStore.getTick();

/** Visible stuck findings for one session (most urgent first). */
export function useStuckFindings(serverId: string | null | undefined, sessionId: string | null | undefined): StuckFinding[] {
  const t = useSyncExternalStore(subscribe, tick, tick);
  return useMemo(() => {
    void t;
    return stuckStore.forSession(serverId, sessionId);
  }, [serverId, sessionId, t]);
}

/** Stuck settings for a server (null until known). */
export function useStuckSettings(serverId: string | null | undefined): { settings: StuckSettings | null; supported: boolean | null } {
  useSyncExternalStore(subscribe, tick, tick);
  return { settings: stuckStore.settings(serverId), supported: stuckStore.supported(serverId) };
}
