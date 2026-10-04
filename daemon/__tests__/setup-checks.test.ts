/**
 * Prerequisite checks with a mocked runner: missing binaries, timeouts, the
 * login check never reading credentials, and in-flight dedup.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CheckEnv, CheckRunner, RunResult, Runner, runChecks, execRunner } from '../src/setup/checks';
import type { PrereqCheck, PrereqId } from '../src/setup/protocol';

const ok = (stdout: string): RunResult => ({ ok: true, stdout, missing: false, timedOut: false, code: 0 });
const missing: RunResult = { ok: false, stdout: '', missing: true, timedOut: false, code: null };
const timedOut: RunResult = { ok: false, stdout: '', missing: false, timedOut: true, code: null };

function env(over: Partial<CheckEnv> = {}, table: Record<string, RunResult> = {}): CheckEnv & { calls: string[][] } {
  const calls: string[][] = [];
  const run: Runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return table[cmd] ?? missing;
  };
  return Object.assign(
    {
      run,
      platform: 'linux' as NodeJS.Platform,
      home: '/home/u',
      codeHome: '/home/u/.claude',
      nodeVersion: 'v20.20.0',
      voiceUrl: 'http://127.0.0.1:9889',
      daemonPorts: [9877],
      freeBytes: async () => 50 * 1024 ** 3,
      voiceHealthy: async () => false,
      portFree: async () => true,
      exists: () => false,
      supervisor: () => null,
      calls,
    },
    over
  );
}

const byId = (list: PrereqCheck[]) => Object.fromEntries(list.map((c) => [c.id, c])) as Record<PrereqId, PrereqCheck>;

describe('setup prerequisite checks', () => {
  it('a bare machine: tmux and claude fail with copyable fixes, optional ones warn', async () => {
    const r = byId(await runChecks(env()));
    expect(r.node.status).toBe('ok');
    expect(r.tmux).toMatchObject({ status: 'fail', detail: 'Not installed', command: 'sudo apt install -y tmux' });
    expect(r.git.status).toBe('warn');
    expect(r.claude_installed).toMatchObject({ status: 'fail', command: 'npm install -g @anthropic-ai/claude-code' });
    expect(r.claude_login.status).toBe('warn');
    expect(r.tailscale).toMatchObject({ status: 'warn', optional: true });
    expect(r.herald_voice).toMatchObject({ status: 'warn', optional: true });
    expect(r.service).toMatchObject({ status: 'warn', command: 'bin/companion autostart enable --no-start' });
    expect(r.disk.status).toBe('ok');
    expect(r.port.status).toBe('ok');
    for (const c of Object.values(r)) {
      if (c.status === 'ok') expect(c.fix).toBeUndefined();
      expect(c.detail.split('\n')).toHaveLength(1);
    }
  });

  it('macOS gets brew commands', async () => {
    const r = byId(await runChecks(env({ platform: 'darwin' })));
    expect(r.tmux.command).toBe('brew install tmux');
  });

  it('a ready machine is all ok, with versions', async () => {
    const e = env(
      { exists: (p) => p.endsWith('.credentials.json'), voiceHealthy: async () => true, supervisor: () => 'systemd' },
      {
        tmux: ok('tmux 3.4\n'),
        git: ok('git version 2.43.0\n'),
        claude: ok('2.1.3 (Claude Code)\n'),
        tailscale: ok(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'box.tail1234.ts.net.' } })),
      }
    );
    const r = byId(await runChecks(e));
    expect(Object.values(r).every((c) => c.status === 'ok')).toBe(true);
    expect(r.tmux.detail).toBe('tmux 3.4');
    expect(r.tailscale.detail).toContain('box.tail1234.ts.net');
  });

  it('a hung binary is a warning, not a crash', async () => {
    const r = byId(await runChecks(env({}, { tmux: timedOut, claude: timedOut })));
    expect(r.tmux).toMatchObject({ status: 'warn', detail: 'tmux did not answer in time' });
    expect(r.claude_installed.status).toBe('warn');
  });

  it('the login check only tests for the credential file, never reads or runs claude auth', async () => {
    const exists = jest.fn((p: string) => p === '/home/u/.claude/.credentials.json');
    const e = env({ exists }, { claude: ok('2.1.3') });
    const r = byId(await runChecks(e, ['claude_installed', 'claude_login']));
    expect(r.claude_login.status).toBe('ok');
    expect(exists).toHaveBeenCalledWith('/home/u/.claude/.credentials.json');
    expect(e.calls).toEqual([['claude', '--version']]);
  });

  it('macOS keychain presence query never asks for the secret (-w / -g)', async () => {
    const e = env({ platform: 'darwin' }, { claude: ok('2.1.3'), security: ok('keychain: ...') });
    const r = byId(await runChecks(e, ['claude_login']));
    expect(r.claude_login.detail).toContain('Keychain');
    const sec = e.calls.find((c) => c[0] === 'security')!;
    expect(sec).not.toContain('-w');
    expect(sec).not.toContain('-g');
  });

  it('only= limits the run', async () => {
    const e = env({}, { tmux: ok('tmux 3.4') });
    const r = await runChecks(e, ['tmux']);
    expect(r.map((c) => c.id)).toEqual(['tmux']);
    expect(e.calls).toEqual([['tmux', '-V']]);
  });

  it('old node and low disk are flagged', async () => {
    const r = byId(await runChecks(env({ nodeVersion: 'v16.0.0', freeBytes: async () => 100 * 1024 ** 2 })));
    expect(r.node.status).toBe('fail');
    expect(r.disk.status).toBe('fail');
  });

  it('CheckRunner shares one in-flight run between concurrent callers', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let runs = 0;
    const e = env();
    e.run = async () => {
      runs++;
      await gate;
      return missing;
    };
    const runner = new CheckRunner(() => e);
    const a = runner.run(['tmux']);
    const b = runner.run(['tmux']);
    expect(a).toBe(b);
    release();
    await Promise.all([a, b]);
    expect(runs).toBe(1);
    await runner.run(['tmux']);
    expect(runs).toBe(2);
  });

  it('execRunner: missing binary and timeout (real execFile, SIGKILL)', async () => {
    const m = await execRunner('definitely-not-a-binary-xyz', [], 1000);
    expect(m).toMatchObject({ ok: false, missing: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-exec-'));
    const t0 = Date.now();
    const t = await execRunner('sleep', ['5'], 200);
    expect(t).toMatchObject({ ok: false, timedOut: true });
    expect(Date.now() - t0).toBeLessThan(3000);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
