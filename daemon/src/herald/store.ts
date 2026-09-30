/**
 * Bounded, crash-safe persistence for Herald state.
 *
 * - Async + debounced writes (never blocks the event loop on a hot path).
 * - Atomic: write to a temp file in the same directory, then rename.
 * - Writes are serialized; a burst of changes collapses into one write.
 * - Load is tolerant: a corrupt file is moved aside and Herald starts fresh.
 * - Pending actions are NEVER resumed after a restart: they load as expired.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { HeraldAction, HeraldMessage } from './protocol';

export const MAX_PERSISTED_MESSAGES = 100;
export const MAX_PERSISTED_ACTIONS = 50;
export const MAX_PERSISTED_HEARD = 1000;
const MAX_MESSAGE_TEXT = 8000;
const STATE_VERSION = 1;

export interface PersistedHeraldState {
  version: number;
  messages: HeraldMessage[];
  heard: string[];
  actions: HeraldAction[];
  /** Names of cush-tools tools Herald itself launched (closing those needs no confirm). */
  cushOpened?: string[];
}

export const MAX_PERSISTED_CUSH_OPENED = 100;
const CUSH_NAME = /^[a-z0-9-]{2,32}$/;

export function emptyState(): PersistedHeraldState {
  return { version: STATE_VERSION, messages: [], heard: [], actions: [] };
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function sanitizeMessage(raw: unknown): HeraldMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (
    !isStr(m.id) ||
    (m.role !== 'user' && m.role !== 'herald') ||
    !isStr(m.text) ||
    !isNum(m.createdAt)
  )
    return null;
  const out: HeraldMessage = {
    id: m.id,
    role: m.role,
    text: m.text.slice(0, MAX_MESSAGE_TEXT),
    createdAt: m.createdAt,
  };
  if (Array.isArray(m.sessionRefs)) {
    out.sessionRefs = m.sessionRefs
      .filter((r: any) => r && isStr(r.serverId) && isStr(r.sessionId) && isStr(r.sessionName))
      .map((r: any) => ({
        serverId: r.serverId,
        sessionId: r.sessionId,
        sessionName: r.sessionName,
      }))
      .slice(0, 20);
  }
  if (Array.isArray(m.actionIds)) out.actionIds = m.actionIds.filter(isStr).slice(0, 20);
  // A message persisted mid-stream is finalized on load.
  return out;
}

const ACTION_STATUSES = new Set(['pending', 'sent', 'cancelled', 'failed', 'expired']);

function sanitizeAction(raw: unknown): HeraldAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  if (
    !isStr(a.id) ||
    (a.tier !== 'echo' && a.tier !== 'hard_confirm') ||
    (a.kind !== 'send_input' && a.kind !== 'answer_choice' && a.kind !== 'cush_command') ||
    !isStr(a.serverId) ||
    !isStr(a.sessionId) ||
    !isStr(a.sessionName) ||
    !isStr(a.payload) ||
    !isStr(a.readback) ||
    !isStr(a.status) ||
    !ACTION_STATUSES.has(a.status) ||
    !isNum(a.createdAt)
  ) {
    return null;
  }
  const out: HeraldAction = {
    id: a.id,
    tier: a.tier,
    kind: a.kind,
    serverId: a.serverId,
    sessionId: a.sessionId,
    sessionName: a.sessionName,
    payload: a.payload,
    readback: a.readback,
    reasons: Array.isArray(a.reasons) ? a.reasons.filter(isStr) : [],
    status: a.status as HeraldAction['status'],
    createdAt: a.createdAt,
  };
  if (isNum(a.autoSendAt)) out.autoSendAt = a.autoSendAt;
  if (isStr(a.error)) out.error = a.error;
  if (isNum(a.resolvedAt)) out.resolvedAt = a.resolvedAt;
  return out;
}

/** Validate + bound a parsed state object. Pending actions become expired. */
export function sanitizeState(raw: unknown, now: number): PersistedHeraldState {
  if (!raw || typeof raw !== 'object') throw new Error('state is not an object');
  const r = raw as Record<string, unknown>;
  const messages = (Array.isArray(r.messages) ? r.messages : [])
    .map(sanitizeMessage)
    .filter((m): m is HeraldMessage => m !== null)
    .slice(-MAX_PERSISTED_MESSAGES);
  const heard = (Array.isArray(r.heard) ? r.heard : []).filter(isStr).slice(-MAX_PERSISTED_HEARD);
  const actions = (Array.isArray(r.actions) ? r.actions : [])
    .map(sanitizeAction)
    .filter((a): a is HeraldAction => a !== null)
    .slice(-MAX_PERSISTED_ACTIONS)
    .map((a) =>
      a.status === 'pending'
        ? {
            ...a,
            status: 'expired' as const,
            autoSendAt: undefined,
            error: 'Not sent: the daemon restarted before this was confirmed.',
            resolvedAt: now,
          }
        : a
    );
  const cushOpened = (Array.isArray(r.cushOpened) ? r.cushOpened : [])
    .filter((n): n is string => isStr(n) && CUSH_NAME.test(n))
    .slice(-MAX_PERSISTED_CUSH_OPENED);
  return {
    version: STATE_VERSION,
    messages,
    heard,
    actions,
    ...(cushOpened.length ? { cushOpened } : {}),
  };
}

export class HeraldStore {
  readonly filePath: string;
  private debounceMs: number;
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();
  private latest: (() => PersistedHeraldState) | null = null;
  /** Most recent snapshot source ever scheduled (used for the shutdown write). */
  private source: (() => PersistedHeraldState) | null = null;
  private inFlight = 0;
  private closed = false;

  constructor(dir: string, debounceMs = 1000) {
    this.filePath = path.join(dir, 'state.json');
    this.debounceMs = debounceMs;
  }

  async load(now: number = Date.now()): Promise<PersistedHeraldState> {
    let content: string;
    try {
      content = await fs.promises.readFile(this.filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.error('Herald: failed to read state file, starting fresh:', err);
      }
      return emptyState();
    }
    try {
      return sanitizeState(JSON.parse(content), now);
    } catch (err) {
      const aside = `${this.filePath}.corrupt-${now}`;
      console.error(
        `Herald: state file is corrupt (${String(err)}); moving it to ${aside} and starting fresh`
      );
      try {
        await fs.promises.rename(this.filePath, aside);
      } catch {
        /* best effort */
      }
      return emptyState();
    }
  }

  /** Schedule a debounced save; `snapshot` is invoked at write time for fresh data. */
  scheduleSave(snapshot: () => PersistedHeraldState): void {
    if (this.closed) return;
    this.latest = snapshot;
    this.source = snapshot;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  /** Write the latest snapshot now (serialized behind any in-flight write). */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const snap = this.latest;
    if (!snap) return this.writing;
    this.latest = null;
    this.inFlight++;
    this.writing = this.writing
      .then(() => (this.closed ? undefined : this.writeAtomic(snap())))
      .catch((err) => {
        console.error('Herald: failed to persist state:', err);
      })
      .finally(() => {
        this.inFlight--;
      });
    return this.writing;
  }

  private async writeAtomic(state: PersistedHeraldState): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.state.json.${process.pid}.${Date.now()}.tmp`);
    try {
      await fs.promises.writeFile(tmp, JSON.stringify(state), { encoding: 'utf-8', mode: 0o600 });
      if (this.closed) {
        // Shutdown already wrote the newest state synchronously; don't clobber it.
        await fs.promises.unlink(tmp).catch(() => undefined);
        return;
      }
      await fs.promises.rename(tmp, this.filePath);
    } catch (err) {
      try {
        await fs.promises.unlink(tmp);
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  /** Synchronous last-chance write for process shutdown (not a hot path). */
  flushSyncOnShutdown(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.closed = true;
    // Write if anything is unsaved OR an async write may still be landing.
    const snap = this.latest || (this.inFlight > 0 ? this.source : null);
    if (!snap) return;
    this.latest = null;
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, `.state.json.${process.pid}.shutdown.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(snap()), { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error('Herald: failed to persist state on shutdown:', err);
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
