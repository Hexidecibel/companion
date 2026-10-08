/**
 * Ask-and-report: when Herald sends a question or request to a session, it
 * remembers who asked what ("awaiting reply" links) and, when that session
 * finishes the turn that answers it, tells the user what it said in one or two
 * sentences, grounded ONLY in the session's actual reply.
 *
 *   waiting  -> reply   the turn that follows our prompt is complete
 *            -> blocked the session now waits on a choice / approval (reported
 *                       once per prompt; the link stays open for the answer)
 *            -> timeout no reply in ASK_TIMEOUT_MS: dropped quietly
 *            -> gone    the session closed: dropped quietly
 *
 * The tracker is synchronous and deterministic (decisions only); the service
 * fetches transcripts, composes the answer and posts it. Links persist across
 * daemon restarts (state.json).
 */

import type { LlmProvider } from './llm/provider';
import type { SessionSnapshot, TranscriptExchange } from './session-source';
import { clip, clipTail, firstSentence, oneLine, plainToolAction } from './text';
import { echoWords } from './voice/echo-match';

export const ASK_TIMEOUT_MS = 30 * 60 * 1000;
export const MAX_ASKS = 20;
const MAX_TEXT = 1000;
/** How much of the session's reply the answer is written from (its end matters most). */
export const ANSWER_REPLY_CHARS = 3500;
export const ANSWER_TIMEOUT_MS = 20_000;
const ANSWER_MAX_CHARS = 320;

export interface AskLink {
  /** The action that sent it (one link per send). */
  actionId: string;
  serverId: string;
  sessionId: string;
  sessionName: string;
  /** What the user said to Herald. */
  userQuestion: string;
  /** What was typed into the session. */
  sentText: string;
  sentAt: number;
  /** The session's last turn when we sent (fallback reply detection). */
  baselineTurnKey: string | null;
  /** Choice / approval on screen when we sent: not news. */
  baselineBlockKey: string | null;
  /** Last block already reported for this link. */
  reportedBlockKey?: string | null;
}

export type AskDecision =
  | { type: 'reply'; link: AskLink; snap: SessionSnapshot }
  | { type: 'blocked'; link: AskLink; snap: SessionSnapshot; what: string }
  | { type: 'timeout'; link: AskLink }
  | { type: 'gone'; link: AskLink };

const sk = (s: { serverId: string; sessionId: string }) => `${s.serverId}:${s.sessionId}`;

/**
 * What the session is blocked on, for "needs your input" reports: only a prompt
 * that is ON SCREEN (a choice box, which includes Claude's permission prompts).
 * A tool call without a result in the transcript is not enough: in
 * bypass-permissions mode that is simply a command still running.
 */
export function blockKeyOf(s: SessionSnapshot): string | null {
  if (s.pendingChoice) return `c:${s.pendingChoice.signature}`;
  return null;
}

/** "the deploy question" / "approval to run a command", for "Out4 needs your input on ...". */
export function blockedWhat(s: SessionSnapshot): string {
  if (s.pendingChoice) {
    const q = clip(
      oneLine(s.pendingChoice.question || s.pendingChoice.header || '').replace(/[?.!\s]+$/, ''),
      120
    );
    if (!q) return 'a question';
    // "Which fixture" -> "which fixture" (mid-sentence), but keep "API ..." / "Out4 ...".
    const lower = /^[A-Z][a-z]/.test(q) ? q[0].toLowerCase() + q.slice(1) : q;
    return `"${lower}"`;
  }
  if (s.pendingApproval) return `approval to ${plainToolAction(s.pendingApproval.tool)}`;
  return 'a question';
}

function sanitizeLink(raw: unknown, now: number): AskLink | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const actionId = str(r.actionId);
  const serverId = str(r.serverId);
  const sessionId = str(r.sessionId);
  const sessionName = str(r.sessionName);
  const userQuestion = str(r.userQuestion);
  const sentText = str(r.sentText);
  const sentAt = num(r.sentAt);
  if (!actionId || !serverId || !sessionId || !sessionName || sentAt === null) return null;
  if (userQuestion === null || sentText === null) return null;
  if (now - sentAt > ASK_TIMEOUT_MS || sentAt > now + 60_000) return null;
  return {
    actionId,
    serverId,
    sessionId,
    sessionName,
    userQuestion: userQuestion.slice(0, MAX_TEXT),
    sentText: sentText.slice(0, MAX_TEXT),
    sentAt,
    baselineTurnKey: str(r.baselineTurnKey),
    baselineBlockKey: str(r.baselineBlockKey),
    reportedBlockKey: str(r.reportedBlockKey),
  };
}

/** Validate persisted links (expired ones are dropped). */
export function sanitizeAsks(raw: unknown, now: number): AskLink[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => sanitizeLink(x, now))
    .filter((x): x is AskLink => x !== null)
    .slice(-MAX_ASKS);
}

export class AskTracker {
  private links: AskLink[] = [];
  /** Links whose answer is being composed: never decided twice. */
  private busy = new Set<string>();

  constructor(initial: AskLink[] = []) {
    this.links = initial.slice(-MAX_ASKS).map((l) => ({ ...l }));
  }

  add(link: AskLink): void {
    this.links = this.links.filter((l) => l.actionId !== link.actionId);
    this.links.push({
      ...link,
      userQuestion: link.userQuestion.slice(0, MAX_TEXT),
      sentText: link.sentText.slice(0, MAX_TEXT),
    });
    if (this.links.length > MAX_ASKS) this.links.splice(0, this.links.length - MAX_ASKS);
  }

  remove(actionId: string): void {
    this.links = this.links.filter((l) => l.actionId !== actionId);
    this.busy.delete(actionId);
  }

  /** Done looking for now; `turnKey`: re-check only once the session's turn changes again. */
  release(actionId: string, turnKey?: string | null): void {
    this.busy.delete(actionId);
    if (turnKey === undefined) return;
    const l = this.links.find((x) => x.actionId === actionId);
    if (l) l.baselineTurnKey = turnKey;
  }

  list(): AskLink[] {
    return this.links.map((l) => ({ ...l }));
  }

  /** A session with an open ask: its generic "finished" inbox note is replaced by the answer. */
  hasOpen(sessionKey: string): boolean {
    return this.links.some((l) => sk(l) === sessionKey);
  }

  get size(): number {
    return this.links.length;
  }

  /**
   * Decide what changed for each open link. `reply` candidates still need the
   * transcript check (the service confirms the reply follows OUR prompt);
   * they are marked busy until `remove` / `release`.
   */
  update(snaps: SessionSnapshot[], now: number): AskDecision[] {
    const out: AskDecision[] = [];
    const bySession = new Map(snaps.map((s) => [sk(s), s] as const));
    for (const link of this.links.slice()) {
      if (this.busy.has(link.actionId)) continue;
      if (now - link.sentAt > ASK_TIMEOUT_MS) {
        this.remove(link.actionId);
        out.push({ type: 'timeout', link: { ...link } });
        continue;
      }
      const s = bySession.get(sk(link));
      if (!s) continue; // not listed right now (spawning, a flaky listing): wait for the timeout
      if (s.inactive) {
        this.remove(link.actionId);
        out.push({ type: 'gone', link: { ...link } });
        continue;
      }
      const block = blockKeyOf(s);
      if (block && block !== link.baselineBlockKey && block !== link.reportedBlockKey) {
        link.reportedBlockKey = block;
        out.push({ type: 'blocked', link: { ...link }, snap: s, what: blockedWhat(s) });
        continue;
      }
      if (s.status === 'working' || block || s.pendingApproval) continue;
      // Idle (or ended its turn with a question): a reply may be complete.
      if (s.lastTurnKey && s.lastTurnKey !== link.baselineTurnKey) {
        this.busy.add(link.actionId);
        out.push({ type: 'reply', link: { ...link }, snap: s });
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Which reply answers our prompt

function normText(s: string): string {
  return oneLine(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The prompt the session saw is ours (queued messages may be merged into one). */
export function promptMatches(prompt: string, sent: string): boolean {
  const p = normText(prompt);
  const s = normText(sent).slice(0, 80);
  return !!s && p.includes(s);
}

/**
 * The session's reply to OUR prompt, or null when it has not answered it yet.
 * `exchanges` are oldest first; a reply counts once the session is idle or has
 * moved on to a later prompt (so it is complete).
 */
export function findReply(
  link: AskLink,
  exchanges: TranscriptExchange[],
  sessionIdle: boolean,
  skewMs = 60_000
): { reply: string; at: number } | null {
  for (let i = exchanges.length - 1; i >= 0; i--) {
    const ex = exchanges[i];
    if (ex.promptAt < link.sentAt - skewMs) break;
    if (!promptMatches(ex.prompt, link.sentText)) continue;
    const complete = sessionIdle || i < exchanges.length - 1;
    if (!complete || !ex.reply.trim()) return null;
    return { reply: ex.reply, at: ex.replyAt ?? ex.promptAt };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Composing the answer

const ANSWER_SYSTEM = `You report back to the user what one of their AI coding sessions replied to something they asked it.
Rules:
- Use ONLY the session's reply below. Never add facts, numbers, names or outcomes it does not state. If it did not answer the question, say briefly what it did say.
- Keep its tense and certainty: "says it's deploying" is not "deployed"; a plan is a plan; a guess stays a guess.
- One or two short spoken sentences, under 40 words, answer first. Give the content itself ("Two tests fail because..."), never a description of the reply ("The session replied with..."), and do not start with the session's name or "It said".
- No markdown, lists, code, file paths, commands, URLs or commit hashes; paraphrase for the ear.
- If the reply ends by asking the user something, end with that question in plain words.`;

const NUMBER_WORDS = new Set([
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
  'hundred',
  'thousand',
  'million',
  'percent',
  'point',
]);

/**
 * Numbers in `text` that the source never states, compared spelled out ("7",
 * "seven" and "7.0" all become words), so "seven tests fail" is caught when the
 * session said "two". "one" is ignored ("one of the tests" is not a count).
 */
export function inventedNumbers(text: string, source: string): string[] {
  const said = new Set(echoWords(source.replace(/,/g, '')));
  return echoWords(text.replace(/,/g, '')).filter(
    (w) => NUMBER_WORDS.has(w) && w !== 'one' && w !== 'point' && !said.has(w)
  );
}

/** Deterministic answer: the session's own first sentence(s). */
export function fallbackAnswer(reply: string): string {
  const one = firstSentence(reply, 220);
  return one || clip(oneLine(reply), 220);
}

export interface ComposedAnswer {
  text: string;
  via: 'llm' | 'fallback';
  /** Why the model's answer was not used. */
  rejected?: string;
}

/**
 * One or two sentences tied to the user's question, from the reply alone. The
 * model's answer is checked (non-empty, bounded, no invented numbers); anything
 * else falls back to the session's own first sentence.
 */
export async function composeAnswer(
  provider: LlmProvider | null,
  input: { sessionName: string; userQuestion: string; sentText: string; reply: string },
  opts: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<ComposedAnswer> {
  const reply = clipTail(input.reply.trim(), ANSWER_REPLY_CHARS);
  const fallback = (rejected?: string): ComposedAnswer => ({
    text: fallbackAnswer(input.reply),
    via: 'fallback',
    ...(rejected ? { rejected } : {}),
  });
  if (!provider) return fallback('no brain');
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener('abort', onAbort);
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? ANSWER_TIMEOUT_MS);
  timer.unref?.();
  try {
    const res = await provider.chat({
      system: ANSWER_SYSTEM,
      messages: [
        {
          role: 'user',
          text:
            `The user asked: ${JSON.stringify(clip(oneLine(input.userQuestion), 400))}\n` +
            `Sent to the session (${input.sessionName}): ${JSON.stringify(clip(oneLine(input.sentText), 400))}\n` +
            `The session's reply:\n<<<\n${reply}\n>>>\n` +
            'Write the answer for the user now.',
        },
      ],
      tools: [],
      toolChoice: 'none',
      maxTokens: 160,
      signal: ctrl.signal,
      onText: () => {},
    });
    let text = oneLine(res.text || '')
      .replace(/^["'\s]+|["'\s]+$/g, '')
      .replace(
        new RegExp(`^${escapeRe(input.sessionName)}\\s+(?:says|said|answered)[:,]?\\s*`, 'i'),
        ''
      )
      // "The session replied (with ...): X" -> "X"
      .replace(
        /^(?:the session|it)\s+(?:replied|said|says|answered)(?:\s+(?:with|that)\b[^:]*)?:\s*/i,
        ''
      );
    if (text) text = text[0].toUpperCase() + text.slice(1);
    if (!text) return fallback('empty');
    if (text.length > ANSWER_MAX_CHARS) text = clip(text, ANSWER_MAX_CHARS);
    const invented = inventedNumbers(text, input.reply);
    if (invented.length) return fallback(`numbers not in the reply: ${invented.join(', ')}`);
    return { text, via: 'llm' };
  } catch (err) {
    return fallback(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Reporter: decisions -> transcript check -> grounded answer -> message + inbox

/** The user just talked to Herald by voice this recently: answers are spoken. */
export const VOICE_EXCHANGE_WINDOW_MS = 2 * 60 * 1000;

export interface AskPost {
  text: string;
  ref: { serverId: string; sessionId: string; sessionName: string };
  /** Not part of an active voice exchange: tone + screen only, never spoken unasked. */
  quiet: boolean;
}

export interface AskReporterDeps {
  getSource(serverId: string): import('./session-source').SessionSource | null;
  /** The brain to phrase the answer (null: the session's own first sentence). */
  provider(): LlmProvider | null;
  now(): number;
  /** The user is in a voice exchange right now (answers may be spoken). */
  voiceActive(): boolean;
  /** A brain turn is streaming: posting now would cut its spoken reply off. */
  busy(): boolean;
  post(p: AskPost): void;
  addAnswer(a: {
    askId: string;
    serverId: string;
    sessionId: string;
    sessionName: string;
    headline: string;
    priority: 'finished' | 'blocked';
    createdAt: number;
    heard: boolean;
  }): void;
  persist(): void;
  log?(line: string): void;
}

/** Does the user's utterance read as a question ("ask Out4 what's failing")? */
export function isQuestion(userText: string): boolean {
  const t = oneLine(userText).toLowerCase();
  return (
    /\?\s*$/.test(t) ||
    /^(?:hey\s+\w+[,\s]+)?(?:ask|check with|find out|see if|see whether)\b/.test(t) ||
    /\b(?:ask|find out|check)\b.*\b(?:what|why|how|when|where|which|who|whether|if)\b/.test(t) ||
    /^(?:what|why|how|when|where|which|who|is|are|does|did|can|could|has|have|will|would)\b/.test(t)
  );
}

export class AskReporter {
  readonly tracker: AskTracker;
  private deps: AskReporterDeps;
  private queue: AskPost[] = [];
  private inFlight = new Set<Promise<void>>();

  constructor(deps: AskReporterDeps, initial: AskLink[] = []) {
    this.deps = deps;
    this.tracker = new AskTracker(initial);
  }

  load(links: AskLink[]): void {
    for (const l of links) this.tracker.add(l);
  }

  list(): AskLink[] {
    return this.tracker.list();
  }

  hasOpen(sessionKey: string): boolean {
    return this.tracker.hasOpen(sessionKey);
  }

  /** Record a send that expects a reply. */
  open(link: AskLink): void {
    this.tracker.add(link);
    this.deps.log?.(
      `Herald: awaiting ${link.sessionName}'s reply (ask ${link.actionId.slice(0, 8)})`
    );
    this.deps.persist();
  }

  /** Feed a fresh listing (from the poll loop). Async work runs in the background. */
  onSnapshots(snaps: SessionSnapshot[]): void {
    const decisions = this.tracker.update(snaps, this.deps.now());
    if (decisions.length === 0) return;
    let changed = false;
    for (const d of decisions) {
      if (d.type === 'timeout' || d.type === 'gone') {
        changed = true;
        this.deps.log?.(
          `Herald: dropped ask to ${d.link.sessionName} (${d.type === 'timeout' ? 'no reply in 30 min' : 'session closed'})`
        );
      } else if (d.type === 'blocked') {
        changed = true;
        this.emit({
          text: `${d.link.sessionName} needs your input on ${d.what}.`,
          ref: refOf(d.link),
          quiet: !this.deps.voiceActive(),
        });
      } else {
        const p = this.resolveReply(d.link, d.snap).finally(() => this.inFlight.delete(p));
        this.inFlight.add(p);
      }
    }
    if (changed) this.deps.persist();
  }

  private async resolveReply(link: AskLink, snap: SessionSnapshot): Promise<void> {
    try {
      const src = this.deps.getSource(link.serverId);
      if (!src) return this.tracker.release(link.actionId);
      let reply: { reply: string; at: number } | null = null;
      if (src.getExchangesSince) {
        const ex = await src.getExchangesSince(link.sessionId, link.sentAt - 60_000);
        reply = findReply(link, ex, snap.status !== 'working');
      } else {
        const t = await src.getRecentTranscript(link.sessionId, 1);
        const last = t.assistantTurns[t.assistantTurns.length - 1];
        if (t.lastUserPrompt && promptMatches(t.lastUserPrompt.text, link.sentText) && last)
          reply = { reply: last.text, at: last.at };
      }
      if (!reply) {
        // Not our turn yet (an earlier task finishing, a queued prompt): keep waiting.
        this.tracker.release(link.actionId, snap.lastTurnKey);
        return;
      }
      const answer = await composeAnswer(this.deps.provider(), {
        sessionName: link.sessionName,
        userQuestion: link.userQuestion,
        sentText: link.sentText,
        reply: reply.reply,
      });
      if (answer.rejected)
        this.deps.log?.(
          `Herald: ask answer for ${link.sessionName} used the fallback (${answer.rejected})`
        );
      const asking = !!snap.pendingQuestion;
      const lead = asking
        ? `${link.sessionName} replied`
        : isQuestion(link.userQuestion)
          ? `${link.sessionName} answered your question`
          : `${link.sessionName} replied`;
      const text = `${lead}: ${answer.text}`;
      const quiet = !this.deps.voiceActive();
      this.tracker.remove(link.actionId);
      this.deps.addAnswer({
        askId: link.actionId,
        serverId: link.serverId,
        sessionId: link.sessionId,
        sessionName: link.sessionName,
        headline: text,
        priority: asking ? 'blocked' : 'finished',
        createdAt: this.deps.now(),
        // Spoken right away in a voice exchange: already heard (no tone, not re-briefed).
        heard: !quiet,
      });
      this.emit({ text, ref: refOf(link), quiet });
      this.deps.persist();
    } catch (err) {
      this.deps.log?.(
        `Herald: checking ${link.sessionName}'s reply failed: ${err instanceof Error ? err.message : String(err)}`
      );
      this.tracker.release(link.actionId);
    }
  }

  private emit(p: AskPost): void {
    // A spoken announcement must not cut off a reply that is streaming.
    if (!p.quiet && this.deps.busy()) this.queue.push(p);
    else this.deps.post(p);
  }

  /** The brain turn ended: post what waited for it. */
  flush(): void {
    const q = this.queue.splice(0);
    for (const p of q) this.deps.post(p);
  }

  /** Tests: wait for background answer composition. */
  async settle(): Promise<void> {
    while (this.inFlight.size) await Promise.all(Array.from(this.inFlight));
  }
}

function refOf(l: AskLink) {
  return { serverId: l.serverId, sessionId: l.sessionId, sessionName: l.sessionName };
}
