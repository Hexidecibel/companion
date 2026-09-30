/**
 * OpenAI-compatible chat provider (vLLM, llama.cpp server, Ollama, LM Studio, ...).
 *
 * Plain `fetch` + SSE parsing, no SDK dependency. Hardened for local servers:
 *   - fast TCP reachability probe (short connect timeout) before each request,
 *     cached briefly on success, so a down server fails in seconds, not minutes;
 *   - header + inter-chunk idle timeouts, caller abort;
 *   - tool-call argument deltas accumulated across chunks by index (or id), and
 *     servers that only send tool calls in the final chunk / final `message`;
 *   - `<think>...</think>` reasoning emitted inline by some models is suppressed;
 *   - non-streaming JSON fallback when a server ignores `stream: true`;
 *   - retries once without `stream_options` for servers that reject it.
 */

import * as net from 'net';
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

export type ReachabilityProbe = (host: string, port: number, timeoutMs: number) => Promise<void>;

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  model: string;
  apiKey?: string | null;
  /** Header timeout and max idle gap between streamed chunks. */
  requestTimeoutMs: number;
  /** TCP connect timeout for the reachability probe. */
  connectTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  probe?: ReachabilityProbe;
  temperature?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 4000;
const PROBE_CACHE_MS = 15_000;
const MAX_ERROR_BODY = 2000;
const MAX_STREAM_BYTES = 4 * 1024 * 1024;

export const tcpProbe: ReachabilityProbe = (host, port, timeoutMs) =>
  new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error(`connect timeout after ${timeoutMs}ms`)),
      timeoutMs
    );
    timer.unref?.();
    sock.once('connect', () => finish());
    sock.once('error', (err) => finish(err));
  });

/** Streaming filter that drops `<think>...</think>` spans, robust to chunk boundaries. */
export class ThinkFilter {
  private buf = '';
  private inThink = false;
  private static OPEN = '<think>';
  private static CLOSE = '</think>';

  push(delta: string): string {
    this.buf += delta;
    let out = '';
    for (let guard = 0; guard < 64; guard++) {
      if (!this.inThink) {
        const idx = this.buf.indexOf(ThinkFilter.OPEN);
        if (idx >= 0) {
          out += this.buf.slice(0, idx);
          this.buf = this.buf.slice(idx + ThinkFilter.OPEN.length);
          this.inThink = true;
          continue;
        }
        // Hold back a possible partial "<think" at the end.
        const keep = partialSuffix(this.buf, ThinkFilter.OPEN);
        out += this.buf.slice(0, this.buf.length - keep);
        this.buf = this.buf.slice(this.buf.length - keep);
        return out;
      }
      const idx = this.buf.indexOf(ThinkFilter.CLOSE);
      if (idx >= 0) {
        this.buf = this.buf.slice(idx + ThinkFilter.CLOSE.length).replace(/^\s+/, '');
        this.inThink = false;
        continue;
      }
      const keep = partialSuffix(this.buf, ThinkFilter.CLOSE);
      this.buf = this.buf.slice(this.buf.length - keep);
      return out;
    }
    return out;
  }

  end(): string {
    const rest = this.inThink ? '' : this.buf;
    this.buf = '';
    return rest;
  }
}

function partialSuffix(s: string, token: string): number {
  const max = Math.min(token.length - 1, s.length);
  for (let n = max; n > 0; n--) {
    if (token.startsWith(s.slice(s.length - n))) return n;
  }
  return 0;
}

interface ToolAcc {
  id: string;
  name: string;
  args: string;
}

function toOpenAiMessages(system: string, turns: LlmTurn[]): unknown[] {
  const out: unknown[] = [{ role: 'system', content: system }];
  for (const t of turns) {
    if (t.role === 'user') out.push({ role: 'user', content: t.text });
    else if (t.role === 'assistant') {
      const msg: Record<string, unknown> = { role: 'assistant', content: t.text || '' };
      if (t.toolCalls && t.toolCalls.length > 0) {
        msg.tool_calls = t.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.arguments || '{}' },
        }));
      }
      out.push(msg);
    } else {
      out.push({
        role: 'tool',
        tool_call_id: t.toolCallId,
        content: t.isError ? `ERROR: ${t.content}` : t.content,
      });
    }
  }
  return out;
}

function mapFinish(reason: string | null | undefined, hasTools: boolean): LlmStopReason {
  if (reason === 'length') return 'max_tokens';
  if (hasTools) return 'tool_calls';
  switch (reason) {
    case 'stop':
    case 'eos':
    case 'end_turn':
      return 'end';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return reason ? 'other' : 'end';
  }
}

function isAbortError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError';
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name = 'openai_compatible';
  readonly model: string;
  private opts: OpenAiCompatibleOptions;
  private fetchImpl: typeof fetch;
  private probe: ReachabilityProbe;
  private probeOkUntil = 0;
  private noStreamOptions = false;
  private host: string;
  private port: number;

  constructor(opts: OpenAiCompatibleOptions) {
    this.opts = opts;
    this.model = opts.model;
    this.fetchImpl = opts.fetchImpl || fetch;
    this.probe = opts.probe || tcpProbe;
    const u = new URL(opts.baseUrl);
    this.host = u.hostname.replace(/^\[|\]$/g, '');
    this.port = u.port ? parseInt(u.port, 10) : u.protocol === 'https:' ? 443 : 80;
  }

  private async ensureReachable(): Promise<void> {
    if (Date.now() < this.probeOkUntil) return;
    try {
      await this.probe(
        this.host,
        this.port,
        this.opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
      );
      this.probeOkUntil = Date.now() + PROBE_CACHE_MS;
    } catch (err) {
      this.probeOkUntil = 0;
      throw new LlmError(
        'unreachable',
        `Brain server unreachable at ${this.opts.baseUrl} (${err instanceof Error ? err.message : String(err)})`
      );
    }
  }

  async chat(req: LlmChatRequest): Promise<LlmChatResult> {
    if (req.signal.aborted) throw new LlmError('aborted', 'Request aborted');
    await this.ensureReachable();
    try {
      return await this.request(req, !this.noStreamOptions);
    } catch (err) {
      if (
        err instanceof LlmError &&
        err.code === 'bad_request' &&
        !this.noStreamOptions &&
        /stream_options/i.test(err.message)
      ) {
        this.noStreamOptions = true;
        return this.request(req, false);
      }
      throw err;
    }
  }

  private async request(req: LlmChatRequest, withStreamOptions: boolean): Promise<LlmChatResult> {
    const started = Date.now();
    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages: toOpenAiMessages(req.system, req.messages),
      max_tokens: req.maxTokens,
      temperature: this.opts.temperature ?? 0.3,
      stream: true,
    };
    if (withStreamOptions) body.stream_options = { include_usage: true };
    if (req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = req.toolChoice;
    }

    const ctl = new AbortController();
    let timedOut = false;
    let idleTimer: NodeJS.Timeout | null = null;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        ctl.abort();
      }, this.opts.requestTimeoutMs);
      idleTimer.unref?.();
    };
    const onCallerAbort = () => ctl.abort();
    req.signal.addEventListener('abort', onCallerAbort, { once: true });
    armIdle();

    const classify = (err: unknown): LlmError => {
      if (err instanceof LlmError) return err;
      if (req.signal.aborted) return new LlmError('aborted', 'Request aborted');
      if (timedOut || isAbortError(err)) {
        return new LlmError(
          'timeout',
          `Brain server at ${this.opts.baseUrl} timed out after ${this.opts.requestTimeoutMs}ms`
        );
      }
      const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
      const code = cause?.code || '';
      if (
        /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ECONNRESET|EAI_AGAIN|UND_ERR_CONNECT/i.test(
          code
        )
      ) {
        this.probeOkUntil = 0;
        return new LlmError(
          'unreachable',
          `Brain server unreachable at ${this.opts.baseUrl} (${code})`
        );
      }
      return new LlmError(
        'protocol',
        `Brain request failed: ${err instanceof Error ? err.message : String(err)}`
      );
    };

    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'text/event-stream, application/json',
      };
      if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.opts.baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: ctl.signal,
        });
      } catch (err) {
        throw classify(err);
      }
      armIdle();

      if (!res.ok) {
        let detail = '';
        try {
          detail = (await res.text()).slice(0, MAX_ERROR_BODY);
        } catch {
          /* ignore */
        }
        const msg = `Brain server returned HTTP ${res.status}${detail ? `: ${detail.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`;
        if (res.status === 401 || res.status === 403) throw new LlmError('auth', msg);
        if (res.status === 429) throw new LlmError('rate_limited', msg);
        if (res.status >= 500) throw new LlmError('server', msg);
        throw new LlmError('bad_request', msg);
      }

      const ctype = res.headers.get('content-type') || '';
      if (!ctype.includes('text/event-stream') && ctype.includes('json')) {
        let json: any;
        try {
          json = await res.json();
        } catch (err) {
          throw classify(err);
        }
        return this.fromNonStreaming(json, req, started);
      }
      if (!res.body) throw new LlmError('protocol', 'Brain server returned an empty body');
      return await this.readStream(res.body, req, started, armIdle, classify);
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      req.signal.removeEventListener('abort', onCallerAbort);
    }
  }

  private fromNonStreaming(json: any, req: LlmChatRequest, started: number): LlmChatResult {
    const choice = json?.choices?.[0];
    if (!choice) throw new LlmError('protocol', 'Brain server response has no choices');
    const filter = new ThinkFilter();
    const content = typeof choice.message?.content === 'string' ? choice.message.content : '';
    const text = filter.push(content) + filter.end();
    if (text) req.onText(text);
    const toolCalls: LlmToolCall[] = (choice.message?.tool_calls || []).map(
      (tc: any, i: number) => ({
        id: tc.id || `call_${i}`,
        name: tc.function?.name || '',
        arguments:
          typeof tc.function?.arguments === 'string'
            ? tc.function.arguments
            : JSON.stringify(tc.function?.arguments ?? {}),
      })
    );
    return {
      text,
      toolCalls,
      stopReason: mapFinish(choice.finish_reason, toolCalls.length > 0),
      usage: {
        inputTokens: json?.usage?.prompt_tokens,
        outputTokens: json?.usage?.completion_tokens,
      },
      firstTokenMs: Date.now() - started,
    };
  }

  private async readStream(
    stream: ReadableStream<Uint8Array>,
    req: LlmChatRequest,
    started: number,
    armIdle: () => void,
    classify: (err: unknown) => LlmError
  ): Promise<LlmChatResult> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const filter = new ThinkFilter();
    const acc = new Map<number, ToolAcc>();
    let finalToolCalls: LlmToolCall[] | null = null;
    let text = '';
    let finish: string | null = null;
    const usage: LlmUsage = {};
    let firstTokenMs: number | undefined;
    let pending = '';
    let bytes = 0;
    let parsedAny = false;
    let done = false;

    const markFirst = () => {
      if (firstTokenMs === undefined) firstTokenMs = Date.now() - started;
    };
    const emit = (s: string) => {
      if (!s) return;
      text += s;
      req.onText(s);
    };

    const handleChunk = (chunk: any) => {
      parsedAny = true;
      if (chunk?.error) {
        const m =
          typeof chunk.error === 'string'
            ? chunk.error
            : chunk.error?.message || JSON.stringify(chunk.error);
        throw new LlmError('server', `Brain server error: ${String(m).slice(0, 300)}`);
      }
      if (chunk?.usage) {
        if (typeof chunk.usage.prompt_tokens === 'number')
          usage.inputTokens = chunk.usage.prompt_tokens;
        if (typeof chunk.usage.completion_tokens === 'number')
          usage.outputTokens = chunk.usage.completion_tokens;
      }
      const choice = chunk?.choices?.[0];
      if (!choice) return;
      const delta = choice.delta || {};
      if (typeof delta.content === 'string' && delta.content) {
        markFirst();
        emit(filter.push(delta.content));
      }
      if (Array.isArray(delta.tool_calls)) {
        markFirst();
        for (let i = 0; i < delta.tool_calls.length; i++) {
          const tc = delta.tool_calls[i];
          let idx: number;
          if (typeof tc.index === 'number') idx = tc.index;
          else {
            const byId = tc.id
              ? Array.from(acc.entries()).find(([, v]) => v.id === tc.id)
              : undefined;
            idx = byId ? byId[0] : tc.id || acc.size === 0 ? acc.size : acc.size - 1; // new id -> new slot; bare fragment -> latest slot
          }
          let e = acc.get(idx);
          if (!e) {
            e = { id: '', name: '', args: '' };
            acc.set(idx, e);
          }
          if (typeof tc.id === 'string' && tc.id && !e.id) e.id = tc.id;
          const fn = tc.function || {};
          if (typeof fn.name === 'string' && fn.name) {
            if (!e.name) e.name = fn.name;
            else if (fn.name !== e.name) e.name += fn.name;
          }
          if (typeof fn.arguments === 'string') e.args += fn.arguments;
          else if (fn.arguments && typeof fn.arguments === 'object')
            e.args = JSON.stringify(fn.arguments);
        }
      }
      // Some servers put the complete tool calls on a final `message` object.
      if (
        choice.message &&
        Array.isArray(choice.message.tool_calls) &&
        choice.message.tool_calls.length > 0
      ) {
        markFirst();
        finalToolCalls = choice.message.tool_calls.map((tc: any, i: number) => ({
          id: tc.id || `call_${i}`,
          name: tc.function?.name || '',
          arguments:
            typeof tc.function?.arguments === 'string'
              ? tc.function.arguments
              : JSON.stringify(tc.function?.arguments ?? {}),
        }));
      }
      if (
        choice.message &&
        typeof choice.message.content === 'string' &&
        !text &&
        choice.message.content
      ) {
        markFirst();
        emit(filter.push(choice.message.content));
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    };

    const handleLine = (line: string) => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data) return;
      if (data === '[DONE]') {
        done = true;
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return; // tolerate a malformed keep-alive / partial line
      }
      handleChunk(parsed);
    };

    try {
      while (!done) {
        let r: { done: boolean; value?: Uint8Array };
        try {
          r = await reader.read();
        } catch (err) {
          throw classify(err);
        }
        if (r.done) break;
        armIdle();
        if (!r.value) continue;
        bytes += r.value.byteLength;
        if (bytes > MAX_STREAM_BYTES)
          throw new LlmError('protocol', 'Brain response exceeded the size limit');
        pending += decoder.decode(r.value, { stream: true });
        let nl: number;
        while ((nl = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, nl).replace(/\r$/, '');
          pending = pending.slice(nl + 1);
          handleLine(line);
          if (done) break;
        }
      }
      pending += decoder.decode();
      if (pending.trim()) handleLine(pending.trim());
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
    }

    if (!parsedAny) throw new LlmError('protocol', 'Brain server sent no parseable stream data');
    emit(filter.end());

    let toolCalls: LlmToolCall[] =
      finalToolCalls ||
      Array.from(acc.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([i, e]) => ({ id: e.id || `call_${i}`, name: e.name, arguments: e.args }));
    toolCalls = toolCalls.filter((c) => c.name || c.arguments);

    return {
      text,
      toolCalls,
      stopReason: mapFinish(finish, toolCalls.length > 0),
      usage,
      firstTokenMs,
    };
  }
}
