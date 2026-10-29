/**
 * The agents' start-up "Trust this folder?" prompt as a choice the USER can tap
 * in the chat ("Yes, trust" / "No"). It is never answered on anyone's behalf:
 * babysit, auto-approval, Herald and the spawn flow only report it.
 *
 * Codex 0.165 (live capture, agents/__tests__/fixtures/codex/live-trust.txt;
 * shown for an untrusted GIT folder, also with
 * --dangerously-bypass-approvals-and-sandbox):
 *
 *     Folder access
 *     /home/hexi/.cache/codex-trust-probe/repo
 *
 *     Trust this folder? Codex can read, edit, and run files here, ...
 *     ... Your trust decision will be saved.
 *
 *   › 1. Trust and continue
 *     2. Back to Agent Command Center
 *
 *     enter continue · esc back
 *
 * Claude Code: "Do you trust the files in this folder?" (older, in a box) or
 * "Quick safety check: Is this a project you created or one you trust?" with
 * "❯ 1. Yes, proceed | Yes, I trust this folder" / "2. No, exit" and
 * "Enter to confirm · Esc to exit|cancel".
 */
import { stripAnsi } from '../prompt-guard';
import type { TerminalChoicePrompt } from '../types';

const OPTION_RE = /^(?:[›❯>]\s*)?(\d)\.\s+(.+?)\s*$/;
/** Box borders some versions draw around the dialog. */
const BORDER_RE = /^[│┃|]\s?|\s?[│┃|]$/g;
/** Options must end within this many non-empty lines of the bottom. */
const MAX_LINES_BELOW = 3;
/** The trust wording must be at most this many lines above the first option. */
const MAX_ABOVE = 16;

export interface TrustPromptSpec {
  header: string;
  /** The question wording above the options. */
  questionRe: RegExp;
  /** The hint line under the options. */
  footerRe: RegExp;
  /** Option 1 = trust, option 2 = don't. */
  yesRe: RegExp;
  noRe: RegExp;
  yesDescription: string;
  noDescription: string;
}

export const CODEX_TRUST: TrustPromptSpec = {
  header: 'Codex',
  questionRe:
    /Trust this folder\?|Do you trust the (?:contents|files) of this (?:directory|folder)/i,
  footerRe: /enter (?:to )?continue|esc back|enter to confirm/i,
  yesRe: /trust|yes/i,
  noRe: /back|no\b|exit|quit/i,
  yesDescription:
    "Codex can read, edit and run files here; it saves the folder as trusted in Codex's config",
  noDescription: 'Not trusted: Codex does not open this folder and exits (nothing is saved)',
};

export const CLAUDE_TRUST: TrustPromptSpec = {
  header: 'Claude Code',
  questionRe:
    /Do you trust the files in this folder|trust this folder|project you created or one you trust/i,
  footerRe: /Enter to confirm|Esc to (?:exit|cancel)/i,
  yesRe: /yes|trust|proceed/i,
  noRe: /\bno\b|exit/i,
  yesDescription: 'Claude Code can read, edit and run files here',
  noDescription: 'Claude Code exits',
};

function cleanLines(pane: string): string[] {
  return stripAnsi(pane || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim().replace(BORDER_RE, '').trim())
    .map((l) => (/^[╭╰─━┌└]/.test(l) ? '' : l));
}

/** The trust prompt live at the bottom of a pane, or null. */
export function parseTrustPrompt(pane: string, spec: TrustPromptSpec): TerminalChoicePrompt | null {
  const lines = cleanLines(pane);
  let end = lines.length - 1;
  let below = 0;
  let footer = false;
  while (end >= 0 && !OPTION_RE.test(lines[end])) {
    if (lines[end]) {
      if (spec.footerRe.test(lines[end])) footer = true;
      if (++below > MAX_LINES_BELOW) return null;
    }
    end--;
  }
  if (end < 0 || !footer) return null;
  let start = end;
  while (start - 1 >= 0 && OPTION_RE.test(lines[start - 1])) start--;
  const labels: string[] = [];
  for (let i = start; i <= end; i++) {
    const m = OPTION_RE.exec(lines[i])!;
    if (Number(m[1]) !== labels.length + 1) return null;
    labels.push(m[2]);
  }
  if (labels.length !== 2 || !spec.yesRe.test(labels[0]) || !spec.noRe.test(labels[1])) return null;
  let asked = false;
  let folder = '';
  for (let i = start - 1; i >= 0 && i >= start - MAX_ABOVE; i--) {
    const t = lines[i];
    if (!t) continue;
    if (spec.questionRe.test(t)) asked = true;
    if (!folder && /^(?:\/|~\/)\S*$/.test(t)) folder = t;
  }
  if (!asked) return null;
  return {
    question: folder ? `Trust this folder?\n${folder}` : 'Trust this folder?',
    header: spec.header,
    options: [
      { label: 'Yes, trust', description: spec.yesDescription },
      { label: 'No', description: spec.noDescription },
    ],
    multiSelect: false,
    kind: 'trust',
  };
}
