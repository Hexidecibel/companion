/**
 * Code Review 2.0: per-server review summaries.
 *
 * One store for the whole app. It attaches to every connection the
 * ConnectionManager knows about, fetches `review_summary_list` on connect and
 * on every reconnect (authoritative: it replaces what we had), and applies the
 * global `review_summary` events in between, dropping any version older than
 * the one already held. `review_reverted` events are fanned out to listeners
 * (other devices toast "Reverted on Phone").
 *
 * Servers whose daemon predates Code Review answer the list request with an
 * error; they are marked unsupported and nothing review-related renders.
 */
import type { ReviewRevertedEvent, ReviewSummary, ReviewSummaryEvent, ReviewSummaryListResponse } from '../types/review';
import type { WebSocketResponse } from '../types';
import { connectionManager } from './ConnectionManager';
import type { ServerConnection } from './ServerConnection';

type Listener = () => void;
type RevertListener = (serverId: string, ev: ReviewRevertedEvent) => void;

interface ServerEntry {
  summaries: Map<string, ReviewSummary>;
  supported: boolean | null;
}

/** Minimal connection surface the store needs (lets tests inject fakes). */
export interface ReviewStoreConnection {
  isConnected(): boolean;
  sendRequest(type: string, payload?: unknown, timeoutMs?: number): Promise<WebSocketResponse>;
  onMessage(handler: (msg: WebSocketResponse) => void): () => void;
  onStateChange(handler: (state: { status: string }) => void): () => void;
}

export class ReviewStore {
  private servers = new Map<string, ServerEntry>();
  private listeners = new Set<Listener>();
  private revertListeners = new Set<RevertListener>();
  private attached = new Map<string, { conn: ReviewStoreConnection; off: () => void }>();
  /** Bumped on every change; useSyncExternalStore snapshots key off it. */
  private tick = 0;

  getTick(): number {
    return this.tick;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onReverted(listener: RevertListener): () => void {
    this.revertListeners.add(listener);
    return () => this.revertListeners.delete(listener);
  }

  get(serverId: string | null | undefined, sessionId: string | null | undefined): ReviewSummary | null {
    if (!serverId || !sessionId) return null;
    return this.servers.get(serverId)?.summaries.get(sessionId) ?? null;
  }

  all(serverId: string): ReviewSummary[] {
    return [...(this.servers.get(serverId)?.summaries.values() ?? [])];
  }

  /** null = not known yet, false = daemon has no Code Review. */
  supported(serverId: string | null | undefined): boolean | null {
    if (!serverId) return null;
    return this.servers.get(serverId)?.supported ?? null;
  }

  /**
   * Apply one summary. Older versions are dropped (events can race the list
   * response and each other). Returns whether it was applied.
   */
  apply(serverId: string, summary: ReviewSummary): boolean {
    if (!summary || typeof summary.sessionId !== 'string') return false;
    const entry = this.entry(serverId);
    const prev = entry.summaries.get(summary.sessionId);
    if (prev && prev.version >= summary.version) return false;
    entry.summaries.set(summary.sessionId, summary);
    if (entry.supported !== true) entry.supported = true;
    this.emit();
    return true;
  }

  /** Authoritative replace (list response after connect / reconnect). */
  replaceAll(serverId: string, summaries: ReviewSummary[]): void {
    const entry = this.entry(serverId);
    entry.summaries = new Map(summaries.filter((s) => s && typeof s.sessionId === 'string').map((s) => [s.sessionId, s]));
    entry.supported = true;
    this.emit();
  }

  markUnsupported(serverId: string): void {
    const entry = this.entry(serverId);
    if (entry.supported === false) return;
    entry.supported = false;
    entry.summaries.clear();
    this.emit();
  }

  /** Feed one inbound message (exposed for tests). */
  handleMessage(serverId: string, msg: WebSocketResponse): void {
    if (msg.type === 'review_summary') {
      const p = msg.payload as ReviewSummaryEvent | undefined;
      if (p?.summary) this.apply(serverId, p.summary);
    } else if (msg.type === 'review_reverted') {
      const p = msg.payload as ReviewRevertedEvent | undefined;
      if (!p || typeof p.sessionId !== 'string') return;
      for (const l of this.revertListeners) {
        try { l(serverId, p); } catch (err) { console.error('review revert listener', err); }
      }
    }
  }

  async refresh(serverId: string): Promise<void> {
    const a = this.attached.get(serverId);
    if (!a || !a.conn.isConnected()) return;
    try {
      const res = await a.conn.sendRequest('review_summary_list', {}, 10000);
      if (res.success && res.payload) {
        this.replaceAll(serverId, (res.payload as ReviewSummaryListResponse).summaries ?? []);
      } else if (!res.success) {
        // Old daemon: "Unknown message type". Anything else is transient.
        if (/unknown message type/i.test(res.error ?? '')) this.markUnsupported(serverId);
      }
    } catch {
      // Timeout / socket dropped: retried on the next (re)connect.
    }
  }

  /** Attach to one connection (idempotent). */
  attach(serverId: string, conn: ReviewStoreConnection): void {
    const existing = this.attached.get(serverId);
    if (existing?.conn === conn) return;
    existing?.off();
    let wasConnected = false;
    // Register before subscribing: onStateChange fires synchronously with the
    // current state, and an already-connected socket must fetch right away.
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
      e = { summaries: new Map(), supported: null };
      this.servers.set(serverId, e);
    }
    return e;
  }

  private emit(): void {
    this.tick++;
    for (const l of this.listeners) {
      try { l(); } catch (err) { console.error('review store listener', err); }
    }
  }
}

export const reviewStore = new ReviewStore();

let wired = false;

/** Attach the singleton store to every connection, now and as they come and go. */
export function ensureReviewStore(): ReviewStore {
  if (wired) return reviewStore;
  wired = true;
  const sync = () => {
    const ids = new Set<string>();
    for (const snap of connectionManager.getSnapshots()) {
      const conn = connectionManager.getConnection(snap.serverId) as ServerConnection | undefined;
      if (!conn) continue;
      ids.add(snap.serverId);
      reviewStore.attach(snap.serverId, conn as unknown as ReviewStoreConnection);
    }
    for (const id of reviewStore.attachedIds()) {
      if (!ids.has(id)) reviewStore.detach(id);
    }
  };
  connectionManager.onChange(sync);
  sync();
  return reviewStore;
}
