/**
 * Parsing Claude Code's <task-notification> envelope (pure).
 *
 * The harness writes one into the PARENT transcript (the main conversation, or the
 * spawning agent's sidechain for nested agents) each time an agent stops:
 *
 *   <task-notification><task-id>{agentId}</task-id><tool-use-id>..</tool-use-id>
 *   <status>completed|failed|killed</status><summary>..</summary>[<result>..</result>]
 *   [<usage><subagent_tokens>N</subagent_tokens><tool_uses>N</tool_uses><duration_ms>N</duration_ms></usage>]
 *   </task-notification>
 *
 * Carriers: a `type:'user'` entry whose content is a string (or text blocks),
 * possibly after a "[SYSTEM NOTIFICATION ...]" preamble, and a
 * `type:'queue-operation'` enqueue (string `content`) when the parent was busy.
 * Tool results and assistant text that merely quote one are never accepted.
 * Background Bash tasks use the same envelope: callers match known agent ids only.
 */

export type NotifyStatus = 'completed' | 'failed' | 'stopped';

export interface TaskNotification {
  taskId: string;
  toolUseId?: string;
  status: NotifyStatus;
  summary: string;
  result?: string;
  tokens?: number;
  toolUses?: number;
  durationMs?: number;
  at: number;
  /** Same stop seen twice (queued, then delivered) compares equal. */
  key: string;
}

const NEEDLE = '<task-notification>';
const BLOCK =
  /<task-notification>\s*<task-id>([^<\s]{1,100})<\/task-id>([\s\S]*?)<\/task-notification>/g;

function tag(body: string, name: string, max: number): string | undefined {
  const i = body.indexOf(`<${name}>`);
  if (i < 0) return undefined;
  const j = body.indexOf(`</${name}>`, i);
  const raw = j < 0 ? body.slice(i + name.length + 2) : body.slice(i + name.length + 2, j);
  return raw.length > max ? raw.slice(0, max) : raw;
}

function num(body: string, name: string): number | undefined {
  const v = tag(body, name, 40);
  if (v === undefined) return undefined;
  const n = Number(v.trim());
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function mapStatus(s: string | undefined): NotifyStatus | null {
  const v = (s || '').trim();
  if (v === 'completed') return 'completed';
  if (v === 'failed') return 'failed';
  if (v === 'killed' || v === 'stopped' || v === 'cancelled') return 'stopped';
  return null;
}

/** Every notification in one text (usually one). */
export function parseNotifications(text: string, at: number): TaskNotification[] {
  if (!text || text.indexOf(NEEDLE) < 0) return [];
  const out: TaskNotification[] = [];
  BLOCK.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BLOCK.exec(text)) && out.length < 20) {
    const body = m[2];
    const status = mapStatus(tag(body, 'status', 40));
    if (!status) continue;
    const summary = (tag(body, 'summary', 400) || '').trim();
    const result = tag(body, 'result', 4000);
    const n: TaskNotification = {
      taskId: m[1],
      status,
      summary,
      at,
      key: '',
    };
    const toolUseId = tag(body, 'tool-use-id', 200)?.trim();
    if (toolUseId) n.toolUseId = toolUseId;
    if (result !== undefined) n.result = result.trim();
    const tokens = num(body, 'subagent_tokens');
    const toolUses = num(body, 'tool_uses');
    const durationMs = num(body, 'duration_ms');
    if (tokens !== undefined) n.tokens = tokens;
    if (toolUses !== undefined) n.toolUses = toolUses;
    if (durationMs !== undefined) n.durationMs = durationMs;
    n.key = [
      m[1],
      status,
      summary.slice(0, 120),
      tokens ?? '',
      toolUses ?? '',
      durationMs ?? '',
    ].join('|');
    out.push(n);
  }
  return out;
}

interface EntryLike {
  type?: unknown;
  operation?: unknown;
  content?: unknown;
  timestamp?: unknown;
  message?: { content?: unknown };
}

function ts(v: unknown): number {
  if (typeof v !== 'string') return 0;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

/** Notifications carried by one parsed transcript entry (see header for the accepted carriers). */
export function notificationsInEntry(entry: EntryLike): TaskNotification[] {
  if (!entry || typeof entry !== 'object') return [];
  const at = ts(entry.timestamp);
  if (entry.type === 'queue-operation') {
    if (entry.operation !== undefined && entry.operation !== 'enqueue') return [];
    return typeof entry.content === 'string' ? parseNotifications(entry.content, at) : [];
  }
  if (entry.type !== 'user') return [];
  const c = entry.message?.content;
  if (typeof c === 'string') return parseNotifications(c, at);
  if (!Array.isArray(c)) return [];
  const out: TaskNotification[] = [];
  for (const b of c as Array<{ type?: unknown; text?: unknown }>) {
    if (b && b.type === 'text' && typeof b.text === 'string')
      out.push(...parseNotifications(b.text, at));
  }
  return out;
}

export const NOTIFICATION_NEEDLE = NEEDLE;
