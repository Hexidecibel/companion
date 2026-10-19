/**
 * Background work: the main Claude thread ended its turn (the transcript says
 * "waiting for input") while background subagents or background shells it
 * started keep running. Such a session is reported as WORKING with an optional
 * `backgroundWork: { agents, shells }` (and currentActivity like "2 agents
 * running"), never as waiting: no needs-input notification, escalation, Herald
 * "is asking" or babysitter prompt fires until the work is done and the main
 * thread is still idle.
 *
 * Also: in bypass-permissions mode a pending Bash / Edit / Write is RUNNING,
 * not awaiting approval (the transcript cannot tell the two apart; after 3 s
 * the watcher calls it waiting). The pane footer says whether bypass is on.
 *
 * Sources (no new subprocesses):
 *  - agents: the subagent tracker (running = starting / running / waiting_child);
 *  - shells + bypass: the prompt footer of pane captures that already happen
 *    (Herald's listing captures the 12 most recent sessions every few seconds),
 *    fed through `noteCapture`. Best effort: no fresh capture = unknown.
 *
 * Verified footer (Claude Code 2.1.303, idle main thread, one background shell
 * + one background agent):
 *
 *   ────────────────────────────────── (rule)
 *   ❯
 *   ────────────────────────────────── (rule)
 *     ⏵⏵ bypass permissions on · 2 shells · ↓ to manage
 *     ● main
 *     ◯ general-purpose  Sleep 200 then reply ok        30s · ↓ 37.8k tokens
 */
import type { ConversationMessage } from './types';
import { stripAnsi } from './prompt-guard';

export interface BackgroundWork {
  agents: number;
  shells: number;
}

export interface PaneFooterInfo {
  /** Background shells the footer reports ("2 shells"); 0 when none shown. */
  shells: number;
  /** "bypass permissions on" is shown: tools never wait for approval. */
  bypass: boolean;
}

const RULE_RE = /^\s*─{10,}\s*$/;
const MAX_FOOTER_LINES = 40;
/** A footer reading older than this is unknown. */
export const FOOTER_TTL_MS = 30_000;
/**
 * Background shells alone (no agent) keep a session "working" at most this long
 * after its turn ended: a dev server started in the background must not hide a
 * finished session forever.
 */
export const SHELL_ONLY_MAX_MS = 20 * 60_000;

const APPROVAL_LIKE = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const INTERACTIVE = new Set(['AskUserQuestion', 'ExitPlanMode']);

/** Parse the footer under Claude Code's prompt box. null = no prompt box at the bottom. */
export function parsePaneFooter(capture: string): PaneFooterInfo | null {
  if (!capture) return null;
  const plain = capture.replace(/\r/g, '').split('\n').map(stripAnsi);
  let end = plain.length - 1;
  while (end >= 0 && plain[end].trim() === '') end--;
  let bottom = -1;
  let below = 0;
  for (let i = end; i >= 0; i--) {
    if (RULE_RE.test(plain[i])) {
      bottom = i;
      break;
    }
    if (plain[i].trim() !== '') below++;
    if (below > MAX_FOOTER_LINES) return null;
  }
  if (bottom < 1) return null;
  // The prompt box: a rule above the bottom one whose first inner line starts with the marker.
  let top = -1;
  for (let i = bottom - 1; i >= 0 && i >= bottom - 30; i--) {
    if (RULE_RE.test(plain[i])) {
      top = i;
      break;
    }
  }
  if (top < 0 || top === bottom - 1) return null;
  if (!/^\s*[❯>!#]/.test(plain[top + 1])) return null;
  const footer = plain.slice(bottom + 1, end + 1).join('\n');
  let shells = 0;
  const m = /(\d+)\s+(?:background\s+)?(?:shells?|bash(?:es)?)\b/i.exec(footer);
  if (m) shells = Number(m[1]) || 0;
  return { shells, bypass: /bypass permissions on/i.test(footer) };
}

export function backgroundWorkLabel(bg: BackgroundWork): string {
  const parts: string[] = [];
  if (bg.agents > 0) parts.push(`${bg.agents} agent${bg.agents === 1 ? '' : 's'}`);
  if (bg.shells > 0) parts.push(`${bg.shells} shell${bg.shells === 1 ? '' : 's'}`);
  return `${parts.join(', ')} running`;
}

export interface SessionOverlayInput {
  /** The transcript-derived waiting flag. */
  waiting: boolean;
  messages: ConversationMessage[] | null | undefined;
  currentActivity?: string;
  /** Running subagents of this session (tracker). */
  agents: number;
  /** Fresh pane footer, or null when unknown. */
  footer: PaneFooterInfo | null;
  now: number;
}

export interface SessionOverlay {
  /** Effective waiting flag (false while background work runs). */
  waiting: boolean;
  backgroundWork?: BackgroundWork;
  /** Replacement activity text, when the overlay applies. */
  currentActivity?: string;
}

/**
 * Pure: the effective state of a session whose transcript says `waiting`.
 * Genuine waits always stay waits: a pending AskUserQuestion / ExitPlanMode,
 * or a pending Bash/Edit/Write outside bypass mode (a permission prompt).
 */
export function overlaySessionState(input: SessionOverlayInput): SessionOverlay {
  if (!input.waiting) return { waiting: false };
  const msgs = input.messages || [];
  const last = msgs[msgs.length - 1];
  const pending =
    last?.type === 'assistant'
      ? (last.toolCalls || []).filter((tc) => tc.status === 'pending')
      : [];
  if (pending.some((tc) => INTERACTIVE.has(tc.name))) return { waiting: true };
  if (pending.some((tc) => APPROVAL_LIKE.has(tc.name))) {
    // Bypass mode never asks: the tool is running.
    if (input.footer?.bypass) {
      const act = input.currentActivity || '';
      return {
        waiting: false,
        currentActivity: act.startsWith('Approve? ')
          ? `Running: ${act.slice(9)}`
          : act || 'Running a tool',
      };
    }
    return { waiting: true };
  }
  const agents = Math.max(0, input.agents | 0);
  let shells = Math.max(0, input.footer?.shells ?? 0);
  if (agents === 0 && shells > 0) {
    const endedAt = last?.timestamp || 0;
    if (endedAt > 0 && input.now - endedAt > SHELL_ONLY_MAX_MS) shells = 0;
  }
  if (agents === 0 && shells === 0) return { waiting: true };
  const backgroundWork = { agents, shells };
  return { waiting: false, backgroundWork, currentActivity: backgroundWorkLabel(backgroundWork) };
}

export interface BackgroundWorkDeps {
  /** Running subagents for a session (tmux session name). */
  runningAgents(sessionId: string): number;
  now?: () => number;
}

/** Live source the watcher / websocket / Herald share. In-memory only. */
export class BackgroundWorkMonitor {
  private footers = new Map<string, { info: PaneFooterInfo | null; at: number }>();
  private now: () => number;

  constructor(private deps: BackgroundWorkDeps) {
    this.now = deps.now || Date.now;
  }

  /** Feed a pane capture that was taken anyway (never capture just for this). */
  noteCapture(sessionId: string, capture: string): void {
    if (!sessionId) return;
    this.footers.set(sessionId, { info: parsePaneFooter(capture), at: this.now() });
    if (this.footers.size > 200) {
      const cutoff = this.now() - FOOTER_TTL_MS;
      for (const [k, v] of this.footers) if (v.at < cutoff) this.footers.delete(k);
    }
  }

  footer(sessionId: string): PaneFooterInfo | null {
    const f = this.footers.get(sessionId);
    if (!f || this.now() - f.at > FOOTER_TTL_MS) return null;
    return f.info;
  }

  agents(sessionId: string): number {
    try {
      return this.deps.runningAgents(sessionId) || 0;
    } catch {
      return 0;
    }
  }

  overlay(
    sessionId: string,
    waiting: boolean,
    messages: ConversationMessage[] | null | undefined,
    currentActivity?: string
  ): SessionOverlay {
    if (!waiting) return { waiting: false };
    return overlaySessionState({
      waiting,
      messages,
      currentActivity,
      agents: this.agents(sessionId),
      footer: this.footer(sessionId),
      now: this.now(),
    });
  }
}
