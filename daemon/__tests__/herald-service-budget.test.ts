import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HeraldService } from '../src/herald/service';
import { HeraldStore } from '../src/herald/store';
import type { ResolvedHeraldConfig } from '../src/herald/config';
import type { HeraldEvent } from '../src/herald/protocol';
import type { SessionSnapshot, SessionSource } from '../src/herald/session-source';
import { LlmChatRequest, LlmChatResult, LlmError, LlmProvider } from '../src/herald/llm/provider';
import { DEFAULT_PRICING } from '../src/herald/usage';
import { snap } from './herald-helpers';

type Step = { throws?: Error; text?: string; usage?: LlmChatResult['usage'] };

function scripted(steps: Step[], health?: () => Promise<void>) {
  const calls: LlmChatRequest[] = [];
  const p: LlmProvider & { calls: LlmChatRequest[] } = {
    name: 'fake',
    model: 'claude-haiku-4-5',
    calls,
    async chat(r) {
      calls.push(r);
      const s = steps.shift() || { text: 'ok' };
      if (s.throws) throw s.throws;
      r.onText(s.text || 'ok');
      return { text: s.text || 'ok', toolCalls: [], stopReason: 'end', usage: s.usage || {} };
    },
    ...(health ? { healthCheck: health } : {}),
  };
  return p;
}

function source(sessions: SessionSnapshot[]): SessionSource {
  return {
    serverId: 'local',
    listSessions: async () => sessions,
    getRecentTranscript: async () => ({ lastUserPrompt: null, assistantTurns: [] }),
    getLiveChoice: async () => null,
    sessionExists: async () => true,
    sendText: async () => true,
    sendChoice: async () => true,
  } as unknown as SessionSource;
}

const cfg = (over: Partial<ResolvedHeraldConfig> = {}): ResolvedHeraldConfig => ({
  featureEnabled: true,
  displayName: 'Herald',
  provider: 'anthropic',
  baseUrl: null,
  model: 'claude-haiku-4-5',
  echoDelayMs: 80,
  requestTimeoutMs: 5000,
  maxTokens: 700,
  stateDir: '/tmp/unused',
  apiKey: 'k',
  brainConfigured: true,
  promptCache: { ttl: '5m' },
  pricing: DEFAULT_PRICING,
  ...over,
});

async function waitFor(cond: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('Herald usage meter, budget and fallback brain', () => {
  let dir: string;
  let services: HeraldService[] = [];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-budget-'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const s of services) s.shutdown();
    services = [];
    fs.rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function make(provider: LlmProvider, sessions: SessionSnapshot[] = [], config = cfg(), now?: () => number) {
    const events: HeraldEvent[] = [];
    const svc = new HeraldService({
      config,
      provider,
      sources: [source(sessions)],
      store: new HeraldStore(dir, 10),
      broadcast: (e) => events.push(e),
      audit: () => {},
      pollIntervalMs: 60_000,
      toolbox: null,
      ...(now ? { now } : {}),
    });
    services.push(svc);
    return { svc, events };
  }
  const lastText = (svc: HeraldService) => svc.getState().messages.slice(-1)[0].text;
  async function turn(svc: HeraldService, text: string, opts: { intent?: string } = {}) {
    svc.send(text, opts);
    await waitFor(() => !svc.getState().busy);
  }

  it('records cached usage per request, passes the cache option, persists the meter', async () => {
    const p = scripted([
      { usage: { inputTokens: 400, outputTokens: 30, cacheCreationInputTokens: 5400 } },
      { usage: { inputTokens: 420, outputTokens: 25, cacheReadInputTokens: 5400 } },
    ]);
    const { svc, events } = make(p);
    await svc.start();
    await turn(svc, 'hello');
    await turn(svc, 'and again');
    expect(p.calls[0].cache).toEqual({ ttl: '5m' });
    const u = svc.getState().usage!;
    expect(u.today.turns).toBe(2);
    expect(u.month.cacheReadTokens).toBe(5400);
    expect(u.month.cacheWriteTokens).toBe(5400);
    expect(u.month.costUsd).toBeCloseTo((400 + 150 + 6750 + 420 + 125 + 540) / 1e6, 9);
    expect(events.filter((e) => e.kind === 'usage').length).toBeGreaterThanOrEqual(2);
    // Survives a restart.
    svc.shutdown();
    const again = make(scripted([]));
    await again.svc.start();
    expect(again.svc.getState().usage!.month.turns).toBe(2);
  });

  it('"how much have you cost me" is answered from the meter without the LLM', async () => {
    const p = scripted([{ usage: { inputTokens: 40_000 } }]);
    const { svc } = make(p, [], cfg({ monthlyBudgetUsd: 5 }));
    await svc.start();
    await turn(svc, 'hi');
    svc.send('How much have you cost me?');
    expect(p.calls).toHaveLength(1);
    expect(lastText(svc)).toBe(
      "Today I've cost about 4 cents, and about 4 cents this month over 1 turn. That's 1% of your 5 dollars monthly budget."
    );
  });

  it('80% warns once (message + usage notice), 100% switches to the fallback; raising the cap restores', async () => {
    const sessions = [snap({ sessionId: 'docs', status: 'working', currentActivity: 'Running the build' })];
    const p = scripted([
      { usage: { inputTokens: 85_000 } }, // $0.085 of $0.10
      { usage: { inputTokens: 10_000 } }, // $0.095: no second warning
      { usage: { inputTokens: 10_000 } }, // $0.105: over
    ]);
    const { svc, events } = make(p, sessions, cfg({ monthlyBudgetUsd: 0.1 }));
    await svc.start();
    await turn(svc, 'one');
    expect(events.filter((e) => e.kind === 'usage' && e.notice === 'budget_warning')).toHaveLength(1);
    expect(lastText(svc)).toMatch(/^Heads up: I've used 85% of this month's about 10 cents budget/);
    await turn(svc, 'two');
    expect(events.filter((e) => e.kind === 'usage' && e.notice)).toHaveLength(1);
    await turn(svc, 'three');
    expect(events.filter((e) => e.kind === 'usage' && e.notice === 'budget_exceeded')).toHaveLength(1);
    expect(lastText(svc)).toMatch(/budget used up\. Until .+, or until you raise the cap in my menu/);
    expect(svc.getState().brain).toMatchObject({ state: 'degraded', reason: 'budget' });
    // Over budget: no LLM call, deterministic status answer.
    await turn(svc, "what's the status?");
    expect(p.calls).toHaveLength(3);
    expect(lastText(svc)).toBe('1 session. docs is working: Running the build.');
    // Raise the cap: back to the LLM.
    svc.setBudget(1);
    expect(svc.getState().brain).toEqual({ state: 'ok' });
    await turn(svc, 'four');
    expect(p.calls).toHaveLength(4);
  });

  it.each([
    ['credit', new LlmError('credit', 'x', 402), 'out of API credit'],
    ['auth', new LlmError('auth', 'x', 401), 'the API key was rejected'],
    ['rate_limited', new LlmError('rate_limited', 'x', 429), 'the API is rate limiting me'],
    ['server', new LlmError('server', 'x', 500), 'the API is having problems'],
    ['overloaded', new LlmError('overloaded', 'x', 529), 'the API is having problems'],
    ['unreachable', new LlmError('unreachable', 'x'), "I can't reach the API"],
    ['timeout', new LlmError('timeout', 'x'), 'the API is not answering'],
  ])('%s: one clear outage message, then short answers without retrying until the backoff', async (_n, err, why) => {
    const sessions = [snap({ sessionId: 'companion', status: 'waiting', pendingQuestion: 'Ship it?' })];
    const p = scripted([{ throws: err }]);
    const { svc, events } = make(p, sessions);
    await svc.start();
    await turn(svc, 'tell docs to rebase');
    expect(lastText(svc)).toBe(`My brain's offline right now (${why}) — here's what's waiting: companion asked: Ship it?`);
    expect(events.some((e) => e.kind === 'error')).toBe(false);
    await turn(svc, 'and the api session?');
    expect(lastText(svc)).toBe("Still offline — here's what's waiting: companion asked: Ship it?");
    expect(p.calls).toHaveLength(1); // inside the backoff: no API call
    expect(svc.getState().brain?.state).toBe('degraded');
  });

  it('brief while offline: inbox headlines, marked heard', async () => {
    let sessions = [snap({ sessionId: 'docs', status: 'working', lastTurnKey: 'k1' })];
    const src = { list: () => sessions };
    const p = scripted([{ throws: new LlmError('unreachable', 'x') }]);
    const events: HeraldEvent[] = [];
    const svc = new HeraldService({
      config: cfg(),
      provider: p,
      sources: [{ ...source([]), listSessions: async () => src.list() } as SessionSource],
      store: new HeraldStore(dir, 10),
      broadcast: (e) => events.push(e),
      audit: () => {},
      pollIntervalMs: 60_000,
      toolbox: null,
    });
    services.push(svc);
    await svc.start();
    await svc.poll();
    sessions = [snap({ sessionId: 'docs', status: 'idle', lastTurnKey: 'k2', lastTurnGist: 'Published the site.' })];
    await svc.poll();
    await turn(svc, 'Anything for me?');
    expect(lastText(svc)).toBe(
      "My brain's offline right now (I can't reach the API), so here's the short version. docs finished: Published the site."
    );
    expect(svc.getState().inbox.every((i) => i.heard)).toBe(true);
  });

  it('recovers automatically through the health check', async () => {
    let healthy = false;
    const health = jest.fn(async () => {
      if (!healthy) throw new LlmError('unreachable', 'still down');
    });
    let now = 1_000_000;
    const p = scripted([{ throws: new LlmError('unreachable', 'x') }], health);
    const { svc, events } = make(p, [], cfg(), () => now);
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      await svc.start();
      svc.send('hi');
      for (let i = 0; i < 50 && svc.getState().busy; i++) await Promise.resolve();
      await jest.advanceTimersByTimeAsync(50);
      expect(svc.getState().brain?.state).toBe('degraded');
      now += 11_000;
      await jest.advanceTimersByTimeAsync(11_000);
      expect(health).toHaveBeenCalledTimes(1);
      expect(svc.getState().brain?.state).toBe('degraded');
      healthy = true;
      now += 21_000;
      await jest.advanceTimersByTimeAsync(21_000);
      expect(health).toHaveBeenCalledTimes(2);
      expect(svc.getState().brain).toEqual({ state: 'ok' });
      expect(events.filter((e) => e.kind === 'brain').map((e) => (e as { brain: { state: string } }).brain.state)).toContain('ok');
    } finally {
      jest.useRealTimers();
    }
  });
});
