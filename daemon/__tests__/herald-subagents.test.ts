import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HeraldService } from '../src/herald/service';
import { HeraldStore } from '../src/herald/store';
import type { ResolvedHeraldConfig } from '../src/herald/config';
import type { HeraldEvent } from '../src/herald/protocol';
import type { SessionSnapshot, SessionSource } from '../src/herald/session-source';
import type { LlmChatRequest, LlmChatResult, LlmProvider } from '../src/herald/llm/provider';
import { snap } from './herald-helpers';
import { executeTool, TOOL_SPECS, validateToolCall, type ToolEnv } from '../src/herald/tools';
import { ActionManager } from '../src/herald/actions';
import { InboxTracker } from '../src/herald/inbox';
import { classifyFallback, fallbackReply } from '../src/herald/fallback';
import { buildSystemPrompt } from '../src/herald/prompt';
import type { SubagentAlert } from '../src/subagents/alerts';
import type { SubagentFacts } from '../src/subagents/protocol';

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

function recorder(reply = 'ok'): LlmProvider & { calls: LlmChatRequest[] } {
  const calls: LlmChatRequest[] = [];
  return {
    name: 'fake',
    model: 'fake-1',
    calls,
    async chat(r: LlmChatRequest) {
      calls.push(r);
      r.onText(reply);
      return { text: reply, toolCalls: [], stopReason: 'end', usage: {} } as unknown as LlmChatResult;
    },
  } as LlmProvider & { calls: LlmChatRequest[] };
}

function source(sessions: SessionSnapshot[]) {
  const src = {
    serverId: 'local',
    listSessions: jest.fn(async () => sessions),
    getRecentTranscript: jest.fn(async () => ({ lastUserPrompt: null, assistantTurns: [] })),
    getExchangesSince: jest.fn(async () => []),
    getLiveChoice: jest.fn(async () => null),
    sessionExists: jest.fn(async () => true),
    sendText: jest.fn(async () => true),
    sendChoice: jest.fn(async () => true),
    cancelInput: jest.fn(async () => true),
  };
  return src as typeof src & SessionSource;
}

const facts = (over: Partial<SubagentFacts> = {}): SubagentFacts => ({
  rollup: '2 of 5 done, 3 running.',
  running: 3,
  total: 5,
  generatedAt: 1,
  moreSessions: 0,
  sessions: [
    {
      conversationId: 'conv-1',
      sessionId: 'out4',
      session: 'Out4',
      rollup: '2 of 5 done, 3 running. Bob is running tests (2 failing runs, 4 min).',
      running: 3,
      total: 5,
      failed: 0,
      more: 0,
      agents: [
        {
          agentId: 'a1',
          name: 'Bob',
          type: 'general-purpose',
          status: 'running',
          line: 'Bob is running tests (2 failing runs, 4 min)',
          elapsedMs: 4 * 60_000,
          idleMs: 90_000,
          activity: 'npx jest TOKEN=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
          tests: { runs: 3, failed: 2, lastFailed: true },
          filesTouched: 2,
        },
        { agentId: 'a2', name: 'Ann', status: 'done', line: 'Ann finished after 2 min', elapsedMs: 120_000, filesTouched: 0, summary: 'Agent "Ann" completed' },
      ],
    },
  ],
  ...over,
});

const alert = (over: Partial<SubagentAlert> = {}): SubagentAlert => ({
  key: 'g|conv-1||a1',
  kind: 'group_done',
  sessionId: 'out4',
  sessionName: 'Out4',
  conversationId: 'conv-1',
  headline: '5 agents done in Out4: 4 finished, 1 failed',
  agentIds: ['a1', 'a2'],
  names: ['Bob', 'Ann'],
  total: 5,
  failed: 1,
  at: Date.now(),
  ...over,
});

describe('subagent_status brain tool', () => {
  const sessions = [
    snap({ sessionId: 'out4', sessionName: 'Out4', status: 'working' }),
    snap({ sessionId: 'far', sessionName: 'Far', serverId: 'mac' }),
  ];
  function env(over: Partial<ToolEnv> = {}): ToolEnv {
    return {
      listSessions: async () => sessions,
      getSource: () => null,
      actions: new ActionManager({ getSource: () => null, echoDelayMs: 20, onChange: () => {}, onSent: () => {}, audit: () => {} }),
      now: () => 10 * 60_000,
      statusSince: () => null,
      echoDelayMs: 20,
      ...over,
    };
  }
  const turn = () => ({ userText: "where's it at?", sessionRefs: new Map(), proposals: [] });

  it('spec validates (session optional)', () => {
    expect(TOOL_SPECS.find((t) => t.name === 'subagent_status')).toBeTruthy();
    expect(validateToolCall('subagent_status', '{}').ok).toBe(true);
    expect(validateToolCall('subagent_status', '{"session":"Out4"}').ok).toBe(true);
    expect(buildSystemPrompt('Herald')).toContain('subagent_status');
  });

  it('returns structured, redacted facts and refs the sessions', async () => {
    const calls: Array<string | undefined> = [];
    const subagents = { facts: (id?: string) => (calls.push(id), facts()) };
    const t = turn();
    const out = await executeTool('subagent_status', {}, env({ subagents }), t);
    expect(out.isError).toBe(false);
    expect(out.content).not.toContain('sk-ant-api03');
    const data = JSON.parse(out.content);
    expect(data.running).toBe(3);
    expect(data.sessions[0]).toMatchObject({
      session: 'Out4',
      rollup: expect.stringMatching(/^2 of 5 done/),
      agents: [
        expect.objectContaining({ name: 'Bob', status: 'running', ran: '4m', idle: '2m', tests: { runs: 3, failed: 2, lastFailed: true } }),
        expect.objectContaining({ name: 'Ann', status: 'done', result: 'Agent "Ann" completed' }),
      ],
    });
    expect(data.instruction).toMatch(/rollup/);
    expect(t.sessionRefs.has('local:out4')).toBe(true);
    await executeTool('subagent_status', { session: 'out 4' }, env({ subagents }), turn());
    expect(calls).toEqual([undefined, 'out4']);
  });

  it('says plainly when there are none; refuses remote sessions; unavailable without the tracker', async () => {
    const empty = { facts: () => facts({ sessions: [], running: 0, total: 0 }) };
    const none = JSON.parse((await executeTool('subagent_status', { session: 'out4' }, env({ subagents: empty }), turn())).content);
    expect(none.sessions).toEqual([]);
    expect(none.instruction).toMatch(/Out4 has no subagents/);
    expect((await executeTool('subagent_status', { session: 'far' }, env({ subagents: empty }), turn())).isError).toBe(true);
    expect((await executeTool('subagent_status', {}, env(), turn())).content).toMatch(/not available/);
    expect((await executeTool('subagent_status', {}, env({ subagents: { facts: () => null } }), turn())).content).toMatch(/off/);
  });
});

describe('subagent inbox items', () => {
  const working = [snap({ sessionId: 'out4', sessionName: 'Out4', status: 'working', lastTurnKey: 't1' })];
  const row = (a: SubagentAlert) => ({
    key: a.key,
    serverId: 'local',
    sessionId: a.sessionId,
    sessionName: a.sessionName,
    headline: a.headline,
    at: a.at,
    subagents: { kind: a.kind, agentIds: a.agentIds, names: a.names, total: a.total, failed: a.failed, ...(a.stuckKind ? { stuckKind: a.stuckKind } : {}) },
  });

  it('one item per fact, survives the session working, replaced wholesale', () => {
    const inbox = new InboxTracker();
    inbox.update(working, 1000);
    const g = alert();
    const f = alert({ key: 'f|a3|9', kind: 'failed', headline: 'An agent failed in Out4: Cara', agentIds: ['a3'], names: ['Cara'], total: 1, failed: 1 });
    expect(inbox.setSubagentAlerts([row(g), row(f)], 2000)).toBe(true);
    expect(inbox.list().map((i) => i.subagents?.kind)).toEqual(['group_done', 'failed']);
    // Same facts again: no change (one tone).
    expect(inbox.setSubagentAlerts([row(g), row(f)], 3000)).toBe(false);
    // The parent session working again (it reads the notifications) keeps them.
    inbox.update(working, 4000);
    inbox.update([{ ...working[0], status: 'idle', lastTurnKey: 't2' }], 5000);
    inbox.update(working, 6000);
    expect(inbox.list().filter((i) => i.subagents)).toHaveLength(2);
    const id = inbox.list().find((i) => i.subagents?.kind === 'failed')!.id;
    inbox.markHeard([id]);
    expect(inbox.setSubagentAlerts([row(f)], 7000)).toBe(true);
    expect(inbox.list().filter((i) => i.subagents)).toEqual([expect.objectContaining({ id, heard: true })]);
    expect(inbox.setSubagentAlerts([], 8000)).toBe(true);
    expect(inbox.list().filter((i) => i.subagents)).toEqual([]);
  });

  it('the fallback answers "where are the agents at" from the rollup', () => {
    expect(classifyFallback('Where are the agents at?')).toBe('subagents');
    expect(classifyFallback("where's it at")).toBe('subagents');
    expect(classifyFallback('how are the agents doing?')).toBe('subagents');
    expect(classifyFallback('status')).toBe('status');
    expect(
      fallbackReply({ kind: 'subagents', reason: 'unreachable', announce: false, snapshots: [], briefing: [], subagents: 'Out4: 2 of 5 done, 3 running.' })
    ).toBe('Out4: 2 of 5 done, 3 running.');
  });
});

describe('Herald service: subagent alerts and snapshot', () => {
  let dir: string;
  const services: HeraldService[] = [];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-subagents-'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const s of services.splice(0)) s.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function make(provider: LlmProvider) {
    const events: HeraldEvent[] = [];
    const src = source([snap({ sessionId: 'out4', sessionName: 'Out4', status: 'working', lastTurnKey: 't1' })]);
    const svc = new HeraldService({
      config: cfg(dir),
      provider,
      sources: [src],
      store: new HeraldStore(dir, 5),
      broadcast: (e) => events.push(e),
      audit: () => {},
      pollIntervalMs: 60_000,
      toolbox: null,
    });
    services.push(svc);
    return { svc, events };
  }

  it('alerts before start are applied; live ones push an inbox event; snapshot carries running agents + news', async () => {
    const p = recorder();
    const { svc, events } = make(p);
    svc.setSubagents({ facts: () => facts() });
    svc.syncSubagentAlerts([alert()]);
    await svc.start();
    await svc.poll();
    expect(svc.getState().inbox.filter((i) => i.subagents)).toHaveLength(1);
    svc.syncSubagentAlerts([alert(), alert({ key: 's|a1|loop|1', kind: 'stuck', headline: 'An agent in Out4 looks stuck: Bob, looping', stuckKind: 'loop' })]);
    expect(events.some((e) => e.kind === 'inbox' && e.inbox.some((i) => i.subagents?.kind === 'stuck'))).toBe(true);
    svc.send('Where are the agents at?', { mode: 'text' });
    await waitFor(() => !svc.getState().busy);
    const text = JSON.stringify(p.calls[0].messages[p.calls[0].messages.length - 1]);
    expect(text).toContain('Subagents running: Out4 3 running of 5');
    expect(text).toContain('[agents finished] 5 agents done in Out4: 4 finished, 1 failed');
    // Live state never in the cached system prompt.
    expect(p.calls[0].system).not.toContain('Subagents running');
    expect(p.calls[0].system).not.toContain('agents done in');
  });
});
