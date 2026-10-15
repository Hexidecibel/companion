/**
 * Synthetic transcripts shaped like real Claude Code ones:
 *   <proj>/<conv>.jsonl                          (parent, with <task-notification> entries)
 *   <proj>/<conv>/subagents/agent-<id>.jsonl     (sidechain, one content block per entry)
 *   <proj>/<conv>/subagents/agent-<id>.meta.json
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const T0 = Date.parse('2026-10-14T10:00:00.000Z');
export const CONV = '1e2e016d-e122-49f0-9300-88028c066d62';

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function tmpProjects(): { root: string; proj: string; subDir: string; convPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subagents-'));
  const proj = path.join(root, '-home-u-src-app');
  const subDir = path.join(proj, CONV, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  const convPath = path.join(proj, `${CONV}.jsonl`);
  fs.writeFileSync(convPath, '');
  return { root, proj, subDir, convPath };
}

export function line(o: unknown): string {
  return JSON.stringify(o) + '\n';
}

export function prompt(agentId: string, at: number, text = 'Do the thing'): string {
  return line({
    parentUuid: null,
    isSidechain: true,
    agentId,
    type: 'user',
    message: { role: 'user', content: text },
    uuid: `u-${at}`,
    timestamp: iso(at),
    sessionId: CONV,
  });
}

export function toolUse(
  agentId: string,
  at: number,
  msgId: string,
  id: string,
  name: string,
  input: Record<string, unknown>,
  stop: string | null = null,
  usage = {
    input_tokens: 2,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 1000,
    output_tokens: 50,
  }
): string {
  return line({
    isSidechain: true,
    agentId,
    type: 'assistant',
    message: {
      id: msgId,
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input, caller: { type: 'direct' } }],
      stop_reason: stop,
      usage,
    },
    timestamp: iso(at),
    sessionId: CONV,
  });
}

export function text(
  agentId: string,
  at: number,
  msgId: string,
  body: string,
  stop: string | null = null
): string {
  return line({
    isSidechain: true,
    agentId,
    type: 'assistant',
    message: {
      id: msgId,
      role: 'assistant',
      content: [{ type: 'text', text: body }],
      stop_reason: stop,
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 500,
        output_tokens: 30,
      },
    },
    timestamp: iso(at),
    sessionId: CONV,
  });
}

export function result(
  agentId: string,
  at: number,
  id: string,
  content: string,
  isError = false
): string {
  return line({
    isSidechain: true,
    agentId,
    type: 'user',
    message: {
      role: 'user',
      content: [
        { tool_use_id: id, type: 'tool_result', content, ...(isError ? { is_error: true } : {}) },
      ],
    },
    timestamp: iso(at),
    sessionId: CONV,
  });
}

export function notification(
  agentId: string,
  at: number,
  status = 'completed',
  opts: { tokens?: number; summary?: string; result?: string; preamble?: boolean } = {}
): string {
  const usage =
    opts.tokens !== undefined
      ? `\n<usage><subagent_tokens>${opts.tokens}</subagent_tokens><tool_uses>3</tool_uses><duration_ms>9000</duration_ms></usage>`
      : '';
  const body =
    `<task-notification>\n<task-id>${agentId}</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n` +
    `<output-file>/tmp/x/${agentId}.output</output-file>\n<status>${status}</status>\n` +
    `<summary>${opts.summary ?? `Agent "${agentId}" finished`}</summary>\n` +
    `<result>${opts.result ?? 'All done.'}</result>${usage}\n</task-notification>`;
  return line({
    parentUuid: 'p',
    isSidechain: false,
    type: 'user',
    message: {
      role: 'user',
      content: opts.preamble
        ? `[SYSTEM NOTIFICATION - NOT USER INPUT]\nautomated\n\n${body}`
        : body,
    },
    origin: 'task-notification',
    timestamp: iso(at),
    sessionId: CONV,
  });
}

export function queuedNotification(agentId: string, at: number, status = 'completed'): string {
  return line({
    type: 'queue-operation',
    operation: 'enqueue',
    timestamp: iso(at),
    sessionId: CONV,
    content:
      `<task-notification>\n<task-id>${agentId}</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n` +
      `<status>${status}</status>\n<summary>Agent "${agentId}" finished</summary>\n` +
      `<result>All done.</result>\n</task-notification>`,
  });
}

export function meta(subDir: string, agentId: string, m: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(subDir, `agent-${agentId}.meta.json`),
    JSON.stringify({ spawnDepth: 1, requestShape: 'background', requestNonInteractive: true, ...m })
  );
}

export function agentFile(subDir: string, agentId: string): string {
  return path.join(subDir, `agent-${agentId}.jsonl`);
}

export function append(file: string, s: string): void {
  fs.appendFileSync(file, s);
}
