// The chat window's one-line status: what the session is doing, for how long,
// how much it did. Pure (takes `now`), works from what the client already has;
// the daemon's TurnStats only fills in a turn longer than the loaded page.
// Claude and Codex tool names both map here (Codex keeps its own: exec_command,
// apply_patch, update_plan, ...).
import type { ConversationHighlight, SessionStatus, ToolCall, TurnStats } from '../types';
import { backgroundWorkLabel } from './backgroundWork';

export type StatusLinePhase = 'working' | 'background' | 'waiting' | 'done';

export interface StatusLine {
  phase: StatusLinePhase;
  /** Truncated first on a narrow screen. */
  activity: string;
  /** Always visible; empty fields are left out. */
  meta: string[];
}

export interface StatusStep {
  id: string;
  label: string;
  status: ToolCall['status'];
  durationMs?: number;
}

const MAX_COMMAND = 40;
const MAX_TARGET = 40;
const MAX_QUESTION = 200;

/** 42s, 4m 12s, 1h 12m: ticks while working. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** 42s, 6m, 1h 12m: the quieter form for a finished turn. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Relative to the project when that stays short, else just the file name. */
export function shortPath(path: string, projectPath?: string): string {
  const root = projectPath?.replace(/\/+$/, '');
  const rel = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
  if (rel && rel.length <= MAX_TARGET) return rel;
  return path.split('/').filter(Boolean).pop() || path;
}

/** A shell command in plain words: "Running tests", else the command cut short. */
export function commandLabel(command: string): string {
  const firstLine = command.split('\n').find((l) => l.trim()) ?? '';
  // What it actually runs, without the "cd x &&" / "source y;" / "FOO=1" lead-in.
  let cmd = firstLine.trim();
  for (;;) {
    const next = cmd
      .replace(/^(cd|source|\.)\s+\S+\s*(&&|;)\s*/, '')
      .replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, '');
    if (next === cmd) break;
    cmd = next;
  }
  if (!cmd) return 'Running a command';
  if (/^((npm|pnpm|yarn|bun)\s+(run\s+)?test\b|(npx\s+)?(vitest|jest|pytest)\b|cargo\s+test\b|go\s+test\b|make\s+test\b|(\S*\/)?bin\/test\b)/.test(cmd)) {
    return 'Running tests';
  }
  if (/^((npm|pnpm|yarn|bun)\s+run\s+typecheck\b|(npx\s+)?tsc\b)/.test(cmd)) return 'Type checking';
  if (/^((npm|pnpm|yarn|bun)\s+run\s+build\b|cargo\s+build\b|make(\s+build)?$)/.test(cmd)) return 'Building';
  return `Running ${clip(cmd, MAX_COMMAND)}`;
}

function firstPatchFile(input: Record<string, unknown>): string {
  return Array.isArray(input.files) && typeof input.files[0] === 'string' ? input.files[0] : '';
}

/** A tool call in plain words, for Claude and Codex alike. */
export function toolLabel(tc: Pick<ToolCall, 'name' | 'input'>, projectPath?: string): string {
  const input = tc.input ?? {};
  const target = (verb: string, path: string) =>
    path ? `${verb} ${shortPath(path, projectPath)}` : verb;
  switch (tc.name) {
    case 'Bash':
    case 'exec_command':
    case 'exec':
    case 'shell':
    case 'local_shell':
    case 'local_shell_call':
    case 'container.exec':
    case 'unified_exec':
      return commandLabel(str(input.command));
    case 'Read':
      return target('Reading', str(input.file_path));
    case 'view_image':
      return target('Viewing', str(input.path));
    case 'Write':
      return target('Writing', str(input.file_path));
    case 'Edit':
    case 'MultiEdit':
      return target('Editing', str(input.file_path));
    case 'NotebookEdit':
      return target('Editing', str(input.notebook_path));
    case 'apply_patch': {
      const files = Array.isArray(input.files) ? input.files.length : 0;
      const label = target('Editing', firstPatchFile(input));
      return files > 1 ? `${label} +${files - 1}` : label;
    }
    case 'Glob':
    case 'Grep': {
      const pattern = str(input.pattern);
      return pattern ? `Searching for ${clip(pattern, MAX_COMMAND)}` : 'Searching files';
    }
    case 'list_files':
      return 'Listing files';
    case 'WebSearch':
    case 'web_search':
    case 'web_search_call':
      return 'Searching the web';
    case 'WebFetch': {
      const host = /^https?:\/\/([^/]+)/.exec(str(input.url))?.[1];
      return host ? `Fetching ${host}` : 'Fetching a page';
    }
    case 'Task':
    case 'Agent': {
      const what = str(input.description);
      return what ? `Agent: ${clip(what, MAX_COMMAND)}` : 'Running an agent';
    }
    case 'TaskOutput':
      return 'Checking an agent';
    case 'BashOutput':
    case 'write_stdin':
      return 'Checking a command';
    case 'TodoWrite':
    case 'update_plan':
      return 'Updating the plan';
    case 'Skill':
      return str(input.skill) ? `Running ${clip(str(input.skill), MAX_COMMAND)}` : 'Running a skill';
    case 'AskUserQuestion':
    case 'request_user_input':
      return 'Asking a question';
    case 'ExitPlanMode':
      return 'Presenting a plan';
    default: {
      const mcp = /^mcp__.+__(.+)$/.exec(tc.name);
      return `Using ${mcp ? mcp[1] : tc.name}`;
    }
  }
}

/** Index of the message that started the current turn, -1 = not loaded. */
function turnStartIndex(highlights: ConversationHighlight[]): number {
  for (let i = highlights.length - 1; i >= 0; i--) {
    const h = highlights[i];
    if (h.type === 'user' && !h.content.startsWith('[Request interrupted')) return i;
  }
  return -1;
}

/** Same counting as the daemon's daemon/src/turn-stats.ts. */
export function turnFromHighlights(highlights: ConversationHighlight[]): TurnStats | undefined {
  const start = turnStartIndex(highlights);
  if (start < 0) return undefined;
  let tools = 0;
  const files = new Set<string>();
  for (let i = start + 1; i < highlights.length; i++) {
    for (const tc of highlights[i].toolCalls ?? []) {
      tools++;
      if (tc.status !== 'completed' || tc.isError) continue;
      const input = tc.input ?? {};
      if (tc.name === 'Edit' || tc.name === 'MultiEdit' || tc.name === 'Write') {
        if (str(input.file_path)) files.add(str(input.file_path));
      } else if (tc.name === 'NotebookEdit') {
        if (str(input.notebook_path)) files.add(str(input.notebook_path));
      } else if (tc.name === 'apply_patch' && Array.isArray(input.files)) {
        for (const f of input.files) if (typeof f === 'string') files.add(f);
      }
    }
  }
  return {
    startedAt: highlights[start].timestamp,
    endedAt: highlights[highlights.length - 1].timestamp,
    tools,
    files: files.size,
  };
}

/**
 * The daemon sees the whole turn; the loaded messages can be newer (a message
 * just sent, an update the daemon's last answer predates). Newest turn wins;
 * for the same turn, the higher count.
 */
export function pickTurn(local: TurnStats | undefined, server: TurnStats | null | undefined): TurnStats | undefined {
  if (!server) return local;
  if (!local) return server;
  if (local.startedAt !== server.startedAt) return local.startedAt > server.startedAt ? local : server;
  return {
    startedAt: local.startedAt,
    endedAt: Math.max(local.endedAt, server.endedAt),
    tools: Math.max(local.tools, server.tools),
    files: Math.max(local.files, server.files),
  };
}

/** The last few tool calls of this turn, oldest first. */
export function recentSteps(highlights: ConversationHighlight[], projectPath?: string, limit = 5): StatusStep[] {
  const steps: StatusStep[] = [];
  for (let i = highlights.length - 1; i >= 0 && steps.length < limit; i--) {
    const h = highlights[i];
    if (h.type === 'user' && !h.content.startsWith('[Request interrupted')) break;
    const calls = h.toolCalls ?? [];
    for (let j = calls.length - 1; j >= 0 && steps.length < limit; j--) {
      const tc = calls[j];
      steps.unshift({
        id: tc.id,
        label: toolLabel(tc, projectPath),
        status: tc.isError ? 'error' : tc.status,
        durationMs: tc.startedAt && tc.completedAt ? tc.completedAt - tc.startedAt : undefined,
      });
    }
  }
  return steps;
}

function lastMessage(highlights: ConversationHighlight[]): ConversationHighlight | undefined {
  for (let i = highlights.length - 1; i >= 0; i--) {
    if (highlights[i].type !== 'system') return highlights[i];
  }
  return undefined;
}

/** The question a turn ended on: only when its last line really asks one. */
export function endingQuestion(content: string): string | null {
  const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1]?.replace(/[*_`]/g, '').trim();
  if (!last || !last.endsWith('?')) return null;
  const sentence = last.split(/(?<=[.!:])\s+/).pop() ?? last;
  return sentence.replace(/^[-#>\s]+/, '');
}

function waitingQuestion(status: SessionStatus, last: ConversationHighlight | undefined, projectPath?: string): string | null {
  if (last?.isWaitingForChoice) {
    const q = last.questions?.[0];
    // A start-up prompt: the title, not the folder on its second line.
    if (q?.kind === 'trust') return q.question.split('\n')[0];
    return last.questions?.[0]?.question || last.content.trim() || 'Choose an option';
  }
  const activity = status.currentActivity;
  if (activity?.startsWith('Approve') || activity === 'Asking whether to trust this folder' || activity === 'Asking to allow Bypass Permissions mode') return activity;
  if (activity === 'Waiting for approval') return 'approval';
  if (last?.type !== 'assistant') return null;
  const pending = last.toolCalls?.filter((tc) => tc.status === 'pending').pop();
  if (pending) return `Approve: ${toolLabel(pending, projectPath)}`;
  return endingQuestion(last.content);
}

function workingActivity(status: SessionStatus, last: ConversationHighlight | undefined, projectPath?: string): string {
  if (status.currentActivity?.startsWith('Approve')) return status.currentActivity;
  if (last?.type === 'assistant') {
    const running = last.toolCalls?.filter((tc) => tc.status === 'running' || tc.status === 'pending').pop();
    if (running) return toolLabel(running, projectPath);
    return 'Thinking';
  }
  if (last?.type === 'user') return 'Thinking';
  // Nothing loaded yet: the daemon's text, minus its placeholders.
  const raw = status.currentActivity;
  return !raw || raw === 'Processing...' || raw === 'Working...' ? 'Thinking' : raw;
}

export interface StatusLineInput {
  status: SessionStatus | null;
  highlights?: ConversationHighlight[];
  turn?: TurnStats | null;
  runningAgents?: number;
  projectPath?: string;
  now: number;
}

/** The line to show, or null for no line. Feedback prompts are the caller's. */
export function buildStatusLine(input: StatusLineInput): StatusLine | null {
  const { status, highlights = [], runningAgents = 0, now } = input;
  if (!status) return null;
  const projectPath = input.projectPath ?? status.projectPath;
  const last = lastMessage(highlights);
  const turn = pickTurn(turnFromHighlights(highlights), input.turn);

  const background = backgroundWorkLabel(status.backgroundWork);
  if (background && !status.isWaitingForInput) {
    return { phase: 'background', activity: background, meta: turn ? [formatElapsed(now - turn.startedAt)] : [] };
  }

  // A live choice box is a wait even while the session reads as "working".
  if (status.isWaitingForInput || last?.isWaitingForChoice) {
    const question = waitingQuestion(status, last, projectPath);
    if (question) {
      return { phase: 'waiting', activity: `Waiting on you: ${clip(question.replace(/\s+/g, ' '), MAX_QUESTION)}`, meta: [] };
    }
    // Nothing has answered yet (a new session, a message still on its way).
    if (!turn || last?.type !== 'assistant') return { phase: 'waiting', activity: 'Waiting for input', meta: [] };
    return {
      phase: 'done',
      activity: 'Done',
      meta: [
        formatDuration(turn.endedAt - turn.startedAt),
        ...(turn.files > 0 ? [`${plural(turn.files, 'file')} changed`] : []),
      ],
    };
  }

  if (!status.currentActivity) return null;
  const meta: string[] = [];
  if (turn) {
    meta.push(formatElapsed(now - turn.startedAt));
    if (turn.tools > 0) meta.push(plural(turn.tools, 'tool'));
    if (turn.files > 0) meta.push(plural(turn.files, 'file'));
  }
  if (runningAgents > 0) meta.push(plural(runningAgents, 'agent'));
  return { phase: 'working', activity: workingActivity(status, last, projectPath), meta };
}

export interface ThrottledLine {
  key: string;
  line: StatusLine | null;
  at: number;
}

/** A hair under the 1 s tick, so timer jitter never skips a second. */
export const STATUS_LINE_MIN_GAP_MS = 950;

/**
 * Fast tool calls must not flicker: while working, the shown text changes at
 * most about once a second (the tick picks up whatever is newest). Anything
 * else (another session, another phase, a finished turn) shows at once.
 */
export function throttleLine(prev: ThrottledLine | null, key: string, next: StatusLine | null, now: number): ThrottledLine {
  const held =
    prev?.line &&
    next &&
    prev.key === key &&
    prev.line.phase === next.phase &&
    (next.phase === 'working' || next.phase === 'background') &&
    now - prev.at >= 0 &&
    now - prev.at < STATUS_LINE_MIN_GAP_MS;
  return held ? prev : { key, line: next, at: now };
}
