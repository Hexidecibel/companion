/**
 * Starting tmux sessions so a NEW tmux server lives in its own systemd scope.
 *
 * When the daemon runs `tmux new-session` and no tmux server is running yet,
 * tmux forks the server from the daemon: it lands in companion.service's
 * cgroup, where a unit stop, an OOM kill of the unit or a KillMode change
 * would take every Claude session down with it. Instead the first session is
 * started through `systemd-run --user --scope --unit=companion-tmux-<...>`,
 * which moves the tmux client (and the server it forks) into a transient
 * scope of its own. A server that is already running is never touched (its
 * new sessions are created by the server itself, wherever it lives).
 *
 * Falls back to plain `tmux` where systemd-run is not usable: not Linux, inside
 * a container (`containerInfo()`), no `systemd-run` binary, no user manager
 * (XDG_RUNTIME_DIR missing), COMPANION_TMUX_SCOPE=0, or when systemd-run itself
 * fails (the session is then created directly).
 *
 * All subprocesses go through execFile (no shell) with SIGKILL timeouts.
 */
import * as fs from 'fs';
import * as path from 'path';
import { trySub } from './impact/sub';
import { containerInfo } from './container';

const TMUX_TIMEOUT_MS = 5000;

export interface TmuxServerEnv {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  inContainer: boolean;
  /** Is this binary on PATH? */
  which: (bin: string) => boolean;
}

function whichOnPath(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

export function defaultTmuxServerEnv(): TmuxServerEnv {
  return {
    platform: process.platform,
    env: process.env,
    inContainer: containerInfo() !== null,
    which: (b) => whichOnPath(b),
  };
}

/** Whether a new tmux server should be started inside its own systemd scope. */
export function scopeUsable(e: TmuxServerEnv): boolean {
  const flag = (e.env.COMPANION_TMUX_SCOPE || '').trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off' || flag === 'no') return false;
  if (e.platform !== 'linux' || e.inContainer) return false;
  if (!e.env.XDG_RUNTIME_DIR) return false;
  return e.which('systemd-run');
}

/** A unique, valid transient unit name for this server's scope. */
export function scopeUnitName(now = Date.now(), env: NodeJS.ProcessEnv = process.env): string {
  const sock = (env.TMUX_TMPDIR ? 'private-' : '') + (process.getuid?.() ?? 'u');
  const safe = sock.replace(/[^A-Za-z0-9_-]/g, '_');
  return `companion-tmux-${safe}-${now.toString(36)}`;
}

/** The command line that starts `tmux <args>` (scoped only when no server runs). */
export function newSessionCommand(
  tmuxArgs: string[],
  serverRunning: boolean,
  e: TmuxServerEnv,
  now = Date.now()
): { cmd: string; args: string[]; scoped: boolean } {
  if (serverRunning || !scopeUsable(e)) return { cmd: 'tmux', args: tmuxArgs, scoped: false };
  return {
    cmd: 'systemd-run',
    args: [
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      `--unit=${scopeUnitName(now, e.env)}`,
      '--description=tmux server started by Companion',
      'tmux',
      ...tmuxArgs,
    ],
    scoped: true,
  };
}

/** True when a tmux server answers (an empty server exits by itself, so this is sessions > 0). */
export async function tmuxServerRunning(): Promise<boolean> {
  const r = await trySub(
    'tmux:list-sessions@server',
    'tmux',
    ['list-sessions', '-F', '#{session_name}'],
    {
      timeoutMs: TMUX_TIMEOUT_MS,
    }
  );
  return !r.error;
}

export interface StartSessionDeps {
  serverRunning?: () => Promise<boolean>;
  run?: (cmd: string, args: string[]) => Promise<{ ok: boolean; stderr: string }>;
  sessionExists?: (name: string) => Promise<boolean>;
  env?: TmuxServerEnv;
  log?: (line: string) => void;
}

async function defaultRun(cmd: string, args: string[]): Promise<{ ok: boolean; stderr: string }> {
  const kind = cmd === 'tmux' ? 'tmux:new-session' : 'systemd-run:tmux';
  const r = await trySub(kind, cmd, args, { timeoutMs: TMUX_TIMEOUT_MS * 2 });
  return { ok: !r.error, stderr: r.stderr || (r.error ? String(r.error.message || r.error) : '') };
}

async function defaultSessionExists(name: string): Promise<boolean> {
  const r = await trySub('tmux:has-session@server', 'tmux', ['has-session', '-t', name], {
    timeoutMs: TMUX_TIMEOUT_MS,
  });
  return !r.error;
}

/**
 * `tmux new-session <args>` for session `name`; throws (like execFile) when the
 * session could not be created.
 */
export async function startTmuxSession(
  name: string,
  newSessionArgs: string[],
  deps: StartSessionDeps = {}
): Promise<{ scoped: boolean }> {
  const env = deps.env || defaultTmuxServerEnv();
  const run = deps.run || defaultRun;
  const log = deps.log || ((l: string) => console.log(l));
  const tmuxArgs = ['new-session', ...newSessionArgs];
  const running = scopeUsable(env) ? await (deps.serverRunning || tmuxServerRunning)() : true; // unused when no scope is possible
  const c = newSessionCommand(tmuxArgs, running, env);
  const first = await run(c.cmd, c.args);
  if (first.ok) {
    if (c.scoped)
      log(`TmuxServer: started a new tmux server in its own systemd scope (${c.args[4].slice(7)})`);
    return { scoped: c.scoped };
  }
  if (c.scoped) {
    // systemd-run itself may have failed (no user bus): unless tmux did create
    // the session, fall back to plain tmux.
    if (await (deps.sessionExists || defaultSessionExists)(name)) return { scoped: true };
    log(
      `TmuxServer: systemd-run failed (${first.stderr.trim().slice(0, 200)}); starting tmux directly`
    );
    const second = await run('tmux', tmuxArgs);
    if (second.ok) return { scoped: false };
    throw new Error(second.stderr.trim() || 'tmux new-session failed');
  }
  throw new Error(first.stderr.trim() || 'tmux new-session failed');
}
