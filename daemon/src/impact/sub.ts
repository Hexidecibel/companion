/**
 * The one way recurring daemon code runs a short subprocess: execFile (never a
 * shell), a hard timeout with SIGKILL, a bounded output buffer, and every call
 * recorded in the impact registry (count, duration, timeouts, concurrency) by
 * `kind` ("tmux:capture-pane@herald", "pstree", ...).
 *
 * In-flight dedupe and liveness are per caller (they know what a duplicate is);
 * `dedupeSub` offers the common "same kind + args already running -> share it".
 */
import { exec, execFile } from 'child_process';
import { impact } from './state';

export const DEFAULT_SUB_TIMEOUT_MS = 5000;

export interface SubOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface SubResult {
  stdout: string;
  stderr: string;
  /** Exit code; -1 when it never ran or was killed. */
  code: number;
  timedOut: boolean;
  /** Spawn failure / non-zero exit / timeout. */
  error: (Error & { code?: number | string; killed?: boolean }) | null;
}

/** Never rejects: the outcome is in the result (like spawnSync's shape). */
export function trySub(
  kind: string,
  file: string,
  args: string[],
  opts: SubOptions = {}
): Promise<SubResult> {
  const timeout = opts.timeoutMs ?? DEFAULT_SUB_TIMEOUT_MS;
  const t0 = performance.now();
  impact.subStart(kind);
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: SubResult) => {
      if (done) return;
      done = true;
      impact.subEnd(kind, performance.now() - t0, {
        timedOut: r.timedOut,
        failed: !!r.error && !r.timedOut,
      });
      resolve(r);
    };
    try {
      execFile(
        file,
        args,
        {
          timeout,
          killSignal: 'SIGKILL',
          maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024,
          cwd: opts.cwd,
          env: opts.env,
          encoding: 'utf8',
          windowsHide: true,
        },
        (err, stdout, stderr) => {
          const e = err as
            | (Error & { code?: number | string; killed?: boolean; signal?: string })
            | null;
          const timedOut = !!e && (e.killed === true || e.signal === 'SIGKILL');
          finish({
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            code: e ? (typeof e.code === 'number' ? e.code : -1) : 0,
            timedOut,
            error: e,
          });
        }
      );
    } catch (err) {
      finish({ stdout: '', stderr: '', code: -1, timedOut: false, error: err as Error });
    }
  });
}

/**
 * Like promisify(execFile): resolves {stdout, stderr} on exit 0, rejects with
 * the error (carrying stdout/stderr) otherwise.
 */
export async function runSub(
  kind: string,
  file: string,
  args: string[],
  opts: SubOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  const r = await trySub(kind, file, args, opts);
  if (r.error) {
    const e = r.error as Error & { stdout?: string; stderr?: string };
    e.stdout = r.stdout;
    e.stderr = r.stderr;
    throw e;
  }
  return { stdout: r.stdout, stderr: r.stderr };
}

/** Kind for a tmux call: "tmux:<subcommand>" plus "@who" when given. */
export function tmuxKind(args: string[], who?: string): string {
  return `tmux:${args[0] || '?'}${who ? `@${who}` : ''}`;
}

/** `tmux <args>` through runSub (rejects on failure). */
export function runTmux(
  args: string[],
  who?: string,
  opts: SubOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  return runSub(tmuxKind(args, who), 'tmux', args, opts);
}

/** `tmux <args>` through trySub (never rejects). */
export function tryTmux(args: string[], who?: string, opts: SubOptions = {}): Promise<SubResult> {
  return trySub(tmuxKind(args, who), 'tmux', args, opts);
}

const shared = new Map<string, Promise<SubResult>>();

/** Identical call already running (same kind + file + args) -> share its result. */
export function dedupeSub(
  kind: string,
  file: string,
  args: string[],
  opts: SubOptions = {}
): Promise<SubResult> {
  const key = `${kind}\0${file}\0${args.join('\0')}`;
  const running = shared.get(key);
  if (running) return running;
  const p = trySub(kind, file, args, opts).finally(() => shared.delete(key));
  shared.set(key, p);
  return p;
}

/**
 * Legacy shell form (`exec`), tracked. Same contract as promisify(exec): rejects
 * on non-zero exit. Prefer runSub/runTmux (no shell, one process instead of two).
 */
export function execShTracked(
  kind: string,
  cmd: string,
  opts: SubOptions & { killSignal?: NodeJS.Signals } = {}
): Promise<{ stdout: string; stderr: string }> {
  const t0 = performance.now();
  impact.subStart(kind);
  return new Promise((resolve, reject) => {
    exec(
      cmd,
      {
        timeout: opts.timeoutMs ?? 0,
        killSignal: opts.killSignal ?? 'SIGTERM',
        maxBuffer: opts.maxBuffer ?? 1024 * 1024,
        cwd: opts.cwd,
        env: opts.env,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        const e = err as
          | (Error & { killed?: boolean; signal?: string; stdout?: string; stderr?: string })
          | null;
        const timedOut = !!e && (e.killed === true || !!e.signal);
        impact.subEnd(kind, performance.now() - t0, { timedOut, failed: !!e && !timedOut });
        if (e) {
          e.stdout = String(stdout ?? '');
          e.stderr = String(stderr ?? '');
          reject(e);
        } else resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      }
    );
  });
}

/** "tmux:capture-pane@watcher" / "git:rev-parse@tmux-manager" / "pstree@watcher" from a shell command. */
export function kindOfCommand(cmd: string, who?: string): string {
  const words = cmd.trim().split(/\s+/);
  const bin = (words[0] || '?').replace(/^.*\//, '');
  const sub =
    bin === 'tmux' || bin === 'git' ? words.find((w, i) => i > 0 && !w.startsWith('-')) : undefined;
  return `${bin}${sub ? `:${sub.replace(/["']/g, '')}` : ''}${who ? `@${who}` : ''}`;
}

/**
 * Drop-in for `promisify(exec)` that records every call under a kind derived
 * from the command. Exec-style options (`timeout`, `killSignal`) are honoured.
 */
export function trackedExecAsync(who: string) {
  return (
    cmd: string,
    o: {
      timeout?: number;
      killSignal?: NodeJS.Signals;
      cwd?: string;
      maxBuffer?: number;
      env?: NodeJS.ProcessEnv;
    } = {}
  ): Promise<{ stdout: string; stderr: string }> =>
    execShTracked(kindOfCommand(cmd, who), cmd, {
      timeoutMs: o.timeout,
      killSignal: o.killSignal,
      cwd: o.cwd,
      maxBuffer: o.maxBuffer,
      env: o.env,
    });
}
