import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HeraldService } from '../src/herald/service';
import { HeraldStore } from '../src/herald/store';
import type { ResolvedHeraldConfig } from '../src/herald/config';
import type { HeraldEvent } from '../src/herald/protocol';
import type { SessionSnapshot, SessionSource, TranscriptExchange } from '../src/herald/session-source';
import type { LlmProvider } from '../src/herald/llm/provider';
import { snap } from './herald-helpers';
import { executeTool, TOOL_SPECS, validateToolCall, type ToolEnv } from '../src/herald/tools';
import { ActionManager } from '../src/herald/actions';
import { InboxTracker } from '../src/herald/inbox';
import { sanitizeState } from '../src/herald/store';
import { briefSummary } from '../src/herald/fallback';

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

const quietBrain: LlmProvider = {
  name: 'fake',
  model: 'fake-1',
  async chat(r) {
    r.onText('ok');
    return { text: 'ok', toolCalls: [], stopReason: 'end', usage: {} } as never;
  },
} as LlmProvider;

export function world() {
  const state = {
    sessions: [snap({ sessionId: 'out4', sessionName: 'Out4', lastTurnKey: 'turn-0' })] as SessionSnapshot[],
    exchanges: [] as TranscriptExchange[],
    choice: null as unknown,
  };
  const src = {
    serverId: 'local',
    listSessions: jest.fn(async () => state.sessions),
    getRecentTranscript: jest.fn(async () => ({ lastUserPrompt: null, assistantTurns: [] })),
    getExchangesSince: jest.fn(async () => state.exchanges),
    getLiveChoice: jest.fn(async () => state.choice),
    sessionExists: jest.fn(async () => true),
    sendText: jest.fn(async () => true),
    sendChoice: jest.fn(async () => true),
  };
  return { state, src: src as typeof src & SessionSource };
}

describe('Herald relayAsk (Code Review "Ask why")', () => {
  let dir: string;
  const services: HeraldService[] = [];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-review-'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const s of services.splice(0)) s.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function make(src: SessionSource, provider: LlmProvider = quietBrain) {
    const events: HeraldEvent[] = [];
    const audit: unknown[] = [];
    const svc = new HeraldService({
      config: cfg(dir),
      provider,
      sources: [src],
      store: new HeraldStore(dir, 5),
      broadcast: (e) => events.push(e),
      audit: (e) => audit.push(e),
      pollIntervalMs: 60_000,
      toolbox: null,
    });
    services.push(svc);
    return { svc, events, audit };
  }

  it('sends the question, opens an ask, and the answer lands in the inbox', async () => {
    const { state, src } = world();
    const { svc, audit } = make(src);
    await svc.start();
    await svc.poll();
    const r = await svc.relayAsk({ sessionId: 'out4', sessionName: 'Out4', prompt: 'Why did you make this change? (from Companion review)', userText: 'why?', clientId: 'c1' });
    expect(r.askId).toMatch(/^review-/);
    expect(src.sendText).toHaveBeenCalledWith('out4', 'Why did you make this change? (from Companion review)', r.askId);
    expect(audit).toHaveLength(1);
    state.sessions = [snap({ sessionId: 'out4', sessionName: 'Out4', status: 'working', lastTurnKey: 'turn-0' })];
    await svc.poll();
    state.sessions = [snap({ sessionId: 'out4', sessionName: 'Out4', lastTurnKey: 'turn-1' })];
    state.exchanges = [
      { prompt: 'Why did you make this change? (from Companion review)', promptAt: Date.now(), reply: 'Because the old guard ignored echoes.', replyAt: Date.now() },
    ];
    await svc.poll();
    await waitFor(() => svc.getState().inbox.some((i) => i.answer));
    expect(svc.getState().inbox.find((i) => i.answer)!.headline).toMatch(/^Out4 answered your question/);
  });

  it('refuses when a choice prompt is on screen (nothing sent)', async () => {
    const { state, src } = world();
    state.choice = { question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }], signature: 'x' };
    const { svc } = make(src);
    await svc.start();
    await expect(svc.relayAsk({ sessionId: 'out4', sessionName: 'Out4', prompt: 'q', userText: 'q' })).rejects.toMatchObject({ code: 'session_waiting' });
    expect(src.sendText).not.toHaveBeenCalled();
  });
});

describe('review_changes brain tool', () => {
  const sessions = [snap({ sessionId: 'out4', sessionName: 'Out4' }), snap({ sessionId: 'far', sessionName: 'Far', serverId: 'mac' })];
  function env(over: Partial<ToolEnv> = {}): ToolEnv {
    return {
      listSessions: async () => sessions,
      getSource: () => null,
      actions: new ActionManager({ getSource: () => null, echoDelayMs: 20, onChange: () => {}, onSent: () => {}, audit: () => {} }),
      now: () => 1000,
      statusSince: () => null,
      echoDelayMs: 20,
      ...over,
    };
  }
  const turn = () => ({ userText: 'what did out4 change?', sessionRefs: new Map(), proposals: [] });

  it('has the exact static spec', () => {
    const spec = TOOL_SPECS.find((t) => t.name === 'review_changes')!;
    expect(spec.description).toBe(
      "What a session changed in code: its recent turns as one-line summaries, files with +/- line counts, risk flags (CI, migrations, secrets, deletions, config...) and how much the user has not reviewed yet. Use for 'what did Out4 change?', 'anything risky in X?', 'did X touch the deploy script?'. Report counts and at most three file names, risky ones first. Never mention changes that are not listed."
    );
    expect(spec.parameters).toMatchObject({ required: ['session'], properties: { scope: { type: 'string', enum: ['since_last_look', 'last_turn', 'all'] } } });
    expect(validateToolCall('review_changes', '{}').ok).toBe(false);
    expect(validateToolCall('review_changes', '{"session":"out4","scope":"all"}').ok).toBe(true);
  });

  it('returns the digest, redacted, for local sessions only', async () => {
    const calls: unknown[] = [];
    const e = env({
      review: {
        digest: async (id, scope) => {
          calls.push([id, scope]);
          return { session: 'Out4', files: [{ path: 'a.ts', plus: 1, minus: 0, status: 'modified', risks: ['adds sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 key'] }] };
        },
      },
    });
    const out = await executeTool('review_changes', { session: 'out 4' }, e, turn());
    expect(out.isError).toBe(false);
    expect(calls).toEqual([['out4', 'since_last_look']]);
    expect(out.content).not.toContain('sk-ant-api03');
    const far = await executeTool('review_changes', { session: 'far' }, e, turn());
    expect(far.isError).toBe(true);
    expect(far.content).toMatch(/only review code changes for sessions on this machine/);
    const bad = await executeTool('review_changes', { session: 'out4', scope: 'yesterday' }, e, turn());
    expect(bad.isError).toBe(true);
    const none = await executeTool('review_changes', { session: 'out4' }, env(), turn());
    expect(none.content).toMatch(/not available/);
  });
});

describe('review inbox items', () => {
  const s1 = (status: 'working' | 'idle', turnKey = 't1') => [snap({ sessionId: 'out4', sessionName: 'Out4', status, lastTurnKey: turnKey })];
  it('survive the session working again, resolve on review, persist across a store round trip', () => {
    const inbox = new InboxTracker();
    inbox.update(s1('idle'), 1000);
    const item = inbox.addReviewAlert({ key: 'k1', serverId: 'local', sessionId: 'out4', sessionName: 'Out4', headline: 'Out4 changed a CI workflow: deploy.yml', level: 'high', kinds: ['ci'], paths: ['.github/workflows/deploy.yml'], createdAt: 1000 });
    expect(item).toMatchObject({ priority: 'finished', review: { level: 'high', kinds: ['ci'] } });
    inbox.update(s1('working'), 2000);
    inbox.update(s1('idle', 't2'), 3000);
    expect(inbox.list().filter((i) => i.review)).toHaveLength(1);
    // Store round trip.
    const restored = sanitizeState({ version: 1, messages: [], heard: [], actions: [], reviews: inbox.reviewAlerts() }, 4000);
    expect(restored.reviews).toHaveLength(1);
    const again = new InboxTracker();
    again.restoreReviewAlerts(restored.reviews!, 4000);
    expect(again.list()[0].review).toEqual({ level: 'high', kinds: ['ci'], paths: ['.github/workflows/deploy.yml'] });
    expect(again.resolveReviewAlerts('local:out4')).toBe(true);
    expect(again.list()).toHaveLength(0);
  });

  it('fallback briefing gives review items a templated line', () => {
    const inbox = new InboxTracker();
    const item = inbox.addReviewAlert({ key: 'k', serverId: 'local', sessionId: 'out4', sessionName: 'Out4', headline: 'Out4 deleted 2 files including migrations/003_users.sql', level: 'high', kinds: ['deleted'], paths: [], createdAt: 1 });
    expect(briefSummary([item])).toBe('Heads up: Out4 deleted 2 files including migrations/003_users.sql.');
  });
});

describe('Herald addReviewAlert / polishGists through the service', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-review2-'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('alerts land in the inbox, are persisted, and resolve', async () => {
    const { src } = world();
    const events: HeraldEvent[] = [];
    const store = new HeraldStore(dir, 5);
    const svc = new HeraldService({ config: cfg(dir), provider: quietBrain, sources: [src], store, broadcast: (e) => events.push(e), audit: () => {}, pollIntervalMs: 60_000, toolbox: null });
    await svc.start();
    svc.addReviewAlert({ key: 'a', sessionId: 'out4', sessionName: 'Out4', headline: 'Out4 changed a CI workflow: deploy.yml', level: 'high', kinds: ['ci'], paths: ['deploy.yml'] });
    expect(svc.getState().inbox.find((i) => i.review)).toBeTruthy();
    await store.flush();
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    expect(persisted.reviews).toHaveLength(1);
    svc.resolveReviewAlerts('out4');
    expect(svc.getState().inbox.find((i) => i.review)).toBeUndefined();
    svc.shutdown();
  });

  it('polishGists makes one metered call and keeps only sane gists', async () => {
    const { src } = world();
    const calls: unknown[] = [];
    const provider = {
      name: 'fake',
      model: 'haiku',
      async chat(r: { messages: unknown[]; tools: unknown[] }) {
        calls.push(r);
        return { text: 'Here: [{"id":"t1","gist":"Fixed the echo guard."},{"id":"zz","gist":"nope"},{"id":"t2","gist":""}]', toolCalls: [], stopReason: 'end', usage: { inputTokens: 100, outputTokens: 20 } };
      },
    } as unknown as LlmProvider;
    const svc = new HeraldService({ config: cfg(dir), provider, sources: [src], store: new HeraldStore(dir, 5), broadcast: () => {}, audit: () => {}, pollIntervalMs: 60_000, toolbox: null });
    await svc.start();
    const before = svc.getUsage().today.requests;
    const out = await svc.polishGists([
      { id: 't1', prompt: 'fix it', reply: 'I fixed it', files: ['a.ts'], gist: 'Fixed it' },
      { id: 't2', prompt: 'x', reply: 'y', files: [], gist: 'X' },
    ]);
    expect(calls).toHaveLength(1);
    expect(Array.from(out.entries())).toEqual([['t1', 'Fixed the echo guard']]);
    expect(svc.getUsage().today.requests).toBe(before + 1);
    svc.shutdown();
  });
});
