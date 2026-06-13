#!/usr/bin/env node
/*
 * Generates a Tauri config overlay that sets an auto-incrementing Android
 * `versionCode`, so sideloaded APKs reliably install over the previously
 * installed build.
 *
 * Why this exists:
 *   Tauri derives the Android versionCode from the semver `version` in
 *   tauri.conf.json as `major*1000000 + minor*1000 + patch`. With version
 *   "1.0.0" that is always 1000000 and never changes between builds, so
 *   Android refuses to treat a new APK as an upgrade.
 *
 * Strategy:
 *   versionCode = BASE_OFFSET + (number of git commits on HEAD)
 *   - Monotonic: commit count only grows.
 *   - Reproducible: the same commit always yields the same versionCode.
 *   - Always > 1000000 so it installs over the currently-sideloaded build.
 *
 *   The value is written into an untracked overlay (android-version.conf.json)
 *   that the Android build consumes via `cargo tauri android build --config`.
 *   Nothing tracked is mutated on each build.
 *
 * Usage:
 *   node scripts/android-version.cjs            # write overlay, print versionCode
 *   node scripts/android-version.cjs --print    # print versionCode only
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Base offset keeps the value above the legacy 1000000 that older sideloaded
// builds shipped with, guaranteeing upgrades install cleanly.
const BASE_OFFSET = 1_000_000;

function commitCount() {
  try {
    const out = execSync('git rev-list --count HEAD', {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    const n = parseInt(out, 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
  } catch {
    // Detached/CI without full history: fall back to a date-based integer so
    // the value is still monotonic-ish and strictly above the legacy floor.
    const d = new Date();
    return (
      d.getUTCFullYear() * 10000 +
      (d.getUTCMonth() + 1) * 100 +
      d.getUTCDate()
    );
  }
}

const versionCode = BASE_OFFSET + commitCount();
// Google Play caps versionCode at 2,100,000,000; assert we stay well under.
if (versionCode > 2_100_000_000) {
  console.error(`android-version: versionCode ${versionCode} exceeds Android limit`);
  process.exit(1);
}

if (process.argv.includes('--print')) {
  process.stdout.write(String(versionCode));
  process.exit(0);
}

const overlay = {
  bundle: {
    android: {
      versionCode,
    },
  },
};

const outPath = path.join(__dirname, '..', 'src-tauri', 'android-version.conf.json');
fs.writeFileSync(outPath, JSON.stringify(overlay, null, 2) + '\n');
console.log(`android-version: versionCode=${versionCode} -> ${path.relative(process.cwd(), outPath)}`);
