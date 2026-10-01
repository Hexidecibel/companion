import Anthropic from '@anthropic-ai/sdk';
import {
  AnthropicProvider,
  buildAnthropicRequest,
  classifyAnthropicError,
  usageFromAnthropic,
} from '../src/herald/llm/anthropic';
import { LlmChatRequest, LlmError, LlmTurn } from '../src/herald/llm/provider';
import { runTurn } from '../src/herald/brain';
import { TOOL_SPECS } from '../src/herald/tools';
import { buildSystemPrompt } from '../src/herald/prompt';

const Ctor = Anthropic as unknown as typeof Anthropic;

function req(messages: LlmTurn[], extra: Partial<LlmChatRequest> = {}) {
  return {
    system: 'SYSTEM',
    messages,
    tools: [{ name: 'list_sessions', description: 'd', parameters: { type: 'object', properties: {} } }],
    toolChoice: 'auto' as const,
    maxTokens: 700,
    cache: { ttl: '5m' as const },
    ...extra,
  };
}

describe('Anthropic request shape (prompt caching)', () => {
  it('puts one breakpoint on the system block (tools render before it), none on a first call', () => {
    const r = buildAnthropicRequest('claude-haiku-4-5', req([{ role: 'user', text: 'hi' }]));
    expect(r.system).toEqual([{ type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral' } }]);
    expect(r.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(JSON.stringify(r.tools)).not.toContain('cache_control');
    expect(r.tool_choice).toEqual({ type: 'auto' });
  });

  it('1h TTL is passed through', () => {
    const r = buildAnthropicRequest('m', req([{ role: 'user', text: 'hi' }], { cache: { ttl: '1h' } }));
    expect((r.system as Anthropic.TextBlockParam[])[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('no cache option = no cache_control anywhere', () => {
    const r = buildAnthropicRequest('m', req([{ role: 'user', text: 'hi' }], { cache: undefined }));
    expect(JSON.stringify(r)).not.toContain('cache_control');
  });

  it('a tool-loop step caches the turn so far on the newest tool result', () => {
    const r = buildAnthropicRequest(
      'm',
      req([
        { role: 'user', text: 'snapshot + question' },
        { role: 'assistant', text: '', toolCalls: [{ id: 't1', name: 'list_sessions', arguments: '{}' }] },
        { role: 'tool', toolCallId: 't1', name: 'list_sessions', content: '[]' },
      ])
    );
    const last = r.messages[r.messages.length - 1];
    expect(last.role).toBe('user');
    const blocks = last.content as Anthropic.ToolResultBlockParam[];
    expect(blocks[blocks.length - 1].cache_control).toEqual({ type: 'ephemeral' });
    // Still exactly two breakpoints (limit is 4).
    expect(JSON.stringify(r).match(/cache_control/g)).toHaveLength(2);
  });

  it('the prefix is byte-identical across turns and tool-loop steps', () => {
    const sys = buildSystemPrompt('Herald', { webUrls: ['http://192.168.1.48:9877/web'] });
    const tools = TOOL_SPECS;
    const a = buildAnthropicRequest('m', { ...req([{ role: 'user', text: 'one' }]), system: sys, tools });
    const b = buildAnthropicRequest('m', {
      ...req([
        { role: 'user', text: 'two' },
        { role: 'assistant', text: 'x', toolCalls: [{ id: 'a', name: 'list_sessions', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'a', name: 'list_sessions', content: '[]' },
      ]),
      system: sys,
      tools,
      toolChoice: 'none',
    });
    expect(JSON.stringify(a.tools)).toBe(JSON.stringify(b.tools));
    expect(JSON.stringify(a.system)).toBe(JSON.stringify(b.system));
    // No volatile content in the cached prefix.
    expect(sys).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
    expect(JSON.stringify(tools)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
    // Deterministic tool order.
    expect(TOOL_SPECS.map((t) => t.name)).toEqual(TOOL_SPECS.map((t) => t.name));
  });

  it('usage maps cache read / write tokens', () => {
    expect(
      usageFromAnthropic({
        input_tokens: 412,
        output_tokens: 31,
        cache_read_input_tokens: 5401,
        cache_creation_input_tokens: 0,
      } as Anthropic.Usage)
    ).toEqual({ inputTokens: 412, outputTokens: 31, cacheReadInputTokens: 5401, cacheCreationInputTokens: 0 });
    expect(usageFromAnthropic(undefined)).toEqual({
      inputTokens: undefined,
      outputTokens: undefined,
      cacheReadInputTokens: undefined,
      cacheCreationInputTokens: undefined,
    });
  });
});

describe('Anthropic provider end to end (fake SDK client)', () => {
  function fakeCtor(final: Partial<Anthropic.Message>, seen: unknown[]) {
    class Fake {
      messages = {
        stream: (params: unknown) => {
          seen.push(params);
          const handlers: Record<string, (x: unknown) => void> = {};
          return {
            on(ev: string, fn: (x: unknown) => void) {
              handlers[ev] = fn;
              return this;
            },
            async finalMessage() {
              handlers.text?.('Hello.');
              return { content: [{ type: 'text', text: 'Hello.' }], stop_reason: 'end_turn', ...final };
            },
          };
        },
      };
    }
    return Object.assign(Fake, {
      APIError: Ctor.APIError,
      APIUserAbortError: Ctor.APIUserAbortError,
      APIConnectionError: Ctor.APIConnectionError,
      APIConnectionTimeoutError: Ctor.APIConnectionTimeoutError,
      AuthenticationError: Ctor.AuthenticationError,
      PermissionDeniedError: Ctor.PermissionDeniedError,
      RateLimitError: Ctor.RateLimitError,
      BadRequestError: Ctor.BadRequestError,
      NotFoundError: Ctor.NotFoundError,
    }) as unknown as typeof Anthropic;
  }

  it('sends cache_control and reports cache usage through the brain loop', async () => {
    const seen: unknown[] = [];
    const p = new AnthropicProvider({
      apiKey: 'k',
      model: 'claude-haiku-4-5',
      requestTimeoutMs: 1000,
      ctor: fakeCtor(
        {
          usage: {
            input_tokens: 300,
            output_tokens: 12,
            cache_read_input_tokens: 5400,
            cache_creation_input_tokens: 0,
          } as Anthropic.Usage,
        },
        seen
      ),
    });
    const perRequest: unknown[] = [];
    const out = await runTurn(p, {
      history: [],
      userText: 'hi',
      snapshot: '[snap]',
      systemPrompt: 'SYS',
      maxTokens: 100,
      signal: new AbortController().signal,
      onText: () => {},
      runTool: async () => ({ content: '{}', isError: false }),
      cache: { ttl: '5m' },
      onUsage: (u) => perRequest.push(u),
    });
    expect(out.text).toBe('Hello.');
    expect(out.usage).toEqual({ inputTokens: 300, outputTokens: 12, cacheReadInputTokens: 5400, cacheCreationInputTokens: 0 });
    expect(perRequest).toHaveLength(1);
    expect(JSON.stringify(seen[0])).toContain('"cache_control":{"type":"ephemeral"}');
  });
});

describe('Anthropic error classes', () => {
  const gen = (status: number, type: string, message: string) =>
    Ctor.APIError.generate(status, { type: 'error', error: { type, message } }, message, new Headers());
  const code = (e: unknown, aborted = false) => classifyAnthropicError(e, Ctor, aborted).code;

  it.each([
    [401, 'authentication_error', 'invalid x-api-key', 'auth'],
    [403, 'permission_error', 'no access', 'auth'],
    [402, 'billing_error', 'payment required', 'credit'],
    [400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API.', 'credit'],
    [429, 'rate_limit_error', 'slow down', 'rate_limited'],
    [529, 'overloaded_error', 'Overloaded', 'overloaded'],
    [500, 'api_error', 'boom', 'server'],
    [503, 'api_error', 'unavailable', 'server'],
    [400, 'invalid_request_error', 'messages: bad', 'bad_request'],
  ])('%i %s -> %s', (status, type, message, expected) => {
    const e = classifyAnthropicError(gen(status, type, message), Ctor, false);
    expect(e).toBeInstanceOf(LlmError);
    expect(e.code).toBe(expected);
    expect(e.status).toBe(status);
  });

  it('network, timeout, abort', () => {
    expect(code(new Ctor.APIConnectionError({ message: 'ECONNREFUSED' }))).toBe('unreachable');
    expect(code(new Ctor.APIConnectionTimeoutError({ message: 'timeout' }))).toBe('timeout');
    expect(code(new Ctor.APIUserAbortError())).toBe('aborted');
    expect(code(new Error('x'), true)).toBe('aborted');
    expect(code(new Error('weird'))).toBe('protocol');
  });
});
