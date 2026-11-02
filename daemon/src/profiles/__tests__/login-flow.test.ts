import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { withEnvFile } from '../../tmux-manager';
import {
  LOGIN_FLOW_TAG,
  LOGIN_TIMEOUT_MS,
  LoginFlowManager,
  loginLaunchLine,
  loginTestOverride,
} from '../login-flow';
import type { ProfileLoginFlow } from '../protocol';

const URL_SECRET = 'https://claude.com/cai/oauth/authorize?state=URLSECRET';
const CLAUDE_PANE = `Opening browser to sign in…\nvisit: ${URL_SECRET}\nPaste code here if prompted > \n`;
const CODEX_PANE =
  '1. Open this link\n   https://auth.openai.com/codex/device\n\n2. Enter this one-time code (expires in 15 minutes)\n   DEVC-CODE9\n';
const claude: any = { id: 'work', label: 'Work', agent: 'claude', home: '/h/w', isDefault: false };
const codex: any = { id: 'x2', label: 'X', agent: 'codex', home: '/h/x', isDefault: false };

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'login-flow-'));
  let t = 1_000_000;
  const emitted: ProfileLoginFlow[] = [];
  const audits: Array<{ action: string; info: unknown; ok: boolean }> = [];
  const logs: string[] = [];
  const hidden = new Set<string>();
  const sessions = new Map<string, Record<string, string>>();
  const typed: string[] = [];
  let pane: { text: string | null; gone: boolean } = { text: '', gone: false };
  const tmux = {
    captures: 0,
    holdCapture: null as Promise<void> | null,
    sessionExists: async (n: string) => sessions.has(n),
    createSession: jest.fn(async (n: string, _c: string, _s: boolean, o: any) => {
      sessions.set(n, o.env);
      return { success: true };
    }),
    capturePaneJoined: async () => {
      tmux.captures++;
      if (tmux.holdCapture) await tmux.holdCapture;
      return pane;
    },
    sendSecretLine: jest.fn(async (_n: string, c: string) => {
      typed.push(c);
      return true;
    }),
    sessionEnvValue: async (n: string, k: string) => sessions.get(n)?.[k] ?? null,
    listAllSessionNames: async () => [...sessions.keys()],
    killSessionNow: jest.fn(async (n: string) => {
      sessions.delete(n);
      return true;
    }),
  };
  const successes: string[] = [];
  const m = new LoginFlowManager({
    tmux,
    launchOpts: async () => ({}),
    emit: (f) => emitted.push(f),
    onSuccess: (p) => successes.push(p.id),
    audit: (action, info, ok) => audits.push({ action, info, ok }),
    hide: (n) => hidden.add(n),
    unhide: (n) => hidden.delete(n),
    log: (l) => logs.push(l),
    now: () => t,
    stateDir: root,
    owner: 'me',
    pollMs: 3_600_000,
    homeDir: root,
    override: () => ({}),
  });
  const exitFile = () => {
    const cmd = tmux.createSession.mock.calls[0][3].command as string;
    return /' '([^']+\.exit)'$/.exec(cmd)![1];
  };
  return {
    m,
    tmux,
    root,
    emitted,
    audits,
    logs,
    hidden,
    sessions,
    typed,
    successes,
    exitFile,
    advance: (ms: number) => (t += ms),
    setPane: (text: string | null, gone = false) => (pane = { text, gone }),
    done: () => m.shutdown(),
  };
}

const last = (a: ProfileLoginFlow[]) => a[a.length - 1];

describe('LoginFlowManager', () => {
  it('Claude: starting -> awaiting_code -> verifying -> success, session removed', async () => {
    const s = setup();
    const r: any = await s.m.start(claude);
    expect(r.flow.state).toBe('starting');
    expect(s.hidden.has('login-work')).toBe(true);
    s.setPane(CLAUDE_PANE);
    await s.m.tick();
    expect(last(s.emitted)).toMatchObject({ state: 'awaiting_code', url: URL_SECRET });
    const sent: any = await s.m.submitCode('work', '  abc#def \n');
    expect(sent.flow.state).toBe('verifying');
    expect(s.typed).toEqual(['abc#def']);
    fs.writeFileSync(s.exitFile(), '0\n');
    await s.m.tick();
    const end = last(s.emitted);
    expect(end.state).toBe('success');
    expect(end.url).toBeUndefined();
    expect(s.sessions.size).toBe(0);
    expect(s.hidden.size).toBe(0);
    expect(s.successes).toEqual(['work']);
    expect(fs.existsSync(s.exitFile())).toBe(false);
    expect(s.m.list()[0].state).toBe('success');
    s.advance(6 * 60_000);
    expect(s.m.list()).toEqual([]);
    s.done();
  });

  it('Claude can finish without any code', async () => {
    const s = setup();
    await s.m.start(claude);
    s.setPane(CLAUDE_PANE);
    await s.m.tick();
    fs.writeFileSync(s.exitFile(), '0\n');
    await s.m.tick();
    expect(last(s.emitted).state).toBe('success');
    expect(s.typed).toEqual([]);
  });

  it('Codex: open_link with the device code, no code accepted', async () => {
    const s = setup();
    await s.m.start(codex);
    s.setPane(CODEX_PANE);
    await s.m.tick();
    expect(last(s.emitted)).toMatchObject({
      state: 'open_link',
      deviceCode: 'DEVC-CODE9',
      url: 'https://auth.openai.com/codex/device',
    });
    expect(await s.m.submitCode('x2', 'abc')).toEqual({
      error: 'This login is not waiting for a code',
    });
    await s.m.cancel('x2');
    s.done();
  });

  it('a non-zero exit fails, 127 names the missing command, and the session goes', async () => {
    const s = setup();
    await s.m.start(claude);
    fs.writeFileSync(s.exitFile(), '1\n');
    await s.m.tick();
    expect(last(s.emitted).state).toBe('failed');
    expect(s.sessions.size).toBe(0);
    const n = setup();
    await n.m.start(codex);
    fs.writeFileSync(n.exitFile(), '127\n');
    await n.m.tick();
    expect(last(n.emitted).message).toMatch(/codex command was not found/);
  });

  it('timeout: expired and the session is removed', async () => {
    const s = setup();
    await s.m.start(claude);
    s.advance(LOGIN_TIMEOUT_MS + 1);
    await s.m.tick();
    expect(last(s.emitted).state).toBe('expired');
    expect(s.sessions.size).toBe(0);
  });

  it('cancel removes the session and clears the link', async () => {
    const s = setup();
    await s.m.start(claude);
    s.setPane(CLAUDE_PANE);
    await s.m.tick();
    const r: any = await s.m.cancel('work');
    expect(r.flow.state).toBe('cancelled');
    expect(r.flow.url).toBeUndefined();
    expect(s.sessions.size).toBe(0);
  });

  it('the session vanishing without an exit code is a failure; a late exit file wins', async () => {
    const s = setup();
    await s.m.start(claude);
    s.setPane(null, true);
    await s.m.tick();
    expect(last(s.emitted).state).toBe('failed');
    const g = setup();
    await g.m.start(claude);
    g.setPane(null, true);
    const cap = g.tmux.capturePaneJoined;
    g.tmux.capturePaneJoined = async () => {
      fs.writeFileSync(g.exitFile(), '0\n');
      return cap();
    };
    await g.m.tick();
    expect(last(g.emitted).state).toBe('success');
  });

  it('a tmux timeout changes nothing', async () => {
    const s = setup();
    await s.m.start(claude);
    s.setPane(null, false);
    const n = s.emitted.length;
    await s.m.tick();
    expect(s.emitted.length).toBe(n);
    await s.m.cancel('work');
  });

  it('unreadable output flags unparsed, and a second tap restarts it', async () => {
    const s = setup();
    await s.m.start(claude);
    s.setPane('something new\n');
    s.advance(21_000);
    await s.m.tick();
    expect(last(s.emitted).unparsed).toBe(true);
    const before = last(s.emitted).flowId;
    const r: any = await s.m.start(claude);
    expect(r.alreadyRunning).toBeUndefined();
    expect(r.flow.flowId).not.toBe(before);
    expect(s.tmux.createSession).toHaveBeenCalledTimes(2);
    await s.m.cancel('work');
  });

  it('a link on a foreign host is never passed on', async () => {
    const s = setup();
    await s.m.start(claude);
    s.setPane('visit: https://evil.example.com/x\nPaste code here if prompted > \n');
    await s.m.tick();
    const f = last(s.emitted);
    expect(f.url).toBeUndefined();
    expect(f.unparsed).toBe(true);
    expect(f.state).toBe('starting');
    await s.m.cancel('work');
  });

  it('a rejected code goes back to awaiting_code after a while', async () => {
    const s = setup();
    await s.m.start(claude);
    s.setPane(CLAUDE_PANE);
    await s.m.tick();
    await s.m.submitCode('work', 'bad');
    await s.m.tick();
    expect(last(s.emitted).state).toBe('verifying');
    s.advance(9000);
    await s.m.tick();
    expect(last(s.emitted)).toMatchObject({ state: 'awaiting_code' });
    expect(last(s.emitted).message).toMatch(/wasn't accepted/);
    await s.m.cancel('work');
  });

  it('polls are deduped: a slow capture is not stacked', async () => {
    const s = setup();
    await s.m.start(claude);
    let release!: () => void;
    s.tmux.holdCapture = new Promise((r) => (release = r));
    const a = s.m.tick();
    const b = s.m.tick();
    const c = s.m.tick();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 20));
    expect(s.tmux.captures).toBe(1);
    release();
    s.tmux.holdCapture = null;
    await Promise.all([a, b, c]);
    await s.m.cancel('work');
  });

  it('reaps only sessions tagged by this owner', async () => {
    const s = setup();
    s.sessions.set('login-old', { [LOGIN_FLOW_TAG]: 'me.aaa' });
    s.sessions.set('login-mine-user', {});
    s.sessions.set('login-sandbox', { [LOGIN_FLOW_TAG]: 'other.bbb' });
    s.sessions.set('work', { [LOGIN_FLOW_TAG]: 'me.ccc' });
    fs.writeFileSync(path.join(s.root, 'old.exit'), '0');
    expect(await s.m.reapLeftovers()).toBe(1);
    expect([...s.sessions.keys()].sort()).toEqual(['login-mine-user', 'login-sandbox', 'work']);
    expect(fs.existsSync(path.join(s.root, 'old.exit'))).toBe(false);
  });

  it('never kills a session that lost its tag', async () => {
    const s = setup();
    await s.m.start(claude);
    s.sessions.set('login-work', { [LOGIN_FLOW_TAG]: 'someone.else' });
    await s.m.cancel('work');
    expect(s.tmux.killSessionNow).not.toHaveBeenCalled();
    expect(s.sessions.has('login-work')).toBe(true);
  });

  it('link, device code and pasted code never reach logs, audit or errors', async () => {
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((k) =>
      jest.spyOn(console, k).mockImplementation(() => undefined)
    );
    const s = setup();
    await s.m.start(claude);
    s.setPane(CLAUDE_PANE);
    await s.m.tick();
    const CODE = 'PASTEDSECRET#123';
    await s.m.submitCode('work', CODE);
    s.tmux.sendSecretLine.mockResolvedValueOnce(false);
    const failed: any = await s.m.submitCode('work', CODE);
    expect(failed.error).toBeTruthy();
    const bad: any = await s.m.submitCode('work', `${CODE}\u0007`);
    fs.writeFileSync(s.exitFile(), '1\n');
    await s.m.tick();
    const x = setup();
    await x.m.start(codex);
    x.setPane(CODEX_PANE);
    await x.m.tick();
    await x.m.cancel('x2');
    const everything = JSON.stringify([
      s.logs,
      x.logs,
      s.audits,
      x.audits,
      failed,
      bad,
      spies.map((sp) => sp.mock.calls),
    ]);
    for (const secret of ['URLSECRET', 'authorize', CODE, 'DEVC-CODE9', 'auth.openai.com']) {
      expect(everything).not.toContain(secret);
    }
    expect(s.audits.map((a) => a.action)).toEqual(['profile_login_start', 'profile_login_end']);
    spies.forEach((sp) => sp.mockRestore());
  });

  it('createSession failure reports a fixed message', async () => {
    const s = setup();
    s.tmux.createSession.mockResolvedValueOnce({
      success: false,
      error: 'tmux said /secret',
    } as any);
    expect(await s.m.start(claude)).toEqual({ error: 'Could not start the login' });
    expect(s.hidden.size).toBe(0);
    expect(s.m.list()).toEqual([]);
  });
});

describe('loginLaunchLine', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'login-line-'));
  it.each([
    ['true', '0'],
    ['false', '1'],
    ['ls /nonexistent-login-line', '2'],
  ])('records the exit code of `%s`, also through the env-file wrapper', (cmd, want) => {
    const f = path.join(dir, 'x.exit');
    execFileSync('sh', ['-c', loginLaunchLine(cmd, f)], { stdio: 'ignore' });
    expect(fs.readFileSync(f, 'utf-8').trim()).toBe(want);
    fs.rmSync(f);
    const env = path.join(dir, 'p.env');
    fs.writeFileSync(env, 'FROM_FILE=hi\n');
    execFileSync('sh', ['-c', withEnvFile(loginLaunchLine(cmd, f), env)], { stdio: 'ignore' });
    expect(fs.readFileSync(f, 'utf-8').trim()).toBe(want);
    fs.rmSync(f);
  });

  it('the env file reaches the command', () => {
    const f = path.join(dir, 'y.exit');
    const env = path.join(dir, 'q.env');
    fs.writeFileSync(env, 'FROM_FILE=ok\n');
    const out = execFileSync(
      'sh',
      ['-c', withEnvFile(loginLaunchLine('echo got=$FROM_FILE', f), env)],
      { encoding: 'utf-8' }
    );
    expect(out.trim()).toBe('got=ok');
  });
});

describe('loginTestOverride', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'login-override-'));
  fs.writeFileSync(path.join(dir, 'p.sh'), 'exit 0\n');
  fs.writeFileSync(path.join(dir, 'p.timeout-ms'), '5000\n');
  it('applies only with COMPANION_SANDBOX=1', () => {
    expect(
      loginTestOverride('p', { COMPANION_SANDBOX: '1', COMPANION_PROFILE_LOGIN_TEST_DIR: dir })
    ).toEqual({ command: `sh ${path.join(dir, 'p.sh')}`, timeoutMs: 5000 });
    expect(loginTestOverride('p', { COMPANION_PROFILE_LOGIN_TEST_DIR: dir })).toEqual({});
    expect(
      loginTestOverride('p', { COMPANION_SANDBOX: '0', COMPANION_PROFILE_LOGIN_TEST_DIR: dir })
    ).toEqual({});
    expect(loginTestOverride('p', { COMPANION_SANDBOX: '1' })).toEqual({});
  });
});
