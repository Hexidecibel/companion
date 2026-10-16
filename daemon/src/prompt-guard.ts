/**
 * Reading Claude Code's prompt box before typing into it (pure, no tmux).
 *
 * Verified against a live pane (Claude Code 2.1.301, `capture-pane -p -e`):
 *
 *   ────────────────────────────── (gray rule)
 *   ❯<NBSP>my draft text here        <- typed text, normal colour
 *     second draft line              <- continuation lines (backslash-Enter)
 *   ────────────────────────────── (gray rule)
 *     ⏵⏵ bypass permissions on ...   <- footer (1-2 lines)
 *
 * An empty box shows either nothing after the marker or a DIM (SGR 2)
 * placeholder / prompt suggestion (`Try "how does <filepath> work?"`,
 * `is it done yet?`): dim text is never typed text, so it counts as empty.
 * While a choice box, permission prompt or overlay is up the prompt box is
 * replaced, so `found` is false and callers proceed (those paths never type
 * into the prompt box).
 *
 * Overlays (background-task list / details) also replace the prompt box and
 * end in a key-hint line: `↑↓ to select · Enter to view · Esc to close`,
 * `← to go back · Esc/Enter/Space to close · x to stop`.
 */

export interface PromptBoxState {
  /** The rule-bounded prompt box was found at the bottom of the pane. */
  found: boolean;
  /** Typed (non-dim) text in the box, trimmed; '' when empty or placeholder only. */
  draft: string;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Za-z0-9]/g;
const RULE_RE = /^\s*─{10,}\s*$/;
const MARKERS = ['❯', '>', '!', '#'];
/** The box must sit within this many non-empty lines of the bottom (footer + slash menu). */
const MAX_LINES_BELOW_BOX = 12;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** Visible text of one ANSI line with every dim (SGR 2) run removed. */
export function stripDim(line: string): string {
  let out = '';
  let dim = false;
  let i = 0;
  while (i < line.length) {
    if (line[i] === '\x1b') {
      // eslint-disable-next-line no-control-regex
      const m = /^\x1b\[([0-9;]*)m/.exec(line.slice(i));
      if (m) {
        const codes = m[1] === '' ? [0] : m[1].split(';').map((c) => Number(c));
        for (let k = 0; k < codes.length; k++) {
          const c = codes[k];
          // 38/48;5;N and 38/48;2;R;G;B carry arguments, never SGR 2.
          if (c === 38 || c === 48 || c === 58) {
            k += codes[k + 1] === 5 ? 2 : codes[k + 1] === 2 ? 4 : 1;
            continue;
          }
          if (c === 0) dim = false;
          else if (c === 2) dim = true;
          else if (c === 22) dim = false;
        }
        i += m[0].length;
        continue;
      }
      // eslint-disable-next-line no-control-regex
      const other = /^(\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Za-z0-9]|\x1b)/.exec(
        line.slice(i)
      );
      i += other ? other[0].length : 1;
      continue;
    }
    if (!dim) out += line[i];
    i++;
  }
  return out;
}

/** Parse the prompt box out of a `capture-pane -p -e` capture (plain captures work too). */
export function readPromptBox(capture: string): PromptBoxState {
  const lines = capture.replace(/\r/g, '').split('\n');
  const plain = lines.map(stripAnsi);
  let end = plain.length - 1;
  while (end >= 0 && plain[end].trim() === '') end--;
  // Bottom rule: the last rule line, with only a few non-empty lines below it.
  let below = 0;
  let bottom = -1;
  for (let i = end; i >= 0; i--) {
    if (RULE_RE.test(plain[i])) {
      bottom = i;
      break;
    }
    if (plain[i].trim() !== '') below++;
    if (below > MAX_LINES_BELOW_BOX) break;
  }
  if (bottom < 1) return { found: false, draft: '' };
  let top = -1;
  for (let i = bottom - 1; i >= 0; i--) {
    if (RULE_RE.test(plain[i])) {
      top = i;
      break;
    }
  }
  if (top < 0 || top === bottom - 1) return { found: false, draft: '' };
  const first = plain[top + 1].replace(/^\s+/, '');
  const marker = MARKERS.find((m) => first.startsWith(m));
  if (!marker) return { found: false, draft: '' };

  const parts: string[] = [];
  for (let i = top + 1; i < bottom; i++) {
    let text = stripDim(lines[i]);
    if (i === top + 1) {
      text = text.replace(/^\s+/, '');
      if (text.startsWith(marker)) text = text.slice(marker.length);
    }
    parts.push(text.replace(/\u00a0/g, ' ').trim());
  }
  return { found: true, draft: parts.filter(Boolean).join('\n').trim() };
}

/**
 * A key-hint line that closes an overlay: "Esc to close" (or "Esc/Enter/Space to
 * close") as its own `·`-separated segment, i.e. at the start of the line (after
 * a panel border) or after a `·`, and followed by `·` or the end of the line.
 * Conversation text ("Press Esc to close the dialog") does not match.
 */
const OVERLAY_HINT_RE = /(?:^|·)\s*Esc(?:\/[A-Za-z]+)*\s+to\s+close\s*(?:·|$)/;

/** True when an overlay (task list / details panel) is up instead of the prompt box. */
export function detectOverlay(capture: string, hintLines = 4): boolean {
  if (readPromptBox(capture).found) return false;
  const plain = capture
    .replace(/\r/g, '')
    .split('\n')
    .map((l) =>
      stripAnsi(l)
        .replace(/^\s*[┃│║]\s?/, '')
        .replace(/\s?[┃│║]\s*$/, '')
        .trim()
    )
    .filter((l) => l !== '');
  return plain.slice(-hintLines).some((l) => OVERLAY_HINT_RE.test(l));
}

/** Seconds since the most recent attached-client keypress (null: nobody attached). */
export function secondsSinceClientActivity(listClientsOut: string, nowMs: number): number | null {
  const stamps = listClientsOut
    .split('\n')
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (stamps.length === 0) return null;
  return Math.max(0, nowMs / 1000 - Math.max(...stamps));
}

export type InputRefusalReason = 'draft' | 'typing';

export interface InputRefusal {
  reason: InputRefusalReason;
  /** Wire error code (send_input / message_sent). */
  code: 'prompt_has_draft' | 'user_typing';
  /** User-facing sentence (web banner). */
  message: string;
}

export function refusalFor(reason: InputRefusalReason): InputRefusal {
  return reason === 'draft'
    ? {
        reason,
        code: 'prompt_has_draft',
        message:
          'Not sent: the prompt has an unsent draft in the terminal. Send or clear it there, then try again.',
      }
    : {
        reason,
        code: 'user_typing',
        message: 'Not sent: someone is typing in the terminal right now. Try again in a moment.',
      };
}

/** Herald's wording for a refused send to `name`. */
export function heraldRefusalText(name: string, reason: InputRefusalReason): string {
  return reason === 'draft'
    ? `${name} has an unsent draft in its prompt box, so I didn't type over it. Send or clear it, then try again.`
    : `Someone is typing in ${name}'s terminal right now, so I didn't send. Try again in a moment.`;
}
