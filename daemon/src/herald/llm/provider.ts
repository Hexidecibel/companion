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
  /**
   * Prompt caching hint: system + tools are a stable prefix the provider may
   * cache. Providers without caching ignore it.
   */
  cache?: { ttl: '5m' | '1h' };
  /** 'none' forces a text-only answer (used on the final loop iteration). */
  toolChoice: 'auto' | 'none';
  maxTokens: number;
  signal: AbortSignal;
  /** Called for each visible text delta as it streams. */
  onText: (delta: string) => void;
}

export type LlmStopReason = 'end' | 'tool_calls' | 'max_tokens' | 'refusal' | 'other';

export interface LlmUsage {
  /** Uncached input tokens (billed at the base input rate). */
  inputTokens?: number;
  outputTokens?: number;
  /** Input tokens served from the prompt cache (billed at the cache-read rate). */
  cacheReadInputTokens?: number;
  /** Input tokens written to the prompt cache (billed at the cache-write rate). */
  cacheCreationInputTokens?: number;
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
  /** Out of API credit / billing problem (402, or "credit balance is too low"). */
  | 'credit'
  /** The API is overloaded (529). */
  | 'overloaded'
  | 'bad_request'
  | 'server'
  | 'aborted'
  | 'protocol';

export class LlmError extends Error {
  readonly code: LlmErrorCode;
  /** HTTP status from the API, when there was one. */
  readonly status?: number;
  constructor(code: LlmErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  chat(req: LlmChatRequest): Promise<LlmChatResult>;
  /**
   * Cheap health check used to recover from an outage without a user turn.
   * Resolves when the brain answers; rejects with an LlmError otherwise.
   */
  healthCheck?(signal: AbortSignal): Promise<void>;
}
