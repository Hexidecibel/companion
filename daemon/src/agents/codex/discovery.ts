/**
 * Finding a Codex CLI session's rollout file from its tmux pane.
 *
 * Codex 0.16x does NOT keep the rollout open in the TUI process: a shared
 * `codex app-server` daemon (outside tmux) owns every thread's rollout and
 * writer lock, so /proc/<tui>/fd cannot name the file, and the app-server's
 * fds cover all loaded threads (several per TUI after /new). Rollouts are
 * stored by DATE (`sessions/YYYY/MM/DD/rollout-<local ts>-<uuid>.jsonl`), the
 * cwd lives only in the first line (session_meta).
 *
 * So: find the codex process under the pane (/proc walk, no subprocess), read
 * its cwd + start time (+ a `resume <uuid>` argument), then pick, among
 * rollouts of the date dirs since the process started whose session_meta.cwd
 * equals that cwd, the one written since the process started: born after the
 * start first, then the most recently written. Plain fs reads, all async, the
 * session_meta of a file is cached (it never changes).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findPidInPane, processStartMs } from '../../session-identity';
import { sessionMetaOf, type CodexSessionMeta } from './parse';

/** Codex's home: config `codex_home`, else $CODEX_HOME, else beside code_home, else ~/.codex. */
export function resolveCodexHome(opts: {
  configured?: string | null;
  env?: NodeJS.ProcessEnv;
  codeHome?: string;
}): string {
  const env = opts.env ?? process.env;
  if (opts.configured) return opts.configured;
  if (env.CODEX_HOME) return env.CODEX_HOME;
  // code_home is normally ~/.claude; Codex lives next to it. This also keeps an
  // isolated daemon (own HOME, shared code_home) reading the real Codex home.
  if (opts.codeHome && path.basename(opts.codeHome) === '.claude') {
    return path.join(path.dirname(opts.codeHome), '.codex');
  }
  return path.join(os.homedir(), '.codex');
}

/** `node .../bin/codex` or the vendored `.../bin/codex` binary; never the app-server. */
export function isCodexArgv(argv: string[]): boolean {
  if (!argv.slice(0, 2).some((a) => path.basename(a) === 'codex')) return false;
  return !argv.includes('app-server') && !argv.includes('mcp-server');
}

export async function findCodexPid(panePid: number, procRoot = '/proc'): Promise<number | null> {
  return findPidInPane(panePid, isCodexArgv, procRoot);
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** `codex resume <uuid>` / `codex fork <uuid>`: the thread asked for on the command line. */
export function resumeIdFromArgv(argv: string[]): string | null {
  const i = argv.findIndex((a) => a === 'resume' || a === 'fork');
  if (i < 0) return null;
  for (const a of argv.slice(i + 1)) {
    const m = UUID_RE.exec(a);
    if (m) return m[0].toLowerCase();
  }
  return null;
}

export interface CodexProcessInfo {
  pid: number;
  cwd: string;
  startedAt: number | null;
  resumeId: string | null;
}

export async function codexProcessInfo(
  pid: number,
  procRoot = '/proc'
): Promise<CodexProcessInfo | null> {
  try {
    const [cwd, cmd, startedAt] = await Promise.all([
      fs.promises.readlink(path.join(procRoot, String(pid), 'cwd')),
      fs.promises.readFile(path.join(procRoot, String(pid), 'cmdline'), 'utf-8'),
      processStartMs(pid, procRoot),
    ]);
    return {
      pid,
      cwd,
      startedAt,
      resumeId: resumeIdFromArgv(cmd.split('\0').filter(Boolean)),
    };
  } catch {
    return null;
  }
}

/** Rollout file name -> thread uuid (`rollout-2026-10-28T15-02-41-<uuid>.jsonl`). */
export function rolloutIdOf(file: string): string | null {
  const base = path.basename(file);
  if (!base.startsWith('rollout-') || !base.endsWith('.jsonl')) return null;
  const m = UUID_RE.exec(base.slice(-('.jsonl'.length + 36)));
  return m ? m[0].toLowerCase() : null;
}

export function isCodexRollout(file: string): boolean {
  return rolloutIdOf(file) !== null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Local-date dirs (YYYY/MM/DD) to search for a process started at `since`. */
export function dateDirsSince(since: number, now: number, maxDays = 14): string[] {
  const DAY = 86_400_000;
  const days: number[] = [];
  const from = since - DAY;
  const to = now + DAY;
  if ((to - from) / DAY <= maxDays) {
    for (let t = from; t <= to; t += DAY) days.push(t);
    days.push(to);
  } else {
    days.push(since - DAY, since, since + DAY, now - DAY, now, now + DAY);
  }
  const out: string[] = [];
  for (const t of days) {
    const d = new Date(t);
    const rel = path.join(String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
    if (!out.includes(rel)) out.push(rel);
  }
  return out;
}

const META_HEAD = 512 * 1024;

/** session_meta of a rollout from its first line (null when not there yet). */
export async function readRolloutMeta(file: string): Promise<CodexSessionMeta | null> {
  let fh: fs.promises.FileHandle | undefined;
  try {
    fh = await fs.promises.open(file, 'r');
    const buf = Buffer.alloc(META_HEAD);
    const { bytesRead } = await fh.read(buf, 0, META_HEAD, 0);
    const head = buf.toString('utf8', 0, bytesRead);
    const nl = head.indexOf('\n');
    if (nl > 0) {
      const rec = JSON.parse(head.slice(0, nl)) as { type?: string; payload?: unknown };
      return rec.type === 'session_meta' ? sessionMetaOf(rec.payload) : null;
    }
    // Enormous first line: pull the two fields we need out of the head.
    const cwd = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(head);
    const id = /"id"\s*:\s*"([^"]+)"/.exec(head);
    if (!cwd || !id || !head.includes('"session_meta"')) return null;
    return { id: id[1], cwd: JSON.parse(cwd[1]) as string, startedAt: null };
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

export interface RolloutCandidate {
  file: string;
  id: string;
  mtimeMs: number;
  meta: CodexSessionMeta;
}

/**
 * The rollout a codex process writes:
 *   1. a thread in its cwd born after the process started (newest born):
 *      a fresh `codex`, or a `/new` after a resume;
 *   2. else the thread named by `codex resume <uuid>` (whenever it was written);
 *   3. else the newest thread in its cwd written since the process started
 *      (a resume picked in the TUI's own picker).
 * `claimed` files belong to another pane already (newer processes go first).
 */
export function pickRollout(
  proc: { cwd: string; startedAt: number | null; resumeId: string | null },
  candidates: RolloutCandidate[],
  claimed: ReadonlySet<string> = new Set()
): RolloutCandidate | null {
  const free = candidates.filter((c) => !claimed.has(c.file));
  const start = proc.startedAt;
  const newest = (list: RolloutCandidate[]) =>
    list.length ? list.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a)) : null;
  const written = free.filter(
    (c) => c.meta.cwd === proc.cwd && (start === null || c.mtimeMs >= start - 2000)
  );
  // A TUI's threads are born after it started (/proc start times are only
  // second-accurate: 1.5 s of slack). Among them the newest BORN is current
  // (a /new); by latest write instead, a second TUI started a few seconds
  // later in the same folder took the first one's thread whenever that one
  // had just been written (seen live, 2026-10-28).
  const born = written.filter(
    (c) => start !== null && c.meta.startedAt !== null && c.meta.startedAt >= start - 1500
  );
  if (born.length)
    return born.reduce((a, b) => {
      const ab = a.meta.startedAt ?? 0;
      const bb = b.meta.startedAt ?? 0;
      return bb > ab || (bb === ab && b.mtimeMs > a.mtimeMs) ? b : a;
    });
  if (proc.resumeId) {
    const hit = free.find((c) => c.id === proc.resumeId);
    if (hit) return hit;
  }
  return newest(written);
}

/**
 * Rollout lookup with a session_meta cache. One instance per codex home; the
 * watcher calls `findRollout` for each Codex pane on its 5 s refresh.
 */
export class CodexRolloutIndex {
  private metaCache = new Map<string, CodexSessionMeta>();
  private realCwd = new Map<string, string>();
  private static readonly MAX_META = 2000;
  private static readonly MAX_FILES_PER_DIR = 1000;

  constructor(readonly codexHome: string) {}

  get sessionsDir(): string {
    return path.join(this.codexHome, 'sessions');
  }

  private async meta(file: string): Promise<CodexSessionMeta | null> {
    const hit = this.metaCache.get(file);
    if (hit) return hit;
    const m = await readRolloutMeta(file);
    if (!m) return null;
    let cwd = this.realCwd.get(m.cwd);
    if (cwd === undefined) {
      cwd = await fs.promises.realpath(m.cwd).catch(() => m.cwd);
      if (this.realCwd.size > 500) this.realCwd.clear();
      this.realCwd.set(m.cwd, cwd);
    }
    const meta = { ...m, cwd };
    if (this.metaCache.size >= CodexRolloutIndex.MAX_META) this.metaCache.clear();
    this.metaCache.set(file, meta);
    return meta;
  }

  /** Rollouts in the date dirs covering [since, now] written at or after `writtenSince`. */
  async candidates(since: number, now: number, writtenSince: number): Promise<RolloutCandidate[]> {
    const out: RolloutCandidate[] = [];
    for (const rel of dateDirsSince(since, now)) {
      const dir = path.join(this.sessionsDir, rel);
      let names: string[];
      try {
        names = await fs.promises.readdir(dir);
      } catch {
        continue;
      }
      if (names.length > CodexRolloutIndex.MAX_FILES_PER_DIR) {
        names = names.sort().slice(-CodexRolloutIndex.MAX_FILES_PER_DIR);
      }
      for (const name of names) {
        const id = rolloutIdOf(name);
        if (!id) continue;
        const file = path.join(dir, name);
        let st: fs.Stats;
        try {
          st = await fs.promises.stat(file);
        } catch {
          continue;
        }
        if (st.mtimeMs < writtenSince) continue;
        const meta = await this.meta(file);
        if (meta) out.push({ file, id, mtimeMs: st.mtimeMs, meta });
      }
    }
    return out;
  }

  /** The rollout a codex process is writing, or null (none yet / ambiguous). */
  async findRollout(
    proc: CodexProcessInfo,
    claimed: ReadonlySet<string> = new Set(),
    now = Date.now()
  ): Promise<RolloutCandidate | null> {
    const start = proc.startedAt ?? now - 86_400_000;
    const cands = await this.candidates(start, now, start - 2000);
    if (proc.resumeId && !cands.some((c) => c.id === proc.resumeId)) {
      const resumed = await this.byId(proc.resumeId);
      if (resumed) cands.push(resumed);
    }
    return pickRollout(proc, cands, claimed);
  }

  private idCache = new Map<string, { file: string | null; at: number }>();

  /**
   * A thread's rollout by uuid, wherever its date dir is (a resumed thread may
   * be weeks old). One bounded walk of sessions/YYYY/MM/DD per id; a hit is
   * cached for good, a miss for a minute.
   */
  async byId(id: string, now = Date.now()): Promise<RolloutCandidate | null> {
    const cached = this.idCache.get(id);
    let file: string | null | undefined =
      cached && (cached.file || now - cached.at < 60_000) ? cached.file : undefined;
    if (file === undefined) {
      file = await this.walkForId(id);
      if (this.idCache.size > 200) this.idCache.clear();
      this.idCache.set(id, { file, at: now });
    }
    if (!file) return null;
    try {
      const st = await fs.promises.stat(file);
      const meta = await this.meta(file);
      return meta ? { file, id, mtimeMs: st.mtimeMs, meta } : null;
    } catch {
      this.idCache.delete(id);
      return null;
    }
  }

  private async walkForId(id: string): Promise<string | null> {
    const suffix = `-${id}.jsonl`;
    const ls = async (dir: string) => {
      try {
        return (await fs.promises.readdir(dir)).sort().reverse(); // newest first
      } catch {
        return [] as string[];
      }
    };
    let dirs = 0;
    for (const y of await ls(this.sessionsDir)) {
      if (!/^\d{4}$/.test(y)) continue;
      for (const m of await ls(path.join(this.sessionsDir, y))) {
        for (const d of await ls(path.join(this.sessionsDir, y, m))) {
          if (++dirs > 3000) return null;
          const dir = path.join(this.sessionsDir, y, m, d);
          const hit = (await ls(dir)).find((n) => n.startsWith('rollout-') && n.endsWith(suffix));
          if (hit) return path.join(dir, hit);
        }
      }
    }
    return null;
  }
}
