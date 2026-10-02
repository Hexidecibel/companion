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
