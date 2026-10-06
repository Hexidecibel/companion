/**
 * Session babysitter: briefs, decisions and sends.
 *
 *   observe(snapshots)  -> tracker: which babysat session has a settled, new prompt
 *     -> decide (one metered model call + guards in code, see decider.ts)
 *        answer    re-validate against the LIVE session, send, log a quiet line
 *        escalate  the normal "is asking" inbox item, plus a card with the
 *                  suggested answer when there is one (Send / Cancel, no countdown)
 *        done      the brief ends and the user is told
 *
 * Fail closed everywhere: a pane that cannot be read, a prompt that changed, a
 * session the user is already handling, a send that fails, any error: nothing
 * is typed and the question is left to the user. Never answers permission
 * prompts (the tracker never reports them). Does not take Herald's turn lock:
 * a decision runs beside a conversation turn, and only spoken lines wait for it.
 */

import { randomUUID } from 'crypto';
import {
  HERALD_BABYSIT_LIMITS as LIMITS,
  type HeraldAction,
  type HeraldActionTier,
  type HeraldBabysit,
  type HeraldBabysitEndReason,
  type HeraldBabysitErrorCode,
  type HeraldBabysitLogEntry,
  type HeraldSessionRef,
} from '../protocol';
import type { SessionSnapshot, SessionSource } from '../session-source';
import { withTimeout } from '../actions';
import type { ChoiceMeta } from '../actions';
import { clip, oneLine } from '../text';
import type { BabysitAnswer, BabysitDecideInput, BabysitVerdict } from './decider';
import { BabysitTracker, promptOf, type BabysitPrompt } from './tracker';
import { cloneBrief, sessionKeyOf, type BabysitRecord } from './types';

const REVALIDATE_TIMEOUT_MS = 8000;
const SEND_TIMEOUT_MS = 20_000;
/** Typed answers say who answered, so the transcript never passes Herald off as the user. */
export const BABYSIT_PREFIX = '[Herald for you]';

export class BabysitError extends Error {
  constructor(
    readonly code: HeraldBabysitErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'BabysitError';
  }
}

/** A validated request to start (or edit) a brief. */
export interface BabysitSpec {
  serverId: string;
  sessionId: string;
  goal: string;
  direction?: string;
  never?: string;
  minutes: number;
  maxAnswers: number;
}

/**
 * Validate an untrusted brief (the WS request, the brain's propose_babysit).
 * Text is trimmed and bounded; numbers are clamped to the limits. Throws a
 * BabysitError('bad_request') naming the field.
 */
export function parseBabysitSpec(raw: unknown): BabysitSpec {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const text = (v: unknown, name: string, max: number): string => {
    if (v === undefined || v === null) return '';
    if (typeof v !== 'string') throw new BabysitError('bad_request', `${name} must be text`);
    // eslint-disable-next-line no-control-regex
    const t = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
    if (t.length > max) throw new BabysitError('bad_request', `${name} is too long (max ${max} characters)`);
    return t;
  };
  const num = (v: unknown, name: string, def: number, min: number, max: number): number => {
    if (v === undefined || v === null) return def;
    if (typeof v !== 'number' || !Number.isFinite(v))
      throw new BabysitError('bad_request', `${name} must be a number`);
    return Math.min(max, Math.max(min, Math.round(v)));
  };
  const sessionId = text(r.sessionId, 'sessionId', 200);
  if (!sessionId) throw new BabysitError('bad_request', 'sessionId is required');
  const goal = text(r.goal, 'goal', LIMITS.maxGoalChars);
  if (goal.length < LIMITS.minGoalChars) throw new BabysitError('bad_request', 'goal is required');
  const direction = text(r.direction, 'direction', LIMITS.maxDirectionChars);
  const never = text(r.never, 'never', LIMITS.maxNeverChars);
  return {
    serverId: text(r.serverId, 'serverId', 80) || 'local',
    sessionId,
    goal,
    ...(direction ? { direction } : {}),
    ...(never ? { never } : {}),
    minutes: num(r.minutes, 'minutes', LIMITS.defaultMinutes, LIMITS.minMinutes, LIMITS.maxMinutes),
    maxAnswers: num(r.maxAnswers, 'maxAnswers', LIMITS.defaultMaxAnswers, 1, LIMITS.maxMaxAnswers),
  };
}

export interface BabysitPost {
  text: string;
  ref: HeraldSessionRef;
  /** Tone + screen only, never spoken unasked. */
  quiet: boolean;
  actionIds?: string[];
}

export interface BabysitManagerDeps {
  getSource(serverId: string): SessionSource | null;
  now(): number;
  /** The metered, gated model call plus its guards (decider.ts). Must not throw. */
  decide(input: BabysitDecideInput): Promise<BabysitVerdict>;
  /** The user has an open ask with this session. */
  hasOpenAsk(sessionKey: string): boolean;
  /** The user has their own pending card for this session (not one of our suggestions). */
  hasUserAction(sessionKey: string): boolean;
  /** The user is in a voice exchange right now (the "goal done" line may be spoken). */
  voiceActive(): boolean;
  /** A brain turn is streaming: a spoken line now would cut its reply off. */
  busy(): boolean;
  post(p: BabysitPost): void;
  /** Put up a suggested-answer card (never auto-sends). Null = could not. */
  suggest(p: {
    tier: HeraldActionTier;
    reasons: string[];
    ruleIds: string[];
    kind: 'send_input' | 'answer_choice';
    session: HeraldSessionRef;
    payload: string;
    readback: string;
    choice?: ChoiceMeta;
    babysitId: string;
    why: string;
  }): HeraldAction | null;
  cancelAction(actionId: string): void;
  audit(action: string, payload: Record<string, unknown>, result: Record<string, unknown>, startedAt: number): void;
  /** Briefs changed: tell clients, refresh the inbox tally, persist. */
  changed(): void;
  /** Poll soon (an escalated question should show at once). */
  kick(): void;
  /** False = suggest only (the sandbox reads real sessions; it must never type into them). */
  autoSend: boolean;
  settleMs?: { choice: number; text: number };
  log?(line: string): void;
}

const END_TEXT: Record<HeraldBabysitEndReason, string> = {
  stopped: 'stopped',
  expired: 'time limit reached',
  max_answers: 'answer limit reached',
  session_gone: 'the session closed',
  done: 'goal finished',
  loop: 'it kept asking the same thing',
};

export function babysitEndText(reason: HeraldBabysitEndReason | undefined): string {
  return END_TEXT[reason ?? 'stopped'];
}

const norm = (s: string) => oneLine(s).toLowerCase();
const refOf = (b: HeraldBabysit): HeraldSessionRef => ({
  serverId: b.serverId,
  sessionId: b.sessionId,
  sessionName: b.sessionName,
});
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export class BabysitManager {
  readonly tracker: BabysitTracker;
  private deps: BabysitManagerDeps;
  private inFlight = new Set<Promise<void>>();
  /** Spoken lines waiting for the brain turn to end. */
  private queue: BabysitPost[] = [];
  /** Our suggested-answer card per session, and the prompt it answers. */
  private suggestions = new Map<string, { actionId: string; key: string; question: string }>();

  constructor(deps: BabysitManagerDeps, initial: BabysitRecord[] = []) {
    this.deps = deps;
    this.tracker = new BabysitTracker(initial);
  }

  load(records: BabysitRecord[]): void {
    this.tracker.load(records);
  }

  list(): HeraldBabysit[] {
    return this.tracker.list().map((b) => this.view(b));
  }

  /** A brief as clients see it (a copy; says so when this daemon only suggests). */
  private view(b: HeraldBabysit): HeraldBabysit {
    return this.deps.autoSend ? cloneBrief(b) : { ...cloneBrief(b), autoSend: false };
  }

  persisted(): BabysitRecord[] {
    return this.tracker.persisted();
  }

  /** Sessions whose pane must always be captured. */
  pinned(serverId: string): string[] {
    return this.tracker.activeSessionIds(serverId);
  }

  inboxHold(s: SessionSnapshot): 'hold' | 'suppress' | null {
    return this.tracker.inboxHold(s, this.deps.now());
  }

  // ---------------------------------------------------------------- briefs

  /**
   * Start babysitting `snap`'s session, or edit its active brief in place (same
   * id, counters and log kept; the time limit restarts).
   */
  set(spec: BabysitSpec, snap: SessionSnapshot): HeraldBabysit {
    const now = this.deps.now();
    const key = sessionKeyOf(snap);
    const fields = {
      goal: spec.goal,
      expiresAt: now + spec.minutes * 60_000,
      minutes: spec.minutes,
      maxAnswers: spec.maxAnswers,
    };
    const existing = this.tracker.active(key);
    let rec: BabysitRecord;
    if (existing) {
      rec = existing;
      Object.assign(rec.brief, fields, { sessionName: snap.sessionName });
      if (spec.direction) rec.brief.direction = spec.direction;
      else delete rec.brief.direction;
      if (spec.never) rec.brief.never = spec.never;
      else delete rec.brief.never;
      // An edit may lower the cap below what was already sent.
      if (rec.brief.answersUsed >= rec.brief.maxAnswers) {
        this.finish(rec, 'max_answers');
        this.deps.changed();
        return this.view(rec.brief);
      }
    } else {
      if (this.tracker.activeCount() >= LIMITS.maxActive)
        throw new BabysitError(
          'limit',
          `Already babysitting ${LIMITS.maxActive} sessions; stop one first.`
        );
      rec = this.tracker.start(
        {
          id: randomUUID(),
          serverId: snap.serverId,
          sessionId: snap.sessionId,
          sessionName: snap.sessionName,
          ...fields,
          ...(spec.direction ? { direction: spec.direction } : {}),
          ...(spec.never ? { never: spec.never } : {}),
          createdAt: now,
          answersUsed: 0,
          escalations: 0,
          status: 'active',
          log: [],
        },
        snap
      );
    }
    this.deps.log?.(
      `Herald: babysitting ${rec.brief.sessionName} ${existing ? 'updated' : 'started'} ` +
        `(${spec.minutes} min, up to ${spec.maxAnswers} answers${this.deps.autoSend ? '' : ', suggest only'})`
    );
    this.deps.changed();
    return this.view(rec.brief);
  }

  /** Stop one brief (by id or session), or every active one. Returns what was stopped. */
  stop(which: { babysitId?: string; sessionKey?: string } = {}): HeraldBabysit[] {
    const targets: BabysitRecord[] = [];
    if (which.babysitId) {
      const r = this.tracker.byId(which.babysitId);
      if (r && r.brief.status === 'active') targets.push(r);
    } else if (which.sessionKey) {
      const r = this.tracker.active(which.sessionKey);
      if (r) targets.push(r);
    } else {
      for (const b of this.tracker.list()) {
        const r = b.status === 'active' ? this.tracker.active(sessionKeyOf(b)) : null;
        if (r) targets.push(r);
      }
    }
    for (const r of targets) this.finish(r, 'stopped', false);
    if (targets.length) this.deps.changed();
    return targets.map((r) => this.view(r.brief));
  }

  // ---------------------------------------------------------------- observing

  /** Feed a fresh listing (from the poll loop, BEFORE the inbox). Decisions run in the background. */
  observe(snaps: SessionSnapshot[]): void {
    const now = this.deps.now();
    const events = this.tracker.update(snaps, now, {
      hasOpenAsk: (k) => this.deps.hasOpenAsk(k),
      settleMs: this.deps.settleMs,
    });
    // A suggestion whose question went away is stale: take the card down.
    if (this.suggestions.size) {
      const bySession = new Map(snaps.map((s) => [sessionKeyOf(s), s] as const));
      for (const [key, sug] of Array.from(this.suggestions.entries())) {
        const s = bySession.get(key);
        const p = s ? promptOf(s) : null;
        if (!this.tracker.active(key) || !p || !('prompt' in p) || p.prompt.key !== sug.key) {
          this.suggestions.delete(key);
          this.deps.cancelAction(sug.actionId);
        }
      }
    }
    let changed = false;
    for (const e of events) {
      if (e.type === 'end') {
        // The tracker already marked it; announce and clean up.
        this.announceEnd(e.record, e.reason, true);
        changed = true;
        continue;
      }
      const p = this.handle(e.record, e.snap, e.prompt).finally(() => this.inFlight.delete(p));
      this.inFlight.add(p);
    }
    if (changed) this.deps.changed();
  }

  /** The user sent our suggested answer (ActionManager's onSent). */
  onSuggestionSent(a: HeraldAction): void {
    const key = sessionKeyOf(a);
    const sug = this.suggestions.get(key);
    if (!sug || sug.actionId !== a.id) return;
    this.suggestions.delete(key);
    const rec = this.tracker.active(key);
    if (!rec) return;
    this.pushLog(rec, { at: this.deps.now(), question: sug.question, answer: clip(oneLine(a.payload), 400), kind: 'user' });
    this.deps.changed();
  }

  /** The brain turn ended: post what waited for it. */
  flush(): void {
    for (const p of this.queue.splice(0)) this.deps.post(p);
  }

  /** Tests: wait for decisions in flight. */
  async settle(): Promise<void> {
    while (this.inFlight.size) await Promise.all(Array.from(this.inFlight));
  }

  // ---------------------------------------------------------------- deciding

  private current(rec: BabysitRecord, prompt: BabysitPrompt): boolean {
    const key = sessionKeyOf(rec.brief);
    return this.tracker.active(key) === rec && this.tracker.deciding(key, prompt.key);
  }

  private async handle(rec: BabysitRecord, snap: SessionSnapshot, prompt: BabysitPrompt): Promise<void> {
    const key = sessionKeyOf(rec.brief);
    try {
      if (prompt.multiSelect) {
        this.escalate(rec, prompt, {
          kind: 'escalate',
          why: 'multi_select',
          reason: 'It is a multi-select question; answer it in the app.',
          tier: 'echo',
          reasons: [],
          ruleIds: [],
        });
        return;
      }
      const src = this.deps.getSource(rec.brief.serverId);
      let lastUserPrompt: string | null = null;
      let latest = snap.lastTurnGist;
      if (src) {
        try {
          const t = await withTimeout(src.getRecentTranscript(rec.brief.sessionId, 1), REVALIDATE_TIMEOUT_MS, 'transcript');
          lastUserPrompt = t.lastUserPrompt?.text ?? null;
          if (!latest) latest = t.assistantTurns[t.assistantTurns.length - 1]?.text ?? null;
        } catch {
          /* context only: the decision still has the question itself */
        }
      }
      const verdict = await this.deps.decide({
        brief: rec.brief,
        prompt,
        sessionName: rec.brief.sessionName,
        projectPath: snap.projectPath,
        lastUserPrompt,
        latest,
      });
      // Stopped, replaced, or the prompt moved on while the model was thinking.
      if (!this.current(rec, prompt)) {
        this.tracker.resolve(key, prompt.key, 'ignored', this.deps.now());
        return;
      }
      if (verdict.kind === 'done') {
        this.pushLog(rec, { at: this.deps.now(), question: prompt.question, answer: '', kind: 'done', reason: verdict.reason });
        this.tracker.resolve(key, prompt.key, 'escalated', this.deps.now());
        this.finish(rec, 'done', true, verdict.reason);
        this.deps.changed();
        this.deps.kick();
        return;
      }
      if (verdict.kind === 'escalate') {
        this.escalate(rec, prompt, verdict);
        return;
      }
      // Answering: a question that comes straight back, or the same answer
      // twice running, means the answers are not moving it on.
      const answerKey = norm(verdict.answer.label);
      if (rec.answered.includes(prompt.hash) || (!verdict.continueCase && rec.lastAnswer === answerKey)) {
        this.tracker.resolve(key, prompt.key, 'escalated', this.deps.now());
        this.finish(rec, 'loop');
        this.deps.changed();
        this.deps.kick();
        return;
      }
      if (!this.deps.autoSend) {
        this.escalate(rec, prompt, {
          kind: 'escalate',
          why: 'suggest_only',
          reason: 'This copy of Herald only suggests answers; it never sends them itself.',
          suggestion: verdict.answer,
          tier: 'echo',
          reasons: [],
          ruleIds: [],
        });
        return;
      }
      await this.send(rec, prompt, verdict);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log?.(`Herald: babysitting ${rec.brief.sessionName}: decision failed (${message}); left for the user`);
      if (this.current(rec, prompt)) {
        this.escalate(rec, prompt, {
          kind: 'escalate',
          why: 'error',
          reason: 'Something went wrong on my end, so I left it for you.',
          tier: 'echo',
          reasons: [],
          ruleIds: [],
        });
      } else {
        this.tracker.resolve(key, prompt.key, 'ignored', this.deps.now());
      }
    }
  }

  /**
   * Type the answer, after re-checking the LIVE session: it must still exist,
   * still show exactly this prompt, and the user must not be handling it.
   * Anything else sends nothing.
   */
  private async send(
    rec: BabysitRecord,
    prompt: BabysitPrompt,
    verdict: Extract<BabysitVerdict, { kind: 'answer' }>
  ): Promise<void> {
    const b = rec.brief;
    const key = sessionKeyOf(b);
    const started = this.deps.now();
    const dropped = (why: string) => {
      this.deps.log?.(`Herald: babysitting ${b.sessionName}: nothing sent (${why})`);
      this.tracker.resolve(key, prompt.key, 'ignored', this.deps.now());
      this.deps.kick();
    };
    const failed = (reason: string) =>
      this.escalate(rec, prompt, {
        kind: 'escalate',
        why: 'send_failed',
        reason,
        suggestion: verdict.answer,
        tier: 'echo',
        reasons: [],
        ruleIds: [],
      });

    const src = this.deps.getSource(b.serverId);
    if (!src) return failed('I could not reach the session, so I left it for you.');
    let sendStarted = false;
    try {
      const exists = await withTimeout(src.sessionExists(b.sessionId), REVALIDATE_TIMEOUT_MS, 'session check');
      if (!exists) return dropped('the session is gone');
      // Strict read: an unreadable screen throws, and nothing is typed blind.
      const live = await withTimeout(src.getLiveChoice(b.sessionId), REVALIDATE_TIMEOUT_MS, 'prompt check');
      if (this.deps.hasOpenAsk(key) || this.deps.hasUserAction(key)) return dropped('the user is handling it');
      if (!this.current(rec, prompt)) return dropped('the brief or the prompt changed');
      const answer = verdict.answer;
      let ok: boolean;
      let sent: string;
      if (prompt.kind === 'choice') {
        const index = answer.optionIndex;
        if (!live || live.signature !== prompt.signature) return dropped('the question changed or was already answered');
        if (live.multiSelect || index === undefined || index < 0 || index >= live.options.length)
          return dropped('that option is no longer offered');
        sent = live.options[index].label;
        sendStarted = true;
        ok = await withTimeout(
          src.sendChoice(b.sessionId, index, live.options.length, false),
          SEND_TIMEOUT_MS,
          'send'
        );
      } else {
        // Typed text can never answer a choice box (it would land in the wrong place).
        if (live) return dropped('the session is now showing a choice prompt');
        const fresh = (await withTimeout(src.listSessions(), REVALIDATE_TIMEOUT_MS, 'status check')).find(
          (s) => s.sessionId === b.sessionId
        );
        if (
          !fresh ||
          fresh.inactive ||
          fresh.status === 'working' ||
          fresh.pendingApproval ||
          fresh.pendingChoice ||
          fresh.lastTurnKey !== prompt.turnKey
        )
          return dropped('the session moved on (someone answered, or it is working again)');
        sent = answer.text || '';
        if (!sent) return dropped('empty answer');
        sendStarted = true;
        ok = await withTimeout(
          src.sendText(b.sessionId, `${BABYSIT_PREFIX} ${sent}`, `herald-babysit-${b.id}`),
          SEND_TIMEOUT_MS,
          'send'
        );
      }
      if (!ok) return failed(`I could not deliver my answer to ${b.sessionName}, so I left it for you.`);

      const now = this.deps.now();
      b.answersUsed += 1;
      rec.answered.push(prompt.hash);
      if (rec.answered.length > 80) rec.answered.splice(0, rec.answered.length - 80);
      if (!verdict.continueCase) rec.lastAnswer = norm(answer.label);
      const shown = clip(oneLine(sent), 200);
      this.pushLog(rec, { at: now, question: prompt.question, answer: shown, kind: 'answered', reason: verdict.reason });
      this.tracker.resolve(key, prompt.key, 'answered', now);
      this.deps.audit(
        'herald_babysit_answer',
        {
          babysitId: b.id,
          session: b.sessionId,
          kind: prompt.kind,
          question: clip(oneLine(prompt.question), 300),
          answer: clip(shown, 300),
          basis: clip(verdict.basis, 200),
          answersUsed: b.answersUsed,
        },
        { ok: true },
        started
      );
      this.deps.log?.(
        `Herald: babysitting ${b.sessionName}: answered (${b.answersUsed}/${b.maxAnswers}, basis: ${clip(verdict.basis, 60)})`
      );
      this.emit({
        text: `${b.sessionName} asked: "${clip(oneLine(prompt.question), 160)}" I answered: "${clip(shown, 120)}".`,
        ref: refOf(b),
        quiet: true,
      });
      if (b.answersUsed >= b.maxAnswers) this.finish(rec, 'max_answers');
      this.deps.changed();
      this.deps.kick();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.audit(
        'herald_babysit_answer',
        { babysitId: b.id, session: b.sessionId, kind: prompt.kind },
        { ok: false, error: clip(message, 300) },
        started
      );
      // The keystrokes may still land after a send timeout: never offer a retry card.
      if (sendStarted) {
        this.escalate(rec, prompt, {
          kind: 'escalate',
          why: 'send_failed',
          reason: `My answer to ${b.sessionName} may or may not have been typed; check the session.`,
          tier: 'echo',
          reasons: [],
          ruleIds: [],
        });
      } else {
        failed(`I could not re-check ${b.sessionName}'s screen, so I left it for you.`);
      }
    }
  }

  /** Bring the question to the user: the inbox item shows now, plus a suggestion card if we have one. */
  private escalate(
    rec: BabysitRecord,
    prompt: BabysitPrompt,
    verdict: Extract<BabysitVerdict, { kind: 'escalate' }>
  ): void {
    const b = rec.brief;
    const key = sessionKeyOf(b);
    const now = this.deps.now();
    b.escalations += 1;
    this.tracker.resolve(key, prompt.key, 'escalated', now);
    const suggestion: BabysitAnswer | undefined = verdict.suggestion;
    let action: HeraldAction | null = null;
    if (suggestion && !this.deps.hasUserAction(key)) {
      try {
        action = this.suggestionCard(rec, prompt, suggestion, verdict);
      } catch (err) {
        this.deps.log?.(`Herald: babysitting ${b.sessionName}: suggestion card failed (${String(err)})`);
      }
    }
    this.pushLog(rec, {
      at: now,
      question: prompt.question,
      answer: suggestion ? clip(oneLine(suggestion.label), 200) : '',
      kind: 'escalated',
      reason: verdict.reason,
    });
    this.deps.audit(
      'herald_babysit_escalate',
      {
        babysitId: b.id,
        session: b.sessionId,
        why: verdict.why,
        question: clip(oneLine(prompt.question), 300),
        ...(suggestion ? { suggestion: clip(oneLine(suggestion.label), 300) } : {}),
        ...(action ? { actionId: action.id, tier: action.tier } : {}),
      },
      { ok: true },
      now
    );
    this.deps.log?.(`Herald: babysitting ${b.sessionName}: brought to the user (${verdict.why})`);
    if (action && suggestion) {
      this.suggestions.set(key, { actionId: action.id, key: prompt.key, question: prompt.question });
      this.emit({
        text:
          `${b.sessionName} is asking: "${clip(oneLine(prompt.question), 160)}" ` +
          `I'd answer "${clip(oneLine(suggestion.label), 120)}", but it's your call: ${verdict.reason}`,
        ref: refOf(b),
        quiet: true,
        actionIds: [action.id],
      });
    }
    this.deps.changed();
    this.deps.kick();
  }

  private suggestionCard(
    rec: BabysitRecord,
    prompt: BabysitPrompt,
    s: BabysitAnswer,
    verdict: Extract<BabysitVerdict, { kind: 'escalate' }>
  ): HeraldAction | null {
    const b = rec.brief;
    const old = this.suggestions.get(sessionKeyOf(b));
    if (old) this.deps.cancelAction(old.actionId);
    const common = {
      tier: verdict.tier,
      reasons: verdict.reasons,
      ruleIds: verdict.ruleIds,
      session: refOf(b),
      babysitId: b.id,
      why: verdict.reason,
    };
    if (prompt.kind === 'choice') {
      const options = prompt.options || [];
      if (s.optionIndex === undefined || !prompt.signature || !options[s.optionIndex]) return null;
      const label = options[s.optionIndex].label;
      return this.deps.suggest({
        ...common,
        kind: 'answer_choice',
        payload: label,
        readback: `${b.sessionName}: option ${s.optionIndex + 1}, ${clip(oneLine(label), 80)}`,
        choice: { index: s.optionIndex, optionCount: options.length, multiSelect: false, signature: prompt.signature },
      });
    }
    if (!s.text) return null;
    return this.deps.suggest({
      ...common,
      kind: 'send_input',
      payload: s.text,
      readback: `${b.sessionName}: "${clip(oneLine(s.text), 100)}"`,
    });
  }

  // ---------------------------------------------------------------- ending

  /** End an active brief and announce it. `announce` false = the user stopped it themselves. */
  private finish(rec: BabysitRecord, reason: HeraldBabysitEndReason, announce = true, detail?: string): void {
    const key = sessionKeyOf(rec.brief);
    if (!this.tracker.end(key, reason, this.deps.now())) return;
    this.announceEnd(rec, reason, announce, detail);
  }

  private announceEnd(rec: BabysitRecord, reason: HeraldBabysitEndReason, announce: boolean, detail?: string): void {
    const b = rec.brief;
    const key = sessionKeyOf(b);
    const sug = this.suggestions.get(key);
    if (sug) {
      this.suggestions.delete(key);
      this.deps.cancelAction(sug.actionId);
    }
    this.deps.audit(
      'herald_babysit_end',
      { babysitId: b.id, session: b.sessionId, reason, answersUsed: b.answersUsed, escalations: b.escalations },
      { ok: true },
      this.deps.now()
    );
    this.deps.log?.(
      `Herald: babysitting ${b.sessionName} ended (${reason}; ${plural(b.answersUsed, 'answer')}, ${b.escalations} brought to the user)`
    );
    if (!announce) return;
    const sent = plural(b.answersUsed, 'answer');
    let text: string;
    switch (reason) {
      case 'done':
        text = `${b.sessionName} says the goal is done${detail ? `: ${clip(oneLine(detail), 200)}` : '.'} I've stopped babysitting it (${sent} sent).`;
        break;
      case 'expired':
        text = `Babysitting ${b.sessionName} ended: the time limit is up (${sent} sent).`;
        break;
      case 'max_answers':
        text = `Babysitting ${b.sessionName} ended: I've used all ${b.maxAnswers} answers. It's yours again.`;
        break;
      case 'session_gone':
        text = `Babysitting ${b.sessionName} ended: the session closed (${sent} sent).`;
        break;
      case 'loop':
        text = `Babysitting ${b.sessionName} ended: it asked the same thing again after my answer, so I stopped answering. Have a look.`;
        break;
      default:
        text = `Stopped babysitting ${b.sessionName} (${sent} sent).`;
    }
    // Only "the goal is done" is worth saying aloud, and only mid-conversation.
    this.emit({ text, ref: refOf(b), quiet: !(reason === 'done' && this.deps.voiceActive()) });
  }

  private pushLog(rec: BabysitRecord, e: HeraldBabysitLogEntry): void {
    rec.brief.log.push({
      ...e,
      question: clip(oneLine(e.question), 300),
      ...(e.reason ? { reason: clip(oneLine(e.reason), 200) } : {}),
    });
    if (rec.brief.log.length > LIMITS.maxLog) rec.brief.log.splice(0, rec.brief.log.length - LIMITS.maxLog);
  }

  private emit(p: BabysitPost): void {
    // A spoken line must not cut off a reply that is streaming.
    if (!p.quiet && this.deps.busy()) this.queue.push(p);
    else this.deps.post(p);
  }
}
