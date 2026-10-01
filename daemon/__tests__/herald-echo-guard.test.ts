import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HeraldService, ECHO_GUARD_WINDOW_MS } from '../src/herald/service';
import { HeraldStore } from '../src/herald/store';
import type { ResolvedHeraldConfig } from '../src/herald/config';
import type { SessionSource } from '../src/herald/session-source';
import type { LlmChatResult, LlmProvider } from '../src/herald/llm/provider';
import { isLikelyEcho, isLikelyTextEcho } from '../src/herald/voice/echo-match';

const REPLY = 'Doc Upload Site shipped v2.28.0 to supdox.com. The deploy checks passed.';

function provider(texts: string[]): LlmProvider & { calls: number } {
  const p = {
    name: 'fake',
    model: 'fake-1',
    calls: 0,
    async chat(r: { onText: (t: string) => void }) {
      p.calls++;
      const t = texts.shift() || 'ok';
      r.onText(t);
      return { text: t, toolCalls: [], stopReason: 'end', usage: {} } as unknown as LlmChatResult;
    },
  };
  return p as unknown as LlmProvider & { calls: number };
}

const source = {
  serverId: 'local',
  listSessions: async () => [],
  getRecentTranscript: async () => null,
  getLiveChoice: async () => null,
  sessionExists: async () => true,
  sendText: async () => true,
  sendChoice: async () => true,
} as unknown as SessionSource;

const cfg: ResolvedHeraldConfig = {
  featureEnabled: true,
  displayName: 'Herald',
  provider: 'openai_compatible',
  baseUrl: 'http://x/v1',
  model: 'm',
  echoDelayMs: 80,
  requestTimeoutMs: 5000,
  maxTokens: 700,
  stateDir: '/tmp/unused',
  apiKey: null,
  brainConfigured: true,
};

async function waitFor(cond: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('echo-match (daemon copy)', () => {
  it('matches the real production echoes and not real interruptions', () => {
    expect(isLikelyEcho('Doc Upload Site, shift V2.', [REPLY])).toBe(true);
    expect(isLikelyEcho('Doc Upload', [REPLY])).toBe(true);
    expect(isLikelyEcho('stop', [REPLY])).toBe(false);
    expect(isLikelyEcho('wait tell Out4 to hold', [REPLY])).toBe(false);
  });
});

describe('HeraldService voice echo guard', () => {
  let dir: string;
  let svc: HeraldService | null = null;
  let now = 1_000_000;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-echo-'));
    now = 1_000_000;
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(async () => {
    svc?.shutdown();
    svc = null;
    await new Promise((r) => setTimeout(r, 50)); // let the last state write land
    fs.rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  async function withReply() {
    const p = provider([REPLY, 'Sure.', 'Okay.']);
    svc = new HeraldService({
      config: cfg,
      provider: p,
      sources: [source],
      store: new HeraldStore(dir, 10),
      broadcast: () => {},
      audit: () => {},
      pollIntervalMs: 60_000,
      now: () => now,
    });
    await svc.start();
    svc.send('anything shipped?', { mode: 'voice' });
    await waitFor(() => !svc!.getState().busy);
    return { svc, p };
  }

  it("drops a voice message that is Herald's own last reply, with a benign ack", async () => {
    const { svc, p } = await withReply();
    const before = svc.getState().messages.length;
    const res = svc.send('Doc Upload Site, shift V2.', { mode: 'voice' });
    expect(res).toEqual({ messageId: '', ignored: 'echo' });
    expect(svc.getState().messages).toHaveLength(before);
    expect(svc.getState().busy).toBe(false);
    expect(p.calls).toBe(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/likely self-echo/));
  });

  it('typed text, real interruptions, and one-word answers go through', async () => {
    const { svc } = await withReply();
    expect(svc.send('Doc Upload Site, shift V2.', { mode: 'text' }).ignored).toBeUndefined();
    await waitFor(() => !svc.getState().busy);
    expect(svc.send('wait tell Out4 to hold', { mode: 'voice' }).ignored).toBeUndefined();
    await waitFor(() => !svc.getState().busy);
    expect(svc.send('Okay', { mode: 'voice' }).ignored).toBeUndefined();
  });

  it('only recent replies count', async () => {
    const { svc } = await withReply();
    now += ECHO_GUARD_WINDOW_MS + 1;
    expect(svc.send('Doc Upload Site shipped v2', { mode: 'voice' }).ignored).toBeUndefined();
  });

  it('a gesture send (push-to-talk, hotkey) is never dropped as echo', async () => {
    const { svc } = await withReply();
    expect(svc.send('Doc Upload Site, shift V2.', { mode: 'voice', gesture: true }).ignored).toBeUndefined();
  });

  it('regression: "What is 2 plus 2?" right after a reply with "2 ... plus 2" goes through', async () => {
    const p = provider([EARLIER, 'Four.']);
    svc = new HeraldService({
      config: cfg,
      provider: p,
      sources: [source],
      store: new HeraldStore(dir, 10),
      broadcast: () => {},
      audit: () => {},
      pollIntervalMs: 60_000,
      now: () => now,
    });
    await svc.start();
    svc.send('anything for me?', { mode: 'voice' });
    await waitFor(() => !svc!.getState().busy);
    const res = svc.send('What is 2 plus 2?', { mode: 'voice' });
    expect(res.ignored).toBeUndefined();
    expect(res.messageId).not.toBe('');
  });
});

const EARLIER = 'You have 2 sessions waiting on you, plus 2 that finished. What next?';

describe('isLikelyTextEcho (daemon copy): the strict send guard', () => {
  it('the loose rule matched the real question; the strict one does not', () => {
    expect(isLikelyEcho('What is 2 plus 2?', [EARLIER], { minTokens: 2 })).toBe(true);
    expect(isLikelyTextEcho('What is 2 plus 2?', [EARLIER])).toBe(false);
  });
  it('still drops the earlier true echo', () => {
    expect(isLikelyTextEcho('Doc Upload Site, shift V2.', [REPLY])).toBe(true);
  });
});
