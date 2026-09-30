import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cushArgv,
  cushCommandLine,
  CushTool,
  CushValidateContext,
  inspectServeDir,
  parseCushStatus,
  parseLaunchLog,
  runCushCommand,
  validateCushCommand,
  validateCushName,
} from '../src/herald/knowledge/cush';
import { classifyCushCommand } from '../src/herald/danger';
import { guardedExecFile, guardedInFlight, stripAnsi } from '../src/herald/knowledge/guarded-exec';
import { HeraldToolbox } from '../src/herald/knowledge/toolbox';
import { ActionManager } from '../src/herald/actions';
import { executeTool, validateToolCall, ToolEnv, TurnToolState } from '../src/herald/tools';
import type { HeraldAction } from '../src/herald/protocol';

const STATUS_OUT = [
  '\u001b[1m=== frp Server ===\u001b[0m',
  'Status: \u001b[0;32mRUNNING\u001b[0m (PID: 1696)',
  'Dashboard: http://127.0.0.1:7500',
  '',
  '\u001b[1m=== Active Tunnels ===\u001b[0m',
  '  \u001b[1mNAME                 TYPE           URL                                         UPTIME     EXPIRES\u001b[0m',
  '  companion-web        serve (bg)     https://companion-web.tunnel.cush.rocks     5m         55m left',
  '  \u001b[2mlog: /x/logs/companion-web.log\u001b[0m',
  '  old-share            tunnel         https://old-share.tunnel.cush.rocks         1h 2m      \u001b[0;33m8m left\u001b[0m',
  '  rogue                \u001b[2munmanaged\u001b[0m      https://rogue.tunnel.cush.rocks             unknown    \u001b[2m--\u001b[0m',
  '',
  '3 active tunnel(s)',
].join('\n');

describe('cush status parsing', () => {
  it('parses tools, types, expiry and unmanaged entries after stripping ANSI', () => {
    const st = parseCushStatus(stripAnsi(STATUS_OUT));
    expect(st.server).toBe('running');
    expect(st.tools.map((t) => t.name)).toEqual(['companion-web', 'old-share', 'rogue']);
    expect(st.tools[0]).toMatchObject({
      type: 'serve',
      background: true,
      uptime: '5m',
      expires: '55m left',
      managed: true,
    });
    expect(st.tools[1]).toMatchObject({ type: 'tunnel', uptime: '1h 2m', expires: '8m left' });
    expect(st.tools[2]).toMatchObject({ managed: false, expires: null, uptime: 'unknown' });
  });

  it('handles no tunnels', () => {
    const st = parseCushStatus(
      '=== frp Server ===\nStatus: STOPPED\n\n=== Active Tunnels ===\n  (none)\n'
    );
    expect(st).toEqual({ server: 'stopped', tools: [] });
  });
});

describe('cush command validation', () => {
  let root: string;
  let home: string;
  let ctx: CushValidateContext;
  const active: CushTool[] = [
    {
      name: 'mine',
      type: 'serve',
      url: 'https://mine.tunnel.cush.rocks',
      uptime: '5m',
      expires: '55m left',
      background: true,
      managed: true,
    },
    {
      name: 'theirs',
      type: 'tunnel',
      url: 'https://theirs.tunnel.cush.rocks',
      uptime: '5m',
      expires: '55m left',
      background: true,
      managed: true,
    },
  ];

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herald-cush-')));
    home = path.join(root, 'home');
    for (const d of [
      '.ssh',
      '.config/app',
      '.claude',
      '.companion',
      'proj/dist/assets',
      'proj/secretdir',
      'cush-tools/bin',
      'cush-tools/logs',
    ])
      fs.mkdirSync(path.join(home, d), { recursive: true });
    fs.writeFileSync(path.join(home, 'proj/dist/index.html'), '<html></html>');
    fs.writeFileSync(path.join(home, 'proj/dist/assets/app.js'), 'x');
    fs.writeFileSync(path.join(home, 'proj/secretdir/.env'), 'A=1');
    fs.writeFileSync(path.join(home, '.ssh/id_ed25519'), 'nope');
    ctx = {
      userHome: home,
      cushToolsDir: path.join(home, 'cush-tools'),
      active,
      openedByHerald: new Set(['mine']),
      isListening: async (p) => p === 8096 || p === 9877,
      portInfo: async (p) => (p === 8096 ? 'Jellyfin (jellyfin.cush.rocks)' : null),
    };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it.each([
    'A',
    'a',
    'has space',
    'UPPER',
    'x'.repeat(33),
    '../etc',
    'a_b',
    'dot.name',
    '-lead',
    'trail-',
    '',
  ])('rejects bad name %p', (n) => {
    expect(validateCushName(n).ok).toBe(false);
  });

  it.each(['ab', 'phone-share', 'companion-web', 'a1-b2'])('accepts name %p', (n) => {
    expect(validateCushName(n).ok).toBe(true);
  });

  it.each([
    'secure-entry',
    'inject',
    'stash',
    'deploy',
    'expose',
    'publish-tarball',
    'issue-cert',
    'rm',
    'bash',
  ])('refuses forbidden tool %p in code', async (op) => {
    const r = await validateCushCommand({ operation: op, name: 'ab' }, ctx);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/can't run/);
  });

  it('serves a normal folder and states exactly what gets exposed', async () => {
    const r = await validateCushCommand(
      { operation: 'serve', name: 'web', dir: path.join(home, 'proj/dist') },
      ctx
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cmd.dir).toBe(path.join(home, 'proj/dist'));
    expect(r.facts.exposure).toMatch(/2 files/);
    expect(r.facts.exposure).toContain('https://web.tunnel.cush.rocks');
    expect(cushArgv(r.cmd)).toEqual({
      bin: 'serve',
      args: [path.join(home, 'proj/dist'), 'web', '--bg'],
    });
  });

  it.each([
    ['/', /whole filesystem/],
    ['HOME', /entire home/],
    ['PARENT', /entire home/],
    ['HOME/.ssh', /private configuration/],
    ['HOME/.config', /private configuration/],
    ['HOME/.config/app', /private configuration/],
    ['HOME/.claude', /private configuration/],
    ['HOME/.companion', /private configuration/],
    ['HOME/proj/secretdir', /secret or key file/],
    ['HOME/proj', /secret or key file/],
    ['HOME/cush-tools', /private configuration/],
    ['/etc', /private configuration/],
    ['HOME/nope', /does not exist/],
    ['relative/dir', /not a full path/],
  ])('refuses dangerous dir %s', async (d, why) => {
    const dir = d === 'HOME' ? home : d === 'PARENT' ? path.dirname(home) : d.replace('HOME', home);
    const r = await validateCushCommand({ operation: 'serve', name: 'web', dir }, ctx);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(why);
  });

  it('resolves symlinks: a link to ~/.ssh is refused, and so is a folder holding a link that escapes', async () => {
    fs.symlinkSync(path.join(home, '.ssh'), path.join(home, 'innocent'));
    const viaLink = await validateCushCommand(
      { operation: 'serve', name: 'web', dir: path.join(home, 'innocent') },
      ctx
    );
    expect(viaLink.ok).toBe(false);
    expect((viaLink as { error: string }).error).toMatch(/private configuration/);

    fs.symlinkSync(home, path.join(home, 'proj/dist/assets/escape'));
    const escape = await validateCushCommand(
      { operation: 'serve', name: 'web', dir: path.join(home, 'proj/dist') },
      ctx
    );
    expect(escape.ok).toBe(false);
    expect((escape as { error: string }).error).toMatch(/points outside the folder/);
  });

  it('refuses serve dirs with nested key files', async () => {
    fs.writeFileSync(path.join(home, 'proj/dist/assets/server.pem'), 'x');
    const r = await inspectServeDir(path.join(home, 'proj/dist'), {
      userHome: home,
      cushToolsDir: ctx.cushToolsDir,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/server\.pem/);
  });

  it('tunnel: port range, nothing listening, registry and Companion warnings', async () => {
    for (const port of [0, 65536, -1, 1.5, 'abc'])
      expect((await validateCushCommand({ operation: 'tunnel', name: 'tn', port }, ctx)).ok).toBe(
        false
      );
    const idle = await validateCushCommand({ operation: 'tunnel', name: 'tn', port: 5555 }, ctx);
    expect((idle as { error: string }).error).toMatch(/Nothing is listening/);
    const jf = await validateCushCommand({ operation: 'tunnel', name: 'tn', port: 8096 }, ctx);
    expect(jf.ok && jf.facts.warnings.join(' ')).toMatch(/Jellyfin/);
    const comp = await validateCushCommand({ operation: 'tunnel', name: 'tn', port: 9877 }, ctx);
    expect(comp.ok && comp.facts.warnings.join(' ')).toMatch(/Companion daemon itself/);
  });

  it('name collisions, unknown targets, and stray fields', async () => {
    expect((await validateCushCommand({ operation: 'drop', name: 'mine' }, ctx)).ok).toBe(false);
    expect((await validateCushCommand({ operation: 'close', name: 'ghost' }, ctx)).ok).toBe(false);
    expect(
      (await validateCushCommand({ operation: 'extend', name: 'mine', port: 80 }, ctx)).ok
    ).toBe(false);
    expect(
      (await validateCushCommand({ operation: 'drop', name: 'fresh', dir: '/tmp' }, ctx)).ok
    ).toBe(false);
    expect(
      (await validateCushCommand({ operation: 'close', name: 'mine' }, { ...ctx, active: null })).ok
    ).toBe(false);
  });
});

describe('cush tiers (deterministic table)', () => {
  it.each([
    [{ op: 'extend', name: 'x' }, 'echo'],
    [{ op: 'close', name: 'x', openedByHerald: true }, 'echo'],
    [{ op: 'close', name: 'x', openedByHerald: false }, 'hard_confirm'],
    [{ op: 'serve', name: 'x', exposure: 'makes every file in ~/p readable' }, 'hard_confirm'],
    [{ op: 'tunnel', name: 'x', port: 3000 }, 'hard_confirm'],
    [{ op: 'drop', name: 'x' }, 'hard_confirm'],
    [{ op: 'extend', name: 'x', requestedConfirm: true }, 'hard_confirm'],
    [{ op: 'nuke', name: 'x' }, 'hard_confirm'],
  ] as const)('%j -> %s', (input, tier) => {
    expect(classifyCushCommand(input as Parameters<typeof classifyCushCommand>[0]).tier).toBe(tier);
  });

  it('serve reasons state exactly what is exposed', () => {
    const r = classifyCushCommand({
      op: 'serve',
      name: 'x',
      exposure:
        'makes every file in ~/p (3 files) readable by anyone with the link https://x.tunnel.cush.rocks',
    });
    expect(r.reasons[0]).toContain('~/p (3 files)');
  });
});

describe('guardedExecFile', () => {
  it('kills a hung child with SIGKILL at the timeout', async () => {
    const t0 = Date.now();
    const r = await guardedExecFile('/bin/sleep', ['10'], { key: 'test:sleep', timeoutMs: 200 });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(guardedInFlight()).toBe(0);
  });

  it('dedupes concurrent calls with the same key into one child', async () => {
    const a = guardedExecFile('/bin/sh', ['-c', 'echo $$; sleep 0.2'], { key: 'test:dedupe' });
    const b = guardedExecFile('/bin/sh', ['-c', 'echo $$; sleep 0.2'], { key: 'test:dedupe' });
    expect(a).toBe(b);
    expect(guardedInFlight()).toBe(1);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.stdout).toBe(rb.stdout);
    expect(guardedInFlight()).toBe(0);
    const c = await guardedExecFile('/bin/sh', ['-c', 'echo $$'], { key: 'test:dedupe' });
    expect(c.stdout).not.toBe(ra.stdout);
  });

  it('bounds output and passes a minimal env without daemon secrets', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-' + 'shouldneverleak1234567890';
    try {
      const env = await guardedExecFile('/usr/bin/env', [], {
        key: 'test:env',
        home: '/home/realuser',
      });
      expect(env.ok).toBe(true);
      expect(env.stdout).not.toContain('ANTHROPIC_API_KEY');
      expect(env.stdout).toContain('HOME=/home/realuser');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
    const big = await guardedExecFile('/bin/sh', ['-c', 'yes | head -c 200000'], {
      key: 'test:big',
      maxOutputBytes: 1024,
    });
    expect(big.ok).toBe(false);
    expect(big.timedOut).toBe(false);
    expect(big.error).toMatch(/too much output/);
  });

  it('never runs through a shell (metacharacters are inert argv)', async () => {
    const r = await guardedExecFile('/bin/echo', ['$(id)', ';', 'rm', '-rf', '/'], {
      key: 'test:echo',
    });
    expect(r.stdout.trim()).toBe('$(id) ; rm -rf /');
  });
});

describe('launch verification', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-verify-'));
    fs.mkdirSync(path.join(dir, 'logs'));
    fs.writeFileSync(
      path.join(dir, 'logs', 'web.log'),
      'old run\nTunneling localhost:1111 -> web.tunnel.cush.rocks\n[web] start proxy success\n'
    );
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('parses the port and the frpc success line', () => {
    const p = parseLaunchLog(
      'Serving /x on http://localhost:4321\nTunneling localhost:4321 -> web.tunnel.cush.rocks\n\u001b[1;34m... [web] start proxy success\n',
      'web'
    );
    expect(p).toEqual({ port: 4321, proxyOk: true, proxyError: null });
    expect(parseLaunchLog('[web-2] start proxy success', 'web').proxyOk).toBe(false);
  });

  function fakeExec(appendLog: string) {
    return (async () => {
      fs.appendFileSync(path.join(dir, 'logs', 'web.log'), appendLog);
      return {
        ok: true,
        code: 0,
        timedOut: false,
        stdout: 'Serving /x -> https://web.tunnel.cush.rocks\n',
        stderr: '',
      };
    }) as unknown as typeof guardedExecFile;
  }

  it("says it's up only when the local port answers AND frpc connected (fresh log lines only)", async () => {
    const up = await runCushCommand(
      { op: 'serve', name: 'web', dir: '/x' },
      {
        cushToolsDir: dir,
        userHome: dir,
        exec: fakeExec(
          'Tunneling localhost:4321 -> web.tunnel.cush.rocks\n[web] start proxy success\n'
        ),
        httpCheck: async (port) => ({ ok: port === 4321, detail: 'answered HTTP 200' }),
      }
    );
    expect(up.verified).toBe(true);
    expect(up.localPort).toBe(4321);
    expect(up.message).toMatch(/It's up/);

    const noProxy = await runCushCommand(
      { op: 'serve', name: 'web', dir: '/x' },
      {
        cushToolsDir: dir,
        userHome: dir,
        exec: fakeExec('Tunneling localhost:4322 -> web.tunnel.cush.rocks\n'),
        httpCheck: async () => ({ ok: true, detail: 'answered HTTP 200' }),
        verifyWindowMs: 300,
        sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))),
      }
    );
    // The OLD run's "start proxy success" must not count for the new launch.
    expect(noProxy.verified).toBe(false);
    expect(noProxy.message).toMatch(/couldn't confirm/);
    expect(noProxy.message).toMatch(/frpc never reported/);
  });

  it('reports a failed command honestly', async () => {
    const r = await runCushCommand(
      { op: 'drop', name: 'web' },
      {
        cushToolsDir: dir,
        userHome: dir,
        exec: (async () => ({
          ok: false,
          code: 2,
          timedOut: false,
          stdout: '',
          stderr: 'Error: invalid name',
          error: 'exit 2',
        })) as unknown as typeof guardedExecFile,
      }
    );
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/didn't work/);
  });
});

describe('propose_cush_command end to end (no real execution)', () => {
  function setup(opened: string[] = []) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herald-e2e-')));
    const home = path.join(root, 'home');
    fs.mkdirSync(path.join(home, 'site/dist'), { recursive: true });
    fs.writeFileSync(path.join(home, 'site/dist/index.html'), 'hi');
    const ran: string[] = [];
    const toolbox = new HeraldToolbox({
      paths: {
        userHome: home,
        infraDoc: path.join(root, 'none.md'),
        cushToolsDir: path.join(home, 'cush-tools'),
        projectsRoot: home,
        memoryRoot: path.join(home, '.claude/projects'),
        userClaudeMd: path.join(home, '.claude/CLAUDE.md'),
      },
      status: async () => ({
        ok: true,
        server: 'running',
        tools: [
          {
            name: 'mine',
            type: 'serve',
            url: 'https://mine.tunnel.cush.rocks',
            uptime: '1m',
            expires: '59m left',
            background: true,
            managed: true,
          },
          {
            name: 'theirs',
            type: 'serve',
            url: 'https://theirs.tunnel.cush.rocks',
            uptime: '1m',
            expires: '59m left',
            background: true,
            managed: true,
          },
        ],
      }),
      run: async (cmd) => {
        ran.push(cushCommandLine(cmd));
        return { ok: true, message: `ran ${cmd.op}`, url: `https://${cmd.name}.tunnel.cush.rocks` };
      },
    });
    toolbox.loadOpened(opened);
    const sent: Array<{ a: HeraldAction; note?: string }> = [];
    const actions = new ActionManager({
      getSource: () => null,
      echoDelayMs: 30,
      onChange: () => undefined,
      onSent: (a, note) => sent.push({ a, note }),
      audit: () => undefined,
      runCush: (cmd) => toolbox.runCush(cmd),
    });
    const env = { toolbox, actions, echoDelayMs: 30, now: Date.now } as unknown as ToolEnv;
    const state: TurnToolState = { userText: '', sessionRefs: new Map(), proposals: [] };
    const call = async (args: Record<string, unknown>) => {
      const v = validateToolCall('propose_cush_command', JSON.stringify(args));
      if (!v.ok) return { isError: true, content: v.error };
      state.proposals = [];
      return executeTool('propose_cush_command', v.value, env, state);
    };
    return { root, home, toolbox, actions, call, ran, sent };
  }

  it('serve proposes a hard_confirm card with the command as payload; cancel runs nothing', async () => {
    const t = setup();
    try {
      const out = await t.call({
        operation: 'serve',
        name: 'site',
        dir: path.join(t.home, 'site/dist'),
      });
      expect(out.isError).toBe(false);
      const a = t.actions.list()[0];
      expect(a).toMatchObject({
        kind: 'cush_command',
        tier: 'hard_confirm',
        payload: `serve ${path.join(t.home, 'site/dist')} site --bg`,
      });
      expect(a.readback).toContain('https://site.tunnel.cush.rocks');
      expect(a.reasons.join(' ')).toMatch(
        /publishes files: makes every file in .*site\/dist \(1 file/
      );
      t.actions.cancel(a.id);
      await new Promise((r) => setTimeout(r, 80));
      expect(t.ran).toEqual([]);
      expect(t.actions.get(a.id)!.status).toBe('cancelled');
    } finally {
      t.actions.dispose();
      fs.rmSync(t.root, { recursive: true, force: true });
    }
  });

  it('closing a Herald-opened share echoes and runs; closing anything else hard-confirms', async () => {
    const t = setup(['mine']);
    try {
      await t.call({ operation: 'close', name: 'mine' });
      await t.call({ operation: 'close', name: 'theirs' });
      const [mine, theirs] = t.actions.list();
      expect(mine.tier).toBe('echo');
      expect(theirs.tier).toBe('hard_confirm');
      await new Promise((r) => setTimeout(r, 150));
      expect(t.ran).toEqual(['status close mine']);
      expect(t.sent[0].note).toBe('ran close');
      expect(t.toolbox.openedNames()).toEqual([]);
      expect(t.actions.get(theirs.id)!.status).toBe('pending');
    } finally {
      t.actions.dispose();
      fs.rmSync(t.root, { recursive: true, force: true });
    }
  });

  it('refuses forbidden operations without creating an action', async () => {
    const t = setup();
    try {
      const out = await t.call({ operation: 'secure-entry', name: 'anthropic' });
      expect(out.isError).toBe(true);
      expect(out.content).toMatch(/can't run/);
      expect(t.actions.list()).toHaveLength(0);
    } finally {
      t.actions.dispose();
      fs.rmSync(t.root, { recursive: true, force: true });
    }
  });
});
