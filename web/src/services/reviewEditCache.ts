/**
 * Per-session cache of ReviewEdits for the inline chips under Edit/Write tool
 * cards. Chips ask for their tool_use id; asks made in the same short window
 * are batched into one `review_get_edits` request (at most
 * REVIEW_LIMITS.maxGetEdits ids each). Ids the daemon reports missing are
 * remembered as null so a chip renders nothing instead of refetching forever.
 * Pending edits are refetched when the summary version moves.
 */
import { REVIEW_LIMITS, type ReviewEdit, type ReviewGetEditsResponse } from '../types/review';
import type { ReviewRequestFn } from './reviewApi';

export const EDIT_BATCH_WINDOW_MS = 40;

export class ReviewEditCache {
  private entries = new Map<string, ReviewEdit | null>();
  private queued = new Set<string>();
  private inFlight = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private tick = 0;
  private disposed = false;

  constructor(
    private readonly sessionId: string,
    private readonly request: ReviewRequestFn,
  ) {}

  getTick(): number {
    return this.tick;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** undefined = not known yet, null = not a reviewable edit. */
  peek(id: string): ReviewEdit | null | undefined {
    return this.entries.get(id);
  }

  /** Ask for an edit; resolves through subscribe(). */
  want(id: string): void {
    if (!id || this.entries.has(id) || this.inFlight.has(id) || this.queued.has(id)) return;
    this.queued.add(id);
    if (!this.timer) this.timer = setTimeout(() => this.flush(), EDIT_BATCH_WINDOW_MS);
  }

  /** Seed from a review_get answer (no request needed). */
  seed(edits: ReviewEdit[]): void {
    let changed = false;
    for (const e of edits) {
      if (this.entries.get(e.id) !== e) {
        this.entries.set(e.id, e);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  /** Summary version moved: drop pending edits so visible chips refetch. */
  invalidatePending(): void {
    const stale: string[] = [];
    for (const [id, e] of this.entries) if (e && e.pending) stale.push(id);
    for (const id of stale) this.entries.delete(id);
    if (stale.length) {
      this.emit();
      for (const id of stale) this.want(id);
    }
  }

  /** A revert changed the file: forget everything (chips refetch on demand). */
  clear(): void {
    this.entries.clear();
    this.emit();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  private async flush(): Promise<void> {
    this.timer = null;
    if (this.disposed) return;
    const ids = [...this.queued];
    this.queued.clear();
    for (let i = 0; i < ids.length; i += REVIEW_LIMITS.maxGetEdits) {
      const batch = ids.slice(i, i + REVIEW_LIMITS.maxGetEdits);
      batch.forEach((id) => this.inFlight.add(id));
      try {
        const res = await this.request<ReviewGetEditsResponse>('review_get_edits', { sessionId: this.sessionId, editIds: batch });
        if (this.disposed) return;
        for (const e of res.edits ?? []) this.entries.set(e.id, e);
        for (const id of res.missing ?? []) this.entries.set(id, null);
        for (const id of batch) if (!this.entries.has(id)) this.entries.set(id, null);
      } catch {
        // Leave unknown: a later mount retries.
      } finally {
        batch.forEach((id) => this.inFlight.delete(id));
      }
      if (!this.disposed) this.emit();
    }
  }

  private emit(): void {
    this.tick++;
    for (const l of this.listeners) l();
  }
}
