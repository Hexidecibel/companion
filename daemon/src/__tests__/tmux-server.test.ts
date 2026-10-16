/**
 * tmux in its own systemd scope (tmux-server.ts) and app spawns launching
 * `claude --permission-mode bypassPermissions` without touching the project's
 * .claude/settings.json (session-spawn.ts).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  newSessionCommand,
  scopeUsable,
  scopeUnitName,
  startTmuxSession,
  type TmuxServerEnv,
} from '../tmux-server';
import { claudeCommand } from '../tmux-manager';
import { createClaudeSession, SPAWN_PERMISSION_MODE } from '../session-spawn';

const linux = (over: Partial<TmuxServerEnv> = {}): TmuxServerEnv => ({
  platform: 'linux',
  env: { XDG_RUNTIME_DIR: '/run/user/1000', PATH: '/usr/bin' },
  inContainer: false,
  which: (b) => b === 'systemd-run',
  ...over,
});

describe('scopeUsable', () => {
  it('needs Linux, no container, a user manager and systemd-run', () => {
    expect(scopeUsable(linux())).toBe(true);
    expect(scopeUsable(linux({ platform: 'darwin' }))).toBe(false);
    expect(scopeUsable(linux({ inContainer: true }))).toBe(false);
    expect(scopeUsable(linux({ env: { PATH: '/usr/bin' } }))).toBe(false);
    expect(scopeUsable(linux({ which: () => false }))).toBe(false);
    expect(
      scopeUsable(linux({ env: { XDG_RUNTIME_DIR: '/run/user/1000', COMPANION_TMUX_SCOPE: '0' } }))
    ).toBe(false);
  });
});

describe('newSessionCommand', () => {
  const args = ['new-session', '-d', '-s', 'x', '-c', '/tmp'];
  it('wraps the first session of a new server in a systemd scope', () => {
    const c = newSessionCommand(args, false, linux(), 1_800_000_000_000);
    expect(c.scoped).toBe(true);
    expect(c.cmd).toBe('systemd-run');
    expect(c.args.slice(0, 4)).toEqual(['--user', '--scope', '--quiet', '--collect']);
    expect(c.args[4]).toMatch(/^--unit=companion-tmux-[A-Za-z0-9_-]+$/);
    expect(c.args.slice(c.args.indexOf('tmux'))).toEqual(['tmux', ...args]);
  });
  it('leaves a running server alone and falls back to plain tmux without systemd', () => {
    expect(newSessionCommand(args, true, linux())).toEqual({ cmd: 'tmux', args, scoped: false });
    expect(newSessionCommand(args, false, linux({ inContainer: true }))).toEqual({
      cmd: 'tmux',
      args,
      scoped: false,
    });
  });
  it('unit names are unique per start and valid', () => {
    expect(scopeUnitName(1, {})).not.toBe(scopeUnitName(2, {}));
    expect(scopeUnitName(1, { TMUX_TMPDIR: '/tmp/x' })).toMatch(/^companion-tmux-private-/);
  });
});

describe('startTmuxSession', () => {
  it('starts scoped when no server runs; never probes or scopes when it cannot', async () => {
    const run = jest.fn(async () => ({ ok: true, stderr: '' }));
    const serverRunning = jest.fn(async () => false);
    const r = await startTmuxSession('x', ['-d', '-s', 'x'], {
      env: linux(),
      run,
      serverRunning,
      log: () => {},
    });
    expect(r.scoped).toBe(true);
    expect((run.mock.calls[0] as unknown as string[])[0]).toBe('systemd-run');

    run.mockClear();
    serverRunning.mockClear();
    await startTmuxSession('x', ['-d', '-s', 'x'], {
      env: linux({ platform: 'darwin' }),
      run,
      serverRunning,
    });
    expect(serverRunning).not.toHaveBeenCalled();
    expect(run.mock.calls[0]).toEqual(['tmux', ['new-session', '-d', '-s', 'x']]);
  });

  it('falls back to plain tmux when systemd-run fails and no session was made', async () => {
    const run = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, stderr: 'Failed to connect to bus' })
      .mockResolvedValueOnce({ ok: true, stderr: '' });
    const r = await startTmuxSession('x', ['-d', '-s', 'x'], {
      env: linux(),
      run,
      serverRunning: async () => false,
      sessionExists: async () => false,
      log: () => {},
    });
    expect(r.scoped).toBe(false);
    expect(run.mock.calls[1]).toEqual(['tmux', ['new-session', '-d', '-s', 'x']]);
  });

  it('throws when tmux itself fails (duplicate session)', async () => {
    await expect(
      startTmuxSession('x', ['-d', '-s', 'x'], {
        env: linux(),
        run: async () => ({ ok: false, stderr: 'duplicate session: x' }),
        serverRunning: async () => true,
      })
    ).rejects.toThrow('duplicate session');
  });
});

describe('app spawns: permission mode flag, no settings.json writes', () => {
  it('claudeCommand', () => {
    expect(claudeCommand()).toBe('claude');
    expect(claudeCommand('bypassPermissions')).toBe('claude --permission-mode bypassPermissions');
  });

  it('createClaudeSession launches with the flag, stores it, and writes nothing into the project', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-flag-'));
    const existing = path.join(dir, '.claude');
    try {
      const createSession = jest.fn(async () => ({ success: true }));
      const store = jest.fn();
      const names = new Map<string, string>();
      const r = await createClaudeSession(
        {
          tmux: { createSession, generateSessionName: () => 'proj' } as never,
          storeTmuxSessionConfig: store,
          sessionNameStore: { get: (n) => names.get(n), set: (n, f) => void names.set(n, f) },
          watcher: { markSessionAsNew: () => {}, refreshTmuxPaths: async () => {} },
          log: () => {},
        },
        { workingDir: dir }
      );
      expect(r.success).toBe(true);
      expect(createSession).toHaveBeenCalledWith('proj', dir, true, {
        permissionMode: SPAWN_PERMISSION_MODE,
      });
      expect(store).toHaveBeenCalledWith('proj', dir, true, {
        permissionMode: 'bypassPermissions',
      });
      expect(fs.existsSync(existing)).toBe(false);

      // A settings file an older version wrote is left exactly as it was.
      fs.mkdirSync(existing);
      const old = JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } });
      fs.writeFileSync(path.join(existing, 'settings.json'), old);
      await createClaudeSession(
        {
          tmux: { createSession, generateSessionName: () => 'proj2' } as never,
          storeTmuxSessionConfig: store,
          sessionNameStore: { get: (n) => names.get(n), set: (n, f) => void names.set(n, f) },
          watcher: { markSessionAsNew: () => {}, refreshTmuxPaths: async () => {} },
          log: () => {},
        },
        { workingDir: dir, startCli: false }
      );
      expect(fs.readFileSync(path.join(existing, 'settings.json'), 'utf-8')).toBe(old);
      expect(createSession).toHaveBeenLastCalledWith('proj2', dir, false, {
        permissionMode: undefined,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
