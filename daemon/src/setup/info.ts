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
import { Runner, tailscaleStatus } from './checks';

// ------------------------------------------------------------ remote access

export async function remoteAccessInfo(opts: {
  run: Runner;
  port: number;
  tls: boolean;
  lan: string[];
}): Promise<RemoteAccessInfo> {
  const t = await tailscaleStatus(opts.run);
  const scheme = opts.tls ? 'https' : 'http';
  return {
    tailscale: {
      ...t,
      url: t.up && t.dnsName ? `${scheme}://${t.dnsName}:${opts.port}/web/` : null,
    },
    lanUrls: opts.lan.map((ip) => `${scheme}://${ip}:${opts.port}/web/`),
    port: opts.port,
    tls: opts.tls,
  };
}

// ------------------------------------------------------------ app downloads

const DESKTOP_PLATFORMS: Array<{ key: string; platform: AppDownload['platform']; label: string }> = [
  { key: 'darwin-aarch64', platform: 'macos', label: 'macOS (Apple silicon)' },
  { key: 'darwin-x86_64', platform: 'macos', label: 'macOS (Intel)' },
  { key: 'linux-x86_64', platform: 'linux', label: 'Linux (AppImage)' },
  { key: 'windows-x86_64', platform: 'windows', label: 'Windows' },
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

/** Installer links from the feed manifests (latest.json, android.json). Never writes. */
export function appDownloads(feedDir: string, channel = 'stable'): AppDownloads {
  const dir = path.join(feedDir, channel);
  const out: AppDownload[] = [];
  const android = readJson(path.join(dir, 'android.json'));
  const aUrl = android ? httpUrl(android.url) : null;
  if (android && aUrl) {
    out.push({
      platform: 'android',
      label: 'Android (APK)',
      version: String(android.versionName || ''),
      url: aUrl,
      localPath: localPathFor(aUrl, dir, channel),
    });
  }
  const latest = readJson(path.join(dir, 'latest.json'));
  const platforms =
    latest && latest.platforms && typeof latest.platforms === 'object'
      ? (latest.platforms as Record<string, { url?: unknown }>)
      : {};
  for (const p of DESKTOP_PLATFORMS) {
    const u = httpUrl(platforms[p.key]?.url);
    if (!u) continue;
    out.push({
      platform: p.platform,
      label: p.label,
      version: String(latest?.version || ''),
      url: u,
      localPath: localPathFor(u, dir, channel),
    });
  }
  return { channel, downloads: out };
}

// ------------------------------------------------------------ services

export interface ServicePaths {
  platform: NodeJS.Platform;
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
    voiceHome: process.env.HERALD_VOICE_HOME || path.join(os.homedir(), '.local', 'share', 'herald-voice'),
  };
}

export interface ServicePlan {
  info: ServiceInfo;
  /** What to execFile (no shell) when the user clicks Install. */
  exec: { cmd: string; args: string[] } | null;
}

export function servicePlan(target: ServiceTarget, p: ServicePaths): ServicePlan {
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
export function sessionHint(pane: string, opts: { exists: boolean; conversation: boolean }): {
  hint: SessionHint;
  guidance: string;
} {
  if (!opts.exists) {
    return { hint: 'gone', guidance: 'The session has closed. Start it again.' };
  }
  if (opts.conversation) {
    return { hint: 'ready', guidance: 'Claude Code is running and Companion can see the conversation.' };
  }
  const text = pane.slice(-6000);
  if (/command not found:?\s*claude|claude: (command )?not found|No such file or directory.*claude/i.test(text)) {
    return {
      hint: 'claude_missing',
      guidance: 'Claude Code is not installed on this server yet. Install it, then start the session again.',
    };
  }
  if (/Do you trust|trust (the files|this folder)|Yes, I accept|Bypass Permissions mode/i.test(text)) {
    return {
      hint: 'trust_dialog',
      guidance:
        'Claude Code is asking you to trust this folder (sessions started from Companion run in bypass-permissions mode). Accept it once in the terminal: the option is usually "2. Yes, I accept".',
    };
  }
  if (/\/login|Select login method|not logged in|Invalid API key|Log ?in (with|to)|Choose the text style/i.test(text)) {
    return {
      hint: 'login',
      guidance: 'Claude Code needs you to sign in. Attach to the session, type /login and follow the link in your browser.',
    };
  }
  return {
    hint: 'starting',
    guidance: 'Waiting for Claude Code. Once it shows its prompt, send it a first message so Companion can pick up the conversation.',
  };
}
