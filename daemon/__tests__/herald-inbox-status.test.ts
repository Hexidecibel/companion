import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HeraldService } from '../src/herald/service';
import { HeraldStore } from '../src/herald/store';
import { InboxTracker } from '../src/herald/inbox';
import type { ResolvedHeraldConfig } from '../src/herald/config';
import type { SessionSnapshot, SessionSource } from '../src/herald/session-source';
import type { LlmChatRequest, LlmChatResult, LlmProvider } from '../src/herald/llm/provider';
import { snap } from './herald-helpers';

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

function recorder(): LlmProvider & { calls: LlmChatRequest[] } {
  const calls: LlmChatRequest[] = [];
  return {
    name: 'fake',
    model: 'fake',
    calls,
    async chat(r) {
      calls.push(r);
      r.onText('ok');
      return { text: 'ok', toolCalls: [], stopReason: 'end', usage: {} } as LlmChatResult;
    },
  };
}

function source(holder: { sessions: SessionSnapshot[] }): SessionSource {
  return {
    serverId: 'local',
    listSessions: async () => holder.sessions,
    getRecentTranscript: async () => ({ lastUserPrompt: null, assistantTurns: [] }),
    getLiveChoice: async () => null,
    sessionExists: async () => true,
    sendText: async () => true,
    sendChoice: async () => true,
  } as unknown as SessionSource;
}

async function waitFor(cond: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('inbox: finished vs current status', () => {
  let dir: string;
  let svc: HeraldService | null = null;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-inbox-'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    svc?.shutdown();
    svc = null;
    fs.rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('InboxTracker clears a finished item as soon as the session works again', () => {
    const t = new InboxTracker();
    t.update([snap({ sessionId: 'docs', status: 'working', lastTurnKey: 'k1' })], 1);
    t.update(
      [
        snap({
          sessionId: 'docs',
          status: 'idle',
          lastTurnKey: 'k2',
          lastTurnGist: 'Build passed.',
        }),
      ],
      2
    );
    expect(t.list().map((i) => i.priority)).toEqual(['finished']);
    t.update([snap({ sessionId: 'docs', status: 'working', lastTurnKey: 'k2' })], 3);
    expect(t.list()).toEqual([]);
  });

  async function turnSnapshot(
    holder: { sessions: SessionSnapshot[] },
    before: () => Promise<void>
  ) {
    const provider = recorder();
    svc = new HeraldService({
      config: cfg,
      provider,
      sources: [source(holder)],
      store: new HeraldStore(dir, 10),
      broadcast: () => undefined,
      audit: () => undefined,
      pollIntervalMs: 60_000,
      toolbox: null,
    });
    await svc.start();
    await before();
    svc.send('anything for me?');
    await waitFor(() => provider.calls.length === 1 && !svc!.getState().busy);
    const user = provider.calls[0].messages.filter((m) => m.role === 'user').pop()!;
    return (user as { text: string }).text;
  }

  it('a session that went back to working is never reported as finished, even before the next poll', async () => {
    const holder = {
      sessions: [
        snap({
          sessionId: 'docs',
          sessionName: 'Doc Upload Site',
          status: 'working',
          lastTurnKey: 'k1',
        }),
        snap({ sessionId: 'api', sessionName: 'API', status: 'working', lastTurnKey: 'a1' }),
      ],
    };
    const text = await turnSnapshot(holder, async () => {
      await svc!.poll();
      holder.sessions = [
        snap({
          sessionId: 'docs',
          sessionName: 'Doc Upload Site',
          status: 'idle',
          lastTurnKey: 'k2',
          lastTurnGist: 'Duplicate build is done.',
        }),
        snap({
          sessionId: 'api',
          sessionName: 'API',
          status: 'idle',
          lastTurnKey: 'a2',
          lastTurnGist: 'Shipped the fix.',
        }),
      ];
      await svc!.poll();
      expect(svc!.getState().inbox.filter((i) => i.priority === 'finished')).toHaveLength(2);
      // Docs starts its final test run; no poll happens before the user asks.
      holder.sessions = [
        snap({
          sessionId: 'docs',
          sessionName: 'Doc Upload Site',
          status: 'working',
          lastTurnKey: 'k2',
          currentActivity: 'Running the final test run',
        }),
        holder.sessions[1],
      ];
    });
    expect(text).toMatch(/- Doc Upload Site.*: working/);
    expect(text).not.toMatch(/\[finished\] Doc Upload Site/);
    expect(text).toMatch(/\[finished\] API finished: Shipped the fix\..*API is idle now/);
    expect(text).toMatch(/Inbox: 0 blocked, 1 finished earlier/);
    expect(svc!.getState().inbox.map((i) => i.sessionName)).toEqual(['API']);
  });

  it("each unheard item carries the session's current status", async () => {
    const holder = {
      sessions: [
        snap({ sessionId: 'api', sessionName: 'API', status: 'working', lastTurnKey: 'a1' }),
      ],
    };
    const text = await turnSnapshot(holder, async () => {
      await svc!.poll();
      holder.sessions = [
        snap({
          sessionId: 'api',
          sessionName: 'API',
          status: 'idle',
          lastTurnKey: 'a2',
          lastTurnGist: 'Done.',
        }),
      ];
      await svc!.poll();
      holder.sessions = [
        snap({
          sessionId: 'api',
          sessionName: 'API',
          status: 'waiting',
          lastTurnKey: 'a2',
          pendingQuestion: 'Ship it?',
        }),
      ];
    });
    expect(text).toMatch(/API is waiting now/);
  });
});
