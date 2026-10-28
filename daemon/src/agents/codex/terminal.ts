/**
 * Codex CLI's terminal side (read-only in step 2): the approval box parser
 * that the existing pane-capture paths use to surface "waiting for approval",
 * plus the trivially right bits (launch line, start-up screen). Answering a
 * choice (key sequences) and the prompt-box guard are step 3.
 *
 * The approval box as Codex 0.165 draws it:
 *
 *     Would you like to run the following command?
 *
 *     Environment: local
 *
 *     Reason: May I read the repository files outside the sandbox?
 *
 *     $ pwd && ls -la
 *
 *   › 1. Yes, proceed (y)
 *     2. Yes, and don't ask again for commands that start with `pwd` (p)
 *     3. No, and tell Codex what to do differently (esc)
 *
 *     Press enter to confirm or esc to cancel
 */
import { stripAnsi } from '../../prompt-guard';
import type { TerminalChoicePrompt } from '../../types';
import type {
  AgentTerminal,
  ChoiceKeyPlan,
  ChoiceRequest,
  PermissionPrompt,
  StartupPaneState,
  TextChoicePrompt,
} from '../types';

/** Codex has no permission-mode switch the app uses yet. */
export type CodexPermissionMode = never;

const QUESTION_RE = /^(Would you like to .+\?|Do you want to .+\?|Allow .+\?|Approve .+\?)\s*$/i;
const OPTION_RE = /^(?:[›❯>]\s*)?(\d{1,2})\.\s+(.+?)\s*$/;
/** Trailing hotkey hint: "(y)", "(esc)", "(p)". */
const HOTKEY_RE = /\s*\(([A-Za-z]{1,6})\)\s*$/;
const FOOTER_RE = /press enter to confirm|esc to cancel/i;
/** The options must end within this many non-empty lines of the bottom. */
const MAX_LINES_BELOW = 4;
/** And the question must be at most this many lines above the first option. */
const MAX_QUESTION_ABOVE = 40;

export interface CodexApprovalBox extends PermissionPrompt {
  /** "$ <command>" line, without the "$ ". */
  command?: string;
  reason?: string;
  environment?: string;
  /** Hotkey per option ("y", "p", "esc"), aligned with options. */
  hotkeys: Array<string | null>;
  /** Index of the highlighted option (›), if shown. */
  selected?: number;
}

/** The Codex approval box at the bottom of a pane, or null. */
export function parseCodexApprovalBox(content: string): CodexApprovalBox | null {
  const lines = stripAnsi(content || '')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''));
  // Last option block from the bottom.
  let end = lines.length - 1;
  let below = 0;
  while (end >= 0 && !OPTION_RE.test(lines[end].trim())) {
    const t = lines[end].trim();
    if (t) {
      if (!FOOTER_RE.test(t)) below++;
      if (below > MAX_LINES_BELOW) return null;
    }
    end--;
  }
  if (end < 0) return null;
  // Codex draws "Press enter to confirm or esc to cancel" under the box and a
  // hotkey after every option; a numbered list in the conversation has neither.
  let footer = false;
  for (let i = end + 1; i < lines.length; i++) if (FOOTER_RE.test(lines[i])) footer = true;
  let start = end;
  while (start - 1 >= 0 && OPTION_RE.test(lines[start - 1].trim())) start--;
  const options: PermissionPrompt['options'] = [];
  const hotkeys: Array<string | null> = [];
  let selected: number | undefined;
  for (let i = start; i <= end; i++) {
    const raw = lines[i].trim();
    const m = OPTION_RE.exec(raw)!;
    if (Number(m[1]) !== options.length + 1) return null; // must be 1., 2., 3. ...
    const hk = HOTKEY_RE.exec(m[2]);
    options.push({ label: hk ? m[2].slice(0, hk.index).trim() : m[2], description: '' });
    hotkeys.push(hk ? hk[1].toLowerCase() : null);
    if (/^[›❯>]/.test(raw)) selected = options.length - 1;
  }
  if (options.length < 2) return null;
  if (!footer && hotkeys.some((h) => h === null)) return null;
  // The question above the options.
  let q = -1;
  for (let i = start - 1; i >= 0 && i >= start - MAX_QUESTION_ABOVE; i--) {
    if (QUESTION_RE.test(lines[i].trim())) {
      q = i;
      break;
    }
  }
  if (q < 0) return null;
  const question = lines[q].trim();
  let command: string | undefined;
  let reason: string | undefined;
  let environment: string | undefined;
  const body: string[] = [];
  for (let i = q + 1; i < start; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    body.push(t);
    if (t.startsWith('$ ') && command === undefined) command = t.slice(2).trim();
    else if (/^Reason:/i.test(t)) reason = t.replace(/^Reason:\s*/i, '');
    else if (/^Environment:/i.test(t)) environment = t.replace(/^Environment:\s*/i, '');
    else if (command !== undefined && !/^Reason:|^Environment:/i.test(t)) command += `\n${t}`;
  }
  const cleanContent = [question, ...body, ...options.map((o, i) => `${i + 1}. ${o.label}`)].join(
    '\n'
  );
  return {
    question,
    options,
    cleanContent,
    hotkeys,
    ...(selected !== undefined ? { selected } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(environment !== undefined ? { environment } : {}),
  };
}

export function parseCodexPermissionPrompt(content: string): PermissionPrompt | null {
  const box = parseCodexApprovalBox(content);
  return box
    ? { question: box.question, options: box.options, cleanContent: box.cleanContent }
    : null;
}

/** Codex's only choice box in step 2 is the approval box. */
export function parseCodexTextChoicePrompt(content: string): TextChoicePrompt | null {
  const box = parseCodexApprovalBox(content);
  return box
    ? {
        question: box.question,
        multiSelect: false,
        options: box.options,
        cleanContent: box.cleanContent,
      }
    : null;
}

/** The approval box live at the bottom of a pane capture, as the app's choice prompt. */
export function detectCodexActiveChoicePrompt(paneOutput: string): TerminalChoicePrompt | null {
  const box = parseCodexApprovalBox(paneOutput);
  if (!box) return null;
  const detail = [box.command ? `$ ${box.command}` : '', box.reason ? `Reason: ${box.reason}` : '']
    .filter(Boolean)
    .join('\n');
  return {
    question: detail ? `${box.question}\n${detail}` : box.question,
    header: 'Codex',
    options: box.options.map((o) => ({ label: o.label, description: o.description })),
    multiSelect: false,
  };
}

export const CODEX_APPROVAL_PROMPT_RE =
  /Would you like to (run|make|apply|grant|allow)|Press enter to confirm or esc to cancel/i;

export function classifyCodexStartupPane(pane: string): StartupPaneState {
  const p = stripAnsi(pane || '');
  if (
    /Do you trust the (contents|files) of this (directory|folder)|trust this (directory|folder)/i.test(
      p
    )
  )
    return 'trust_prompt';
  if (/Ask Codex to do anything|\? for shortcuts|context left/i.test(p)) return 'ready';
  return 'starting';
}

/** Step 3: Codex choice keys are not implemented; the plan sends nothing. */
export function codexChoiceKeys(req: ChoiceRequest): ChoiceKeyPlan {
  return {
    description: `codex choice: indices [${req.selectedIndices.join(',')}] of ${req.optionCount} (not supported)`,
    warnings: ['Answering Codex choice boxes is not supported yet; nothing was sent'],
    steps: [],
  };
}

export const codexTerminal: AgentTerminal<CodexPermissionMode> = {
  launchCommand: () => 'codex',
  // The prompt-box guard is Claude-shaped; Codex's composer is step 3.
  readPromptBox: () => ({ found: false, draft: '' }),
  detectOverlay: () => false,
  parsePermissionPrompt: parseCodexPermissionPrompt,
  parseTextChoicePrompt: parseCodexTextChoicePrompt,
  detectActiveChoicePrompt: detectCodexActiveChoicePrompt,
  approvalPromptRe: CODEX_APPROVAL_PROMPT_RE,
  choiceKeys: codexChoiceKeys,
  classifyStartupPane: classifyCodexStartupPane,
};
