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
 * Claude Code 2.1.316 (live capture, agents/__tests__/fixtures/claude/live-trust.txt):
 * NO digits, "No" FIRST and selected, and digit keys do nothing:
 *
 *     Accessing workspace:
 *     /home/hexi/.cache/trust-repro/plain
 *     Quick safety check: Is this a project you created or one you trust? ...
 *
 *   ❯ No, exit
 *     Yes, I trust this folder
 *
 *     Enter to confirm · Esc to cancel
 *
 * Older Claude Code: "Do you trust the files in this folder?" (in a box) or the
 * same wording with "❯ 1. Yes, ..." / "2. No, exit". The same screen layout also
 * carries Claude's one-time Bypass Permissions warning ("Yes, I accept"), which
 * can follow it: same card, same rule (only the user answers).
 *
 * The chat always shows Yes first; `trustLayout` holds where the rows really are
 * and the keys are worked out from it. Never assume an order: Enter on the
 * default row of the current wording is "No, exit".
 */
import { stripAnsi } from '../prompt-guard';
import type { TerminalChoicePrompt, TrustLayout } from '../types';

const CURSOR_RE = /^[›❯>]\s*/;
const OPTION_RE = /^(?:[›❯>]\s*)?(\d)\.\s+(.+?)\s*$/;
/** Box borders some versions draw around the dialog. */
const BORDER_RE = /^[│┃|]\s?|\s?[│┃|]$/g;
/** The trust wording must be at most this many lines above the first option. */
const MAX_ABOVE = 24;

export interface TrustPromptSpec {
  header: string;
  /** First line of the card's question. */
  title?: string;
  yesLabel?: string;
  /** The question wording above the options (matched on them joined: panes wrap). */
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
  noDescription: 'Codex does not open this folder and exits (nothing is saved)',
};

export const CLAUDE_TRUST: TrustPromptSpec = {
  header: 'Claude Code',
  questionRe:
    /Do you trust the files in this folder|trust this folder|project you created or one you trust/i,
  footerRe: /Enter to confirm|Esc to (?:exit|cancel)/i,
  yesRe: /yes|trust|proceed/i,
  noRe: /\bno\b|exit/i,
  yesDescription: 'Claude Code can read, edit and run files here, and it remembers this folder',
  noDescription: 'Claude Code exits without opening this folder (nothing is saved)',
};

export const CLAUDE_BYPASS: TrustPromptSpec = {
  header: 'Claude Code',
  title: 'Allow Bypass Permissions mode?',
  yesLabel: 'Yes, I accept',
  questionRe: /running in Bypass Permissions mode/i,
  footerRe: /Enter to confirm|Esc to (?:exit|cancel)/i,
  yesRe: /accept/i,
  noRe: /\bno\b|exit/i,
  yesDescription: 'Claude Code runs commands without asking for your approval in this session',
  noDescription: 'Claude Code exits (nothing is saved)',
};

function cleanLines(pane: string): string[] {
  return stripAnsi(pane || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim().replace(BORDER_RE, '').trim())
    .map((l) => (/^[╭╰─━┌└]/.test(l) ? '' : l));
}

/** The two rows above the footer: "1. x" / "2. y", or plain rows with a cursor. */
function readRows(
  lines: string[],
  last: number
): { start: number; labels: string[]; numbered: boolean; cursor: number } | null {
  const numbered = OPTION_RE.test(lines[last]);
  let start = last;
  const isRow = (l: string) => (numbered ? OPTION_RE.test(l) : !!l);
  while (start - 1 >= 0 && last - start < 3 && isRow(lines[start - 1])) start--;
  const rows = lines.slice(start, last + 1);
  if (rows.length !== 2) return null;
  if (numbered) {
    const m = rows.map((r) => OPTION_RE.exec(r)!);
    if (Number(m[0][1]) !== 1 || Number(m[1][1]) !== 2) return null;
  }
  const cursor = rows.findIndex((r) => CURSOR_RE.test(r));
  // Plain rows are only options with their cursor on one of them.
  if (!numbered && cursor < 0) return null;
  const labels = rows.map((r) =>
    numbered ? OPTION_RE.exec(r)![2] : r.replace(CURSOR_RE, '').trim()
  );
  return { start, labels, numbered, cursor: Math.max(cursor, 0) };
}

/** The trust prompt live at the bottom of a pane, or null. */
export function parseTrustPrompt(pane: string, spec: TrustPromptSpec): TerminalChoicePrompt | null {
  const lines = cleanLines(pane);
  // The hint line must be the last thing on screen: after "No, exit" the old
  // dialog stays visible with the shell prompt under it.
  let end = lines.length - 1;
  while (end >= 0 && !lines[end]) end--;
  if (end < 0 || !spec.footerRe.test(lines[end])) return null;
  end--;
  while (end >= 0 && !lines[end]) end--;
  if (end < 0) return null;
  const rows = readRows(lines, end);
  if (!rows) return null;
  const isYes = (l: string) => spec.yesRe.test(l) && !/^no\b/i.test(l);
  const yes = rows.labels.findIndex(isYes);
  if (yes < 0) return null;
  const no = 1 - yes;
  if (!spec.noRe.test(rows.labels[no])) return null;
  const above: string[] = [];
  let folder = '';
  for (let i = rows.start - 1; i >= 0 && i >= rows.start - MAX_ABOVE; i--) {
    const t = lines[i];
    if (!t) continue;
    above.unshift(t);
    if (!folder && /^(?:\/|~\/)\S*$/.test(t)) {
      folder = t;
      // A long path wraps: the rest are the lines straight under it, no spaces.
      for (let j = i + 1; j < rows.start && lines[j] && !/\s/.test(lines[j]); j++) {
        folder += lines[j];
      }
    }
  }
  if (!spec.questionRe.test(above.join(' '))) return null;
  const title = spec.title ?? 'Trust this folder?';
  const trustLayout: TrustLayout = { numbered: rows.numbered, yes, no, cursor: rows.cursor };
  return {
    question: folder ? `${title}\n${folder}` : title,
    header: spec.header,
    options: [
      { label: spec.yesLabel ?? 'Yes, trust', description: spec.yesDescription },
      { label: 'No', description: spec.noDescription },
    ],
    multiSelect: false,
    kind: 'trust',
    trustLayout,
  };
}
