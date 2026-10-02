/*
 * Android sideload update feed: pure helpers for `publish-update --apk`.
 *
 * The feed entry lives next to the desktop manifest as
 * <feed>/<channel>/android.json:
 *   { versionCode, versionName, url, sha256, size, certSha256: [hex...],
 *     packageName, notes, pub_date }
 * The app (tauri-plugin-herald-native, ApkUpdater.kt) offers the update when
 * versionCode is above the installed one, downloads the APK, checks sha256,
 * and installs only if the APK's signing certificates equal the installed app's.
 */
'use strict';

const PACKAGE_NAME = 'com.hexidecibel.companion';
const MANIFEST = 'android.json';
const APK_NAME = /^Companion_(\d+\.\d+\.\d+)_android-(\d+)\.apk$/;

/** `aapt2 dump badging` -> { packageName, versionCode, versionName }. */
function parseBadging(text) {
  const line = String(text)
    .split('\n')
    .find((l) => l.startsWith('package:'));
  if (!line) throw new Error('aapt2 badging has no package line');
  const field = (k) => {
    const m = line.match(new RegExp(`\\b${k}='([^']*)'`));
    return m ? m[1] : null;
  };
  const versionCode = Number(field('versionCode'));
  if (!Number.isSafeInteger(versionCode) || versionCode <= 0)
    throw new Error('APK has no valid versionCode');
  return { packageName: field('name'), versionCode, versionName: field('versionName') || '' };
}

/** `apksigner verify --print-certs` -> lowercase SHA-256 hex digests of the signers. */
function parseCertDigests(text) {
  const out = [];
  for (const m of String(text).matchAll(/certificate SHA-256 digest:\s*([0-9a-fA-F:]{64,95})/g)) {
    const hex = m[1].replace(/:/g, '').toLowerCase();
    if (/^[0-9a-f]{64}$/.test(hex) && !out.includes(hex)) out.push(hex);
  }
  return out.sort();
}

function sameCerts(a, b) {
  const x = [...(a || [])].map((s) => s.toLowerCase()).sort();
  const y = [...(b || [])].map((s) => s.toLowerCase()).sort();
  return x.length > 0 && x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * Throws unless `next` may replace `current` on the feed: a strictly higher
 * versionCode (never older or equal), the app's package, and (when the feed
 * already pins certificates) the same signing certificates, so installed apps
 * can actually upgrade.
 */
function checkPublishable(current, next) {
  if (next.packageName !== PACKAGE_NAME)
    throw new Error(`APK package is ${next.packageName}, expected ${PACKAGE_NAME}`);
  if (!next.certSha256 || next.certSha256.length === 0) throw new Error('APK is not signed');
  if (current && Number.isFinite(current.versionCode) && next.versionCode <= current.versionCode) {
    throw new Error(
      `feed already has versionCode ${current.versionCode}; refusing ${next.versionCode} (must be higher)`
    );
  }
  if (current && Array.isArray(current.certSha256) && current.certSha256.length > 0) {
    if (!sameCerts(current.certSha256, next.certSha256))
      throw new Error('APK is signed with a different certificate than the published one');
  }
}

function apkFileName(versionName, versionCode) {
  const v = /^\d+\.\d+\.\d+$/.test(versionName) ? versionName : '0.0.0';
  return `Companion_${v}_android-${versionCode}.apk`;
}

function buildEntry({ info, sha256, size, certSha256, baseUrl, channel, notes, now }) {
  const name = apkFileName(info.versionName, info.versionCode);
  return {
    versionCode: info.versionCode,
    versionName: info.versionName,
    packageName: info.packageName,
    url: `${baseUrl}/${channel}/${encodeURIComponent(name)}`,
    sha256,
    size,
    certSha256,
    notes: notes || `Companion ${info.versionName || info.versionCode}`,
    pub_date: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

/** APK files to delete: all but the newest `keep` versionCodes (never `publishedCode`). */
function apksToPrune(names, keep, publishedCode) {
  const apks = names
    .map((n) => ({ n, m: n.match(APK_NAME) }))
    .filter((x) => x.m)
    .map((x) => ({ name: x.n, code: Number(x.m[2]) }))
    .sort((a, b) => b.code - a.code);
  return apks
    .filter((a, i) => i >= keep && a.code !== publishedCode)
    .map((a) => a.name);
}

module.exports = {
  PACKAGE_NAME,
  MANIFEST,
  APK_NAME,
  parseBadging,
  parseCertDigests,
  sameCerts,
  checkPublishable,
  apkFileName,
  buildEntry,
  apksToPrune,
};
