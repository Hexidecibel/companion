/**
 * Codex CLI rollout parser: `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`
 * into the daemon's ConversationMessage / ToolCall model.
 *
 * Record shape: `{timestamp?, type, payload}`. What we read (codex-cli 0.165):
 *   - session_meta                 id, cwd, cli_version, git (never copied: creator_* ids are PII)
 *   - event_msg task_started       a turn starts
 *   - event_msg task_complete      the turn ended normally -> stopReason 'end_turn'
 *   - event_msg turn_aborted       the turn was interrupted -> system "Turn interrupted", 'aborted'
 *   - response_item message        user / assistant text; developer and harness-injected
 *                                  user content (environment_context, AGENTS.md, ...) is skipped
 *   - response_item reasoning      hidden (encrypted; the summary is usually empty)
 *   - response_item custom_tool_call / custom_tool_call_output   the `exec` code-mode tool
 *   - response_item function_call / function_call_output         plain tools (older rollouts)
 *   - response_item local_shell_call, web_search_call            generic
 *   - compacted                    a context compaction marker
 * Everything else (turn_context, token_count, world_state, item_completed,
 * thread_settings_applied, additional_tools, unknown types) is ignored.
 *
 * Append-only and incremental: `append()` takes newly read lines; replaced
 * messages are new objects (never mutated in place) so earlier snapshots stay
 * valid. A pending approval is NOT in the file: the rollout just ends with a
 * call that has no output, which is reported as `running`.
 */
import * as fs from 'fs';
import type { CompactionEvent, ConversationMessage, TaskItem, ToolCall } from '../../types';

/** Tool output kept per call (head of it); the web shows a preview anyway. */
export const CODEX_OUTPUT_LIMIT = 16 * 1024;

/** Stop reasons this parser writes on the last message of a finished turn. */
export const CODEX_TURN_END = 'end_turn';
export const CODEX_TURN_ABORTED = 'aborted';

type Rec = { timestamp?: string; type?: string; payload?: Record<string, unknown> } | null;

export interface CodexSessionMeta {
  id: string;
  cwd: string;
  /** session_meta.timestamp (ms), when the thread was created. */
  startedAt: number | null;
  cliVersion?: string;
  originator?: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function tsOf(rec: Rec, fallback: number): number {
  const t = rec?.timestamp ? Date.parse(rec.timestamp) : NaN;
  return Number.isFinite(t) ? t : fallback;
}

function truncate(s: string, max = CODEX_OUTPUT_LIMIT): string {
  return s.length > max ? `${s.slice(0, max)}\n... (${s.length - max} more chars)` : s;
}

/** Session meta from a session_meta payload (PII fields are never read). */
export function sessionMetaOf(payload: unknown): CodexSessionMeta | null {
  const p = obj(payload);
  const id = str(p.id) || str(p.session_id);
  const cwd = str(p.cwd);
  if (!id || !cwd) return null;
  const t = Date.parse(str(p.timestamp));
  return {
    id,
    cwd,
    startedAt: Number.isFinite(t) ? t : null,
    cliVersion: str(p.cli_version) || undefined,
    originator: str(p.originator) || undefined,
  };
}

// ---------------------------------------------------------------------------
// Harness-injected user content

const INJECTED_PREFIXES = [
  '<environment_context>',
  '<user_instructions>',
  '<permissions instructions>',
  '<turn_aborted>',
  '<collaboration_mode>',
  '<skills_instructions>',
  '# AGENTS.md instructions',
];

/** A role=user message that the harness wrote, not the user. */
export function isInjectedUserMessage(payload: Record<string, unknown>, text: string): boolean {
  const meta = obj(payload.internal_chat_message_metadata_passthrough);
  const kinds = Array.isArray(meta.content_item_kinds)
    ? (meta.content_item_kinds as unknown[]).filter((k): k is string => typeof k === 'string')
    : null;
  if (kinds && kinds.length > 0) return !kinds.some((k) => k.startsWith('user.'));
  const t = text.trimStart();
  return INJECTED_PREFIXES.some((p) => t.startsWith(p));
}

function contentText(content: unknown, kinds: string[]): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const c of content) {
    const b = obj(c);
    const type = str(b.type);
    if (kinds.includes(type) && typeof b.text === 'string') parts.push(b.text);
    else if (type === 'input_image' || type === 'image') parts.push('[image]');
  }
  return parts.join('\n').trim();
}

// ---------------------------------------------------------------------------
// Tool calls

/** Decode one JS string literal starting at `s[i]` (", ' or `). */
function readJsString(s: string, i: number): string | null {
  const q = s[i];
  if (q !== '"' && q !== "'" && q !== '`') return null;
  let out = '';
  for (let j = i + 1; j < s.length; j++) {
    const ch = s[j];
    if (ch === q) return out;
    if (ch === '\\' && j + 1 < s.length) {
      const n = s[++j];
      if (n === 'n') out += '\n';
      else if (n === 't') out += '\t';
      else if (n === 'r') out += '\r';
      else if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(j + 1, j + 5))) {
        out += String.fromCharCode(parseInt(s.slice(j + 1, j + 5), 16));
        j += 4;
      } else out += n;
      continue;
    }
    out += ch;
  }
  return null; // unterminated
}

/** Values of `key: "<string>"` (key quoted or not) in a JS snippet, in order. */
function stringProps(code: string, key: string): string[] {
  const re = new RegExp(`["']?\\b${key}\\b["']?\\s*:\\s*(?=["'\`])`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const v = readJsString(code, m.index + m[0].length);
    if (v !== null) out.push(v);
  }
  return out;
}

export interface ExecSummary {
  /** Inner tool names called by the snippet, in order (`tools.<name>(`). */
  tools: string[];
  commands: string[];
  justification?: string;
  escalated: boolean;
  patch?: string;
}

/** What a code-mode `exec` snippet does: `text(await tools.exec_command({cmd:"..."}))`. */
export function summarizeExecInput(code: string): ExecSummary {
  const tools: string[] = [];
  const re = /\btools\.([A-Za-z_][\w]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) tools.push(m[1]);
  const commands = stringProps(code, 'cmd');
  if (commands.length === 0) commands.push(...stringProps(code, 'command'));
  const justification = stringProps(code, 'justification')[0];
  const patch = stringProps(code, 'input').find((s) => s.includes('*** Begin Patch'));
  return {
    tools,
    commands,
    justification,
    escalated: /require_escalated/.test(code),
    ...(patch ? { patch } : {}),
  };
}

/** Files named by an apply_patch envelope (`*** Update File: path` ...). */
export function patchFiles(patch: string): string[] {
  const out: string[] = [];
  const re = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(patch)) !== null) {
    const f = m[1].trim();
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}

/** `["bash","-lc","cmd"]` -> "cmd"; other arrays are joined. */
function commandFromArgv(v: unknown): string {
  if (typeof v === 'string') return v;
  if (!Array.isArray(v)) return '';
  const argv = v.filter((a): a is string => typeof a === 'string');
  if (argv.length >= 3 && /(^|\/)(ba|z|da)?sh$/.test(argv[0]) && /^-l?c$/.test(argv[1])) {
    return argv.slice(2).join(' ');
  }
  return argv.join(' ');
}

interface ToolStart {
  name: string;
  input: Record<string, unknown>;
}

/** ToolCall name + input for a custom `exec` (code-mode) or other custom tool call. */
export function customToolStart(name: string, input: string): ToolStart {
  if (name === 'apply_patch') {
    return { name: 'apply_patch', input: { patch: input, files: patchFiles(input) } };
  }
  if (name !== 'exec') return { name, input: { input } };
  const s = summarizeExecInput(input);
  const extra: Record<string, unknown> = {};
  if (s.justification) extra.justification = s.justification;
  if (s.escalated) extra.sandbox_permissions = 'require_escalated';
  if (s.patch !== undefined || (s.tools.length > 0 && s.tools.every((t) => t === 'apply_patch'))) {
    const patch = s.patch ?? '';
    return { name: 'apply_patch', input: { patch, files: patchFiles(patch), ...extra } };
  }
  if (s.commands.length > 0) {
    return {
      name: 'exec_command',
      input: { command: s.commands.join('\n'), commands: s.commands, ...extra },
    };
  }
  const inner = s.tools.find((t) => t !== 'text') ?? 'exec';
  return { name: inner, input: { code: input, ...extra } };
}

/** ToolCall name + input for a plain function call (`arguments` is JSON text). */
export function functionToolStart(name: string, rawArgs: unknown): ToolStart {
  let args: Record<string, unknown> = {};
  if (typeof rawArgs === 'string') {
    try {
      args = obj(JSON.parse(rawArgs));
    } catch {
      args = { arguments: rawArgs };
    }
  } else args = obj(rawArgs);
  if (name === 'shell' || name === 'container.exec' || name === 'local_shell') {
    return { name, input: { ...args, command: commandFromArgv(args.command) } };
  }
  if (name === 'exec_command' || name === 'unified_exec') {
    const cmd = commandFromArgv(args.cmd ?? args.command);
    return { name, input: { ...args, command: cmd } };
  }
  if (name === 'apply_patch') {
    const patch = str(args.input) || str(args.patch);
    return { name, input: { patch, files: patchFiles(patch) } };
  }
  return { name, input: args };
}

export interface ToolResult {
  output: string;
  isError: boolean;
}

/** Exit code of a function_call_output text (`{"metadata":{"exit_code":1}}`, "Exit code: 1", ...). */
function exitCodeOfText(text: string): number | null {
  try {
    const v = obj(JSON.parse(text));
    const md = obj(v.metadata);
    if (typeof md.exit_code === 'number') return md.exit_code;
    if (typeof v.exit_code === 'number') return v.exit_code;
  } catch {
    /* not JSON */
  }
  const m = /(?:Exit code|exited with code|Process exited with code)[:\s]+(-?\d+)/i.exec(text);
  return m ? Number(m[1]) : null;
}

/**
 * custom_tool_call_output.output: `[{type:'input_text', text}]` where the first
 * text is "Script completed\nWall time ..." and each command chunk is JSON
 * `{exit_code, output, wall_time_seconds}`; or a plain string.
 */
export function customToolResult(output: unknown): ToolResult {
  const texts: string[] = [];
  if (typeof output === 'string') texts.push(output);
  else if (Array.isArray(output)) {
    for (const o of output) {
      const t = obj(o).text;
      if (typeof t === 'string') texts.push(t);
    }
  } else {
    const t = obj(output).content;
    if (typeof t === 'string') texts.push(t);
  }
  const parts: string[] = [];
  let isError = false;
  for (const t of texts) {
    if (/^Script (completed|failed)\b/.test(t)) {
      if (t.startsWith('Script failed')) {
        isError = true;
        parts.push(t.trim());
      }
      continue;
    }
    let chunk: Record<string, unknown> | null = null;
    if (t.trimStart().startsWith('{')) {
      try {
        chunk = obj(JSON.parse(t));
      } catch {
        chunk = null;
      }
    }
    if (chunk && ('exit_code' in chunk || 'output' in chunk)) {
      if (typeof chunk.exit_code === 'number' && chunk.exit_code !== 0) isError = true;
      parts.push(str(chunk.output));
    } else {
      parts.push(t);
    }
  }
  return { output: truncate(parts.join('\n').replace(/\n+$/, '')), isError };
}

/** function_call_output.output: a string (maybe JSON with output + metadata) or {content, success}. */
export function functionToolResult(output: unknown): ToolResult {
  if (typeof output === 'string') {
    let text = output;
    try {
      const v = obj(JSON.parse(output));
      if (typeof v.output === 'string') text = v.output;
    } catch {
      /* plain text */
    }
    const code = exitCodeOfText(output);
    return { output: truncate(text), isError: code !== null && code !== 0 };
  }
  const o = obj(output);
  const content = typeof o.content === 'string' ? o.content : JSON.stringify(output ?? '');
  const code = exitCodeOfText(content);
  return {
    output: truncate(content),
    isError: o.success === false || (code !== null && code !== 0),
  };
}

// ---------------------------------------------------------------------------
// Accumulator

/**
 * Incremental rollout parser; same interface the transcript cache uses for
 * Claude's ConversationAccumulator.
 */
export class CodexAccumulator {
  private msgs: ConversationMessage[] = [];
  /** call_id -> index of the message that holds the call. */
  private callAt = new Map<string, number>();
  private lines = 0;
  private turnOpen = false;
  /** Index of the first message of the current turn. */
  private turnStart = 0;
  private seq = 0;
  meta: CodexSessionMeta | null = null;

  get lineCount(): number {
    return this.lines;
  }

  /** True while a task (turn) has started and not completed / aborted. */
  get inTurn(): boolean {
    return this.turnOpen;
  }

  append(entries: Array<unknown>): void {
    for (const e of entries) {
      this.lines++;
      if (!e || typeof e !== 'object') continue;
      try {
        this.add(e as Rec);
      } catch {
        // one odd record never breaks the transcript
      }
    }
  }

  messages(): ConversationMessage[] {
    return this.msgs.slice();
  }

  tasks(): TaskItem[] {
    return [];
  }

  compactionSince(lastCheckedLine: number): { event: CompactionEvent | null; lastLine: number } {
    return { event: null, lastLine: Math.max(lastCheckedLine, this.lines) };
  }

  private nextId(prefix: string): string {
    return `codex-${prefix}-${this.lines}-${this.seq++}`;
  }

  private replace(i: number, msg: ConversationMessage): void {
    this.msgs[i] = msg;
  }

  private last(): ConversationMessage | undefined {
    return this.msgs[this.msgs.length - 1];
  }

  private add(rec: Rec): void {
    const type = rec?.type;
    const p = obj(rec?.payload);
    const now = tsOf(rec, this.last()?.timestamp ?? 0);
    if (type === 'session_meta') {
      this.meta = sessionMetaOf(p) ?? this.meta;
      return;
    }
    if (type === 'compacted') {
      this.msgs.push({
        id: this.nextId('compacted'),
        type: 'system',
        content: str(p.message) || 'Context compacted',
        timestamp: now,
        isCompaction: true,
      });
      return;
    }
    if (type === 'event_msg') {
      const t = str(p.type);
      if (t === 'task_started') {
        this.turnOpen = true;
        this.turnStart = this.msgs.length;
      } else if (t === 'task_complete') {
        this.endTurn(CODEX_TURN_END, now);
      } else if (t === 'turn_aborted') {
        this.endTurn(CODEX_TURN_ABORTED, now);
      }
      return;
    }
    if (type !== 'response_item') return;
    switch (str(p.type)) {
      case 'message':
        this.addMessage(p, now);
        return;
      case 'custom_tool_call': {
        const start = customToolStart(str(p.name) || 'exec', str(p.input));
        this.startTool(str(p.call_id) || str(p.id), start, now);
        return;
      }
      case 'function_call': {
        const start = functionToolStart(str(p.name) || 'function', p.arguments);
        this.startTool(str(p.call_id) || str(p.id), start, now);
        return;
      }
      case 'local_shell_call': {
        const action = obj(p.action);
        this.startTool(
          str(p.call_id) || str(p.id),
          { name: 'local_shell', input: { command: commandFromArgv(action.command) } },
          now
        );
        return;
      }
      case 'web_search_call': {
        const action = obj(p.action);
        const id = str(p.id) || this.nextId('web');
        this.startTool(id, { name: 'web_search', input: { query: str(action.query) } }, now);
        this.finishTool(id, { output: '', isError: false }, now);
        return;
      }
      case 'custom_tool_call_output':
        this.finishTool(str(p.call_id), customToolResult(p.output), now);
        return;
      case 'function_call_output':
        this.finishTool(str(p.call_id), functionToolResult(p.output), now);
        return;
      default:
        return; // reasoning (hidden), additional_tools, unknown
    }
  }

  private addMessage(p: Record<string, unknown>, ts: number): void {
    const role = str(p.role);
    if (role === 'user') {
      const text = contentText(p.content, ['input_text', 'text']);
      if (!text || isInjectedUserMessage(p, text)) return;
      this.msgs.push({
        id: str(p.id) || this.nextId('user'),
        type: 'user',
        content: text,
        timestamp: ts,
      });
      if (!this.turnOpen) this.turnStart = this.msgs.length - 1;
      return;
    }
    if (role === 'assistant') {
      const text = contentText(p.content, ['output_text', 'text']);
      if (!text) return;
      this.msgs.push({
        id: str(p.id) || this.nextId('assistant'),
        type: 'assistant',
        content: text,
        timestamp: ts,
      });
    }
    // developer / system: harness instructions, never shown
  }

  /** Tool calls hang off the current assistant message (Claude's shape: text + tool calls). */
  private startTool(callId: string, start: ToolStart, ts: number): void {
    const id = callId || this.nextId('call');
    const call: ToolCall = {
      id,
      name: start.name,
      input: start.input,
      status: 'running',
      startedAt: ts,
    };
    const i = this.msgs.length - 1;
    const last = this.msgs[i];
    if (last && last.type === 'assistant' && i >= this.turnStart && !last.stopReason) {
      this.replace(i, { ...last, toolCalls: [...(last.toolCalls ?? []), call] });
      this.callAt.set(id, i);
    } else {
      this.msgs.push({
        id: `codex-tools-${id}`,
        type: 'assistant',
        content: '',
        timestamp: ts,
        toolCalls: [call],
      });
      this.callAt.set(id, this.msgs.length - 1);
    }
  }

  private finishTool(callId: string, res: ToolResult, ts: number): void {
    const i = this.callAt.get(callId);
    if (i === undefined) return;
    const msg = this.msgs[i];
    if (!msg?.toolCalls) return;
    this.replace(i, {
      ...msg,
      toolCalls: msg.toolCalls.map((tc) =>
        tc.id === callId
          ? {
              ...tc,
              status: 'completed' as const,
              output: res.output,
              completedAt: ts,
              ...(res.isError ? { isError: true } : {}),
            }
          : tc
      ),
    });
  }

  private endTurn(reason: string, ts: number): void {
    this.turnOpen = false;
    // Calls still open when the turn ends (interrupted, or never answered).
    for (let i = this.turnStart; i < this.msgs.length; i++) {
      const msg = this.msgs[i];
      if (!msg.toolCalls?.some((tc) => tc.status === 'running' || tc.status === 'pending'))
        continue;
      this.replace(i, {
        ...msg,
        toolCalls: msg.toolCalls.map((tc) =>
          tc.status === 'running' || tc.status === 'pending'
            ? {
                ...tc,
                status: 'completed' as const,
                output: tc.output ?? (reason === CODEX_TURN_ABORTED ? '(interrupted)' : ''),
                completedAt: ts,
              }
            : tc
        ),
      });
    }
    if (reason === CODEX_TURN_ABORTED) {
      this.msgs.push({
        id: this.nextId('aborted'),
        type: 'system',
        content: 'Turn interrupted',
        timestamp: ts,
        stopReason: CODEX_TURN_ABORTED,
      });
    } else {
      const i = this.msgs.length - 1;
      if (i >= 0) this.replace(i, { ...this.msgs[i], stopReason: CODEX_TURN_END });
    }
    this.turnStart = this.msgs.length;
  }
}

/** Parse rollout text (whole file) into messages. */
export function parseCodexText(text: string): {
  messages: ConversationMessage[];
  acc: CodexAccumulator;
} {
  const acc = new CodexAccumulator();
  const entries: unknown[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      entries.push(null);
    }
  }
  acc.append(entries);
  return { messages: acc.messages(), acc };
}

/** parseFile for the adapter: whole file, optional newest-`limit` cut. */
export function parseCodexFile(
  filePath: string,
  limit?: number,
  preReadContent?: string
): ConversationMessage[] {
  let text = preReadContent;
  if (text === undefined) {
    try {
      text = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return [];
    }
  }
  const { messages } = parseCodexText(text);
  return limit && limit > 0 && messages.length > limit ? messages.slice(-limit) : messages;
}

// ---------------------------------------------------------------------------
// Status over messages

/** The last turn ended (task_complete or turn_aborted): Codex waits for the user. */
export function codexTurnEnded(messages: ConversationMessage[]): boolean {
  const last = messages[messages.length - 1];
  return !!last && (last.stopReason === CODEX_TURN_END || last.stopReason === CODEX_TURN_ABORTED);
}

/**
 * Calls of the open turn that wait on the user's approval: an `exec_command`
 * that asked for sandbox escalation (`sandbox_permissions: require_escalated`)
 * and has no output yet. Codex writes the call before it draws the approval
 * box and the output only after the answer (checked live, 0.165). Like
 * Claude's pending tool_use, an approved command that runs long still counts
 * until its output lands. Edits outside the sandbox ask without any mark in
 * the rollout; those are only seen on the pane.
 */
export function codexAwaitingApproval(
  messages: ConversationMessage[]
): Array<{ name: string; id: string }> {
  if (messages.length === 0 || codexTurnEnded(messages)) return [];
  const last = messages[messages.length - 1];
  if (last.type !== 'assistant' || !last.toolCalls) return [];
  return last.toolCalls
    .filter(
      (tc) =>
        (tc.status === 'running' || tc.status === 'pending') &&
        tc.input?.sandbox_permissions === 'require_escalated'
    )
    .map((tc) => ({ name: tc.name, id: tc.id }));
}

const PREVIEW = 60;

/** Status-bar text while Codex works; undefined once the turn ended. */
export function codexCurrentActivity(messages: ConversationMessage[]): string | undefined {
  if (messages.length === 0 || codexTurnEnded(messages)) return undefined;
  if (codexAwaitingApproval(messages).length > 0) return 'Waiting for approval';
  const last = messages[messages.length - 1];
  if (last.type === 'user') return 'Processing...';
  if (last.type !== 'assistant') return undefined;
  const tc = last.toolCalls?.[last.toolCalls.length - 1];
  if (!tc) return 'Working...';
  const running = tc.status === 'running' || tc.status === 'pending';
  if (tc.name === 'apply_patch') {
    const files = Array.isArray(tc.input.files) ? (tc.input.files as string[]) : [];
    const f = files[0] ? files[0].split('/').pop() : '';
    return running ? `Editing${f ? `: ${f}` : ''}` : 'Working...';
  }
  const cmd = typeof tc.input.command === 'string' ? tc.input.command.split('\n')[0] : '';
  if (running && cmd)
    return `Running: ${cmd.slice(0, PREVIEW)}${cmd.length > PREVIEW ? '...' : ''}`;
  if (running) return `Running ${tc.name}`;
  return 'Working...';
}
