/**
 * "The turn ended in an unresolved error": the only tool error worth a
 * notification. Claude hits harmless tool errors all the time (a grep with no
 * match, an Edit whose old_string drifted, a red test mid-TDD) and recovers on
 * its own; those must stay silent.
 *
 * Rule (deterministic, transcript only, no LLM):
 *
 *  1. The turn has ENDED: the last message is the assistant's, none of its
 *     tool calls is pending / running, and (when the CLI records it) its
 *     stop_reason is a real end (`end_turn` / `stop_sequence` / `max_tokens`),
 *     not `tool_use`. The caller additionally requires the session to be idle
 *     or waiting.
 *  2. The turn = everything after the user's last prompt.
 *  3. E = the LAST errored tool call of the turn (`is_error` from the
 *     transcript). Errors the user caused (a rejected tool, an interrupt) do
 *     not count.
 *  4. E is RESOLVED, and nothing fires, when
 *       a. a later tool call of the same kind succeeded (same tool; Edit /
 *          MultiEdit / Write / NotebookEdit are one kind; Bash is keyed by its
 *          command, e.g. `npm test`, `npm run build`, `git push`), or
 *       b. the assistant's final text after E clearly moved on: it does not
 *          talk about a failure ("fails", "error", "couldn't", "blocked", ...)
 *          or it says the failure was expected ("fails as expected").
 *     With no assistant text after E at all, the turn ended right on the
 *     error: unresolved.
 *
 * The result is keyed by E's tool_use id, so one turn notifies at most once.
 */

import type { ConversationMessage, ToolCall } from './types';
import { redactSecrets } from './herald/knowledge/redact';

export interface TurnEndError {
  /** tool_use id of the error the turn ended on (dedupe key). */
  toolId: string;
  /** Tool name ("Bash", "Edit", ...). */
  tool: string;
  /** First meaningful error line, redacted and clipped. */
  line: string;
  /** `${tool}: ${line}` (what notifications show). */
  preview: string;
}

/** stop_reason values that end a turn (anything else, e.g. tool_use, does not). */
const END_REASONS = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal']);

const EDIT_KIND = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** Errors the user caused: a rejected tool, an interrupt. Never "the turn failed". */
const USER_CAUSED =
  /The user doesn't want to proceed with this tool use|tool use was rejected|\[Request interrupted by user|interrupted by user/i;

/** Text that talks about a failure (the error stands). */
const ACKNOWLEDGES_FAILURE =
  /\b(fail(?:s|ed|ing|ure|ures)?|errors?|errored|couldn'?t|could not|can'?t|cannot|unable|blocked|broken|not working|didn'?t work|doesn'?t work|won'?t work|denied|refused|timed? ?out|crash(?:es|ed)?|still (?:red|failing))\b/i;
/** Phrases where an error word is not about this turn failing. */
const NOT_A_FAILURE =
  /\b(error handling|error messages?|error states?|error codes?|error paths?|error boundar(?:y|ies)|without errors?|no errors?|0 errors?|zero errors?|0 failures?|no failures?)\b/gi;
/** The failure was the point (TDD red step, a probe). */
const EXPECTED_FAILURE =
  /\b(as expected|expected(?: it)? to fail|expected failure|fails? (?:first|for now) as|red (?:phase|step)|(?:is|are) failing for the right reason)\b/i;

/** Package runners and multi-command tools: the subcommand is part of the kind. */
const SUBCOMMAND_TOOLS = new Set([
  'npm',
  'npx',
  'yarn',
  'pnpm',
  'bun',
  'cargo',
  'go',
  'git',
  'docker',
  'make',
  'uv',
  'poetry',
  'pip',
  'pip3',
  'dotnet',
  'gradle',
  './gradlew',
  'gradlew',
  'mvn',
  'kubectl',
  'gh',
  'systemctl',
]);
const PREFIX_COMMANDS = /^(cd|source|\.|export|set|pushd|popd|unset|true|echo)$/;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ERROR_LINE =
  /\b(error|err!|fail(?:ed|ure)?|fatal|exception|traceback|panic|cannot|can't|could not|not found|no such|denied|refused|timed? ?out|invalid|unexpected|missing)\b/i;
const EXIT_LINE = /^(error: )?exit code \d+$/i;
const MAX_LINE = 160;

function isError(tc: ToolCall): boolean {
  return tc.status === 'error' || tc.isError === true;
}

function isPrompt(m: ConversationMessage): boolean {
  if (m.type !== 'user') return false;
  const c = (m.content || '').trim();
  return c.length > 0 && !c.startsWith('<system-reminder>');
}

/** The kind of a Bash command: its program (plus subcommand for runners), env/cd prefixes skipped. */
export function bashKind(command: string): string {
  const segments = command.split(/&&|\|\||;|\n|\|/);
  for (const seg of segments) {
    const words = seg
      .trim()
      .split(/\s+/)
      .filter((w) => w && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    if (!words.length) continue;
    const head = words[0].startsWith('./') ? words[0] : words[0].replace(/^.*\//, '');
    if (PREFIX_COMMANDS.test(head)) continue;
    const rest = words.slice(1).filter((w) => !w.startsWith('-'));
    if (SUBCOMMAND_TOOLS.has(head) && rest.length) {
      if ((rest[0] === 'run' || rest[0] === 'exec') && rest[1])
        return `${head} ${rest[0]} ${rest[1]}`;
      return `${head} ${rest[0]}`;
    }
    return head;
  }
  return '';
}

export function toolKind(tc: ToolCall): string {
  if (EDIT_KIND.has(tc.name)) return 'edit';
  if (tc.name === 'Bash') {
    const cmd = typeof tc.input?.command === 'string' ? tc.input.command : '';
    return `Bash:${bashKind(cmd)}`;
  }
  return tc.name;
}

/** Whether the assistant's text after an error leaves that error standing. */
export function textLeavesErrorStanding(text: string): boolean {
  const t = text.replace(NOT_A_FAILURE, ' ');
  if (EXPECTED_FAILURE.test(t)) return false;
  return ACKNOWLEDGES_FAILURE.test(t);
}

/** The first meaningful error line of a tool result (ANSI stripped, redacted, clipped). */
export function firstErrorLine(output: string | undefined): string {
  const lines = (output || '')
    .replace(ANSI_RE, '')
    .replace(/<\/?tool_use_error>/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const exit = lines.find((l) => EXIT_LINE.test(l));
  const body = lines.filter((l) => !EXIT_LINE.test(l));
  const pick = body.find((l) => ERROR_LINE.test(l)) || body[0] || exit || 'Tool error';
  const one = redactSecrets(pick.replace(/\s+/g, ' '));
  return one.length > MAX_LINE ? `${one.slice(0, MAX_LINE - 1)}…` : one;
}

export function detectTurnEndError(messages: ConversationMessage[]): TurnEndError | null {
  const last = messages[messages.length - 1];
  if (!last || last.type !== 'assistant') return null;
  if (last.toolCalls?.some((tc) => tc.status === 'pending' || tc.status === 'running')) return null;
  if (last.stopReason !== undefined && !END_REASONS.has(last.stopReason)) return null;

  let start = messages.length - 1;
  while (start >= 0 && !isPrompt(messages[start])) start--;
  const turn = messages.slice(start + 1);

  const calls: Array<{ tc: ToolCall; msg: number }> = [];
  turn.forEach((m, i) => {
    if (m.type === 'assistant') for (const tc of m.toolCalls || []) calls.push({ tc, msg: i });
  });

  let eIdx = -1;
  for (let i = calls.length - 1; i >= 0; i--) {
    const tc = calls[i].tc;
    if (isError(tc) && !USER_CAUSED.test(tc.output || '')) {
      eIdx = i;
      break;
    }
  }
  if (eIdx < 0) return null;
  const e = calls[eIdx];

  // a. A later call of the same kind succeeded.
  const kind = toolKind(e.tc);
  for (let i = eIdx + 1; i < calls.length; i++) {
    const tc = calls[i].tc;
    if (tc.status === 'completed' && !isError(tc) && toolKind(tc) === kind) return null;
  }

  // b. The assistant's final word after the error moved on.
  let finalText = '';
  for (let i = turn.length - 1; i > e.msg; i--) {
    const m = turn[i];
    if (m.type === 'assistant' && (m.content || '').trim()) {
      finalText = m.content;
      break;
    }
  }
  if (finalText && !textLeavesErrorStanding(finalText)) return null;

  const line = firstErrorLine(e.tc.output);
  return { toolId: e.tc.id, tool: e.tc.name, line, preview: `${e.tc.name}: ${line}` };
}
