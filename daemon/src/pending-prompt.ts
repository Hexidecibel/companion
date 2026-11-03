/**
 * What a session is asking the user right now, from the caches only (the
 * transcript and the last pane capture). Shared by the server summary
 * (Mission Control tiles), send_choice's stale-prompt check and Herald, so all
 * of them see the same prompt and the same signature.
 */

import { getPendingApprovalTools } from './parser';
import { defaultAgent, type AgentAdapter } from './agents';
import type { ConversationMessage, PendingPrompt, TerminalChoicePrompt } from './types';
import { fnv1a, oneLine, clip, flattenMarkdown } from './herald/text';

export type { PendingPrompt } from './types';

export interface PendingApproval {
  tool: string;
  detail: string;
  /** tool_use id: unique per approval occurrence. */
  toolUseId: string;
}

/** Live choice box from a pane, normalized (Herald's PendingChoice shape). */
export interface NormalizedChoice {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
  /** Stable signature of (header, question, option labels) — detects a changed prompt. */
  signature: string;
  /** The agent's start-up "Trust this folder?" prompt: only the user answers it. */
  trust?: boolean;
}

export const LAST_MESSAGE_MAX = 140;

export function choiceSignature(q: {
  header?: string;
  question?: string;
  options: Array<{ label: string }>;
}): string {
  return fnv1a([q.header || '', q.question || '', ...q.options.map((o) => o.label)].join('\u0001'));
}

export function approvalDetail(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  const pick = ['command', 'file_path', 'path', 'url', 'pattern', 'description', 'plan'];
  for (const k of pick) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return clip(oneLine(v), 300);
  }
  return '';
}

/** The first tool approval the transcript's last message waits on, else null. */
export function derivePendingApproval(
  messages: ConversationMessage[],
  agent: AgentAdapter = defaultAgent()
): PendingApproval | null {
  const last = messages[messages.length - 1];
  if (!last || last.type !== 'assistant') return null;
  const pendingTools =
    agent === defaultAgent()
      ? getPendingApprovalTools(messages)
      : agent.transcript.getPendingApprovalTools(messages);
  if (pendingTools.length === 0) return null;
  const tc = last.toolCalls?.find((t) => t.id === pendingTools[0].id);
  return {
    tool: pendingTools[0].name,
    detail: approvalDetail(tc?.input),
    toolUseId: pendingTools[0].id,
  };
}

/** A pane's choice box as a normalized prompt (null when not a real choice). */
export function normalizeChoice(
  choice: TerminalChoicePrompt | null | undefined
): NormalizedChoice | null {
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
    ...(choice.kind === 'trust' ? { trust: true } : {}),
  };
}

/** Last non-empty line of the latest assistant text (flattened, clipped). */
export function lastAssistantLine(
  messages: ConversationMessage[] | null | undefined,
  max = LAST_MESSAGE_MAX
): string | undefined {
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0 && i >= messages.length - 50; i--) {
    const m = messages[i];
    if (m.type !== 'assistant' || !(m.content || '').trim()) continue;
    // Code is not a status line: drop closed fences, and an unclosed trailing
    // one, so the line shown is the last prose line before the code.
    const lines = m.content
      .replace(/```[\s\S]*?```/g, '\n')
      .replace(/```[\s\S]*$/, '\n')
      .split('\n');
    for (let j = lines.length - 1; j >= 0; j--) {
      const line = oneLine(flattenMarkdown(lines[j]));
      if (line && !/^```/.test(line)) return clip(line, max);
    }
    return undefined;
  }
  return undefined;
}

/** Text that reads like a tool-permission box ("Do you want to ...?"). */
function looksLikePermission(c: NormalizedChoice, agent: AgentAdapter): boolean {
  if (agent.id === 'codex') return true; // Codex's only choice box is its approval box
  const q = oneLine([c.header, c.question].filter(Boolean).join(' '));
  if (/\bdo you want to\b|\bwould you like to (?:run|make|proceed)\b/i.test(q)) return true;
  const rendered = `${c.question}\n${c.options.map((o, i) => `${i + 1}. ${o.label}`).join('\n')}`;
  try {
    return agent.terminal.parsePermissionPrompt(rendered) !== null;
  } catch {
    return false;
  }
}

function fromChoice(c: NormalizedChoice, kind: PendingPrompt['kind']): PendingPrompt {
  return {
    kind,
    question: c.question,
    ...(c.header ? { header: c.header } : {}),
    options: c.options.map((o) => ({
      label: o.label,
      ...(o.description ? { description: o.description } : {}),
    })),
    ...(c.multiSelect ? { multiSelect: true } : {}),
    signature: c.signature,
  };
}

export interface PendingPromptInputs {
  messages: ConversationMessage[] | null | undefined;
  agent: AgentAdapter;
  /** The agent's start-up prompt (trust) currently on screen. */
  trust?: TerminalChoicePrompt | null;
  /** The last (still fresh) choice box seen on the session's pane. */
  paneChoice?: TerminalChoicePrompt | null;
}

/**
 * The prompt a session waits on, in this order: start-up trust prompt, a tool
 * approval in the transcript (with the pane's on-screen options when a box is
 * known), a pending AskUserQuestion in the transcript, then the live choice box
 * from the last pane capture.
 */
export function buildPendingPrompt(inp: PendingPromptInputs): PendingPrompt | null {
  if (inp.trust) {
    const c = normalizeChoice(inp.trust);
    if (c) return fromChoice(c, 'trust');
  }
  const messages = inp.messages || [];
  const last = messages[messages.length - 1];
  const pane = normalizeChoice(
    inp.paneChoice && inp.paneChoice.kind !== 'trust' ? inp.paneChoice : null
  );

  const approval = derivePendingApproval(messages, inp.agent);
  if (approval) {
    const question = approval.detail
      ? `${approval.tool}: ${approval.detail}`
      : `Allow ${approval.tool}?`;
    // The pane is the source of truth for what an index means: Claude Code's
    // permission box has more rows than the transcript's yes / always / no
    // (e.g. "Yes, and switch to auto mode"), so a transcript index can select
    // the wrong row. Transcript options are only a fallback when no box is
    // known, and clients answer those by label (send_choice.selectedLabels).
    const src = pane ? pane.options : (last?.options || []).filter((o) => o && o.label);
    if (src.length >= 2) {
      const options = src.map((o) => ({
        label: o.label,
        ...(o.description ? { description: o.description } : {}),
      }));
      return {
        kind: 'approval',
        question,
        header: approval.tool,
        options,
        signature: choiceSignature({
          header: `approval:${approval.toolUseId}`,
          question,
          options,
        }),
      };
    }
  }

  if (last?.type === 'assistant' && last.isWaitingForChoice) {
    const qs = (last.questions || []).filter((q) => q && q.options && q.options.length >= 2);
    if (qs.length > 0) {
      const q = qs[0];
      const options = q.options.map((o) => ({
        label: o.label,
        ...(o.description ? { description: o.description } : {}),
      }));
      return {
        kind: 'choice',
        question: q.question || 'Select an option',
        ...(q.header ? { header: q.header } : {}),
        options,
        ...(q.multiSelect ? { multiSelect: true } : {}),
        ...(qs.length > 1 ? { questionCount: qs.length } : {}),
        signature: choiceSignature({ header: q.header, question: q.question, options }),
      };
    }
  }

  if (pane) return fromChoice(pane, looksLikePermission(pane, inp.agent) ? 'approval' : 'choice');
  return null;
}

/** Normalized label for matching: lowercase, no key hints like "(esc)", single spaces. */
export function normalizeChoiceLabel(label: string): string {
  return oneLine(label)
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/[.!?:]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The transcript's "always allow" label (parser.ts) and its on-screen spellings. */
const ALWAYS_ALLOW_LABEL = /^yes, and don't ask again\b/;
const ALWAYS_ALLOW_ON_SCREEN =
  /^yes, (?:always allow|allow all|and always allow|and don't ask again)\b/;

/**
 * Resolve labels the user tapped to indices of the options ON SCREEN. Exact
 * (normalized) match first; else, for a one-word label, a unique option that
 * starts with it as a whole word ("no" -> "No, and tell Claude what to do differently"); the
 * transcript's "yes, and don't ask again" maps to a unique "always allow" row.
 * Null when any label is unknown or ambiguous: the caller must send nothing.
 */
export function resolveChoiceLabels(
  labels: string[],
  options: Array<{ label: string }>
): number[] | null {
  if (labels.length === 0) return null;
  const norm = options.map((o) => normalizeChoiceLabel(o.label));
  const out: number[] = [];
  for (const raw of labels) {
    if (typeof raw !== 'string') return null;
    const want = normalizeChoiceLabel(raw);
    if (!want) return null;
    let hits = norm.flatMap((n, i) => (n === want ? [i] : []));
    // Prefix only for a one-word answer ("no" -> "No, and tell Claude ..."):
    // a partial phrase like "yes, and" must never pick a row.
    if (hits.length === 0 && /^[a-z']+$/.test(want)) {
      hits = norm.flatMap((n, i) =>
        n.startsWith(want) && /^[\s,.;:-]/.test(n.slice(want.length)) ? [i] : []
      );
    }
    if (hits.length === 0 && ALWAYS_ALLOW_LABEL.test(want)) {
      hits = norm.flatMap((n, i) => (ALWAYS_ALLOW_ON_SCREEN.test(n) ? [i] : []));
    }
    if (hits.length !== 1) return null;
    out.push(hits[0]);
  }
  return out;
}
