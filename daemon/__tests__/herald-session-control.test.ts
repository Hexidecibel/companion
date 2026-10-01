import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ActionManager } from '../src/herald/actions';
import { classifyInterrupt, classifySpawn } from '../src/herald/danger';
import {
  classifyStartupPane,
  cleanFirstPrompt,
  resolveSpawnDir,
  SpawnRunner,
  type SessionSpawner,
} from '../src/herald/spawn';
import { executeTool, type ToolEnv, type TurnToolState } from '../src/herald/tools';
import type { SessionSnapshot, SessionSource } from '../src/herald/session-source';
import { snap } from './herald-helpers';

describe('spawn folder validation', () => {
  let home: string;
  let root: string;
  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herald-spawn-')));
    root = path.join(home, 'local', 'src');
    fs.mkdirSync(path.join(root, 'companion', 'web'), { recursive: true });
    fs.mkdirSync(path.join(root, 'doc-upload-site'), { recursive: true });
    fs.mkdirSync(path.join(home, 'secret'), { recursive: true });
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('finds a project by name (case and punctuation ignored) or by path', () => {
    expect(resolveSpawnDir('Companion', [root], home)).toEqual({
      ok: true,
      dir: path.join(root, 'companion'),
      name: 'companion',
    });
    expect(resolveSpawnDir('doc upload site', [root], home)).toMatchObject({
      ok: true,
      name: 'doc-upload-site',
    });
    expect(resolveSpawnDir('~/local/src/companion/web', [root], home)).toMatchObject({
      ok: true,
      dir: path.join(root, 'companion', 'web'),
    });
    expect(resolveSpawnDir('companion/web', [root], home)).toMatchObject({ ok: true, name: 'web' });
  });

  it('refuses folders outside the allowed roots, symlink escapes and the root itself', () => {
    expect(resolveSpawnDir('~/secret', [root], home)).toMatchObject({ ok: false });
    expect((resolveSpawnDir('~/secret', [root], home) as { error: string }).error).toMatch(/outside/);
    fs.symlinkSync(path.join(home, 'secret'), path.join(root, 'sneaky'));
    expect(resolveSpawnDir('sneaky', [root], home)).toMatchObject({ ok: false });
    expect(resolveSpawnDir('~/local/src', [root], home)).toMatchObject({ ok: false });
    expect(resolveSpawnDir('../secret', [root], home)).toMatchObject({ ok: false });
  });

  it('refuses missing folders, shell characters and no roots', () => {
    expect(resolveSpawnDir('nope', [root], home)).toMatchObject({ ok: false });
    expect(resolveSpawnDir('~/local/src/nope', [root], home)).toMatchObject({ ok: false });
    expect(resolveSpawnDir('companion; rm -rf ~', [root], home)).toMatchObject({ ok: false });
    expect(resolveSpawnDir('$(whoami)', [root], home)).toMatchObject({ ok: false });
    expect(resolveSpawnDir('companion', [], home)).toMatchObject({ ok: false });
  });

  it('cleans the first prompt', () => {
    expect(cleanFirstPrompt('  run tests\u0007 ')).toEqual({ ok: true, prompt: 'run tests' });
    expect(cleanFirstPrompt('')).toMatchObject({ ok: false });
    expect(cleanFirstPrompt('x'.repeat(2001))).toMatchObject({ ok: false });
  });
});

describe('session-control tiers', () => {
  it('interrupt is echo; the assistant can only raise it', () => {
    expect(classifyInterrupt({}).tier).toBe('echo');
    expect(classifyInterrupt({ requestedConfirm: true }).tier).toBe('hard_confirm');
  });
  it('spawn is always hard_confirm and says it bypasses permissions', () => {
    const v = classifySpawn({ dir: '/x/companion', userText: 'start one', firstPrompt: 'run tests' });
    expect(v.tier).toBe('hard_confirm');
    expect(v.reasons[0]).toMatch(/permissions bypassed/);
    const d = classifySpawn({ dir: '/x/a', userText: 'start one', firstPrompt: 'deploy to prod' });
    expect(d.reasons.join(' ')).toMatch(/deploy/);
  });
});

describe('startup screen', () => {
  it('tells ready from the bypass warning, the trust prompt and a plain shell', () => {
    expect(
      classifyStartupPane(
        'WARNING: Claude Code running in Bypass Permissions mode\n❯ 1. No, exit\n  2. Yes, I accept'
      )
    ).toBe('bypass_warning');
    expect(classifyStartupPane('Do you trust the files in this folder?\n❯ 1. Yes')).toBe('trust_prompt');
    expect(classifyStartupPane('╭──────────────╮\n│ ❯            │\n╰──────────────╯\n  ? for shortcuts')).toBe(
      'ready'
    );
    // A shell prompt that happens to use ❯ is NOT Claude: never type the prompt into a shell.
    expect(classifyStartupPane('~/local/src/companion ❯ ')).toBe('starting');
  });
});

function fakeSpawner(screens: string[], over: Partial<SessionSpawner> = {}) {
  const s = {
    spawned: [] as Array<{ dir: string; name: string }>,
    spawn: jest.fn(async (req: { dir: string; name: string }) => {
      s.spawned.push(req);
      return { ok: true, sessionId: 'companion-x', sessionName: 'Companion' };
    }),
    capturePane: jest.fn(async () => (screens.length > 1 ? screens.shift()! : screens[0])),
    exists: jest.fn(async () => true),
    ...over,
  };
  return s;
}

describe('SpawnRunner', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-run-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('ready: sends the first prompt and opens the ask', async () => {
    const sp = fakeSpawner(['starting...', '? for shortcuts']);
    const sendPrompt = jest.fn(async () => true);
    const onPromptSent = jest.fn();
    const r = new SpawnRunner({ spawner: sp, sendPrompt, post: jest.fn(), onPromptSent, pollMs: 1 });
    const out = await r.run({ dir, name: 'companion', firstPrompt: 'run the tests' });
    expect(out).toMatchObject({ ok: true, sessionId: 'companion-x' });
    expect(out.message).toMatch(/sent your first prompt/);
    expect(sendPrompt).toHaveBeenCalledWith('companion-x', 'run the tests');
    expect(onPromptSent).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'companion-x', prompt: 'run the tests' }));
  });

  it('bypass warning: reports it, never accepts it, and sends once the user has', async () => {
    const warning = 'Bypass Permissions mode\n❯ 1. No, exit\n 2. Yes, I accept';
    const screens = [warning];
    const sp = fakeSpawner(screens);
    const sendPrompt = jest.fn(async () => true);
    const post = jest.fn();
    const r = new SpawnRunner({
      spawner: sp,
      sendPrompt,
      post,
      onPromptSent: jest.fn(),
      pollMs: 1,
      watchPollMs: 5,
    });
    const out = await r.run({ dir, name: 'companion', firstPrompt: 'run the tests' });
    expect(out.ok).toBe(true);
    expect(out.message).toMatch(/bypass-permissions warning/);
    expect(out.message).toMatch(/I won't do that for you/);
    expect(sendPrompt).not.toHaveBeenCalled();
    // The user accepts in the app.
    screens[0] = '? for shortcuts';
    for (let i = 0; i < 100 && !sendPrompt.mock.calls.length; i++) await new Promise((x) => setTimeout(x, 5));
    expect(sendPrompt).toHaveBeenCalledWith('companion-x', 'run the tests');
    expect(post).toHaveBeenCalledWith(expect.stringMatching(/ready; sent your first prompt/), expect.anything());
    r.dispose();
  });

  it('a parked session that closes is reported, nothing sent', async () => {
    const sp = fakeSpawner(['Bypass Permissions mode ... Yes, I accept'], { exists: jest.fn(async () => false) });
    const sendPrompt = jest.fn(async () => true);
    const post = jest.fn();
    const r = new SpawnRunner({ spawner: sp, sendPrompt, post, onPromptSent: jest.fn(), pollMs: 1, watchPollMs: 5 });
    await r.run({ dir, name: 'companion', firstPrompt: 'x' });
    for (let i = 0; i < 100 && !post.mock.calls.length; i++) await new Promise((x) => setTimeout(x, 5));
    expect(post).toHaveBeenCalledWith(expect.stringMatching(/closed before it started/), expect.anything());
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it('a folder that vanished or a failed start reports an error', async () => {
    const sp = fakeSpawner(['? for shortcuts']);
    const r = new SpawnRunner({ spawner: sp, sendPrompt: jest.fn(), post: jest.fn(), onPromptSent: jest.fn() });
    expect(await r.run({ dir: path.join(dir, 'gone'), name: 'gone', firstPrompt: 'x' })).toMatchObject({ ok: false });
    expect(sp.spawn).not.toHaveBeenCalled();
    const bad = fakeSpawner([''], { spawn: jest.fn(async () => ({ ok: false, error: 'tmux exploded' })) });
    const r2 = new SpawnRunner({ spawner: bad, sendPrompt: jest.fn(), post: jest.fn(), onPromptSent: jest.fn() });
    expect((await r2.run({ dir, name: 'x', firstPrompt: 'x' })).error).toMatch(/tmux exploded/);
  });
});

// ---------------------------------------------------------------------------
// Tools + execution

function env(sessions: SessionSnapshot[], over: Partial<ToolEnv> = {}) {
  const src = {
    serverId: 'local',
    listSessions: jest.fn(async () => sessions),
    getRecentTranscript: jest.fn(async () => ({ lastUserPrompt: null, assistantTurns: [] })),
    getLiveChoice: jest.fn(async () => null),
    sessionExists: jest.fn(async () => true),
    sendText: jest.fn(async () => true),
    sendChoice: jest.fn(async () => true),
    interrupt: jest.fn(async () => true),
  };
  const sent: string[] = [];
  const actions = new ActionManager({
    getSource: () => src as unknown as SessionSource,
    echoDelayMs: 20,
    onChange: () => {},
    onSent: (a) => sent.push(a.id),
    audit: () => {},
  });
  const e: ToolEnv = {
    listSessions: async () => sessions,
    getSource: () => src as unknown as SessionSource,
    actions,
    now: () => Date.now(),
    statusSince: () => null,
    echoDelayMs: 20,
    ...over,
  };
  return { e, src, actions, sent };
}

const turn = (userText: string): TurnToolState => ({ userText, sessionRefs: new Map(), proposals: [] });

describe('propose_interrupt', () => {
  it('echo tier, readback "Interrupting Docs", and it really sends Ctrl+C', async () => {
    const sessions = [snap({ sessionId: 'docs', sessionName: 'Docs', status: 'working' })];
    const { e, src, actions } = env(sessions);
    const out = await executeTool('propose_interrupt', { session: 'Docs' }, e, turn('stop docs'));
    expect(out.isError).toBe(false);
    const r = JSON.parse(out.content);
    expect(r).toMatchObject({ tier: 'echo', readback: 'Interrupting Docs' });
    expect(r.instruction).toMatch(/Interrupting Docs/);
    for (let i = 0; i < 100 && actions.get(r.action_id)!.status === 'pending'; i++)
      await new Promise((x) => setTimeout(x, 5));
    expect(actions.get(r.action_id)!.status).toBe('sent');
    expect(src.interrupt).toHaveBeenCalledWith('docs');
    actions.dispose();
  });

  it('refuses an idle session (a stray Ctrl+C is a step toward exiting Claude)', async () => {
    const { e, actions } = env([snap({ sessionId: 'docs', sessionName: 'Docs', status: 'idle' })]);
    const out = await executeTool('propose_interrupt', { session: 'Docs' }, e, turn('stop docs'));
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/nothing to interrupt/);
    expect(actions.list()).toHaveLength(0);
  });

  it('re-checks at send time: a session that already stopped is not interrupted', async () => {
    const sessions = [snap({ sessionId: 'docs', sessionName: 'Docs', status: 'working' })];
    const { e, src, actions } = env(sessions);
    const out = await executeTool('propose_interrupt', { session: 'Docs' }, e, turn('stop docs'));
    const id = JSON.parse(out.content).action_id;
    sessions[0] = { ...sessions[0], status: 'idle' };
    for (let i = 0; i < 100 && actions.get(id)!.status === 'pending'; i++) await new Promise((x) => setTimeout(x, 5));
    expect(actions.get(id)!.status).toBe('expired');
    expect(actions.get(id)!.error).toMatch(/already stopped/);
    expect(src.interrupt).not.toHaveBeenCalled();
  });

  it('a second interrupt replaces the first (never a double Ctrl+C)', async () => {
    const { e, actions } = env([snap({ sessionId: 'docs', sessionName: 'Docs', status: 'working' })]);
    const a = JSON.parse((await executeTool('propose_interrupt', { session: 'Docs' }, e, turn('stop'))).content);
    const b = JSON.parse((await executeTool('propose_interrupt', { session: 'Docs' }, e, turn('stop'))).content);
    expect(actions.get(a.action_id)!.status).toBe('cancelled');
    expect(actions.get(b.action_id)!.status).toBe('pending');
    actions.dispose();
  });
});

describe('propose_spawn_session', () => {
  let home: string;
  let root: string;
  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herald-spawn-tool-')));
    root = path.join(home, 'local', 'src');
    fs.mkdirSync(path.join(root, 'companion'), { recursive: true });
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('hard_confirm with "confirm launch"; nothing starts without confirmation', async () => {
    const { e, actions } = env([snap({ sessionId: 'c1', sessionName: 'Companion', projectPath: path.join(root, 'companion') })], {
      spawn: { roots: [root], userHome: home },
    });
    const out = await executeTool(
      'propose_spawn_session',
      { project_or_dir: 'companion', first_prompt: 'run the tests' },
      e,
      turn('start a new session in companion and run the tests')
    );
    expect(out.isError).toBe(false);
    const r = JSON.parse(out.content);
    expect(r).toMatchObject({ tier: 'hard_confirm', confirm_phrase: 'confirm launch', folder: 'companion' });
    expect(r.reasons.join(' ')).toMatch(/already runs in this folder/);
    expect(r.instruction).toMatch(/say 'confirm launch' to go ahead/);
    const a = actions.get(r.action_id)!;
    expect(a.kind).toBe('spawn_session');
    expect(a.payload).toBe('run the tests');
    await new Promise((x) => setTimeout(x, 40));
    expect(actions.get(r.action_id)!.status).toBe('pending');
    actions.dispose();
  });

  it('refuses without spawn support or outside the roots', async () => {
    const { e } = env([]);
    expect((await executeTool('propose_spawn_session', { project_or_dir: 'companion', first_prompt: 'x' }, e, turn('x'))).isError).toBe(true);
    const { e: e2 } = env([], { spawn: { roots: [root], userHome: home } });
    const out = await executeTool('propose_spawn_session', { project_or_dir: '/etc', first_prompt: 'x' }, e2, turn('x'));
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/outside/);
  });
});
