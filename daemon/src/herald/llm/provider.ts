/**
 * Provider-neutral chat interface for Herald's brain.
 *
 * The tool loop, grounding and guardrails are written against this interface only;
 * concrete providers (OpenAI-compatible local servers, Anthropic) translate to and
 * from their wire formats.
 */

export interface LlmToolSpec {
  name: string;
  description: string;
  /** JSON Schema (object) for the tool's arguments. */
  parameters: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  /** Raw JSON argument string exactly as the model produced it (may be malformed). */
  arguments: string;
}

export type LlmTurn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError?: boolean };

export interface LlmChatRequest {
  system: string;
  messages: LlmTurn[];
  tools: LlmToolSpec[];
  /** 'none' forces a text-only answer (used on the final loop iteration). */
  toolChoice: 'auto' | 'none';
  maxTokens: number;
  signal: AbortSignal;
  /** Called for each visible text delta as it streams. */
  onText: (delta: string) => void;
}

export type LlmStopReason = 'end' | 'tool_calls' | 'max_tokens' | 'refusal' | 'other';

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface LlmChatResult {
  text: string;
  toolCalls: LlmToolCall[];
  stopReason: LlmStopReason;
  usage: LlmUsage;
  /** ms from request start to first streamed text/tool token (undefined if none). */
  firstTokenMs?: number;
}

export type LlmErrorCode =
  | 'unreachable'
  | 'timeout'
  | 'auth'
  | 'rate_limited'
  | 'bad_request'
  | 'server'
  | 'aborted'
  | 'protocol';

export class LlmError extends Error {
  readonly code: LlmErrorCode;
  constructor(code: LlmErrorCode, message: string) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
  }
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  chat(req: LlmChatRequest): Promise<LlmChatResult>;
}
