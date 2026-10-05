#!/usr/bin/env node
/*
 * publish-update: put a desktop build on the daemon's update feed
 * (served at /updates/<channel>/... by daemon/src/update-feed.ts).
 *
 *   bin/companion publish-update --run <id|latest> [options]   # from a GitHub Actions run
 *   bin/companion publish-update --from <dir>      [options]   # from local files
 *   bin/companion publish-update --apk <file.apk>  [options]   # a signed Android APK
 *
 * Input files (CI's "updater-*" artifacts), searched recursively:
 *   Companion_<version>_darwin-aarch64.app.tar.gz      + .sig
 *   Companion_<version>_windows-x86_64-setup.exe       + .sig
 *   Companion_<version>_linux-x86_64.AppImage          + .sig
 * All must carry the same version. Each signature is verified against the
 * pubkey in desktop/src-tauri/tauri.conf.json before anything is published, so
 * a wrong key can never strand installed apps.
 * First-install installers (CI's "desktop-macos" / "desktop-linux" artifacts,
 * optional): Companion_<version>_aarch64.dmg (signed + notarized by CI) and
 * Companion_<version>_amd64.deb, same version as the bundles.
 *
 * Writes <dir>/<channel>/latest.json (Tauri updater format: version, notes,
 * pub_date, platforms with url + signature) and installers.json (version,
 * pub_date, installers: {"darwin-aarch64-dmg", "windows-x86_64-nsis",
 * "linux-x86_64-appimage", "linux-x86_64-deb"} -> {kind, file, url, sha256,
 * size}; the NSIS setup.exe and the AppImage are the updater's own files), and
 * copies the files next to them. Files land first, then the manifests are
 * swapped in with atomic renames. Older versions beyond --keep are pruned.
 *
 * Android (--apk): the APK must be signed (apksigner verify), for package
 * com.hexidecibel.companion, with a versionCode strictly higher than the one
 * in <channel>/android.json (older or equal is always refused) and, once the
 * feed pins signing certificates, signed by the same certificate. Writes
 * Companion_<versionName>_android-<versionCode>.apk + android.json
 * (versionCode, versionName, url, sha256, size, certSha256). Uses aapt2 and
 * apksigner from $ANDROID_HOME (or ~/Android/Sdk) build-tools.
 *
 * Options:
 *   --channel <name>   default "stable"
 *   --notes <text>     release notes (default: "Companion <version>")
 *   --dir <path>       feed root (default $COMPANION_UPDATES_DIR or ~/.companion/updates)
 *   --base-url <url>   public feed URL (default https://dev.cush.rocks/updates)
 *   --keep <n>         versions to keep on disk (default 3)
 *   --allow-older      publish even if the feed already has a newer version
 *   --dry-run          verify and print the manifest, write nothing
 */
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TAURI_CONF = path.join(ROOT, 'desktop', 'src-tauri', 'tauri.conf.json');
const ARTIFACTS = ['updater-macos', 'updater-windows', 'updater-linux'];
// First-install installers (dmg, deb); optional. The NSIS exe and the AppImage
// come from the updater artifacts (identical files).
const INSTALLER_ARTIFACTS = ['desktop-macos', 'desktop-linux'];

const BUNDLE =
  /^Companion_(\d+\.\d+\.\d+)_([a-z]+)-([a-z0-9_]+)(\.app\.tar\.gz|-setup\.exe|\.AppImage)$/;
const PLATFORM_KEYS = {
  '.app.tar.gz': (os_, arch) => [`${os_}-${arch}`, `${os_}-${arch}-app`],
  '-setup.exe': (os_, arch) => [`${os_}-${arch}`, `${os_}-${arch}-nsis`],
  '.AppImage': (os_, arch) => [`${os_}-${arch}`, `${os_}-${arch}-appimage`],
};

function die(msg) {
  console.error(`publish-update: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {
    channel: 'stable',
    dir: process.env.COMPANION_UPDATES_DIR || path.join(os.homedir(), '.companion', 'updates'),
    baseUrl: 'https://dev.cush.rocks/updates',
    keep: 3,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) die(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--run':
        opts.run = val();
        break;
      case '--from':
        opts.from = val();
        break;
      case '--apk':
        opts.apk = val();
        break;
      case '--channel':
        opts.channel = val();
        break;
      case '--notes':
        opts.notes = val();
        break;
      case '--dir':
        opts.dir = val();
        break;
      case '--base-url':
        opts.baseUrl = val().replace(/\/+$/, '');
        break;
      case '--keep':
        opts.keep = Math.max(1, parseInt(val(), 10) || 3);
        break;
      case '--allow-older':
        opts.allowOlder = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '-h':
      case '--help':
        console.log(
          fs
            .readFileSync(__filename, 'utf8')
            .split('\n')
            .slice(2, 46)
            .map((l) => l.replace(/^ \* ?/, ''))
            .join('\n')
        );
        process.exit(0);
        break;
      default:
        die(`unknown option ${a} (see --help)`);
    }
  }
  if ([opts.run, opts.from, opts.apk].filter(Boolean).length !== 1)
    die('give exactly one of --run <id|latest>, --from <dir> or --apk <file>');
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(opts.channel))
    die('channel must be lowercase letters, digits, hyphens');
  return opts;
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function downloadRun(run) {
  const gh = (args) =>
    execFileSync('gh', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    }).trim();
  let id = run;
  if (run === 'latest') {
    id = gh([
      'run',
      'list',
      '--workflow',
      'release.yml',
      '--status',
      'success',
      '--limit',
      '1',
      '--json',
      'databaseId',
      '-q',
      '.[0].databaseId',
    ]);
    if (!id) die('no successful release.yml run found');
  }
  if (!/^\d+$/.test(id)) die(`bad run id: ${id}`);
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-update-'));
  const available = gh([
    'api',
    `repos/{owner}/{repo}/actions/runs/${id}/artifacts`,
    '-q',
    '.artifacts[].name',
  ]).split('\n');
  const updaters = ARTIFACTS.filter((n) => available.includes(n));
  if (updaters.length === 0) die(`run ${id} has no updater artifacts (${ARTIFACTS.join(', ')})`);
  const wanted = [...updaters, ...INSTALLER_ARTIFACTS.filter((n) => available.includes(n))];
  console.log(`Downloading ${wanted.join(', ')} from run ${id}`);
  execFileSync('gh', ['run', 'download', id, '-D', dest, ...wanted.flatMap((n) => ['-n', n])], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  return dest;
}

// --- minisign (Tauri updater signatures) ---------------------------------

function b64text(b64) {
  return Buffer.from(b64.trim(), 'base64').toString('utf8');
}

function pubkeyFromConfig() {
  const conf = JSON.parse(fs.readFileSync(TAURI_CONF, 'utf8'));
  const pk = conf.plugins && conf.plugins.updater && conf.plugins.updater.pubkey;
  if (!pk) die(`no plugins.updater.pubkey in ${TAURI_CONF}`);
  const raw = Buffer.from(b64text(pk).split('\n')[1].trim(), 'base64');
  if (raw.length !== 42 || raw.subarray(0, 2).toString() !== 'Ed')
    die('unexpected updater pubkey format');
  const key = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw.subarray(10)]),
    format: 'der',
    type: 'spki',
  });
  return { keyId: raw.subarray(2, 10), key };
}

/** Verifies a Tauri (minisign) signature; returns the trusted comment. */
function verifySignature(file, sigB64, pub) {
  const lines = b64text(sigB64).split('\n');
  const sig = Buffer.from(lines[1].trim(), 'base64');
  const trusted = lines[2].replace(/^trusted comment: /, '');
  const globalSig = Buffer.from(lines[3].trim(), 'base64');
  const alg = sig.subarray(0, 2).toString();
  if (!sig.subarray(2, 10).equals(pub.keyId))
    throw new Error('signed with a different key (key id mismatch)');
  const data = fs.readFileSync(file);
  const msg = alg === 'ED' ? crypto.createHash('blake2b512').update(data).digest() : data;
  if (!crypto.verify(null, msg, pub.key, sig.subarray(10))) throw new Error('bad signature');
  if (
    !crypto.verify(
      null,
      Buffer.concat([sig.subarray(10), Buffer.from(trusted)]),
      pub.key,
      globalSig
    )
  ) {
    throw new Error('bad trusted-comment signature');
  }
  return trusted;
}

// --- versions -------------------------------------------------------------

function cmpVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

// --- Android APK ----------------------------------------------------------

function androidTool(name) {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), 'Android', 'Sdk');
  const bt = path.join(sdk, 'build-tools');
  const versions = fs.existsSync(bt)
    ? fs
        .readdirSync(bt)
        .filter((v) => fs.existsSync(path.join(bt, v, name)))
        .sort((a, b) => cmpVersion(a.replace(/[^\d.]/g, ''), b.replace(/[^\d.]/g, '')))
    : [];
  if (!versions.length) die(`${name} not found under ${bt} (set ANDROID_HOME)`);
  return path.join(bt, versions[versions.length - 1], name);
}

function publishApk(opts) {
  const af = require('./android-feed');
  const apk = path.resolve(opts.apk);
  if (!fs.existsSync(apk)) die(`no such file: ${apk}`);
  const run = (tool, args) => {
    try {
      return execFileSync(androidTool(tool), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      die(`${tool} ${args[0]} failed: ${(e.stderr || e.message || '').toString().trim().split('\n')[0]}`);
    }
  };
  const info = af.parseBadging(run('aapt2', ['dump', 'badging', apk]));
  const certSha256 = af.parseCertDigests(run('apksigner', ['verify', '--print-certs', apk]));
  const data = fs.readFileSync(apk);
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');

  const channelDir = path.join(opts.dir, opts.channel);
  const manifestPath = path.join(channelDir, af.MANIFEST);
  let current = null;
  if (fs.existsSync(manifestPath)) {
    try {
      current = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      die(`cannot read ${manifestPath}: ${e.message}`);
    }
  }
  try {
    af.checkPublishable(current, { ...info, certSha256 });
  } catch (e) {
    die(e.message);
  }
  const entry = af.buildEntry({
    info,
    sha256,
    size: data.length,
    certSha256,
    baseUrl: opts.baseUrl,
    channel: opts.channel,
    notes: opts.notes,
    now: Date.now(),
  });
  console.log(
    `Verified APK ${info.versionName} (versionCode ${info.versionCode}), sha256 ${sha256.slice(0, 12)}…, cert ${certSha256[0].slice(0, 12)}…`
  );
  if (opts.dryRun) {
    console.log(JSON.stringify(entry, null, 2));
    return;
  }
  fs.mkdirSync(channelDir, { recursive: true });
  const name = af.apkFileName(info.versionName, info.versionCode);
  const tmpSuffix = `.tmp-${process.pid}`;
  const dest = path.join(channelDir, name);
  fs.copyFileSync(apk, dest + tmpSuffix);
  fs.chmodSync(dest + tmpSuffix, 0o644);
  fs.renameSync(dest + tmpSuffix, dest);
  fs.writeFileSync(manifestPath + tmpSuffix, JSON.stringify(entry, null, 2) + '\n', { mode: 0o644 });
  fs.renameSync(manifestPath + tmpSuffix, manifestPath);
  for (const n of af.apksToPrune(fs.readdirSync(channelDir), opts.keep, info.versionCode)) {
    fs.rmSync(path.join(channelDir, n), { force: true });
    console.log(`Pruned ${n}`);
  }
  console.log(`Published Android ${info.versionName} (${info.versionCode}) to ${manifestPath}`);
  console.log(`Feed URL: ${opts.baseUrl}/${opts.channel}/${af.MANIFEST}`);
}

function fileDigest(file) {
  const data = fs.readFileSync(file);
  return { sha256: crypto.createHash('sha256').update(data).digest('hex'), size: data.length };
}

function main() {
  const inst = require('./installers-feed');
  const opts = parseArgs(process.argv.slice(2));
  if (opts.apk) return publishApk(opts);
  const src = opts.from ? path.resolve(opts.from) : downloadRun(opts.run);
  if (!fs.existsSync(src)) die(`no such dir: ${src}`);

  const pub = pubkeyFromConfig();
  const bundles = [];
  for (const file of walk(src)) {
    const m = path.basename(file).match(BUNDLE);
    if (!m) continue;
    const [, version, os_, arch, ext] = m;
    const sigFile = `${file}.sig`;
    if (!fs.existsSync(sigFile)) die(`missing signature: ${sigFile}`);
    const signature = fs.readFileSync(sigFile, 'utf8').trim();
    try {
      verifySignature(file, signature, pub);
    } catch (e) {
      die(`${path.basename(file)}: ${e.message}`);
    }
    bundles.push({
      file,
      name: path.basename(file),
      version,
      os: os_,
      arch,
      ext,
      keys: PLATFORM_KEYS[ext](os_, arch),
      signature,
    });
  }
  if (bundles.length === 0) die(`no Companion_<version>_<target> bundles under ${src}`);
  const versions = [...new Set(bundles.map((b) => b.version))];
  if (versions.length > 1) die(`bundles disagree on version: ${versions.join(', ')}`);
  const version = versions[0];

  // Installers: the dmg / deb from the desktop-* artifacts, plus the updater's
  // NSIS setup.exe and AppImage (the same files a first install needs).
  const installerFiles = [];
  for (const file of walk(src)) {
    const c = inst.classifyInstaller(path.basename(file));
    if (!c) continue;
    if (c.version !== version) die(`${path.basename(file)} is ${c.version}, the bundles are ${version}`);
    installerFiles.push({ ...c, file, ...fileDigest(file) });
  }
  const installerEntries = [...installerFiles];
  for (const b of bundles) {
    const kind = inst.bundleInstallerKind(b.ext);
    if (kind) installerEntries.push({ version, os: b.os, arch: b.arch, kind, name: b.name, ...fileDigest(b.file) });
  }
  let installersManifest;
  try {
    installersManifest = inst.buildInstallersManifest({
      version,
      entries: installerEntries,
      baseUrl: opts.baseUrl,
      channel: opts.channel,
      now: Date.now(),
    });
  } catch (e) {
    die(e.message);
  }

  const channelDir = path.join(opts.dir, opts.channel);
  const manifestPath = path.join(channelDir, 'latest.json');
  if (fs.existsSync(manifestPath) && !opts.allowOlder) {
    try {
      const current = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version;
      if (current && cmpVersion(version, current) < 0) {
        die(`feed already has ${current}, newer than ${version} (use --allow-older to roll back)`);
      }
    } catch (e) {
      if (e && e.code !== undefined) throw e;
    }
  }

  const platforms = {};
  for (const b of bundles) {
    for (const key of b.keys) {
      platforms[key] = {
        url: `${opts.baseUrl}/${opts.channel}/${encodeURIComponent(b.name)}`,
        signature: b.signature,
      };
    }
  }
  const manifest = {
    version,
    notes: opts.notes || `Companion ${version}`,
    pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    platforms,
  };

  console.log(
    `Verified ${bundles.length} bundle(s) for ${version}: ${bundles.map((b) => b.keys[0]).join(', ')}`
  );
  console.log(
    `Installers: ${Object.keys(installersManifest.installers).join(', ') || 'none'}`
  );
  if (opts.dryRun) {
    console.log(JSON.stringify(manifest, null, 2));
    console.log(JSON.stringify(installersManifest, null, 2));
    return;
  }

  fs.mkdirSync(channelDir, { recursive: true });
  const tmpSuffix = `.tmp-${process.pid}`;
  for (const b of [...bundles, ...installerFiles]) {
    const dest = path.join(channelDir, b.name);
    fs.copyFileSync(b.file, dest + tmpSuffix);
    fs.chmodSync(dest + tmpSuffix, 0o644);
    fs.renameSync(dest + tmpSuffix, dest);
  }
  fs.writeFileSync(manifestPath + tmpSuffix, JSON.stringify(manifest, null, 2) + '\n', {
    mode: 0o644,
  });
  fs.renameSync(manifestPath + tmpSuffix, manifestPath);
  const installersPath = path.join(channelDir, inst.MANIFEST);
  fs.writeFileSync(installersPath + tmpSuffix, JSON.stringify(installersManifest, null, 2) + '\n', {
    mode: 0o644,
  });
  fs.renameSync(installersPath + tmpSuffix, installersPath);

  // Prune bundles of versions beyond --keep (never the one just published).
  const byVersion = new Map();
  for (const name of fs.readdirSync(channelDir)) {
    const base = name.replace(/\.sig$/, '');
    const m = base.match(BUNDLE) || base.match(inst.INSTALLER_NAME);
    if (!m) continue;
    if (!byVersion.has(m[1])) byVersion.set(m[1], []);
    byVersion.get(m[1]).push(name);
  }
  const keep = new Set([...byVersion.keys()].sort(cmpVersion).reverse().slice(0, opts.keep));
  keep.add(version);
  for (const [v, names] of byVersion) {
    if (keep.has(v)) continue;
    for (const n of names) fs.rmSync(path.join(channelDir, n), { force: true });
    console.log(`Pruned ${v}`);
  }

  console.log(`Published ${version} to ${manifestPath}`);
  console.log(`Feed URL: ${opts.baseUrl}/${opts.channel}/latest.json`);
  console.log(`Installers: ${opts.baseUrl}/${opts.channel}/${inst.MANIFEST}`);
  if (opts.run) fs.rmSync(src, { recursive: true, force: true });
}

main();
