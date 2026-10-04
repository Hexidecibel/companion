/**
 * Stuck sessions: per-server findings from the daemon's stuck detector.
 *
 * One store for the whole app. It attaches to every connection the
 * ConnectionManager knows about, fetches `stuck_list` on connect and on every
 * reconnect (authoritative), and applies the global `stuck_update` events (the
 * full visible list each time) in between. Servers whose daemon predates stuck
 * detection answer the list with "Unknown message type" and render nothing.
 *
 * "Not stuck" / snooze are applied optimistically (hidden at once) and
 * confirmed by the daemon's next list.
 */
import type { StuckFinding, StuckListResponse, StuckSettings, StuckUpdateEvent } from '../types/stuck';
import type { WebSocketResponse } from '../types';
import { connectionManager } from './ConnectionManager';
import type { ServerConnection } from './ServerConnection';

type Listener = () => void;

/** Minimal connection surface the store needs (lets tests inject fakes). */
export interface StuckStoreConnection {
  isConnected(): boolean;
  sendRequest(type: string, payload?: unknown, timeoutMs?: number): Promise<WebSocketResponse>;
  onMessage(handler: (msg: WebSocketResponse) => void): () => void;
  onStateChange(handler: (state: { status: string }) => void): () => void;
}

interface ServerEntry {
  findings: StuckFinding[];
  settings: StuckSettings | null;
  supported: boolean | null;
}

export class StuckStore {
  private servers = new Map<string, ServerEntry>();
  private listeners = new Set<Listener>();
  private attached = new Map<string, { conn: StuckStoreConnection; off: () => void }>();
  /** Finding ids hidden locally until the daemon's list drops them. */
  private hidden = new Set<string>();
  private tick = 0;

  getTick(): number {
    return this.tick;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Visible findings for one session, most urgent first. */
  forSession(serverId: string | null | undefined, sessionId: string | null | undefined): StuckFinding[] {
    if (!serverId || !sessionId) return [];
    return (this.servers.get(serverId)?.findings ?? []).filter((f) => f.sessionId === sessionId && !this.hidden.has(f.id));
  }

  all(serverId: string | null | undefined): StuckFinding[] {
    if (!serverId) return [];
    return (this.servers.get(serverId)?.findings ?? []).filter((f) => !this.hidden.has(f.id));
  }

  settings(serverId: string | null | undefined): StuckSettings | null {
    if (!serverId) return null;
    return this.servers.get(serverId)?.settings ?? null;
  }

  /** null = not known yet, false = daemon has no stuck detection. */
  supported(serverId: string | null | undefined): boolean | null {
    if (!serverId) return null;
    return this.servers.get(serverId)?.supported ?? null;
  }

  /** Authoritative replace (list response / update event). */
  replace(serverId: string, findings: StuckFinding[], settings?: StuckSettings): void {
    const e = this.entry(serverId);
    e.findings = (Array.isArray(findings) ? findings : []).filter((f) => f && typeof f.id === 'string');
    if (settings) e.settings = settings;
    e.supported = true;
    // Forget local hides the daemon has confirmed.
    const live = new Set(e.findings.map((f) => f.id));
    for (const id of this.hidden) if (!live.has(id)) this.hidden.delete(id);
    this.emit();
  }

  setSettings(serverId: string, settings: StuckSettings): void {
    this.entry(serverId).settings = settings;
    this.emit();
  }

  /** Hide findings now (optimistic "not stuck" / snooze). */
  hide(ids: string[]): void {
    let changed = false;
    for (const id of ids) {
      if (!this.hidden.has(id)) {
        this.hidden.add(id);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  unhide(ids: string[]): void {
    let changed = false;
    for (const id of ids) changed = this.hidden.delete(id) || changed;
    if (changed) this.emit();
  }

  markUnsupported(serverId: string): void {
    const e = this.entry(serverId);
    if (e.supported === false) return;
    e.supported = false;
    e.findings = [];
    this.emit();
  }

  handleMessage(serverId: string, msg: WebSocketResponse): void {
    if (msg.type !== 'stuck_update') return;
    const p = msg.payload as StuckUpdateEvent | undefined;
    if (p && Array.isArray(p.findings)) this.replace(serverId, p.findings);
  }

  async refresh(serverId: string): Promise<void> {
    const a = this.attached.get(serverId);
    if (!a || !a.conn.isConnected()) return;
    try {
      const res = await a.conn.sendRequest('stuck_list', {}, 10000);
      if (res.success && res.payload) {
        const p = res.payload as StuckListResponse;
        this.replace(serverId, p.findings ?? [], p.settings);
      } else if (!res.success && /unknown message type/i.test(res.error ?? '')) {
        this.markUnsupported(serverId);
      }
    } catch {
      // Timeout / socket dropped: retried on the next (re)connect.
    }
  }

  /** Send a stuck request to one server. */
  async request<T>(serverId: string, type: string, payload: unknown): Promise<T> {
    const a = this.attached.get(serverId);
    if (!a || !a.conn.isConnected()) throw new Error('Not connected');
    const res = await a.conn.sendRequest(type, payload, 15000);
    if (!res.success) throw new Error(res.error || 'Request failed');
    return res.payload as T;
  }

  attach(serverId: string, conn: StuckStoreConnection): void {
    const existing = this.attached.get(serverId);
    if (existing?.conn === conn) return;
    existing?.off();
    let wasConnected = false;
    const entry = { conn, off: () => {} };
    this.attached.set(serverId, entry);
    const offMsg = conn.onMessage((msg) => this.handleMessage(serverId, msg));
    const offState = conn.onStateChange((state) => {
      const now = state.status === 'connected';
      if (now && !wasConnected) void this.refresh(serverId);
      wasConnected = now;
    });
    entry.off = () => { offMsg(); offState(); };
  }

  attachedIds(): string[] {
    return [...this.attached.keys()];
  }

  detach(serverId: string): void {
    this.attached.get(serverId)?.off();
    this.attached.delete(serverId);
    if (this.servers.delete(serverId)) this.emit();
  }

  private entry(serverId: string): ServerEntry {
    let e = this.servers.get(serverId);
    if (!e) {
      e = { findings: [], settings: null, supported: null };
      this.servers.set(serverId, e);
    }
    return e;
  }

  private emit(): void {
    this.tick++;
    for (const l of this.listeners) {
      try { l(); } catch (err) { console.error('stuck store listener', err); }
    }
  }
}

export const stuckStore = new StuckStore();

let wired = false;

/** Attach the singleton store to every connection, now and as they come and go. */
export function ensureStuckStore(): StuckStore {
  if (wired) return stuckStore;
  wired = true;
  const sync = () => {
    const ids = new Set<string>();
    for (const snap of connectionManager.getSnapshots()) {
      const conn = connectionManager.getConnection(snap.serverId) as ServerConnection | undefined;
      if (!conn) continue;
      ids.add(snap.serverId);
      stuckStore.attach(snap.serverId, conn as unknown as StuckStoreConnection);
    }
    for (const id of stuckStore.attachedIds()) {
      if (!ids.has(id)) stuckStore.detach(id);
    }
  };
  connectionManager.onChange(sync);
  sync();
  return stuckStore;
}
