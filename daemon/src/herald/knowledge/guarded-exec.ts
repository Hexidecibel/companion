/**
 * The only way Herald runs a subprocess.
 *
 *   - execFile against an absolute binary path with an argv array; never a shell.
 *   - Hard timeout with SIGKILL (a hung child can never pile up; see 3058a0a).
 *   - Bounded output (maxBuffer), ANSI stripped, redacted before anyone sees it.
 *   - In-flight dedupe by key: concurrent callers for the same key share one child.
 *   - Minimal environment: the daemon's own secrets (ANTHROPIC_API_KEY, tokens)
 *     never reach the child or anything it daemonizes.
 */

import { execFile } from 'child_process';
import { redactSecrets } from './redact';

export const DEFAULT_EXEC_TIMEOUT_MS = 5000;
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

export interface GuardedExecOptions {
  /** Dedupe key: a second call with the same key while one runs shares its result. */
  key: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  cwd?: string;
  /** HOME for the child (the real user's home, not a sandbox HOME). */
  home?: string;
}

export interface GuardedExecResult {
  ok: boolean;
  /** Exit code (null when killed by a signal). */
  code: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007|\u001b[@-Z\\-_]/g;

export function stripAnsi(s: string): string {
  return (s || '').replace(ANSI, '');
}

/** Environment passed to every child: enough to run bash/python tools, nothing secret. */
export function minimalEnv(home?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: home || process.env.HOME || '/',
    LANG: process.env.LANG || 'C.UTF-8',
    TERM: 'dumb',
    NO_COLOR: '1',
  };
  if (process.env.USER) env.USER = process.env.USER;
  if (process.env.LOGNAME) env.LOGNAME = process.env.LOGNAME;
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  return env;
}

const inFlight = new Map<string, Promise<GuardedExecResult>>();

/** Number of distinct children currently running (for tests / diagnostics). */
export function guardedInFlight(): number {
  return inFlight.size;
}

export function guardedExecFile(
  file: string,
  args: string[],
  opts: GuardedExecOptions
): Promise<GuardedExecResult> {
  const existing = inFlight.get(opts.key);
  if (existing) return existing;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const p = new Promise<GuardedExecResult>((resolve) => {
    let child;
    try {
      child = execFile(
        file,
        args,
        {
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
          cwd: opts.cwd,
          env: minimalEnv(opts.home),
          windowsHide: true,
          shell: false,
        },
        (err, stdout, stderr) => {
          const out = redactSecrets(stripAnsi(String(stdout || '')));
          const errText = redactSecrets(stripAnsi(String(stderr || '')));
          if (!err) {
            resolve({ ok: true, code: 0, timedOut: false, stdout: out, stderr: errText });
            return;
          }
          const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
          const overflow = (e.code as unknown) === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
          const timedOut = !overflow && !!e.killed && e.signal === 'SIGKILL';
          const code = typeof e.code === 'number' ? e.code : null;
          resolve({
            ok: false,
            code,
            timedOut,
            stdout: out,
            stderr: errText,
            error: timedOut
              ? `timed out after ${timeoutMs}ms and was killed`
              : e.code === 'ENOENT'
                ? `${file} was not found`
                : overflow
                  ? 'produced too much output and was stopped'
                  : redactSecrets(stripAnsi(e.message || String(err))).slice(0, 300),
          });
        }
      );
    } catch (err) {
      resolve({
        ok: false,
        code: null,
        timedOut: false,
        stdout: '',
        stderr: '',
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    child.stdin?.end();
  }).finally(() => {
    inFlight.delete(opts.key);
  });
  inFlight.set(opts.key, p);
  return p;
}
