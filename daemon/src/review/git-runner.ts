/**
 * GitRunner: the ONLY way Code Review runs git.
 *
 * Every call is bounded (this repo was fork-bombed once by an unbounded poller,
 * commit 3058a0a):
 *   - execFile, never a shell; fixed `-c` safety flags; diff never runs external
 *     diff drivers or textconv filters.
 *   - per-kind timeout with SIGKILL, maxBuffer (overflow -> `too_large`).
 *   - in-flight dedupe: identical concurrent calls share one subprocess.
 *   - global semaphore (3) with a bounded queue (20, else `busy`).
 *   - per-repo breaker: 3 timeouts within 60 s -> `degraded` for 5 minutes.
 *   - pathspecs never travel in argv: anything after a literal `--` is refused.
 *     Commands that take paths read them from stdin (`git add
 *     --pathspec-from-file=- --pathspec-file-nul`, `git cat-file --batch`), or
 *     the caller diffs whole trees and filters in JS. (git 2.43 `diff` and
 *     `status` do not support --pathspec-from-file.)
 *   - `enabled()` false (config.git === false) -> never execs, `git_disabled`.
 */

import { execFile as nodeExecFile } from 'child_process';
import { createHash } from 'crypto';

export type GitOpKind = 'rev-parse' | 'status' | 'diff' | 'write' | 'apply' | 'read';

export const GIT_TIMEOUTS_MS: Record<GitOpKind, number> = {
  'rev-parse': 4000,
  status: 4000,
  diff: 8000,
  write: 10000,
  apply: 4000,
  read: 4000,
};
export const GIT_MAX_BUFFER = 8 * 1024 * 1024;
const BREAKER_WINDOW_MS = 60_000;
const BREAKER_TRIPS = 3;
const BREAKER_COOLDOWN_MS = 5 * 60_000;

export type GitErrorCode =
  | 'timeout'
  | 'too_large'
  | 'busy'
  | 'git_disabled'
  | 'degraded'
  | 'spawn_failed'
  | 'bad_args';

export class GitError extends Error {
  readonly code: GitErrorCode;
  constructor(code: GitErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'GitError';
  }
}

export interface GitRunRequest {
  cwd: string;
  /** Arguments after the global `-c` flags (e.g. ['diff', '--numstat']). */
  args: string[];
  kind?: GitOpKind;
  /** Written to the child's stdin, then closed. */
  stdin?: string | Buffer;
  /** Extra environment (e.g. GIT_INDEX_FILE for a temp index). */
  env?: Record<string, string>;
  /** Breaker key (repo root). Defaults to cwd. */
  repoKey?: string;
  timeoutMs?: number;
  maxBuffer?: number;
}

export interface GitRunResult {
  /** Process exit code (0 = success). Non-zero exits resolve, they do not throw. */
  code: number;
  stdout: string;
  stderr: string;
  /** Raw stdout bytes (exact file contents for cat-file). */
  stdoutBuf: Buffer;
}

type ExecErr = Error & { code?: number | string; killed?: boolean; signal?: string | null };
export type ExecFileFn = (
  file: string,
  args: string[],
  opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeout: number;
    killSignal: NodeJS.Signals;
    maxBuffer: number;
    encoding: 'buffer';
    windowsHide: boolean;
  },
  cb: (err: ExecErr | null, stdout: Buffer, stderr: Buffer) => void
) => { stdin?: { end: (data?: string | Buffer) => void; on?: (ev: string, fn: () => void) => void } | null };

export interface GitRunnerOptions {
  enabled?: () => boolean;
  execFileFn?: ExecFileFn;
  concurrency?: number;
  maxQueue?: number;
  now?: () => number;
}

const SAFETY_FLAGS = ['-c', 'core.quotepath=off', '-c', 'color.ui=never', '-c', 'core.fsmonitor=false'];
const DIFF_CMDS = new Set(['diff', 'diff-tree', 'diff-index', 'diff-files', 'show', 'log']);
const STRIPPED_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX'];

function hashKey(req: GitRunRequest): string {
  const h = createHash('sha1');
  h.update(req.cwd);
  h.update('\0');
  h.update(req.args.join('\0'));
  h.update('\0');
  h.update(JSON.stringify(req.env || {}));
  h.update('\0');
  if (req.stdin !== undefined) h.update(req.stdin);
  return h.digest('hex');
}

/** Insert --no-ext-diff / --no-textconv after a diff-ish subcommand when missing. */
export function hardenArgs(args: string[]): string[] {
  if (args.length === 0 || !DIFF_CMDS.has(args[0])) return args.slice();
  const out = [args[0]];
  if (!args.includes('--no-ext-diff')) out.push('--no-ext-diff');
  if (!args.includes('--no-textconv')) out.push('--no-textconv');
  return out.concat(args.slice(1));
}

export class GitRunner {
  private enabled: () => boolean;
  private execFileFn: ExecFileFn;
  private concurrency: number;
  private maxQueue: number;
  private now: () => number;
  private active = 0;
  private queue: Array<() => void> = [];
  private inflight = new Map<string, Promise<GitRunResult>>();
  private timeouts = new Map<string, number[]>();
  private degradedUntil = new Map<string, number>();
  /** Total subprocesses started (tests + diagnostics). */
  spawnCount = 0;

  constructor(opts: GitRunnerOptions = {}) {
    this.enabled = opts.enabled || (() => true);
    this.execFileFn = opts.execFileFn || (nodeExecFile as unknown as ExecFileFn);
    this.concurrency = opts.concurrency ?? 3;
    this.maxQueue = opts.maxQueue ?? 20;
    this.now = opts.now || Date.now;
  }

  isEnabled(): boolean {
    return this.enabled();
  }

  /** The repo's breaker is open (recent timeouts): callers report `degraded:'timeout'`. */
  isDegraded(repoKey: string): boolean {
    const until = this.degradedUntil.get(repoKey);
    if (!until) return false;
    if (this.now() >= until) {
      this.degradedUntil.delete(repoKey);
      this.timeouts.delete(repoKey);
      return false;
    }
    return true;
  }

  stats(): { active: number; queued: number; inflight: number } {
    return { active: this.active, queued: this.queue.length, inflight: this.inflight.size };
  }

  run(req: GitRunRequest): Promise<GitRunResult> {
    if (!this.enabled()) {
      return Promise.reject(new GitError('git_disabled', 'git integration is disabled'));
    }
    if (req.args.includes('--')) {
      return Promise.reject(
        new GitError('bad_args', 'pathspecs must not be passed in argv (use stdin)')
      );
    }
    const repoKey = req.repoKey || req.cwd;
    if (this.isDegraded(repoKey)) {
      return Promise.reject(new GitError('degraded', `git is degraded for ${repoKey}`));
    }
    const key = hashKey(req);
    const existing = this.inflight.get(key);
    if (existing) return existing;
    if (this.active >= this.concurrency && this.queue.length >= this.maxQueue) {
      return Promise.reject(new GitError('busy', 'too many git operations queued'));
    }
    const p = new Promise<GitRunResult>((resolve, reject) => {
      const start = () => {
        this.active++;
        this.exec(req, repoKey)
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            const next = this.queue.shift();
            if (next) next();
          });
      };
      if (this.active < this.concurrency) start();
      else this.queue.push(start);
    }).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, p);
    return p;
  }

  private exec(req: GitRunRequest, repoKey: string): Promise<GitRunResult> {
    const kind = req.kind || 'read';
    const timeout = req.timeoutMs ?? GIT_TIMEOUTS_MS[kind];
    const maxBuffer = req.maxBuffer ?? GIT_MAX_BUFFER;
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of STRIPPED_ENV) delete env[k];
    Object.assign(env, {
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
      ...(req.env || {}),
    });
    const args = [...SAFETY_FLAGS, ...hardenArgs(req.args)];
    return new Promise<GitRunResult>((resolve, reject) => {
      let child: ReturnType<ExecFileFn>;
      try {
        this.spawnCount++;
        child = this.execFileFn(
          'git',
          args,
          {
            cwd: req.cwd,
            env,
            timeout,
            killSignal: 'SIGKILL',
            maxBuffer,
            encoding: 'buffer',
            windowsHide: true,
          },
          (err, stdout, stderr) => {
            const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || '');
            const errText = (Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr || '')).toString(
              'utf8'
            );
            if (!err) {
              resolve({ code: 0, stdout: out.toString('utf8'), stderr: errText, stdoutBuf: out });
              return;
            }
            if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
              reject(new GitError('too_large', `git output exceeded ${maxBuffer} bytes`));
              return;
            }
            if (err.killed || err.signal === 'SIGKILL') {
              this.noteTimeout(repoKey);
              reject(new GitError('timeout', `git ${req.args[0]} timed out after ${timeout} ms`));
              return;
            }
            if (typeof err.code === 'number') {
              resolve({
                code: err.code,
                stdout: out.toString('utf8'),
                stderr: errText,
                stdoutBuf: out,
              });
              return;
            }
            reject(new GitError('spawn_failed', `git failed to start: ${err.message}`));
          }
        );
      } catch (e) {
        reject(new GitError('spawn_failed', `git failed to start: ${String(e)}`));
        return;
      }
      const stdin = child?.stdin;
      if (stdin) {
        // A child that exits before reading stdin raises EPIPE: ignore it (the
        // callback reports the real outcome).
        stdin.on?.('error', () => undefined);
        stdin.end(req.stdin !== undefined ? req.stdin : undefined);
      }
    });
  }

  private noteTimeout(repoKey: string): void {
    const now = this.now();
    const list = (this.timeouts.get(repoKey) || []).filter((t) => now - t < BREAKER_WINDOW_MS);
    list.push(now);
    this.timeouts.set(repoKey, list);
    if (list.length >= BREAKER_TRIPS) {
      this.degradedUntil.set(repoKey, now + BREAKER_COOLDOWN_MS);
      console.log(`Review: git breaker open for ${repoKey} (${list.length} timeouts in 60s)`);
    }
  }
}

/** stdin + args for `git add` with NUL-separated pathspecs read from stdin. */
export function pathspecStdin(paths: string[]): { args: string[]; stdin: string } {
  return {
    args: ['--pathspec-from-file=-', '--pathspec-file-nul'],
    stdin: paths.map((p) => `:(literal)${p}`).join('\0'),
  };
}
