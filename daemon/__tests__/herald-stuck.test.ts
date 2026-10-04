import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HeraldService, type HeraldStuckAlert } from '../src/herald/service';
import { HeraldStore } from '../src/herald/store';
import type { ResolvedHeraldConfig } from '../src/herald/config';
import type { HeraldEvent } from '../src/herald/protocol';
import type { SessionSnapshot, SessionSource } from '../src/herald/session-source';
import type { LlmChatRequest, LlmChatResult, LlmProvider } from '../src/herald/llm/provider';
import { snap } from './herald-helpers';
import { executeTool, TOOL_SPECS, validateToolCall, type ToolEnv } from '../src/herald/tools';
import { ActionManager } from '../src/herald/actions';
import { InboxTracker } from '../src/herald/inbox';
import { briefSummary } from '../src/herald/fallback';
import type { StuckFinding } from '../src/stuck/protocol';

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

function recorder(reply = 'Out4 looks stuck.'): LlmProvider & { calls: LlmChatRequest[] } {
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

const alert = (over: Partial<HeraldStuckAlert> = {}): HeraldStuckAlert => ({
  key: 'out4|turn-1',
  sessionId: 'out4',
  sessionName: 'Out4',
  headline: 'Out4 looks stuck: same test failing 6 times',
  summary: 'Same test failing 6 times in 18 min: api.test.ts › retries',
  kind: 'repeated_failure',
  kinds: ['repeated_failure'],
  findingId: 'out4|repeated_failure|abc',
  count: 6,
  ...over,
});

const finding = (over: Partial<StuckFinding> = {}): StuckFinding => ({
  id: 'out4|repeated_failure|abc',
  sessionId: 'out4',
  sessionName: 'Out4',
  kind: 'repeated_failure',
  severity: 'medium',
  signature: 'abc',
  summary: 'Same test failing 6 times in 18 min: api.test.ts › retries',
  headline: 'same test failing 6 times',
  evidence: ['$ npm test 2>&1 | tail -40', 'TOKEN=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'],
  firstSeen: 1000,
  lastSeen: 5000,
  count: 6,
  turnId: 'turn-1',
  ...over,
});

describe('stuck inbox items', () => {
  const working = [snap({ sessionId: 'out4', sessionName: 'Out4', status: 'working', lastTurnKey: 't1' })];

  it('one item per session, updated in place, survives working, removed when the list drops it', () => {
    const inbox = new InboxTracker();
    inbox.update(working, 1000);
    expect(inbox.setStuckAlerts([{ ...alert(), serverId: 'local' }], 1000)).toBe(true);
    const [item] = inbox.list();
    expect(item).toMatchObject({
      priority: 'finished',
      headline: 'Out4 looks stuck: same test failing 6 times',
      stuck: { kind: 'repeated_failure', count: 6, findingId: 'out4|repeated_failure|abc' },
    });
    inbox.update(working, 2000);
    expect(inbox.list()).toHaveLength(1);
    // Count grows: same id, same createdAt, still unheard.
    inbox.setStuckAlerts([{ ...alert({ headline: 'Out4 looks stuck: same test failing 7 times', count: 7 }), serverId: 'local' }], 3000);
    const [again] = inbox.list();
    expect(again.id).toBe(item.id);
    expect(again.createdAt).toBe(1000);
    expect(again.headline).toMatch(/7 times/);
    // Heard sticks while the item lives.
    inbox.markHeard([item.id]);
    inbox.setStuckAlerts([{ ...alert({ count: 8 }), serverId: 'local' }], 4000);
    expect(inbox.list()[0].heard).toBe(true);
    expect(inbox.setStuckAlerts([], 5000)).toBe(true);
    expect(inbox.list()).toHaveLength(0);
  });

  it('the fallback briefing reads it as it is', () => {
    const inbox = new InboxTracker();
    inbox.setStuckAlerts([{ ...alert(), serverId: 'local' }], 1);
    expect(briefSummary(inbox.list())).toBe('Out4 looks stuck: same test failing 6 times.');
  });
});

describe('Herald service: stuck alerts, brief me, interrupt', () => {
  let dir: string;
  const services: HeraldService[] = [];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-stuck-'));
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
    return { svc, events, src };
  }

  it('alerts sent before start are applied when the inbox is built', async () => {
    const { svc } = make(recorder());
    svc.syncStuckAlerts([alert()]);
    await svc.start();
    expect(svc.getState().inbox.filter((i) => i.stuck)).toHaveLength(1);
  });

  it('brief me includes "Out4 looks stuck: same test failing 6 times."', async () => {
    const p = recorder('Out4 looks stuck: the same test failed 6 times.');
    const { svc, events } = make(p);
    await svc.start();
    await svc.poll();
    svc.syncStuckAlerts([alert()]);
    expect(events.some((e) => e.kind === 'inbox' && e.inbox.some((i) => i.stuck))).toBe(true);
    svc.send('Brief me', { mode: 'voice', intent: 'brief' });
    await waitFor(() => !svc.getState().busy);
    const last = p.calls[0].messages[p.calls[0].messages.length - 1];
    const text = JSON.stringify(last);
    expect(text).toContain('[looks stuck] Out4 looks stuck: same test failing 6 times (Out4,');
    expect(svc.getState().inbox.find((i) => i.stuck)?.heard).toBe(true);
  });

  it('proposeInterrupt makes one echo-tier interrupt card (no double Ctrl+C)', async () => {
    const { svc } = make(recorder());
    await svc.start();
    const a = svc.proposeInterrupt({ sessionId: 'out4', sessionName: 'Out4' });
    expect(a.autoSendAt).toEqual(expect.any(Number));
    const b = svc.proposeInterrupt({ sessionId: 'out4', sessionName: 'Out4' });
    expect(b.actionId).toBe(a.actionId);
    const card = svc.getState().actions.find((x) => x.id === a.actionId)!;
    expect(card).toMatchObject({ kind: 'interrupt', tier: 'echo', readback: 'Interrupting Out4', status: 'pending' });
  });
});

describe('stuck_sessions / snooze_stuck brain tools', () => {
  const sessions = [
    snap({ sessionId: 'out4', sessionName: 'Out4', status: 'working' }),
    snap({ sessionId: 'docs', sessionName: 'Docs', status: 'working' }),
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
  const turn = () => ({ userText: 'is anything stuck?', sessionRefs: new Map(), proposals: [] });

  it('specs validate', () => {
    expect(TOOL_SPECS.find((t) => t.name === 'stuck_sessions')).toBeTruthy();
    expect(validateToolCall('stuck_sessions', '{}').ok).toBe(true);
    expect(validateToolCall('snooze_stuck', '{}').ok).toBe(false);
    expect(validateToolCall('snooze_stuck', '{"session":"out4","minutes":30}').ok).toBe(true);
  });

  it('lists what each session is stuck on, redacted, and refs the sessions', async () => {
    const calls: Array<string | undefined> = [];
    const stuck = { list: (id?: string) => (calls.push(id), [finding()]), snooze: () => 0 };
    const t = turn();
    const out = await executeTool('stuck_sessions', {}, env({ stuck }), t);
    expect(out.isError).toBe(false);
    const data = JSON.parse(out.content);
    expect(data.stuck).toEqual([
      {
        session: 'Out4',
        signals: [
          {
            what: 'Same test failing 6 times in 18 min: api.test.ts › retries',
            since: expect.any(String),
            evidence: ['$ npm test 2>&1 | tail -40', expect.stringContaining('[redacted]')],
          },
        ],
      },
    ]);
    expect(out.content).not.toContain('sk-ant-api03');
    expect(data.instruction).toMatch(/snooze_stuck/);
    expect(t.sessionRefs.has('local:out4')).toBe(true);
    // One session, by name.
    await executeTool('stuck_sessions', { session: 'out 4' }, env({ stuck }), turn());
    expect(calls).toEqual([undefined, 'out4']);
  });

  it('says plainly when nothing is stuck; refuses remote sessions; unavailable without a detector', async () => {
    const stuck = { list: () => [], snooze: () => 0 };
    const none = JSON.parse((await executeTool('stuck_sessions', { session: 'docs' }, env({ stuck }), turn())).content);
    expect(none.stuck).toEqual([]);
    expect(none.instruction).toMatch(/Docs does not look stuck/);
    const far = await executeTool('stuck_sessions', { session: 'far' }, env({ stuck }), turn());
    expect(far.isError).toBe(true);
    const off = await executeTool('stuck_sessions', {}, env(), turn());
    expect(off.content).toMatch(/not available/);
  });

  it('snoozes a session for the minutes asked (default 30)', async () => {
    const calls: unknown[] = [];
    const stuck = { list: () => [], snooze: (id: string, kind: unknown, m: number) => (calls.push([id, kind, m]), m ? 1 : 0) };
    const a = JSON.parse((await executeTool('snooze_stuck', { session: 'Out4' }, env({ stuck }), turn())).content);
    expect(a.instruction).toMatch(/leave Out4 alone for 30 minutes/);
    await executeTool('snooze_stuck', { session: 'Out4', minutes: 90 }, env({ stuck }), turn());
    expect(calls).toEqual([
      ['out4', undefined, 30],
      ['out4', undefined, 90],
    ]);
  });
});
