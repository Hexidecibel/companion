/**
 * Read-only prerequisite checks for the setup wizard. Every external program
 * runs through `execFile` (no shell) with a timeout, SIGKILL on expiry and a
 * small output cap; a whole run is deduplicated while in flight, so repeated
 * "re-check" clicks never pile up subprocesses.
 *
 * Claude Code login is detected WITHOUT reading credentials: on Linux only the
 * existence of ~/.claude/.credentials.json is checked; on macOS the Keychain
 * item's presence is queried (`security find-generic-password` without -w/-g,
 * which prints metadata only, never the secret).
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { CheckStatus, PrereqCheck, PrereqId } from './protocol';

export interface RunResult {
  ok: boolean;
  stdout: string;
  /** The binary does not exist (ENOENT). */
  missing: boolean;
  timedOut: boolean;
  code: number | null;
}

export type Runner = (cmd: string, args: string[], timeoutMs: number) => Promise<RunResult>;

const MAX_OUTPUT = 256 * 1024;

/** The default runner: execFile, no shell, SIGKILL on timeout. */
export const execRunner: Runner = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    try {
      execFile(
        cmd,
        args,
        { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT, windowsHide: true },
        (err, stdout) => {
          const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null;
          resolve({
            ok: !e,
            stdout: String(stdout || ''),
            missing: e?.code === 'ENOENT',
            timedOut: !!e && (e.killed === true || e.signal === 'SIGKILL'),
            code: e ? (typeof e.code === 'number' ? (e.code as unknown as number) : null) : 0,
          });
        }
      );
    } catch {
      resolve({ ok: false, stdout: '', missing: true, timedOut: false, code: null });
    }
  });

export interface CheckEnv {
  run: Runner;
  platform: NodeJS.Platform;
  home: string;
  codeHome: string;
  nodeVersion: string;
  voiceUrl: string | null;
  /** The daemon's own listener ports (always in use by this process). */
  daemonPorts: number[];
  /** Free bytes on the home filesystem (null when unknown). */
  freeBytes: () => Promise<number | null>;
  /** Voice service health (true = answering). */
  voiceHealthy: () => Promise<boolean>;
  /** Whether a TCP port on 127.0.0.1 can be bound. */
  portFree: (port: number) => Promise<boolean>;
  exists: (p: string) => boolean;
  /** Running under systemd (INVOCATION_ID) / launchd (XPC_SERVICE_NAME). */
  supervisor: () => 'systemd' | 'launchd' | null;
}

export const TIMEOUTS = { version: 4000, tailscale: 4000, keychain: 3000 };
const GiB = 1024 ** 3;
export const VOICE_PORT = 9889;

const firstLine = (s: string) => (s || '').split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';

function versionOf(s: string): string {
  const m = /(\d+\.\d+(?:\.\d+)?[a-z]?)/.exec(s);
  return m ? m[1] : firstLine(s).slice(0, 40);
}

function install(env: CheckEnv, linux: string, mac: string): string {
  return env.platform === 'darwin' ? mac : linux;
}

function check(
  id: PrereqId,
  label: string,
  status: CheckStatus,
  detail: string,
  optional: boolean,
  fix?: string,
  command?: string
): PrereqCheck {
  return {
    id,
    label,
    status,
    detail,
    optional,
    ...(status !== 'ok' && fix ? { fix } : {}),
    ...(status !== 'ok' && command ? { command } : {}),
  };
}

async function checkNode(env: CheckEnv): Promise<PrereqCheck> {
  const major = Number(/^v?(\d+)/.exec(env.nodeVersion)?.[1] || 0);
  const v = env.nodeVersion.replace(/^v/, '');
  if (major >= 20) return check('node', 'Node.js', 'ok', `Node ${v}`, false);
  return check(
    'node',
    'Node.js',
    major >= 18 ? 'warn' : 'fail',
    `Node ${v} (20 or newer recommended)`,
    false,
    'Install Node 20 with nvm, then restart the daemon.',
    'nvm install 20 && nvm alias default 20'
  );
}

async function checkBinary(
  env: CheckEnv,
  id: PrereqId,
  label: string,
  cmd: string,
  args: string[],
  missingStatus: CheckStatus,
  fix: string,
  command: string,
  optional = false
): Promise<{ check: PrereqCheck; found: boolean }> {
  const r = await env.run(cmd, args, TIMEOUTS.version);
  if (r.ok) {
    return { check: check(id, label, 'ok', `${label} ${versionOf(r.stdout)}`, optional), found: true };
  }
  if (r.timedOut) {
    return {
      check: check(id, label, 'warn', `${cmd} did not answer in time`, optional, fix, command),
      found: false,
    };
  }
  return {
    check: check(
      id,
      label,
      missingStatus,
      r.missing ? 'Not installed' : `${cmd} failed to run`,
      optional,
      fix,
      command
    ),
    found: false,
  };
}

async function checkClaudeLogin(env: CheckEnv, installed: boolean): Promise<PrereqCheck> {
  const label = 'Claude Code login';
  const fix = 'Start a session, run claude, then type /login and follow the browser prompt.';
  if (!installed) {
    return check('claude_login', label, 'warn', 'Install Claude Code first', false, fix, 'claude');
  }
  // Presence only: the credential file is never opened.
  const credFile = path.join(env.codeHome, '.credentials.json');
  if (env.exists(credFile)) return check('claude_login', label, 'ok', 'Signed in', false);
  if (env.platform === 'darwin') {
    const r = await env.run(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials'],
      TIMEOUTS.keychain
    );
    if (r.ok) return check('claude_login', label, 'ok', 'Signed in (Keychain)', false);
  }
  return check('claude_login', label, 'warn', 'Not signed in yet', false, fix, 'claude');
}

interface TailscaleStatus {
  installed: boolean;
  up: boolean;
  dnsName: string | null;
}

/** `tailscale status --json`: only Self.DNSName and BackendState are read. */
export async function tailscaleStatus(run: Runner): Promise<TailscaleStatus> {
  const r = await run('tailscale', ['status', '--json'], TIMEOUTS.tailscale);
  if (r.missing) return { installed: false, up: false, dnsName: null };
  try {
    const j = JSON.parse(r.stdout) as { BackendState?: string; Self?: { DNSName?: string } };
    const dns = (j.Self?.DNSName || '').replace(/\.$/, '') || null;
    return { installed: true, up: j.BackendState === 'Running', dnsName: dns };
  } catch {
    return { installed: true, up: false, dnsName: null };
  }
}

async function checkTailscale(env: CheckEnv): Promise<PrereqCheck> {
  const t = await tailscaleStatus(env.run);
  const label = 'Tailscale (optional)';
  if (!t.installed) {
    return check(
      'tailscale',
      label,
      'warn',
      'Not installed: reach this server from outside your network with it',
      true,
      'Optional. Install Tailscale to use Companion away from home.',
      install(env, 'curl -fsSL https://tailscale.com/install.sh | sh', 'brew install --cask tailscale')
    );
  }
  if (!t.up) {
    return check('tailscale', label, 'warn', 'Installed, not connected', true, 'Connect it.', 'sudo tailscale up');
  }
  return check('tailscale', label, 'ok', t.dnsName ? `Connected as ${t.dnsName}` : 'Connected', true);
}

async function checkVoice(env: CheckEnv): Promise<PrereqCheck> {
  const label = 'Herald voice service (optional)';
  if (!env.voiceUrl) return check('herald_voice', label, 'warn', 'Turned off in the config', true);
  const ok = await env.voiceHealthy().catch(() => false);
  if (ok) return check('herald_voice', label, 'ok', `Answering at ${env.voiceUrl}`, true);
  return check(
    'herald_voice',
    label,
    'warn',
    'Not running (only needed for spoken Herald)',
    true,
    'Install and start the local voice service.',
    'bin/herald-voice install && bin/herald-voice install-unit'
  );
}

async function checkDisk(env: CheckEnv): Promise<PrereqCheck> {
  const free = await env.freeBytes().catch(() => null);
  const label = 'Disk space';
  if (free === null) return check('disk', label, 'warn', 'Could not measure free space', true);
  const gb = (free / GiB).toFixed(1);
  if (free >= 2 * GiB) return check('disk', label, 'ok', `${gb} GB free`, true);
  return check(
    'disk',
    label,
    free >= 0.5 * GiB ? 'warn' : 'fail',
    `${gb} GB free (voice models need about 1 GB)`,
    true,
    'Free some space in your home directory before installing the voice service.'
  );
}

async function checkService(env: CheckEnv): Promise<PrereqCheck> {
  const label = 'Starts on boot';
  const sup = env.supervisor();
  if (sup) return check('service', label, 'ok', `Running under ${sup}`, true);
  const unit =
    env.platform === 'darwin'
      ? path.join(env.home, 'Library', 'LaunchAgents', 'com.companion.daemon.plist')
      : path.join(env.home, '.config', 'systemd', 'user', 'companion.service');
  if (env.platform !== 'linux' && env.platform !== 'darwin') {
    return check('service', label, 'warn', 'No service manager support on this OS', true);
  }
  if (env.exists(unit)) return check('service', label, 'ok', `Installed (${path.basename(unit)})`, true);
  return check(
    'service',
    label,
    'warn',
    'Not installed: the daemon stops when you log out or reboot',
    true,
    'Install the user service (later step, or run this).',
    'bin/companion autostart enable --no-start'
  );
}

async function checkPorts(env: CheckEnv): Promise<PrereqCheck> {
  const label = 'Ports';
  const own = env.daemonPorts.join(', ');
  const voiceUp = env.voiceUrl ? await env.voiceHealthy().catch(() => false) : false;
  if (voiceUp) return check('port', label, 'ok', `Daemon on ${own}; voice port in use by the voice service`, true);
  const free = await env.portFree(VOICE_PORT).catch(() => true);
  if (free) return check('port', label, 'ok', `Daemon on ${own}; ${VOICE_PORT} free for voice`, true);
  return check(
    'port',
    label,
    'warn',
    `Port ${VOICE_PORT} (voice) is used by another program`,
    true,
    'Stop that program, or set HERALD_VOICE_PORT and herald.voice_url to another port.',
    env.platform === 'darwin' ? `lsof -iTCP:${VOICE_PORT} -sTCP:LISTEN` : `ss -ltnp 'sport = :${VOICE_PORT}'`
  );
}

/** Run every check (or the listed ones). Independent checks run in parallel. */
export async function runChecks(env: CheckEnv, only?: PrereqId[]): Promise<PrereqCheck[]> {
  const want = (id: PrereqId) => !only || only.length === 0 || only.includes(id);
  const tasks: Promise<PrereqCheck | PrereqCheck[] | null>[] = [];
  tasks.push(want('node') ? checkNode(env) : Promise.resolve(null));
  tasks.push(
    want('tmux')
      ? checkBinary(
          env,
          'tmux',
          'tmux',
          'tmux',
          ['-V'],
          'fail',
          'Companion runs Claude Code inside tmux. Install it.',
          install(env, 'sudo apt install -y tmux', 'brew install tmux')
        ).then((r) => r.check)
      : Promise.resolve(null)
  );
  tasks.push(
    want('git')
      ? checkBinary(
          env,
          'git',
          'git',
          'git',
          ['--version'],
          'warn',
          'Used for code review and worktrees. Install it.',
          install(env, 'sudo apt install -y git', 'xcode-select --install')
        ).then((r) => r.check)
      : Promise.resolve(null)
  );
  if (want('claude_installed') || want('claude_login')) {
    tasks.push(
      checkBinary(
        env,
        'claude_installed',
        'Claude Code',
        'claude',
        ['--version'],
        'fail',
        'Install Claude Code (needs Node 18+).',
        'npm install -g @anthropic-ai/claude-code'
      ).then(async (r) => {
        const out: PrereqCheck[] = [];
        if (want('claude_installed')) out.push(r.check);
        if (want('claude_login')) out.push(await checkClaudeLogin(env, r.found));
        return out;
      })
    );
  }
  tasks.push(want('tailscale') ? checkTailscale(env) : Promise.resolve(null));
  tasks.push(want('herald_voice') ? checkVoice(env) : Promise.resolve(null));
  tasks.push(want('disk') ? checkDisk(env) : Promise.resolve(null));
  tasks.push(want('service') ? checkService(env) : Promise.resolve(null));
  tasks.push(want('port') ? checkPorts(env) : Promise.resolve(null));
  const results = await Promise.all(tasks);
  const flat: PrereqCheck[] = [];
  for (const r of results) {
    if (!r) continue;
    if (Array.isArray(r)) flat.push(...r);
    else flat.push(r);
  }
  return flat;
}

/** One run at a time: concurrent callers share the in-flight promise. */
export class CheckRunner {
  private inFlight: Promise<PrereqCheck[]> | null = null;
  private inFlightKey = '';

  constructor(private readonly env: () => CheckEnv) {}

  run(only?: PrereqId[]): Promise<PrereqCheck[]> {
    const key = (only || []).slice().sort().join(',');
    if (this.inFlight && this.inFlightKey === key) return this.inFlight;
    const p = runChecks(this.env(), only).finally(() => {
      if (this.inFlight === p) this.inFlight = null;
    });
    this.inFlight = p;
    this.inFlightKey = key;
    return p;
  }
}

// ------------------------------------------------------------ real environment

export function freeBytesAt(dir: string): Promise<number | null> {
  const statfs = (fs.promises as unknown as { statfs?: (p: string) => Promise<{ bavail: number; bsize: number }> })
    .statfs;
  if (!statfs) return Promise.resolve(null);
  return statfs(dir)
    .then((s) => Number(s.bavail) * Number(s.bsize))
    .catch(() => null);
}

export function portFreeOnLoopback(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host: '127.0.0.1', exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

export async function httpHealthy(url: string, timeoutMs = 1500): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/health`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export function defaultSupervisor(env: NodeJS.ProcessEnv = process.env): 'systemd' | 'launchd' | null {
  if (env.INVOCATION_ID) return 'systemd';
  if (env.XPC_SERVICE_NAME && env.XPC_SERVICE_NAME.includes('companion')) return 'launchd';
  return null;
}

export function realCheckEnv(opts: {
  codeHome: string;
  voiceUrl: string | null;
  daemonPorts: number[];
  run?: Runner;
}): CheckEnv {
  const home = os.homedir();
  return {
    run: opts.run || execRunner,
    platform: process.platform,
    home,
    codeHome: opts.codeHome,
    nodeVersion: process.version,
    voiceUrl: opts.voiceUrl,
    daemonPorts: opts.daemonPorts,
    freeBytes: () => freeBytesAt(home),
    voiceHealthy: () => (opts.voiceUrl ? httpHealthy(opts.voiceUrl) : Promise.resolve(false)),
    portFree: portFreeOnLoopback,
    exists: (p) => fs.existsSync(p),
    supervisor: () => defaultSupervisor(),
  };
}
