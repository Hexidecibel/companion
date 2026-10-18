/**
 * iOS "new build on TestFlight" banner, web side. iOS apps cannot update
 * themselves: CI uploads each release run's IPA to TestFlight with
 * CFBundleVersion = the run number, and `bin/companion publish-update --run`
 * writes <feed>/stable/ios.json (daemon/scripts/ios-feed.js) when it did.
 * The native side (tauri-plugin-herald-native, HeraldNativePlugin.swift) reports
 * the installed CFBundleVersion and fetches the feed (no WebView CORS).
 */
export const IOS_TESTFLIGHT_FEED = 'https://dev.cush.rocks/updates/stable/ios.json';
export const IOS_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const TESTFLIGHT_FALLBACK_URL = 'itms-beta://';
/** TestFlight's App Store page (opens TestFlight, or offers to install it). */
export const TESTFLIGHT_APP_STORE_URL = 'https://apps.apple.com/app/testflight/id899247664';

export interface IosFeedEntry {
  build: number;
  versionName: string;
  testflightUrl: string;
  publishedAt: string | null;
}

/** A valid ios.json, or null (anything malformed is ignored, never shown). */
export function parseIosFeed(body: string): IosFeedEntry | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const build = r.build;
  if (typeof build !== 'number' || !Number.isSafeInteger(build) || build <= 0) return null;
  const url = typeof r.testflightUrl === 'string' && /^itms-beta:\/\/[^\s]*$/i.test(r.testflightUrl)
    ? r.testflightUrl
    : TESTFLIGHT_FALLBACK_URL;
  return {
    build,
    versionName: typeof r.versionName === 'string' ? r.versionName : '',
    testflightUrl: url,
    publishedAt: typeof r.publishedAt === 'string' ? r.publishedAt : null,
  };
}

/** Show only a strictly higher build than the installed CFBundleVersion. */
export function isNewerIosBuild(entry: IosFeedEntry | null, installedBuild: number | null | undefined): boolean {
  if (!entry || typeof installedBuild !== 'number' || !Number.isFinite(installedBuild) || installedBuild <= 0) return false;
  return entry.build > installedBuild;
}
