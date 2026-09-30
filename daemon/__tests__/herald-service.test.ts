import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HeraldService } from '../src/herald/service';
import { HeraldStore } from '../src/herald/store';
import { resolveHeraldConfig, parseHeraldConfigBlock, ResolvedHeraldConfig } from '../src/herald/config';
import type { HeraldEvent } from '../src/herald/protocol';
import type { PendingChoice, SessionSnapshot, SessionSource } from '../src/herald/session-source';
import { LlmChatRequest, LlmChatResult, LlmError, LlmProvider } from '../src/herald/llm/provider';
import type { AuditEntry } from '../src/audit-log';
import { snap } from './herald-helpers';

type Step = Partial<LlmChatResult> & { emit?: string; throws?: Error; wait?: (signal: AbortSignal) => Promise<void> };

function scripted(steps: Step[]): LlmProvider & { calls: LlmChatRequest[] } {
  const calls: LlmChatRequest[] = [];
  return {
    name: 'fake',
    model: 'fake-1',
    calls,
    async chat(r) {
      calls.push(r);
      const s = steps.shift() || { emit: 'ok' };
      if (s.wait) await s.wait(r.signal);
      if (s.throws) throw s.throws;
      if (s.emit) r.onText(s.emit);
      return { text: s.emit || '', toolCalls: [], stopReason: 'end', usage: {}, ...s } as LlmChatResult;
    },
  };
}

function fakeSource(sessions: SessionSnapshot[]) {
  const holder: { sessions: SessionSnapshot[] } = { sessions };
  const src = {
    serverId: 'local',
    sessions,
    listSessions: jest.fn(async (): Promise<SessionSnapshot[]> => holder.sessions),
    getRecentTranscript: jest.fn(async () => ({
      lastUserPrompt: { role: 'user' as const, text: 'fix the bug', at: 1 },
      assistantTurns: [{ role: 'assistant' as const, text: 'Fixed the parser bug in `src/parser.ts`.', at: 2 }],
    })),
    getLiveChoice: jest.fn(async (id: string): Promise<PendingChoice | null> => holder.sessions.find((s) => s.sessionId === id)?.pendingChoice || null),
    sessionExists: jest.fn(async () => true),
    sendText: jest.fn(async () => true),
    sendChoice: jest.fn(async () => true),
  };
  return src as typeof src & SessionSource;
}

const cfg = (over: Partial<ResolvedHeraldConfig> = {}): ResolvedHeraldConfig => ({
  featureEnabled: true,
  displayName: 'Herald',
  provider: 'openai_compatible',
  baseUrl: 'http://spark:8000/v1',
  model: 'qwen3',
  echoDelayMs: 80,
  requestTimeoutMs: 5000,
  maxTokens: 700,
  stateDir: '/tmp/herald-test-unused',
  apiKey: null,
  brainConfigured: true,
  ...over,
});

async function waitFor(cond: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const choice: PendingChoice = {
  question: 'Which approach should I take?',
  options: [{ label: 'Rewrite it' }, { label: 'Patch it' }],
  multiSelect: false,
  signature: 'sig-1',
};

describe('HeraldService', () => {
  let dir: string;
  let services: HeraldService[] = [];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-svc-'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const s of services) s.shutdown();
    services = [];
    fs.rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function make(provider: LlmProvider | null, source: SessionSource, config = cfg()) {
    const events: HeraldEvent[] = [];
    const audits: AuditEntry[] = [];
    const svc = new HeraldService({
      config: provider ? config : { ...config, brainConfigured: false, disabledReason: 'Brain not configured: set herald.base_url' },
      provider,
      sources: [source],
      store: new HeraldStore(dir, 10),
      broadcast: (e) => events.push(e),
      audit: (a) => audits.push(a),
      pollIntervalMs: 60_000,
    });
    services.push(svc);
    return { svc, events, audits };
  }

  it('without a brain: disabled with reason, send rejected, inbox still works', async () => {
    const src = fakeSource([snap({ sessionId: 'companion', status: 'waiting', pendingChoice: choice })]);
    const { svc, events } = make(null, src);
    await svc.start();
    await svc.poll();
    const st = svc.getState();
    expect(st.enabled).toBe(false);
    expect(st.disabledReason).toMatch(/base_url/);
    expect(st.inbox).toHaveLength(1);
    expect(events.some((e) => e.kind === 'inbox')).toBe(true);
    expect(() => svc.send('hello')).toThrow(/base_url/);
  });

  it('validates input and rejects concurrent turns', async () => {
    let release!: () => void;
    const p = scripted([{ wait: () => new Promise<void>((r) => (release = r)), emit: 'done' }]);
    const { svc } = make(p, fakeSource([]));
    await svc.start();
    expect(() => svc.send('   ')).toThrow(/empty/);
    expect(() => svc.send('x'.repeat(4001))).toThrow(/too long/);
    expect(() => svc.send(42 as unknown as string)).toThrow(/string/);
    svc.send('first');
    expect(svc.getState().busy).toBe(true);
    expect(() => svc.send('second')).toThrow(/still answering/);
    await waitFor(() => p.calls.length === 1);
    release();
    await waitFor(() => !svc.getState().busy);
  });

  it('streams a grounded reply with the documented event sequence', async () => {
    const src = fakeSource([snap({ sessionId: 'companion', status: 'working', currentActivity: 'Running tests' })]);
    const p = scripted([
      { toolCalls: [{ id: 't', name: 'summarize_session', arguments: '{"session":"companion"}' }], stopReason: 'tool_calls' },
      { emit: 'Companion fixed the parser bug and is running tests.' },
    ]);
    const { svc, events } = make(p, src);
    await svc.start();
    const { messageId } = svc.send('what is companion doing?');
    await waitFor(() => !svc.getState().busy);
    const kinds = events.filter((e) => e.kind !== 'inbox').map((e) => e.kind);
    expect(kinds).toEqual(['busy', 'message_start', 'message_end', 'message_start', 'message_delta', 'message_end', 'busy']);
    const userEnd = events.find((e) => e.kind === 'message_end') as Extract<HeraldEvent, { kind: 'message_end' }>;
    expect(userEnd.message.id).toBe(messageId);
    const end = events.filter((e) => e.kind === 'message_end').pop() as Extract<HeraldEvent, { kind: 'message_end' }>;
    expect(end.message.role).toBe('herald');
    expect(end.message.streaming).toBe(false);
    expect(end.message.text).toBe('Companion fixed the parser bug and is running tests.');
    expect(end.message.sessionRefs).toEqual([{ serverId: 'local', sessionId: 'companion', sessionName: 'companion' }]);
    // Snapshot was injected with the user message.
    const first = p.calls[0].messages.filter((m) => m.role === 'user').pop()!;
    expect(first.role === 'user' ? first.text : '').toMatch(/Fleet snapshot[\s\S]*companion: working[\s\S]*what is companion doing\?/);
    expect(svc.getState().messages.map((m) => m.role)).toEqual(['user', 'herald']);
  });

  it('pre-fetches detail for a session the user names, but not for broad questions', async () => {
    const src = fakeSource([snap({ sessionId: 'out4', status: 'idle' }), snap({ sessionId: 'apps', status: 'idle' })]);
    const p = scripted([{ emit: 'Out4 is idle.' }, { emit: 'All quiet.' }]);
    const { svc } = make(p, src);
    await svc.start();
    svc.send('where is out4 at?');
    await waitFor(() => !svc.getState().busy);
    const named = p.calls[0].messages.filter((m) => m.role === 'user').pop()!;
    expect(named.role === 'user' ? named.text : '').toMatch(/\[Detail for out4, fetched just now[\s\S]*where is out4 at\?/);
    expect(svc.getState().messages[1].sessionRefs).toEqual([{ serverId: 'local', sessionId: 'out4', sessionName: 'out4' }]);
    svc.send('anything for me?');
    await waitFor(() => p.calls.length === 2 && !svc.getState().busy);
    const broad = p.calls[1].messages.filter((m) => m.role === 'user').pop()!;
    expect(broad.role === 'user' ? broad.text : '').not.toMatch(/Detail for/);
  });

  it('echo proposal auto-sends through the choice path and confirms in chat', async () => {
    const src = fakeSource([snap({ sessionId: 'companion', status: 'waiting', pendingChoice: choice })]);
    const p = scripted([
      { toolCalls: [{ id: 't', name: 'propose_input', arguments: '{"session":"companion","option":"2"}' }], stopReason: 'tool_calls' },
      { emit: 'Telling companion to patch it.' },
    ]);
    const { svc, events, audits } = make(p, src);
    await svc.start();
    svc.send('tell companion option 2');
    await waitFor(() => !svc.getState().busy);
    const action = svc.getState().actions[0];
    expect(action.tier).toBe('echo');
    expect(action.kind).toBe('answer_choice');
    expect(action.payload).toBe('Patch it');
    expect(action.readback).toBe('companion: option 2, Patch it');
    expect(action.autoSendAt).toBeDefined();
    const reply = svc.getState().messages[1];
    expect(reply.actionIds).toEqual([action.id]);
    await waitFor(() => svc.getState().actions[0].status === 'sent');
    expect(src.sendChoice).toHaveBeenCalledWith('companion', 1, 2, false);
    await waitFor(() => svc.getState().messages.some((m) => m.text === 'Sent to companion.'));
    expect(events.filter((e) => e.kind === 'action').map((e) => (e as any).action.status)).toEqual(['pending', 'sent']);
    expect(audits.map((a) => a.action)).toEqual(['herald_action_proposed', 'herald_action_sent']);
  });

  it('dangerous pending question forces hard_confirm; LLM cannot lower it; confirm sends', async () => {
    const deployChoice: PendingChoice = { question: 'Deploy to production now?', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false, signature: 'd' };
    const src = fakeSource([snap({ sessionId: 'companion', status: 'waiting', pendingChoice: deployChoice })]);
    const p = scripted([
      { toolCalls: [{ id: 't', name: 'propose_input', arguments: '{"session":"companion","option":"yes","confirm":false}' }], stopReason: 'tool_calls' },
      { emit: 'That deploys to production, so confirm on screen.' },
    ]);
    const { svc, audits } = make(p, src);
    await svc.start();
    svc.send('yeah');
    await waitFor(() => !svc.getState().busy);
    const a = svc.getState().actions[0];
    expect(a.tier).toBe('hard_confirm');
    expect(a.autoSendAt).toBeUndefined();
    expect(a.reasons.join(' ')).toMatch(/deploy|production/);
    await new Promise((r) => setTimeout(r, 200));
    expect(src.sendChoice).not.toHaveBeenCalled();
    const origin = { addr: '1.2.3.4', clientId: 'c1', isLocal: false, tls: true, origin: null };
    const done = await svc.confirm(a.id, 'confirm', origin);
    expect(done.status).toBe('sent');
    expect(audits.find((x) => x.action === 'herald_action_confirmed')?.origin).toEqual(origin);
    await expect(svc.confirm(a.id, 'maybe', origin)).rejects.toThrow(/decision/);
    await expect(svc.confirm('nope', 'cancel', origin)).rejects.toThrow(/Unknown action/);
  });

  it('multi-session batch classifies each member: safe ones echo, dangerous ones are split out', async () => {
    const pushChoice: PendingChoice = { question: 'Push to origin main now?', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false, signature: 'p' };
    const src = fakeSource([
      snap({ sessionId: 'alpha', status: 'idle' }),
      snap({ sessionId: 'beta', status: 'idle' }),
      snap({ sessionId: 'gamma', status: 'waiting', pendingChoice: pushChoice }),
    ]);
    const p = scripted([
      {
        toolCalls: [
          { id: 'a', name: 'propose_input', arguments: '{"session":"alpha","text":"go ahead"}' },
          { id: 'b', name: 'propose_input', arguments: '{"session":"beta","text":"go ahead"}' },
          { id: 'c', name: 'propose_input', arguments: '{"session":"gamma","option":"yes"}' },
        ],
        stopReason: 'tool_calls',
      },
      { emit: 'Alpha and beta are going ahead; gamma is waiting for your confirmation because it pushes.' },
    ]);
    const { svc } = make(p, src);
    await svc.start();
    svc.send('tell them all go ahead');
    await waitFor(() => !svc.getState().busy);
    const byName = new Map(svc.getState().actions.map((a) => [a.sessionName, a]));
    expect(byName.size).toBe(3);
    expect(byName.get('alpha')!.tier).toBe('echo');
    expect(byName.get('beta')!.tier).toBe('echo');
    expect(byName.get('alpha')!.reasons).toEqual([]);
    const gamma = byName.get('gamma')!;
    expect(gamma.tier).toBe('hard_confirm');
    expect(gamma.reasons.join(' ')).toMatch(/push/);
    // The brain is told the split so its readback can say it.
    const results = p.calls[1].messages.filter((m) => m.role === 'tool').map((m) => (m.role === 'tool' ? JSON.parse(m.content) : null));
    expect(results[0].batch).toBeUndefined();
    expect(results[2].batch).toEqual({ sending_automatically: ['alpha', 'beta'], needs_confirmation: ['gamma'] });
    expect(results[2].instruction).toMatch(/held back for on-screen confirmation/);
    // Safe members auto-send; the dangerous one never does.
    await waitFor(() => svc.getState().actions.filter((a) => a.status === 'sent').length === 2);
    expect(src.sendText).toHaveBeenCalledTimes(2);
    await new Promise((r) => setTimeout(r, 150));
    expect(src.sendChoice).not.toHaveBeenCalled();
    expect(svc.getState().actions.find((a) => a.sessionName === 'gamma')!.status).toBe('pending');
  });

  it('danger in what the user said applies to every batch member', async () => {
    const src = fakeSource([snap({ sessionId: 'alpha', status: 'idle' }), snap({ sessionId: 'beta', status: 'idle' })]);
    const p = scripted([
      {
        toolCalls: [
          { id: 'a', name: 'propose_input', arguments: '{"session":"alpha","text":"go ahead"}' },
          { id: 'b', name: 'propose_input', arguments: '{"session":"beta","text":"go ahead"}' },
        ],
        stopReason: 'tool_calls',
      },
      { emit: 'Both need your confirmation.' },
    ]);
    const { svc } = make(p, src);
    await svc.start();
    svc.send('tell them both to go ahead and deploy');
    await waitFor(() => !svc.getState().busy);
    const actions = svc.getState().actions;
    expect(actions).toHaveLength(2);
    expect(actions.every((a) => a.tier === 'hard_confirm' && a.status === 'pending')).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(src.sendText).not.toHaveBeenCalled();
  });

  it('never guesses the target: ambiguous session and text-into-choice are tool errors', async () => {
    const src = fakeSource([
      snap({ sessionId: 'api-server', status: 'idle' }),
      snap({ sessionId: 'api-client', status: 'idle' }),
      snap({ sessionId: 'companion', status: 'waiting', pendingChoice: choice }),
    ]);
    const p = scripted([
      {
        toolCalls: [
          { id: 'a', name: 'propose_input', arguments: '{"session":"api","text":"continue"}' },
          { id: 'b', name: 'propose_input', arguments: '{"session":"companion","text":"do the rewrite"}' },
        ],
        stopReason: 'tool_calls',
      },
      { emit: 'Which api session do you mean?' },
    ]);
    const { svc } = make(p, src);
    await svc.start();
    svc.send('tell api to continue and companion to rewrite');
    await waitFor(() => !svc.getState().busy);
    expect(svc.getState().actions).toHaveLength(0);
    const results = p.calls[1].messages.filter((m) => m.role === 'tool').map((m) => (m.role === 'tool' ? m.content : ''));
    expect(results[0]).toMatch(/matches 2 sessions/);
    expect(results[1]).toMatch(/multiple-choice prompt/);
  });

  it('a new proposal for the same session supersedes the pending one', async () => {
    const src = fakeSource([snap({ sessionId: 'companion', status: 'idle' })]);
    const p = scripted([
      { toolCalls: [{ id: 'a', name: 'propose_input', arguments: '{"session":"companion","text":"deploy it","confirm":true}' }], stopReason: 'tool_calls' },
      { emit: 'Confirm?' },
      { toolCalls: [{ id: 'b', name: 'propose_input', arguments: '{"session":"companion","text":"wait for me"}' }], stopReason: 'tool_calls' },
      { emit: 'Okay.' },
    ]);
    const { svc } = make(p, src);
    await svc.start();
    svc.send('deploy companion');
    await waitFor(() => !svc.getState().busy);
    svc.send('actually tell it to wait for me');
    await waitFor(() => !svc.getState().busy);
    const statuses = svc.getState().actions.map((a) => `${a.payload}:${a.status}`);
    expect(statuses).toContain('deploy it:cancelled');
  });

  it('unreachable brain: error event + spoken fallback, enabled stays true', async () => {
    const p = scripted([{ throws: new LlmError('unreachable', 'Brain server unreachable at http://spark:8000/v1 (connect ECONNREFUSED)') }]);
    const { svc, events } = make(p, fakeSource([]));
    await svc.start();
    svc.send('status?');
    await waitFor(() => !svc.getState().busy);
    const err = events.find((e) => e.kind === 'error') as Extract<HeraldEvent, { kind: 'error' }>;
    expect(err.error).toMatch(/^Brain server unreachable at http:\/\/spark:8000\/v1/);
    const last = svc.getState().messages.pop()!;
    expect(last.text).toBe("I can't reach my brain server right now.");
    expect(last.streaming).toBe(false);
    expect(svc.getState().enabled).toBe(true);
  });

  it('reset aborts the in-flight turn, clears conversation, keeps inbox', async () => {
    const src = fakeSource([snap({ sessionId: 'companion', status: 'waiting', pendingChoice: choice })]);
    const p = scripted([
      {
        wait: (signal) =>
          new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new LlmError('aborted', 'aborted')))),
      },
    ]);
    const { svc, events } = make(p, src);
    await svc.start();
    await svc.poll();
    svc.send('hello');
    await waitFor(() => p.calls.length === 1);
    const st = svc.reset();
    expect(st.messages).toEqual([]);
    expect(st.inbox).toHaveLength(1);
    await waitFor(() => !svc.getState().busy);
    expect(svc.getState().messages).toEqual([]);
    expect(events.some((e) => e.kind === 'state')).toBe(true);
    expect(events.some((e) => e.kind === 'error')).toBe(false);
  });

  it('reset releases the turn lock even when a session listing hangs', async () => {
    const src = fakeSource([]);
    src.listSessions.mockImplementation(() => new Promise<SessionSnapshot[]>(() => undefined));
    const p = scripted([{ emit: 'never reached' }]);
    const { svc } = make(p, src);
    await svc.start();
    svc.send('hello');
    expect(svc.getState().busy).toBe(true);
    svc.reset();
    await waitFor(() => !svc.getState().busy);
    expect(p.calls).toHaveLength(0);
  });

  it('a mid-stream state snapshot never contains text a later delta repeats', async () => {
    let release!: () => void;
    const provider: LlmProvider & { calls: number } = {
      name: 'fake',
      model: 'fake-1',
      calls: 0,
      async chat(r) {
        provider.calls++;
        r.onText('Hello there. ');
        await new Promise<void>((res) => (release = res));
        r.onText('All quiet.');
        return { text: 'Hello there. All quiet.', toolCalls: [], stopReason: 'end', usage: {} };
      },
    };
    const { svc, events } = make(provider, fakeSource([]));
    await svc.start();
    svc.send('anything for me?');
    await waitFor(() => provider.calls === 1);
    const st = svc.getState();
    const streaming = st.messages.find((m) => m.role === 'herald' && m.streaming)!;
    const mark = events.length;
    release();
    await waitFor(() => !svc.getState().busy);
    const later = events
      .slice(mark)
      .filter((e): e is Extract<HeraldEvent, { kind: 'message_delta' }> => e.kind === 'message_delta' && e.messageId === streaming.id)
      .map((e) => e.delta)
      .join('');
    expect(streaming.text + later).toBe('Hello there. All quiet.');
  });

  it('persists conversation and heard markers across restarts', async () => {
    const src = fakeSource([snap({ sessionId: 'companion', status: 'waiting', pendingChoice: choice })]);
    const p = scripted([{ emit: 'All quiet.' }]);
    const a = make(p, src);
    await a.svc.start();
    await a.svc.poll();
    const itemId = a.svc.getState().inbox[0].id;
    a.svc.markHeard([itemId]);
    a.svc.send('anything new?');
    await waitFor(() => !a.svc.getState().busy);
    a.svc.shutdown();

    const b = make(scripted([]), src);
    await b.svc.start();
    await b.svc.poll();
    expect(b.svc.getState().messages.map((m) => m.text)).toEqual(['anything new?', 'All quiet.']);
    expect(b.svc.getState().inbox[0].heard).toBe(true);
  });

  const lastUser = (p: { calls: LlmChatRequest[] }, i: number) => {
    const m = p.calls[i].messages.filter((x) => x.role === 'user').pop()!;
    return m.role === 'user' ? m.text : '';
  };

  it('voice vs text mode: the per-turn reply style rides in the user turn (after the snapshot), system prompt unchanged', async () => {
    const p = scripted([{ emit: 'Out4 is idle.' }, { emit: 'Out4 is idle.' }]);
    const { svc } = make(p, fakeSource([snap({ sessionId: 'out4' })]));
    await svc.start();
    svc.send('what is going on with everything?', { mode: 'voice' });
    await waitFor(() => !svc.getState().busy);
    svc.send('what is going on with everything?', { mode: 'text' });
    await waitFor(() => p.calls.length === 2 && !svc.getState().busy);
    expect(lastUser(p, 0)).toMatch(/\[End snapshot\]\n\[Reply style: spoken aloud, brief\. One or two short sentences[^\n]*\]\n\nwhat is going on with everything\?$/);
    expect(lastUser(p, 1)).toMatch(/\[Reply style: short plain sentences, usually one to three[^\n]*\]\n\nwhat is going on/);
    // The cacheable prefix is identical across modes.
    expect(p.calls[0].system).toBe(p.calls[1].system);
    // History carries the words only, never an old style line.
    const hist = p.calls[1].messages.filter((m) => m.role === 'user').slice(0, -1);
    expect(hist.map((m) => (m.role === 'user' ? m.text : ''))).toEqual(['what is going on with everything?']);
  });

  it('unknown mode / intent values are ignored (old or buggy clients)', async () => {
    const p = scripted([{ emit: 'ok' }]);
    const { svc } = make(p, fakeSource([]));
    await svc.start();
    svc.send('hello', { mode: 'shouting', intent: 'explode' });
    await waitFor(() => !svc.getState().busy);
    expect(lastUser(p, 0)).toMatch(/\[Reply style: short plain sentences[^\n]*\]\n\nhello$/);
    expect(svc.getState().messages[0].intent).toBeUndefined();
  });

  it('a parroted "[Reply style: ...]" never reaches the user; other brackets do', async () => {
    const p = scripted([
      { emit: 'Out4 is idle.\n\n[Reply style: brief]' },
      { emit: 'The value is [redacted] in the notes. [Reply style: spoken aloud' },
    ]);
    const { svc } = make(p, fakeSource([]));
    await svc.start();
    svc.send('status?', { mode: 'voice' });
    await waitFor(() => !svc.getState().busy);
    svc.send('what is the key?', { mode: 'voice' });
    await waitFor(() => p.calls.length === 2 && !svc.getState().busy);
    const replies = svc.getState().messages.filter((m) => m.role === 'herald').map((m) => m.text);
    expect(replies).toEqual(['Out4 is idle.', 'The value is [redacted] in the notes.']);
  });

  it('shorter / more: the brain gets an instruction, the transcript keeps the words and an intent chip', async () => {
    const p = scripted([{ emit: 'Long answer. With detail.' }, { emit: 'Out4 is waiting.' }, { emit: 'More detail.' }]);
    const { svc } = make(p, fakeSource([snap({ sessionId: 'out4' })]));
    await svc.start();
    svc.send('tell me about out4', { mode: 'voice' });
    await waitFor(() => !svc.getState().busy);
    svc.send('Shorter.', { mode: 'voice', intent: 'shorter' });
    await waitFor(() => p.calls.length === 2 && !svc.getState().busy);
    expect(lastUser(p, 1)).toMatch(/restate your previous reply in ONE short sentence/);
    expect(lastUser(p, 1)).not.toMatch(/Detail for out4/); // no prefetch for a command
    svc.send('Go on.', { mode: 'voice', intent: 'more' });
    await waitFor(() => p.calls.length === 3 && !svc.getState().busy);
    expect(lastUser(p, 2)).toMatch(/more detail on the last topic/);
    const users = svc.getState().messages.filter((m) => m.role === 'user');
    expect(users.map((m) => [m.text, m.intent])).toEqual([
      ['tell me about out4', undefined],
      ['Shorter.', 'shorter'],
      ['Go on.', 'more'],
    ]);
  });

  it('verbosity: validated, persisted, broadcast, and it shapes the style line', async () => {
    const p = scripted([{ emit: 'ok' }, { emit: 'ok' }]);
    const a = make(p, fakeSource([]));
    await a.svc.start();
    expect(a.svc.getState().verbosity).toBe('auto');
    expect(() => a.svc.setVerbosity('chatty')).toThrow(/verbosity/);
    expect(a.svc.setVerbosity('detailed')).toEqual({ verbosity: 'detailed' });
    expect(a.events).toContainEqual({ kind: 'settings', verbosity: 'detailed' });
    a.svc.send('status?', { mode: 'voice' });
    await waitFor(() => !a.svc.getState().busy);
    expect(lastUser(p, 0)).toMatch(/\[Reply style: spoken aloud, detailed/);
    a.svc.shutdown();
    const b = make(scripted([]), fakeSource([]));
    await b.svc.start();
    expect(b.svc.getState().verbosity).toBe('detailed');
  });

  it('set_verbosity tool: the brain can change the setting ("keep it short from now on")', async () => {
    const p = scripted([
      { toolCalls: [{ id: 'v', name: 'set_verbosity', arguments: '{"level":"brief"}' }], stopReason: 'tool_calls' },
      { emit: "Okay, I'll keep it short." },
    ]);
    const { svc, events } = make(p, fakeSource([]));
    await svc.start();
    svc.send('keep it short from now on');
    await waitFor(() => !svc.getState().busy);
    expect(svc.getState().verbosity).toBe('brief');
    expect(events).toContainEqual({ kind: 'settings', verbosity: 'brief' });
    const bad = scripted([
      { toolCalls: [{ id: 'v', name: 'set_verbosity', arguments: '{"level":"loud"}' }], stopReason: 'tool_calls' },
      { emit: 'Sorry.' },
    ]);
    const other = make(bad, fakeSource([]));
    await other.svc.start();
    other.svc.send('be loud');
    await waitFor(() => !other.svc.getState().busy);
    expect(other.svc.getState().verbosity).toBe('auto');
    const toolResult = bad.calls[1].messages.find((m) => m.role === 'tool');
    expect(toolResult && toolResult.role === 'tool' ? toolResult.content : '').toMatch(/level must be one of/);
  });

  it('brief: nothing unheard -> "Nothing new." with no brain turn', async () => {
    const p = scripted([]);
    const { svc } = make(p, fakeSource([snap({ sessionId: 'out4', status: 'idle' })]));
    await svc.start();
    await svc.poll();
    svc.send('Brief me', { mode: 'voice', intent: 'brief' });
    expect(p.calls).toHaveLength(0);
    expect(svc.getState().busy).toBe(false);
    expect(svc.getState().messages.map((m) => [m.role, m.text, m.intent])).toEqual([
      ['user', 'Brief me', 'brief'],
      ['herald', 'Nothing new.', undefined],
    ]);
  });

  it('brief: only unheard items, most urgent first, capped at three, and they become heard', async () => {
    const sessions = ['a', 'b', 'c', 'd', 'e'].map((id) =>
      snap({ sessionId: id, status: 'waiting', pendingChoice: { ...choice, signature: `sig-${id}` } })
    );
    const src = fakeSource(sessions);
    const p = scripted([{ emit: 'B needs you. C asks to ship. D needs you. And 1 more.' }]);
    const { svc } = make(p, src);
    await svc.start();
    await svc.poll();
    const before = svc.getState().inbox.filter((i) => !i.heard);
    expect(before).toHaveLength(5);
    svc.send('Brief me', { mode: 'voice', intent: 'brief' });
    await waitFor(() => !svc.getState().busy);
    const text = lastUser(p, 0);
    expect(text).toMatch(/Tell them ONLY about these new items/);
    const items = text.split('New items:')[1].trim().split('\n');
    expect(items).toHaveLength(3);
    expect(items[0]).toMatch(/^- \[blocked\]/);
    expect(text).toMatch(/"and 2 more"/);
    expect(text).not.toMatch(/\[Reply style:/);
    expect(svc.getState().inbox.filter((i) => !i.heard)).toHaveLength(0);
  });

  it('sttHints: session names (newest first), the names Herald / Jarvis, jargon; bounded', async () => {
    const src = fakeSource([
      snap({ sessionId: 'x1', sessionName: 'Doc Upload Site', projectName: 'doc-upload-site', lastActivity: 5 }),
      snap({ sessionId: 'x2', sessionName: 'Out4', projectName: 'out4', lastActivity: 9 }),
      snap({ sessionId: 'x3', sessionName: 'gone', inactive: true }),
    ]);
    const { svc } = make(scripted([]), src);
    await svc.start();
    await svc.poll();
    const h = svc.sttHints();
    expect(h.prompt).toMatch(/^Herald, Jarvis\. Sessions: Out4, Doc Upload Site, doc-upload-site\. tmux, deploy/);
    expect(h.prompt).not.toMatch(/gone/);
    expect(h.hotwords).toMatch(/Out4/);
    expect(h.prompt.length).toBeLessThanOrEqual(600);
    src.sessions.push(snap({ sessionId: 'x4', sessionName: 'Fresh One', lastActivity: 20 }));
    await svc.poll();
    expect(svc.sttHints().prompt).toMatch(/Sessions: Fresh One,/);
  });

  it('markHeard rejects non-arrays', () => {
    const { svc } = make(null, fakeSource([]));
    expect(() => svc.markHeard('x' as unknown as string[])).toThrow();
  });
});

describe('herald config', () => {
  it('defaults to openai_compatible and requires base_url + model', () => {
    const r = resolveHeraldConfig(undefined, {});
    expect(r.provider).toBe('openai_compatible');
    expect(r.featureEnabled).toBe(true);
    expect(r.brainConfigured).toBe(false);
    expect(r.disabledReason).toMatch(/herald\.base_url.*herald\.model/);
    expect(r.displayName).toBe('Herald');
    expect(r.echoDelayMs).toBe(5000);
  });

  it('openai_compatible with optional key from HERALD_LLM_API_KEY only', () => {
    const block = parseHeraldConfigBlock({ base_url: 'http://spark.local:8000/v1/', model: 'qwen3-32b', api_key: 'IGNORED' });
    const r = resolveHeraldConfig(block, { HERALD_LLM_API_KEY: 'k1', ANTHROPIC_API_KEY: 'nope' });
    expect(r.brainConfigured).toBe(true);
    expect(r.baseUrl).toBe('http://spark.local:8000/v1');
    expect(r.apiKey).toBe('k1');
    expect(resolveHeraldConfig(block, {}).apiKey).toBeNull();
  });

  it('rejects a non-http base_url', () => {
    const r = resolveHeraldConfig({ base_url: 'spark:8000', model: 'm' }, {});
    expect(r.brainConfigured).toBe(false);
    expect(r.disabledReason).toMatch(/not a valid/);
  });

  it('anthropic is opt-in and needs ANTHROPIC_API_KEY', () => {
    const off = resolveHeraldConfig({ provider: 'anthropic' }, {});
    expect(off.brainConfigured).toBe(false);
    expect(off.model).toBe('claude-haiku-4-5');
    expect(off.disabledReason).toMatch(/ANTHROPIC_API_KEY/);
    const on = resolveHeraldConfig({ provider: 'anthropic', model: 'claude-sonnet-5-5' }, { ANTHROPIC_API_KEY: 'sk' });
    expect(on.brainConfigured).toBe(true);
    expect(on.model).toBe('claude-sonnet-5-5');
  });

  it('explicitly disabled', () => {
    const r = resolveHeraldConfig({ enabled: false, base_url: 'http://x', model: 'm' }, {});
    expect(r.featureEnabled).toBe(false);
    expect(r.disabledReason).toMatch(/disabled/i);
  });

  it('parses and clamps values, drops junk', () => {
    const b = parseHeraldConfigBlock({ provider: 'openai', display_name: '  Jarvis ', echo_delay_ms: 10, max_tokens: 'lots' });
    expect(b).toEqual({ display_name: 'Jarvis', echo_delay_ms: 10 });
    const r = resolveHeraldConfig(b, {});
    expect(r.displayName).toBe('Jarvis');
    expect(r.echoDelayMs).toBe(1500);
    expect(parseHeraldConfigBlock('nope')).toBeUndefined();
  });

  it('resolves the state dir: env override > config state_dir > ~/.companion/herald', () => {
    const def = resolveHeraldConfig(undefined, {});
    expect(def.stateDir).toBe(path.join(os.homedir(), '.companion', 'herald'));
    const fromCfg = resolveHeraldConfig(parseHeraldConfigBlock({ state_dir: '~/sandbox/herald' }), {});
    expect(fromCfg.stateDir).toBe(path.join(os.homedir(), 'sandbox', 'herald'));
    const fromEnv = resolveHeraldConfig({ state_dir: '/ignored' }, { COMPANION_HERALD_STATE_DIR: '/tmp/hs' });
    expect(fromEnv.stateDir).toBe('/tmp/hs');
    // Disabled/anthropic branches carry it too.
    expect(resolveHeraldConfig({ enabled: false }, { COMPANION_HERALD_STATE_DIR: '/tmp/hs' }).stateDir).toBe('/tmp/hs');
  });
});
