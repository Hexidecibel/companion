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
import {
  InboxTracker,
  PAIRING_CODE_PLACEHOLDER,
  brainHeadline,
  pairingDecisionReply,
} from '../src/herald/inbox';
import { briefSummary } from '../src/herald/fallback';
import { latestShowRef } from '../src/herald/show';

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

function recorder(reply = 'Okay.'): LlmProvider & { calls: LlmChatRequest[] } {
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

function source(sessions: () => SessionSnapshot[]) {
  const src = {
    serverId: 'local',
    listSessions: jest.fn(async () => sessions()),
    getRecentTranscript: jest.fn(async () => ({ lastUserPrompt: null, assistantTurns: [] })),
    getExchangesSince: jest.fn(async () => []),
    getLiveChoice: jest.fn(async () => null),
    sessionExists: jest.fn(async () => true),
    sendText: jest.fn(async () => true),
    sendChoice: jest.fn(async () => true),
  };
  return src as typeof src & SessionSource;
}

const pair = (over: Partial<{ pairingId: string; deviceName: string; code: string; expiresAt: number }> = {}) => ({
  pairingId: 'p1',
  deviceName: "Chris's iPad",
  platform: 'ios',
  code: '123456',
  expiresAt: 10_000,
  ...over,
});

describe('"ended with an error" inbox items', () => {
  const working = snap({ sessionId: 'out4', sessionName: 'Out4', status: 'working', lastTurnKey: 't0' });
  const endedWithError = snap({
    sessionId: 'out4',
    sessionName: 'Out4',
    status: 'idle',
    lastTurnKey: 't1',
    lastTurnGist: 'The auth test still fails.',
    turnError: { tool: 'Bash', line: 'FAIL auth.test.ts' },
  });

  it('replaces the plain finished note for that turn, finished-toned, gone when work resumes', () => {
    const inbox = new InboxTracker();
    inbox.update([working], 1000);
    expect(inbox.update([endedWithError], 2000)).toBe(true);
    const items = inbox.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      priority: 'finished',
      headline: 'Out4 ended with an error: Bash: FAIL auth.test.ts',
      error: { tool: 'Bash', line: 'FAIL auth.test.ts' },
      heard: false,
    });
    inbox.update([{ ...working, lastTurnKey: 't1' }], 3000);
    expect(inbox.list()).toHaveLength(0);
  });

  it('a clean turn still gets the plain finished note', () => {
    const inbox = new InboxTracker();
    inbox.update([working], 1000);
    inbox.update([{ ...endedWithError, turnError: null, lastTurnGist: 'All done.' }], 2000);
    expect(inbox.list()[0]).toMatchObject({ headline: 'Out4 finished: All done.' });
    expect(inbox.list()[0].error).toBeUndefined();
  });

  it('brief me labels it "[ended with an error]" (and it is never spoken unasked: no message)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-err-'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    let sessions = [working];
    const p = recorder('Out4 ended with an error.');
    const events: HeraldEvent[] = [];
    const svc = new HeraldService({
      config: cfg(dir),
      provider: p,
      sources: [source(() => sessions)],
      store: new HeraldStore(dir, 5),
      broadcast: (e) => events.push(e),
      audit: () => {},
      pollIntervalMs: 60_000,
      toolbox: null,
    });
    try {
      await svc.start();
      await svc.poll();
      sessions = [endedWithError];
      await svc.poll();
      expect(svc.getState().inbox.find((i) => i.error)).toBeTruthy();
      // An inbox event only: no Herald message was posted on its own.
      expect(events.some((e) => e.kind === 'message_start' || e.kind === 'message_end')).toBe(false);
      svc.send('Brief me', { mode: 'voice', intent: 'brief' });
      await waitFor(() => !svc.getState().busy);
      const text = JSON.stringify(p.calls[0].messages[p.calls[0].messages.length - 1]);
      expect(text).toContain('[ended with an error] Out4 ended with an error: Bash: FAIL auth.test.ts (Out4,');
    } finally {
      svc.shutdown();
      fs.rmSync(dir, { recursive: true, force: true });
      jest.restoreAllMocks();
    }
  });
});

describe('"wants to pair" inbox items', () => {
  it('one blocked item per request with the code for the screen, cleared on approve/deny/expiry', () => {
    const inbox = new InboxTracker();
    expect(inbox.setPairingRequests([pair()], 1000)).toBe(true);
    const [item] = inbox.list();
    expect(item).toMatchObject({
      priority: 'blocked',
      headline: "Chris's iPad wants to pair, code 123456",
      pairing: { pairingId: 'p1', deviceName: "Chris's iPad", code: '123456', platform: 'ios' },
    });
    // Session polls never drop it (it is not a session).
    inbox.update([snap({ sessionId: 'out4' })], 1500);
    expect(inbox.list()).toHaveLength(1);
    // Approved / denied: the manager's list no longer has it.
    expect(inbox.setPairingRequests([], 2000)).toBe(true);
    expect(inbox.list()).toHaveLength(0);
    // Expired by time even if the list was not refreshed yet.
    inbox.setPairingRequests([pair({ expiresAt: 3000 })], 2500);
    inbox.setPairingRequests([pair({ expiresAt: 3000 })], 3001);
    expect(inbox.list()).toHaveLength(0);
  });

  it('the brain and the spoken fallback never get the code', () => {
    const inbox = new InboxTracker();
    inbox.setPairingRequests([pair()], 1000);
    const [item] = inbox.list();
    expect(brainHeadline(item)).not.toContain('123456');
    expect(brainHeadline(item)).toContain(PAIRING_CODE_PLACEHOLDER);
    expect(briefSummary([item])).not.toContain('123456');
    expect(latestShowRef({ actions: [], messages: [], inbox: [item] })).toBeNull();
  });

  it('approving by voice gets a fixed "approve on screen" reply', () => {
    const inbox = new InboxTracker();
    inbox.setPairingRequests([pair()], 1000);
    const waiting = inbox.list();
    expect(pairingDecisionReply("approve Chris's iPad", waiting)).toMatch(/approve or deny it on screen/);
    expect(pairingDecisionReply('yes allow the new device', waiting)).toMatch(/on screen/);
    expect(pairingDecisionReply('deny the pairing request', [])).toMatch(/No device is waiting/);
    expect(pairingDecisionReply('approve the edit in Out4', waiting)).toBeNull();
    expect(pairingDecisionReply('what is Out4 doing?', waiting)).toBeNull();
  });

  describe('service', () => {
    let dir: string;
    let svc: HeraldService;
    let p: ReturnType<typeof recorder>;
    let events: HeraldEvent[];
    beforeEach(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-pair-'));
      jest.spyOn(console, 'log').mockImplementation(() => {});
      p = recorder('Chris’s iPad wants to pair.');
      events = [];
      svc = new HeraldService({
        config: cfg(dir),
        provider: p,
        sources: [source(() => [snap({ sessionId: 'out4', sessionName: 'Out4' })])],
        store: new HeraldStore(dir, 5),
        broadcast: (e) => events.push(e),
        audit: () => {},
        pollIntervalMs: 60_000,
        toolbox: null,
        now: () => 1000,
      });
    });
    afterEach(() => {
      svc.shutdown();
      fs.rmSync(dir, { recursive: true, force: true });
      jest.restoreAllMocks();
    });

    it('requests before start are applied; updates emit an inbox event; no message is posted', async () => {
      svc.syncPairingRequests([pair()]);
      await svc.start();
      expect(svc.getState().inbox.filter((i) => i.pairing)).toHaveLength(1);
      svc.syncPairingRequests([]);
      expect(events.some((e) => e.kind === 'inbox' && !e.inbox.some((i) => i.pairing))).toBe(true);
      expect(svc.getState().messages).toHaveLength(0);
    });

    it('the brain context carries a placeholder, never the code', async () => {
      await svc.start();
      svc.syncPairingRequests([pair()]);
      svc.send('anything for me?', { mode: 'text' });
      await waitFor(() => !svc.getState().busy);
      const all = JSON.stringify(p.calls[0]);
      expect(all).toContain("Chris's iPad wants to pair");
      expect(all).toContain(PAIRING_CODE_PLACEHOLDER);
      expect(all).not.toContain('123456');
      p.calls.length = 0;
      svc.send('Brief me', { mode: 'voice', intent: 'brief' });
      await waitFor(() => !svc.getState().busy);
      const brief = JSON.stringify(p.calls[0]);
      expect(brief).toContain('[pairing request]');
      expect(brief).not.toContain('123456');
    });

    it('"approve the iPad" by voice: told to approve on screen, no brain turn', async () => {
      await svc.start();
      svc.syncPairingRequests([pair()]);
      svc.send('approve the iPad', { mode: 'voice' });
      const msgs = svc.getState().messages;
      expect(msgs[msgs.length - 1].text).toMatch(/can't approve pairing by voice.*on screen/);
      expect(p.calls).toHaveLength(0);
    });
  });
});
