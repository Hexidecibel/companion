import { useCallback, useEffect, useState } from 'react';
import { isTauriDesktop } from '../utils/platform';

/** Mirrors `UpdateStatus` in desktop/src-tauri/src/updater.rs. */
export interface AppUpdateStatus {
  currentVersion: string;
  state:
    | 'disabled'
    | 'idle'
    | 'checking'
    | 'up-to-date'
    | 'downloading'
    | 'ready'
    | 'installing'
    | 'error';
  version: string | null;
  notes: string | null;
  error: string | null;
  autoInstallOnQuit: boolean;
  lastCheck: number | null;
}

export const UPDATER_STATUS_EVENT = 'updater-status';

/**
 * Desktop auto-update state (Tauri only; null elsewhere). The native side does
 * the checking/downloading; this only reflects it and forwards actions.
 */
export function useAppUpdater() {
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);

  useEffect(() => {
    if (!isTauriDesktop()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const { listen } = await import('@tauri-apps/api/event');
        const off = await listen<AppUpdateStatus>(UPDATER_STATUS_EVENT, (e) => setStatus(e.payload));
        if (cancelled) {
          off();
          return;
        }
        unlisten = off;
        const initial = await invoke<AppUpdateStatus | null>('updater_status');
        if (!cancelled && initial) setStatus(initial);
      } catch {
        // Older native shell without the updater: stay hidden.
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const checkNow = useCallback(async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const next = await invoke<AppUpdateStatus | null>('updater_check');
      if (next) setStatus(next);
    } catch {
      // Quiet: status event carries any error.
    }
  }, []);

  const installNow = useCallback(async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('updater_install');
  }, []);

  const setAutoInstall = useCallback(async (enabled: boolean) => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const next = await invoke<AppUpdateStatus | null>('updater_set_auto_install', { enabled });
      if (next) setStatus(next);
    } catch {
      // Ignore; the toggle keeps its previous value.
    }
  }, []);

  return { status, checkNow, installNow, setAutoInstall };
}
