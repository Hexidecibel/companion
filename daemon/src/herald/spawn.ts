/**
 * Starting a new Claude Code session from Herald: where it may run.
 *
 * A session can start only in an existing directory whose REAL path (symlinks
 * resolved) is inside one of the allowed roots: `~/local/src` by default
 * (the projects root), or `HERALD_SPAWN_ROOTS` (colon-separated absolute paths).
 * The user may name a project ("companion") or a path ("~/local/src/companion/web").
 * Names with shell or control characters are refused outright, even though
 * nothing here goes through a shell.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SessionSnapshot } from './session-source';

/** Characters a directory may contain (no quotes, $, backticks, ;, newlines...). */
const SAFE_PATH = /^[A-Za-z0-9 ._+@,/~-]+$/;
const MAX_PROMPT = 2000;

export function spawnRoots(projectsRoot: string, env = process.env): string[] {
  const raw = env.HERALD_SPAWN_ROOTS;
  const list = raw
    ? raw
        .split(':')
        .map((r) => r.trim())
        .filter((r) => r && path.isAbsolute(r))
    : [projectsRoot];
  const out: string[] = [];
  for (const r of list) {
    try {
      out.push(fs.realpathSync(r));
    } catch {
      /* a missing root allows nothing */
    }
  }
  return out;
}

function inside(real: string, root: string): boolean {
  return real === root || real.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export type SpawnDirResult = { ok: true; dir: string; name: string } | { ok: false; error: string };

/**
 * Resolve "companion" / "~/local/src/companion/web" / an absolute path to a real
 * directory inside the allowed roots. Project names match a folder directly
 * under a root (case and punctuation ignored); several matches are refused.
 */
export function resolveSpawnDir(ref: string, roots: string[], userHome: string): SpawnDirResult {
  const raw = (ref || '').trim();
  if (!raw) return { ok: false, error: 'Say which project or folder to start the session in.' };
  if (roots.length === 0)
    return {
      ok: false,
      error: 'Starting sessions is not set up on this server (no allowed folders).',
    };
  if (!SAFE_PATH.test(raw) || raw.includes('..'))
    return {
      ok: false,
      error: `"${raw}" is not a folder name I can use. Name the project instead.`,
    };

  let candidates: string[];
  if (raw.startsWith('~') || raw.startsWith('/')) {
    const expanded = raw.startsWith('~') ? path.join(userHome, raw.slice(1)) : raw;
    candidates = [path.resolve(expanded)];
  } else if (raw.includes('/')) {
    candidates = roots.map((r) => path.join(r, raw));
  } else {
    const want = squash(raw);
    candidates = [];
    for (const root of roots) {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith('.') && squash(e.name) === want)
          candidates.push(path.join(root, e.name));
      }
    }
    if (candidates.length === 0)
      return {
        ok: false,
        error: `I couldn't find a project called "${raw}". Which folder should it start in?`,
      };
    if (candidates.length > 1)
      return {
        ok: false,
        error: `"${raw}" matches more than one folder (${candidates.map((c) => path.basename(c)).join(', ')}). Which one?`,
      };
  }

  for (const c of candidates) {
    let real: string;
    try {
      real = fs.realpathSync(c);
    } catch {
      continue;
    }
    let st: fs.Stats;
    try {
      st = fs.statSync(real);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (!roots.some((r) => inside(real, r)))
      return {
        ok: false,
        error: `${raw} is outside the folders I may start sessions in (${roots.join(', ')}).`,
      };
    if (roots.includes(real))
      return { ok: false, error: 'Pick a project folder, not the projects folder itself.' };
    if (!SAFE_PATH.test(real))
      return { ok: false, error: `The folder path has characters I won't pass on: ${real}` };
    return { ok: true, dir: real, name: path.basename(real) };
  }
  return { ok: false, error: `There is no folder at ${raw}.` };
}

export type SpawnPromptResult = { ok: true; prompt: string } | { ok: false; error: string };

/** The first prompt: plain text, control characters stripped, bounded. */
export function cleanFirstPrompt(raw: unknown): SpawnPromptResult {
  if (typeof raw !== 'string') return { ok: false, error: 'first_prompt must be text.' };
  // eslint-disable-next-line no-control-regex
  const prompt = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (!prompt) return { ok: false, error: 'Say what the new session should do first.' };
  if (prompt.length > MAX_PROMPT)
    return { ok: false, error: `The first prompt is too long (max ${MAX_PROMPT} characters).` };
  return { ok: true, prompt };
}

/** Live sessions already working in `dir` (a second one is allowed, but the user is told). */
export function sessionsIn(dir: string, snaps: SessionSnapshot[]): SessionSnapshot[] {
  return snaps.filter((s) => !s.inactive && s.projectPath && path.resolve(s.projectPath) === dir);
}

// ---------------------------------------------------------------------------
// Start-up screen: ready, or parked at Claude's bypass-permissions warning.

export type PaneState = 'ready' | 'bypass_warning' | 'trust_prompt' | 'starting';

/**
 * What a freshly started session's screen shows. Claude Code in
 * bypass-permissions mode parks at a one-time "Yes, I accept" warning per
 * folder; a new folder may ask whether to trust it. Herald never answers either
 * on the user's behalf.
 */
export function classifyStartupPane(pane: string): PaneState {
  const p = pane || '';
  if (/Bypass Permissions mode/i.test(p) && /Yes,? I accept/i.test(p)) return 'bypass_warning';
  if (/Do you trust the files in this folder|trust this folder/i.test(p)) return 'trust_prompt';
  // Claude's own input box / footer. A bare "❯" is not enough: a shell prompt
  // (after "No, exit") can use it too, and the first prompt must never be typed
  // into a shell.
  if (/for shortcuts|bypass permissions on|shift\+tab to cycle|Try "/i.test(p)) return 'ready';
  if (/❯/.test(p) && /[─━]{10,}/.test(p)) return 'ready';
  return 'starting';
}

// ---------------------------------------------------------------------------
// Running a confirmed spawn

/** The daemon's real session-creation path (the same one the app uses). */
export interface SessionSpawner {
  spawn(req: { dir: string; name: string }): Promise<{
    ok: boolean;
    /** tmux session name = Herald's session id. */
    sessionId?: string;
    sessionName?: string;
    error?: string;
  }>;
  /** Current screen of the session (rejects when it cannot be read). */
  capturePane(sessionId: string): Promise<string>;
  exists(sessionId: string): Promise<boolean>;
}

export interface SpawnRunnerDeps {
  spawner: SessionSpawner;
  /** Type the first prompt (the normal input path). */
  sendPrompt(sessionId: string, text: string): Promise<boolean>;
  /** A follow-up note for the user ("Sent your first prompt to X."). */
  post(text: string, ref: { serverId: string; sessionId: string; sessionName: string }): void;
  /** The first prompt went in: report back what the session says. */
  onPromptSent(info: {
    sessionId: string;
    sessionName: string;
    prompt: string;
    sentAt: number;
  }): void;
  now?: () => number;
  /** Start-up wait before answering the confirm (ms). */
  readyWaitMs?: number;
  pollMs?: number;
  /** How long to keep waiting for a parked session (warning not accepted yet). */
  watchMs?: number;
  watchPollMs?: number;
  log?: (line: string) => void;
}

export interface SpawnResult {
  ok: boolean;
  message: string;
  error?: string;
  sessionId?: string;
  sessionName?: string;
}

const sleep = (ms: number) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });

export class SpawnRunner {
  private deps: SpawnRunnerDeps;
  private disposed = false;
  private watching = new Set<string>();

  constructor(deps: SpawnRunnerDeps) {
    this.deps = deps;
  }

  private now(): number {
    return (this.deps.now || Date.now)();
  }

  private async paneState(id: string): Promise<PaneState | 'unreadable'> {
    try {
      return classifyStartupPane(await this.deps.spawner.capturePane(id));
    } catch {
      return 'unreadable';
    }
  }

  async run(req: { dir: string; name: string; firstPrompt: string }): Promise<SpawnResult> {
    // Re-validate right before acting: the folder may have gone since the card.
    try {
      if (!fs.statSync(req.dir).isDirectory()) throw new Error('not a directory');
    } catch {
      return { ok: false, message: '', error: `${req.dir} no longer exists; nothing was started.` };
    }
    const made = await this.deps.spawner.spawn({ dir: req.dir, name: req.name });
    if (!made.ok || !made.sessionId)
      return {
        ok: false,
        message: '',
        error: `Could not start a session in ${req.name}: ${made.error || 'unknown error'}.`,
      };
    const id = made.sessionId;
    const name = made.sessionName || req.name;
    const ref = { serverId: 'local', sessionId: id, sessionName: name };
    const deadline = this.now() + (this.deps.readyWaitMs ?? 15_000);
    let state: PaneState | 'unreadable' = 'starting';
    while (!this.disposed) {
      state = await this.paneState(id);
      if (state === 'ready' || state === 'bypass_warning' || state === 'trust_prompt') break;
      if (this.now() >= deadline) break;
      await sleep(this.deps.pollMs ?? 500);
    }
    if (state === 'ready') {
      const sent = await this.sendFirst(id, name, req.firstPrompt);
      return {
        ok: true,
        sessionId: id,
        sessionName: name,
        message: sent
          ? `Started ${name} and sent your first prompt. I'll tell you what it says.`
          : `Started ${name}, but I couldn't type your first prompt into it. Open it in the app to send it.`,
      };
    }
    this.watch(id, name, req.firstPrompt, ref);
    const why =
      state === 'bypass_warning'
        ? "it's waiting on Claude's bypass-permissions warning. Open it in the app and accept it yourself; I won't do that for you."
        : state === 'trust_prompt'
          ? "it's asking whether to trust this folder. Open it in the app and answer it yourself."
          : "it's still starting up.";
    return {
      ok: true,
      sessionId: id,
      sessionName: name,
      message: `Started ${name}, but ${why} I'll send your first prompt as soon as it's ready.`,
    };
  }

  private async sendFirst(id: string, name: string, prompt: string): Promise<boolean> {
    let ok = false;
    try {
      ok = await this.deps.sendPrompt(id, prompt);
    } catch {
      ok = false;
    }
    if (ok)
      this.deps.onPromptSent({ sessionId: id, sessionName: name, prompt, sentAt: this.now() });
    return ok;
  }

  /** Wait (bounded) for a parked session to become ready, then send the first prompt. */
  private watch(
    id: string,
    name: string,
    prompt: string,
    ref: { serverId: string; sessionId: string; sessionName: string }
  ): void {
    if (this.watching.has(id)) return;
    this.watching.add(id);
    const until = this.now() + (this.deps.watchMs ?? 10 * 60_000);
    void (async () => {
      try {
        while (!this.disposed && this.now() < until) {
          await sleep(this.deps.watchPollMs ?? 3000);
          if (this.disposed) return;
          if (!(await this.deps.spawner.exists(id).catch(() => true))) {
            this.deps.post(
              `${name} closed before it started; your first prompt was not sent.`,
              ref
            );
            return;
          }
          if ((await this.paneState(id)) === 'ready') {
            const sent = await this.sendFirst(id, name, prompt);
            this.deps.post(
              sent
                ? `${name} is ready; sent your first prompt. I'll tell you what it says.`
                : `${name} is ready, but I couldn't type your first prompt into it. Open it in the app to send it.`,
              ref
            );
            return;
          }
        }
        if (!this.disposed)
          this.deps.post(
            `${name} still isn't ready after 10 minutes; your first prompt was not sent.`,
            ref
          );
      } finally {
        this.watching.delete(id);
      }
    })();
  }

  dispose(): void {
    this.disposed = true;
  }
}
