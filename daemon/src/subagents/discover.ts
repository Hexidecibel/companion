/**
 * Finding subagent transcripts without polling the past.
 *
 * - fs.watch (inotify / FSEvents, no polling) on `projects/` and on each project
 *   dir, non-recursive: an event on `<conv>.jsonl` means that conversation is
 *   being written (any Claude session on the box, not only Companion's).
 * - A conversation written in the last ACTIVE_WINDOW (or still owning an active
 *   agent) is a candidate: one fs.watch on its `<conv>/subagents/` dir (created
 *   lazily: re-checked on that conversation's next write, at most every 2 s).
 * - A subagents-dir event on a known agent file marks it dirty; an unknown name
 *   re-reads that one dir (debounced 250 ms).
 * - Startup: one async readdir per project dir; only conversations touched in the
 *   last 24 h are looked into, and only agent files written in the last
 *   ACTIVE_WINDOW are read (older ones are registered as history: meta + parent
 *   notification, read lazily on demand).
 * Nothing here ever stats or reads old files repeatedly.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SubagentTracker } from './tracker';
import { isActive } from './completion';

export const ACTIVE_WINDOW_MS = 30 * 60 * 1000;
const STARTUP_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const MAX_CONV_WATCHES = 32;
const MAX_PROJECT_WATCHES = 500;
const DIR_CHECK_MS = 2000;
const READDIR_DEBOUNCE_MS = 250;
const AGENT_FILE = /^agent-[\w-]+\.jsonl$/;
const META_FILE = /^agent-([\w-]+)\.meta\.json$/;
const CONV_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

interface Conv {
  projectDir: string;
  convId: string;
  convPath: string;
  subDir: string;
  lastActivity: number;
  watcher: fs.FSWatcher | null;
  checkedAt: number;
  checking: boolean;
  readdirTimer: NodeJS.Timeout | null;
}

export interface DiscoveryDeps {
  now?: () => number;
  /** fs.watch, injectable for tests. */
  watch?: typeof fs.watch;
  log?: (msg: string) => void;
}

export class SubagentDiscovery {
  private projectWatchers = new Map<string, fs.FSWatcher>();
  private rootWatcher: fs.FSWatcher | null = null;
  private convs = new Map<string, Conv>();
  private stopped = false;
  private readonly now: () => number;
  private readonly watchFn: typeof fs.watch;
  private readonly log: (msg: string) => void;
  /** fs.watch could not be set up somewhere (callers may fall back). */
  watchErrors = 0;

  constructor(
    private projectsDir: string,
    private tracker: SubagentTracker,
    deps: DiscoveryDeps = {}
  ) {
    this.now = deps.now ?? Date.now;
    this.watchFn = deps.watch ?? fs.watch;
    this.log = deps.log ?? ((m) => console.log(m));
  }

  async start(): Promise<void> {
    try {
      this.rootWatcher = this.watchFn(this.projectsDir, { persistent: false }, (_ev, name) => {
        if (typeof name === 'string' && name && !name.includes('/'))
          void this.addProject(path.join(this.projectsDir, name), false);
      });
      this.rootWatcher.on('error', () => this.closeRoot());
    } catch {
      this.watchErrors++;
    }
    let names: string[] = [];
    try {
      names = await fs.promises.readdir(this.projectsDir);
    } catch {
      return;
    }
    for (const n of names) {
      if (this.stopped) return;
      await this.addProject(path.join(this.projectsDir, n), true);
    }
  }

  private closeRoot(): void {
    try {
      this.rootWatcher?.close();
    } catch {
      /* ignore */
    }
    this.rootWatcher = null;
  }

  private async addProject(dir: string, initial: boolean): Promise<void> {
    if (this.stopped || this.projectWatchers.has(dir)) return;
    if (this.projectWatchers.size >= MAX_PROJECT_WATCHES) return;
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(dir);
    } catch {
      return;
    }
    if (!st.isDirectory() || this.projectWatchers.has(dir)) return;
    try {
      const w = this.watchFn(dir, { persistent: false }, (_ev, name) => {
        if (typeof name !== 'string') return;
        const m = name.match(CONV_FILE);
        if (m) this.convActivity(dir, m[1]);
        else if (/^[0-9a-f-]{36}$/.test(name)) this.convActivity(dir, name, false);
      });
      w.on('error', () => {
        try {
          w.close();
        } catch {
          /* ignore */
        }
        this.projectWatchers.delete(dir);
      });
      this.projectWatchers.set(dir, w);
    } catch {
      this.watchErrors++;
    }
    if (initial) await this.scanProject(dir);
  }

  /** Startup: conversations touched in the last 24 h that have a subagents dir. */
  private async scanProject(dir: string): Promise<void> {
    let ents: fs.Dirent[];
    try {
      ents = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const dirs = new Set(ents.filter((e) => e.isDirectory()).map((e) => e.name));
    const now = this.now();
    for (const e of ents) {
      if (this.stopped) return;
      const m = e.isFile() ? e.name.match(CONV_FILE) : null;
      if (!m || !dirs.has(m[1])) continue;
      const convPath = path.join(dir, e.name);
      let st: fs.Stats;
      try {
        st = await fs.promises.stat(convPath);
      } catch {
        continue;
      }
      if (now - st.mtimeMs > STARTUP_LOOKBACK_MS) continue;
      const subDir = path.join(dir, m[1], 'subagents');
      let names: string[];
      try {
        names = await fs.promises.readdir(subDir);
      } catch {
        continue;
      }
      const files = names.filter((n) => AGENT_FILE.test(n));
      if (!files.length) continue;
      const stats: Array<{ file: string; st: fs.Stats }> = [];
      for (const n of files) {
        const file = path.join(subDir, n);
        try {
          stats.push({ file, st: await fs.promises.stat(file) });
        } catch {
          /* gone */
        }
      }
      const fresh = stats.some((s) => now - s.st.mtimeMs <= ACTIVE_WINDOW_MS);
      const convFresh = now - st.mtimeMs <= ACTIVE_WINDOW_MS;
      // Only conversations with recent activity are tracked at startup; agents of
      // older ones are not loaded (a later write brings them in).
      if (!fresh && !convFresh) continue;
      for (const { file, st: fst } of stats) {
        this.tracker.register(file, {
          mtimeMs: fst.mtimeMs,
          birthtimeMs: fst.birthtimeMs,
          size: fst.size,
          history: now - fst.mtimeMs > ACTIVE_WINDOW_MS,
        });
      }
      const conv = this.getConv(dir, m[1]);
      conv.lastActivity = Math.max(st.mtimeMs, ...stats.map((s) => s.st.mtimeMs));
      this.openDir(conv);
    }
  }

  private getConv(projectDir: string, convId: string): Conv {
    const key = path.join(projectDir, convId);
    let c = this.convs.get(key);
    if (!c) {
      c = {
        projectDir,
        convId,
        convPath: path.join(projectDir, `${convId}.jsonl`),
        subDir: path.join(projectDir, convId, 'subagents'),
        lastActivity: this.now(),
        watcher: null,
        checkedAt: 0,
        checking: false,
        readdirTimer: null,
      };
      this.convs.set(key, c);
    }
    return c;
  }

  /** A conversation file (or its dir) changed. Cheap: Map work + at most one stat per 2 s. */
  convActivity(projectDir: string, convId: string, fileWrite = true): void {
    if (this.stopped) return;
    const c = this.getConv(projectDir, convId);
    c.lastActivity = this.now();
    if (fileWrite) this.tracker.markParentDirty(c.convPath);
    if (c.watcher || c.checking || this.now() - c.checkedAt < DIR_CHECK_MS) return;
    c.checking = true;
    c.checkedAt = this.now();
    fs.promises.stat(c.subDir).then(
      (st) => {
        c.checking = false;
        if (st.isDirectory()) this.openDir(c);
      },
      () => {
        c.checking = false;
      }
    );
  }

  private openDir(c: Conv): void {
    if (this.stopped || c.watcher) return;
    this.prune();
    try {
      const w = this.watchFn(c.subDir, { persistent: false }, (_ev, name) => {
        if (typeof name !== 'string') return;
        c.lastActivity = this.now();
        if (AGENT_FILE.test(name)) {
          if (!this.tracker.markDirtyFile(path.join(c.subDir, name), true)) this.queueReaddir(c);
          return;
        }
        const meta = name.match(META_FILE);
        if (meta) {
          const rec = this.tracker.get(meta[1]);
          if (rec) void this.tracker.loadMeta(rec);
          else this.queueReaddir(c);
        }
      });
      w.on('error', () => this.closeConv(c));
      c.watcher = w;
    } catch {
      this.watchErrors++;
      return;
    }
    this.queueReaddir(c, 0);
  }

  private queueReaddir(c: Conv, delay = READDIR_DEBOUNCE_MS): void {
    if (c.readdirTimer || this.stopped) return;
    c.readdirTimer = setTimeout(() => {
      c.readdirTimer = null;
      void this.readdir(c);
    }, delay);
    c.readdirTimer.unref?.();
  }

  private async readdir(c: Conv): Promise<void> {
    let names: string[];
    try {
      names = await fs.promises.readdir(c.subDir);
    } catch {
      return;
    }
    const now = this.now();
    for (const n of names) {
      if (!AGENT_FILE.test(n)) continue;
      const file = path.join(c.subDir, n);
      const id = n.slice('agent-'.length, -'.jsonl'.length);
      const known = this.tracker.get(id);
      if (known) {
        if (!known.metaLoaded) void this.tracker.loadMeta(known);
        continue;
      }
      try {
        const st = await fs.promises.stat(file);
        this.tracker.register(file, {
          mtimeMs: st.mtimeMs,
          birthtimeMs: st.birthtimeMs,
          size: st.size,
          history: now - st.mtimeMs > ACTIVE_WINDOW_MS,
        });
      } catch {
        /* gone */
      }
    }
  }

  private convHasActive(c: Conv): boolean {
    for (const rec of this.tracker.agents.values())
      if (rec.sessionId === c.convId && isActive(rec.status)) return true;
    return false;
  }

  /** Close dir watches of conversations idle for ACTIVE_WINDOW with no active agent; cap the rest. */
  prune(): void {
    const now = this.now();
    const open = [...this.convs.values()].filter((c) => c.watcher);
    for (const c of open) {
      if (now - c.lastActivity > ACTIVE_WINDOW_MS && !this.convHasActive(c)) this.closeConv(c);
    }
    const still = [...this.convs.values()]
      .filter((c) => c.watcher)
      .sort((a, b) => a.lastActivity - b.lastActivity);
    while (still.length >= MAX_CONV_WATCHES) {
      const victim = still.find((c) => !this.convHasActive(c)) ?? still[0];
      this.closeConv(victim);
      still.splice(still.indexOf(victim), 1);
    }
    // Forget idle conversation records (watch-less, quiet) so the map stays small.
    for (const [k, c] of this.convs)
      if (!c.watcher && now - c.lastActivity > ACTIVE_WINDOW_MS) this.convs.delete(k);
  }

  private closeConv(c: Conv): void {
    try {
      c.watcher?.close();
    } catch {
      /* ignore */
    }
    c.watcher = null;
    if (c.readdirTimer) clearTimeout(c.readdirTimer);
    c.readdirTimer = null;
  }

  watchCounts(): { projects: number; conversations: number } {
    let n = 0;
    for (const c of this.convs.values()) if (c.watcher) n++;
    return { projects: this.projectWatchers.size, conversations: n };
  }

  stop(): void {
    this.stopped = true;
    this.closeRoot();
    for (const w of this.projectWatchers.values()) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
    this.projectWatchers.clear();
    for (const c of this.convs.values()) this.closeConv(c);
  }
}
