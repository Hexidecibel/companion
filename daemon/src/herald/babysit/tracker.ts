/**
 * Session babysitter, the deterministic half: from session snapshots and the
 * briefs, which babysat session has a NEW prompt Herald may look at.
 *
 *   settling  -> deciding   the same prompt was there on a later poll, at least
 *                           `settleMs` after it was first seen
 *   deciding  -> answered   Herald sent an answer (the "is asking" item never shows)
 *             -> escalated  brought to the user (the item shows at once)
 *             -> ignored    the prompt went away / the user got there first
 *
 * A prompt is identified per occurrence: a choice box by its signature plus the
 * turn it belongs to (the boxes of a multi-question prompt share a turn), a
 * turn that ended in plain text by the turn alone. Never a prompt:
 *   - a permission box (a pending tool approval, or a box that reads as one)
 *   - whatever was on screen when the brief started (the user saw that one)
 *   - a session the user has an open ask with (their exchange, not ours)
 * A multi-select box is reported so it can be escalated; it is never answered.
 *
 * Synchronous and free of I/O; the manager does the asking and the sending.
 */

import { mapPermissionLabel, parsePermissionPrompt } from '../../parser';
import type { HeraldBabysit, HeraldBabysitEndReason } from '../protocol';
import type { PendingChoice, SessionSnapshot } from '../session-source';
import { clipTail, fnv1a, oneLine } from '../text';
import {
  BABYSIT_ENDED_KEEP_MS,
  BABYSIT_LIMITS,
  BABYSIT_MAX_HANDLED,
  cloneBrief,
  cloneRecord,
  sessionKeyOf,
  type BabysitRecord,
} from './types';

/** A choice box must be unchanged this long (and seen on two polls) before it is decided. */
export const SETTLE_CHOICE_MS = 3000;
/** Longer for a turn that ended in text: a status flicker between tool calls looks the same. */
export const SETTLE_TEXT_MS = 6000;
/** The "is asking" inbox item is held back at most this long while a decision is pending. */
export const HOLD_MAX_MS = 20_000;
/** After an answer, the item stays hidden this long (the box takes a moment to go away). */
export const ANSWERED_SUPPRESS_MS = 45_000;
/**
 * "Session gone" is never decided from one listing, nor from a few fast ones:
 * the session must be absent (or listed as closed) on at least MISSING_POLLS
 * SUCCESSFUL listings spread over GONE_AFTER_MS of wall clock, and even then
 * the tracker only reports a `gone` candidate. The manager ends the brief once
 * the strict existence check says the session is really gone; while it still
 * exists the candidate is raised again every GONE_RECHECK_MS.
 * (The watcher's listing has shown live sessions as closed for a moment while
 * it rebuilt its tmux maps; that ended real briefs minutes after they started.)
 */
export const MISSING_POLLS = 5;
export const GONE_AFTER_MS = 60_000;
export const GONE_RECHECK_MS = 30_000;
const QUESTION_CHARS = 600;

export interface BabysitPrompt {
  /** Per-occurrence identity (see the header). */
  key: string;
  kind: 'choice' | 'text';
  /** What the session is asking: the box's question, or the end of its last message. */
  question: string;
  header?: string;
  options?: PendingChoice['options'];
  signature?: string;
  turnKey: string | null;
  multiSelect: boolean;
  /** Identity of the question's content, across turns (loop detection). */
  hash: string;
}

export type PromptSkip = 'closed' | 'approval' | 'permission' | 'working' | 'none';

const PERMISSION_LABEL = /don'?t ask again|allow all|always allow|\byes, allow\b|\bi accept\b|\btrust (?:this|the) (?:folder|files)\b/i;
const PERMISSION_QUESTION =
  /^\s*do you want to\b|\b(?:allow|grant|approve) (?:this|the|claude)\b|\bpermission to\b|\bbypass permissions?\b|\btrust (?:this|the) (?:folder|files)\b/i;

/**
 * A choice box that is Claude Code asking for permission (run this command,
 * make this edit, trust this folder), not the session asking a question.
 * Errs toward "permission": those are never the babysitter's to answer.
 */
export function isPermissionChoice(c: PendingChoice): boolean {
  const question = oneLine([c.header, c.question].filter(Boolean).join(' '));
  if (PERMISSION_QUESTION.test(question)) return true;
  if (c.options.some((o) => PERMISSION_LABEL.test(o.label) || PERMISSION_LABEL.test(mapPermissionLabel(o.label))))
    return true;
  const rendered = `${c.question}\n${c.options.map((o, i) => `${i + 1}. ${o.label}`).join('\n')}`;
  return parsePermissionPrompt(rendered) !== null;
}

/** The end of the session's last message: where a question, if any, is. */
export function questionTail(text: string): string {
  const paragraphs = text
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  let tail = paragraphs[paragraphs.length - 1] || '';
  // A one-line ending ("Want me to continue?") reads better with what it follows.
  if (tail.length < 80 && paragraphs.length > 1) tail = `${paragraphs[paragraphs.length - 2]}\n${tail}`;
  return clipTail(tail, QUESTION_CHARS);
}

/** The prompt a session is stopped on, or why it has none the babysitter may touch. */
export function promptOf(s: SessionSnapshot): { prompt: BabysitPrompt } | { skip: PromptSkip } {
  if (s.inactive) return { skip: 'closed' };
  // A pending tool approval is a permission prompt, whatever the pane parsed as.
  if (s.pendingApproval) return { skip: 'approval' };
  const c = s.pendingChoice;
  if (c) {
    if (isPermissionChoice(c)) return { skip: 'permission' };
    return {
      prompt: {
        key: `c:${c.signature}:${fnv1a(s.lastTurnKey || '')}`,
        kind: 'choice',
        question: oneLine(c.question || ''),
        ...(c.header ? { header: oneLine(c.header) } : {}),
        options: c.options.map((o) => ({ ...o })),
        signature: c.signature,
        turnKey: s.lastTurnKey,
        multiSelect: c.multiSelect,
        hash: `c${c.signature}`,
      },
    };
  }
  if (s.status === 'working') return { skip: 'working' };
  const said = (s.lastTurnGist || '').trim();
  if (!s.lastTurnKey || !said) return { skip: 'none' };
  return {
    prompt: {
      key: `t:${fnv1a(s.lastTurnKey)}`,
      kind: 'text',
      question: questionTail(said),
      turnKey: s.lastTurnKey,
      multiSelect: false,
      hash: `t${fnv1a(oneLine(said).toLowerCase())}`,
    },
  };
}

export type BabysitPhase = 'settling' | 'deciding' | 'answered' | 'escalated' | 'ignored';

interface Watch {
  key: string;
  firstSeen: number;
  phase: BabysitPhase;
  /** When the phase was entered. */
  at: number;
}

export type BabysitEvent =
  | { type: 'prompt'; record: BabysitRecord; snap: SessionSnapshot; prompt: BabysitPrompt }
  | { type: 'end'; record: BabysitRecord; reason: HeraldBabysitEndReason }
  /** The session has been missing for a while: confirm it is gone before ending. */
  | { type: 'gone'; record: BabysitRecord };

export interface TrackerContext {
  /** The user has an open ask with this session (ask-and-report). */
  hasOpenAsk(sessionKey: string): boolean;
  settleMs?: { choice: number; text: number };
  /**
   * False when that server's listing failed (or is incomplete) this round: its
   * sessions are then neither looked at nor counted as missing.
   */
  listingOk?(serverId: string): boolean;
}

interface Missing {
  /** First successful listing without the session. */
  since: number;
  polls: number;
  /** When a `gone` candidate was last raised (0 = never). */
  raisedAt: number;
}

export class BabysitTracker {
  /** One record per session: its active brief, or the one that ended last. */
  private records = new Map<string, BabysitRecord>();
  private watch = new Map<string, Watch>();
  private missing = new Map<string, Missing>();

  constructor(initial: BabysitRecord[] = []) {
    this.load(initial);
  }

  load(records: BabysitRecord[]): void {
    for (const r of records) this.records.set(sessionKeyOf(r.brief), cloneRecord(r));
  }

  /** The live record (mutable: the manager updates counters and the log through it). */
  get(sessionKey: string): BabysitRecord | null {
    return this.records.get(sessionKey) ?? null;
  }

  active(sessionKey: string): BabysitRecord | null {
    const r = this.records.get(sessionKey);
    return r && r.brief.status === 'active' ? r : null;
  }

  byId(id: string): BabysitRecord | null {
    for (const r of this.records.values()) if (r.brief.id === id) return r;
    return null;
  }

  activeCount(): number {
    let n = 0;
    for (const r of this.records.values()) if (r.brief.status === 'active') n++;
    return n;
  }

  /** Active briefs first (oldest first), then the recently ended. */
  list(): HeraldBabysit[] {
    return Array.from(this.records.values())
      .map((r) => cloneBrief(r.brief))
      .sort(
        (a, b) =>
          Number(a.status === 'ended') - Number(b.status === 'ended') || a.createdAt - b.createdAt
      );
  }

  persisted(): BabysitRecord[] {
    return Array.from(this.records.values()).map(cloneRecord);
  }

  /** Session ids (per server) with an active brief: their panes are always captured. */
  activeSessionIds(serverId: string): string[] {
    return Array.from(this.records.values())
      .filter((r) => r.brief.status === 'active' && r.brief.serverId === serverId)
      .map((r) => r.brief.sessionId);
  }

  /** Start a brief (replacing the session's previous one). `snap`: the session right now. */
  start(brief: HeraldBabysit, snap: SessionSnapshot | null): BabysitRecord {
    const key = sessionKeyOf(brief);
    const now = snap ? promptOf(snap) : null;
    const rec: BabysitRecord = {
      brief: cloneBrief(brief),
      baselineKey: now && 'prompt' in now ? now.prompt.key : null,
      handled: [],
      answered: [],
      lastAnswer: null,
    };
    this.records.set(key, rec);
    this.watch.delete(key);
    this.missing.delete(key);
    return rec;
  }

  end(sessionKey: string, reason: HeraldBabysitEndReason, now: number): BabysitRecord | null {
    const rec = this.active(sessionKey);
    if (!rec) return null;
    rec.brief.status = 'ended';
    rec.brief.endReason = reason;
    rec.brief.endedAt = now;
    // The answer that reached the cap was still sent: its "is asking" item
    // stays hidden for the usual window, although the brief is over.
    if (this.watch.get(sessionKey)?.phase !== 'answered') this.watch.delete(sessionKey);
    this.missing.delete(sessionKey);
    return rec;
  }

  /** Is the session still unseen since a `gone` candidate was raised for it? */
  stillMissing(sessionKey: string): boolean {
    return this.missing.has(sessionKey);
  }

  /** The decision for a prompt is in: it is never looked at again. */
  resolve(sessionKey: string, key: string, phase: 'answered' | 'escalated' | 'ignored', now: number): void {
    const rec = this.records.get(sessionKey);
    if (rec && !rec.handled.includes(key)) {
      rec.handled.push(key);
      if (rec.handled.length > BABYSIT_MAX_HANDLED)
        rec.handled.splice(0, rec.handled.length - BABYSIT_MAX_HANDLED);
    }
    const w = this.watch.get(sessionKey);
    if (w && w.key === key) {
      w.phase = phase;
      w.at = now;
    }
  }

  /** Is `key` the prompt being decided for that session right now? */
  deciding(sessionKey: string, key: string): boolean {
    const w = this.watch.get(sessionKey);
    return !!w && w.key === key && w.phase === 'deciding';
  }

  /**
   * Apply a fresh listing. Returns the prompts that just became ready to
   * decide, the briefs that ended by themselves (time limit; already marked)
   * and the briefs whose session looks gone (`gone`: NOT ended, see above).
   */
  update(snaps: SessionSnapshot[], now: number, ctx: TrackerContext): BabysitEvent[] {
    const out: BabysitEvent[] = [];
    const bySession = new Map(snaps.map((s) => [sessionKeyOf(s), s] as const));
    for (const [key, rec] of Array.from(this.records.entries())) {
      const b = rec.brief;
      if (b.status !== 'active') {
        const left = this.watch.get(key);
        if (left && now - left.at >= ANSWERED_SUPPRESS_MS) this.watch.delete(key);
        if (now - (b.endedAt ?? b.expiresAt) > BABYSIT_ENDED_KEEP_MS) {
          this.records.delete(key);
          this.watch.delete(key);
        }
        continue;
      }
      if (now >= b.expiresAt) {
        this.end(key, 'expired', now);
        out.push({ type: 'end', record: rec, reason: 'expired' });
        continue;
      }
      // A listing that failed says nothing about this session.
      if (ctx.listingOk && !ctx.listingOk(b.serverId)) continue;
      const s = bySession.get(key);
      if (!s || s.inactive) {
        // Absent or "closed" in one listing is not a closed session (a listing
        // can lag or be caught half-built): only a sustained absence is worth
        // checking, and the check, not the listing, ends the brief.
        const m = this.missing.get(key) ?? { since: now, polls: 0, raisedAt: 0 };
        m.polls += 1;
        this.missing.set(key, m);
        if (
          m.polls >= MISSING_POLLS &&
          now - m.since >= GONE_AFTER_MS &&
          (m.raisedAt === 0 || now - m.raisedAt >= GONE_RECHECK_MS)
        ) {
          m.raisedAt = now;
          out.push({ type: 'gone', record: rec });
        }
        continue;
      }
      this.missing.delete(key);
      if (s.sessionName && s.sessionName !== b.sessionName) b.sessionName = s.sessionName;

      const p = promptOf(s);
      const w = this.watch.get(key);
      if (!('prompt' in p)) {
        // Nothing to answer (working, a permission box, ...): forget what was
        // settling. A decision in flight finishes by itself and finds it stale.
        if (w && w.phase !== 'deciding') this.watch.delete(key);
        continue;
      }
      const prompt = p.prompt;
      if (prompt.key === rec.baselineKey || rec.handled.includes(prompt.key)) {
        if (w && w.key !== prompt.key) this.watch.delete(key);
        continue;
      }
      if (ctx.hasOpenAsk(key)) {
        if (w && w.phase !== 'deciding') this.watch.delete(key);
        continue;
      }
      if (!w || w.key !== prompt.key) {
        this.watch.set(key, { key: prompt.key, firstSeen: now, phase: 'settling', at: now });
        continue;
      }
      if (w.phase !== 'settling') continue;
      const settle = prompt.kind === 'choice'
        ? ctx.settleMs?.choice ?? SETTLE_CHOICE_MS
        : ctx.settleMs?.text ?? SETTLE_TEXT_MS;
      if (now - w.firstSeen < settle) continue;
      w.phase = 'deciding';
      w.at = now;
      out.push({ type: 'prompt', record: rec, snap: s, prompt });
    }
    return out;
  }

  /**
   * Inbox hook: what to do with a babysat session's "is asking" / "finished"
   * item right now. `hold` = not yet (a decision is pending), `suppress` =
   * never (Herald answered it), null = show it as usual.
   */
  inboxHold(s: SessionSnapshot, now: number): 'hold' | 'suppress' | null {
    const key = sessionKeyOf(s);
    const w = this.watch.get(key);
    if (!w) return null;
    // An ended brief hides nothing, except the question its last answer went to.
    if (!this.active(key) && w.phase !== 'answered') return null;
    const p = promptOf(s);
    if (!('prompt' in p) || p.prompt.key !== w.key) return null;
    if (w.phase === 'settling' || w.phase === 'deciding')
      return now - w.firstSeen < HOLD_MAX_MS ? 'hold' : null;
    if (w.phase === 'answered') return now - w.at < ANSWERED_SUPPRESS_MS ? 'suppress' : null;
    return null;
  }
}

export { BABYSIT_LIMITS };
