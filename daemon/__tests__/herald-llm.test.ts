import * as net from 'net';
import { OpenAiCompatibleProvider, ThinkFilter, tcpProbe } from '../src/herald/llm/openai-compatible';
import { LlmChatRequest, LlmChatResult, LlmError, LlmProvider } from '../src/herald/llm/provider';
import { historyToTurns, runTurn, MAX_TOOL_ITERATIONS } from '../src/herald/brain';
import type { ToolOutcome } from '../src/herald/tools';

const enc = new TextEncoder();

function sse(chunks: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

const data = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const delta = (d: Record<string, unknown>, finish: string | null = null) => data({ choices: [{ index: 0, delta: d, finish_reason: finish }] });

function provider(fetchImpl: jest.Mock, extra: Partial<ConstructorParameters<typeof OpenAiCompatibleProvider>[0]> = {}) {
  return new OpenAiCompatibleProvider({
    baseUrl: 'http://spark.local:8000/v1',
    model: 'qwen3-8b',
    requestTimeoutMs: 2000,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    probe: async () => {},
    ...extra,
  });
}

function req(overrides: Partial<LlmChatRequest> = {}): LlmChatRequest & { texts: string[] } {
  const texts: string[] = [];
  return {
    system: 'sys',
    messages: [{ role: 'user', text: 'hi' }],
    tools: [{ name: 'list_sessions', description: 'd', parameters: { type: 'object', properties: {} } }],
    toolChoice: 'auto',
    maxTokens: 100,
    signal: new AbortController().signal,
    onText: (d) => texts.push(d),
    texts,
    ...overrides,
  };
}

describe('OpenAiCompatibleProvider', () => {
  it('streams text split across arbitrary chunk boundaries and reports usage', async () => {
    const payload =
      delta({ role: 'assistant', content: 'Two sessions ' }) +
      delta({ content: 'are waiting.' }) +
      delta({}, 'stop') +
      data({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 7 } }) +
      'data: [DONE]\n\n';
    const parts = [payload.slice(0, 13), payload.slice(13, 70), payload.slice(70)];
    const fetchMock = jest.fn(async () => sse(parts));
    const r = req();
    const res = await provider(fetchMock).chat(r);
    expect(res.text).toBe('Two sessions are waiting.');
    expect(r.texts.join('')).toBe('Two sessions are waiting.');
    expect(res.stopReason).toBe('end');
    expect(res.usage).toEqual({ inputTokens: 50, outputTokens: 7 });
    expect(res.firstTokenMs).toBeGreaterThanOrEqual(0);
  });

  it('accumulates fragmented tool-call arguments across chunks', async () => {
    const fetchMock = jest.fn(async () =>
      sse([
        delta({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'summarize_session', arguments: '' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '{"ses' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: 'sion": "comp' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: 'anion"}' } }] }),
        delta({}, 'tool_calls'),
        'data: [DONE]\n\n',
      ])
    );
    const res = await provider(fetchMock).chat(req());
    expect(res.stopReason).toBe('tool_calls');
    expect(res.toolCalls).toEqual([{ id: 'call_a', name: 'summarize_session', arguments: '{"session": "companion"}' }]);
  });

  it('handles text mixed with two interleaved parallel tool calls', async () => {
    const fetchMock = jest.fn(async () =>
      sse([
        delta({ content: 'Checking both. ' }),
        delta({ tool_calls: [{ index: 0, id: 'c0', function: { name: 'summarize_session', arguments: '{"session":' } }] }),
        delta({ tool_calls: [{ index: 1, id: 'c1', function: { name: 'summarize_session', arguments: '{"session":' } }] }),
        delta({ tool_calls: [{ index: 1, function: { arguments: '"notes"}' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '"companion"}' } }] }),
        delta({}, 'tool_calls'),
        'data: [DONE]\n\n',
      ])
    );
    const res = await provider(fetchMock).chat(req());
    expect(res.text).toBe('Checking both. ');
    expect(res.toolCalls.map((c) => [c.id, JSON.parse(c.arguments).session])).toEqual([
      ['c0', 'companion'],
      ['c1', 'notes'],
    ]);
  });

  it('tolerates servers that send tool calls only in the final chunk (no index, object args)', async () => {
    const fetchMock = jest.fn(async () =>
      sse([
        delta({ content: '' }),
        data({ choices: [{ index: 0, delta: { tool_calls: [{ id: 'x', function: { name: 'list_sessions', arguments: {} } }] }, finish_reason: 'stop' }] }),
      ])
    );
    const res = await provider(fetchMock).chat(req());
    expect(res.toolCalls).toEqual([{ id: 'x', name: 'list_sessions', arguments: '{}' }]);
    expect(res.stopReason).toBe('tool_calls');
  });

  it('uses a final `message.tool_calls` block when present', async () => {
    const fetchMock = jest.fn(async () =>
      sse([
        delta({ tool_calls: [{ index: 0, function: { name: 'list_sess' } }] }),
        data({ choices: [{ index: 0, message: { tool_calls: [{ id: 'z', function: { name: 'list_sessions', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }),
      ])
    );
    const res = await provider(fetchMock).chat(req());
    expect(res.toolCalls).toEqual([{ id: 'z', name: 'list_sessions', arguments: '{}' }]);
  });

  it('suppresses inline <think> reasoning', async () => {
    const fetchMock = jest.fn(async () =>
      sse([delta({ content: '<thi' }), delta({ content: 'nk>secret plan</th' }), delta({ content: 'ink>\nAll quiet.' }), delta({}, 'stop')])
    );
    const r = req();
    const res = await provider(fetchMock).chat(r);
    expect(res.text).toBe('All quiet.');
    expect(r.texts.join('')).not.toMatch(/secret|think/);
  });

  it('maps finish_reason length to max_tokens even with tool calls', async () => {
    const fetchMock = jest.fn(async () =>
      sse([delta({ tool_calls: [{ index: 0, id: 'a', function: { name: 'propose_input', arguments: '{"session":"c","te' } }] }, 'length')])
    );
    expect((await provider(fetchMock).chat(req())).stopReason).toBe('max_tokens');
  });

  it('sends the expected request shape (tools, tool_choice, auth, tool turns)', async () => {
    const fetchMock = jest.fn(async (_url: string, _init: RequestInit) => sse([delta({ content: 'ok' }, 'stop')]));
    const p = provider(fetchMock, { apiKey: 'sekrit' });
    await p.chat(
      req({
        toolChoice: 'none',
        messages: [
          { role: 'user', text: 'status?' },
          { role: 'assistant', text: '', toolCalls: [{ id: 't1', name: 'list_sessions', arguments: '{}' }] },
          { role: 'tool', toolCallId: 't1', name: 'list_sessions', content: '{"error":"x"}', isError: true },
        ],
      })
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://spark.local:8000/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sekrit');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('qwen3-8b');
    expect(body.stream).toBe(true);
    expect(body.tool_choice).toBe('none');
    expect(body.tools[0]).toEqual({ type: 'function', function: { name: 'list_sessions', description: 'd', parameters: { type: 'object', properties: {} } } });
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(body.messages[2].tool_calls[0]).toEqual({ id: 't1', type: 'function', function: { name: 'list_sessions', arguments: '{}' } });
    expect(body.messages[3]).toEqual({ role: 'tool', tool_call_id: 't1', content: 'ERROR: {"error":"x"}' });
  });

  it('fails fast with a clear error when the server is unreachable (probe)', async () => {
    const fetchMock = jest.fn();
    const p = provider(fetchMock, { probe: async () => Promise.reject(new Error('connect ECONNREFUSED')) });
    const err = await p.chat(req()).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.code).toBe('unreachable');
    expect(err.message).toMatch(/^Brain server unreachable at http:\/\/spark\.local:8000\/v1/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('real TCP probe fails fast against a closed port', async () => {
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as net.AddressInfo).port;
    await new Promise<void>((r) => srv.close(() => r()));
    const t0 = Date.now();
    await expect(tcpProbe('127.0.0.1', port, 3000)).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('classifies fetch connection errors as unreachable', async () => {
    const fetchMock = jest.fn(async () => {
      const e = new TypeError('fetch failed') as TypeError & { cause?: unknown };
      e.cause = { code: 'ECONNREFUSED' };
      throw e;
    });
    const err = await provider(fetchMock).chat(req()).catch((e) => e);
    expect(err.code).toBe('unreachable');
  });

  it.each([
    [401, 'auth'],
    [404, 'bad_request'],
    [429, 'rate_limited'],
    [503, 'server'],
  ])('HTTP %d -> %s', async (status, code) => {
    const fetchMock = jest.fn(async () => new Response('{"error":"nope"}', { status }));
    const err = await provider(fetchMock).chat(req()).catch((e) => e);
    expect(err.code).toBe(code);
    expect(err.message).toMatch(new RegExp(`HTTP ${status}`));
  });

  it('retries once without stream_options when the server rejects it', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(new Response('unknown field stream_options', { status: 400 }))
      .mockResolvedValueOnce(sse([delta({ content: 'hi' }, 'stop')]));
    const res = await provider(fetchMock).chat(req());
    expect(res.text).toBe('hi');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).stream_options).toBeDefined();
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).stream_options).toBeUndefined();
  });

  it('times out a stalled stream', async () => {
    const fetchMock = jest.fn(async (_u: string, init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(delta({ content: 'partial' })));
          init.signal?.addEventListener('abort', () => c.error(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    const err = await provider(fetchMock, { requestTimeoutMs: 150 }).chat(req()).catch((e) => e);
    expect(err.code).toBe('timeout');
  });

  it('caller abort surfaces as aborted', async () => {
    const ctl = new AbortController();
    const fetchMock = jest.fn(async (_u: string, init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          init.signal?.addEventListener('abort', () => c.error(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        },
      });
      setTimeout(() => ctl.abort(), 20);
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    const err = await provider(fetchMock).chat(req({ signal: ctl.signal })).catch((e) => e);
    expect(err.code).toBe('aborted');
  });

  it('falls back to non-streaming JSON responses', async () => {
    const fetchMock = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '<think>x</think>Fine.', tool_calls: [{ id: 'q', function: { name: 'list_sessions', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 3, completion_tokens: 2 },
          }),
          { headers: { 'content-type': 'application/json' } }
        )
    );
    const res = await provider(fetchMock).chat(req());
    expect(res.text).toBe('Fine.');
    expect(res.toolCalls[0].name).toBe('list_sessions');
    expect(res.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
  });

  it('rejects a stream with no parseable data', async () => {
    const fetchMock = jest.fn(async () => sse([': keep-alive\n\n', 'data: {not json\n\n']));
    const err = await provider(fetchMock).chat(req()).catch((e) => e);
    expect(err.code).toBe('protocol');
  });
});

describe('ThinkFilter', () => {
  it('passes normal text and holds partial tags', () => {
    const f = new ThinkFilter();
    expect(f.push('a <b> c <th')).toBe('a <b> c ');
    expect(f.push('ing')).toBe('<thing');
    expect(f.end()).toBe('');
  });
  it('drops an unterminated think block', () => {
    const f = new ThinkFilter();
    expect(f.push('<think>never closes')).toBe('');
    expect(f.end()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Brain loop (provider-agnostic)

type Scripted = Partial<LlmChatResult> & { emit?: string };

function scriptedProvider(script: Scripted[]): LlmProvider & { calls: LlmChatRequest[] } {
  const calls: LlmChatRequest[] = [];
  return {
    name: 'fake',
    model: 'fake-1',
    calls,
    async chat(r) {
      calls.push({ ...r, messages: [...r.messages] });
      const s = script[Math.min(calls.length - 1, script.length - 1)];
      if (s.emit) r.onText(s.emit);
      return { text: s.emit || '', toolCalls: [], stopReason: 'end', usage: { inputTokens: 10, outputTokens: 5 }, ...s } as LlmChatResult;
    },
  };
}

function turnInput(runTool: jest.Mock) {
  const texts: string[] = [];
  return {
    texts,
    input: {
      history: [],
      userText: 'what is going on?',
      snapshot: '[snapshot]',
      systemPrompt: 'sys',
      maxTokens: 100,
      signal: new AbortController().signal,
      onText: (d: string) => texts.push(d),
      runTool: runTool as unknown as (n: string, a: Record<string, unknown>) => Promise<ToolOutcome>,
    },
  };
}

describe('runTurn', () => {
  it('returns a corrective error for malformed args once, then continues', async () => {
    const p = scriptedProvider([
      { toolCalls: [{ id: 'a', name: 'summarize_session', arguments: '{"session": ' }], stopReason: 'tool_calls' },
      { toolCalls: [{ id: 'b', name: 'summarize_session', arguments: '{"session":"companion"}' }], stopReason: 'tool_calls' },
      { emit: 'Companion is waiting on you.' },
    ]);
    const runTool = jest.fn(async () => ({ content: '{"name":"companion"}', isError: false }));
    const { input } = turnInput(runTool);
    const res = await runTurn(p, input);
    expect(res.outcome).toBe('ok');
    expect(res.text).toBe('Companion is waiting on you.');
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(runTool).toHaveBeenCalledWith('summarize_session', { session: 'companion' });
    const second = p.calls[1].messages;
    const toolMsg = second[second.length - 1];
    expect(toolMsg.role).toBe('tool');
    expect(toolMsg.role === 'tool' && toolMsg.isError).toBe(true);
    expect(toolMsg.role === 'tool' && toolMsg.content).toMatch(/not valid JSON/);
  });

  it('gives up gracefully after a second malformed call and never runs propose_input', async () => {
    const p = scriptedProvider([
      { toolCalls: [{ id: 'a', name: 'propose_input', arguments: '{"session":"c","option":' }], stopReason: 'tool_calls' },
      { toolCalls: [{ id: 'b', name: 'propose_input', arguments: '{"session":"c"}' }], stopReason: 'tool_calls' },
      { emit: 'should not get here' },
    ]);
    const runTool = jest.fn();
    const { input } = turnInput(runTool);
    const res = await runTurn(p, input);
    expect(res.outcome).toBe('malformed');
    expect(res.text).toMatch(/tangled up/);
    expect(runTool).not.toHaveBeenCalled();
    expect(p.calls).toHaveLength(2);
  });

  it('does not execute propose_input alongside a malformed sibling call', async () => {
    const p = scriptedProvider([
      {
        toolCalls: [
          { id: 'a', name: 'propose_input', arguments: '{"session":"c","option":"1"}' },
          { id: 'b', name: 'nonexistent_tool', arguments: '{}' },
        ],
        stopReason: 'tool_calls',
      },
      { emit: 'Okay.' },
    ]);
    const runTool = jest.fn();
    const { input } = turnInput(runTool);
    await runTurn(p, input);
    expect(runTool).not.toHaveBeenCalled();
  });

  it('treats tool calls cut off by max_tokens as malformed', async () => {
    const p = scriptedProvider([
      { toolCalls: [{ id: 'a', name: 'list_sessions', arguments: '{}' }], stopReason: 'max_tokens' },
      { emit: 'Sorry.' },
    ]);
    const runTool = jest.fn();
    const { input } = turnInput(runTool);
    await runTurn(p, input);
    expect(runTool).not.toHaveBeenCalled();
  });

  it('caps tool iterations and forces a text-only final round', async () => {
    const p = scriptedProvider([{ toolCalls: [{ id: 'x', name: 'list_sessions', arguments: '{}' }], stopReason: 'tool_calls' }]);
    const runTool = jest.fn(async () => ({ content: '{}', isError: false }));
    const { input } = turnInput(runTool);
    const res = await runTurn(p, input);
    expect(p.calls).toHaveLength(MAX_TOOL_ITERATIONS + 1);
    expect(p.calls[MAX_TOOL_ITERATIONS].toolChoice).toBe('none');
    expect(p.calls.slice(0, MAX_TOOL_ITERATIONS).every((c) => c.toolChoice === 'auto')).toBe(true);
    expect(runTool).toHaveBeenCalledTimes(MAX_TOOL_ITERATIONS);
    expect(res.outcome).toBe('tool_limit');
  });

  it('drops lone pre-tool narration, joins real text across iterations, and uniquifies reused call ids', async () => {
    const p = scriptedProvider([
      { emit: 'Let me check.', toolCalls: [{ id: 'call_0', name: 'list_sessions', arguments: '{}' }], stopReason: 'tool_calls' },
      {
        emit: 'Nothing is blocked. One more look at companion.',
        toolCalls: [{ id: 'call_0', name: 'list_sessions', arguments: '{}' }],
        stopReason: 'tool_calls',
      },
      { emit: 'All good.' },
    ]);
    const runTool = jest.fn(async () => ({ content: '{}', isError: false }));
    const { input, texts } = turnInput(runTool);
    const res = await runTurn(p, input);
    expect(res.text).toBe('Nothing is blocked. One more look at companion. All good.');
    expect(texts.join('')).toBe(res.text);
    expect(res.droppedNarration).toEqual(['Let me check.']);
    const ids = p.calls[2].messages.filter((m) => m.role === 'tool').map((m) => (m.role === 'tool' ? m.toolCallId : ''));
    expect(new Set(ids).size).toBe(2);
  });

  it('streams a multi-sentence answer once the second sentence starts', async () => {
    const provider: LlmProvider = {
      name: 'fake',
      model: 'fake-1',
      async chat(r) {
        for (const d of ['Companion ', 'is waiting.', ' Out4 ', 'is idle.']) r.onText(d);
        return { text: '', toolCalls: [], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 } } as LlmChatResult;
      },
    };
    const { input, texts } = turnInput(jest.fn());
    const res = await runTurn(provider, input);
    expect(res.text).toBe('Companion is waiting. Out4 is idle.');
    // Held until " O" proved a second sentence, then streamed live.
    expect(texts).toEqual(['Companion is waiting. Out4 ', 'is idle.']);
    expect(res.firstTokenMs).toBeDefined();
    expect(res.droppedNarration).toEqual([]);
  });

  it('strips markdown from spoken output, even when markers are split across deltas', async () => {
    const provider: LlmProvider = {
      name: 'fake',
      model: 'fake-1',
      async chat(r) {
        for (const d of ['*', '*Out4:* ', '*', ' shipped the `refund` fix.\n', '- ', 'Web is live.\n## Next', '\n  indented stays.']) r.onText(d);
        return { text: '', toolCalls: [], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 } } as LlmChatResult;
      },
    };
    const { input, texts } = turnInput(jest.fn());
    const res = await runTurn(provider, input);
    expect(res.text).toBe('Out4:  shipped the refund fix.\nWeb is live.\nNext\n  indented stays.');
    expect(texts.join('')).toBe(res.text);
  });

  it('keeps a lone sentence that ends the turn without tools (short answers are not narration)', async () => {
    const p = scriptedProvider([{ emit: 'Everything is quiet.' }]);
    const { input, texts } = turnInput(jest.fn());
    const res = await runTurn(p, input);
    expect(res.text).toBe('Everything is quiet.');
    expect(texts.join('')).toBe('Everything is quiet.');
  });

  it('injects the snapshot with the user message and uses bounded history', async () => {
    const p = scriptedProvider([{ emit: 'Hi.' }]);
    const { input } = turnInput(jest.fn());
    input.history = [
      { id: '1', role: 'herald', text: 'orphan', createdAt: 1 },
      { id: '2', role: 'user', text: 'hello', createdAt: 2 },
      { id: '3', role: 'herald', text: 'hey', createdAt: 3 },
      { id: '4', role: 'herald', text: 'Sent to companion.', createdAt: 4 },
    ] as any;
    await runTurn(p, input);
    const msgs = p.calls[0].messages;
    expect(msgs[0]).toEqual({ role: 'user', text: 'hello' });
    expect(msgs[1]).toEqual({ role: 'assistant', text: 'hey\nSent to companion.' });
    expect(msgs[2]).toEqual({ role: 'user', text: '[snapshot]\n\nwhat is going on?' });
  });

  it('historyToTurns drops streaming/empty messages and trailing user turns', () => {
    const t = historyToTurns([
      { id: '1', role: 'user', text: 'a', createdAt: 1 },
      { id: '2', role: 'herald', text: '', createdAt: 2 },
      { id: '3', role: 'herald', text: 'partial', createdAt: 3, streaming: true },
      { id: '4', role: 'user', text: 'b', createdAt: 4 },
    ]);
    expect(t).toEqual([]);
  });

  it('end-to-end over SSE: malformed args get one corrective retry', async () => {
    const responses = [
      sse([delta({ tool_calls: [{ index: 0, id: 'k1', function: { name: 'summarize_session', arguments: '{"session":"comp' } }] }, 'tool_calls')]),
      sse([delta({ tool_calls: [{ index: 0, id: 'k2', function: { name: 'summarize_session', arguments: '{"session":"companion"}' } }] }, 'tool_calls')]),
      sse([delta({ content: 'It finished the refactor.' }, 'stop')]),
    ];
    const fetchMock = jest.fn(async () => responses.shift()!);
    const runTool = jest.fn(async () => ({ content: '{"latest_reply":"done"}', isError: false }));
    const { input } = turnInput(runTool);
    const res = await runTurn(provider(fetchMock), input);
    expect(res.text).toBe('It finished the refactor.');
    expect(runTool).toHaveBeenCalledTimes(1);
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body));
    const lastMsg = secondBody.messages[secondBody.messages.length - 1];
    expect(lastMsg.role).toBe('tool');
    expect(lastMsg.tool_call_id).toBe('k1');
    expect(lastMsg.content).toMatch(/^ERROR: .*not valid JSON/);
  });
});
