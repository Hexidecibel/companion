import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AskTracker,
  ASK_TIMEOUT_MS,
  composeAnswer,
  findReply,
  isQuestion,
  promptMatches,
  type AskLink,
} from '../src/herald/asks';
import { extractExchanges } from '../src/herald/session-source';
import { HeraldService } from '../src/herald/service';
import { HeraldStore } from '../src/herald/store';
import type { ResolvedHeraldConfig } from '../src/herald/config';
import type { HeraldEvent, HeraldMessage } from '../src/herald/protocol';
import type { PendingChoice, SessionSnapshot, SessionSource, TranscriptExchange } from '../src/herald/session-source';
import type { LlmChatRequest, LlmChatResult, LlmProvider } from '../src/herald/llm/provider';
import type { ConversationMessage } from '../src/types';
import { snap } from './herald-helpers';

const T0 = 10_000_000;

function link(over: Partial<AskLink> = {}): AskLink {
  return {
    actionId: 'a1',
    serverId: 'local',
    sessionId: 'out4',
    sessionName: 'Out4',
    userQuestion: "ask Out4 what's failing",
    sentText: "What's failing in the test run?",
    sentAt: T0,
    baselineTurnKey: 'turn-0',
    baselineBlockKey: null,
    ...over,
  };
}

describe('AskTracker lifecycle', () => {
  it('waits while working, then decides reply once a new turn exists', () => {
    const t = new AskTracker([link()]);
    expect(t.update([snap({ sessionId: 'out4', status: 'working' })], T0 + 1000)).toEqual([]);
    // Same turn as at send time: nothing yet.
    expect(t.update([snap({ sessionId: 'out4', lastTurnKey: 'turn-0' })], T0 + 2000)).toEqual([]);
    const d = t.update([snap({ sessionId: 'out4', lastTurnKey: 'turn-1' })], T0 + 3000);
    expect(d.map((x) => x.type)).toEqual(['reply']);
    // Busy while the answer is composed: never decided twice.
    expect(t.update([snap({ sessionId: 'out4', lastTurnKey: 'turn-1' })], T0 + 4000)).toEqual([]);
    t.remove('a1');
    expect(t.size).toBe(0);
  });

  it('reports a new block once and keeps waiting for the answer', () => {
    const choice: PendingChoice = {
      question: 'Which test fixture should I use?',
      options: [{ label: 'a' }, { label: 'b' }],
      multiSelect: false,
      signature: 'sig',
    };
    const t = new AskTracker([link()]);
    const s = snap({ sessionId: 'out4', status: 'waiting', pendingChoice: choice, lastTurnKey: 'turn-1' });
    const d = t.update([s], T0 + 1000);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ type: 'blocked', what: 'Which test fixture should I use' });
    expect(t.update([s], T0 + 2000)).toEqual([]);
    expect(t.size).toBe(1);
  });

  it('a block already on screen when we sent is not news', () => {
    const t = new AskTracker([link({ baselineBlockKey: 'a:tool-1' })]);
    const s = snap({
      sessionId: 'out4',
      status: 'waiting',
      pendingApproval: { tool: 'Bash', detail: 'ls', toolUseId: 'tool-1' },
    });
    expect(t.update([s], T0 + 1000)).toEqual([]);
  });

  it('drops quietly after 30 minutes without a reply, or when the session closes', () => {
    const t = new AskTracker([link(), link({ actionId: 'a2', sessionId: 'docs', sessionName: 'Docs' })]);
    const d = t.update(
      [snap({ sessionId: 'out4', status: 'working' }), snap({ sessionId: 'docs', inactive: true })],
      T0 + 1000
    );
    expect(d.map((x) => x.type)).toEqual(['gone']);
    expect(t.update([snap({ sessionId: 'out4', status: 'working' })], T0 + ASK_TIMEOUT_MS + 1).map((x) => x.type)).toEqual([
      'timeout',
    ]);
    expect(t.size).toBe(0);
  });

  it('a session missing from one listing is not dropped', () => {
    const t = new AskTracker([link()]);
    expect(t.update([], T0 + 1000)).toEqual([]);
    expect(t.size).toBe(1);
  });

  it('several asks across sessions are tracked independently', () => {
    const t = new AskTracker([link(), link({ actionId: 'a2', sessionId: 'docs', sessionName: 'Docs' })]);
    const d = t.update(
      [snap({ sessionId: 'out4', status: 'working' }), snap({ sessionId: 'docs', lastTurnKey: 'd-1' })],
      T0 + 1000
    );
    expect(d.map((x) => `${x.type}:${x.link.sessionName}`)).toEqual(['reply:Docs']);
  });
});

describe('finding the reply to our prompt', () => {
  const msgs = (list: Array<[ConversationMessage['type'], string, number]>): ConversationMessage[] =>
    list.map(([type, content, timestamp], i) => ({ id: `m${i}`, type, content, timestamp }));

  it('pairs prompts with their replies (tool results do not split a reply)', () => {
    const ex = extractExchanges(
      msgs([
        ['user', 'old question', T0 - 100_000],
        ['assistant', 'old answer', T0 - 90_000],
        ['user', "What's failing in the test run?", T0 + 10],
        ['assistant', 'Looking.', T0 + 20],
        ['user', '', T0 + 30],
        ['assistant', 'Two tests fail: the upload fixture is missing.', T0 + 40],
      ]),
      T0 - 60_000
    );
    expect(ex).toEqual([
      {
        prompt: "What's failing in the test run?",
        promptAt: T0 + 10,
        reply: 'Looking.\n\nTwo tests fail: the upload fixture is missing.',
        replyAt: T0 + 40,
      },
    ]);
  });

  it('only a complete reply to OUR prompt counts', () => {
    const ours: TranscriptExchange = {
      prompt: "What's failing in the test run?",
      promptAt: T0 + 10,
      reply: 'Two tests fail.',
      replyAt: T0 + 40,
    };
    const other: TranscriptExchange = { prompt: 'unrelated', promptAt: T0 + 50, reply: 'ok', replyAt: T0 + 60 };
    expect(findReply(link(), [ours], true)).toEqual({ reply: 'Two tests fail.', at: T0 + 40 });
    // Still working on it: not complete.
    expect(findReply(link(), [ours], false)).toBeNull();
    // Moved on to a later prompt: ours is complete.
    expect(findReply(link(), [ours, other], false)).toEqual({ reply: 'Two tests fail.', at: T0 + 40 });
    expect(findReply(link(), [other], true)).toBeNull();
    expect(promptMatches('  WHAT’S failing in the test run? also check lint', "What's failing in the test run?")).toBe(
      true
    );
  });

  it('question detection', () => {
    expect(isQuestion("ask Out4 what's failing")).toBe(true);
    expect(isQuestion('is the build green?')).toBe(true);
    expect(isQuestion('tell Docs to check the test fixture')).toBe(false);
  });
});

function scripted(texts: Array<string | Error>): LlmProvider & { calls: LlmChatRequest[] } {
  const calls: LlmChatRequest[] = [];
  return {
    name: 'fake',
    model: 'fake-1',
    calls,
    async chat(r) {
      calls.push(r);
      const t = texts.shift() ?? 'ok';
      if (t instanceof Error) throw t;
      r.onText(t);
      return { text: t, toolCalls: [], stopReason: 'end', usage: {} } as LlmChatResult;
    },
  };
}

describe('composeAnswer (grounding)', () => {
  const input = {
    sessionName: 'Out4',
    userQuestion: "ask Out4 what's failing",
    sentText: "What's failing?",
    reply: 'Two tests fail in upload.spec.ts because the fixture file is missing. I can add it.',
  };

  it('asks the model with the reply only and returns its sentence', async () => {
    const p = scripted(['Two upload tests fail because a fixture file is missing; it offers to add it.']);
    const a = await composeAnswer(p, input);
    expect(a).toEqual({ text: 'Two upload tests fail because a fixture file is missing; it offers to add it.', via: 'llm' });
    const req = p.calls[0];
    expect(req.tools).toEqual([]);
    expect(req.toolChoice).toBe('none');
    expect(req.system).toMatch(/ONLY the session's reply/);
    expect(req.messages[0].role === 'user' && req.messages[0].text).toContain(input.reply);
  });

  it('a made-up number falls back to the session\'s own words', async () => {
    const a = await composeAnswer(scripted(['Seven tests fail.']), input);
    expect(a.via).toBe('fallback');
    expect(a.text).toBe('Two tests fail in upload.spec.ts because the fixture file is missing.');
    expect(a.rejected).toMatch(/7|Seven|numbers/);
  });

  it('falls back on errors and without a brain', async () => {
    expect((await composeAnswer(scripted([new Error('down')]), input)).via).toBe('fallback');
    expect((await composeAnswer(null, input)).via).toBe('fallback');
  });

  it('strips a leading "Out4 says"', async () => {
    const a = await composeAnswer(scripted(['Out4 says: two tests fail.']), input);
    expect(a.text).toBe('two tests fail.');
  });
});

// ---------------------------------------------------------------------------
// End to end through HeraldService (mocked session source + LLM)

const cfg = (dir: string): ResolvedHeraldConfig =>
  ({
    featureEnabled: true,
    displayName: 'Herald',
    provider: 'openai_compatible',
    baseUrl: 'http://x/v1',
    model: 'm',
    echoDelayMs: 30,
    requestTimeoutMs: 5000,
    maxTokens: 700,
    stateDir: dir,
    apiKey: null,
    brainConfigured: true,
  }) as ResolvedHeraldConfig;

async function waitFor(cond: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface Step {
  text?: string;
  tool?: { name: string; args: Record<string, unknown> };
}

function brain(steps: Step[]): LlmProvider & { calls: LlmChatRequest[] } {
  const calls: LlmChatRequest[] = [];
  return {
    name: 'fake',
    model: 'fake-1',
    calls,
    async chat(r) {
      calls.push(r);
      const s = steps.shift() || { text: 'ok' };
      if (s.tool) {
        return {
          text: '',
          toolCalls: [{ id: `t${calls.length}`, name: s.tool.name, arguments: JSON.stringify(s.tool.args) }],
          stopReason: 'tool_calls',
          usage: {},
        } as LlmChatResult;
      }
      r.onText(s.text || '');
      return { text: s.text || '', toolCalls: [], stopReason: 'end', usage: {} } as LlmChatResult;
    },
  };
}

function world() {
  const state = {
    sessions: [snap({ sessionId: 'out4', sessionName: 'Out4', lastTurnKey: 'turn-0' })] as SessionSnapshot[],
    exchanges: [] as TranscriptExchange[],
  };
  const src = {
    serverId: 'local',
    listSessions: jest.fn(async () => state.sessions),
    getRecentTranscript: jest.fn(async () => ({ lastUserPrompt: null, assistantTurns: [] })),
    getExchangesSince: jest.fn(async () => state.exchanges),
    getLiveChoice: jest.fn(async () => null),
    sessionExists: jest.fn(async () => true),
    sendText: jest.fn(async () => true),
    sendChoice: jest.fn(async () => true),
  };
  return { state, src: src as typeof src & SessionSource };
}

describe('ask-and-report through the service', () => {
  let dir: string;
  const services: HeraldService[] = [];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-asks-'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const s of services.splice(0)) s.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function make(p: LlmProvider, src: SessionSource, store = new HeraldStore(dir, 5)) {
    const events: HeraldEvent[] = [];
    const svc = new HeraldService({
      config: cfg(dir),
      provider: p,
      sources: [src],
      store,
      broadcast: (e) => events.push(e),
      audit: () => {},
      pollIntervalMs: 60_000,
      toolbox: null,
    });
    services.push(svc);
    return { svc, events };
  }

  const answers = (svc: HeraldService) =>
    svc.getState().messages.filter((m) => m.role === 'herald' && /answered|replied|needs your input/.test(m.text));

  async function askOut4(svc: HeraldService, how: { voice?: boolean } = {}) {
    svc.send("ask Out4 what's failing", how.voice ? { mode: 'voice' } : {});
    await waitFor(() => svc.getState().actions.some((a) => a.status === 'sent'));
    await waitFor(() => svc.getState().messages.some((m) => m.text === 'Sent to Out4.'));
    await waitFor(() => !svc.getState().busy);
  }

  it('reports the answer tied to the question, replacing the generic finished note', async () => {
    const { state, src } = world();
    const p = brain([
      { tool: { name: 'propose_input', args: { session: 'Out4', text: "What's failing in the test run?" } } },
      { text: 'Asking Out4 now.' },
      { text: 'Two upload tests fail because a fixture file is missing.' },
    ]);
    const { svc, events } = make(p, src);
    await svc.start();
    await svc.poll();
    await askOut4(svc);
    // Session works, then finishes with a reply to our prompt.
    state.sessions = [snap({ sessionId: 'out4', sessionName: 'Out4', status: 'working', lastTurnKey: 'turn-0' })];
    await svc.poll();
    state.sessions = [snap({ sessionId: 'out4', sessionName: 'Out4', lastTurnKey: 'turn-1', lastTurnGist: 'Two tests fail.' })];
    state.exchanges = [
      {
        prompt: "What's failing in the test run?",
        promptAt: Date.now(),
        reply: 'Two tests fail in upload.spec.ts: the fixture file is missing.',
        replyAt: Date.now(),
      },
    ];
    await svc.poll();
    await waitFor(() => answers(svc).length === 1);
    const msg = answers(svc)[0];
    expect(msg.text).toBe('Out4 answered your question: Two upload tests fail because a fixture file is missing.');
    expect(msg.sessionRefs).toEqual([{ serverId: 'local', sessionId: 'out4', sessionName: 'Out4' }]);
    // Typed: tone + screen only, never spoken unasked.
    expect(msg.quiet).toBe(true);
    const inbox = svc.getState().inbox;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ answer: true, priority: 'finished', heard: false });
    expect(inbox[0].headline).toMatch(/^Out4 answered your question:/);
    // The answer-composition request saw the reply and the question, and nothing else.
    const req = p.calls[p.calls.length - 1];
    expect(req.tools).toEqual([]);
    expect(JSON.stringify(req.messages)).toContain('fixture file is missing');
    expect(events.some((e) => e.kind === 'inbox')).toBe(true);
    // Brief me puts the answer first.
    const p2 = brain([{ text: 'Out4 answered your question: two upload tests fail.' }]);
    (svc as unknown as { provider: LlmProvider }).provider = p2;
    svc.send("what's up?", { intent: 'brief' });
    await waitFor(() => !svc.getState().busy);
    const brief = p2.calls[0].messages.map((m) => ('text' in m ? m.text : '')).join('\n');
    expect(brief).toMatch(/\[answer\] Out4 answered your question/);
  });

  it('in an active voice exchange the answer is spoken (not quiet) and counts as heard', async () => {
    const { state, src } = world();
    const p = brain([
      { tool: { name: 'propose_input', args: { session: 'Out4', text: 'Is the build green?' } } },
      { text: 'Asking.' },
      { text: 'Yes, the build is green.' },
    ]);
    const { svc } = make(p, src);
    await svc.start();
    await svc.poll();
    await askOut4(svc, { voice: true });
    state.sessions = [snap({ sessionId: 'out4', sessionName: 'Out4', lastTurnKey: 'turn-1' })];
    state.exchanges = [{ prompt: 'Is the build green?', promptAt: Date.now(), reply: 'Build is green.', replyAt: Date.now() }];
    await svc.poll();
    await waitFor(() => answers(svc).length === 1);
    const m = answers(svc)[0] as HeraldMessage;
    expect(m.quiet).toBeUndefined();
    expect(svc.getState().inbox[0].heard).toBe(true);
  });

  it('a block is reported as needing input, with no extra inbox item', async () => {
    const { state, src } = world();
    const p = brain([
      { tool: { name: 'propose_input', args: { session: 'Out4', text: 'Check the test fixture' } } },
      { text: 'Sending.' },
    ]);
    const { svc } = make(p, src);
    await svc.start();
    await svc.poll();
    await askOut4(svc);
    state.sessions = [
      snap({
        sessionId: 'out4',
        sessionName: 'Out4',
        status: 'waiting',
        pendingChoice: { question: 'Which fixture?', options: [{ label: 'a' }, { label: 'b' }], multiSelect: false, signature: 's' },
      }),
    ];
    await svc.poll();
    await waitFor(() => answers(svc).length === 1);
    expect(answers(svc)[0].text).toBe('Out4 needs your input on Which fixture.');
    // The inbox has only the blocked item (the tracker's), not a duplicate.
    expect(svc.getState().inbox.map((i) => i.priority)).toEqual(['blocked']);
  });

  it('ask links survive a daemon restart and still get answered', async () => {
    const { state, src } = world();
    const store = new HeraldStore(dir, 5);
    const p = brain([
      { tool: { name: 'propose_input', args: { session: 'Out4', text: "What's failing?" } } },
      { text: 'Asking.' },
    ]);
    const first = make(p, src, store).svc;
    await first.start();
    await first.poll();
    await askOut4(first);
    first.shutdown();
    services.splice(services.indexOf(first), 1);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf-8'));
    expect(saved.asks).toHaveLength(1);
    expect(saved.asks[0]).toMatchObject({ sessionName: 'Out4', sentText: "What's failing?" });

    const p2 = brain([{ text: 'The lint step fails.' }]);
    const { svc } = make(p2, src, new HeraldStore(dir, 5));
    await svc.start();
    await svc.poll();
    state.sessions = [snap({ sessionId: 'out4', sessionName: 'Out4', lastTurnKey: 'turn-9' })];
    state.exchanges = [{ prompt: "What's failing?", promptAt: Date.now(), reply: 'The lint step fails.', replyAt: Date.now() }];
    await svc.poll();
    await waitFor(() => answers(svc).length === 1);
    expect(answers(svc)[0].text).toBe('Out4 answered your question: The lint step fails.');
  });

  it('without a matching reply nothing is reported and the generic note stays suppressed', async () => {
    const { state, src } = world();
    const p = brain([
      { tool: { name: 'propose_input', args: { session: 'Out4', text: "What's failing?" } } },
      { text: 'Asking.' },
    ]);
    const { svc } = make(p, src);
    await svc.start();
    await svc.poll();
    await askOut4(svc);
    state.sessions = [snap({ sessionId: 'out4', sessionName: 'Out4', status: 'working', lastTurnKey: 'turn-0' })];
    await svc.poll();
    // An earlier task finishes; our prompt is still queued.
    state.sessions = [snap({ sessionId: 'out4', sessionName: 'Out4', lastTurnKey: 'turn-1' })];
    state.exchanges = [{ prompt: 'earlier task', promptAt: Date.now(), reply: 'Done.', replyAt: Date.now() }];
    await svc.poll();
    await new Promise((r) => setTimeout(r, 50));
    expect(answers(svc)).toHaveLength(0);
    expect(svc.getState().inbox).toHaveLength(0);
  });
});
