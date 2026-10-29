/** Spawning under an account profile: env, env file launch line, defaults unchanged. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createAgentSession, resolveSpawnProfile } from '../../session-spawn';
import { withEnvFile } from '../../tmux-manager';
import { ProfileRegistry } from '../registry';
import { LOGIN_COMMANDS, loginSessionName } from '../../handlers/profiles';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-spawn-'));
  const cfgDir = path.join(root, 'cfg');
  fs.mkdirSync(path.join(cfgDir, 'profiles'), { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'profiles', 'work.env'), 'ANTHROPIC_API_KEY=sk-x\n', {
    mode: 0o600,
  });
  const profiles = new ProfileRegistry({
    codeHome: path.join(root, '.claude'),
    configPath: null,
    configDir: cfgDir,
    profilesRaw: [
      { id: 'work', label: 'Work', agent: 'claude', home: path.join(root, 'cw'), env: { A: '1' } },
      { id: 'cdx2', agent: 'codex', home: path.join(root, 'c2') },
    ],
    log: () => {},
  });
  const createSession = jest.fn(async (..._a: unknown[]) => ({ success: true }));
  const deps = {
    tmux: {
      createSession,
      generateSessionName: () => 's',
      capturePane: async () => 'Welcome to Codex\n› ',
    } as never,
    storeTmuxSessionConfig: jest.fn(),
    sessionNameStore: { get: () => undefined, set: () => {} },
    watcher: {
      markSessionAsNew: jest.fn(),
      refreshTmuxPaths: async () => {},
      noteSessionAgent: jest.fn(),
      noteSessionProfile: jest.fn(),
      profiles,
    },
    log: () => {},
  };
  return { root, profiles, deps, createSession };
}
const sleep = async () => {};

describe('resolveSpawnProfile', () => {
  const { profiles } = setup();
  it('absent profile = the agent default', () => {
    expect(resolveSpawnProfile(profiles, undefined, undefined)).toEqual({ agent: 'claude' });
    expect(resolveSpawnProfile(profiles, 'codex', '')).toEqual({ agent: 'codex' });
  });
  it('the profile decides the agent; a disagreeing agent or unknown id is refused', () => {
    const r = resolveSpawnProfile(profiles, undefined, 'cdx2');
    expect('agent' in r && r.agent).toBe('codex');
    expect(resolveSpawnProfile(profiles, 'claude', 'cdx2')).toEqual({
      error: 'Profile cdx2 is a codex profile, not claude',
    });
    expect(resolveSpawnProfile(profiles, undefined, 'nope')).toEqual({
      error: 'Unknown profile: nope',
    });
    expect(resolveSpawnProfile(profiles, 'gpt', undefined)).toEqual({
      error: 'Unknown agent: gpt',
    });
  });
});

describe('createAgentSession with profiles', () => {
  it('default Claude: no env, no env file (exactly the old launch)', async () => {
    const { root, deps, createSession } = setup();
    const r = await createAgentSession(deps, { workingDir: root }, { sleep });
    expect(r.success).toBe(true);
    expect(createSession.mock.calls[0][3]).toEqual({ permissionMode: 'bypassPermissions' });
    expect(deps.watcher.noteSessionProfile).not.toHaveBeenCalled();
  });

  it('default Codex: CODEX_HOME as before', async () => {
    const { root, deps, createSession } = setup();
    await createAgentSession(deps, { workingDir: root, agent: 'codex' }, { sleep });
    expect(createSession.mock.calls[0][3]).toEqual({
      permissionMode: 'bypassPermissions',
      agent: 'codex',
      env: { CODEX_HOME: path.join(root, '.codex') },
    });
  });

  it('a Claude profile: CLAUDE_CONFIG_DIR + env in tmux, the env file only by path', async () => {
    const { root, deps, createSession, profiles } = setup();
    await createAgentSession(deps, { workingDir: root, profile: profiles.get('work') }, { sleep });
    const opts = createSession.mock.calls[0][3] as Record<string, unknown>;
    expect(opts).toEqual({
      permissionMode: 'bypassPermissions',
      env: { A: '1', CLAUDE_CONFIG_DIR: path.join(root, 'cw') },
      envFile: path.join(root, 'cfg', 'profiles', 'work.env'),
    });
    expect(JSON.stringify(opts)).not.toContain('sk-x');
    expect(deps.storeTmuxSessionConfig).toHaveBeenCalledWith('s', root, true, {
      permissionMode: 'bypassPermissions',
      profileId: 'work',
    });
    expect(deps.watcher.noteSessionProfile).toHaveBeenCalledWith('s', 'work');
  });

  it('a Codex profile: its own CODEX_HOME', async () => {
    const { root, deps, createSession, profiles } = setup();
    await createAgentSession(deps, { workingDir: root, profile: profiles.get('cdx2') }, { sleep });
    expect(createSession.mock.calls[0][3]).toEqual({
      permissionMode: 'bypassPermissions',
      agent: 'codex',
      env: { CODEX_HOME: path.join(root, 'c2') },
    });
  });
});

describe('withEnvFile', () => {
  it('leaves the command alone without a file', () => {
    expect(withEnvFile('claude')).toBe('claude');
  });
  it('sources the file in sh and execs the agent (same in bash and fish)', () => {
    expect(
      withEnvFile('claude --permission-mode bypassPermissions', '/h/.companion/profiles/w.env')
    ).toBe(
      `sh -c 'set -a; . "$0"; set +a; exec "$@"' '/h/.companion/profiles/w.env' claude --permission-mode bypassPermissions`
    );
  });
  it('refuses a path that cannot be quoted', () => {
    expect(() => withEnvFile('claude', "/h/it's.env")).toThrow();
  });
});

describe('login session', () => {
  it('names and commands', () => {
    expect(loginSessionName('work')).toBe('login-work');
    expect(LOGIN_COMMANDS).toEqual({
      claude: 'claude auth login',
      codex: 'codex login --device-auth',
    });
  });
});
