/** profiles_list / profile_login with a mocked context (no tmux, no real login). */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { registerProfileHandlers } from '../../handlers/profiles';
import { ProfileRegistry } from '../registry';

function setup(opts: { exists?: boolean; originCredential?: boolean; clients?: any[] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-handlers-'));
  const profiles = new ProfileRegistry({
    codeHome: path.join(root, '.claude'),
    configPath: null,
    configDir: path.join(root, 'cfg'),
    profilesRaw: [
      { id: 'work', label: 'Work', agent: 'claude', home: path.join(root, 'cw') },
      { id: 'c2', agent: 'codex', home: path.join(root, 'c2') },
    ],
    log: () => {},
  });
  const sent: any[] = [];
  const delivered: Array<{ type: string; ws: string }> = [];
  const createSession = jest.fn(async (..._a: unknown[]) => ({ success: true }));
  const ctx: any = {
    watcher: {
      profiles,
      noteSessionAgent: jest.fn(),
      noteSessionProfile: jest.fn(),
      markSessionAsNew: jest.fn(),
      refreshTmuxPaths: async () => {},
    },
    tmux: {
      sessionExists: async () => !!opts.exists,
      createSession,
      capturePaneJoined: async () => ({ text: '', gone: false }),
      sendSecretLine: async () => true,
      sessionEnvValue: async () => null,
      listAllSessionNames: async () => [],
      killSessionNow: async () => true,
    },
    clients: new Map((opts.clients ?? []).map((c, i) => [String(i), c])),
    auditLog: { append: jest.fn() },
    sessionNameStore: { get: () => undefined, set: jest.fn() },
    send: (ws: { n?: string }, m: { type: string }) => {
      if (ws?.n) delivered.push({ type: m.type, ws: ws.n });
      else sent.push(m);
    },
    broadcast: jest.fn(),
    requireRemoteCapability: () => 'dispatch capability required',
  };
  const client: any = { ws: {}, ...(opts.originCredential ? { originCredential: {} } : {}) };
  return { root, ctx, client, sent, delivered, createSession, h: registerProfileHandlers(ctx) };
}

describe('profile handlers', () => {
  it('profiles_list returns every profile without secrets', async () => {
    const { h, client, sent } = setup();
    await h.profiles_list(client, {}, 'r1');
    expect(sent[0].success).toBe(true);
    expect(sent[0].payload.profiles.map((p: { id: string }) => p.id)).toEqual([
      'claude',
      'codex',
      'work',
      'c2',
    ]);
  });

  it('profile_login starts a hidden login in the profile env (Claude: CLAUDE_CONFIG_DIR)', async () => {
    const { h, client, sent, createSession, ctx, root } = setup();
    await h.profile_login(client, { profileId: 'work' }, 'r2');
    const [name, cwd, start, opts] = createSession.mock.calls[0] as [
      string,
      string,
      boolean,
      { env: Record<string, string>; command: string; managed: boolean },
    ];
    expect([name, cwd, start]).toEqual(['login-work', os.homedir(), true]);
    expect(opts.managed).toBe(false);
    expect(opts.env.CLAUDE_CONFIG_DIR).toBe(path.join(root, 'cw'));
    expect(opts.env.COMPANION_LOGIN_FLOW).toBeTruthy();
    expect(opts.command).toContain('claude auth login');
    expect(sent[0]).toMatchObject({
      success: true,
      payload: {
        sessionName: 'login-work',
        command: 'claude auth login',
        flow: { profileId: 'work', state: 'starting' },
      },
    });
    // Not a coding session: nothing registered for the watcher or session names.
    expect(ctx.watcher.noteSessionAgent).not.toHaveBeenCalled();
    expect(ctx.watcher.markSessionAsNew).not.toHaveBeenCalled();
    expect(ctx.sessionNameStore.set).not.toHaveBeenCalled();
    expect(ctx.broadcast).not.toHaveBeenCalledWith('tmux_sessions_changed', expect.anything());
    await h.profile_login_cancel(client, { profileId: 'work' }, 'c');
  });

  it('Codex: device auth in its CODEX_HOME', async () => {
    const { h, client, createSession, root } = setup();
    await h.profile_login(client, { profileId: 'c2' }, 'r3');
    const opts = createSession.mock.calls[0][3] as {
      env: Record<string, string>;
      command: string;
    };
    expect(opts.env.CODEX_HOME).toBe(path.join(root, 'c2'));
    expect(opts.command).toContain('codex login --device-auth');
    await h.profile_login_cancel(client, { profileId: 'c2' }, 'c');
  });

  it("a user's own session with the same name is left alone", async () => {
    const { h, client, sent, createSession } = setup({ exists: true });
    await h.profile_login(client, { profileId: 'work' }, 'r4');
    expect(createSession.mock.calls[0][0]).toMatch(/^login-work-[0-9a-f]{4}$/);
    expect(sent[0].payload.flow.sessionName).toMatch(/^login-work-/);
    await h.profile_login_cancel(client, { profileId: 'work' }, 'c');
  });

  it('a second tap attaches to the running login', async () => {
    const { h, client, sent, createSession } = setup();
    await h.profile_login(client, { profileId: 'work' }, 'a');
    await h.profile_login(client, { profileId: 'work' }, 'b');
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(sent[1].payload.alreadyRunning).toBe(true);
    await h.profile_login_cancel(client, { profileId: 'work' }, 'c');
  });

  it('every login request is gated for a narrowed credential', async () => {
    const { h, client, sent } = setup({ originCredential: true });
    for (const t of ['profile_login_code', 'profile_login_cancel', 'profile_login_status']) {
      await h[t](client, { profileId: 'work', code: 'x' }, t);
      expect(sent.pop()).toMatchObject({ success: false, error: 'dispatch capability required' });
    }
    const d = setup();
    const dev = { ws: {}, deviceCapabilities: { dispatch: false } } as any;
    await d.h.profile_login(dev, { profileId: 'work' }, 'x');
    expect(d.sent[0]).toMatchObject({ success: false, error: 'capability_disabled' });
  });

  it('the update event reaches only clients allowed to dispatch', async () => {
    const full = { ws: { n: 'full' }, authenticated: true, subscribed: true };
    const narrow = {
      ws: { n: 'narrow' },
      authenticated: true,
      subscribed: true,
      originCredential: {},
    };
    const device = {
      ws: { n: 'device' },
      authenticated: true,
      subscribed: true,
      deviceCapabilities: { dispatch: false },
    };
    const trigger = {
      ws: { n: 'trigger' },
      authenticated: true,
      subscribed: true,
      scope: 'trigger',
    };
    const s = setup({ clients: [full, narrow, device, trigger] });
    await s.h.profile_login(full as any, { profileId: 'work' }, 'a');
    const got = s.delivered.filter((m) => m.type === 'profile_login_update').map((m) => m.ws);
    expect(new Set(got)).toEqual(new Set(['full']));
    await s.h.profile_login_cancel(full as any, { profileId: 'work' }, 'c');
  });

  it('unknown profile and narrowed credentials are refused', async () => {
    const a = setup();
    await a.h.profile_login(a.client, { profileId: 'nope' }, 'r5');
    expect(a.sent[0]).toMatchObject({ success: false, error: 'Unknown profile: nope' });
    const b = setup({ originCredential: true });
    await b.h.profile_login(b.client, { profileId: 'work' }, 'r6');
    expect(b.sent[0]).toMatchObject({ success: false, error: 'dispatch capability required' });
    expect(b.createSession).not.toHaveBeenCalled();
  });
});
