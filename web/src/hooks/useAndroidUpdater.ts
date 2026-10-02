import { useCallback, useEffect, useRef, useState } from 'react';
import { nativePlatform } from '../utils/platform';
import {
  ANDROID_CHECK_INTERVAL_MS,
  ANDROID_UPDATE_FEED,
  isNewerBuild,
  parseAndroidFeed,
  shouldCheck,
  updateErrorCode,
  type AndroidFeedEntry,
  type AndroidInstalledInfo,
} from '../services/androidUpdate';

export type AndroidUpdatePhase = 'idle' | 'downloading' | 'needs_permission' | 'installer' | 'error';

export interface AndroidUpdateState {
  available: AndroidFeedEntry | null;
  installed: AndroidInstalledInfo | null;
  phase: AndroidUpdatePhase;
  /** 0..1 while downloading, null when the size is unknown. */
  progress: number | null;
  error: string | null;
}

const INITIAL: AndroidUpdateState = { available: null, installed: null, phase: 'idle', progress: null, error: null };

async function tauri() {
  return import('@tauri-apps/api/core');
}

/**
 * Android app only (null-ish elsewhere): checks the sideload feed on launch and
 * every 6 hours, and drives the native download / verify / installer flow.
 */
export function useAndroidUpdater() {
  const enabled = nativePlatform() === 'android';
  const [state, setState] = useState<AndroidUpdateState>(INITIAL);
  const lastCheck = useRef<number | null>(null);
  const checking = useRef(false);

  const check = useCallback(async (force = false) => {
    if (!enabled || checking.current) return;
    if (!force && !shouldCheck(lastCheck.current, Date.now())) return;
    checking.current = true;
    lastCheck.current = Date.now();
    try {
      const { invoke } = await tauri();
      const installed = await invoke<AndroidInstalledInfo>('plugin:herald-native|app_update_info');
      const res = await invoke<{ body: string }>('plugin:herald-native|app_update_fetch_feed', { url: ANDROID_UPDATE_FEED });
      const entry = parseAndroidFeed(res?.body ?? '');
      setState((s) => ({ ...s, installed, available: isNewerBuild(entry, installed?.versionCode) ? entry : null }));
    } catch {
      // Offline, older native shell, or no feed yet: try again next interval.
    } finally {
      checking.current = false;
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    void check(true);
    const t = setInterval(() => void check(), ANDROID_CHECK_INTERVAL_MS);
    // Android freezes timers in the background: re-check when the app returns.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, check]);

  const install = useCallback(async () => {
    const entry = state.available;
    if (!entry) return;
    setState((s) => ({ ...s, phase: 'downloading', progress: 0, error: null }));
    try {
      const { invoke, Channel } = await tauri();
      const onProgress = new Channel<{ received: number; total: number }>();
      onProgress.onmessage = (p) => {
        const total = p.total > 0 ? p.total : entry.size ?? 0;
        setState((s) => ({ ...s, progress: total > 0 ? Math.min(1, p.received / total) : null }));
      };
      await invoke('plugin:herald-native|app_update_install', {
        url: entry.url,
        sha256: entry.sha256,
        versionCode: entry.versionCode,
        onProgress,
      });
      setState((s) => ({ ...s, phase: 'installer', progress: null }));
    } catch (err) {
      const { code, message } = updateErrorCode(err);
      if (code === 'install_permission') setState((s) => ({ ...s, phase: 'needs_permission', progress: null }));
      else setState((s) => ({ ...s, phase: 'error', progress: null, error: message || 'Update failed' }));
    }
  }, [state.available]);

  const openSettings = useCallback(async () => {
    try {
      const { invoke } = await tauri();
      await invoke('plugin:herald-native|app_update_open_settings');
    } catch {
      // Nothing else to do: the banner keeps its explanation.
    }
  }, []);

  return { enabled, state, check, install, openSettings };
}
