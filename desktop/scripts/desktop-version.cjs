#!/usr/bin/env node
/*
 * Writes src-tauri/desktop-version.conf.json, the config overlay every desktop
 * build uses (`npm run build`), so each build has a newer version than the
 * last and the auto-updater can tell them apart.
 *
 *   version = <major>.<minor>.<git commit count>
 *
 * major.minor come from tauri.conf.json ("1.0.0" -> 1.0). The commit count is
 * monotonic on main, reproducible (same commit, same version), identical for
 * local and CI builds (CI must check out full history: fetch-depth 0), and far
 * below the 65535 MSI patch limit. No tags involved.
 *
 * APPLE_SIGNING_IDENTITY (CI, Developer ID) replaces the ad-hoc identity.
 *
 * When TAURI_SIGNING_PRIVATE_KEY is set (CI), the overlay also turns on
 * bundle.createUpdaterArtifacts, producing the signed .app.tar.gz / setup.exe
 * / .AppImage + .sig the update feed serves. Without the key, local builds
 * skip them (the bundler would fail without a key).
 *
 * Usage:
 *   node scripts/desktop-version.cjs           # write overlay, print version
 *   node scripts/desktop-version.cjs --print   # print version only
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const srcTauri = path.join(__dirname, '..', 'src-tauri');

function commitCount() {
  const out = execSync('git rev-list --count HEAD', {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .toString()
    .trim();
  const n = Number.parseInt(out, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`bad commit count: ${out}`);
  return n;
}

function desktopVersion() {
  const base = JSON.parse(fs.readFileSync(path.join(srcTauri, 'tauri.conf.json'), 'utf8')).version;
  const [major, minor] = String(base).split('.');
  const override = process.env.COMPANION_DESKTOP_VERSION;
  if (override) return override;
  let patch;
  try {
    patch = commitCount();
  } catch {
    patch = 0; // not a git checkout: keep the base version
  }
  if (process.env.CI && patch < 100) {
    throw new Error(
      `git commit count is ${patch}: the CI checkout is shallow. Use actions/checkout with fetch-depth: 0.`
    );
  }
  return `${major}.${minor}.${patch}`;
}

const version = desktopVersion();
if (process.argv.includes('--print')) {
  console.log(version);
  process.exit(0);
}
const overlay = { version };
if (process.env.TAURI_SIGNING_PRIVATE_KEY) {
  overlay.bundle = { createUpdaterArtifacts: true };
}
// CI with the Developer ID certificate imported: sign with it instead of the
// ad-hoc "-" identity in tauri.conf.json (hardened runtime is on in the config).
if (process.env.APPLE_SIGNING_IDENTITY) {
  overlay.bundle = { ...(overlay.bundle || {}), macOS: { signingIdentity: process.env.APPLE_SIGNING_IDENTITY } };
}
fs.writeFileSync(
  path.join(srcTauri, 'desktop-version.conf.json'),
  JSON.stringify(overlay, null, 2) + '\n'
);
const extras = [];
if (overlay.bundle && overlay.bundle.createUpdaterArtifacts) extras.push('updater artifacts');
if (overlay.bundle && overlay.bundle.macOS) extras.push('Developer ID signing');
console.log(`desktop version ${version}${extras.length ? ` (+ ${extras.join(', ')})` : ''}`);
