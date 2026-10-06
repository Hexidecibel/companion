/**
 * SessionSource: Herald's read/act surface over coding sessions.
 *
 * The interface is deliberately transport-agnostic so a fleet (multi-daemon)
 * implementation can plug in later; LocalSessionSource reads this daemon's
 * watcher + tmux panes and acts through the existing InputInjector path.
 */

import { execFile } from 'child_process';
import * as path from 'path';
import {
  classifyLocalCommands,
  detectActiveChoicePrompt,
  getPendingApprovalTools,
  parseLocalCommandPart,
} from '../parser';
import type { ConversationMessage } from '../types';
import { detectTurnEndError } from '../turn-error';
import { BoundedMap } from '../utils';
import { fnv1a, oneLine, clip, trailingQuestion } from './text';

export type HeraldSessionStatus = 'working' | 'waiting' | 'idle';

export interface PendingChoice {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
  /** Stable signature of (header, question, option labels) — detects a changed prompt. */
  signature: string;
}

export interface PendingApproval {
  tool: string;
  detail: string;
  /** tool_use id: unique per approval occurrence. */
  toolUseId: string;
}

export interface SessionSnapshot {
  serverId: string;
  /** Stable id within the server (tmux session name for the local source). */
  sessionId: string;
  /** Display name: user-assigned friendly name, else tmux name. */
  sessionName: string;
  tmuxName: string;
  projectPath: string;
  projectName: string;
  status: HeraldSessionStatus;
  inactive: boolean;
  lastActivity: number;
  currentActivity?: string;
  /** Live multiple-choice prompt on the terminal (AskUserQuestion / permission box). */
  pendingChoice: PendingChoice | null;
  /** Pending tool approval visible in the transcript. */
  pendingApproval: PendingApproval | null;
  /** The finished turn ended by asking the user something. */
  pendingQuestion: string | null;
  /** Identity of the most recent assistant turn (dedupe key for "finished"). */
  lastTurnKey: string | null;
  /** Deterministic one-line gist of the last assistant turn (for headlines). */
  lastTurnGist: string | null;
  /**
   * The finished turn ended on an unresolved tool error (turn-error.ts): the
   * tool and its first error line (redacted). Absent / null otherwise.
   */
  turnError?: { tool: string; line: string } | null;
}

export interface TranscriptTurn {
  role: 'user' | 'assistant';
  text: string;
  at: number;
}

export interface RecentTranscript {
  lastUserPrompt: TranscriptTurn | null;
  /** Assistant turns, oldest first (a turn = consecutive assistant messages). */
  assistantTurns: TranscriptTurn[];
}

/** One user prompt and the session's reply to it (consecutive assistant text). */
export interface TranscriptExchange {
  prompt: string;
  promptAt: number;
  reply: string;
  /** Time of the last assistant message of the reply (absent: no reply yet). */
  replyAt?: number;
}

export interface SessionSource {
  readonly serverId: string;
  listSessions(): Promise<SessionSnapshot[]>;
  getRecentTranscript(sessionId: string, maxTurns: number): Promise<RecentTranscript>;
  /**
   * Fresh (uncached) read of the live choice prompt — used to re-validate before
   * sending. Must REJECT when the screen cannot be read (never resolve null).
   */
  getLiveChoice(sessionId: string): Promise<PendingChoice | null>;
  sessionExists(sessionId: string): Promise<boolean>;
  sendText(sessionId: string, text: string, tag: string): Promise<boolean>;
  sendChoice(
    sessionId: string,
    index: number,
    optionCount: number,
    multiSelect: boolean
  ): Promise<boolean>;
  /** Prompt/reply pairs whose prompt is at or after `sinceMs`, oldest first (ask-and-report). */
  getExchangesSince?(sessionId: string, sinceMs: number): Promise<TranscriptExchange[]>;
  /** Interrupt the running turn (Ctrl+C). */
  interrupt?(sessionId: string): Promise<boolean>;
  /**
   * Sessions whose live prompt must be read on every listing, whatever the
   * capture cap (babysat sessions: a prompt nobody reads is never answered).
   */
  setPinnedSessions?(sessionIds: string[]): void;
}

// ---------------------------------------------------------------------------

export function choiceSignature(q: {
  header?: string;
  question?: string;
  options: Array<{ label: string }>;
}): string {
  return fnv1a([q.header || '', q.question || '', ...q.options.map((o) => o.label)].join('\u0001'));
}

/**
 * Entries that are not prompts to the model: a directly-run slash command
 * (`/login`), its caveat and its output. Skill triggers stay (unchanged
 * behaviour). Only the tail that the bounded scans below can reach is
 * classified.
 */
function localCommandIndices(messages: ConversationMessage[]): Set<number> {
  const TAIL = 700;
  const start = Math.max(0, messages.length - TAIL);
  const tail = messages.slice(start);
  const { hidden, markers } = classifyLocalCommands(tail);
  const out = new Set<number>();
  for (const i of hidden) {
    if (parseLocalCommandPart(tail[i].content)?.kind !== 'command') out.add(i + start);
  }
  for (const i of markers.keys()) out.add(i + start);
  return out;
}

/** Split messages into the last user prompt + trailing assistant turns. */
export function extractRecentTranscript(
  messages: ConversationMessage[],
  maxTurns: number
): RecentTranscript {
  const turns: TranscriptTurn[] = [];
  let lastUserPrompt: TranscriptTurn | null = null;
  let current: TranscriptTurn | null = null;
  const plumbing = localCommandIndices(messages);
  // Walk backwards so we can stop early on huge transcripts.
  const LIMIT_SCAN = 400;
  let scanned = 0;
  for (let i = messages.length - 1; i >= 0 && scanned < LIMIT_SCAN; i--, scanned++) {
    const m = messages[i];
    if (plumbing.has(i)) continue;
    if (m.type === 'assistant') {
      const text = (m.content || '').trim();
      if (!text) continue;
      if (!current) current = { role: 'assistant', text, at: m.timestamp };
      else current.text = `${text}\n\n${current.text}`;
    } else if (m.type === 'user') {
      const text = (m.content || '').trim();
      if (!text) continue;
      if (current) {
        turns.unshift(current);
        current = null;
      }
      if (!lastUserPrompt) lastUserPrompt = { role: 'user', text, at: m.timestamp };
      if (turns.length >= maxTurns) break;
    }
  }
  if (current && turns.length < maxTurns) turns.unshift(current);
  return { lastUserPrompt, assistantTurns: turns.slice(-maxTurns) };
}

/**
 * Prompt/reply pairs from `sinceMs` on, oldest first. A reply is the assistant
 * text between a prompt and the next one (tool results carry no text and do not
 * split it). Bounded scan from the end.
 */
export function extractExchanges(
  messages: ConversationMessage[],
  sinceMs: number,
  maxExchanges = 6
): TranscriptExchange[] {
  const out: TranscriptExchange[] = [];
  let reply: string[] = [];
  let replyAt: number | undefined;
  const LIMIT_SCAN = 600;
  let scanned = 0;
  const plumbing = localCommandIndices(messages);
  for (let i = messages.length - 1; i >= 0 && scanned < LIMIT_SCAN; i--, scanned++) {
    const m = messages[i];
    if (plumbing.has(i)) continue;
    const text = (m.content || '').trim();
    if (!text) continue;
    if (m.type === 'assistant') {
      reply.unshift(text);
      if (replyAt === undefined) replyAt = m.timestamp;
    } else if (m.type === 'user') {
      if (m.timestamp < sinceMs) break;
      out.unshift({
        prompt: text,
        promptAt: m.timestamp,
        reply: reply.join('\n\n'),
        ...(replyAt !== undefined ? { replyAt } : {}),
      });
      reply = [];
      replyAt = undefined;
      if (out.length >= maxExchanges) break;
    }
  }
  return out;
}

function approvalDetail(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  const pick = ['command', 'file_path', 'path', 'url', 'pattern', 'description', 'plan'];
  for (const k of pick) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return clip(oneLine(v), 300);
  }
  return '';
}

// ---------------------------------------------------------------------------

const TRANSCRIPT_LOAD_RETRY_MS = 30_000;

interface ServerSummarySession {
  id: string;
  name: string;
  projectPath: string;
  status: 'idle' | 'working' | 'waiting' | 'error';
  lastActivity: number;
  currentActivity?: string;
  tmuxSessionName?: string;
  inactive?: boolean;
}

export interface LocalSourceDeps {
  watcher: {
    getServerSummary(): Promise<{ sessions: ServerSummarySession[] }>;
    getMessages(sessionId?: string): ConversationMessage[];
    /**
     * Load a session's transcript on demand. After a daemon start the watcher only
     * tracks recently modified files, so idle sessions have no messages until
     * something asks for them.
     */
    ensureConversationLoaded?(sessionId: string, opts?: { quiet?: boolean }): boolean;
  };
  injector: {
    sendInput(input: string, targetSession?: string): Promise<boolean>;
    sendChoice(
      selectedIndices: number[],
      optionCount: number,
      multiSelect: boolean,
      otherText: string | undefined,
      targetSession?: string
    ): Promise<boolean>;
    checkSessionExists(sessionName?: string): Promise<boolean>;
    /** Ctrl+C into the session (interrupt). */
    cancelInput?(targetSession?: string): Promise<boolean>;
  };
  sessionNames: { getAll(): Record<string, string> };
  /** Override for tests; defaults to `tmux capture-pane` with a hard timeout. */
  capturePane?: (tmuxName: string) => Promise<string>;
  /** Called after a successful send (pending-sent bookkeeping, escalation ack). */
  onSent?: (tmuxName: string, text: string, tag: string) => void;
}

const PANE_CAPTURE_TIMEOUT_MS = 2500;
const PANE_CAPTURE_LINES = 60;
/** Cap on panes captured per listing (most recently active live sessions first). */
export const MAX_PANE_CAPTURES = 12;

/** Capture a pane. Rejects on failure (timeout, missing session) so callers can fail closed. */
export function defaultCapturePane(tmuxName: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'tmux',
      ['capture-pane', '-p', '-t', tmuxName, '-S', `-${PANE_CAPTURE_LINES}`],
      { timeout: PANE_CAPTURE_TIMEOUT_MS, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout || '')))
    );
  });
}

interface DerivedTurnInfo {
  pendingApproval: PendingApproval | null;
  pendingQuestion: string | null;
  lastTurnKey: string | null;
  lastTurnGist: string | null;
  turnError: { tool: string; line: string } | null;
}

export class LocalSessionSource implements SessionSource {
  readonly serverId = 'local';
  private deps: LocalSourceDeps;
  private capture: (tmuxName: string) => Promise<string>;
  // Transcript-derived info memoized per (session, lastActivity) so polling never
  // re-parses an unchanged conversation.
  private derivedCache = new BoundedMap<string, { key: number; info: DerivedTurnInfo }>(256);
  private listInFlight: Promise<SessionSnapshot[]> | null = null;
  /** Last on-demand transcript load attempt per session (throttles retries). */
  private loadAttempts = new BoundedMap<string, number>(256);
  /** Sessions always inside the pane-capture set (see setPinnedSessions). */
  private pinned = new Set<string>();

  constructor(deps: LocalSourceDeps) {
    this.deps = deps;
    this.capture = deps.capturePane || defaultCapturePane;
  }

  listSessions(): Promise<SessionSnapshot[]> {
    // Share one in-flight listing between concurrent callers (poll + tool calls).
    if (this.listInFlight) return this.listInFlight;
    const p = this.doListSessions().finally(() => {
      this.listInFlight = null;
    });
    this.listInFlight = p;
    return p;
  }

  private derive(sessionId: string, lastActivity: number): DerivedTurnInfo {
    const cached = this.derivedCache.get(sessionId);
    if (cached && cached.key === lastActivity) return cached.info;
    let info: DerivedTurnInfo = {
      pendingApproval: null,
      pendingQuestion: null,
      lastTurnKey: null,
      lastTurnGist: null,
      turnError: null,
    };
    try {
      const messages = this.messagesFor(sessionId);
      const last = messages[messages.length - 1];
      const pendingTools = getPendingApprovalTools(messages);
      let pendingApproval: PendingApproval | null = null;
      if (pendingTools.length > 0 && last?.type === 'assistant') {
        const tc = last.toolCalls?.find((t) => t.id === pendingTools[0].id);
        pendingApproval = {
          tool: pendingTools[0].name,
          detail: approvalDetail(tc?.input),
          toolUseId: pendingTools[0].id,
        };
      }
      let lastAssistant: ConversationMessage | undefined;
      for (let i = messages.length - 1; i >= 0 && i >= messages.length - 50; i--) {
        if (messages[i].type === 'assistant' && (messages[i].content || '').trim()) {
          lastAssistant = messages[i];
          break;
        }
      }
      const lastIsAssistant = last?.type === 'assistant';
      const te = detectTurnEndError(messages);
      info = {
        pendingApproval,
        pendingQuestion:
          lastIsAssistant && lastAssistant ? trailingQuestion(lastAssistant.content) : null,
        lastTurnKey: lastAssistant ? `${lastAssistant.id}:${lastAssistant.timestamp}` : null,
        lastTurnGist: lastAssistant ? lastAssistant.content : null,
        turnError: te ? { tool: te.tool, line: te.line } : null,
      };
    } catch (err) {
      console.error(`Herald: failed to derive turn info for "${sessionId}":`, err);
    }
    // Only memoize a real read: an empty result (transcript not loaded yet) is retried next poll.
    if (info.lastTurnKey || info.pendingApproval)
      this.derivedCache.set(sessionId, { key: lastActivity, info });
    return info;
  }

  /** Messages for a session, loading its transcript on demand if the watcher skipped it. */
  private messagesFor(sessionId: string): ConversationMessage[] {
    const messages = this.deps.watcher.getMessages(sessionId);
    if (messages.length > 0 || !this.deps.watcher.ensureConversationLoaded) return messages;
    const now = Date.now();
    const last = this.loadAttempts.get(sessionId);
    if (last !== undefined && now - last < TRANSCRIPT_LOAD_RETRY_MS) return messages;
    this.loadAttempts.set(sessionId, now);
    try {
      // Quiet: loading an old transcript must not look like new activity (no
      // notifications / escalation / auto-approval for a stale prompt).
      if (!this.deps.watcher.ensureConversationLoaded(sessionId, { quiet: true })) return messages;
    } catch (err) {
      console.error(`Herald: loading transcript for "${sessionId}" failed:`, err);
      return messages;
    }
    return this.deps.watcher.getMessages(sessionId);
  }

  private async doListSessions(): Promise<SessionSnapshot[]> {
    const summary = await this.deps.watcher.getServerSummary();
    const names = this.deps.sessionNames.getAll();
    const sessions = summary.sessions || [];

    // Capture panes for the most recently active live sessions only; pinned
    // (babysat) sessions come first, so the cap never drops them.
    const isPinned = (s: ServerSummarySession) =>
      this.pinned.has(s.id) || (!!s.tmuxSessionName && this.pinned.has(s.tmuxSessionName));
    const liveByRecency = sessions
      .filter((s) => !s.inactive)
      .sort(
        (a, b) => Number(isPinned(b)) - Number(isPinned(a)) || b.lastActivity - a.lastActivity
      )
      .slice(0, MAX_PANE_CAPTURES);
    const choices = new Map<string, PendingChoice | null>();
    await Promise.all(
      liveByRecency.map(async (s) => {
        choices.set(s.id, await this.readChoice(s.tmuxSessionName || s.id));
      })
    );

    const out: SessionSnapshot[] = [];
    for (const s of sessions) {
      const tmuxName = s.tmuxSessionName || s.id;
      const pendingChoice = choices.get(s.id) || null;
      // Transcript-derived state only matters for live, non-working sessions.
      const derived =
        s.inactive || (s.status === 'working' && !pendingChoice)
          ? null
          : this.derive(s.id, s.lastActivity);
      const pendingApproval = derived?.pendingApproval || null;
      const pendingQuestion = derived?.pendingQuestion || null;
      let status: HeraldSessionStatus;
      if (pendingChoice || pendingApproval) status = 'waiting';
      else if (s.status === 'working') status = 'working';
      else if (pendingQuestion && s.status === 'waiting') status = 'waiting';
      else status = 'idle';
      const projectPath = s.projectPath || '';
      out.push({
        serverId: this.serverId,
        sessionId: s.id,
        sessionName: names[s.id] || s.name || s.id,
        tmuxName,
        projectPath,
        projectName: projectPath ? path.basename(projectPath) : '',
        status,
        inactive: Boolean(s.inactive),
        lastActivity: s.lastActivity || 0,
        currentActivity: s.currentActivity,
        pendingChoice,
        pendingApproval,
        pendingQuestion:
          status === 'waiting' && !pendingChoice && !pendingApproval ? pendingQuestion : null,
        lastTurnKey: derived?.lastTurnKey || null,
        lastTurnGist: derived?.lastTurnGist || null,
        turnError: status === 'idle' ? derived?.turnError || null : null,
      });
    }
    return out;
  }

  /**
   * Parse the live choice prompt from a pane. For listings a failed capture just
   * means "no prompt known"; with `strict` (pre-send re-validation) it throws, so
   * an unreadable pane can never be mistaken for "no prompt on screen" and let
   * free text be typed into a choice box.
   */
  private async readChoice(tmuxName: string, strict = false): Promise<PendingChoice | null> {
    let pane: string;
    try {
      pane = await this.capture(tmuxName);
    } catch {
      if (strict) throw new Error(`could not read ${tmuxName}'s screen to re-check it`);
      return null;
    }
    try {
      if (!pane) {
        if (strict) throw new Error(`${tmuxName}'s screen came back empty`);
        return null;
      }
      const choice = detectActiveChoicePrompt(pane);
      if (!choice || choice.options.length < 2) return null;
      const options = choice.options.map((o) => ({
        label: o.label,
        description: o.description || undefined,
      }));
      return {
        question: choice.question || 'Select an option',
        header: choice.header || undefined,
        options,
        multiSelect: Boolean(choice.multiSelect),
        signature: choiceSignature({ header: choice.header, question: choice.question, options }),
      };
    } catch (err) {
      if (strict) throw err;
      return null;
    }
  }

  async getRecentTranscript(sessionId: string, maxTurns: number): Promise<RecentTranscript> {
    return extractRecentTranscript(this.messagesFor(sessionId), maxTurns);
  }

  async getExchangesSince(sessionId: string, sinceMs: number): Promise<TranscriptExchange[]> {
    return extractExchanges(this.messagesFor(sessionId), sinceMs);
  }

  async interrupt(sessionId: string): Promise<boolean> {
    if (!this.deps.injector.cancelInput) return false;
    return this.deps.injector.cancelInput(sessionId);
  }

  setPinnedSessions(sessionIds: string[]): void {
    this.pinned = new Set(sessionIds.slice(0, MAX_PANE_CAPTURES));
  }

  getLiveChoice(sessionId: string): Promise<PendingChoice | null> {
    return this.readChoice(sessionId, true);
  }

  sessionExists(sessionId: string): Promise<boolean> {
    return this.deps.injector.checkSessionExists(sessionId);
  }

  async sendText(sessionId: string, text: string, tag: string): Promise<boolean> {
    const ok = await this.deps.injector.sendInput(text, sessionId);
    if (ok) this.deps.onSent?.(sessionId, text, tag);
    return ok;
  }

  async sendChoice(
    sessionId: string,
    index: number,
    optionCount: number,
    multiSelect: boolean
  ): Promise<boolean> {
    const ok = await this.deps.injector.sendChoice(
      [index],
      optionCount,
      multiSelect,
      undefined,
      sessionId
    );
    if (ok) this.deps.onSent?.(sessionId, '', 'choice');
    return ok;
  }
}
