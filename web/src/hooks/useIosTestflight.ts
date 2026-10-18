import { useCallback, useEffect, useRef, useState } from 'react';
import { nativePlatform } from '../utils/platform';
import { shouldCheck } from '../services/androidUpdate';
import {
  IOS_CHECK_INTERVAL_MS,
  IOS_TESTFLIGHT_FEED,
  TESTFLIGHT_APP_STORE_URL,
  isNewerIosBuild,
  parseIosFeed,
  type IosFeedEntry,
} from '../services/iosTestflight';

async function tauri() {
  return import('@tauri-apps/api/core');
}

/**
 * iOS app only: checks ios.json on launch, every 6 hours and when the app comes
 * back, and offers to open TestFlight when a newer build is there.
 */
export function useIosTestflight() {
  const enabled = nativePlatform() === 'ios';
  const [available, setAvailable] = useState<IosFeedEntry | null>(null);
  const [installedBuild, setInstalledBuild] = useState<number | null>(null);
  const lastCheck = useRef<number | null>(null);
  const checking = useRef(false);

  const check = useCallback(async (force = false) => {
    if (!enabled || checking.current) return;
    if (!force && !shouldCheck(lastCheck.current, Date.now())) return;
    checking.current = true;
    lastCheck.current = Date.now();
    try {
      const { invoke } = await tauri();
      const info = await invoke<{ versionCode: number }>('plugin:herald-native|app_update_info');
      const res = await invoke<{ body: string }>('plugin:herald-native|app_update_fetch_feed', { url: IOS_TESTFLIGHT_FEED });
      const entry = parseIosFeed(res?.body ?? '');
      const build = typeof info?.versionCode === 'number' ? info.versionCode : null;
      setInstalledBuild(build);
      setAvailable(isNewerIosBuild(entry, build) ? entry : null);
    } catch {
      // Offline, an older native shell, or no feed yet: try again next interval.
    } finally {
      checking.current = false;
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    void check(true);
    const t = setInterval(() => void check(), IOS_CHECK_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, check]);

  const openTestflight = useCallback(async () => {
    const { invoke } = await tauri();
    try {
      await invoke('plugin:opener|open_url', { url: available?.testflightUrl ?? 'itms-beta://' });
    } catch {
      // TestFlight not installed or the scheme refused: its App Store page.
      try {
        await invoke('plugin:opener|open_url', { url: TESTFLIGHT_APP_STORE_URL });
      } catch {
        // Nothing else to do.
      }
    }
  }, [available]);

  return { enabled, available, installedBuild, check, openTestflight };
}
