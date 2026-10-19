/**
 * Every server's subagents, for the all-sessions Agents page and its nav badge.
 *
 * One `subagent_list {}` (every session on the box) per connected server, then
 * `subagent_watch {live:true}` deltas (coalesced by the daemon to 1/s). Shared
 * and ref-counted: the badge and the page use the same watch. While the page is
 * hidden (document.visibilityState) nothing is watched or re-listed; on show it
 * re-lists. Session names come from the list's `sessions` labels (newer
 * daemons), else from `subagent_rollup {facts:true}` (older ones), else ids.
 */
import type { WebSocketResponse } from '../types';
import type {
  SubagentListResponse,
  SubagentRollupResponse,
  SubagentSessionLabel,
  SubagentSummary,
  SubagentUpdateEvent,
} from '../types/subagents';
import { applyUpdate } from './subagents';
import { connectionManager } from './ConnectionManager';

export const AGENTS_RELIST_MS = 30_000;
/** A delta naming a conversation we have no label for re-lists after this. */
const LABEL_RELIST_MS = 2_000;
const RETRY_MS = 3_000;

export interface AgentsServerState {
  serverId: string;
  serverName: string;
  agents: SubagentSummary[];
  labels: Record<string, SubagentSessionLabel>;
  /** The daemon has no tracker (older daemon or tracking off). */
  unsupported: boolean;
  loaded: boolean;
}

export interface AgentsTransport {
  isConnected: () => boolean;
  request: (type: string, payload: unknown) => Promise<WebSocketResponse>;
  onMessage: (h: (m: WebSocketResponse) => void) => () => void;
  onReconnect: (h: () => void) => () => void;
}

export interface AgentsStoreDeps {
  /** Servers to follow (id + name) and a change subscription. */
  servers: () => Array<{ serverId: string; serverName: string }>;
  onServersChange: (h: () => void) => () => void;
  transport: (serverId: string) => AgentsTransport | null;
  visible?: () => boolean;
  onVisibilityChange?: (h: () => void) => () => void;
}

function isUnsupported(res: WebSocketResponse): boolean {
  if (res.success) return false;
  if (/unknown message type/i.test(res.error || '')) return true;
  return (res.payload as { code?: string } | undefined)?.code === 'unavailable';
}

class ServerFeed {
  summaries = new Map<string, SubagentSummary>();
  labels: Record<string, SubagentSessionLabel> = {};
  unsupported = false;
  loaded = false;
  watching = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private offs: Array<() => void> = [];
  private alive = true;

  constructor(
    readonly serverId: string,
    public serverName: string,
    private t: AgentsTransport,
    private changed: () => void,
    private visible: () => boolean,
  ) {
    this.offs.push(
      t.onMessage((m) => {
        if (m.type !== 'subagent_update' || !this.watching) return;
        const ev = m.payload as SubagentUpdateEvent | undefined;
        // Per-session watches (the session panel) carry their sessionId.
        if (!ev || ev.sessionId !== undefined) return;
        const next = applyUpdate(this.summaries, ev);
        if (next === this.summaries) return;
        this.summaries = next;
        if ((ev.agents || []).some((a) => !this.labels[a.sessionId])) this.arm(LABEL_RELIST_MS);
        this.changed();
      }),
      t.onReconnect(() => {
        this.watching = false;
        if (this.visible()) void this.list();
      }),
    );
  }

  private arm(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.list(), ms);
  }

  async list(): Promise<void> {
    if (!this.alive || this.unsupported || !this.visible()) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.t.isConnected()) {
      this.arm(RETRY_MS);
      return;
    }
    try {
      const res = await this.t.request('subagent_list', {});
      if (!this.alive || !this.visible()) return;
      if (isUnsupported(res)) {
        this.unsupported = true;
        this.loaded = true;
        this.changed();
        return;
      }
      if (res.success && res.payload) {
        const p = res.payload as SubagentListResponse;
        this.summaries = new Map(p.agents.map((a) => [a.agentId, a]));
        if (p.sessions) this.labels = { ...this.labels, ...p.sessions };
        else await this.factsLabels();
        this.loaded = true;
        if (!this.watching) {
          this.watching = true;
          void this.t.request('subagent_watch', { live: true }).catch(() => undefined);
        }
        this.changed();
      }
    } catch {
      /* dropped connection: retried below / on reconnect */
    }
    if (this.alive && this.visible()) this.arm(this.loaded ? AGENTS_RELIST_MS : RETRY_MS);
  }

  /** Older daemons: names from the facts rollup (recent sessions only). */
  private async factsLabels(): Promise<void> {
    try {
      const res = await this.t.request('subagent_rollup', { facts: true });
      const facts = res.success ? (res.payload as SubagentRollupResponse | undefined)?.facts : undefined;
      for (const s of facts?.sessions || []) {
        const label: SubagentSessionLabel = { session: s.session };
        if (s.sessionId) label.sessionId = s.sessionId;
        this.labels[s.conversationId] = label;
      }
    } catch {
      /* names fall back to ids */
    }
  }

  /** Page hidden / no subscribers: stop watching and re-listing. */
  pause(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.watching) {
      this.watching = false;
      void this.t.request('subagent_watch', { live: false }).catch(() => undefined);
    }
  }

  dispose(): void {
    this.pause();
    this.alive = false;
    for (const off of this.offs) off();
    this.offs = [];
  }
}

export class AgentsStore {
  private feeds = new Map<string, ServerFeed>();
  private listeners = new Set<() => void>();
  private refs = 0;
  private offs: Array<() => void> = [];
  private snapshot: AgentsServerState[] = [];
  private notifyQueued = false;

  constructor(private deps: AgentsStoreDeps) {}

  getSnapshot = (): AgentsServerState[] => this.snapshot;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Start following (ref-counted). Returns the release function. */
  retain(): () => void {
    this.refs++;
    if (this.refs === 1) this.start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.refs--;
      if (this.refs === 0) this.stop();
    };
  }

  private visible(): boolean {
    return this.deps.visible ? this.deps.visible() : true;
  }

  private start() {
    this.offs.push(this.deps.onServersChange(() => this.sync()));
    if (this.deps.onVisibilityChange)
      this.offs.push(
        this.deps.onVisibilityChange(() => {
          if (this.visible()) for (const f of this.feeds.values()) void f.list();
          else for (const f of this.feeds.values()) f.pause();
        }),
      );
    this.sync();
  }

  private stop() {
    for (const off of this.offs) off();
    this.offs = [];
    for (const f of this.feeds.values()) f.dispose();
    this.feeds.clear();
    this.publish();
  }

  private sync() {
    const want = new Map(this.deps.servers().map((s) => [s.serverId, s.serverName]));
    let changed = false;
    for (const [id, f] of this.feeds) {
      if (!want.has(id)) {
        f.dispose();
        this.feeds.delete(id);
        changed = true;
      } else f.serverName = want.get(id)!;
    }
    for (const [id, name] of want) {
      if (this.feeds.has(id)) continue;
      const t = this.deps.transport(id);
      if (!t) continue;
      const f = new ServerFeed(id, name, t, () => this.queueNotify(), () => this.visible());
      this.feeds.set(id, f);
      changed = true;
      if (this.visible()) void f.list();
    }
    if (changed) this.publish();
  }

  private queueNotify() {
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    queueMicrotask(() => {
      this.notifyQueued = false;
      this.publish();
    });
  }

  private publish() {
    this.snapshot = [...this.feeds.values()].map((f) => ({
      serverId: f.serverId,
      serverName: f.serverName,
      agents: [...f.summaries.values()],
      labels: f.labels,
      unsupported: f.unsupported,
      loaded: f.loaded,
    }));
    for (const l of this.listeners) l();
  }
}


function connectionTransport(serverId: string): AgentsTransport | null {
  const conn = connectionManager.getConnection(serverId);
  if (!conn) return null;
  return {
    isConnected: () => conn.isConnected(),
    request: (type, payload) => conn.sendRequest(type, payload),
    onMessage: (h) => conn.onMessage(h),
    onReconnect: (h) => conn.onReconnect(h),
  };
}

/** The app's shared instance (every configured server). */
export const agentsStore = new AgentsStore({
  servers: () => connectionManager.getSnapshots().map((s) => ({ serverId: s.serverId, serverName: s.serverName })),
  onServersChange: (h) => connectionManager.onChange(() => h()),
  transport: connectionTransport,
  visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  onVisibilityChange: (h) => {
    if (typeof document === 'undefined') return () => undefined;
    document.addEventListener('visibilitychange', h);
    return () => document.removeEventListener('visibilitychange', h);
  },
});
