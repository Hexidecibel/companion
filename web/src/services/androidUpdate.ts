/**
 * Android sideload updater, web side. The feed entry is
 * <feed>/stable/android.json (published by `bin/companion publish-update --apk`);
 * the native side (tauri-plugin-herald-native ApkUpdater.kt) fetches it,
 * downloads the APK, verifies sha256 + package + versionCode + the SAME signing
 * certificate as the installed app, and opens the system installer.
 * This module only decides WHEN to check and WHETHER to offer an update.
 */
export const ANDROID_UPDATE_FEED = 'https://dev.cush.rocks/updates/stable/android.json';
export const ANDROID_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface AndroidFeedEntry {
  versionCode: number;
  versionName: string;
  url: string;
  sha256: string;
  size: number | null;
  notes: string | null;
}

export interface AndroidInstalledInfo {
  packageName: string;
  versionCode: number;
  versionName: string;
  canInstall: boolean;
}

/** A valid feed entry, or null (anything malformed is ignored, never offered). */
export function parseAndroidFeed(body: string): AndroidFeedEntry | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const code = r.versionCode;
  if (typeof code !== 'number' || !Number.isSafeInteger(code) || code <= 0) return null;
  if (typeof r.url !== 'string' || !/^https:\/\/[^\s]+\.apk$/i.test(r.url)) return null;
  if (typeof r.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(r.sha256)) return null;
  return {
    versionCode: code,
    versionName: typeof r.versionName === 'string' && r.versionName ? r.versionName : String(code),
    url: r.url,
    sha256: r.sha256.toLowerCase(),
    size: typeof r.size === 'number' && Number.isFinite(r.size) ? r.size : null,
    notes: typeof r.notes === 'string' ? r.notes : null,
  };
}

/** Offer only a strictly higher versionCode than the installed one. */
export function isNewerBuild(entry: AndroidFeedEntry | null, installedVersionCode: number | null | undefined): boolean {
  if (!entry || typeof installedVersionCode !== 'number' || !Number.isFinite(installedVersionCode)) return false;
  return entry.versionCode > installedVersionCode;
}

/** Check on launch, then at most every 6 hours (also when the app comes back). */
export function shouldCheck(lastCheckAt: number | null, now: number): boolean {
  return lastCheckAt === null || now - lastCheckAt >= ANDROID_CHECK_INTERVAL_MS || now < lastCheckAt;
}

export type AndroidUpdateErrorCode =
  | 'install_permission' | 'verify_failed' | 'download_failed' | 'bad_url' | 'feed_failed' | 'install_failed' | 'unknown';

/** Native rejections carry "code: message". */
export function updateErrorCode(err: unknown): { code: AndroidUpdateErrorCode; message: string } {
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : String((err as { message?: unknown })?.message ?? err);
  const m = text.match(/(install_permission|verify_failed|download_failed|bad_url|feed_failed|install_failed):\s*(.*)$/s);
  if (m) return { code: m[1] as AndroidUpdateErrorCode, message: m[2].trim() };
  return { code: 'unknown', message: text };
}
