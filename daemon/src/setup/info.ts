/**
 * Read-only facts for the wizard: remote access (Tailscale), the app
 * downloads on this server's update feed, user-service status, and what a
 * freshly started session is showing (trust dialog, login, ready).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
  AppDownload,
  AppDownloads,
  RemoteAccessInfo,
  ServiceInfo,
  ServiceStatus,
  ServiceTarget,
  SessionHint,
} from './protocol';
import { Runner, tailscaleStatus, TailscaleStatus } from './checks';
import type { ContainerInfo } from '../container';

// ------------------------------------------------------------ remote access

export async function remoteAccessInfo(opts: {
  run: Runner;
  port: number;
  tls: boolean;
  lan: string[];
  container?: ContainerInfo | null;
  /** Default: the tailscale CLI. A container passes the sidecar's socket query. */
  tailscale?: () => Promise<TailscaleStatus>;
}): Promise<RemoteAccessInfo> {
  const t = await (opts.tailscale ? opts.tailscale() : tailscaleStatus(opts.run));
  const scheme = opts.tls ? 'https' : 'http';
  const c = opts.container ?? null;
  // The sidecar serves HTTPS on 443 (tailscale serve) and proxies to the daemon.
  const sidecar = !!c?.tailscaleSocket;
  const url =
    t.up && t.dnsName
      ? sidecar
        ? `https://${t.dnsName}/web/`
        : `${scheme}://${t.dnsName}:${opts.port}/web/`
      : null;
  // On a bridge network the addresses are Docker-internal: useless to a phone.
  const port = c && !c.hostNetwork ? (c.publishedPort ?? opts.port) : opts.port;
  const lan = c && !c.hostNetwork ? [] : opts.lan;
  return {
    tailscale: { ...t, url },
    lanUrls: lan.map((ip) => `${scheme}://${ip}:${port}/web/`),
    port: opts.port,
    tls: opts.tls,
  };
}

// ------------------------------------------------------------ app downloads

/** Updater bundles from latest.json: only used when installers.json has nothing for that platform. */
const DESKTOP_PLATFORMS: Array<{
  key: string;
  platform: AppDownload['platform'];
  label: string;
  kind: AppDownload['kind'];
}> = [
  {
    key: 'darwin-aarch64',
    platform: 'macos',
    label: 'macOS (Apple silicon, app archive)',
    kind: 'updater',
  },
  { key: 'darwin-x86_64', platform: 'macos', label: 'macOS (Intel, app archive)', kind: 'updater' },
  { key: 'linux-x86_64', platform: 'linux', label: 'Linux (AppImage)', kind: 'appimage' },
  { key: 'windows-x86_64', platform: 'windows', label: 'Windows (installer)', kind: 'nsis' },
];

/** installers.json keys (publish-update), in display order. */
const INSTALLERS: Array<{
  key: string;
  /** latest.json platform this installer replaces in the list. */
  replaces: string;
  platform: AppDownload['platform'];
  label: string;
  kind: AppDownload['kind'];
}> = [
  {
    key: 'darwin-aarch64-dmg',
    replaces: 'darwin-aarch64',
    platform: 'macos',
    label: 'macOS (Apple silicon, .dmg)',
    kind: 'dmg',
  },
  {
    key: 'darwin-x86_64-dmg',
    replaces: 'darwin-x86_64',
    platform: 'macos',
    label: 'macOS (Intel, .dmg)',
    kind: 'dmg',
  },
  {
    key: 'windows-x86_64-nsis',
    replaces: 'windows-x86_64',
    platform: 'windows',
    label: 'Windows (installer)',
    kind: 'nsis',
  },
  {
    key: 'linux-x86_64-appimage',
    replaces: 'linux-x86_64',
    platform: 'linux',
    label: 'Linux (AppImage)',
    kind: 'appimage',
  },
  { key: 'linux-x86_64-deb', replaces: '', platform: 'linux', label: 'Linux (.deb)', kind: 'deb' },
];

function readJson(file: string): Record<string, unknown> | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 256 * 1024) return null;
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

function httpUrl(u: unknown): string | null {
  if (typeof u !== 'string' || u.length > 500) return null;
  try {
    const p = new URL(u);
    return p.protocol === 'https:' || p.protocol === 'http:' ? p.toString() : null;
  } catch {
    return null;
  }
}

const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/;

/** "/updates/<channel>/<file>" when the manifest's file is in the local feed. */
function localPathFor(url: string, channelDir: string, channel: string): string | null {
  const base = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
  if (!FILE_RE.test(base) || base.includes('..')) return null;
  return fs.existsSync(path.join(channelDir, base)) ? `/updates/${channel}/${base}` : null;
}

function sizeOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null;
}

/**
 * Links from parsed manifests; `local` maps a URL to its copy on this server
 * (or null). installers.json (first-install files: dmg, NSIS, AppImage, deb)
 * wins; latest.json's updater bundles fill in platforms it does not cover
 * (older feeds).
 */
function downloadsFrom(
  android: Record<string, unknown> | null,
  latest: Record<string, unknown> | null,
  installers: Record<string, unknown> | null,
  local: (url: string) => string | null
): AppDownload[] {
  const out: AppDownload[] = [];
  const aUrl = android ? httpUrl(android.url) : null;
  if (android && aUrl) {
    out.push({
      platform: 'android',
      label: 'Android (APK)',
      version: String(android.versionName || ''),
      url: aUrl,
      localPath: local(aUrl),
      kind: 'apk',
      size: sizeOf(android.size),
    });
  }
  const covered = new Set<string>();
  const inst =
    installers && installers.installers && typeof installers.installers === 'object'
      ? (installers.installers as Record<string, { url?: unknown; size?: unknown }>)
      : {};
  for (const i of INSTALLERS) {
    const u = httpUrl(inst[i.key]?.url);
    if (!u) continue;
    if (i.replaces) covered.add(i.replaces);
    out.push({
      platform: i.platform,
      label: i.label,
      version: String(installers?.version || ''),
      url: u,
      localPath: local(u),
      kind: i.kind,
      size: sizeOf(inst[i.key]?.size),
    });
  }
  const platforms =
    latest && latest.platforms && typeof latest.platforms === 'object'
      ? (latest.platforms as Record<string, { url?: unknown }>)
      : {};
  for (const p of DESKTOP_PLATFORMS) {
    if (covered.has(p.key)) continue;
    const u = httpUrl(platforms[p.key]?.url);
    if (!u) continue;
    out.push({
      platform: p.platform,
      label: p.label,
      version: String(latest?.version || ''),
      url: u,
      localPath: local(u),
      kind: p.kind,
      size: null,
    });
  }
  return out;
}

/** Installer links from the local feed manifests (installers.json, latest.json, android.json). Never writes. */
export function appDownloads(
  feedDir: string,
  channel = 'stable',
  feedUrl: string | null = null
): AppDownloads {
  const dir = path.join(feedDir, channel);
  const downloads = downloadsFrom(
    readJson(path.join(dir, 'android.json')),
    readJson(path.join(dir, 'latest.json')),
    readJson(path.join(dir, 'installers.json')),
    (u) => localPathFor(u, dir, channel)
  );
  return { channel, downloads, source: downloads.length ? 'local' : 'none', feedUrl };
}

/** The owner's public feed: the apps update from it, so a fresh server can point friends at it. */
export const DEFAULT_APP_FEED_URL = 'https://dev.cush.rocks/updates/stable/';

/**
 * COMPANION_APP_FEED_URL (a channel folder URL, ending in /) or the default;
 * empty / "off" turns the remote lookup off. Only http(s) URLs without
 * credentials are accepted.
 */
export function appFeedUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.COMPANION_APP_FEED_URL;
  if (raw === undefined) return DEFAULT_APP_FEED_URL;
  const v = raw.trim();
  if (!v || v === 'off' || v === '0' || v === 'false') return null;
  try {
    const u = new URL(v.endsWith('/') ? v : v + '/');
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password)
      return null;
    return u.toString();
  } catch {
    return null;
  }
}

export type JsonFetcher = (url: string) => Promise<Record<string, unknown> | null>;

/** GET a small JSON manifest: 4 s timeout, 256 KB cap, no redirects to other schemes. */
export const fetchJsonManifest: JsonFetcher = async (url) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > 256 * 1024) return null;
    const j = JSON.parse(text);
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
};

const REMOTE_TTL_MS = 10 * 60 * 1000;
let remoteCache: { key: string; at: number; value: AppDownload[] } | null = null;

/**
 * Local feed first; when it has no builds (a fresh server, every Docker
 * install) the public feed's manifests are read instead (cached 10 min).
 */
export async function appDownloadsWithFallback(
  feedDir: string,
  feedUrl: string | null,
  fetcher: JsonFetcher = fetchJsonManifest,
  now: () => number = Date.now,
  channel = 'stable'
): Promise<AppDownloads> {
  const local = appDownloads(feedDir, channel, feedUrl);
  if (local.downloads.length > 0 || !feedUrl) return local;
  if (remoteCache && remoteCache.key === feedUrl && now() - remoteCache.at < REMOTE_TTL_MS) {
    return {
      channel,
      downloads: remoteCache.value,
      source: remoteCache.value.length ? 'remote' : 'none',
      feedUrl,
    };
  }
  const [android, latest, installers] = await Promise.all([
    fetcher(feedUrl + 'android.json'),
    fetcher(feedUrl + 'latest.json'),
    fetcher(feedUrl + 'installers.json'),
  ]);
  const downloads = downloadsFrom(android, latest, installers, () => null);
  remoteCache = { key: feedUrl, at: now(), value: downloads };
  return { channel, downloads, source: downloads.length ? 'remote' : 'none', feedUrl };
}

/** Tests only. */
export function resetRemoteFeedCacheForTests(): void {
  remoteCache = null;
}

// ------------------------------------------------------------ services

export interface ServicePaths {
  platform: NodeJS.Platform;
  /** In the Docker image there is nothing to install: compose restarts the container. */
  container?: ContainerInfo | null;
  home: string;
  /** Repo bin/ dir when running from a checkout (null when installed from npm). */
  binDir: string | null;
  daemonEntry: string;
  nodePath: string;
  voiceHome: string;
}

export function defaultServicePaths(): ServicePaths {
  const binDir = path.resolve(__dirname, '..', '..', '..', 'bin');
  return {
    platform: process.platform,
    home: os.homedir(),
    binDir: fs.existsSync(path.join(binDir, 'companion')) ? binDir : null,
    daemonEntry: path.resolve(__dirname, '..', 'index.js'),
    nodePath: process.execPath,
    voiceHome:
      process.env.HERALD_VOICE_HOME || path.join(os.homedir(), '.local', 'share', 'herald-voice'),
  };
}

export interface ServicePlan {
  info: ServiceInfo;
  /** What to execFile (no shell) when the user clicks Install. */
  exec: { cmd: string; args: string[] } | null;
}

export function servicePlan(target: ServiceTarget, p: ServicePaths): ServicePlan {
  if (p.container) {
    const daemon = target === 'daemon';
    return {
      info: {
        target,
        supported: false,
        installed: daemon,
        path: 'docker-compose.yml',
        command: daemon
          ? 'restart: unless-stopped (docker-compose.yml)'
          : 'docker compose --profile voice up -d',
        blocker: daemon
          ? 'Docker restarts the container on boot (restart: unless-stopped)'
          : 'The voice service is its own container: start the voice profile',
      },
      exec: null,
    };
  }
  const linux = p.platform === 'linux';
  const mac = p.platform === 'darwin';
  if (target === 'daemon') {
    const file = mac
      ? path.join(p.home, 'Library', 'LaunchAgents', 'com.companion.daemon.plist')
      : path.join(p.home, '.config', 'systemd', 'user', 'companion.service');
    const exec = p.binDir
      ? { cmd: path.join(p.binDir, 'companion'), args: ['autostart', 'enable', '--no-start'] }
      : { cmd: p.nodePath, args: [p.daemonEntry, 'autostart', 'enable', '--no-start'] };
    const command = p.binDir
      ? `${path.join(p.binDir, 'companion')} autostart enable --no-start`
      : `node ${p.daemonEntry} autostart enable --no-start`;
    return {
      info: {
        target,
        supported: linux || mac,
        installed: fs.existsSync(file),
        path: file,
        command,
        ...(linux || mac ? {} : { blocker: 'No user-service support on this OS' }),
      },
      exec: linux || mac ? exec : null,
    };
  }
  const unit = path.join(p.home, '.config', 'systemd', 'user', 'herald-voice.service');
  const venvPy = path.join(p.voiceHome, 'venv', 'bin', 'python');
  const script = p.binDir ? path.join(p.binDir, 'herald-voice') : null;
  let blocker: string | undefined;
  if (!linux) blocker = 'The voice service unit is systemd-only for now (Linux)';
  else if (!script) blocker = 'The voice service ships with the source checkout (bin/herald-voice)';
  else if (!fs.existsSync(venvPy)) {
    blocker = 'Download the voice models first: bin/herald-voice install (about 1 GB)';
  }
  return {
    info: {
      target,
      supported: linux && !!script,
      installed: fs.existsSync(unit),
      path: unit,
      command: `${script || 'bin/herald-voice'} install-unit`,
      ...(blocker ? { blocker } : {}),
    },
    exec: !blocker && script ? { cmd: script, args: ['install-unit'] } : null,
  };
}

export function serviceStatus(p: ServicePaths): ServiceStatus {
  return {
    platform: p.platform === 'linux' ? 'linux' : p.platform === 'darwin' ? 'darwin' : 'other',
    services: [servicePlan('daemon', p).info, servicePlan('voice', p).info],
  };
}

// ------------------------------------------------------------ session hints

/** What a session's screen shows right after the wizard started it. */
export function sessionHint(
  pane: string,
  opts: { exists: boolean; conversation: boolean }
): {
  hint: SessionHint;
  guidance: string;
} {
  if (!opts.exists) {
    return { hint: 'gone', guidance: 'The session has closed. Start it again.' };
  }
  if (opts.conversation) {
    return {
      hint: 'ready',
      guidance: 'Claude Code is running and Companion can see the conversation.',
    };
  }
  const text = pane.slice(-6000);
  if (
    /command not found:?\s*claude|claude: (command )?not found|No such file or directory.*claude/i.test(
      text
    )
  ) {
    return {
      hint: 'claude_missing',
      guidance:
        'Claude Code is not installed on this server yet. Install it, then start the session again.',
    };
  }
  if (
    /Do you trust|trust (the files|this folder)|Yes, I accept|Bypass Permissions mode/i.test(text)
  ) {
    return {
      hint: 'trust_dialog',
      guidance:
        'Claude Code is asking you to trust this folder (sessions started from Companion run in bypass-permissions mode). Accept it once in the terminal: the option is usually "2. Yes, I accept".',
    };
  }
  if (
    /\/login|Select login method|not logged in|Invalid API key|Log ?in (with|to)|Choose the text style/i.test(
      text
    )
  ) {
    return {
      hint: 'login',
      guidance:
        'Claude Code needs you to sign in. Attach to the session, type /login and follow the link in your browser.',
    };
  }
  return {
    hint: 'starting',
    guidance:
      'Waiting for Claude Code. Once it shows its prompt, send it a first message so Companion can pick up the conversation.',
  };
}
