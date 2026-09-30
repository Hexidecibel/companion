/**
 * Anthropic Messages API provider (opt-in: herald.provider = "anthropic").
 *
 * The SDK is imported lazily so the daemon never loads it unless this provider is
 * actually used. The API key comes only from ANTHROPIC_API_KEY (resolved in config).
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
        {
          model: this.opts.model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: toAnthropicMessages(req.messages),
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
        },
        { signal: req.signal }
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
        usage: { inputTokens: msg.usage?.input_tokens, outputTokens: msg.usage?.output_tokens },
        firstTokenMs,
      };
    } catch (err) {
      if (req.signal.aborted || err instanceof Ctor.APIUserAbortError)
        throw new LlmError('aborted', 'Request aborted');
      if (err instanceof Ctor.APIConnectionTimeoutError)
        throw new LlmError('timeout', 'Anthropic API request timed out');
      if (err instanceof Ctor.APIConnectionError)
        throw new LlmError('unreachable', 'Anthropic API unreachable');
      if (err instanceof Ctor.AuthenticationError || err instanceof Ctor.PermissionDeniedError) {
        throw new LlmError('auth', 'Anthropic API rejected the key (check ANTHROPIC_API_KEY)');
      }
      if (err instanceof Ctor.RateLimitError)
        throw new LlmError('rate_limited', 'Anthropic API rate limited the request');
      if (err instanceof Ctor.BadRequestError || err instanceof Ctor.NotFoundError) {
        throw new LlmError(
          'bad_request',
          `Anthropic API rejected the request: ${(err as Error).message.slice(0, 300)}`
        );
      }
      if (err instanceof Ctor.APIError)
        throw new LlmError(
          'server',
          `Anthropic API error: ${(err as Error).message.slice(0, 300)}`
        );
      throw new LlmError(
        'protocol',
        `Anthropic request failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
