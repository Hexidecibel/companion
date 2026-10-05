/*
 * Desktop installers for people installing Companion for the first time:
 * pure helpers for `publish-update --run/--from`.
 *
 * latest.json stays exactly the Tauri updater format (the apps read it). The
 * first-install downloads go in a separate manifest next to it,
 * <feed>/<channel>/installers.json:
 *   { version, pub_date,
 *     installers: { "<os>-<arch>-<kind>": { kind, file, url, sha256, size } } }
 * kinds: dmg (macOS, signed + notarized + stapled by CI), nsis (Windows
 * setup.exe), appimage and deb (Linux). The NSIS installer and the AppImage are
 * the same files the updater serves (CI copies them byte for byte), so they are
 * linked, not stored twice; the dmg and the deb are new files on the feed.
 *
 * Input names are the Tauri bundler's (CI "desktop-*" artifacts):
 *   Companion_<v>_aarch64.dmg   Companion_<v>_x64.dmg
 *   Companion_<v>_amd64.deb     Companion_<v>_arm64.deb
 * Published names: Companion_<v>_darwin-aarch64.dmg, Companion_<v>_linux-x86_64.deb
 */
'use strict';

const MANIFEST = 'installers.json';

/** Published installer files (pruned by version like the updater bundles). */
const INSTALLER_NAME = /^Companion_(\d+\.\d+\.\d+)_([a-z]+)-([a-z0-9_]+)\.(dmg|deb)$/;

const ARCH = { aarch64: 'aarch64', arm64: 'aarch64', x64: 'x86_64', amd64: 'x86_64', x86_64: 'x86_64' };

/**
 * A Tauri bundler file name -> { version, os, arch, kind, name } (name = the
 * published file name), or null when it is not a dmg / deb installer.
 */
function classifyInstaller(fileName) {
  let m = /^Companion_(\d+\.\d+\.\d+)_(aarch64|x64|x86_64)\.dmg$/.exec(fileName);
  if (m) {
    const arch = ARCH[m[2]];
    return { version: m[1], os: 'darwin', arch, kind: 'dmg', name: `Companion_${m[1]}_darwin-${arch}.dmg` };
  }
  m = /^Companion_(\d+\.\d+\.\d+)_(amd64|arm64)\.deb$/.exec(fileName);
  if (m) {
    const arch = ARCH[m[2]];
    return { version: m[1], os: 'linux', arch, kind: 'deb', name: `Companion_${m[1]}_linux-${arch}.deb` };
  }
  return null;
}

/** Updater bundle (publish-update BUNDLE match) that doubles as an installer. */
function bundleInstallerKind(ext) {
  if (ext === '-setup.exe') return 'nsis';
  if (ext === '.AppImage') return 'appimage';
  return null;
}

/**
 * entries: [{ os, arch, kind, name, sha256, size }] (installer files and the
 * updater bundles that double as installers). Throws on a version mismatch or
 * a duplicate key.
 */
function buildInstallersManifest({ version, entries, baseUrl, channel, now }) {
  const installers = {};
  for (const e of entries) {
    if (e.version && e.version !== version) {
      throw new Error(`installer ${e.name} is ${e.version}, the bundles are ${version}`);
    }
    const key = `${e.os}-${e.arch}-${e.kind}`;
    if (installers[key]) throw new Error(`two ${key} installers (${installers[key].file}, ${e.name})`);
    installers[key] = {
      kind: e.kind,
      file: e.name,
      url: `${baseUrl}/${channel}/${encodeURIComponent(e.name)}`,
      sha256: e.sha256,
      size: e.size,
    };
  }
  return {
    version,
    pub_date: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    installers,
  };
}

module.exports = {
  MANIFEST,
  INSTALLER_NAME,
  classifyInstaller,
  bundleInstallerKind,
  buildInstallersManifest,
};
