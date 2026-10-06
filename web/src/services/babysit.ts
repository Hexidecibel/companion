/**
 * Session babysitter, client side: a tiny store the Herald provider feeds with
 * the hub's briefs, plus the pure helpers the bar / badge / dialog share.
 *
 * A store (not the Herald data context) on purpose: that context changes on
 * every streamed token, and the session view must not re-render with it.
 * Herald lives on ONE hub: briefs carry Herald's own server id ('local'), the
 * session view carries this app's connection id, so everything here is matched
 * against `hostId`.
 */
import type {
  HeraldBabysit,
  HeraldBabysitEndReason,
  HeraldBabysitLogEntry,
  HeraldBabysitSetRequest,
  HeraldBabysitStopRequest,
} from '../types/herald';
import { HERALD_BABYSIT_LIMITS } from '../types/herald';

/** Herald's server id for the hub's own sessions. */
export const HERALD_LOCAL_SERVER_ID = 'local';

export interface BabysitSnapshot {
  /** The connection Herald lives on; null = no hub. */
  hostId: string | null;
  /** The hub reports briefs (false: older daemon, Herald off, or not loaded yet). */
  supported: boolean;
  /** Connected to the hub right now. */
  connected: boolean;
  /** Active briefs plus the ones ended in the last hour. */
  babysits: HeraldBabysit[];
  /** local clock - hub clock, ms (see heraldReducer). */
  skewMs: number | null;
}

export interface BabysitApi {
  set: (req: HeraldBabysitSetRequest) => Promise<string | null>;
  stop: (req: HeraldBabysitStopRequest) => Promise<string | null>;
}

const EMPTY: BabysitSnapshot = { hostId: null, supported: false, connected: false, babysits: [], skewMs: null };
const NOT_READY = 'Herald is not connected';
const NO_API: BabysitApi = { set: async () => NOT_READY, stop: async () => NOT_READY };

let snapshot: BabysitSnapshot = EMPTY;
let api: BabysitApi = NO_API;
const listeners = new Set<() => void>();

export const babysitStore = {
  get: (): BabysitSnapshot => snapshot,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  /** Called by the Herald provider whenever one of the inputs changes. */
  update(next: BabysitSnapshot, nextApi: BabysitApi): void {
    api = nextApi;
    const same = snapshot.hostId === next.hostId && snapshot.supported === next.supported
      && snapshot.connected === next.connected && snapshot.babysits === next.babysits && snapshot.skewMs === next.skewMs;
    if (same) return;
    snapshot = next;
    for (const l of [...listeners]) l();
  },
  reset(): void {
    babysitStore.update(EMPTY, NO_API);
  },
  set: (req: HeraldBabysitSetRequest) => api.set(req),
  stop: (req: HeraldBabysitStopRequest) => api.stop(req),
};

/** A brief belongs to the hub's own sessions (the only kind today). */
function onHub(b: HeraldBabysit, hostId: string | null): boolean {
  return b.serverId === HERALD_LOCAL_SERVER_ID || (!!hostId && b.serverId === hostId);
}

/**
 * The brief to show for a session of connection `serverId`: the active one,
 * else the most recently ended. null for a session on a non-hub server.
 */
export function babysitForSession(snap: BabysitSnapshot, serverId: string | null | undefined, sessionId: string | null | undefined): HeraldBabysit | null {
  if (!serverId || !sessionId || !snap.hostId || serverId !== snap.hostId) return null;
  let best: HeraldBabysit | null = null;
  for (const b of snap.babysits) {
    if (b.sessionId !== sessionId || !onHub(b, snap.hostId)) continue;
    if (b.status === 'active') return b;
    if (!best || (b.endedAt ?? 0) > (best.endedAt ?? 0)) best = b;
  }
  return best;
}

export function activeBabysits(list: readonly HeraldBabysit[] | undefined): HeraldBabysit[] {
  return (list ?? []).filter((b) => b.status === 'active');
}

/** ms until the brief ends, on the local clock (expiresAt is the hub's clock). */
export function babysitRemainingMs(b: Pick<HeraldBabysit, 'expiresAt'>, nowLocal: number, skewMs: number | null): number {
  return Math.max(0, b.expiresAt + (skewMs ?? 0) - nowLocal);
}

/** "26 min left", "1 h 5 min left", "under a minute left". */
export function formatTimeLeft(ms: number): string {
  if (ms < 60_000) return 'under a minute left';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min left`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min left` : `${h} h left`;
}

export function answersText(n: number): string {
  return `${n} ${n === 1 ? 'answer' : 'answers'}`;
}

const END_REASON: Record<HeraldBabysitEndReason, string> = {
  stopped: 'stopped',
  expired: 'time limit reached',
  max_answers: 'answer limit reached',
  session_gone: 'session closed',
  done: 'goal finished',
  loop: 'stopped because the same question kept coming back',
};

/** Why a brief ended, in plain words. */
export function endReasonText(reason: HeraldBabysitEndReason | undefined): string {
  return (reason && END_REASON[reason]) || 'ended';
}

/** "Babysitting: 4 answers, 26 min left" / "Babysitting ended: time limit reached". */
export function babysitStatusLine(b: HeraldBabysit, nowLocal: number, skewMs: number | null): string {
  if (b.status !== 'active') return `Babysitting ended: ${endReasonText(b.endReason)}`;
  return `Babysitting: ${answersText(b.answersUsed)}, ${formatTimeLeft(babysitRemainingMs(b, nowLocal, skewMs))}`;
}

const LOG_LABEL: Record<HeraldBabysitLogEntry['kind'], string> = {
  answered: 'Herald answered',
  escalated: 'Suggested answer',
  user: 'You sent',
  done: 'Goal finished',
};

export function logKindLabel(entry: HeraldBabysitLogEntry): string {
  if (entry.kind === 'escalated' && !entry.answer) return 'Brought to you';
  return LOG_LABEL[entry.kind] ?? 'Herald';
}

export interface BabysitDraft {
  goal: string;
  direction: string;
  never: string;
  minutes: number;
  maxAnswers: number;
}

/** Form values for a new brief, or for editing / restarting `from`. */
export function draftFor(from: HeraldBabysit | null): BabysitDraft {
  const L = HERALD_BABYSIT_LIMITS;
  if (!from) return { goal: '', direction: '', never: '', minutes: L.defaultMinutes, maxAnswers: L.defaultMaxAnswers };
  // The configured limit when the daemon reports it. Older daemons do not: then
  // the span is a guess (an edit restarts the limit but keeps createdAt), a
  // round number inside the bounds, else the default.
  const span =
    typeof from.minutes === 'number' && Number.isFinite(from.minutes)
      ? Math.round(from.minutes)
      : Math.round((from.expiresAt - from.createdAt) / 60_000 / 5) * 5;
  return {
    goal: from.goal,
    direction: from.direction ?? '',
    never: from.never ?? '',
    minutes: Number.isFinite(span) && span >= L.minMinutes && span <= L.maxMinutes ? span : L.defaultMinutes,
    maxAnswers: Math.min(L.maxMaxAnswers, Math.max(1, from.maxAnswers || L.defaultMaxAnswers)),
  };
}

/** First problem with a draft, or null when it can be sent. */
export function validateDraft(d: BabysitDraft): string | null {
  const L = HERALD_BABYSIT_LIMITS;
  const goal = d.goal.trim();
  if (goal.length < L.minGoalChars) return 'Say what the session should get done.';
  if (goal.length > L.maxGoalChars) return `Keep the goal under ${L.maxGoalChars} characters.`;
  if (d.direction.trim().length > L.maxDirectionChars) return `Keep the direction under ${L.maxDirectionChars} characters.`;
  if (d.never.trim().length > L.maxNeverChars) return `Keep "never decide" under ${L.maxNeverChars} characters.`;
  if (!Number.isFinite(d.minutes) || d.minutes < L.minMinutes || d.minutes > L.maxMinutes) {
    return `Time limit: ${L.minMinutes} to ${L.maxMinutes} minutes.`;
  }
  if (!Number.isInteger(d.maxAnswers) || d.maxAnswers < 1 || d.maxAnswers > L.maxMaxAnswers) {
    return `Answer limit: 1 to ${L.maxMaxAnswers}.`;
  }
  return null;
}

export function draftToRequest(sessionId: string, d: BabysitDraft): HeraldBabysitSetRequest {
  const direction = d.direction.trim();
  const never = d.never.trim();
  return {
    sessionId,
    serverId: HERALD_LOCAL_SERVER_ID,
    goal: d.goal.trim(),
    ...(direction ? { direction } : {}),
    ...(never ? { never } : {}),
    minutes: Math.round(d.minutes),
    maxAnswers: d.maxAnswers,
  };
}
