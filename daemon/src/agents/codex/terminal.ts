/**
 * Codex CLI's terminal side: launch line, the composer (prompt box), overlays,
 * the approval box, start-up screens and the keys that drive them. Everything
 * here was checked against a live Codex 0.165 TUI in tmux (2026-10-28):
 *
 * - Composer: `› <text>` at column 0 above a blank line and the footer
 *   (`<model> · <cwd>`, `← for agents · ? for shortcuts`). The empty composer
 *   shows a DIM placeholder (`Ask Codex to do anything`); a draft is plain
 *   text, continuation lines are indented two spaces. Working shows
 *   `• Working (3s • esc to interrupt)` above the composer.
 * - Text: a fast typed burst counts as a paste, and an Enter that arrives
 *   inside it becomes a newline (a 1.4K-char `send-keys -l` + Enter 150 ms
 *   later stayed a draft). A bracketed paste (`paste-buffer -p`) followed by
 *   Enter submits reliably, multi-line included. Enter while working steers
 *   the running turn, like Claude.
 * - Approval box: digit N selects AND confirms option N (verified for 1 and 2);
 *   the hotkey letters work too. Option 3 ("No, and tell Codex what to do
 *   differently", hotkey esc) aborts the turn ("Conversation interrupted")
 *   and returns to the composer, where the feedback is typed as a new message.
 *   An edit outside the sandbox asks "Would you like to make the following
 *   edits?" with Description / Destination lines instead of `$ command`.
 * - Interrupt: Esc ("esc to interrupt"). Ctrl+C while working opens a "Task is
 *   still running" dialog (Cancel task / Run in background / Exit), and
 *   Ctrl+C on an idle composer QUITS Codex at once. Never send Ctrl+C.
 * - Overlays: Esc twice on an idle composer opens "Browsing transcript" whose
 *   Enter REWINDS the conversation; `?` opens the shortcut sheet
 *   ("? / esc close"). Both close with Esc.
 * - Start-up: a git folder Codex has not been told to trust shows "Folder
 *   access / Trust this folder?" (1. Trust and continue / 2. Back to Agent
 *   Command Center); a plain folder does not, and neither does a folder
 *   already trusted in config.toml. `--dangerously-bypass-approvals-and-
 *   sandbox` asks it too (seen live 2026-10-28: the app's first message hit
 *   it, the paste was dropped and its Enter answered "Trust and continue").
 *   Keys (live): "2" selects AND confirms (-> Agent Command Center); "1"
 *   only selects option 1, Enter confirms it. Esc = "2". Esc from the Command
 *   Center shows a composer, but it is not a session: every message there
 *   just queues ("Queued follow-up inputs") and never runs. Ctrl+C in the
 *   Command Center quits Codex (like Claude's own "No, exit").
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
import { stripAnsi, stripDim, type PromptBoxState } from '../../prompt-guard';
import { CODEX_TRUST, parseTrustPrompt } from '../trust';
import type { TerminalChoicePrompt } from '../../types';
import type {
  AgentTerminal,
  ChoiceKeyPlan,
  ChoiceRequest,
  KeyStep,
  PermissionPrompt,
  StartupPaneState,
  TextChoicePrompt,
} from '../types';

/**
 * The app's spawn mode. Companion starts Claude with
 * `--permission-mode bypassPermissions` (no prompts, no sandbox). Codex's
 * equivalent is `--dangerously-bypass-approvals-and-sandbox`: no approval
 * prompts and no sandbox, i.e. the same trust the user already gives an
 * app-spawned Claude. (`--approve-for-me` would keep the sandbox but routes
 * approvals through an automatic reviewer model, and 0.165 has no
 * `--full-auto`.) Plain `codex` (no mode) keeps Codex's own defaults
 * (on-request approvals, workspace-write sandbox), which the app can answer.
 */
export type CodexPermissionMode = 'bypassPermissions';

export function codexCommand(permissionMode?: CodexPermissionMode): string {
  return permissionMode === 'bypassPermissions'
    ? 'codex --dangerously-bypass-approvals-and-sandbox'
    : 'codex';
}

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
  /** Edit approval: the file(s) the patch writes ("Destination: ..."). */
  destination?: string;
  /** Edit approval: "Description: ..." line. */
  description?: string;
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
  let destination: string | undefined;
  let description: string | undefined;
  const body: string[] = [];
  for (let i = q + 1; i < start; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    body.push(t);
    if (t.startsWith('$ ') && command === undefined) command = t.slice(2).trim();
    else if (/^Reason:/i.test(t)) reason = t.replace(/^Reason:\s*/i, '');
    else if (/^Environment:/i.test(t)) environment = t.replace(/^Environment:\s*/i, '');
    else if (/^Destination:/i.test(t)) destination = t.replace(/^Destination:\s*/i, '');
    else if (/^Description:/i.test(t)) description = t.replace(/^Description:\s*/i, '');
    else if (command !== undefined) command += `\n${t}`;
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
    ...(destination !== undefined ? { destination } : {}),
    ...(description !== undefined ? { description } : {}),
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
  // The start-up trust prompt ("Yes, trust" / "No"; agents/trust.ts).
  const trust = parseTrustPrompt(paneOutput, CODEX_TRUST);
  if (trust) return trust;
  const box = parseCodexApprovalBox(paneOutput);
  if (!box) return null;
  const detail = [
    box.command ? `$ ${box.command}` : '',
    box.destination ? `Destination: ${box.destination}` : '',
    box.reason ? `Reason: ${box.reason}` : '',
    box.description ? `Description: ${box.description}` : '',
  ]
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

// ---------------------------------------------------------------------------
// Composer + overlays

/** The composer must start within this many non-empty lines of the bottom. */
const MAX_LINES_BELOW_COMPOSER = 5;
/** Placeholders a plain (non -e) capture cannot tell from a draft. */
const PLACEHOLDERS = [/^Ask Codex to do anything$/i];
const NUMBERED_ROW_RE = /^›\s*\d{1,2}\.\s/;

/**
 * Codex's composer from a `capture-pane -p -e` capture: the last `›` line at
 * column 0 near the bottom, through the next blank line. The dim placeholder
 * is not a draft. A choice list (`› 1. ...`) or the approval box means there
 * is no composer on screen.
 */
export function readCodexPromptBox(capture: string): PromptBoxState {
  const none = { found: false, draft: '' };
  const lines = (capture || '').replace(/\r/g, '').split('\n');
  const plain = lines.map((l) => stripAnsi(l).replace(/\s+$/, ''));
  if (parseCodexApprovalBox(plain.join('\n'))) return none;
  let below = 0;
  let at = -1;
  for (let i = plain.length - 1; i >= 0; i--) {
    const t = plain[i];
    if (t.startsWith('›')) {
      at = i;
      break;
    }
    if (t.trim() !== '') below++;
    if (below > MAX_LINES_BELOW_COMPOSER) return none;
  }
  if (at < 0 || NUMBERED_ROW_RE.test(plain[at])) return none;
  const parts: string[] = [];
  for (let i = at; i < lines.length; i++) {
    if (i > at && plain[i].trim() === '') break;
    let text = stripDim(lines[i]).replace(/\u00a0/g, ' ');
    if (i === at) text = text.replace(/^\s*›/, '');
    parts.push(text.trim());
  }
  let draft = parts.filter(Boolean).join('\n').trim();
  if (PLACEHOLDERS.some((re) => re.test(draft))) draft = '';
  return { found: true, draft };
}

/** "esc back" / "esc close" / "? / esc close" as its own hint segment, or the transcript pager. */
const CODEX_OVERLAY_HINT_RE =
  /(?:^|·)\s*(?:\?\s*\/\s*)?esc\s+(?:back|close|to close|to go back)\s*(?:·|$)|^Browsing transcript\b/i;

/**
 * An overlay that would eat typed text (or turn Enter into "rewind"): the
 * transcript pager, the shortcut sheet, the Ctrl+C "Task is still running"
 * dialog. Never the approval box (a choice) or the trust prompt (start-up;
 * its "esc back" leaves the session).
 */
export function detectCodexOverlay(capture: string, hintLines = 4): boolean {
  const plain = stripAnsi(capture || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (classifyCodexStartupPane(plain.join('\n')) === 'trust_prompt') return false;
  if (parseCodexApprovalBox(plain.join('\n'))) return false;
  return plain.slice(-hintLines).some((l) => CODEX_OVERLAY_HINT_RE.test(l));
}

// ---------------------------------------------------------------------------
// Keys

/** Time for the turn to abort and the composer to come back after "No (esc)". */
export const CODEX_FEEDBACK_DELAY_MS = 1000;
/** Pause between the bracketed paste and Enter. */
export const CODEX_PASTE_SETTLE_MS = 250;
const CHOICE_KEY_DELAY_MS = 120;

/** Free text: one bracketed paste, then Enter (see the header on paste bursts). */
export function codexTextKeys(text: string): KeyStep[] {
  return [
    { type: 'paste', text },
    { type: 'delay', ms: CODEX_PASTE_SETTLE_MS },
    { type: 'key', key: 'Enter' },
    { type: 'delay', ms: 50 },
  ];
}

/**
 * Keys that answer the approval box. Digit N selects and confirms option N.
 * Free text (the app's "Other") = the box's "No, and tell Codex what to do
 * differently (esc)": Esc aborts the turn, then the text goes in as a new
 * message, which is what that option asks for.
 */
/** Time for the Agent Command Center to open after the trust prompt's "2". */
export const CODEX_TRUST_BACK_DELAY_MS = 1200;

/**
 * Keys for the trust prompt: "Yes, trust" = "1" then Enter (the digit alone
 * only selects); "No" = "2" (confirms "Back to Agent Command Center"), then
 * Ctrl+C there, which quits Codex: an untrusted folder gets no working Codex
 * session (the composer Esc would show only queues messages), so "No" ends
 * it like Claude's "No, exit". Nothing is saved either way but "Yes".
 */
export function codexTrustKeys(index: number): ChoiceKeyPlan {
  if (index === 0)
    return {
      description: 'codex trust prompt: Trust and continue',
      warnings: [],
      steps: [
        { type: 'key', key: '1' },
        { type: 'delay', ms: CHOICE_KEY_DELAY_MS },
        { type: 'key', key: 'Enter' },
      ],
    };
  return {
    description: 'codex trust prompt: not trusted (back, then quit Codex)',
    warnings: [],
    steps: [
      { type: 'key', key: '2' },
      { type: 'delay', ms: CODEX_TRUST_BACK_DELAY_MS },
      { type: 'key', key: 'C-c' },
    ],
  };
}

export function codexChoiceKeys(req: ChoiceRequest): ChoiceKeyPlan {
  const { selectedIndices, optionCount, multiSelect, otherText } = req;
  const warnings: string[] = [];
  if (req.trust) {
    if (otherText !== undefined || (selectedIndices[0] ?? -1) < 0 || selectedIndices[0] > 1)
      return {
        description: 'codex trust prompt: only "Yes, trust" or "No"',
        warnings: ['The trust prompt takes only "Yes, trust" or "No"; nothing sent'],
        steps: [],
      };
    return codexTrustKeys(selectedIndices[0]);
  }
  if (otherText !== undefined) {
    return {
      description: `codex choice: decline (esc) + feedback "${otherText.substring(0, 60)}"`,
      warnings,
      steps: [
        { type: 'key', key: 'Escape' },
        { type: 'delay', ms: CODEX_FEEDBACK_DELAY_MS },
        ...codexTextKeys(otherText),
      ],
    };
  }
  if (multiSelect || selectedIndices.length > 1)
    warnings.push('Codex choice boxes are single-select; sending the first selection only');
  const idx = selectedIndices[0] || 0;
  const num = idx + 1;
  const steps: KeyStep[] = [];
  if (num <= 9) {
    steps.push({ type: 'key', key: String(num) });
  } else {
    for (let i = 0; i < idx; i++) {
      steps.push({ type: 'key', key: 'Down' });
      steps.push({ type: 'delay', ms: CHOICE_KEY_DELAY_MS });
    }
    steps.push({ type: 'key', key: 'Enter' });
  }
  return {
    description: `codex choice: index ${idx} (option ${num}) of ${optionCount}`,
    warnings,
    steps,
  };
}

export const codexTerminal: AgentTerminal<CodexPermissionMode> = {
  launchCommand: codexCommand,
  readPromptBox: readCodexPromptBox,
  detectOverlay: detectCodexOverlay,
  parsePermissionPrompt: parseCodexPermissionPrompt,
  parseTextChoicePrompt: parseCodexTextChoicePrompt,
  detectActiveChoicePrompt: detectCodexActiveChoicePrompt,
  approvalPromptRe: CODEX_APPROVAL_PROMPT_RE,
  choiceKeys: codexChoiceKeys,
  classifyStartupPane: classifyCodexStartupPane,
  textKeys: codexTextKeys,
  // Esc stops the turn; Ctrl+C would open a dialog (working) or quit Codex (idle).
  interruptKeys: () => [{ type: 'key', key: 'Escape' }],
  requiresLiveChoiceBox: true,
  // A daemon with its own HOME (the probe sandbox) must still hand Codex the
  // real home: auth.json and the rollouts the watcher reads live there.
  launchEnv: ({ codexHome }): Record<string, string> =>
    codexHome ? { CODEX_HOME: codexHome } : {},
};
