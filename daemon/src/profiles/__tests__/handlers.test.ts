/** profiles_list / profile_login with a mocked context (no tmux, no real login). */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { registerProfileHandlers } from '../../handlers/profiles';
import { ProfileRegistry } from '../registry';

function setup(opts: { exists?: boolean; originCredential?: boolean } = {}) {
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
  const createSession = jest.fn(async (..._a: unknown[]) => ({ success: true }));
  const ctx: any = {
    watcher: {
      profiles,
      noteSessionAgent: jest.fn(),
      noteSessionProfile: jest.fn(),
      markSessionAsNew: jest.fn(),
      refreshTmuxPaths: async () => {},
    },
    tmux: { sessionExists: async () => !!opts.exists, createSession },
    sessionNameStore: { get: () => undefined, set: jest.fn() },
    send: (_ws: unknown, m: unknown) => sent.push(m),
    broadcast: jest.fn(),
    requireRemoteCapability: () => 'dispatch capability required',
  };
  const client: any = { ws: {}, ...(opts.originCredential ? { originCredential: {} } : {}) };
  return { root, ctx, client, sent, createSession, h: registerProfileHandlers(ctx) };
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

  it('profile_login starts the login in the profile env (Claude: CLAUDE_CONFIG_DIR)', async () => {
    const { h, client, sent, createSession, ctx, root } = setup();
    await h.profile_login(client, { profileId: 'work' }, 'r2');
    expect(createSession).toHaveBeenCalledWith('login-work', os.homedir(), true, {
      env: { CLAUDE_CONFIG_DIR: path.join(root, 'cw') },
      command: 'claude auth login',
    });
    expect(sent[0]).toMatchObject({
      success: true,
      payload: { sessionName: 'login-work', command: 'claude auth login' },
    });
    expect(ctx.watcher.noteSessionProfile).toHaveBeenCalledWith('login-work', 'work');
  });

  it('Codex: device auth in its CODEX_HOME', async () => {
    const { h, client, createSession, root } = setup();
    await h.profile_login(client, { profileId: 'c2' }, 'r3');
    expect(createSession).toHaveBeenCalledWith('login-c2', os.homedir(), true, {
      agent: 'codex',
      env: { CODEX_HOME: path.join(root, 'c2') },
      command: 'codex login --device-auth',
    });
  });

  it('an open login session is reported, not duplicated', async () => {
    const { h, client, sent, createSession } = setup({ exists: true });
    await h.profile_login(client, { profileId: 'work' }, 'r4');
    expect(createSession).not.toHaveBeenCalled();
    expect(sent[0].payload.alreadyRunning).toBe(true);
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
