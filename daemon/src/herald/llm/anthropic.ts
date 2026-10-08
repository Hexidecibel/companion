/**
 * Anthropic Messages API provider (opt-in: herald.provider = "anthropic").
 *
 * The SDK is imported lazily so the daemon never loads it unless this provider is
 * actually used. The API key comes only from ANTHROPIC_API_KEY (resolved in config).
 *
 * Prompt caching: tools render before system, so ONE breakpoint on the (single)
 * system block caches tools + system as a byte-stable prefix shared by every turn
 * and every tool-loop step. Everything volatile (fleet snapshot with its
 * timestamp, reply-style note, the user's words) lives in the messages after it.
 * Inside a tool loop a second breakpoint on the newest tool result lets the next
 * step read the turn so far instead of paying for it again. Haiku 4.5 only caches
 * a prefix of at least 4096 tokens; Herald's tools + system are ~5.4K.
 */

import type AnthropicClient from '@anthropic-ai/sdk';
import {
  LlmChatRequest,
  LlmChatResult,
  LlmError,
  LlmProvider,
  LlmStopReason,
  LlmToolCall,
  LlmTurn,
  LlmUsage,
} from './provider';

type AnthropicCtor = typeof AnthropicClient;

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  requestTimeoutMs: number;
  /** Injectable constructor for tests. */
  ctor?: AnthropicCtor;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function toAnthropicMessages(turns: LlmTurn[]): AnthropicClient.MessageParam[] {
  const out: AnthropicClient.MessageParam[] = [];
  let toolResults: AnthropicClient.ToolResultBlockParam[] = [];
  const flushTools = () => {
    if (toolResults.length > 0) {
      out.push({ role: 'user', content: toolResults });
      toolResults = [];
    }
  };
  for (const t of turns) {
    if (t.role === 'tool') {
      toolResults.push({
        type: 'tool_result',
        tool_use_id: t.toolCallId,
        content: t.content,
        is_error: t.isError || undefined,
      });
      continue;
    }
    flushTools();
    if (t.role === 'user') {
      out.push({ role: 'user', content: t.text });
    } else {
      const blocks: AnthropicClient.ContentBlockParam[] = [];
      if (t.text) blocks.push({ type: 'text', text: t.text });
      for (const c of t.toolCalls || []) {
        blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: parseArgs(c.arguments) });
      }
      if (blocks.length > 0) out.push({ role: 'assistant', content: blocks });
    }
  }
  flushTools();
  return out;
}

/** Mark the last block of the last message as a cache breakpoint (tool-loop steps). */
function markLastBlock(
  messages: AnthropicClient.MessageParam[],
  cache: AnthropicClient.CacheControlEphemeral
): void {
  const last = messages[messages.length - 1];
  if (!last || typeof last.content === 'string' || last.content.length === 0) return;
  const blocks = last.content.slice();
  const tail = blocks[blocks.length - 1];
  if (tail.type !== 'tool_result' && tail.type !== 'text') return;
  blocks[blocks.length - 1] = { ...tail, cache_control: cache } as typeof tail;
  messages[messages.length - 1] = { ...last, content: blocks };
}

/** The Messages API request for one brain call (exported for tests). */
export function buildAnthropicRequest(
  model: string,
  req: Pick<
    LlmChatRequest,
    'system' | 'messages' | 'tools' | 'toolChoice' | 'maxTokens' | 'cache' | 'effort'
  >
): AnthropicClient.MessageCreateParamsNonStreaming {
  const cache: AnthropicClient.CacheControlEphemeral | undefined = req.cache
    ? req.cache.ttl === '1h'
      ? { type: 'ephemeral', ttl: '1h' }
      : { type: 'ephemeral' }
    : undefined;
  const messages = toAnthropicMessages(req.messages);
  // A tool-loop step (the request ends in tool results): cache the turn so far
  // for the next step. A plain first call does not: its tail is unique.
  if (cache && req.messages[req.messages.length - 1]?.role === 'tool')
    markLastBlock(messages, cache);
  return {
    model,
    max_tokens: req.maxTokens,
    system: [{ type: 'text', text: req.system, ...(cache ? { cache_control: cache } : {}) }],
    messages,
    ...(req.effort ? { output_config: { effort: req.effort } } : {}),
    ...(req.tools.length > 0
      ? {
          tools: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters as AnthropicClient.Tool.InputSchema,
          })),
          tool_choice: { type: req.toolChoice } as AnthropicClient.ToolChoice,
        }
      : {}),
  };
}

/** Normalize the API's usage block (null-safe). */
export function usageFromAnthropic(u: Partial<AnthropicClient.Usage> | null | undefined): LlmUsage {
  return {
    inputTokens: u?.input_tokens ?? undefined,
    outputTokens: u?.output_tokens ?? undefined,
    cacheReadInputTokens: u?.cache_read_input_tokens ?? undefined,
    cacheCreationInputTokens: u?.cache_creation_input_tokens ?? undefined,
  };
}

const CREDIT_MESSAGE = /credit balance|billing|purchase credits|insufficient (?:funds|credit)/i;

/** Map an SDK error to Herald's provider-neutral error classes. */
export function classifyAnthropicError(
  err: unknown,
  Ctor: AnthropicCtor,
  aborted: boolean
): LlmError {
  if (aborted || err instanceof Ctor.APIUserAbortError)
    return new LlmError('aborted', 'Request aborted');
  if (err instanceof Ctor.APIConnectionTimeoutError)
    return new LlmError('timeout', 'Anthropic API request timed out');
  if (err instanceof Ctor.APIConnectionError)
    return new LlmError('unreachable', 'Anthropic API unreachable');
  if (err instanceof Ctor.APIError) {
    const status = typeof err.status === 'number' ? err.status : undefined;
    const msg = (err as Error).message || '';
    const type = (err as { type?: unknown }).type;
    if (status === 402 || type === 'billing_error' || CREDIT_MESSAGE.test(msg))
      return new LlmError('credit', 'Anthropic API: out of credit (billing)', status);
    if (err instanceof Ctor.AuthenticationError || err instanceof Ctor.PermissionDeniedError)
      return new LlmError(
        'auth',
        'Anthropic API rejected the key (check ANTHROPIC_API_KEY)',
        status
      );
    if (err instanceof Ctor.RateLimitError)
      return new LlmError('rate_limited', 'Anthropic API rate limited the request', status);
    if (status === 529 || type === 'overloaded_error')
      return new LlmError('overloaded', 'Anthropic API is overloaded', status);
    if (err instanceof Ctor.BadRequestError || err instanceof Ctor.NotFoundError)
      return new LlmError(
        'bad_request',
        `Anthropic API rejected the request: ${msg.slice(0, 300)}`,
        status
      );
    return new LlmError('server', `Anthropic API error: ${msg.slice(0, 300)}`, status);
  }
  return new LlmError(
    'protocol',
    `Anthropic request failed: ${err instanceof Error ? err.message : String(err)}`
  );
}

function mapStop(reason: string | null | undefined): LlmStopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end';
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  readonly model: string;
  private opts: AnthropicProviderOptions;
  private client: AnthropicClient | null = null;
  private ctor: AnthropicCtor | null;

  constructor(opts: AnthropicProviderOptions) {
    this.opts = opts;
    this.model = opts.model;
    this.ctor = opts.ctor || null;
  }

  private async getClient(): Promise<{ client: AnthropicClient; Ctor: AnthropicCtor }> {
    if (!this.ctor) {
      const mod = await import('@anthropic-ai/sdk');
      this.ctor = (mod.default || (mod as unknown as AnthropicCtor)) as AnthropicCtor;
    }
    if (!this.client) {
      this.client = new this.ctor({
        apiKey: this.opts.apiKey,
        timeout: this.opts.requestTimeoutMs,
        maxRetries: 1,
      });
    }
    return { client: this.client, Ctor: this.ctor };
  }

  async chat(req: LlmChatRequest): Promise<LlmChatResult> {
    const { client, Ctor } = await this.getClient();
    const started = Date.now();
    let firstTokenMs: number | undefined;
    const mark = () => {
      if (firstTokenMs === undefined) firstTokenMs = Date.now() - started;
    };
    try {
      const stream = client.messages.stream(
        buildAnthropicRequest(req.model || this.opts.model, req),
        {
          signal: req.signal,
        }
      );
      stream.on('text', (delta: string) => {
        mark();
        req.onText(delta);
      });
      stream.on('streamEvent', (ev: AnthropicClient.MessageStreamEvent) => {
        if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') mark();
      });
      const msg = await stream.finalMessage();
      const text = msg.content
        .filter((b): b is AnthropicClient.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const toolCalls: LlmToolCall[] = msg.content
        .filter((b): b is AnthropicClient.ToolUseBlock => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) }));
      return {
        text,
        toolCalls,
        stopReason: mapStop(msg.stop_reason),
        usage: usageFromAnthropic(msg.usage),
        firstTokenMs,
      };
    } catch (err) {
      throw classifyAnthropicError(err, Ctor, req.signal.aborted);
    }
  }

  /**
   * Outage recovery: one tiny real request (about 10 tokens, a hundredth of a
   * cent), because only a real call proves the key AND the credit balance.
   */
  async healthCheck(signal: AbortSignal): Promise<void> {
    const { client, Ctor } = await this.getClient();
    try {
      await client.messages.create(
        {
          model: this.opts.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        },
        { signal, maxRetries: 0 }
      );
    } catch (err) {
      throw classifyAnthropicError(err, Ctor, signal.aborted);
    }
  }
}
