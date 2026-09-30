/**
 * Deterministic inbox derived from session state transitions. No LLM involvement:
 * headlines are templated from session data so they can never hallucinate.
 *
 *   blocked  — a live choice prompt / pending tool approval (current truth, shown
 *              immediately), or a finished turn that ends by asking the user a
 *              question (transition-only). Resolved (removed) as soon as the
 *              session is no longer blocked on that same thing.
 *   finished — a session went working -> idle (or produced a new turn) since the
 *              last observation. Removed when the session starts working again.
 */

import type { HeraldInboxItem, InboxPriority } from './protocol';
import type { SessionSnapshot } from './session-source';
import { BoundedSet } from '../utils';
import { clip, firstSentence, fnv1a, oneLine } from './text';

const MAX_ITEMS = 50;
const FINISHED_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_HEARD = 1000;
const PRIORITY_RANK: Record<InboxPriority, number> = { blocked: 0, finished: 1, progress: 2 };

interface PrevState {
  status: SessionSnapshot['status'];
  turnKey: string | null;
}

interface BlockedDescriptor {
  key: string;
  headline: string;
  /** Choice/approval prompts are current truth; question-ended turns are transition-only. */
  transitionOnly: boolean;
}

function blockedFor(s: SessionSnapshot): BlockedDescriptor | null {
  if (s.pendingChoice) {
    const q = oneLine(s.pendingChoice.question || 'a question');
    const header = s.pendingChoice.header ? `${oneLine(s.pendingChoice.header)}: ` : '';
    return {
      // Occurrence = prompt content + the turn it belongs to: stable across polls and
      // daemon restarts (so "heard" sticks), distinct when a new turn re-asks.
      key: `c${s.pendingChoice.signature}.${fnv1a(s.lastTurnKey || '')}`,
      headline: clip(`${s.sessionName} is asking: ${header}${q}`, 160),
      transitionOnly: false,
    };
  }
  if (s.pendingApproval) {
    const detail = s.pendingApproval.detail ? `: ${oneLine(s.pendingApproval.detail)}` : '';
    return {
      key: `a${fnv1a(s.pendingApproval.toolUseId || `${s.pendingApproval.tool}\u0001${s.pendingApproval.detail}`)}`,
      headline: clip(`${s.sessionName} needs approval for ${s.pendingApproval.tool}${detail}`, 160),
      transitionOnly: false,
    };
  }
  if (s.pendingQuestion) {
    return {
      key: `q${fnv1a(s.lastTurnKey || s.pendingQuestion)}`,
      headline: clip(`${s.sessionName} is asking: ${oneLine(s.pendingQuestion)}`, 160),
      transitionOnly: true,
    };
  }
  return null;
}

export class InboxTracker {
  private items = new Map<string, HeraldInboxItem>();
  private prev = new Map<string, PrevState>();
  private blockedBySession = new Map<string, { key: string; id: string; misses: number }>();
  private seenKeys = new BoundedSet<string>(2000);
  private heard: Set<string>;
  private primed = false;

  constructor(heardIds: string[] = []) {
    this.heard = new Set(heardIds.slice(-MAX_HEARD));
  }

  /** Apply a fresh set of snapshots. Returns true when the visible inbox changed. */
  update(snaps: SessionSnapshot[], now: number): boolean {
    const before = this.signature();
    const present = new Set<string>();

    for (const s of snaps) {
      const sk = `${s.serverId}:${s.sessionId}`;
      present.add(sk);
      const prev = this.prev.get(sk);
      const blocked = blockedFor(s);

      // Blocked: keyed by what the session is blocked on (per occurrence, since
      // identical permission boxes recur). Resolved after
      // two consecutive misses (tolerates one flaky pane capture) or immediately
      // once the session is visibly working again.
      const cur = this.blockedBySession.get(sk);
      if (cur && (!blocked || blocked.key !== cur.key)) {
        cur.misses++;
        if (s.status === 'working' || blocked || cur.misses >= 2) {
          this.items.delete(cur.id);
          this.blockedBySession.delete(sk);
        }
      } else if (cur) {
        cur.misses = 0;
      }
      if (blocked && !this.blockedBySession.has(sk)) {
        const turnChanged = !!prev && (prev.status === 'working' || prev.turnKey !== s.lastTurnKey);
        if (blocked.transitionOnly) {
          const id = `${sk}:${blocked.key}`;
          if (this.primed && turnChanged && !this.seenKeys.has(id)) {
            this.add(id, s, 'blocked', blocked.headline, now);
            this.blockedBySession.set(sk, { key: blocked.key, id, misses: 0 });
          }
        } else {
          const id = `${sk}:${blocked.key}`;
          this.add(id, s, 'blocked', blocked.headline, now);
          this.blockedBySession.set(sk, { key: blocked.key, id, misses: 0 });
        }
      }

      if (s.status === 'working') {
        // Work resumed: any "finished" note for this session is stale.
        for (const [id, item] of this.items) {
          if (item.priority === 'finished' && `${item.serverId}:${item.sessionId}` === sk)
            this.items.delete(id);
        }
      } else if (
        s.status === 'idle' &&
        !blocked &&
        this.primed &&
        prev &&
        s.lastTurnKey &&
        (prev.status === 'working' || prev.turnKey !== s.lastTurnKey)
      ) {
        const id = `${sk}:f${fnv1a(s.lastTurnKey)}`;
        if (!this.items.has(id) && !this.seenKeys.has(id)) {
          // One "finished" per session: a newer one replaces the older.
          for (const [oid, item] of this.items) {
            if (item.priority === 'finished' && `${item.serverId}:${item.sessionId}` === sk)
              this.items.delete(oid);
          }
          const gist = s.lastTurnGist ? firstSentence(s.lastTurnGist, 120) : '';
          this.add(
            id,
            s,
            'finished',
            gist ? `${s.sessionName} finished: ${gist}` : `${s.sessionName} finished.`,
            now
          );
        }
      }

      this.prev.set(sk, { status: s.status, turnKey: s.lastTurnKey });
    }

    // Sessions that vanished can no longer be blocked.
    for (const [id, item] of this.items) {
      const sk = `${item.serverId}:${item.sessionId}`;
      if (!present.has(sk)) {
        if (item.priority === 'blocked') this.items.delete(id);
      }
    }
    for (const sk of Array.from(this.prev.keys())) {
      if (!present.has(sk)) {
        this.prev.delete(sk);
        this.blockedBySession.delete(sk);
      }
    }

    this.prune(now);
    this.primed = true;
    return this.signature() !== before;
  }

  private add(
    id: string,
    s: SessionSnapshot,
    priority: InboxPriority,
    headline: string,
    now: number
  ): void {
    this.seenKeys.add(id);
    this.items.set(id, {
      id,
      serverId: s.serverId,
      sessionId: s.sessionId,
      sessionName: s.sessionName,
      priority,
      headline,
      createdAt: now,
      heard: this.heard.has(id),
    });
  }

  private prune(now: number): void {
    for (const [id, item] of this.items) {
      if (item.priority !== 'blocked' && now - item.createdAt > FINISHED_TTL_MS)
        this.items.delete(id);
    }
    if (this.items.size > MAX_ITEMS) {
      const victims = this.list()
        .slice()
        .reverse()
        .filter((i) => i.priority !== 'blocked');
      for (const v of victims) {
        if (this.items.size <= MAX_ITEMS) break;
        this.items.delete(v.id);
      }
    }
  }

  markHeard(ids: string[]): boolean {
    let changed = false;
    for (const id of ids) {
      if (typeof id !== 'string' || !id) continue;
      if (!this.heard.has(id)) {
        this.heard.add(id);
        changed = true;
      }
      const item = this.items.get(id);
      if (item && !item.heard) {
        item.heard = true;
        changed = true;
      }
    }
    if (this.heard.size > MAX_HEARD) {
      // Keep only ids still in the inbox plus the most recent markers.
      const keep = Array.from(this.heard).slice(-MAX_HEARD);
      this.heard = new Set(keep);
    }
    return changed;
  }

  heardIds(): string[] {
    return Array.from(this.heard);
  }

  list(): HeraldInboxItem[] {
    return Array.from(this.items.values())
      .map((i) => ({ ...i }))
      .sort(
        (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.createdAt - a.createdAt
      );
  }

  private signature(): string {
    return this.list()
      .map((i) => `${i.id}|${i.heard ? 1 : 0}|${i.sessionName}`)
      .join('\n');
  }
}
