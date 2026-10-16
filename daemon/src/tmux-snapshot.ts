/**
 * One shared, short-lived view of the tmux server, so the watcher refresh and
 * every client's get_server_summary / list_tmux_sessions stop running their own
 * `list-sessions` + per-session `display-message` + `show-environment` calls.
 *
 *   - ONE `tmux list-panes -a -F ...` answers names, created, attached, windows
 *     and each session's active pane (cwd + pid). Cached `PANES_TTL_MS`;
 *     concurrent callers share the in-flight call; SIGKILL timeout.
 *   - The COMPANION_APP tag (session environment, not in any format) is cached
 *     per tmux session id + creation time: a tagged answer for 60 s, an
 *     untagged one for 30 s, and never for a session younger than 15 s (it may
 *     be tagged right after creation). invalidateTmuxTag()/invalidateTmuxSnapshot()
 *     drop it when we tag / create / kill sessions ourselves.
 *
 * `ok: false` = tmux did not answer (timeout, error): callers keep their last
 * state instead of treating it as "no sessions". "no server running" is
 * `ok: true` with no sessions.
 */
import { tryTmux } from './impact/sub';

export const PANES_TTL_MS = 2000;
const LIST_TIMEOUT_MS = 3000;
const ENV_TIMEOUT_MS = 2000;
const TAGGED_TTL_MS = 60_000;
const UNTAGGED_TTL_MS = 30_000;
const YOUNG_SESSION_MS = 15_000;

const FIELDS = [
  'session_name',
  'session_id',
  'session_created',
  'session_attached',
  'session_windows',
  'window_active',
  'pane_active',
  'pane_current_path',
  'pane_pid',
] as const;
export const LIST_PANES_FORMAT = FIELDS.map((f) => `#{${f}}`).join('\t');

export interface TmuxSessionRow {
  name: string;
  /** tmux's own id ("$3"), unique for the server's lifetime. */
  sessionId: string;
  /** session_created, epoch seconds as a string ('' when unknown). */
  created: string;
  /** session_attached as tmux prints it (a client count). */
  attached: string;
  windows: number;
  /** The session's current pane (active window, active pane). */
  workingDir: string;
  panePid: number;
}

export interface TmuxSnapshot {
  ok: boolean;
  at: number;
  sessions: TmuxSessionRow[];
}

/** Parse list-panes output into one row per session (its current pane). */
export function parseListPanes(stdout: string): TmuxSessionRow[] {
  const bySession = new Map<string, { row: TmuxSessionRow; current: boolean }>();
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const p = line.split('\t');
    if (p.length < FIELDS.length) continue;
    const [name, sessionId, created, attached, windows, winActive, paneActive, cwd, pid] = p;
    const current = winActive === '1' && paneActive === '1';
    const prev = bySession.get(name);
    if (prev && (prev.current || !current)) continue;
    bySession.set(name, {
      current,
      row: {
        name,
        sessionId,
        created: /^\d+$/.test(created.trim()) ? created.trim() : '',
        attached,
        windows: parseInt(windows, 10) || 0,
        workingDir: cwd.trim(),
        panePid: /^\d+$/.test(pid.trim()) ? Number(pid.trim()) : 0,
      },
    });
  }
  return [...bySession.values()].map((v) => v.row);
}

type Runner = typeof tryTmux;

export class TmuxSnapshotSource {
  private run: Runner;
  private now: () => number;
  private last: TmuxSnapshot | null = null;
  private inflight: Promise<TmuxSnapshot> | null = null;
  private tags = new Map<string, { name: string; tagged: boolean; at: number }>();
  private tagInflight = new Map<string, Promise<boolean>>();

  constructor(opts: { run?: Runner; now?: () => number } = {}) {
    this.run = opts.run || tryTmux;
    this.now = opts.now || Date.now;
  }

  /** Forget the cached view; a call already running is not reused either. */
  invalidate(): void {
    this.last = null;
    this.inflight = null;
  }

  invalidateTag(name?: string): void {
    if (!name) {
      this.tags.clear();
      return;
    }
    for (const [k, v] of this.tags) if (v.name === name) this.tags.delete(k);
  }

  /** The panes view, at most `maxAgeMs` old (0 = fresh, still shares an in-flight call). */
  get(maxAgeMs = PANES_TTL_MS): Promise<TmuxSnapshot> {
    if (maxAgeMs > 0 && this.last && this.last.ok && this.now() - this.last.at <= maxAgeMs)
      return Promise.resolve(this.last);
    if (this.inflight) return this.inflight;
    const p = (async (): Promise<TmuxSnapshot> => {
      const r = await this.run(['list-panes', '-a', '-F', LIST_PANES_FORMAT], 'snapshot', {
        timeoutMs: LIST_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
      });
      const at = this.now();
      if (!r.error) return { ok: true, at, sessions: parseListPanes(r.stdout) };
      if (!r.timedOut && /no server running|error connecting|no sessions/i.test(r.stderr))
        return { ok: true, at, sessions: [] };
      return { ok: false, at, sessions: this.last?.sessions || [] };
    })().then(
      (snap) => {
        if (this.inflight === p) {
          this.last = snap;
          this.inflight = null;
        }
        return snap;
      },
      (err) => {
        if (this.inflight === p) this.inflight = null;
        throw err;
      }
    );
    this.inflight = p;
    return p;
  }

  /** COMPANION_APP=1 on the session (cached, see header). */
  async isTagged(row: Pick<TmuxSessionRow, 'name' | 'sessionId' | 'created'>): Promise<boolean> {
    const key = `${row.sessionId}|${row.created}|${row.name}`;
    const now = this.now();
    const createdMs = Number(row.created) * 1000;
    const young = !createdMs || now - createdMs < YOUNG_SESSION_MS;
    const hit = this.tags.get(key);
    if (hit && !young && now - hit.at < (hit.tagged ? TAGGED_TTL_MS : UNTAGGED_TTL_MS))
      return hit.tagged;
    const running = this.tagInflight.get(key);
    if (running) return running;
    const p = (async () => {
      const r = await this.run(['show-environment', '-t', row.name, 'COMPANION_APP'], 'snapshot', {
        timeoutMs: ENV_TIMEOUT_MS,
      });
      const tagged = !r.error && r.stdout.includes('COMPANION_APP=1');
      // A timeout says nothing about the tag: keep a previous answer if any.
      if (r.timedOut && hit) return hit.tagged;
      if (!r.timedOut) this.tags.set(key, { name: row.name, tagged, at: this.now() });
      return tagged;
    })().finally(() => this.tagInflight.delete(key));
    this.tagInflight.set(key, p);
    // Forget sessions that no longer exist now and then.
    if (this.tags.size > 512) this.tags.clear();
    return p;
  }
}

export const tmuxSnapshot = new TmuxSnapshotSource();

export function invalidateTmuxSnapshot(name?: string): void {
  tmuxSnapshot.invalidate();
  tmuxSnapshot.invalidateTag(name);
}
