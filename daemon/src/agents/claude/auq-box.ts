/**
 * Claude Code's AskUserQuestion picker, read from a pane capture.
 *
 * The generic choice-box parser (parser.ts) reads any "❯ 1. Foo" box and keeps
 * every numbered row, so on an AskUserQuestion box it also offered "Type
 * something." and "Chat about this" as answers, read the multi-select "Submit"
 * row as a description, cut a wrapped label in two (the tail became the
 * description) and took the "Submit answers / Cancel" review screen for a
 * multi-select question. This parser knows the picker's real layout (verified
 * against Claude Code 2.1.323, see docs/cc-contract-tests.md and the
 * auq-cc2.1.323-* fixtures):
 *
 *   ────────────────────────────── (full pane width: W)
 *    ☐ Header                        single question, or
 *   ←  ☐ Size  ☒ Extras  ✔ Submit  → tab bar (multi-select / several questions)
 *
 *   Question text (may wrap)
 *
 *   ❯ 1. Label                       cursor row; multi-select: "1. [ ] Label"
 *        Description                 5 (single) / 9 (multi) spaces in; a wrapped
 *   ...                              label continues at the same indent
 *     4. Type something.             the "Other" row (typed text replaces it)
 *        Submit | Next               multi-select only
 *   ──────────────────────────────
 *     5. Chat about this
 *
 *   Enter to select · ↑/↓ to navigate · Esc to cancel
 *
 * Options with a preview draw a side panel instead of descriptions, have no
 * "Type something" row and an unnumbered "Chat about this"; the review screen
 * lists the answers and offers "1. Submit answers / 2. Cancel" with no footer.
 *
 * Only a box that is LIVE (its footer, or the review screen's Cancel row, is
 * the last thing on the pane) is returned. Anything else is null and the
 * caller falls back to the generic parser (permission boxes and the like).
 */
import type { ClaudeAuqState, TerminalChoicePrompt } from '../../types';

// eslint-disable-next-line no-control-regex
const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_OSC, '').replace(ANSI_CSI, '');
}

const DIVIDER = /^─{10,}$/;
const FOOTER = /^Enter to select · .*Esc to cancel$/;
const SINGLE_HEADER = /^ [☐☒✔] (\S.*)$/;
const TAB_BAR = /^←\s+(.*?)\s+→$/;
const ROW = /^([❯ ]) (\d{1,2})\. (.*)$/;
const SUBMIT_ROW = /^([❯ ]) {4}(Submit|Next)$/;
const CHAT_ROW = /^[❯ ] (?:(\d{1,2})\. )?Chat about this$/;
const CHECKBOX = /^\[([ ✔])\] (.*)$/;
/** Single-select: the row answered earlier ends in " ✔". */
const CHOSEN_MARK = / ✔$/;
const OTHER_PLACEHOLDER = /^Type something\.?$/;
const NOTES_HINT = /^Notes: press n to add notes$/;
const REVIEW_TITLE = /^Review your answers$/;
const REVIEW_WARNING = /^⚠ (.*)$/;
const REVIEW_QUESTION = /^ ● (.*)$/;
const REVIEW_ANSWER = /^ {3}→ (.*)$/;
const REVIEW_READY = /^Ready to submit your answers\?$/;
const REVIEW_ROW = /^([❯ ]) ([12])\. (Submit answers|Cancel)$/;

/** Terminal columns a string takes (wide East Asian characters and emoji count 2). */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      cp === 0 ||
      (cp >= 0x300 && cp <= 0x36f) ||
      cp === 0x200d ||
      (cp >= 0xfe00 && cp <= 0xfe0f)
    ) {
      continue;
    }
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd);
    w += wide ? 2 : 1;
  }
  return w;
}

/** The first `cols` terminal columns of a line. */
function cutColumns(s: string, cols: number): string {
  let w = 0;
  let out = '';
  for (const ch of s) {
    const cw = displayWidth(ch);
    if (w + cw > cols) break;
    w += cw;
    out += ch;
  }
  return out;
}

/** Text drawn with a background colour in a raw (ANSI) line: the active tab. */
function highlightedText(raw: string): string | null {
  // eslint-disable-next-line no-control-regex
  const parts = raw.split(/(\x1b\[[0-9;]*m)/);
  let bg = false;
  let hl = '';
  for (const p of parts) {
    // eslint-disable-next-line no-control-regex
    const m = /^\x1b\[([0-9;]*)m$/.exec(p);
    if (m) {
      const codes = m[1] === '' ? [0] : m[1].split(';').map((c) => parseInt(c, 10));
      for (let i = 0; i < codes.length; i++) {
        const c = codes[i];
        if (c === 0 || c === 49) bg = false;
        else if (c === 7 || (c >= 40 && c <= 47) || (c >= 100 && c <= 107)) bg = true;
        else if (c === 48) {
          bg = true;
          i += codes[i + 1] === 5 ? 2 : 4;
        } else if (c === 38) {
          i += codes[i + 1] === 5 ? 2 : 4;
        }
      }
      continue;
    }
    if (bg) hl += p;
  }
  const t = hl.trim();
  return t ? t : null;
}

/**
 * The foreground colour (SGR state, as text) of the first non-space character
 * at or after visible column `fromCol` of a raw line; null when the line has
 * no escapes at all (a plain capture).
 */
function fgAt(raw: string, fromCol: number): string | null {
  if (!raw.includes('\x1b[')) return null;
  // eslint-disable-next-line no-control-regex
  const parts = raw.split(/(\x1b\[[0-9;]*m)/);
  let fg = 'default';
  let dim = false;
  let col = 0;
  for (const p of parts) {
    // eslint-disable-next-line no-control-regex
    const m = /^\x1b\[([0-9;]*)m$/.exec(p);
    if (m) {
      const codes = m[1] === '' ? [0] : m[1].split(';').map((c) => parseInt(c, 10));
      for (let i = 0; i < codes.length; i++) {
        const c = codes[i];
        if (c === 0) {
          fg = 'default';
          dim = false;
        } else if (c === 2) dim = true;
        else if (c === 22) dim = false;
        else if (c === 39) fg = 'default';
        else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) fg = String(c);
        else if (c === 38) {
          const n = codes[i + 1] === 5 ? 2 : 4;
          fg = codes.slice(i, i + n + 1).join(';');
          i += n;
        } else if (c === 48) i += codes[i + 1] === 5 ? 2 : 4;
      }
      continue;
    }
    // eslint-disable-next-line no-control-regex
    for (const ch of p.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')) {
      if (col >= fromCol && ch.trim() !== '') return dim ? `${fg}+dim` : fg;
      col += displayWidth(ch);
    }
  }
  return null;
}

interface Tab {
  label: string;
  answered: boolean;
}

function parseTabBar(inner: string): { tabs: Tab[]; hasSubmit: boolean } | null {
  const tokens = inner.split(/\s{2,}/).filter(Boolean);
  const tabs: Tab[] = [];
  let hasSubmit = false;
  for (let i = 0; i < tokens.length; i++) {
    const m = /^([☐☒✔]) (\S.*)$/.exec(tokens[i]);
    if (!m) return null;
    if (i === tokens.length - 1 && m[1] === '✔' && m[2] === 'Submit') {
      hasSubmit = true;
      continue;
    }
    tabs.push({ label: m[2], answered: m[1] === '☒' || m[1] === '✔' });
  }
  return tabs.length ? { tabs, hasSubmit } : null;
}

function firstWord(s: string): string {
  return s.trim().split(/\s+/)[0] || '';
}

interface RawRow {
  cursor: boolean;
  number: number;
  /** The row's own line, from the number on ("Label", "[✔] Label"). */
  text: string;
  /** Full first line (for the wrap rule). */
  line: string;
  raw: string;
  continuation: string[];
  continuationRaw: string[];
}

export interface ParsedAuqBox extends TerminalChoicePrompt {
  auq: ClaudeAuqState;
}

/**
 * The live AskUserQuestion box at the bottom of a capture (ANSI allowed), or
 * null. Labels come back whole (wrapped lines joined), "(Recommended)" kept.
 */
export function parseClaudeAuqBox(capture: string): ParsedAuqBox | null {
  if (!capture) return null;
  const rawLines = capture.replace(/\r/g, '').split('\n');
  const lines = rawLines.map((l) => stripAnsi(l).replace(/\s+$/, ''));
  let end = lines.length - 1;
  while (end >= 0 && lines[end] === '') end--;
  if (end < 3) return null;

  // Bottom anchor: the footer (it may wrap onto a second line) or the review
  // screen's Cancel row.
  let footer: string | null = null;
  let bodyEnd: number; // exclusive
  let review = false;
  if (FOOTER.test(lines[end])) {
    footer = lines[end];
    bodyEnd = end;
  } else if (
    end >= 1 &&
    /^Enter to select · /.test(lines[end - 1]) &&
    FOOTER.test(`${lines[end - 1]} ${lines[end].trim()}`)
  ) {
    footer = `${lines[end - 1]} ${lines[end].trim()}`;
    bodyEnd = end - 1;
  } else if (REVIEW_ROW.test(lines[end]) && /Cancel$/.test(lines[end])) {
    review = true;
    bodyEnd = end + 1;
  } else {
    return null;
  }

  // Top anchor: the header (or tab bar) right under a full-width divider.
  let top = -1;
  for (let i = bodyEnd - 1; i >= 1 && i >= bodyEnd - 120; i--) {
    if ((SINGLE_HEADER.test(lines[i]) || TAB_BAR.test(lines[i])) && DIVIDER.test(lines[i - 1])) {
      top = i;
      break;
    }
  }
  if (top < 0) return null;
  const width = displayWidth(lines[top - 1]);
  const unparsed: string[] = [];

  let header = '';
  let tabs: Tab[] | undefined;
  let activeTab: number | undefined;
  const single = SINGLE_HEADER.exec(lines[top]);
  if (single) {
    header = single[1];
  } else {
    const bar = parseTabBar(TAB_BAR.exec(lines[top])![1]);
    if (!bar) return null;
    tabs = bar.tabs;
    const hl = highlightedText(rawLines[top]);
    if (hl) {
      const label = hl.replace(/^[☐☒✔] /, '');
      if (label === 'Submit' && /^✔/.test(hl)) activeTab = tabs.length;
      else {
        const idx = tabs.findIndex((t) => t.label === label);
        if (idx >= 0) activeTab = idx;
      }
    }
  }

  const body = lines.slice(top + 1, bodyEnd);

  if (review) {
    return parseReview(body, tabs, activeTab, unparsed);
  }
  if (!footer) return null;

  // Question: the non-blank lines before the first option row.
  let i = 0;
  while (i < body.length && body[i] === '') i++;
  const qLines: string[] = [];
  while (i < body.length && !ROW.test(body[i])) {
    if (body[i] !== '') qLines.push(body[i].trim());
    i++;
  }
  if (i >= body.length) return null;
  const question = qLines.join(' ');

  // Inner divider: splits the options from "Chat about this".
  let inner = -1;
  for (let j = body.length - 1; j > i; j--) {
    if (DIVIDER.test(body[j])) {
      inner = j;
      break;
    }
  }
  if (inner < 0) return null;
  let section = body.slice(i, inner);
  const sectionRaw = rawLines.slice(top + 1 + i, top + 1 + inner);
  const after = body.slice(inner + 1);

  // A preview side panel: everything from its column on belongs to it.
  let preview = false;
  const panelCol = (() => {
    for (const l of section) {
      const k = l.indexOf('┌');
      if (k > 6) return displayWidth(l.slice(0, k));
    }
    return -1;
  })();
  if (panelCol > 0) {
    preview = true;
    section = section.map((l) => cutColumns(l, panelCol).replace(/\s+$/, ''));
  }

  const rows: RawRow[] = [];
  let submitRow: { cursor: boolean; kind: 'Submit' | 'Next' } | null = null;
  for (let si = 0; si < section.length; si++) {
    const l = section[si];
    const raw = sectionRaw[si] ?? l;
    if (l === '') continue;
    const sm = SUBMIT_ROW.exec(l);
    if (sm && !preview) {
      submitRow = { cursor: sm[1] === '❯', kind: sm[2] as 'Submit' | 'Next' };
      continue;
    }
    const rm = ROW.exec(l);
    if (rm && !submitRow) {
      rows.push({
        cursor: rm[1] === '❯',
        number: parseInt(rm[2], 10),
        text: rm[3],
        line: l,
        raw,
        continuation: [],
        continuationRaw: [],
      });
      continue;
    }
    if (rows.length && !submitRow && /^ {4,}\S/.test(l)) {
      rows[rows.length - 1].continuation.push(l);
      rows[rows.length - 1].continuationRaw.push(raw);
      continue;
    }
    if (preview && NOTES_HINT.test(l.trim())) continue;
    unparsed.push(l);
  }
  if (rows.length < 1) return null;
  for (let k = 0; k < rows.length; k++) {
    if (rows[k].number !== k + 1) return null;
  }

  let chatNumber: number | undefined;
  let chatCursor = false;
  for (const l of after) {
    if (l === '') continue;
    const cm = CHAT_ROW.exec(l);
    if (cm && chatNumber === undefined && !chatCursor) {
      chatNumber = cm[1] ? parseInt(cm[1], 10) : 0;
      chatCursor = l.startsWith('❯');
      continue;
    }
    unparsed.push(l);
  }
  if (chatNumber === undefined) return null;

  const multiSelect = rows.every((r) => CHECKBOX.test(r.text));
  const indent = preview ? 4 : multiSelect ? 9 : 5;

  const options: Array<{ label: string; description?: string; selected?: boolean }> = [];
  let otherRow: RawRow | null = null;
  const optionRows = preview ? rows : rows.slice(0, -1);
  if (!preview) otherRow = rows[rows.length - 1];

  const splitRow = (r: RawRow): { label: string; description: string; checked: boolean } => {
    let text = r.text;
    let checked = false;
    if (multiSelect) {
      const cb = CHECKBOX.exec(text)!;
      checked = cb[1] === '✔';
      text = cb[2];
    }
    const labelParts = [text];
    const descParts: string[] = [];
    let prev = r.line;
    let inLabel = true;
    // Colour tells label from description when the capture has it: Claude draws
    // descriptions in the same dim colour as the row number, labels in another.
    const numberCol = displayWidth(r.line.slice(0, r.line.indexOf(String(r.number))));
    const numberFg = fgAt(r.raw, numberCol);
    const labelCol = displayWidth(r.line) - displayWidth(text);
    const labelFg = fgAt(r.raw, labelCol);
    const byColour = numberFg !== null && labelFg !== null && numberFg !== labelFg;
    for (let ci = 0; ci < r.continuation.length; ci++) {
      const c = r.continuation[ci];
      const content = c.trim();
      if (c.length - c.trimStart().length !== indent) unparsed.push(c);
      const continues = preview
        ? true
        : byColour
          ? fgAt(r.continuationRaw[ci], indent) !== numberFg
          : displayWidth(prev) + 1 + displayWidth(firstWord(content)) > width;
      if (inLabel && continues) {
        labelParts.push(content);
        prev = c;
      } else {
        inLabel = false;
        descParts.push(content);
      }
    }
    let label = labelParts.join(' ');
    // A single-select question answered before (back from a later tab or the
    // review) marks the chosen row with a trailing check.
    if (!multiSelect && CHOSEN_MARK.test(label)) {
      label = label.replace(CHOSEN_MARK, '');
      checked = true;
    }
    return { label, description: descParts.join(' '), checked };
  };

  for (const r of optionRows) {
    const s = splitRow(r);
    options.push({
      label: s.label,
      ...(s.description ? { description: s.description } : {}),
      ...(multiSelect || s.checked ? { selected: s.checked } : {}),
    });
  }

  const auq: ClaudeAuqState = { screen: 'question', width };
  if (tabs) {
    auq.tabs = tabs;
    auq.activeTab = activeTab ?? firstUnanswered(tabs);
    auq.activeTabKnown = activeTab !== undefined;
  }
  if (preview) auq.preview = true;
  if (otherRow) {
    // The Other row: every continuation line is its own wrapped text.
    let text = otherRow.text;
    let checked = false;
    if (multiSelect) {
      const cb = CHECKBOX.exec(text)!;
      checked = cb[1] === '✔';
      text = cb[2];
    }
    const full = [text, ...otherRow.continuation.map((c) => c.trim())].join(' ');
    auq.other = {
      number: otherRow.number,
      ...(OTHER_PLACEHOLDER.test(full) ? {} : { text: full }),
      ...(multiSelect ? { checked } : {}),
    };
  }
  if (submitRow) auq.submitRow = submitRow.kind;
  if (chatNumber) auq.chatNumber = chatNumber;
  const cursorIdx = rows.findIndex((r) => r.cursor);
  if (cursorIdx >= 0) auq.cursor = cursorIdx;
  else if (submitRow?.cursor) auq.cursor = 'submit';
  else if (chatCursor) auq.cursor = 'chat';
  if (/ctrl\+g to edit/.test(footer)) auq.textMode = true;
  auq.footer = footer;
  if (unparsed.length) auq.unparsed = unparsed;
  if (multiSelect && !submitRow && !preview)
    auq.unparsed = [...unparsed, '(missing Submit/Next row)'];

  const headerText = tabs ? (tabs[auq.activeTab!]?.label ?? '') : header;
  return {
    question,
    ...(headerText ? { header: headerText } : {}),
    options,
    multiSelect,
    auq,
  };
}

function firstUnanswered(tabs: Tab[]): number {
  const k = tabs.findIndex((t) => !t.answered);
  return k >= 0 ? k : 0;
}

function parseReview(
  body: string[],
  tabs: Tab[] | undefined,
  activeTab: number | undefined,
  unparsed: string[]
): ParsedAuqBox | null {
  let titled = false;
  let incomplete = false;
  let ready = false;
  const pairs: Array<{ question: string; answer: string }> = [];
  const rows: Array<{ cursor: boolean; label: string }> = [];
  let mode: 'q' | 'a' | null = null;
  for (const l of body) {
    if (l === '') continue;
    let m: RegExpExecArray | null;
    if (REVIEW_TITLE.test(l)) titled = true;
    else if ((m = REVIEW_WARNING.exec(l))) incomplete = true;
    else if ((m = REVIEW_QUESTION.exec(l))) {
      pairs.push({ question: m[1], answer: '' });
      mode = 'q';
    } else if ((m = REVIEW_ANSWER.exec(l)) && pairs.length) {
      pairs[pairs.length - 1].answer = m[1];
      mode = 'a';
    } else if (REVIEW_READY.test(l)) {
      ready = true;
      mode = null;
    } else if ((m = REVIEW_ROW.exec(l))) {
      rows.push({ cursor: m[1] === '❯', label: m[3] });
      mode = null;
    } else if (mode && /^ {3,}\S/.test(l) && pairs.length) {
      const p = pairs[pairs.length - 1];
      if (mode === 'q') p.question += ` ${l.trim()}`;
      else p.answer += ` ${l.trim()}`;
    } else unparsed.push(l);
  }
  if (!titled || !ready || rows.length !== 2) return null;
  const auq: ClaudeAuqState = {
    screen: 'review',
    review: pairs,
    ...(incomplete ? { incomplete: true } : {}),
    ...(tabs
      ? { tabs, activeTab: activeTab ?? tabs.length, activeTabKnown: activeTab !== undefined }
      : {}),
  };
  const c = rows.findIndex((r) => r.cursor);
  if (c >= 0) auq.cursor = c;
  if (unparsed.length) auq.unparsed = unparsed;
  return {
    question: 'Ready to submit your answers?',
    header: 'Review your answers',
    options: rows.map((r) => ({ label: r.label })),
    multiSelect: false,
    auq,
  };
}
