/**
 * Session babysitter: what is kept per brief, and its validation on load.
 *
 * The public part (`brief`) is the protocol's HeraldBabysit; the rest is the
 * bookkeeping that makes a brief safe across polls and daemon restarts: which
 * prompt was on screen when it started (never answered), which prompts were
 * already handled (never decided twice), and what was answered (loop detection).
 */

import {
  HERALD_BABYSIT_LIMITS,
  type HeraldBabysit,
  type HeraldBabysitEndReason,
  type HeraldBabysitLogEntry,
} from '../protocol';

export const BABYSIT_LIMITS = HERALD_BABYSIT_LIMITS;
/** An ended brief stays listed this long (the session view shows why it ended). */
export const BABYSIT_ENDED_KEEP_MS = 60 * 60 * 1000;
/** Prompt keys remembered per brief. */
export const BABYSIT_MAX_HANDLED = 80;
const MAX_RECORDS = 24;
const MAX_LOG_TEXT = 400;

export interface BabysitRecord {
  brief: HeraldBabysit;
  /** The prompt on screen when the brief started: the user saw it, Herald leaves it. */
  baselineKey: string | null;
  /** Prompts already decided (answered, escalated or dropped), newest last. */
  handled: string[];
  /** Hashes of the questions Herald answered itself (a repeat = a loop). */
  answered: string[];
  /** The last non-"continue" answer Herald sent (the same one twice in a row = a loop). */
  lastAnswer: string | null;
}

export const sessionKeyOf = (s: { serverId: string; sessionId: string }): string =>
  `${s.serverId}:${s.sessionId}`;

const END_REASONS: readonly HeraldBabysitEndReason[] = [
  'stopped',
  'expired',
  'max_answers',
  'session_gone',
  'done',
  'loop',
];
const LOG_KINDS: readonly HeraldBabysitLogEntry['kind'][] = [
  'answered',
  'escalated',
  'user',
  'done',
];

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const count = (v: unknown, max: number): number =>
  isNum(v) ? Math.min(max, Math.max(0, Math.round(v))) : 0;

function sanitizeLog(raw: unknown): HeraldBabysitLogEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: HeraldBabysitLogEntry[] = [];
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue;
    const e = x as Record<string, unknown>;
    if (!isNum(e.at) || !isStr(e.question) || !isStr(e.answer)) continue;
    if (!(LOG_KINDS as readonly unknown[]).includes(e.kind)) continue;
    out.push({
      at: e.at,
      question: e.question.slice(0, MAX_LOG_TEXT),
      answer: e.answer.slice(0, MAX_LOG_TEXT),
      kind: e.kind as HeraldBabysitLogEntry['kind'],
      ...(isStr(e.reason) && e.reason ? { reason: e.reason.slice(0, MAX_LOG_TEXT) } : {}),
    });
  }
  return out.slice(-BABYSIT_LIMITS.maxLog);
}

function sanitizeRecord(raw: unknown, now: number): BabysitRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const b = r.brief as Record<string, unknown> | undefined;
  if (!b || typeof b !== 'object') return null;
  if (!isStr(b.id) || !isStr(b.serverId) || !isStr(b.sessionId) || !isStr(b.sessionName))
    return null;
  if (!b.id || !b.serverId || !b.sessionId) return null;
  if (!isStr(b.goal) || b.goal.trim().length < BABYSIT_LIMITS.minGoalChars) return null;
  if (!isNum(b.createdAt) || !isNum(b.expiresAt) || b.createdAt > now + 60_000) return null;
  if (b.status !== 'active' && b.status !== 'ended') return null;
  // A time limit far beyond the allowed maximum is a damaged file, not a brief.
  if (b.expiresAt - now > (BABYSIT_LIMITS.maxMinutes + 1) * 60_000) return null;
  const endedAt = isNum(b.endedAt) ? b.endedAt : undefined;
  if (b.status === 'ended' && now - (endedAt ?? b.expiresAt) > BABYSIT_ENDED_KEEP_MS) return null;
  const maxAnswers = Math.min(
    BABYSIT_LIMITS.maxMaxAnswers,
    Math.max(
      1,
      count(b.maxAnswers, BABYSIT_LIMITS.maxMaxAnswers) || BABYSIT_LIMITS.defaultMaxAnswers
    )
  );
  const brief: HeraldBabysit = {
    id: b.id.slice(0, 80),
    serverId: b.serverId.slice(0, 80),
    sessionId: b.sessionId.slice(0, 200),
    sessionName: b.sessionName.slice(0, 200),
    goal: b.goal.slice(0, BABYSIT_LIMITS.maxGoalChars),
    ...(isStr(b.direction) && b.direction.trim()
      ? { direction: b.direction.slice(0, BABYSIT_LIMITS.maxDirectionChars) }
      : {}),
    ...(isStr(b.never) && b.never.trim()
      ? { never: b.never.slice(0, BABYSIT_LIMITS.maxNeverChars) }
      : {}),
    createdAt: b.createdAt,
    expiresAt: b.expiresAt,
    ...(isNum(b.minutes) &&
    b.minutes >= BABYSIT_LIMITS.minMinutes &&
    b.minutes <= BABYSIT_LIMITS.maxMinutes
      ? { minutes: Math.round(b.minutes) }
      : {}),
    maxAnswers,
    answersUsed: count(b.answersUsed, 1000),
    escalations: count(b.escalations, 10_000),
    status: b.status,
    ...(b.status === 'ended'
      ? {
          endReason: (END_REASONS as readonly unknown[]).includes(b.endReason)
            ? (b.endReason as HeraldBabysitEndReason)
            : 'stopped',
          endedAt: endedAt ?? b.expiresAt,
        }
      : {}),
    log: sanitizeLog(b.log),
  };
  const strs = (v: unknown, max: number) =>
    (Array.isArray(v) ? v : []).filter((x): x is string => isStr(x) && x.length < 300).slice(-max);
  return {
    brief,
    baselineKey: isStr(r.baselineKey) ? r.baselineKey.slice(0, 300) : null,
    handled: strs(r.handled, BABYSIT_MAX_HANDLED),
    answered: strs(r.answered, BABYSIT_MAX_HANDLED),
    lastAnswer: isStr(r.lastAnswer) ? r.lastAnswer.slice(0, MAX_LOG_TEXT) : null,
  };
}

/**
 * Validate persisted briefs. One per session (the newest wins); anything
 * malformed is dropped, which fails closed: a brief that does not load never
 * answers anything.
 */
export function sanitizeBabysits(raw: unknown, now: number): BabysitRecord[] {
  if (!Array.isArray(raw)) return [];
  const bySession = new Map<string, BabysitRecord>();
  for (const x of raw) {
    const rec = sanitizeRecord(x, now);
    if (!rec) continue;
    const key = sessionKeyOf(rec.brief);
    const prev = bySession.get(key);
    if (!prev || prev.brief.createdAt <= rec.brief.createdAt) bySession.set(key, rec);
  }
  return Array.from(bySession.values()).slice(-MAX_RECORDS);
}

export function cloneBrief(b: HeraldBabysit): HeraldBabysit {
  return { ...b, log: b.log.map((e) => ({ ...e })) };
}

export function cloneRecord(r: BabysitRecord): BabysitRecord {
  return { ...r, brief: cloneBrief(r.brief), handled: [...r.handled], answered: [...r.answered] };
}
