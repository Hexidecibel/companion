/**
 * The fallback brain: what Herald says when the LLM is unavailable (network
 * down, 5xx, rate limited after retries, a rejected key, no credit, or the
 * monthly budget is spent). Everything is templated from deterministic data
 * (session listing + inbox), so it can never hallucinate, and short enough to
 * be spoken.
 *
 *   "anything for me" / brief -> unheard inbox headlines, most urgent first
 *   "status"                  -> one line per live session
 *   "how much have you cost"  -> the usage meter
 *   anything else             -> "My brain's offline right now (<why>) — here's what's waiting: ..."
 *
 * The outage itself (the "why") is told once per outage; later answers in the
 * same outage stay short.
 */

import type { HeraldBrainDownReason, HeraldInboxItem } from './protocol';
import { brainHeadline } from './inbox';
import type { SessionSnapshot } from './session-source';
import { LlmError, LlmErrorCode } from './llm/provider';
import { clip, firstSentence, oneLine, plainToolAction } from './text';

/** Spoken items before "and N more". */
export const FALLBACK_MAX_ITEMS = 3;

/** Plain words for each reason (spoken, so no jargon or status codes). */
export const REASON_TEXT: Record<HeraldBrainDownReason, string> = {
  budget: "this month's API budget is used up",
  credit: 'out of API credit',
  auth: 'the API key was rejected',
  rate_limited: 'the API is rate limiting me',
  unreachable: "I can't reach the API",
  timeout: 'the API is not answering',
  server: 'the API is having problems',
  bad_request: 'the API refused my request',
  other: 'the API is not working',
};

/** Map a provider error to an outage reason; null when it is not an outage (aborted). */
export function outageReason(err: unknown): HeraldBrainDownReason | null {
  if (!(err instanceof LlmError)) return 'other';
  const map: Record<LlmErrorCode, HeraldBrainDownReason | null> = {
    aborted: null,
    unreachable: 'unreachable',
    timeout: 'timeout',
    auth: 'auth',
    credit: 'credit',
    rate_limited: 'rate_limited',
    overloaded: 'server',
    server: 'server',
    bad_request: 'bad_request',
    protocol: 'other',
  };
  return map[err.code];
}

/**
 * Seconds before the next automatic recovery attempt, by reason and how many
 * attempts already failed. Transient trouble retries quickly; a bad key or no
 * credit needs the user, so it backs off sooner.
 */
export function recoveryDelayMs(reason: HeraldBrainDownReason, failures: number): number {
  const base =
    reason === 'auth' || reason === 'credit' || reason === 'bad_request'
      ? 60_000
      : reason === 'rate_limited'
        ? 20_000
        : 10_000;
  return Math.min(10 * 60_000, base * 2 ** Math.max(0, Math.min(failures - 1, 6)));
}

export type FallbackKind = 'brief' | 'status' | 'usage' | 'other';

const BRIEF_RE =
  /\b(?:any(?:thing)?\s+(?:new\s+)?for\s+me|what(?:'s|\s+is)\s+new|brief\s+me|briefing|catch\s+me\s+up|what\s+did\s+i\s+miss|what(?:'s|\s+is)\s+waiting|anything\s+(?:new|waiting))\b/i;
const STATUS_RE =
  /\b(?:status|what(?:'s|\s+is)\s+(?:every(?:one|body)|everything)\s+(?:doing|up\s+to)|what(?:'s|\s+is)\s+(?:going\s+on|happening|up)|how(?:'s|\s+is|\s+are)\s+(?:things|the\s+sessions|everyone|everything)|sessions?\s+status)\b/i;
const USAGE_RE =
  /\b(?:how\s+much\s+(?:have\s+you|did\s+you|do\s+you|are\s+you|you've|you\s+have)\s+(?:cost|costing|spent|spend|charged?)|what(?:'s|\s+is|\s+are|\s+have)\s+(?:you\s+)?(?:cost(?:ing)?|spen[dt]|my\s+(?:api\s+)?(?:bill|spend|usage|costs?))|how\s+(?:expensive|much)\s+(?:are\s+you|is\s+(?:herald|this|the\s+api))|api\s+(?:cost|costs|spend|usage|bill)|(?:monthly\s+)?budget\s+(?:left|used|status))\b/i;

/** Questions about Herald's own cost: answered from the meter, no LLM needed. */
export function isUsageQuestion(text: string): boolean {
  return USAGE_RE.test(text);
}

export function classifyFallback(text: string, intent?: string): FallbackKind {
  if (intent === 'brief') return 'brief';
  if (isUsageQuestion(text)) return 'usage';
  if (BRIEF_RE.test(text)) return 'brief';
  if (STATUS_RE.test(text)) return 'status';
  return 'other';
}

const INBOX_RANK = { blocked: 0, finished: 1, progress: 2 } as const;

/** Unheard items worth telling, most urgent first, newest first within a rank. */
export function unheardItems(inbox: HeraldInboxItem[]): HeraldInboxItem[] {
  return inbox
    .filter((i) => !i.heard && i.priority !== 'progress')
    .sort((a, b) => INBOX_RANK[a.priority] - INBOX_RANK[b.priority] || b.createdAt - a.createdAt);
}

function sentence(s: string): string {
  // A gist cut at a list ("...in parallel: 1.") drops the dangling number.
  const t = oneLine(s)
    .replace(/\s+$/, '')
    .replace(/:\s*\d+[.)]$/, '');
  if (!t) return '';
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

function listOut(lines: string[], max = FALLBACK_MAX_ITEMS): string {
  const shown = lines.slice(0, max).map(sentence).filter(Boolean);
  const more = lines.length - shown.length;
  return `${shown.join(' ')}${more > 0 ? ` And ${more} more.` : ''}`;
}

/** "companion needs your OK to run a shell command" etc., for sessions waiting on the user. */
function waitingLine(s: SessionSnapshot): string | null {
  if (s.pendingChoice)
    return `${s.sessionName} is asking: ${clip(oneLine(s.pendingChoice.question || 'a question'), 100)}`;
  if (s.pendingApproval)
    return `${s.sessionName} wants your OK to ${plainToolAction(s.pendingApproval.tool)}`;
  if (s.pendingQuestion) return `${s.sessionName} asked: ${clip(oneLine(s.pendingQuestion), 100)}`;
  if (s.status === 'waiting') return `${s.sessionName} is waiting on you`;
  return null;
}

/** What is waiting on the user right now, from the live listing. */
export function waitingSummary(snaps: SessionSnapshot[]): string {
  const lines = snaps
    .filter((s) => !s.inactive)
    .sort((a, b) => b.lastActivity - a.lastActivity)
    .map(waitingLine)
    .filter((l): l is string => !!l);
  return lines.length ? listOut(lines) : 'Nothing is waiting on you.';
}

/** One line per live session: waiting first, then working, then idle. */
export function statusSummary(snaps: SessionSnapshot[]): string {
  const live = snaps.filter((s) => !s.inactive);
  if (live.length === 0) return 'No sessions are running.';
  const rank = { waiting: 0, working: 1, idle: 2 } as const;
  live.sort((a, b) => rank[a.status] - rank[b.status] || b.lastActivity - a.lastActivity);
  const lines = live.map((s) => {
    const w = waitingLine(s);
    if (w) return w;
    if (s.status === 'working') {
      const what = s.currentActivity ? `: ${clip(oneLine(s.currentActivity), 60)}` : '';
      return `${s.sessionName} is working${what}`;
    }
    return `${s.sessionName} is idle`;
  });
  const count = `${live.length} session${live.length === 1 ? '' : 's'}.`;
  return `${count} ${listOut(lines, 5)}`;
}

/** Spoken briefing from inbox items (already filtered + sorted). */
export function briefSummary(items: HeraldInboxItem[]): string {
  if (items.length === 0) return 'Nothing new.';
  return listOut(items.map(briefLine));
}

/** One briefing line; review alerts get a templated lead-in, stuck items say so as they are. */
export function briefLine(i: HeraldInboxItem): string {
  if (i.pairing) return oneLine(brainHeadline(i));
  if (i.stuck) return oneLine(i.headline);
  const head = firstSentence(i.headline, 160) || i.headline;
  return i.review ? `Heads up: ${head}` : head;
}

export interface FallbackInput {
  kind: FallbackKind;
  reason: HeraldBrainDownReason;
  /** First answer of this outage: say what is wrong. */
  announce: boolean;
  snapshots: SessionSnapshot[];
  /** Unheard items for a briefing (most urgent first). */
  briefing: HeraldInboxItem[];
  /** The usage answer, for kind 'usage'. */
  usage?: string;
}

/** The fallback reply text. */
export function fallbackReply(f: FallbackInput): string {
  const why = REASON_TEXT[f.reason];
  if (f.kind === 'other') {
    const waiting = waitingSummary(f.snapshots);
    return f.announce
      ? `My brain's offline right now (${why}) — here's what's waiting: ${waiting}`
      : `Still offline — here's what's waiting: ${waiting}`;
  }
  const body =
    f.kind === 'brief'
      ? briefSummary(f.briefing)
      : f.kind === 'status'
        ? statusSummary(f.snapshots)
        : f.usage || '';
  return f.announce
    ? `My brain's offline right now (${why}), so here's the short version. ${body}`
    : body;
}
