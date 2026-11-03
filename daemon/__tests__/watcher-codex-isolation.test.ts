/**
 * A Codex session never resolves to a Claude transcript (and vice versa), its
 * first rollout is picked up by a sessions-dir event within a moment, and the
 * agent's trust prompt reads as "waiting" (2026-10-28: a Codex session created
 * from the app showed the folder's old Claude conversation, and its first
 * message went into the trust prompt).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';

const mockRows: Array<Record<string, unknown>> = [];

jest.mock('../src/tmux-snapshot', () => ({
  tmuxSnapshot: {
    get: async () => ({ ok: true, at: Date.now(), sessions: mockRows }),
    isTagged: async () => true,
    invalidate: () => {},
    invalidateTag: () => {},
  },
  invalidateTmuxSnapshot: () => {},
}));
jest.mock('../src/session-identity', () => {
  const actual = jest.requireActual('../src/session-identity');
  return { ...actual, findClaudePid: async () => null };
});
jest.mock('chokidar', () => ({
  watch: () => ({
    on: jest.fn().mockReturnThis(),
    add: jest.fn(),
    unwatch: jest.fn(),
    close: jest.fn(),
  }),
}));

import { SessionWatcher, TRUST_PROMPT_ACTIVITY } from '../src/watcher';
import { ProfileRegistry } from '../src/profiles';
import { encodeProjectDir } from '../src/session-identity';

const FIXTURES = path.join(__dirname, '..', 'src', 'agents', '__tests__', 'fixtures', 'codex');
const OLD_CLAUDE_ID = 'c9562fb3-3611-45df-a6cb-d28302f4d830';
const pad = (n: number) => String(n).padStart(2, '0');

describe('SessionWatcher: Codex sessions stay Codex', () => {
  let root: string;
  let children: ChildProcess[] = [];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-codex-iso-'));
    mockRows.length = 0;
  });
  afterEach(() => {
    for (const c of children) c.kill('SIGKILL');
    children = [];
  });

  function setup() {
    const codeHome = path.join(root, '.claude');
    const codexHome = path.join(root, '.codex');
    const project = path.join(root, 'doc-upload-site');
    fs.mkdirSync(project, { recursive: true });
    // The folder's OLD Claude transcript (the one the bug showed).
    const claudeDir = path.join(codeHome, 'projects', encodeProjectDir(project));
    fs.mkdirSync(claudeDir, { recursive: true });
    const claudeFile = path.join(claudeDir, `${OLD_CLAUDE_ID}.jsonl`);
    fs.writeFileSync(
      claudeFile,
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        timestamp: new Date(Date.now() - 7 * 86_400_000).toISOString(),
        cwd: project,
        message: { role: 'user', content: 'an old Claude conversation' },
      }) + '\n'
    );
    const profiles = new ProfileRegistry({
      codeHome,
      codexHome,
      configPath: null,
      profilesRaw: [],
      log: () => {},
    });
    const w = new SessionWatcher(codeHome, undefined, { profiles, codexHome });
    mockRows.push({
      name: 'cdx1',
      sessionId: '$1',
      created: '1',
      workingDir: project,
      panePid: process.pid,
    });
    return { w, codeHome, codexHome, project, claudeFile };
  }

  /** A process named `codex` in `cwd` under this (pane) process. */
  async function fakeCodex(cwd: string): Promise<ChildProcess> {
    const c = spawn('bash', ['-c', 'exec -a codex sleep 30'], { cwd });
    children.push(c);
    await new Promise((r) => setTimeout(r, 150));
    return c;
  }

  function writeRollout(codexHome: string, cwd: string): string {
    const now = new Date();
    const dir = path.join(
      codexHome,
      'sessions',
      String(now.getFullYear()),
      pad(now.getMonth() + 1),
      pad(now.getDate())
    );
    fs.mkdirSync(dir, { recursive: true });
    const id = '01a18635-c6ce-7b41-9c1f-51a42ea9a0bd';
    const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const file = path.join(dir, `rollout-${ts}-${id}.jsonl`);
    const iso = now.toISOString();
    fs.writeFileSync(
      file,
      [
        { timestamp: iso, type: 'session_meta', payload: { id, timestamp: iso, cwd } },
        {
          timestamp: iso,
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'yoyo' }],
          },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n'
    );
    return file;
  }

  it('before Codex writes a rollout, a launched Codex session shows nothing (never the Claude transcript)', async () => {
    const { w, project } = setup();
    w.noteSessionAgent('cdx1', 'codex');
    w.markSessionAsNew('cdx1');
    // No agent process yet (Codex still starting): the key is Codex's anyway.
    await w.refreshTmuxPaths();
    expect((w as any).tmuxPathBySession.get('cdx1')).toBe('codex:cdx1');
    expect(w.ensureConversationLoaded('cdx1')).toBe(false);
    expect(w.getMessages('cdx1')).toEqual([]);
    expect(w.getConversationChain('cdx1')).toEqual([]);
    expect(w.getConversationInfo('cdx1')).toBeNull();
    const s = (await w.getServerSummary()).sessions.find((x) => x.id === 'cdx1')!;
    expect(s.status).toBe('idle');
    expect(s.projectPath).toBe(project);
    expect(w.resolveSessionByTmuxName('cdx1', project)).toBeNull();

    // Codex process up, still no rollout: same.
    await fakeCodex(project);
    await w.refreshTmuxPaths();
    expect(w.agentFor('cdx1').id).toBe('codex');
    expect(w.ensureConversationLoaded('cdx1')).toBe(false);
    expect(w.getMessages('cdx1')).toEqual([]);
    // Even after the new-session guard is gone.
    (w as any).newlyCreatedSessions.clear();
    expect(w.ensureConversationLoaded('cdx1')).toBe(false);
    expect(w.getMessages('cdx1')).toEqual([]);
    w.stop();
  });

  it('the first rollout is mapped by the sessions-dir watch within a moment', async () => {
    const { w, codexHome, project } = setup();
    w.noteSessionAgent('cdx1', 'codex');
    await fakeCodex(project);
    // Today's sessions dir exists (other threads), the rollout does not yet.
    const now = new Date();
    fs.mkdirSync(
      path.join(
        codexHome,
        'sessions',
        String(now.getFullYear()),
        pad(now.getMonth() + 1),
        pad(now.getDate())
      ),
      { recursive: true }
    );
    await w.refreshTmuxPaths();
    expect(w.getConversationIdsForSession('cdx1')).toEqual([]);
    const t0 = Date.now();
    const file = writeRollout(codexHome, project);
    // No refresh / nudge called by the test: the fs event does it.
    while (w.getConversationIdsForSession('cdx1').length === 0 && Date.now() - t0 < 3000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(w.getConversationIdsForSession('cdx1')).toEqual([
      '01a18635-c6ce-7b41-9c1f-51a42ea9a0bd',
    ]);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(w.getConversationInfo('cdx1')?.path).toBe(file);
    const msgs = w.getMessages('cdx1');
    expect(msgs.some((m) => m.content.includes('yoyo'))).toBe(true);
    expect(msgs.some((m) => m.content.includes('old Claude'))).toBe(false);
    w.stop();
  });

  it('a Claude session in the same folder never resolves to the Codex rollout', async () => {
    const { w, codexHome, project, claudeFile } = setup();
    w.noteSessionAgent('cdx1', 'codex');
    await fakeCodex(project);
    writeRollout(codexHome, project);
    await w.refreshTmuxPaths();
    expect(w.getConversationIdsForSession('cdx1').length).toBe(1);
    // The Claude side: cwd lookups for a Claude session skip Codex rollouts.
    expect(await w.waitForSessionInCwd(project, 50)).toBeNull();
    expect(await w.waitForSessionInCwd(project, 50, 'codex')).toBe(
      '01a18635-c6ce-7b41-9c1f-51a42ea9a0bd'
    );
    expect(claudeFile).toBeTruthy();
    w.stop();
  });

  it('the trust prompt makes the session wait until it is answered', async () => {
    const { w, project } = setup();
    w.noteSessionAgent('cdx1', 'codex');
    await fakeCodex(project);
    await w.refreshTmuxPaths();
    const events: Array<{ sessionId: string; isWaitingForInput: boolean }> = [];
    w.on('status-change', (e) => events.push(e));
    const trust = fs.readFileSync(path.join(FIXTURES, 'live-trust.txt'), 'utf8');
    w.noteStartupPane('cdx1', trust);
    expect(w.startupPromptFor('cdx1')?.kind).toBe('trust');
    expect(w.getStatus('cdx1')).toMatchObject({
      isWaitingForInput: true,
      currentActivity: TRUST_PROMPT_ACTIVITY,
    });
    expect(w.getClientStatus('cdx1').isWaitingForInput).toBe(true);
    const s = (await w.getServerSummary()).sessions.find((x) => x.id === 'cdx1')!;
    expect(s.status).toBe('waiting');
    expect(s.pendingPrompt?.kind).toBe('trust');
    expect(s.pendingPrompt!.options.length).toBeGreaterThanOrEqual(2);
    expect(s.waitingSince).toBe(s.lastActivity); // the trust prompt's own `since`
    w.noteStartupPane('cdx1', trust); // same prompt: no second event
    const idle = fs.readFileSync(path.join(FIXTURES, 'live-idle.ansi'), 'utf8');
    w.noteStartupPane('cdx1', idle);
    expect(w.startupPromptFor('cdx1')).toBeNull();
    expect(w.getStatus('cdx1').isWaitingForInput).toBe(false);
    const after = (await w.getServerSummary()).sessions.find((x) => x.id === 'cdx1')!;
    expect(after.pendingPrompt).toBeUndefined();
    expect(after.waitingSince).toBeUndefined();
    expect(events.map((e) => e.isWaitingForInput)).toEqual([true, false]);
    w.stop();
  });
});
