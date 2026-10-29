/**
 * remote_dispatch_spawn with an agent / profile (Codex dispatch). The Claude
 * default path is unchanged and not exercised here (it shells out to tmux).
 */
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execSync: jest.fn((cmd: string) => {
    if (cmd === 'which codex') return '/usr/local/bin/codex\n';
    throw new Error('not found');
  }),
}));

import * as os from 'os';
import { registerRemoteHandlers } from '../remote';
import type { HandlerContext } from '../../handler-context';

function makeCtx(screens: string[]) {
  const sent: Array<Record<string, unknown>> = [];
  const audit: unknown[] = [];
  const created: Array<{ name: string; opts: Record<string, unknown> }> = [];
  const inputs: Array<[string, string]> = [];
  let i = 0;
  const ctx = {
    config: { listeners: [], allowedPaths: [] },
    send: (_ws: unknown, msg: Record<string, unknown>) => sent.push(msg),
    auditLog: { append: (e: unknown) => audit.push(e) },
    rateLimiter: { check: () => null },
    requireRemoteCapability: () => null,
    storeTmuxSessionConfig: jest.fn(),
    sessionNameStore: { get: () => undefined, set: jest.fn() },
    broadcast: jest.fn(),
    tmux: {
      getHomeDir: () => os.homedir(),
      generateSessionName: () => 'proj',
      sessionExists: async () => false,
      createSession: async (name: string, _dir: string, _cli: boolean, opts = {}) => {
        created.push({ name, opts });
        return { success: true };
      },
      capturePane: async () => screens[0] || '',
      killSession: async () => ({ success: true }),
    },
    injector: {
      capturePaneContent: async () => screens[Math.min(i++, screens.length - 1)],
      sendInput: async (text: string, name: string) => {
        inputs.push([text, name]);
        return true;
      },
    },
    watcher: {
      profiles: {
        get: (id: string) =>
          id === 'work'
            ? { id: 'work', label: 'Work', agent: 'codex', home: '/h/work', isDefault: false }
            : undefined,
        defaultFor: (agent: string) => ({ id: agent, agent, home: '/h', isDefault: true }),
        launchPlan: async (p: { home: string }) => ({ env: { CODEX_HOME: p.home } }),
      },
      noteSessionAgent: jest.fn(),
      noteSessionProfile: jest.fn(),
      markSessionAsNew: jest.fn(),
      refreshTmuxPaths: async () => undefined,
      getCodexHome: () => '/h',
      getConversationIdsForSession: () => ['01a1859c-1206-7690-b142-5335c20e0f1d'],
      waitForSessionInCwd: async () => null,
      resolveSessionByTmuxName: () => null,
    },
  } as unknown as HandlerContext;
  return { ctx, sent, audit, created, inputs };
}

const client = { id: 'c1', ws: {}, isLocal: true } as never;
const READY =
  '› Ask Codex to do anything\n\n  GPT-6.1-Sol default · ~/proj\n  ← for agents · ? for shortcuts';

describe('remote_dispatch_spawn with agent / profileId', () => {
  it('refuses an unknown agent or profile', async () => {
    const { ctx, sent } = makeCtx([READY]);
    const h = registerRemoteHandlers(ctx);
    await h.remote_dispatch_spawn(client, { prompt: 'hi', cwd: os.homedir(), agent: 'gpt' }, 'r1');
    expect(sent[0]).toMatchObject({ success: false, error: 'invalid_payload' });
    await h.remote_dispatch_spawn(
      client,
      { prompt: 'hi', cwd: os.homedir(), profileId: 'nope' },
      'r2'
    );
    expect(sent[1]).toMatchObject({ success: false, error: 'invalid_payload' });
    await h.remote_dispatch_spawn(
      client,
      { prompt: 'hi', cwd: os.homedir(), agent: 'claude', profileId: 'work' },
      'r3'
    );
    expect(sent[2]).toMatchObject({ success: false, error: 'invalid_payload' });
  });

  it('spawns Codex interactively, waits for its composer, sends the prompt', async () => {
    const { ctx, sent, created, inputs } = makeCtx(['', READY]);
    const h = registerRemoteHandlers(ctx);
    await h.remote_dispatch_spawn(
      client,
      { prompt: 'fix it', cwd: os.homedir(), agent: 'codex' },
      'r'
    );
    expect(created[0].opts).toMatchObject({ agent: 'codex', env: { CODEX_HOME: '/h' } });
    expect(inputs).toEqual([['fix it', 'proj']]);
    expect(sent[0]).toMatchObject({
      success: true,
      payload: {
        tmuxSessionName: 'proj',
        agent: 'codex',
        claudePath: '/usr/local/bin/codex',
        sessionId: '01a1859c-1206-7690-b142-5335c20e0f1d',
      },
    });
  });

  it('a profile picks the agent; one-shot types codex exec and exits', async () => {
    const { ctx, sent, created, inputs } = makeCtx([READY]);
    const h = registerRemoteHandlers(ctx);
    await h.remote_dispatch_spawn(
      client,
      { prompt: "it's done?", cwd: os.homedir(), profileId: 'work', oneShot: true },
      'r'
    );
    expect(created[0].opts).toMatchObject({
      agent: 'codex',
      env: { CODEX_HOME: '/h/work' },
      command: `/usr/local/bin/codex exec 'it'\\''s done?'; exit`,
    });
    expect(inputs).toEqual([]);
    expect(sent[0]).toMatchObject({
      success: true,
      payload: { agent: 'codex', profileId: 'work' },
    });
  });

  it('a trust prompt is reported, never answered', async () => {
    const trust =
      'Do you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, quit\n\n  Press enter to continue';
    const { ctx, sent, inputs } = makeCtx([trust]);
    const h = registerRemoteHandlers(ctx);
    await h.remote_dispatch_spawn(client, { prompt: 'x', cwd: os.homedir(), agent: 'codex' }, 'r');
    expect(inputs).toEqual([]);
    expect(sent[0]).toMatchObject({ success: false, error: 'agent_not_ready' });
  });
});
