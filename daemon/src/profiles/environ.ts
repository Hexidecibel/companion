/**
 * The profile a running agent belongs to: CLAUDE_CONFIG_DIR / CODEX_HOME in
 * its /proc/<pid>/environ (the environment it was exec'd with). One async fs
 * read per pid, cached by pid + process start (a reused pid re-reads); no
 * subprocess. Only the asked-for variables are kept.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Selected variables of a NUL-separated environ blob (pure). */
export function pickEnviron(raw: string, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of raw.split('\0')) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const k = entry.slice(0, eq);
    if (keys.includes(k)) out[k] = entry.slice(eq + 1);
  }
  return out;
}

export class ProcEnvCache {
  private cache = new Map<number, { start: number | null; vars: Record<string, string> }>();
  private static readonly MAX = 512;

  constructor(
    private readonly keys: readonly string[],
    private readonly procRoot = '/proc'
  ) {}

  /** The selected variables of a process ({} when unreadable). */
  async read(pid: number, startedAt: number | null = null): Promise<Record<string, string>> {
    const hit = this.cache.get(pid);
    if (hit && hit.start === startedAt) return hit.vars;
    let vars: Record<string, string> = {};
    try {
      vars = pickEnviron(
        await fs.promises.readFile(path.join(this.procRoot, String(pid), 'environ'), 'utf-8'),
        this.keys
      );
    } catch {
      return {}; // gone / not ours: do not cache
    }
    if (this.cache.size >= ProcEnvCache.MAX) this.cache.clear();
    this.cache.set(pid, { start: startedAt, vars });
    return vars;
  }

  /** Drop pids not in `live` (called once per refresh). */
  retain(live: Iterable<number>): void {
    const keep = new Set(live);
    for (const pid of [...this.cache.keys()]) if (!keep.has(pid)) this.cache.delete(pid);
  }
}
