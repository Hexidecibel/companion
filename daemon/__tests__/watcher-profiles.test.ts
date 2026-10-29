/**
 * Account profiles in the watcher: a Claude session under another
 * CLAUDE_CONFIG_DIR is keyed `profile:<id>:<encoded>`, its transcripts come
 * from THAT home's projects dir, and the profile is read from the agent
 * process's real /proc/<pid>/environ.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';

const mockRows: Array<Record<string, unknown>> = [];
let mockAgentPid: number | null = null;

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
  return { ...actual, findClaudePid: async () => mockAgentPid };
});
jest.mock('chokidar', () => ({
  watch: () => ({
    on: jest.fn().mockReturnThis(),
    add: jest.fn(),
    unwatch: jest.fn(),
    close: jest.fn(),
  }),
}));

import { SessionWatcher } from '../src/watcher';
import { ProfileRegistry } from '../src/profiles';
import { encodeProjectDir } from '../src/session-identity';

describe('SessionWatcher with account profiles', () => {
  let root: string;
  let child: ChildProcess | null = null;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-profiles-'));
    mockRows.length = 0;
    mockAgentPid = null;
  });
  afterEach(() => {
    child?.kill('SIGKILL');
    child = null;
  });

  function setup() {
    const codeHome = path.join(root, '.claude');
    const work = path.join(root, 'claude-work');
    const project = path.join(root, 'proj');
    fs.mkdirSync(path.join(codeHome, 'projects'), { recursive: true });
    fs.mkdirSync(work);
    fs.mkdirSync(project);
    const profiles = new ProfileRegistry({
      codeHome,
      configPath: null,
      profilesRaw: [{ id: 'work', label: 'Work', agent: 'claude', home: work }],
      log: () => {},
    });
    const w = new SessionWatcher(codeHome, undefined, { profiles });
    return { w, codeHome, work, project };
  }

  it('maps keys and files per profile root', () => {
    const { w, codeHome, work, project } = setup();
    const enc = encodeProjectDir(project);
    const a = w as any;
    const defFile = path.join(codeHome, 'projects', enc, 'aaa.jsonl');
    const workFile = path.join(work, 'projects', enc, 'bbb.jsonl');
    expect(a.claudeKeyOfFile(defFile)).toBe(enc);
    expect(a.claudeKeyOfFile(workFile)).toBe(`profile:work:${enc}`);
    expect(a.claudeKeyOfFile(path.join(codeHome, 'history.jsonl'))).toBe('');
    expect(a.generateSessionId(workFile)).toBe('bbb');
    expect(a.generateSessionId(path.join(root, 'elsewhere', 'x.jsonl'))).toBe('');
    expect(a.projectDirForKey(`profile:work:${enc}`)).toBe(path.join(work, 'projects', enc));
    expect(a.projectDirForKey(enc)).toBe(path.join(codeHome, 'projects', enc));
    expect(a.projectDirForKey(`profile:gone:${enc}`)).toBeNull();
    expect(a.extractProjectPath(workFile)).toBe(project);
    w.stop();
  });

  it('reads the profile from the agent process environ and loads its transcript', async () => {
    const { w, work, project } = setup();
    child = spawn('sleep', ['30'], { env: { ...process.env, CLAUDE_CONFIG_DIR: work } });
    await new Promise((r) => setTimeout(r, 100));
    mockAgentPid = child.pid!;
    mockRows.push({
      name: 'w1',
      sessionId: '$1',
      created: '1',
      workingDir: project,
      panePid: process.pid,
    });
    const enc = encodeProjectDir(project);
    const dir = path.join(work, 'projects', enc);
    fs.mkdirSync(dir, { recursive: true });
    const conv = path.join(dir, '11111111-1111-1111-1111-111111111111.jsonl');
    fs.writeFileSync(
      conv,
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'hello from work' },
      }) + '\n'
    );
    await w.refreshTmuxPaths();
    expect(w.profileFor('w1').id).toBe('work');
    expect(w.ensureConversationLoaded('w1')).toBe(true);
    expect(w.getConversationInfo('w1')?.path).toBe(conv);
    const summary = await w.getServerSummary();
    const s = summary.sessions.find((x) => x.id === 'w1')!;
    expect(s.profileId).toBe('work');
    expect(s.profileLabel).toBe('Work');
    expect(s.projectPath).toBe(project);
    w.stop();
  });

  it('a default-profile session has no profile fields and the bare key', async () => {
    const { w, codeHome, project } = setup();
    child = spawn('sleep', ['30'], { env: { ...process.env, CLAUDE_CONFIG_DIR: '' } });
    await new Promise((r) => setTimeout(r, 100));
    mockAgentPid = child.pid!;
    mockRows.push({
      name: 'd1',
      sessionId: '$2',
      created: '1',
      workingDir: project,
      panePid: process.pid,
    });
    await w.refreshTmuxPaths();
    expect(w.profileFor('d1').id).toBe('claude');
    expect((w as any).tmuxPathBySession.get('d1')).toBe(encodeProjectDir(project));
    const s = (await w.getServerSummary()).sessions.find((x) => x.id === 'd1')!;
    expect(s.profileId).toBeUndefined();
    expect(codeHome).toBeTruthy();
    w.stop();
  });
});
