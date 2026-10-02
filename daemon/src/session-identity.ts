/**
 * Helpers that tie a tmux session to the Claude Code transcript it runs.
 *
 * - `encodeProjectDir`: Claude Code's project directory name under
 *   `<code_home>/projects/`. Every character that is not ASCII alphanumeric
 *   becomes '-' (so '/', '.', '_' and ' ' all do: `/home/u/.cache/x` ->
 *   `-home-u--cache-x`). The ONLY place this encoding lives; use it everywhere.
 * - Session identity: a tmux session NAME can be reused (killed and created
 *   again, possibly in another directory), and claude can be restarted inside
 *   the same session. A conversation mapping remembers the identity it was made
 *   for; when the identity changes the mapping is stale and must be dropped.
 */
import * as fs from 'fs';
import * as path from 'path';

export function encodeProjectDir(workingDir: string): string {
  return workingDir.replace(/[^a-zA-Z0-9]/g, '-');
}

/** tmux format used to read a session's pane in one call. */
export const PANE_INFO_FORMAT = '#{pane_current_path}\t#{session_created}\t#{pane_pid}';

export interface PaneInfo {
  workingDir: string;
  /** tmux `session_created` (epoch seconds as a string), '' when unknown. */
  created: string;
  /** Pane root process id, 0 when unknown. */
  panePid: number;
}

export function parsePaneInfo(stdout: string): PaneInfo {
  const line = stdout.replace(/\r?\n$/, '').split('\n')[0] ?? '';
  const [workingDir = '', created = '', pid = ''] = line.split('\t');
  const panePid = /^\d+$/.test(pid.trim()) ? Number(pid.trim()) : 0;
  return {
    workingDir: workingDir.trim(),
    created: /^\d+$/.test(created.trim()) ? created.trim() : '',
    panePid,
  };
}

export interface SessionIdentity {
  created: string;
  panePid: number;
  encodedPath: string;
  /** The claude process inside the pane (Linux /proc), null when not found. */
  claudePid: number | null;
}

/**
 * True when a mapping made for `prev` must not be reused for `cur`:
 * the tmux session was created again (new creation time or new pane process),
 * or a different claude process now runs in it. A missing value on either side
 * is "unknown", never a change (older mapping files, macOS without /proc, claude
 * not started yet). A cwd change alone is not enough (a pane can report a
 * transient directory while claude runs a command).
 */
export function identityChanged(prev: SessionIdentity | undefined, cur: SessionIdentity): boolean {
  if (!prev) return false;
  if (prev.created && cur.created && prev.created !== cur.created) return true;
  if (prev.panePid && cur.panePid && prev.panePid !== cur.panePid) return true;
  if (prev.claudePid && cur.claudePid && prev.claudePid !== cur.claudePid) return true;
  return false;
}

export function sanitizeIdentity(raw: unknown): SessionIdentity | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  return {
    created: typeof r.created === 'string' ? r.created : '',
    panePid: typeof r.panePid === 'number' && Number.isFinite(r.panePid) ? r.panePid : 0,
    encodedPath: typeof r.encodedPath === 'string' ? r.encodedPath : '',
    claudePid: typeof r.claudePid === 'number' && Number.isFinite(r.claudePid) ? r.claudePid : null,
  };
}

/**
 * The claude process under a pane (breadth-first over /proc children, at most
 * 3 levels and 64 processes). Plain file reads, no subprocess; null when /proc
 * is unavailable (macOS) or no claude process runs.
 */
export async function findClaudePid(panePid: number, procRoot = '/proc'): Promise<number | null> {
  if (!panePid) return null;
  const isClaude = async (pid: number): Promise<boolean> => {
    try {
      const cmd = await fs.promises.readFile(path.join(procRoot, String(pid), 'cmdline'), 'utf-8');
      const argv = cmd.split('\0').filter(Boolean);
      return argv
        .slice(0, 2)
        .some((a) => path.basename(a) === 'claude' || /\/claude(-code)?\/cli\.(m?js)$/.test(a));
    } catch {
      return false;
    }
  };
  const children = async (pid: number): Promise<number[]> => {
    try {
      const raw = await fs.promises.readFile(
        path.join(procRoot, String(pid), 'task', String(pid), 'children'),
        'utf-8'
      );
      return raw
        .split(/\s+/)
        .filter((s) => /^\d+$/.test(s))
        .map(Number);
    } catch {
      return [];
    }
  };
  let level = [panePid];
  let seen = 0;
  for (let depth = 0; depth < 4 && level.length; depth++) {
    const next: number[] = [];
    for (const pid of level) {
      if (++seen > 64) return null;
      if (await isClaude(pid)) return pid;
      if (depth < 3) next.push(...(await children(pid)));
    }
    level = next;
  }
  return null;
}
