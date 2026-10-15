/**
 * Per-agent state, folded entry by entry from the agent's sidechain transcript.
 * Fixed-size: counters, capped maps and rings; raw lines are never kept.
 */

import type { ToolCall } from '../types';
import type { StuckToolEvent } from '../stuck/signals';
import { toEvent } from '../stuck/signals';
import { analyzeFailure } from '../stuck/normalize';
import { redactSecrets } from '../herald/knowledge/redact';
import { clip, fnv1a, oneLine } from '../herald/text';
import { JsonlTail } from '../review/jsonl-tail';
import { notificationsInEntry, TaskNotification } from './notify';
import type {
  SubagentChecklist,
  SubagentEvent,
  SubagentStatus,
  SubagentStuck,
  SubagentTests,
} from './protocol';
import { SUBAGENT_LIMITS } from './protocol';

export const MAX_PENDING = 64;
export const MAX_STUCK_EVENTS = 120;
export const MAX_TOOL_NAMES = 40;
export const MAX_AGENT_CALLS = 100;
/** Tool output analysed for failures: head + tail of this many chars each. */
const OUTPUT_SLICE = 16 * 1024;

const AGENT_TOOLS = new Set(['Agent', 'Task']);
const TEST_CMD =
  /(?:^|[\s;&|(/])(?:jest|vitest|pytest|py\.test|mocha|playwright\s+test|cargo\s+(?:test|nextest)|go\s+test|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::[\w-]+)?|bin\/test|phpunit|rspec|ctest|tox|gradlew?\s+\S*test)\b/i;
const STEP_LINE =
  /(?:^|\n)\s*(?:[*_#>-]+\s*)?Step\s+(\d{1,3})\s*(?:\/|of)\s*(\d{1,3})\s*[:.)-]\s*([^\n]*)/i;

export interface AgentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
  spawnDepth?: number;
  background?: boolean;
  worktree?: string;
  model?: string;
  stoppedByUser?: boolean;
}

export function parseMeta(raw: string): AgentMeta {
  const out: AgentMeta = {};
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return out;
  }
  if (!j || typeof j !== 'object') return out;
  if (typeof j.agentType === 'string') out.agentType = clip(j.agentType, 60);
  if (typeof j.description === 'string') out.description = clip(oneLine(j.description), 160);
  if (typeof j.toolUseId === 'string') out.toolUseId = clip(j.toolUseId, 100);
  if (typeof j.spawnDepth === 'number' && j.spawnDepth >= 0) out.spawnDepth = j.spawnDepth;
  if (j.requestShape === 'background') out.background = true;
  else if (typeof j.requestShape === 'string') out.background = false;
  if (typeof j.worktreePath === 'string') out.worktree = clip(j.worktreePath, 300);
  if (typeof j.model === 'string') out.model = clip(j.model, 60);
  if (j.stoppedByUser === true) out.stoppedByUser = true;
  return out;
}

interface PendingTool {
  id: string;
  name: string;
  at: number;
  input: Record<string, unknown>;
}

export interface FoldResult {
  /** Notifications found in this entry (for this agent's children, or anything). */
  notifications: TaskNotification[];
  /** Agent / Task tool_use ids started by this agent (nesting). */
  agentCalls: string[];
}

function tsOf(v: unknown): number {
  if (typeof v !== 'string') return 0;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

function safe(s: string, max: number): string {
  return clip(redactSecrets(oneLine(s)), max);
}

function outputText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let s = '';
  for (const b of content as Array<{ type?: unknown; text?: unknown }>) {
    if (b && b.type === 'text' && typeof b.text === 'string') {
      s += (s ? '\n' : '') + b.text;
      if (s.length > OUTPUT_SLICE * 4) break;
    }
  }
  return s;
}

/**
 * Bounded output for failure analysis / hashing: head + tail, and very long
 * unbroken tokens (base64, minified code) folded to a hash so the stuck
 * normaliser's path regex cannot go quadratic on them.
 */
function sliceOutput(s: string): string {
  const cut =
    s.length <= OUTPUT_SLICE * 2 ? s : `${s.slice(0, OUTPUT_SLICE)}\n${s.slice(-OUTPUT_SLICE)}`;
  return cut.replace(/\S{200,}/g, (m) => `<long:${fnv1a(m)}>`);
}

export class AgentRecord {
  readonly agentId: string;
  sessionId: string;
  filePath: string;
  meta: AgentMeta = {};
  metaLoaded = false;

  startedAt = 0;
  lastEntryAt = 0;
  lastBytesAt = 0;
  lastAssistantAt = 0;
  lastTextAt = 0;
  lastEditAt = 0;
  lastStopReason: string | null = null;
  assistantEntries = 0;
  entries = 0;
  prompt?: string;
  lastText?: string;

  private pending = new Map<string, PendingTool>();
  toolCounts = new Map<string, number>();
  toolCalls = 0;
  edits = 0;
  files = new Map<string, number>();
  tests: SubagentTests | null = null;
  tokens = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  private curMsgId: string | null = null;
  private curUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  timeline: SubagentEvent[] = [];
  stuckEvents: StuckToolEvent[] = [];
  checklist: SubagentChecklist | null = null;
  agentCalls = new Set<string>();

  notification: TaskNotification | null = null;
  notifyKeys: string[] = [];
  notifications = 0;

  stuck: SubagentStuck | null = null;
  status: SubagentStatus = 'starting';
  endedAt?: number;

  tail: JsonlTail | null = null;
  /** Registered without reading (old file); read lazily on demand. */
  history = false;
  /** Only the newest part of the file was read. */
  partial = false;
  /** Bytes remain unread (budget ran out). */
  backlog = false;
  version = 1;
  /** Last time this record changed (LRU + eviction). */
  touchedAt = 0;
  /** Last known size of the file (stat backstop). */
  knownSize = 0;

  constructor(agentId: string, sessionId: string, filePath: string) {
    this.agentId = agentId;
    this.sessionId = sessionId;
    this.filePath = filePath;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  pendingList(): PendingTool[] {
    return [...this.pending.values()];
  }

  newestPending(): PendingTool | null {
    let best: PendingTool | null = null;
    for (const p of this.pending.values()) if (!best || p.at >= best.at) best = p;
    return best;
  }

  hasPendingAgentCall(): boolean {
    for (const p of this.pending.values()) if (AGENT_TOOLS.has(p.name)) return true;
    return false;
  }

  bump(now: number): void {
    this.version++;
    this.touchedAt = now;
  }

  /** Forget everything derived from the file (it shrank or was replaced). */
  resetDerived(): void {
    this.pending.clear();
    this.toolCounts.clear();
    this.files.clear();
    this.toolCalls = 0;
    this.edits = 0;
    this.tests = null;
    this.tokens = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    this.curMsgId = null;
    this.curUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    this.timeline = [];
    this.stuckEvents = [];
    this.checklist = null;
    this.assistantEntries = 0;
    this.entries = 0;
    this.lastStopReason = null;
    this.lastText = undefined;
  }

  /** Drop what only a running agent needs (stuck digest ring, pending inputs). */
  compact(): void {
    this.stuckEvents = [];
    for (const p of this.pending.values()) p.input = {};
  }

  /**
   * Context size in tokens: the latest task-notification's subagent_tokens when one
   * arrived after the newest message, else the newest message's input + cache + output
   * (the same measure). Cumulative per-kind usage is in tokenDetail().
   */
  totalTokens(): number {
    const c = this.curUsage;
    const ctx = c.input + c.cacheRead + c.cacheCreate + c.output;
    const n = this.notification;
    if (n?.tokens !== undefined && (n.at >= this.lastAssistantAt || !ctx)) return n.tokens;
    return ctx;
  }

  tokenDetail(): { input: number; output: number; cacheRead: number; cacheCreate: number } {
    const t = this.tokens;
    const c = this.curUsage;
    return {
      input: t.input + c.input,
      output: t.output + c.output,
      cacheRead: t.cacheRead + c.cacheRead,
      cacheCreate: t.cacheCreate + c.cacheCreate,
    };
  }

  private pushTimeline(ev: SubagentEvent): void {
    this.timeline.push(ev);
    if (this.timeline.length > SUBAGENT_LIMITS.timeline)
      this.timeline.splice(0, this.timeline.length - SUBAGENT_LIMITS.timeline);
  }

  private pushStuck(ev: StuckToolEvent): void {
    this.stuckEvents.push(ev);
    if (this.stuckEvents.length > MAX_STUCK_EVENTS)
      this.stuckEvents.splice(0, this.stuckEvents.length - MAX_STUCK_EVENTS);
  }

  private countTool(name: string): void {
    this.toolCalls++;
    if (this.toolCounts.has(name) || this.toolCounts.size < MAX_TOOL_NAMES)
      this.toolCounts.set(name, (this.toolCounts.get(name) || 0) + 1);
  }

  private touchFile(p: string): void {
    if (this.files.has(p) || this.files.size < SUBAGENT_LIMITS.files)
      this.files.set(p, (this.files.get(p) || 0) + 1);
  }

  /** A notification addressed to THIS agent. Returns true when it changed anything. */
  applyNotification(n: TaskNotification): boolean {
    if (this.notifyKeys.includes(n.key)) return false;
    this.notifyKeys.push(n.key);
    if (this.notifyKeys.length > 20) this.notifyKeys.shift();
    this.notifications++;
    if (!this.notification || n.at >= this.notification.at) {
      this.notification = {
        ...n,
        summary: safe(n.summary, 200),
        ...(n.result !== undefined ? { result: clip(redactSecrets(n.result.trim()), 600) } : {}),
      };
      this.pushTimeline({
        id: `n:${this.notifications}`,
        at: n.at,
        kind: 'notify',
        display: safe(`${n.status}: ${n.summary || ''}`, 160),
      });
    }
    return true;
  }

  private checklistFromTodos(input: Record<string, unknown>): void {
    const todos = input.todos;
    if (!Array.isArray(todos) || !todos.length) return;
    let done = 0;
    let current: string | undefined;
    for (const t of todos.slice(0, 200) as Array<Record<string, unknown>>) {
      if (t?.status === 'completed') done++;
      else if (t?.status === 'in_progress' && !current) {
        const label = typeof t.activeForm === 'string' ? t.activeForm : t.content;
        if (typeof label === 'string') current = safe(label, 100);
      }
    }
    this.checklist = { done, total: todos.length, source: 'todo', ...(current ? { current } : {}) };
  }

  private checklistFromText(text: string): void {
    if (this.checklist?.source === 'todo') return;
    const m = text.match(STEP_LINE);
    if (!m) return;
    const n = Number(m[1]);
    const total = Number(m[2]);
    if (!total || n < 1 || n > total) return;
    const current = safe(m[3] || '', 100);
    this.checklist = { done: n - 1, total, source: 'steps', ...(current ? { current } : {}) };
  }

  private commitUsage(): void {
    const c = this.curUsage;
    this.tokens.input += c.input;
    this.tokens.output += c.output;
    this.tokens.cacheRead += c.cacheRead;
    this.tokens.cacheCreate += c.cacheCreate;
    this.curUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  }

  private noteUsage(msgId: string | null, usage: unknown): void {
    if (!usage || typeof usage !== 'object') return;
    const u = usage as Record<string, unknown>;
    const n = (v: unknown) => (typeof v === 'number' && v > 0 ? v : 0);
    // Every content block of one message is its own entry and repeats the usage:
    // count each message id once (its newest figures).
    if (msgId !== this.curMsgId) {
      this.commitUsage();
      this.curMsgId = msgId;
    }
    this.curUsage = {
      input: n(u.input_tokens),
      output: n(u.output_tokens),
      cacheRead: n(u.cache_read_input_tokens),
      cacheCreate: n(u.cache_creation_input_tokens),
    };
  }

  /** Fold one parsed transcript entry. */
  fold(entry: Record<string, unknown>, now: number): FoldResult {
    const res: FoldResult = { notifications: [], agentCalls: [] };
    const at = tsOf(entry.timestamp) || now;
    this.entries++;
    if (!this.startedAt || at < this.startedAt) this.startedAt = at;
    const resumed =
      this.notification !== null && at > this.notification.at + 1500 && at > this.lastEntryAt;
    if (at > this.lastEntryAt) this.lastEntryAt = at;
    if (typeof entry.sessionId === 'string' && !this.sessionId) this.sessionId = entry.sessionId;
    const type = entry.type;
    const msg = (entry.message && typeof entry.message === 'object' ? entry.message : {}) as Record<
      string,
      unknown
    >;

    if (type === 'user' || type === 'queue-operation') {
      res.notifications = notificationsInEntry(entry as never);
      const content = msg.content;
      if (type === 'user' && typeof content === 'string') {
        if (!this.prompt) this.prompt = clip(redactSecrets(content.trim()), 300);
        else if (resumed)
          this.pushTimeline({
            id: `r:${this.entries}`,
            at,
            kind: 'resume',
            display: safe(content, 160),
          });
      }
      if (type === 'user' && Array.isArray(content)) {
        for (const b of content as Array<Record<string, unknown>>) {
          if (!b || b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
          this.completeTool(b.tool_use_id, b.content, b.is_error === true, at);
        }
      }
      return res;
    }

    if (type !== 'assistant') return res;
    this.assistantEntries++;
    this.lastAssistantAt = at;
    const msgId = typeof msg.id === 'string' ? msg.id : null;
    this.noteUsage(msgId, msg.usage);
    this.lastStopReason = typeof msg.stop_reason === 'string' ? msg.stop_reason : null;
    const content = msg.content;
    const blocks: Array<Record<string, unknown>> =
      typeof content === 'string'
        ? [{ type: 'text', text: content }]
        : Array.isArray(content)
          ? (content as Array<Record<string, unknown>>)
          : [];
    for (const b of blocks) {
      if (!b) continue;
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        this.lastText = safe(b.text, 160);
        this.lastTextAt = at;
        this.checklistFromText(b.text);
        this.pushTimeline({
          id: `t:${this.entries}`,
          at,
          kind: 'text',
          display: this.lastText,
        });
      } else if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
        const input =
          b.input && typeof b.input === 'object' ? (b.input as Record<string, unknown>) : {};
        this.startTool(b.id, b.name, input, at);
        if (AGENT_TOOLS.has(b.name)) {
          res.agentCalls.push(b.id);
          if (this.agentCalls.size < MAX_AGENT_CALLS) this.agentCalls.add(b.id);
        }
      }
    }
    return res;
  }

  private startTool(id: string, name: string, input: Record<string, unknown>, at: number): void {
    this.countTool(name);
    if (name === 'TodoWrite') this.checklistFromTodos(input);
    if (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
    this.pending.set(id, { id, name, at, input });
    const ev = toEvent({ id, name, input, status: 'pending', startedAt: at } as ToolCall, at);
    this.pushTimeline({
      id,
      at,
      kind: 'tool',
      tool: name,
      display: safe(
        name === 'Agent' || name === 'Task' ? String(input.description ?? ev.display) : ev.display,
        160
      ),
      pending: true,
    });
  }

  private completeTool(id: string, content: unknown, isError: boolean, at: number): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    const output = sliceOutput(outputText(content));
    const tc: ToolCall = {
      id,
      name: p.name,
      input: p.input,
      output,
      status: isError ? 'error' : 'completed',
      startedAt: p.at,
      completedAt: at,
      isError,
    };
    const ev = toEvent(tc, p.at);
    if (ev.isEdit) {
      this.edits++;
      this.lastEditAt = at;
      if (ev.file) this.touchFile(ev.file);
    }
    if (p.name === 'Bash') {
      const cmd = String(p.input.command ?? '');
      if (TEST_CMD.test(cmd)) {
        const f =
          ev.failed ||
          analyzeFailure('Bash', p.input, output, isError).keys.some((k) => k.type === 'test');
        const t = this.tests || { runs: 0, failed: 0, lastFailed: false, lastAt: 0 };
        t.runs++;
        if (f) t.failed++;
        t.lastFailed = f;
        t.lastAt = at;
        this.tests = t;
      }
    }
    // Bounded digest event: identity hashed, display redacted, no raw output.
    const slim: StuckToolEvent = {
      ...ev,
      inputKey: fnv1a(ev.inputKey),
      display: safe(ev.display, 120),
      ...(ev.cmdKey ? { cmdKey: fnv1a(ev.cmdKey) } : {}),
      ...(ev.rawCommand ? { rawCommand: safe(ev.rawCommand, 120) } : {}),
      ...(ev.excerpt ? { excerpt: clip(redactSecrets(ev.excerpt), 300) } : {}),
    };
    this.pushStuck(slim);
    for (let i = this.timeline.length - 1; i >= 0; i--) {
      const t = this.timeline[i];
      if (t.id !== id) continue;
      this.timeline[i] = {
        ...t,
        pending: false,
        doneAt: at,
        ...(ev.failed ? { failed: true } : {}),
      };
      break;
    }
  }

  /** Pending tools as digest events (stuck analysis). */
  pendingEvents(): StuckToolEvent[] {
    const out: StuckToolEvent[] = [];
    for (const p of this.pending.values()) {
      const ev = toEvent(
        { id: p.id, name: p.name, input: p.input, status: 'pending', startedAt: p.at } as ToolCall,
        p.at
      );
      out.push({ ...ev, inputKey: fnv1a(ev.inputKey), display: safe(ev.display, 160) });
    }
    return out.sort((a, b) => a.at - b.at);
  }

  /** "Bash: npm test" / last text. */
  activity(): { activity?: string; pendingTool?: string; pendingSince?: number } {
    const p = this.newestPending();
    if (p) {
      const shown = this.timeline.find((t) => t.id === p.id)?.display;
      return {
        activity: clip(`${p.name}${shown && shown !== p.name ? `: ${shown}` : ''}`, 160),
        pendingTool: p.name,
        pendingSince: p.at,
      };
    }
    return this.lastText ? { activity: this.lastText } : {};
  }

  /** Rough heap estimate (tests assert the per-agent bound). */
  approxBytes(): number {
    let n = 600;
    for (const t of this.timeline) n += 80 + t.display.length * 2 + (t.tool?.length ?? 0) * 2;
    for (const e of this.stuckEvents)
      n +=
        200 +
        (e.display.length +
          (e.rawCommand?.length ?? 0) +
          (e.excerpt?.length ?? 0) +
          e.inputKey.length) *
          2 +
        e.failureKeys.reduce((s, k) => s + 60 + (k.key.length + k.label.length) * 2, 0);
    for (const [k] of this.files) n += 40 + k.length * 2;
    for (const [k] of this.toolCounts) n += 30 + k.length * 2;
    n += (this.prompt?.length ?? 0) * 2 + (this.lastText?.length ?? 0) * 2;
    n += (this.notification?.result?.length ?? 0) * 2 + this.agentCalls.size * 70;
    for (const p of this.pending.values()) n += 100 + JSON.stringify(p.input).length * 2;
    return n;
  }
}
