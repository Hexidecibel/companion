/**
 * Live deltas: `subagent_update` only to connections that sent subagent_watch,
 * changed agents only, coalesced to at most one event per connection per second.
 */

import type { SubagentSummary, SubagentUpdateEvent } from './protocol';
import { SUBAGENT_LIMITS } from './protocol';

export interface HubDeps {
  /** Compact state of a changed agent (undefined when gone). */
  summary: (agentId: string) => SubagentSummary | undefined;
  /** Watch key (what the client sent) -> conversation ids; null = every session. */
  resolve: (sessionKey: string | null) => string[] | null;
  send: (clientId: string, payload: SubagentUpdateEvent) => boolean;
  now?: () => number;
  intervalMs?: number;
}

interface ClientWatch {
  /** Watch keys (session ids as the client named them; '' = all). */
  keys: Set<string>;
  pending: Set<string>;
  removed: Set<string>;
  lastSentAt: number;
  timer: NodeJS.Timeout | null;
}

export class SubagentHub {
  private clients = new Map<string, ClientWatch>();
  private readonly now: () => number;
  private readonly interval: number;
  /** Events actually sent (tests / stats). */
  sent = 0;

  constructor(private deps: HubDeps) {
    this.now = deps.now ?? Date.now;
    this.interval = deps.intervalMs ?? SUBAGENT_LIMITS.updateIntervalMs;
  }

  watch(clientId: string, sessionKey: string | null, live: boolean): number {
    const key = sessionKey ?? '';
    let c = this.clients.get(clientId);
    if (!live) {
      if (c) {
        c.keys.delete(key);
        if (!c.keys.size) this.dropClient(clientId);
      }
      return c?.keys.size ?? 0;
    }
    if (!c) {
      c = { keys: new Set(), pending: new Set(), removed: new Set(), lastSentAt: 0, timer: null };
      this.clients.set(clientId, c);
    }
    if (!c.keys.has(key) && c.keys.size >= SUBAGENT_LIMITS.maxWatches)
      throw new Error('Watching too many sessions');
    c.keys.add(key);
    return c.keys.size;
  }

  get watcherCount(): number {
    return this.clients.size;
  }

  dropClient(clientId: string): void {
    const c = this.clients.get(clientId);
    if (c?.timer) clearTimeout(c.timer);
    this.clients.delete(clientId);
  }

  /** Tracker 'changed' event. */
  onChanged(ids: string[], removed: string[] = []): void {
    if (!this.clients.size) return;
    for (const [clientId, c] of this.clients) {
      for (const id of ids) c.pending.add(id);
      for (const id of removed) c.removed.add(id);
      this.arm(clientId, c);
    }
  }

  private arm(clientId: string, c: ClientWatch): void {
    if (c.timer) return;
    const wait = Math.max(0, c.lastSentAt + this.interval - this.now());
    c.timer = setTimeout(() => {
      c.timer = null;
      this.deliver(clientId, c);
    }, wait);
    c.timer.unref?.();
  }

  private deliver(clientId: string, c: ClientWatch): void {
    if (!this.clients.has(clientId)) return;
    const ids = [...c.pending];
    const removed = [...c.removed];
    c.pending.clear();
    c.removed.clear();
    if (!ids.length && !removed.length) return;
    const summaries: SubagentSummary[] = [];
    for (const id of ids) {
      const s = this.deps.summary(id);
      if (s) summaries.push(s);
    }
    const at = this.now();
    let delivered = false;
    for (const key of c.keys) {
      const convs = this.deps.resolve(key || null);
      const set = convs ? new Set(convs) : null;
      const agents = set ? summaries.filter((s) => set.has(s.sessionId)) : summaries;
      if (!agents.length && !removed.length) continue;
      const payload: SubagentUpdateEvent = { agents, at };
      if (removed.length) payload.removed = removed;
      if (key) payload.sessionId = key;
      if (!this.deps.send(clientId, payload)) {
        this.dropClient(clientId);
        return;
      }
      this.sent++;
      delivered = true;
    }
    if (delivered) c.lastSentAt = at;
  }

  shutdown(): void {
    for (const id of [...this.clients.keys()]) this.dropClient(id);
  }
}
