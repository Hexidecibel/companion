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
 *   answer   — (a finished/blocked item with `answer: true`) what a session said
 *              back to a question the user asked it through Herald. Replaces the
 *              generic finished / question note for that turn (no double
 *              notification), survives the session working again, expires by TTL.
 *   review   — (a finished item with `review`) a risky code change (Code Review).
 *              Survives the session working again; removed when the user marks
 *              the session reviewed, or by TTL.
 *   stuck    — (a finished item with `stuck`) a WORKING session that looks stuck
 *              (stuck detection). Survives the session working (that is the
 *              point); replaced wholesale by the detector's current list, so it
 *              disappears as soon as the session recovers, is snoozed or idle.
 *   error    — (a finished item with `error`) the session's turn ended on an
 *              unresolved tool error (turn-error.ts). Replaces the plain
 *              "finished" note for that turn; same lifetime as one.
 *   pairing  — (a blocked item with `pairing`) a new device wants to pair with
 *              this daemon. Not a session: replaced wholesale by the pairing
 *              manager's pending list, so it goes on approve, deny or expiry.
 *              Its headline carries the code for the screen; the brain only
 *              ever gets `brainHeadline` (a placeholder instead of the code).
 */

import type { HeraldInboxItem, InboxPriority } from './protocol';
import type { SessionSnapshot } from './session-source';
import { BoundedSet } from '../utils';
import { clip, firstSentence, fnv1a, oneLine } from './text';

const MAX_ITEMS = 50;
const FINISHED_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_HEARD = 1000;
const PRIORITY_RANK: Record<InboxPriority, number> = { blocked: 0, finished: 1, progress: 2 };
/** What the brain (and anything spoken) gets instead of a pairing code. */
export const PAIRING_CODE_PLACEHOLDER = '[code on screen]';

/**
 * The headline as the brain / a spoken briefing may see it: a pairing item
 * never carries its code there (the code is for the screen only).
 */
export function brainHeadline(i: HeraldInboxItem): string {
  if (i.pairing)
    return `${i.pairing.deviceName} wants to pair, code ${PAIRING_CODE_PLACEHOLDER}. Approve or deny it on screen; pairing is never approved by voice.`;
  return i.headline;
}

const DECIDE = /\b(approve|approved|accept|allow|let\s+(?:it|them|\w+)\s+in|deny|reject|decline|refuse)\b/i;
const PAIR_WORD = /\bpair(?:ing|ed)?\b/i;
const DEVICE_WORD = /\b(device|ipad|iphone|phone|tablet|laptop|computer|desktop|mac|macbook|pc|android|pixel|browser)\b/i;

/**
 * A request to approve / deny a pairing through Herald. Pairing is decided on
 * screen only, so such a message gets a fixed reply instead of a brain turn.
 * Matches a decision word plus "pair", or plus a waiting device's name / a
 * device word while a request is waiting. Null when it is not about pairing.
 */
export function pairingDecisionReply(text: string, waiting: HeraldInboxItem[]): string | null {
  const t = oneLine(text);
  if (!DECIDE.test(t)) return null;
  const pending = waiting.filter((i) => i.pairing);
  const named = pending.find((i) => t.toLowerCase().includes(i.pairing!.deviceName.toLowerCase()));
  const aboutPairing = PAIR_WORD.test(t) || !!named || (pending.length > 0 && DEVICE_WORD.test(t));
  if (!aboutPairing) return null;
  const which = named ?? pending[0];
  if (!which)
    return 'No device is waiting to pair. Pairing is approved on screen only: start it from the new device, then approve it on this screen.';
  return `I can't approve pairing by voice. ${which.pairing!.deviceName} is waiting: approve or deny it on screen, in the "Approve new device?" prompt or under Settings, Devices.`;
}

export interface PendingPairingInfo {
  pairingId: string;
  deviceName: string;
  platform: string;
  code: string;
  expiresAt: number;
}

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

  /**
   * Apply a fresh set of snapshots. Returns true when the visible inbox changed.
   * `deferTurn(sessionKey)`: the session has an open ask, so its next finished /
   * question note is left to the ask-answer item instead.
   */
  update(
    snaps: SessionSnapshot[],
    now: number,
    deferTurn?: (sessionKey: string) => boolean
  ): boolean {
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
          if (deferTurn?.(sk)) {
            this.seenKeys.add(id);
          } else if (this.primed && turnChanged && !this.seenKeys.has(id)) {
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
        // Work resumed: any "finished" note for this session is stale (an answer
        // stays: it is what the user asked for; an answer that ended in a
        // question has been answered).
        for (const [id, item] of this.items) {
          if (`${item.serverId}:${item.sessionId}` !== sk || item.review || item.stuck) continue;
          if (item.answer ? item.priority === 'blocked' : item.priority === 'finished')
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
        if (deferTurn?.(sk)) {
          this.seenKeys.add(id);
        } else if (!this.items.has(id) && !this.seenKeys.has(id)) {
          // One "finished" per session: a newer one replaces the older.
          for (const [oid, item] of this.items) {
            if (
              item.priority === 'finished' &&
              !item.answer &&
              !item.review &&
              !item.stuck &&
              `${item.serverId}:${item.sessionId}` === sk
            )
              this.items.delete(oid);
          }
          const gist = s.lastTurnGist ? firstSentence(s.lastTurnGist, 120) : '';
          if (s.turnError) {
            const err = { tool: clip(oneLine(s.turnError.tool), 40), line: clip(oneLine(s.turnError.line), 160) };
            this.add(id, s, 'finished', `${s.sessionName} ended with an error: ${err.tool}: ${err.line}`, now);
            this.items.get(id)!.error = err;
          } else {
            this.add(
              id,
              s,
              'finished',
              gist ? `${s.sessionName} finished: ${gist}` : `${s.sessionName} finished.`,
              now
            );
          }
        }
      }

      this.prev.set(sk, { status: s.status, turnKey: s.lastTurnKey });
    }

    // Sessions that vanished can no longer be blocked.
    for (const [id, item] of this.items) {
      if (item.pairing) continue; // not a session
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

  /**
   * An answer to the user's question (ask-and-report). One per ask; a newer
   * answer from the same session sits beside it (each answers its own question).
   */
  addAnswer(a: {
    askId: string;
    serverId: string;
    sessionId: string;
    sessionName: string;
    headline: string;
    priority: 'finished' | 'blocked';
    createdAt: number;
  }): HeraldInboxItem {
    const id = `${a.serverId}:${a.sessionId}:ans${fnv1a(a.askId)}`;
    this.seenKeys.add(id);
    const item: HeraldInboxItem = {
      id,
      serverId: a.serverId,
      sessionId: a.sessionId,
      sessionName: a.sessionName,
      priority: a.priority,
      headline: clip(oneLine(a.headline), 400),
      createdAt: a.createdAt,
      heard: this.heard.has(id),
      answer: true,
    };
    this.items.set(id, item);
    this.prune(a.createdAt);
    return { ...item };
  }

  /**
   * A risky code change (Code Review). Keyed by the alert's dedupe key, so a
   * coalesced update of the same alert replaces it in place.
   */
  addReviewAlert(a: {
    key: string;
    serverId: string;
    sessionId: string;
    sessionName: string;
    headline: string;
    level: 'high' | 'medium';
    kinds: string[];
    paths: string[];
    createdAt: number;
  }): HeraldInboxItem {
    const id = `${a.serverId}:${a.sessionId}:rv${fnv1a(a.key)}`;
    this.seenKeys.add(id);
    const item: HeraldInboxItem = {
      id,
      serverId: a.serverId,
      sessionId: a.sessionId,
      sessionName: a.sessionName,
      priority: 'finished',
      headline: clip(oneLine(a.headline), 200),
      createdAt: a.createdAt,
      heard: this.heard.has(id),
      review: {
        level: a.level,
        kinds: a.kinds.slice(0, 8).map((k) => clip(k, 40)),
        paths: a.paths.slice(0, 8).map((p) => clip(p, 300)),
      },
    };
    this.items.set(id, item);
    this.prune(a.createdAt);
    return { ...item };
  }

  /**
   * Stuck sessions (stuck detection): the detector's whole current list. One
   * item per session, keyed by session + turn, so an update (a higher count, a
   * different signal) changes it in place and tones at most once per turn.
   * Returns true when the visible inbox changed.
   */
  setStuckAlerts(
    alerts: Array<{
      key: string;
      serverId: string;
      sessionId: string;
      sessionName: string;
      headline: string;
      summary: string;
      kind: string;
      kinds: string[];
      findingId: string;
      count: number;
    }>,
    now: number
  ): boolean {
    const before = JSON.stringify(this.list().filter((i) => i.stuck));
    const keep = new Set<string>();
    for (const a of alerts.slice(0, 20)) {
      const id = `${a.serverId}:${a.sessionId}:st${fnv1a(a.key)}`;
      keep.add(id);
      const prev = this.items.get(id);
      this.seenKeys.add(id);
      this.items.set(id, {
        id,
        serverId: a.serverId,
        sessionId: a.sessionId,
        sessionName: a.sessionName,
        priority: 'finished',
        headline: clip(oneLine(a.headline), 200),
        createdAt: prev?.createdAt ?? now,
        heard: prev?.heard ?? this.heard.has(id),
        stuck: {
          kind: clip(a.kind, 40),
          kinds: a.kinds.slice(0, 5).map((k) => clip(k, 40)),
          findingId: clip(a.findingId, 600),
          summary: clip(oneLine(a.summary), 240),
          count: Math.max(0, Math.round(a.count) || 0),
        },
      });
    }
    for (const [id, item] of this.items) if (item.stuck && !keep.has(id)) this.items.delete(id);
    this.prune(now);
    return JSON.stringify(this.list().filter((i) => i.stuck)) !== before;
  }

  /**
   * Pairing requests waiting for approval (the pairing manager's whole pending
   * list): one blocked item each, removed as soon as a request is approved,
   * denied or expires. Returns true when the visible inbox changed.
   */
  setPairingRequests(pending: PendingPairingInfo[], now: number): boolean {
    const before = JSON.stringify(this.list().filter((i) => i.pairing));
    const keep = new Set<string>();
    for (const p of pending.slice(0, 10)) {
      if (p.expiresAt <= now) continue;
      const id = `local:pair:${p.pairingId}`;
      keep.add(id);
      const prev = this.items.get(id);
      const deviceName = clip(oneLine(p.deviceName), 60) || 'A new device';
      this.seenKeys.add(id);
      this.items.set(id, {
        id,
        serverId: 'local',
        sessionId: `pair:${p.pairingId}`,
        sessionName: deviceName,
        priority: 'blocked',
        headline: `${deviceName} wants to pair, code ${p.code}`,
        createdAt: prev?.createdAt ?? now,
        heard: prev?.heard ?? this.heard.has(id),
        pairing: {
          pairingId: p.pairingId,
          deviceName,
          platform: clip(p.platform, 20),
          code: p.code,
          expiresAt: p.expiresAt,
        },
      });
    }
    for (const [id, item] of this.items) if (item.pairing && !keep.has(id)) this.items.delete(id);
    return JSON.stringify(this.list().filter((i) => i.pairing)) !== before;
  }

  /** The user reviewed the session: its risk alerts are done. */
  resolveReviewAlerts(sessionKey: string): boolean {
    let changed = false;
    for (const [id, item] of this.items) {
      if (item.review && `${item.serverId}:${item.sessionId}` === sessionKey) {
        this.items.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  /** Review alerts restored after a restart. */
  restoreReviewAlerts(items: HeraldInboxItem[], now: number): void {
    for (const i of items) {
      if (!i.review || now - i.createdAt > FINISHED_TTL_MS) continue;
      this.seenKeys.add(i.id);
      this.items.set(i.id, { ...i, heard: i.heard || this.heard.has(i.id) });
    }
    this.prune(now);
  }

  /** Review alert items (persisted). */
  reviewAlerts(): HeraldInboxItem[] {
    return this.list().filter((i) => i.review);
  }

  /** Answers restored after a restart (unheard ones are still news). */
  restoreAnswers(items: HeraldInboxItem[], now: number): void {
    for (const i of items) {
      if (!i.answer || now - i.createdAt > FINISHED_TTL_MS) continue;
      this.seenKeys.add(i.id);
      this.items.set(i.id, { ...i, heard: i.heard || this.heard.has(i.id) });
    }
    this.prune(now);
  }

  /** Answer items (persisted so "brief me" still has them after a restart). */
  answers(): HeraldInboxItem[] {
    return this.list().filter((i) => i.answer);
  }

  private prune(now: number): void {
    for (const [id, item] of this.items) {
      if ((item.priority !== 'blocked' || item.answer) && now - item.createdAt > FINISHED_TTL_MS)
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
