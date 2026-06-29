import * as fs from 'fs';
import {
  ConversationMessage,
  ConversationHighlight,
  ToolCall,
  SessionStatus,
  QuestionOption,
  Question,
  SessionUsage,
  CompactionEvent,
  TaskItem,
  FileChange,
  TerminalChoicePrompt,
} from './types';
import { APPROVAL_TOOLS, KNOWN_TOOL_NAMES, getToolDescription, isKnownTool } from './tool-config';
import { incrementMessagesParsed } from './metrics';
import { PARSER_WARNING_RATE_LIMIT_MS, PARSER_DEDUP_KEY_PREVIEW_LENGTH, FILE_ACTIVITY_READ_BUFFER_SIZE, COMMAND_LOG_PREVIEW_LENGTH, QUESTION_PREVIEW_LENGTH, TOOL_DESCRIPTION_PREVIEW_LENGTH, TOOL_APPROVAL_PREVIEW_LENGTH, SHORT_COMMAND_DISPLAY_LENGTH, TOOL_INPUT_SUMMARY_LENGTH, MAX_TOOL_OUTPUT_SIZE, MAX_SUMMARY_TEXT_LENGTH } from './constants';
import { BoundedMap } from './utils';

// Re-export TaskItem for tests
export { TaskItem } from './types';
// Re-export FileChange for tests
export { FileChange } from './types';

interface ContentBlock {
  type: string;
  text?: string;
  id?: string; // For tool_use blocks
  tool_use_id?: string; // For tool_result blocks
  name?: string;
  input?: unknown;
  content?: string | Array<{ type: string; text?: string }>; // For tool_result blocks
}

interface JsonlEntry {
  type: string;
  subtype?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
  };
  timestamp?: string;
  parentUuid?: string;
  uuid?: string;
  summary?: string;
  content?: string;
}

interface AskUserQuestionInput {
  questions?: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect?: boolean;
  }>;
}

const MAX_MESSAGES = Infinity; // No cap — full conversation available for infinite scroll

/**
 * Strip cross-session noise from compaction summary content.
 * Claude Code's context compaction includes system-reminder blocks (CLAUDE.md, MEMORY.md),
 * injected file contents, and internal XML tags. These reference other sessions/projects
 * and confuse users when displayed in the Companion app.
 */
function cleanCompactionSummary(text: string): string {
  let cleaned = text;

  // Remove <system-reminder>...</system-reminder> blocks (may span many lines)
  cleaned = cleaned.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');

  // Remove <command-name>...</command-name> tags (system-injected skill markers)
  cleaned = cleaned.replace(/<command-name>[^<]*<\/command-name>/g, '');

  // Remove "Contents of /path/to/file" header lines (injected file contents)
  cleaned = cleaned.replace(/^[ \t]*Contents of \/[^\n]*$/gm, '');

  // Remove lines referencing CLAUDE.md or MEMORY.md paths
  cleaned = cleaned.replace(/^[^\n]*(?:CLAUDE\.md|MEMORY\.md)[^\n]*$/gm, '');

  // Collapse multiple blank lines into one
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  // Trim leading/trailing whitespace
  cleaned = cleaned.trim();

  // If everything was stripped, return a generic marker
  return cleaned || 'Context compacted';
}

// KNOWN_TOOLS alias for backward compatibility in this file
const KNOWN_TOOLS = KNOWN_TOOL_NAMES;

// Rate-limit parser warnings: max one per key per 60s
const _warnedRecently = new BoundedMap<string, number>(1000);
function logParserWarning(type: string, details: string): void {
  const key = `${type}:${details.substring(0, PARSER_DEDUP_KEY_PREVIEW_LENGTH)}`;
  const now = Date.now();
  const last = _warnedRecently.get(key);
  if (last && now - last < PARSER_WARNING_RATE_LIMIT_MS) return;
  _warnedRecently.set(key, now);
  console.log(`[PARSER_WARN] ${type}: ${details}`);
}

/**
 * Fast function to detect current activity by reading only the last few KB of a file.
 * Much faster than parsing the entire conversation file.
 * Tracks tool_result entries to avoid showing stale "pending" status for completed tools.
 */
export function detectCurrentActivityFast(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }

  try {
    const stats = fs.statSync(filePath);
    const fileSize = stats.size;

    // Read last 32KB - enough to get recent messages
    const readSize = Math.min(FILE_ACTIVITY_READ_BUFFER_SIZE, fileSize);
    const buffer = Buffer.alloc(readSize);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, readSize, Math.max(0, fileSize - readSize));
    fs.closeSync(fd);

    const tail = buffer.toString('utf-8');
    const lines = tail.split('\n').filter((line) => line.trim());

    // Collect tool_result IDs from recent lines so we know which tools completed
    const completedToolIds = new Set<string>();
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry: JsonlEntry = JSON.parse(lines[i]);
        if (entry.message?.content && Array.isArray(entry.message.content)) {
          for (const block of entry.message.content) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              completedToolIds.add(block.tool_use_id);
            }
          }
        }
      } catch {
        continue;
      }
    }

    // Walk backward to find the most recent meaningful entry
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry: JsonlEntry = JSON.parse(lines[i]);
        if (entry.message?.role === 'user') {
          return 'Processing...';
        }
        if (entry.message?.role === 'assistant' && entry.message.content) {
          const entryContent = entry.message.content;
          if (Array.isArray(entryContent)) {
            // Find the last tool_use that hasn't been completed
            for (let j = entryContent.length - 1; j >= 0; j--) {
              const block = entryContent[j];
              if (block.type === 'tool_use' && block.name && block.id) {
                // Skip tools that already have results
                if (completedToolIds.has(block.id)) {
                  continue;
                }

                // Warn about unknown tools
                if (!isKnownTool(block.name)) {
                  logParserWarning('unknown_tool', `Unrecognized tool: ${block.name}`);
                }

                // Check if this needs approval
                if (APPROVAL_TOOLS.includes(block.name)) {
                  const input = block.input as Record<string, unknown> | undefined;
                  if (block.name === 'Bash' && input?.command) {
                    const cmd = (input.command as string).substring(0, COMMAND_LOG_PREVIEW_LENGTH);
                    return `Approve? ${cmd}${(input.command as string).length > COMMAND_LOG_PREVIEW_LENGTH ? '...' : ''}`;
                  }
                  if ((block.name === 'Edit' || block.name === 'Write') && input?.file_path) {
                    const fileName =
                      (input.file_path as string).split('/').pop() || input.file_path;
                    return `Approve ${block.name.toLowerCase()}: ${fileName}?`;
                  }
                  return `Approve ${block.name}?`;
                }

                return getToolDescription(block.name);
              }
            }
          }
          return undefined; // Assistant message, all tools completed
        }
      } catch {
        continue;
      }
    }

    return undefined;
  } catch (err) {
    return undefined;
  }
}

export function parseConversationFile(
  filePath: string,
  limit: number = MAX_MESSAGES,
  preReadContent?: string
): ConversationMessage[] {
  const content =
    preReadContent ?? (fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '');
  if (!content) {
    return [];
  }

  const lines = content.split('\n').filter((line) => line.trim());
  incrementMessagesParsed(lines.length);

  // First pass: collect all tool results, start times, and completion times
  const toolResults = new Map<string, string>();
  const toolStartTimes = new Map<string, number>();
  const toolCompleteTimes = new Map<string, number>();

  for (const line of lines) {
    try {
      const entry: JsonlEntry = JSON.parse(line);
      const timestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();

      if (entry.message?.content && Array.isArray(entry.message.content)) {
        for (const block of entry.message.content) {
          // Track tool_use start times
          if (block.type === 'tool_use' && block.id) {
            toolStartTimes.set(block.id, timestamp);
          }

          // Track tool_result completion times and outputs
          if (block.type === 'tool_result' && block.tool_use_id) {
            toolCompleteTimes.set(block.tool_use_id, timestamp);

            // Extract output content - can be string or array of content blocks
            let output = '';
            if (typeof block.content === 'string') {
              output = block.content;
            } else if (Array.isArray(block.content)) {
              output = block.content
                .filter((c) => c.type === 'text' && c.text)
                .map((c) => c.text || '')
                .join('\n');
            }
            toolResults.set(block.tool_use_id, output);
          }
        }
      }
    } catch {
      // Skip malformed lines
    }
  }
  const messages: ConversationMessage[] = [];

  // Process from the end to get most recent messages first
  for (let i = lines.length - 1; i >= 0 && messages.length < limit * 2; i--) {
    try {
      const entry: JsonlEntry = JSON.parse(lines[i]);

      if (entry.type === 'user' || entry.type === 'assistant') {
        const message = parseEntry(entry, toolResults, toolStartTimes, toolCompleteTimes);
        if (message) {
          messages.unshift(message); // Add to beginning to maintain order
        }
      } else if (entry.type === 'summary') {
        // Legacy compaction summary — create a system message marking the compaction point
        if (entry.summary) {
          const timestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();
          messages.unshift({
            id: `compaction-${timestamp}`,
            type: 'system',
            content: cleanCompactionSummary(entry.summary),
            timestamp,
            isCompaction: true,
          });
        }
      } else if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
        // New compaction format — the user message we just processed (messages[0]) is the summary
        const timestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();
        if (messages.length > 0 && messages[0].type === 'user') {
          // Convert the summary user message into a compaction system message
          // and clean cross-session noise from the summary content
          messages[0] = {
            ...messages[0],
            id: `compaction-${timestamp}`,
            type: 'system',
            content: cleanCompactionSummary(messages[0].content),
            isCompaction: true,
          };
        } else {
          // No following user message — just insert a compaction marker
          messages.unshift({
            id: `compaction-${timestamp}`,
            type: 'system',
            content: 'Context compacted',
            timestamp,
            isCompaction: true,
          });
        }
      } else if (entry.type === 'queue-operation') {
        const notification = parseQueueOperation(entry);
        if (notification) {
          messages.unshift(notification);
        }
      } else {
        // Silently ignore unknown types
      }
    } catch {
      // Skip malformed lines
    }
  }

  // Post-pass: detect skill invocations and mark the expanded user message.
  // Two patterns:
  //   1. User message with <command-name>/foo</command-name> → next user message is expansion
  //   2. Assistant message with Skill tool_use → next user message (after tool_result) is expansion
  const trimmed = messages.slice(-limit);
  for (let i = 0; i < trimmed.length - 1; i++) {
    // Pattern 1: <command-name> user message
    if (trimmed[i].type === 'user') {
      const cmdMatch = trimmed[i].content.match(/<command-name>\/([^<]+)<\/command-name>/);
      if (cmdMatch) {
        const skillName = cmdMatch[1];
        for (let j = i + 1; j < trimmed.length; j++) {
          if (trimmed[j].type === 'user' && !trimmed[j].skillName) {
            trimmed[j].skillName = skillName;
            break;
          }
          if (trimmed[j].type === 'assistant') break;
        }
      }
    }
    // Pattern 2: Assistant message with Skill tool_use
    if (trimmed[i].type === 'assistant' && trimmed[i].toolCalls) {
      const skillTool = trimmed[i].toolCalls!.find((tc) => tc.name === 'Skill');
      if (skillTool) {
        const skillName = (skillTool.input.skill as string) || 'unknown';
        // Find the next user message with text content (skip tool_result messages which have empty content)
        for (let j = i + 1; j < trimmed.length; j++) {
          if (trimmed[j].type === 'user' && trimmed[j].content.trim() && !trimmed[j].skillName) {
            trimmed[j].skillName = skillName;
            break;
          }
          if (trimmed[j].type === 'assistant') break;
        }
      }
    }
  }
  return trimmed;
}

function parseQueueOperation(_entry: JsonlEntry): ConversationMessage | null {
  // Task notifications are internal plumbing — suppress from conversation UI entirely.
  // The dispatch panel in the Companion app shows agent status separately.
  return null;
}

/**
 * Detect CLI permission prompts rendered as text (e.g. "Do you want to make this edit?")
 * and extract them as native chooser options. Returns null if no prompt found.
 */
export function parsePermissionPrompt(content: string): {
  question: string;
  options: QuestionOption[];
  cleanContent: string;
} | null {
  // Match "Do you want to <action>?" followed by numbered options
  // Options are prefixed with ❯ (selected) or spaces, then "N. label"
  // Optionally followed by footer like "Esc to cancel · Tab to amend"
  const promptRegex =
    /(Do you want to [^\n]+\?)\n((?:[❯\s]*\d+\.\s+[^\n]+\n?)+)(?:\n?Esc[^\n]*)?/;
  const promptMatch = content.match(promptRegex);

  if (!promptMatch) return null;

  const question = promptMatch[1];
  const optionsBlock = promptMatch[2];

  // Parse individual options: "N. label" with optional (shortcut) suffix
  const optionRegex = /\d+\.\s+(.+)/g;
  const options: QuestionOption[] = [];
  let optMatch;
  while ((optMatch = optionRegex.exec(optionsBlock)) !== null) {
    const rawLabel = optMatch[1].trim();
    // Strip keyboard shortcut hints like "(shift+tab)"
    const cleanLabel = rawLabel.replace(/\s*\([^)]*\)\s*$/, '').trim();
    options.push({
      label: mapPermissionLabel(cleanLabel),
      description: question,
    });
  }

  if (options.length === 0) return null;

  // Strip the entire prompt block from content
  const cleanContent = content.replace(promptMatch[0], '').trim();

  return { question, options, cleanContent };
}

export function mapPermissionLabel(label: string): string {
  const lower = label.toLowerCase();
  if (lower === 'yes') return 'yes';
  if (lower === 'no') return 'no';
  if (lower.startsWith('yes, allow all') || lower.includes("don't ask again")) {
    return "yes, and don't ask again for this session";
  }
  return lower;
}

// Matches a single enumerated option line. Captures:
//   [1] optional selector marker (❯ or >)
//   [2] the enumerated index token (1. / 1) / (1) / a. / a))
//   [3] the label text
// Supported styles per line:
//   "❯ 1. label"  "> 1) label"  "  1. label"  "1) label"  "(1) label"  "a. label"  "a) label"
const TEXT_CHOICE_LINE =
  /^[ \t]*([❯>])?[ \t]*(?:\((\d{1,2})\)|(\d{1,2})[.)]|([a-zA-Z])[.)])[ \t]+(\S.*?)[ \t]*$/;

// A leading question / instruction line that, when immediately followed by an
// enumerated list, is a strong signal of an interactive chooser.
const TEXT_CHOICE_QUESTION =
  /(?:^|\n)[ \t]*((?:Do you want|Would you like|Select|Choose|Which|Pick|How would you like|What would you like)[^\n]*\?)[ \t]*$/i;

// Trailing affordance the CLI prints under an interactive selector.
const TEXT_CHOICE_AFFORDANCE =
  /(Esc to (?:cancel|interrupt|go back|close)|Press \d|\bto cancel\b\s*[·•]|↑\/↓|use arrow keys|Tab to amend)/i;

// Lines that look like test runner / stack frame output, NOT chooser options.
// e.g. vitest: "❯ src/foo.test.ts:132:31", "❯ buildTool src/x.ts:12:3",
// "src/assurance.test.ts (9 tests | 2 failed) 10ms". Matches a file path with a
// trailing :line[:col], OR a "(N tests …)" / "(N | M failed)" test-summary suffix.
const LOOKS_LIKE_STACK_FRAME =
  /\.[a-z]{1,4}:\d+(?::\d+)?\b|\([^)]*\b(?:tests?|passed|failed|skipped)\b[^)]*\)/i;

// Signals that an interactive selector is a MULTI-select (checkbox) list rather than
// a single-pick radio list — e.g. an AskUserQuestion multiSelect question. We look for
// checkbox glyphs on the option lines (☐ ◻ [ ] and their filled variants ☑ ◼ [x]) or a
// "Submit"/"space to select" affordance the multi-select TUI prints. Only used to set a
// flag; it never affects whether a prompt is detected.
const TEXT_CHOICE_MULTISELECT =
  /[☐☑◻◼◽◾☒]|\[[ xX]\]|\bSubmit(?:\s+(?:answers?|selection))?\b|\bspace\b[^\n]{0,24}\b(?:select|toggle|mark)\b/i;

// Number of trailing non-empty lines that count as the "live" region of a captured pane.
// A choice prompt is only surfaced if its option block lives within this tail, so stale
// scrollback selectors and vitest "❯ stackframe" lines don't trigger it.
const ACTIVE_PROMPT_TAIL_LINES = 15;

interface ParsedTextChoice {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: QuestionOption[];
  cleanContent: string;
}

/**
 * Strip ANSI escape sequences (CSI color/cursor codes + OSC sequences) that a raw
 * tmux `capture-pane` may include. The on-disk snapshot fixtures are already clean,
 * but live captures can carry color codes around the selector box.
 */
// eslint-disable-next-line no-control-regex
const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_CSI, '').replace(ANSI_OSC, '');
}

// A single enumerated option line inside an AskUserQuestion / selector box. Lenient
// across enumeration styles AND across single-select vs multi-select (checkbox) rows:
//   single: "❯ 1. Robust / lenient"  "  2. Strict / exact"  "3) Foo"  "> 1. Bar"
//           "(1) Yes"  "a. Apple"  "b) Banana"
//   multi:  "❯ 1. [ ] Persistence"  "  2. [x] Spawn flow"  "3. [✔] Both"  "4. ☐ Other"
// The checkbox token (group [5]) sits BETWEEN the enumerator and the label and is
// stripped out of the captured label so the option text is clean.
// Captures: [1] optional selector arrow, [2] (N) digit, [3] N. / N) digit,
//           [4] lettered index, [5] optional checkbox token, [6] label text.
const AUQ_OPTION_LINE =
  /^[ \t]*(❯|>)?[ \t]*(?:\((\d{1,2})\)|(\d{1,2})[.)]|([a-zA-Z])[.)])[ \t]+(?:(\[[ xX✔✓]\]|[☐☑◻◼◽◾▢▣☒])[ \t]+)?(\S.*?)[ \t]*$/;

// Given a checkbox token captured from an option line, is it in the CHECKED state?
// Checked: x / X inside brackets, a check glyph (✔ ✓), or a filled box glyph
// (☑ ◼ ◾ ▣ ☒). Unchecked: "[ ]" and hollow box glyphs (☐ ◻ ◽ ▢).
const AUQ_CHECKBOX_CHECKED = /[xX✔✓☑◼◾▣☒]/;

// Map an option line's enumeration token to a comparable ordinal so ascending-run
// detection works across numeric and lettered lists (a=1, b=2, …).
function auqOptionOrdinal(m: RegExpMatchArray): number {
  if (m[2]) return parseInt(m[2], 10); // (N)
  if (m[3]) return parseInt(m[3], 10); // N. / N)
  return (m[4] || 'a').toLowerCase().charCodeAt(0) - 96; // a. / b) → 1, 2
}

// A horizontal divider / box-drawing rule (outer frame or an inner separator between
// options). It must NOT break a run of enumerated options.
const AUQ_DIVIDER_LINE = /^[ \t]*[─—\-=━═_]{3,}[ \t]*$/;

// The checkbox/header glyph line that titles a question, e.g. " ☐ Parser fix".
const AUQ_HEADER_LINE = /^[ \t]*[☐☑◻◼◽◾▢▣✔✓][ \t]+(\S.*?)[ \t]*$/;

// The trailing affordance the selector prints under the options. Strong "this is a
// live chooser" signal. Broader than TEXT_CHOICE_AFFORDANCE so the AskUserQuestion
// footer ("Enter to select · ↑/↓ to navigate · Esc to cancel") is recognized.
const AUQ_FOOTER =
  /(Enter to select|to navigate|to select|space to (?:select|toggle)|↑\/↓|↑ ↓|↓ to|Esc to (?:cancel|interrupt|go back|close)|use arrow keys|Tab to (?:amend|select))/i;

// Affordances the selector prints under/beside the options that belong to NO option's
// description: the "press n to add notes" hint and the "Chat about this" entry. When a
// right-hand preview panel pushes these onto the option rows (or just under them) they
// otherwise bleed into the last option's description.
const AUQ_BOX_AFFORDANCE =
  /^[ \t]*(?:Notes:[ \t]*press n to add notes|press n to add notes|Chat about this)[ \t]*$/i;

// Box-drawing glyphs that form the VERTICAL edges / corners of a box. A right-hand
// option-preview panel (drawn beside the numbered options) is anchored by one of these
// repeating down a single column. Horizontal rules (─ ━ ═) are intentionally EXCLUDED:
// a full-width divider under the options is all horizontal glyphs and must NOT be
// mistaken for a side panel.
const PANEL_VERTICAL_RE = /[┌│├└┤┐┘╭╮╰╯]/;
const PANEL_VERTICAL_GLYPHS = '┌│├└┤┐┘╭╮╰╯';
// Any box-drawing / scissors glyph — used to recognise the panel body and pure box-art
// leftover lines.
const ANY_BOX_GLYPH_RE = /[┌│├└┤┐┘╭╮╰╯─━═✂]/;
// A line that, after the side panel is stripped, consists only of box-art + whitespace
// (e.g. a stray corner/edge fragment). Blank lines are handled separately upstream.
const AUQ_BOX_ART_LINE = /^[\s┌│├└┤┐┘╭╮╰╯─━═✂]+$/;

// The NORMAL Claude Code input toolbar that only renders when NO selector is active
// (a lone "❯" prompt bracketed by dividers, or the "⏵⏵ bypass permissions / esc to
// interrupt / for agents" status line). If this appears BELOW a parsed box, the box
// is stale scrollback (already answered) — not a live prompt.
const NORMAL_PROMPT_TOOLBAR = /⏵⏵|bypass permissions|esc to interrupt|for agents|^[ \t]*❯[ \t]*$/;

// Max lines (descriptions / dividers / blanks) tolerated between two consecutive
// enumerated options before they stop being treated as one box. Guards against
// gluing together distant numbered lists from scrollback.
const AUQ_MAX_OPTION_GAP_LINES = 12;

// Strict interrogative question form (kept as an additional strong signal for the
// legacy "Do you want to …?" permission box rendered as plain text).
const AUQ_STRICT_QUESTION =
  /^(?:Do you want|Would you like|Select|Choose|Which|Pick|How would you like|What would you like)\b.*\?$/i;

/**
 * Detect an interactive multi-choice prompt rendered as plain TEXT (no AskUserQuestion
 * / approval tool_use). This is the path that matters for terminal-mode raw captures,
 * where the CLI's selector box (e.g. "❯ 1. Yes / 2. No") is the only representation.
 *
 * SAFETY: prose numbered lists in normal answers MUST NOT match. We require BOTH:
 *   (a) a structured enumerated list of >= 2 items in a single contiguous block, AND
 *   (b) a strong interactive signal — an arrow selector (❯/>) on a list line, OR a
 *       question line ("Do you want…/Select…/Choose…/Which…?") immediately preceding
 *       the list, OR a trailing affordance ("Esc to cancel", "Press 1-N", arrow keys).
 *
 * The arrow alone is not trusted (vitest stack traces use "❯ src/x.ts:12:3"); stack-frame
 * shaped item labels are rejected.
 *
 * Returns null when no safe match is found.
 */

/**
 * Some AskUserQuestion prompts render an option-preview DIAGRAM in a right-hand panel,
 * drawn with box-art on the SAME terminal rows as the numbered options:
 *
 *   ❯ 1. On cushbox directly          ┌──────────────┐
 *       (Recommended)                 │ Claude Code … │
 *     2. From here, over tailnet      ├─── ✂ … ──────┤
 *     3. Just prove the bridge        └──────────────┘
 *
 * The parser has no concept of a second column, so the box-art bleeds into every option
 * label and the footer affordances bleed into descriptions. Detect the panel's left
 * edge — a vertical/corner glyph repeating at the SAME column across >= 2 rows, with
 * real (non-box) text to its left and box content to its right — and truncate the panel
 * rows at that column.
 *
 * GUARD: only fires for an ACTUAL side panel. A full-width frame box (vertical border at
 * column 0 with no text to its left) and a lone horizontal divider do NOT trigger
 * stripping, so single-column boxes are left completely untouched (zero behavior change).
 */
function stripSidePanel(lines: string[]): string[] {
  // Tally, per column, the rows carrying a vertical/corner glyph there.
  const colRows = new Map<number, number[]>();
  for (let r = 0; r < lines.length; r++) {
    const ln = lines[r];
    for (let c = 0; c < ln.length; c++) {
      if (PANEL_VERTICAL_GLYPHS.includes(ln[c])) {
        const arr = colRows.get(c) || [];
        arr.push(r);
        colRows.set(c, arr);
      }
    }
  }
  // Leftmost column that looks like a panel's left edge.
  let panelCol = -1;
  for (const [c, rows] of [...colRows.entries()].sort((a, b) => a[0] - b[0])) {
    if (rows.length < 2) continue; // the column must repeat down >= 2 rows
    // Real text (not box-art, not whitespace) to the LEFT on >= 2 rows — i.e. the option
    // labels. This excludes a full-width frame's LEFT border (only whitespace to its left).
    const textLeft = rows.filter((r) => /[^\s┌│├└┤┐┘╭╮╰╯─━═✂]/.test(lines[r].slice(0, c)));
    if (textLeft.length < 2) continue;
    // Box content to the RIGHT on >= 1 row — the panel body. This excludes a full-width
    // frame's RIGHT border, which has nothing (no further box-art) to its right.
    const boxRight = rows.some((r) => ANY_BOX_GLYPH_RE.test(lines[r].slice(c + 1)));
    if (!boxRight) continue;
    panelCol = c;
    break;
  }
  if (panelCol < 0) return lines; // no side panel detected → untouched
  // Truncate ONLY the rows that actually carry the panel (a vertical/corner glyph at or
  // past panelCol). Prose/divider lines that merely extend past panelCol are preserved.
  return lines.map((ln) =>
    PANEL_VERTICAL_RE.test(ln.slice(panelCol)) ? ln.slice(0, panelCol) : ln
  );
}

export function parseTextChoicePrompt(content: string): ParsedTextChoice | null {
  if (!content) {
    return null;
  }
  // Defensively strip ANSI before anything else — live captures may carry color codes.
  const clean = stripAnsi(content);
  // Strip any right-hand option-preview panel BEFORE extraction so its box-art does not
  // bleed into labels/descriptions. No-op (zero behavior change) unless a real side
  // panel is detected (see stripSidePanel).
  const lines = stripSidePanel(clean.split('\n'));

  // Cheap pre-filter: need an arrow, a question keyword, or a footer affordance.
  if (
    !/[❯>]/.test(clean) &&
    !/\b(?:Do you want|Select|Choose|Which|Pick|Would you like|should I)\b/i.test(clean) &&
    !AUQ_FOOTER.test(clean) &&
    !TEXT_CHOICE_AFFORDANCE.test(clean)
  ) {
    return null;
  }

  // 1. Collect EVERY enumerated option line (lenient; reject stack-frame labels).
  //    We do NOT require contiguity: descriptions and dividers may sit between them.
  interface OptLine {
    li: number;
    idx: number;
    label: string;
    marker: boolean;
    hasCheckbox: boolean;
    checked: boolean;
  }
  const optLines: OptLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(AUQ_OPTION_LINE);
    if (!m) continue;
    const checkboxToken = m[5];
    const label = m[6];
    if (LOOKS_LIKE_STACK_FRAME.test(label)) continue;
    optLines.push({
      li: i,
      idx: auqOptionOrdinal(m),
      label,
      marker: !!m[1],
      hasCheckbox: !!checkboxToken,
      checked: checkboxToken ? AUQ_CHECKBOX_CHECKED.test(checkboxToken) : false,
    });
  }

  // 2. Group into the longest run of ascending indices (n, n+1, …) sitting close
  //    together. Intervening descriptions / dividers / blanks do NOT break the run.
  let bestRun: OptLine[] = [];
  let run: OptLine[] = [];
  for (const opt of optLines) {
    if (run.length === 0) {
      run = [opt];
    } else {
      const prev = run[run.length - 1];
      if (opt.idx === prev.idx + 1 && opt.li - prev.li <= AUQ_MAX_OPTION_GAP_LINES) {
        run.push(opt);
      } else {
        if (run.length > bestRun.length) bestRun = run;
        run = [opt];
      }
    }
  }
  if (run.length > bestRun.length) bestRun = run;

  if (bestRun.length < 2) {
    return null;
  }

  const firstOptLi = bestRun[0].li;
  const lastOptLi = bestRun[bestRun.length - 1].li;

  // 3. Find where the box ends: first footer-affordance line at/after the last option.
  let footerLi = -1;
  for (let i = lastOptLi + 1; i < lines.length; i++) {
    if (AUQ_FOOTER.test(lines[i])) {
      footerLi = i;
      break;
    }
    if (i - lastOptLi > AUQ_MAX_OPTION_GAP_LINES) break;
  }
  const blockEnd = footerLi >= 0 ? footerLi : Math.min(lines.length, lastOptLi + AUQ_MAX_OPTION_GAP_LINES);

  // 4. Build options, absorbing each option's indented multi-line description.
  const options: QuestionOption[] = [];
  for (let oi = 0; oi < bestRun.length; oi++) {
    const cur = bestRun[oi];
    const label = cur.label.replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (!label) continue;
    const descUntil = oi + 1 < bestRun.length ? bestRun[oi + 1].li : blockEnd;
    const descParts: string[] = [];
    for (let j = cur.li + 1; j < descUntil; j++) {
      const ln = lines[j];
      if (ln.trim() === '') continue;
      if (AUQ_DIVIDER_LINE.test(ln)) continue;
      if (AUQ_OPTION_LINE.test(ln)) continue;
      // Box-art leftover after the panel strip is not description text — skip it.
      if (AUQ_BOX_ART_LINE.test(ln)) continue;
      // The footer affordances ("press n to add notes", "Chat about this") and the
      // selector footer belong to NO option — stop absorbing here so they don't bleed
      // into the last option's description.
      if (AUQ_FOOTER.test(ln) || AUQ_BOX_AFFORDANCE.test(ln)) break;
      descParts.push(ln.trim());
    }
    options.push({
      label,
      description: descParts.join(' ').replace(/\s+/g, ' ').trim(),
      ...(cur.hasCheckbox ? { selected: cur.checked } : {}),
    });
  }
  if (options.length < 2) {
    return null;
  }

  // 5. Extract the (possibly wrapped) question prose and the header glyph above the
  //    first option. boxTopLi tracks the topmost line that belongs to the box, so
  //    unrelated preceding prose is preserved in cleanContent.
  let header: string | undefined;
  let question = '';
  let boxTopLi = firstOptLi;
  {
    let li = firstOptLi - 1;
    while (li >= 0 && lines[li].trim() === '') li--; // skip blanks directly above options
    const qParts: string[] = [];
    while (li >= 0) {
      const ln = lines[li];
      const t = ln.trim();
      if (t === '') break;
      if (AUQ_DIVIDER_LINE.test(ln)) break;
      const hdr = ln.match(AUQ_HEADER_LINE);
      if (hdr) {
        header = hdr[1].trim();
        boxTopLi = li;
        break;
      }
      if (AUQ_OPTION_LINE.test(ln)) break;
      // Sentence-boundary stop: once the question's bottom line is captured, a line
      // above it that ends a sentence is separate preceding prose (e.g. "Let me run
      // this command." sitting above "Do you want to proceed?"). Keep it out.
      if (qParts.length > 0 && /[.!?]$/.test(t)) break;
      qParts.unshift(t);
      boxTopLi = li;
      li--;
    }
    question = qParts.join(' ').replace(/\s+/g, ' ').trim();
    // Walk up past one blank to find a header glyph titling the box, if any.
    if (!header) {
      while (li >= 0 && lines[li].trim() === '') li--;
      const hdr = li >= 0 ? lines[li].match(AUQ_HEADER_LINE) : null;
      if (hdr) {
        header = hdr[1].trim();
        boxTopLi = li;
      }
    }
  }

  // 6. Strong-signal gate (defends against prose numbered lists in normal answers):
  //    require an arrow selector, OR the selector footer, OR a strict interrogative.
  const hasArrow = bestRun.some((o) => o.marker);
  const hasFooter = footerLi >= 0;
  const strictQuestion = AUQ_STRICT_QUESTION.test(question);
  if (!hasArrow && !hasFooter && !strictQuestion) {
    return null;
  }

  if (!question) {
    question = header || 'Select an option';
  }

  // 7. Multi-select: checkbox glyphs on the OPTION lines (NOT the header glyph) or a
  //    submit/space affordance in the footer.
  const optionRegion = lines.slice(firstOptLi, blockEnd).join('\n');
  const footerRegion = footerLi >= 0 ? lines.slice(footerLi, footerLi + 2).join('\n') : '';
  // Any matched option line carrying a checkbox token is the strongest multi-select
  // signal; fall back to the region/footer glyph scan for boxes whose checkbox sits
  // outside the captured option run.
  const checkboxOptionCount = bestRun.filter((o) => o.hasCheckbox).length;
  const multiSelect =
    checkboxOptionCount > 0 ||
    TEXT_CHOICE_MULTISELECT.test(optionRegion) ||
    TEXT_CHOICE_MULTISELECT.test(footerRegion);

  // 8. Strip the box (header + question prose + options + footer) from content so
  //    JSONL inline rendering doesn't duplicate it. Unrelated prose above boxTopLi
  //    is preserved.
  let startStrip = boxTopLi;
  while (startStrip > 0 && lines[startStrip - 1].trim() === '') startStrip--;
  let endStrip = footerLi >= 0 ? footerLi + 1 : blockEnd;
  while (endStrip < lines.length && lines[endStrip].trim() === '') endStrip++;
  const cleanContent = [...lines.slice(0, startStrip), ...lines.slice(endStrip)].join('\n').trim();

  return { question, header, multiSelect, options, cleanContent };
}

/**
 * Detect a CURRENTLY ACTIVE text choice prompt in a captured tmux pane.
 *
 * parseTextChoicePrompt already guards against false positives (requires >=2
 * enumerated items plus a strong interactive signal). On top of that we require the
 * option block to sit near the END of the capture: we re-run the parser on only the
 * last ACTIVE_PROMPT_TAIL_LINES non-empty lines (plus a little leading context so an
 * adjacent question line / affordance survives), so only a live selector at the
 * bottom of the pane is offered as tappable. Used both for the on-demand terminal
 * view and to surface a live AskUserQuestion in the conversation view.
 */
export function detectActiveChoicePrompt(paneOutput: string): TerminalChoicePrompt | null {
  if (!paneOutput) {
    return null;
  }

  const lines = stripAnsi(paneOutput).split('\n');
  let nonEmptySeen = 0;
  let startIdx = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') {
      nonEmptySeen++;
      if (nonEmptySeen >= ACTIVE_PROMPT_TAIL_LINES) {
        startIdx = i;
        break;
      }
    }
  }
  const tail = lines.slice(startIdx).join('\n');

  const parsed = parseTextChoicePrompt(tail);
  if (!parsed) {
    return null;
  }

  // Live-vs-stale guard: an ACTIVE selector sits at the bottom of the pane — its
  // options/footer are the last meaningful content, and the normal input region is
  // replaced by the selector. So if the NORMAL input toolbar (a lone "❯" prompt, or
  // the "⏵⏵ bypass permissions / esc to interrupt / for agents" status line) appears
  // BELOW the last option line, the box is either historical scrollback (already
  // answered) or the assistant merely quoting the box format mid-stream — not a live
  // prompt. Footer-independent so it also catches quoted boxes that lack a footer.
  const tailLines = tail.split('\n');
  let lastOptIdx = -1;
  for (let i = tailLines.length - 1; i >= 0; i--) {
    if (AUQ_OPTION_LINE.test(tailLines[i]) && !LOOKS_LIKE_STACK_FRAME.test(tailLines[i])) {
      lastOptIdx = i;
      break;
    }
  }
  if (lastOptIdx >= 0) {
    for (let i = lastOptIdx + 1; i < tailLines.length; i++) {
      // The selector's own footer ("Enter to select · … · Esc to cancel") is allowed
      // to follow the options; only the NORMAL input toolbar marks the box as inactive.
      if (NORMAL_PROMPT_TOOLBAR.test(tailLines[i])) {
        return null;
      }
    }
  }

  return {
    question: parsed.question,
    header: parsed.header,
    options: parsed.options.map((o) => ({
      label: o.label,
      description: o.description,
      ...(o.selected !== undefined ? { selected: o.selected } : {}),
    })),
    multiSelect: parsed.multiSelect,
  };
}

function parseEntry(
  entry: JsonlEntry,
  toolResults: Map<string, string>,
  toolStartTimes: Map<string, number>,
  toolCompleteTimes: Map<string, number>
): ConversationMessage | null {
  const message = entry.message;
  if (!message) return null;

  let content = '';
  const toolCalls: ToolCall[] = [];
  let options: QuestionOption[] | undefined;
  let questions: Question[] | undefined;
  let isWaitingForChoice = false;
  let multiSelect = false;

  if (typeof message.content === 'string') {
    content = message.content;
  } else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block.type === 'text' && block.text) {
        content += block.text;
      } else if (block.type === 'tool_use') {
        if (!block.name) {
          logParserWarning('missing_tool_name', `tool_use block without name, id: ${block.id}`);
          continue;
        }
        if (!KNOWN_TOOLS.has(block.name)) {
          logParserWarning('unknown_tool', `Unrecognized tool in parseEntry: ${block.name}`);
        }
        const toolId = block.id || entry.uuid || '';
        const output = toolResults.get(toolId);
        const isPending = !output && output !== '';
        const startedAt = toolStartTimes.get(toolId);
        const completedAt = toolCompleteTimes.get(toolId);

        toolCalls.push({
          id: toolId,
          name: block.name,
          input: (block.input as Record<string, unknown>) || {},
          output: output,
          status: isPending ? 'pending' : 'completed',
          startedAt,
          completedAt,
        });

        // Extract options from AskUserQuestion tool (only if still pending)
        if (block.name === 'AskUserQuestion' && isPending) {
          const input = block.input as AskUserQuestionInput;
          console.log(
            `Parser: Found AskUserQuestion tool, questions count: ${input.questions?.length || 0}`
          );
          if (input.questions && input.questions.length > 0) {
            // Extract all questions
            questions = input.questions.map((q) => ({
              question: q.question,
              header: q.header,
              options: q.options.map((opt) => ({
                label: opt.label,
                description: opt.description,
              })),
              multiSelect: q.multiSelect || false,
            }));

            // Set content to first question for backward compat / message bubble text
            const firstQuestion = input.questions[0];
            content = firstQuestion.question;
            // Set options from first question for backward compat (single-question case)
            options = firstQuestion.options.map((opt) => ({
              label: opt.label,
              description: opt.description,
            }));
            isWaitingForChoice = true;
            multiSelect = firstQuestion.multiSelect || false;
            console.log(
              `Parser: Extracted ${questions.length} questions, first has ${options.length} options: "${content.substring(0, QUESTION_PREVIEW_LENGTH)}..." (multiSelect: ${multiSelect})`
            );
          }
        } else if (block.name === 'AskUserQuestion' && !isPending) {
          // Show the question content but no options (already answered)
          const input = block.input as AskUserQuestionInput;
          if (input.questions && input.questions.length > 0) {
            content = input.questions[0].question;
          }
        }
        // Add Yes/No options for pending approval tools
        // But NOT for Task tools (background, stay "pending" long) or ExitPlanMode (has plan card UI)
        else if (isPending && APPROVAL_TOOLS.includes(block.name) && block.name !== 'Task' && block.name !== 'ExitPlanMode') {
          const input = block.input as Record<string, unknown>;
          let description = '';

          // Build a helpful description based on tool type
          if (block.name === 'Bash' && input.command) {
            description = `Run: ${(input.command as string).substring(0, TOOL_DESCRIPTION_PREVIEW_LENGTH)}`;
          } else if ((block.name === 'Edit' || block.name === 'Write') && input.file_path) {
            description = `${block.name}: ${input.file_path}`;
          } else if (block.name === 'EnterPlanMode') {
            description = 'Enter plan mode';
          } else {
            description = `Allow ${block.name}?`;
          }

          if (block.name === 'EnterPlanMode') {
            // EnterPlanMode: just yes/no (2 options in CLI)
            options = [
              { label: 'yes', description: `Approve: ${description}` },
              { label: 'no', description: 'Reject' },
            ];
          } else {
            // Standard tool approval: yes/always/no (3 options in CLI)
            options = [
              { label: 'yes', description: `Approve: ${description}` },
              {
                label: "yes, and don't ask again for this session",
                description: `Always allow: ${description}`,
              },
              { label: 'no', description: 'Reject this action' },
            ];
          }
          isWaitingForChoice = true;
          console.log(
            `Parser: Pending ${block.name} tool needs approval: "${description.substring(0, TOOL_APPROVAL_PREVIEW_LENGTH)}..."`
          );
        }
      } else if (block.type === 'tool_result') {
        // Skip tool results entirely - they're internal assistant responses
        // We only want to show actual user-typed messages
      }
    }
  }

  // SAFE text-based multi-choice detection. Runs only when the tool/AskUserQuestion
  // path did NOT already populate options. Requires a structured enumerated list
  // (>= 2 items) AND a strong interactive signal (arrow selector, adjacent
  // question line, or Esc/Press affordance). See parseTextChoicePrompt for guards
  // that keep prose numbered lists and vitest stack traces from matching.
  // This runs BEFORE parsePermissionPrompt so it owns the choice block and can
  // both set options and strip the block.
  let textChoiceMatched = false;
  if (!options && !questions) {
    const textChoice = parseTextChoicePrompt(content);
    if (textChoice) {
      options = textChoice.options;
      content = textChoice.cleanContent;
      isWaitingForChoice = true;
      textChoiceMatched = true;
      console.log(
        `Parser: Detected text-based choice prompt with ${options.length} options: "${textChoice.question.substring(0, QUESTION_PREVIEW_LENGTH)}"`
      );
    }
  }

  // Legacy permission-box stripping. Tool-based detection above is the source of
  // truth for approval options, so for the "Do you want to…?" box we only STRIP
  // the text (never override tool-derived options) — this avoids false positives
  // when the CLI emits prompt text while a pending approval tool already exists.
  // Skipped if the text-choice detector already consumed the block.
  if (!textChoiceMatched) {
    const permissionPrompt = parsePermissionPrompt(content);
    if (permissionPrompt) {
      content = permissionPrompt.cleanContent;
    }
  }

  const timestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();

  return {
    id: entry.uuid || String(timestamp),
    type: entry.type as 'user' | 'assistant',
    content,
    timestamp,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    options,
    questions,
    isWaitingForChoice,
    multiSelect: multiSelect || undefined,
  };
}

/**
 * Parse a chain of conversation files for cross-session infinite scroll.
 * Files are ordered oldest-first. Pagination counts from the END of the
 * newest (last) file backwards through older files.
 *
 * Returns { highlights, total, hasMore } matching the get_highlights contract.
 */
export function parseConversationChain(
  files: string[],
  limit: number,
  offset: number
): { highlights: ConversationHighlight[]; total: number; hasMore: boolean } {
  if (files.length === 0) {
    return { highlights: [], total: 0, hasMore: false };
  }

  // Parse all files and collect highlights per file, newest-first
  // We cache this lazily — only parse as many files as needed
  const allHighlights: ConversationHighlight[] = [];
  let totalCount = 0;

  // Walk from newest to oldest, stop once we have enough
  for (let i = files.length - 1; i >= 0; i--) {
    const messages = parseConversationFile(files[i]);
    const highlights = extractHighlights(messages);

    if (highlights.length > 0) {
      // Insert a session boundary marker between files (not before the first/newest)
      if (allHighlights.length > 0 && messages.length > 0) {
        const boundaryTime = messages[messages.length - 1]?.timestamp || Date.now();
        allHighlights.unshift({
          id: `boundary-${i}`,
          type: 'assistant',
          content: `── Previous session ──`,
          timestamp: boundaryTime,
          isWaitingForChoice: false,
        });
        totalCount++;
      }
      // Prepend older highlights before newer ones
      allHighlights.unshift(...highlights);
      totalCount += highlights.length;
    }

    // Check if we have enough messages to satisfy the request
    // We need at least offset + limit messages to paginate correctly
    if (totalCount > offset + limit) {
      break; // No need to parse more old files
    }
  }

  // Paginate from the end, same logic as the existing get_highlights
  const total = totalCount;
  const startIdx = Math.max(0, total - offset - limit);
  const endIdx = Math.max(total - offset, 0);
  const resultHighlights = allHighlights.slice(startIdx, endIdx);
  const hasMore = startIdx > 0;

  return { highlights: resultHighlights, total, hasMore };
}

export function extractHighlights(messages: ConversationMessage[]): ConversationHighlight[] {
  // Find the index of the last user message - anything before this has been "responded to"
  const rawHighlights = messages
    .filter((msg) => {
      // Include user messages with content (but hide internal plumbing)
      if (msg.type === 'user' && msg.content && msg.content.trim()) {
        if (msg.content.includes('<command-name>')) return false;
        if (msg.content.includes('<task-notification>')) return false;
        // Skip messages that are only system-reminder blocks (no user-visible content)
        if (msg.content.includes('<system-reminder>')) {
          const stripped = msg.content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
          if (!stripped) return false;
        }
        return true;
      }
      // Include system messages (compaction summaries), but skip task notifications
      if (msg.type === 'system') {
        if (msg.content && msg.content.includes('<task-notification>')) return false;
        return true;
      }
      // Include assistant messages with content OR toolCalls
      if (msg.type === 'assistant') {
        const trimmed = msg.content?.trim();
        const hasContent = trimmed && trimmed !== '(no content)';
        const hasToolCalls = msg.toolCalls && msg.toolCalls.length > 0;
        return hasContent || hasToolCalls;
      }
      return false;
    })
    .map((msg, index, arr) => {
      // System messages pass through directly
      if (msg.type === 'system') {
        return {
          id: msg.id,
          type: 'system' as const,
          content: msg.content,
          timestamp: msg.timestamp,
          toolCalls: msg.toolCalls,
          isCompaction: msg.isCompaction,
        };
      }

      const isLastMessage = index === arr.length - 1;
      const originalIndex = messages.indexOf(msg);

      // Check if this message has pending interactive tools (approval tools or AskUserQuestion)
      const hasPendingInteractiveTools =
        msg.toolCalls?.some(
          (tc) =>
            tc.status === 'pending' &&
            (APPROVAL_TOOLS.includes(tc.name) || tc.name === 'AskUserQuestion') &&
            tc.name !== 'Task'
        ) ?? false;

      // Check if all tools in this message are already completed/errored
      const allToolsCompleted =
        (msg.toolCalls?.length ?? 0) > 0 &&
        msg.toolCalls?.every(
          (tc) => tc.status === 'completed' || tc.status === 'error' || tc.output !== undefined
        );

      // Check if user already responded after this message (tool is running, not waiting)
      const userRespondedAfter =
        originalIndex < messages.length - 1 &&
        messages.slice(originalIndex + 1).some((m) => m.type === 'user');

      // Show options if:
      // 1. This message has options AND
      // 2. Either it's the last message OR it has pending approval tools AND
      // 3. Tools haven't all completed AND
      // 4. User hasn't already responded (tool would be running, not waiting)
      const showOptions =
        msg.options &&
        msg.options.length > 0 &&
        (isLastMessage || hasPendingInteractiveTools) &&
        !allToolsCompleted &&
        !userRespondedAfter;

      // If user responded after this message, pending tools are now running (not waiting for approval)
      const toolCalls =
        userRespondedAfter && msg.toolCalls
          ? msg.toolCalls.map((tc) =>
              tc.status === 'pending' ? { ...tc, status: 'running' as const } : tc
            )
          : msg.toolCalls;

      // Strip <system-reminder> XML blocks from content (internal plumbing injected by the CLI)
      let content = msg.content;
      if (content && content.includes('<system-reminder>')) {
        content = content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
      }

      return {
        id: msg.id,
        type: msg.type as 'user' | 'assistant',
        content,
        timestamp: msg.timestamp,
        options: showOptions ? msg.options : undefined,
        questions: showOptions ? msg.questions : undefined,
        isWaitingForChoice: showOptions ? msg.isWaitingForChoice : false,
        multiSelect: showOptions ? msg.multiSelect : undefined,
        toolCalls,
        skillName: msg.skillName,
      };
    });

  // Merge consecutive assistant messages that are tool-only (no text content)
  // into a single message so the UI can collapse them together
  const highlights: ConversationHighlight[] = [];
  for (const h of rawHighlights) {
    const prev = highlights[highlights.length - 1];
    const isToolOnly =
      h.type === 'assistant' &&
      (!h.content || !h.content.trim()) &&
      h.toolCalls &&
      h.toolCalls.length > 0;
    const prevIsToolOnly =
      prev &&
      prev.type === 'assistant' &&
      (!prev.content || !prev.content.trim()) &&
      prev.toolCalls &&
      prev.toolCalls.length > 0;

    if (isToolOnly && prevIsToolOnly && !h.options && !prev.options) {
      // Merge: append tool calls to previous message
      prev.toolCalls = [...(prev.toolCalls || []), ...(h.toolCalls || [])];
      prev.timestamp = h.timestamp; // Use latest timestamp
    } else {
      highlights.push(h);
    }
  }

  // Log if the last highlight has options
  const lastHighlight = highlights[highlights.length - 1];
  if (lastHighlight?.options && lastHighlight.options.length > 0) {
    console.log(`Parser: Last message has ${lastHighlight.options.length} options`);
  }

  return highlights;
}

export function detectWaitingForInput(messages: ConversationMessage[]): boolean {
  if (messages.length === 0) return false;

  const lastMessage = messages[messages.length - 1];

  // If the last message is from the assistant
  if (lastMessage.type === 'assistant') {
    // Check for pending tool calls that need approval
    if (lastMessage.toolCalls) {
      // Task tools run in background for long periods — exclude from approval check
      // (consistent with getPendingApprovalTools and extractHighlights)
      const hasPendingApproval = lastMessage.toolCalls.some(
        (tc) => tc.status === 'pending' && APPROVAL_TOOLS.includes(tc.name) && tc.name !== 'Task'
      );
      if (hasPendingApproval) {
        return true;
      }

      // ExitPlanMode and AskUserQuestion pending = CLI is waiting for user input
      const INTERACTIVE_TOOLS = ['ExitPlanMode', 'AskUserQuestion'];
      const hasPendingInteractive = lastMessage.toolCalls.some(
        (tc) => tc.status === 'pending' && INTERACTIVE_TOOLS.includes(tc.name)
      );
      if (hasPendingInteractive) {
        return true;
      }

      // If any tools are still running, not waiting yet
      if (lastMessage.toolCalls.some((tc) => tc.status === 'running')) {
        return false;
      }
    }

    // Assistant finished with all tools completed (or no tools) = waiting for next user input
    if (
      !lastMessage.toolCalls ||
      lastMessage.toolCalls.every((tc) => tc.status === 'completed' || tc.status === 'error')
    ) {
      return true;
    }
  }

  return false;
}

// Detect if the assistant has finished working and is idle (not actively expecting a response)
export function detectIdle(messages: ConversationMessage[]): boolean {
  if (messages.length === 0) return false;

  const lastMessage = messages[messages.length - 1];

  // If the last message is from the assistant with all tools completed and no question
  if (lastMessage.type === 'assistant') {
    // Still has running/pending tools = not idle
    if (lastMessage.toolCalls?.some((tc) => tc.status === 'pending' || tc.status === 'running')) {
      return false;
    }

    // All tools completed, no question pattern = idle (finished task)
    if (!lastMessage.toolCalls || lastMessage.toolCalls.every((tc) => tc.status === 'completed')) {
      return !detectWaitingForInput(messages);
    }
  }

  return false;
}

export interface ActivityDetail {
  summary: string;
  toolName?: string;
  input?: string;
  output?: string;
  timestamp: number;
}

export function detectCurrentActivity(messages: ConversationMessage[]): string | undefined {
  if (messages.length === 0) return undefined;

  const lastMessage = messages[messages.length - 1];

  // If last message is from user, the assistant is processing
  if (lastMessage.type === 'user') {
    return 'Processing...';
  }

  // Check for tool calls in the last assistant message
  if (
    lastMessage.type === 'assistant' &&
    lastMessage.toolCalls &&
    lastMessage.toolCalls.length > 0
  ) {
    const lastTool = lastMessage.toolCalls[lastMessage.toolCalls.length - 1];

    // Check if this is a pending approval
    if (lastTool.status === 'pending' && APPROVAL_TOOLS.includes(lastTool.name)) {
      const input = lastTool.input as Record<string, unknown>;
      if (lastTool.name === 'Bash' && input.command) {
        const cmd = (input.command as string).substring(0, COMMAND_LOG_PREVIEW_LENGTH);
        return `Approve? ${cmd}${(input.command as string).length > COMMAND_LOG_PREVIEW_LENGTH ? '...' : ''}`;
      }
      if ((lastTool.name === 'Edit' || lastTool.name === 'Write') && input.file_path) {
        const filePath = input.file_path as string;
        const fileName = filePath.split('/').pop() || filePath;
        return `Approve ${lastTool.name.toLowerCase()}: ${fileName}?`;
      }
      return `Approve ${lastTool.name}?`;
    }

    const description = getToolDescription(lastTool.name);

    // Add file path info if available
    if (lastTool.input) {
      const input = lastTool.input as Record<string, unknown>;
      if (input.file_path) {
        const filePath = input.file_path as string;
        const fileName = filePath.split('/').pop() || filePath;
        return `${description}: ${fileName}`;
      }
      if (input.command) {
        const cmd = (input.command as string).substring(0, SHORT_COMMAND_DISPLAY_LENGTH);
        return `${description}: ${cmd}${(input.command as string).length > SHORT_COMMAND_DISPLAY_LENGTH ? '...' : ''}`;
      }
    }

    return description;
  }

  // Don't show "waiting for input" - there's already a separate indicator for that
  return undefined;
}

export function getRecentActivity(
  messages: ConversationMessage[],
  limit: number = 5
): ActivityDetail[] {
  const activities: ActivityDetail[] = [];

  // Go through messages in reverse to get recent activity
  for (let i = messages.length - 1; i >= 0 && activities.length < limit; i--) {
    const msg = messages[i];

    if (msg.type === 'assistant' && msg.toolCalls) {
      for (const tool of msg.toolCalls) {
        if (activities.length >= limit) break;

        const input = tool.input as Record<string, unknown>;
        let inputStr = '';
        const outputStr = tool.output || '';

        // Format input based on tool type
        if (input.file_path) {
          inputStr = input.file_path as string;
        } else if (input.command) {
          inputStr = input.command as string;
        } else if (input.pattern) {
          inputStr = `Pattern: ${input.pattern}`;
        } else if (input.query) {
          inputStr = input.query as string;
        }

        activities.push({
          summary: `${tool.name}${inputStr ? `: ${inputStr.substring(0, TOOL_INPUT_SUMMARY_LENGTH)}` : ''}`,
          toolName: tool.name,
          input: inputStr,
          output: outputStr.substring(0, MAX_TOOL_OUTPUT_SIZE), // Limit output size
          timestamp: msg.timestamp,
        });
      }
    }
  }

  return activities.reverse(); // Return in chronological order
}

export function getSessionStatus(
  conversationPath: string,
  isProcessRunning: boolean
): SessionStatus {
  const messages = parseConversationFile(conversationPath);
  const lastMessage = messages[messages.length - 1];

  return {
    isRunning: isProcessRunning,
    isWaitingForInput: isProcessRunning && detectWaitingForInput(messages),
    lastActivity: lastMessage?.timestamp || 0,
    conversationId: conversationPath,
    currentActivity: isProcessRunning ? detectCurrentActivity(messages) : undefined,
  };
}

/**
 * Get list of pending tools that need approval from the last message.
 * Only returns tools that actually require user approval (Bash, Write, Edit, etc.)
 * Excludes Task (runs in background), AskUserQuestion (choice prompts, not tool approval).
 * Returns objects with both name and id so callers can distinguish different instances
 * of the same tool (e.g., two consecutive Bash calls).
 */
export function getPendingApprovalTools(
  messages: ConversationMessage[]
): Array<{ name: string; id: string }> {
  if (messages.length === 0) return [];

  const lastMessage = messages[messages.length - 1];
  if (lastMessage.type !== 'assistant' || !lastMessage.toolCalls) return [];

  return lastMessage.toolCalls
    .filter(
      (tc) => tc.status === 'pending' && APPROVAL_TOOLS.includes(tc.name) && tc.name !== 'Task'
    )
    .map((tc) => ({ name: tc.name, id: tc.id }));
}

interface UsageData {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface UsageJsonlEntry {
  type: string;
  timestamp?: string;
  sessionId?: string;
  message?: {
    model?: string;
    usage?: UsageData;
  };
}

/**
 * Detect compaction events in a conversation file
 * Returns the most recent compaction summary if found
 */
export function detectCompaction(
  filePath: string,
  sessionId: string,
  sessionName: string,
  projectPath: string,
  lastCheckedLine: number = 0,
  preReadContent?: string
): { event: CompactionEvent | null; lastLine: number } {
  const content =
    preReadContent ?? (fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '');
  if (!content) {
    return { event: null, lastLine: 0 };
  }

  const lines = content.split('\n').filter((line) => line.trim());
  let compactionEvent: CompactionEvent | null = null;

  // Only check lines after lastCheckedLine to avoid re-detecting old compactions
  for (let i = lastCheckedLine; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]);

      // Look for summary type entries (context compaction) — legacy format
      if (entry.type === 'summary' && entry.summary) {
        const timestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();
        compactionEvent = {
          sessionId,
          sessionName,
          projectPath,
          summary: cleanCompactionSummary(entry.summary),
          timestamp,
        };
      }
      // New compact_boundary format
      if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
        const timestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();
        // The summary is in the next user message (if it exists)
        let summary = 'Context compacted';
        if (i + 1 < lines.length) {
          try {
            const next = JSON.parse(lines[i + 1]);
            if (next.type === 'user' && next.message?.content) {
              const c = next.message.content;
              if (typeof c === 'string') summary = c.slice(0, MAX_SUMMARY_TEXT_LENGTH);
              else if (Array.isArray(c)) {
                const textBlock = c.find(
                  (b: { type: string; text?: string }) => b.type === 'text' && b.text
                );
                if (textBlock) summary = (textBlock.text || '').slice(0, MAX_SUMMARY_TEXT_LENGTH);
              }
            }
          } catch {
            /* skip */
          }
        }
        compactionEvent = {
          sessionId,
          sessionName,
          projectPath,
          summary: cleanCompactionSummary(summary),
          timestamp,
        };
      }
    } catch {
      // Skip malformed lines
    }
  }

  return { event: compactionEvent, lastLine: lines.length };
}

/**
 * Extract usage data from a conversation JSONL file
 */
export function extractUsageFromFile(filePath: string, sessionName: string): SessionUsage {
  const result: SessionUsage = {
    sessionId: filePath,
    sessionName,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    messageCount: 0,
    currentContextTokens: 0,
  };

  if (!fs.existsSync(filePath)) {
    return result;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter((line) => line.trim());
  const seenMessageIds = new Set<string>();

  for (const line of lines) {
    try {
      const entry: UsageJsonlEntry = JSON.parse(line);

      // Only count assistant messages with usage data
      if (entry.type === 'assistant' && entry.message?.usage) {
        const msgId = (entry as { message?: { id?: string } }).message?.id;

        // Skip duplicate message IDs (same message can appear multiple times as it streams)
        if (msgId && seenMessageIds.has(msgId)) {
          continue;
        }
        if (msgId) {
          seenMessageIds.add(msgId);
        }

        const usage = entry.message.usage;

        // Only add non-zero usage (final message has the totals)
        if (usage.input_tokens && usage.input_tokens > 0) {
          result.totalInputTokens += usage.input_tokens;
          result.messageCount++;
        }
        if (usage.output_tokens && usage.output_tokens > 0) {
          result.totalOutputTokens += usage.output_tokens;
        }
        if (usage.cache_creation_input_tokens && usage.cache_creation_input_tokens > 0) {
          result.totalCacheCreationTokens += usage.cache_creation_input_tokens;
        }
        if (usage.cache_read_input_tokens && usage.cache_read_input_tokens > 0) {
          result.totalCacheReadTokens += usage.cache_read_input_tokens;
        }
        // Track current context size from the most recent message
        if (usage.input_tokens) {
          result.currentContextTokens = usage.input_tokens;
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  return result;
}

// Input types for TaskCreate/TaskUpdate tools
interface TaskCreateInput {
  subject: string;
  description: string;
  activeForm?: string;
  metadata?: Record<string, unknown>;
}

interface TaskUpdateInput {
  taskId: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'deleted';
  subject?: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  addBlockedBy?: string[];
  addBlocks?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Extract tasks from JSONL content (from TaskCreate/TaskUpdate tool calls)
 */
export function extractTasks(content: string): TaskItem[] {
  const lines = content.split('\n').filter((line) => line.trim());

  // Track tasks by temporary ID (toolu_xxx) until we get real ID from result
  const pendingTasks = new Map<string, { task: Partial<TaskItem>; timestamp: number }>();
  // Map toolu_xxx to real task ID
  const toolIdToTaskId = new Map<string, string>();
  // Final tasks by real ID
  const tasks = new Map<string, TaskItem>();

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);

      if (entry.message?.content && Array.isArray(entry.message.content)) {
        const timestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();

        for (const block of entry.message.content) {
          // Handle TaskCreate
          if (block.type === 'tool_use' && block.name === 'TaskCreate') {
            const input = block.input as TaskCreateInput;
            const toolId = block.id as string;

            pendingTasks.set(toolId, {
              task: {
                subject: input.subject,
                description: input.description,
                activeForm: input.activeForm,
                status: 'pending',
                blockedBy: [],
                blocks: [],
                createdAt: timestamp,
                updatedAt: timestamp,
              },
              timestamp,
            });
          }

          // Handle TaskUpdate
          if (block.type === 'tool_use' && block.name === 'TaskUpdate') {
            const input = block.input as TaskUpdateInput;
            const taskId = input.taskId;

            // Find existing task
            const existingTask = tasks.get(taskId);
            if (existingTask) {
              // Handle deletion
              if (input.status === 'deleted') {
                tasks.delete(taskId);
                continue;
              }

              // Apply updates
              if (input.status) {
                existingTask.status = input.status as TaskItem['status'];
              }
              if (input.subject) {
                existingTask.subject = input.subject;
              }
              if (input.description) {
                existingTask.description = input.description;
              }
              if (input.activeForm) {
                existingTask.activeForm = input.activeForm;
              } else if (input.status === 'completed') {
                // Clear activeForm when completed
                existingTask.activeForm = undefined;
              }
              if (input.owner) {
                existingTask.owner = input.owner;
              }
              if (input.addBlockedBy) {
                existingTask.blockedBy = [...(existingTask.blockedBy || []), ...input.addBlockedBy];
              }
              if (input.addBlocks) {
                existingTask.blocks = [...(existingTask.blocks || []), ...input.addBlocks];
              }
              existingTask.updatedAt = timestamp;
            }
          }

          // Handle tool_result to get real task IDs
          if (block.type === 'tool_result' && block.tool_use_id) {
            const toolId = block.tool_use_id as string;
            const pending = pendingTasks.get(toolId);

            if (pending) {
              // Extract task ID from result content
              let resultContent = '';
              if (typeof block.content === 'string') {
                resultContent = block.content;
              } else if (Array.isArray(block.content)) {
                resultContent = block.content
                  .filter((c: { type: string; text?: string }) => c.type === 'text' && c.text)
                  .map((c: { text?: string }) => c.text || '')
                  .join('\n');
              }

              // Try to extract task ID from "Task created with ID: X"
              const idMatch = resultContent.match(/(?:Task created with ID:|id[:\s]+)(\d+)/i);
              if (idMatch) {
                const realId = idMatch[1];
                toolIdToTaskId.set(toolId, realId);

                // Create the task with real ID
                tasks.set(realId, {
                  id: realId,
                  subject: pending.task.subject || '',
                  description: pending.task.description || '',
                  status: pending.task.status || 'pending',
                  activeForm: pending.task.activeForm,
                  owner: pending.task.owner,
                  blockedBy: pending.task.blockedBy,
                  blocks: pending.task.blocks,
                  createdAt: pending.task.createdAt || timestamp,
                  updatedAt: pending.task.updatedAt || timestamp,
                });
              }

              pendingTasks.delete(toolId);
            }
          }
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  // Return tasks sorted by ID (numeric order)
  return Array.from(tasks.values()).sort((a, b) => {
    const aNum = parseInt(a.id, 10);
    const bNum = parseInt(b.id, 10);
    return aNum - bNum;
  });
}

/**
 * Extract file changes from JSONL content (from Write/Edit tool calls).
 * Only includes completed tool calls (those with a matching tool_result).
 * Deduplicates by file path, keeping the latest timestamp and upgrading
 * action to 'write' if both edit and write happened on the same file.
 */
export function extractFileChanges(content: string): FileChange[] {
  if (!content) return [];

  const lines = content.split('\n').filter((line) => line.trim());

  // First pass: collect completed tool IDs (those with tool_result)
  const completedToolIds = new Set<string>();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.message?.content && Array.isArray(entry.message.content)) {
        for (const block of entry.message.content) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            completedToolIds.add(block.tool_use_id);
          }
        }
      }
    } catch {
      continue;
    }
  }

  // Second pass: collect Write/Edit tool_use calls that have completed
  const changesByPath = new Map<string, FileChange>();

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.message?.content && Array.isArray(entry.message.content)) {
        const timestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();

        for (const block of entry.message.content) {
          if (block.type !== 'tool_use') continue;
          if (block.name !== 'Write' && block.name !== 'Edit') continue;

          const toolId = block.id as string;
          if (!completedToolIds.has(toolId)) continue;

          const input = block.input as Record<string, unknown> | undefined;
          const filePath = input?.file_path as string | undefined;
          if (!filePath) continue;

          const action: 'write' | 'edit' = block.name === 'Write' ? 'write' : 'edit';
          const existing = changesByPath.get(filePath);

          if (existing) {
            // Update timestamp to latest
            if (timestamp > existing.timestamp) {
              existing.timestamp = timestamp;
            }
            // Upgrade to 'write' if a Write happened on same file
            if (action === 'write') {
              existing.action = 'write';
            }
          } else {
            changesByPath.set(filePath, { path: filePath, action, timestamp });
          }
        }
      }
    } catch {
      continue;
    }
  }

  // Return sorted by path for stable ordering
  return Array.from(changesByPath.values()).sort((a, b) => a.path.localeCompare(b.path));
}
