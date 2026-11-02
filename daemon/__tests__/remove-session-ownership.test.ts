/**
 * Remove Session archives only a transcript the session owns. 2026-10-31: a new
 * session with no prompt, created 15 hours after an older transcript's last
 * write, had that transcript archived through the folder fallback.
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

import { SessionWatcher } from '../src/watcher';
import { encodeProjectDir } from '../src/session-identity';
import { registerSessionHandlers } from '../src/handlers/session';

const MINE = '43557bb2-00af-4884-89ff-46802004cef7';
const OTHER = '7684a1e4-052c-42a0-b6fa-5cbf1d9f3e63';
const NEW_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const nowSec = () => Math.floor(Date.now() / 1000);

describe('remove_session: transcript ownership', () => {
  let root: string;
  let codeHome: string;
  let project: string;
  let dir: string;
  let children: ChildProcess[] = [];
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'remove-owner-'));
    codeHome = path.join(root, '.claude');
    project = path.join(root, 'apps');
    dir = path.join(codeHome, 'projects', encodeProjectDir(project));
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(dir, { recursive: true });
    mockRows.length = 0;
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const c of children) c.kill('SIGKILL');
    children = [];
    logSpy.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const SECRET = 'transcript text never logged';

  function transcript(id: string, ageSec: number): string {
    const file = path.join(dir, `${id}.jsonl`);
    const at = new Date(Date.now() - ageSec * 1000);
    const iso = at.toISOString();
    const lines = [
      {
        type: 'user',
        uuid: `${id}-u`,
        timestamp: iso,
        sessionId: id,
        cwd: project,
        message: { role: 'user', content: SECRET },
      },
      {
        type: 'assistant',
        uuid: `${id}-a`,
        timestamp: iso,
        sessionId: id,
        message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
      },
    ];
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    fs.utimesSync(file, at, at);
    return file;
  }

  function row(name: string, createdSec: number, panePid: number = process.pid) {
    return { name, sessionId: `$${name}`, created: String(createdSec), workingDir: project, panePid };
  }

  function persist(extra: Record<string, unknown>) {
    fs.writeFileSync(
      path.join(codeHome, 'companion-session-mappings.json'),
      JSON.stringify({ history: {}, ...extra })
    );
  }

  function snapshot(entries: Array<Record<string, unknown>>) {
    fs.writeFileSync(
      path.join(codeHome, 'companion-sessions-snapshot.json'),
      JSON.stringify(
        entries.map((e) => ({
          name: e.id,
          projectPath: project,
          lastActivity: 1,
          isWaitingForInput: false,
          messageCount: 1,
          savedAt: 1,
          ...e,
        }))
      )
    );
  }

  /** Runs the real handler against a real watcher; tmux and stores are stubs. */
  async function remove(w: SessionWatcher, sessionId: string) {
    const sent: any[] = [];
    const handlers = registerSessionHandlers({
      watcher: w,
      tmux: {
        sessionExists: async () => false,
        killSession: async () => ({ success: true }),
        removeWorktree: async () => undefined,
      },
      sessionNameStore: { delete: () => {} },
      tmuxSessionConfigs: new Map(),
      saveTmuxSessionConfigs: () => {},
      autoApproveSessions: new Set(),
      send: (_ws: unknown, m: unknown) => sent.push(m),
      broadcast: () => {},
    } as any);
    await handlers.remove_session({ ws: {} } as any, { sessionId }, 'r1');
    return sent[0];
  }

  const archived = () => fs.readdirSync(dir).filter((f) => f.endsWith('.removed'));

  it('Oct 31 shape: a new session with no prompt leaves the older transcript alone', async () => {
    const old = transcript(OTHER, 15 * 3600);
    mockRows.push(row('fresh', nowSec()));
    const w = new SessionWatcher(codeHome);
    await w.refreshTmuxPaths();

    // Reading the session goes through the on-demand load, which claims the
    // folder's newest file for a lone session: exactly what must not count.
    w.ensureConversationLoaded('fresh', { quiet: true });
    expect(w.getConversationInfo('fresh')?.path).toBe(old);

    const res = await remove(w, 'fresh');
    expect(res.success).toBe(true);
    expect(res.payload.jsonlArchived).toBe(false);
    expect(res.payload.archiveSkipped).toBe('predates_session');
    expect(res.payload.archivePath).toBeUndefined();
    expect(fs.existsSync(old)).toBe(true);
    expect(archived()).toEqual([]);
    expect(w.getSessions().some((s) => s.id === 'fresh')).toBe(false);
    expect(logSpy.mock.calls.flat().join('\n')).toContain('leaving transcript in place');
    expect(logSpy.mock.calls.flat().join('\n')).not.toContain(SECRET);
  });

  it('no mapping at all: the folder fallback archives nothing', async () => {
    const recent = transcript(OTHER, 5);
    mockRows.push(row('lone', nowSec() - 60));
    const w = new SessionWatcher(codeHome);
    await w.refreshTmuxPaths();
    (w as any).processFileChange(recent, OTHER);
    (w as any).dropConversationMapping('lone');
    expect(w.getConversationInfo('lone')?.path).toBe(recent);

    const res = await remove(w, 'lone');
    expect(res.payload.archiveSkipped).toBe('no_mapping');
    expect(fs.existsSync(recent)).toBe(true);
  });

  it('a live session never falls back to a stale snapshot path', async () => {
    const old = transcript(OTHER, 30);
    snapshot([{ id: 'reused', conversationPath: old, ownedConversationId: OTHER, ownedTranscriptPath: old }]);
    mockRows.push(row('reused', nowSec() - 60));
    const w = new SessionWatcher(codeHome);
    await w.refreshTmuxPaths();
    const res = await remove(w, 'reused');
    expect(res.payload.archiveSkipped).toBe('no_mapping');
    expect(fs.existsSync(old)).toBe(true);
  });

  it('normal case: a live session archives its own mapped transcript, unloaded or not', async () => {
    const mine = transcript(MINE, 3600);
    const sibling = transcript(OTHER, 1800);
    persist({ mappings: { idle: MINE }, history: { idle: [MINE] } });
    mockRows.push(row('idle', nowSec() - 7200));
    const w = new SessionWatcher(codeHome);
    await w.refreshTmuxPaths();

    const res = await remove(w, 'idle');
    expect(res.payload.jsonlArchived).toBe(true);
    expect(res.payload.archiveSkipped).toBeUndefined();
    expect(fs.existsSync(mine)).toBe(false);
    expect(fs.existsSync(res.payload.archivePath)).toBe(true);
    expect(fs.existsSync(sibling)).toBe(true);
  });

  it('a mapping another live session also holds is left alone', async () => {
    const shared = transcript(MINE, 60);
    persist({ mappings: { a: MINE, b: MINE }, history: { a: [MINE], b: [MINE] } });
    mockRows.push(row('a', nowSec() - 3600), row('b', nowSec() - 3600));
    const w = new SessionWatcher(codeHome);
    await w.refreshTmuxPaths();
    const res = await remove(w, 'a');
    expect(res.payload.archiveSkipped).toBe('claimed_by_other');
    expect(fs.existsSync(shared)).toBe(true);
  });

  it("a transcript in another session's chain is left alone", async () => {
    const chained = transcript(OTHER, 60);
    transcript(MINE, 30);
    persist({ mappings: { a: OTHER, b: MINE }, history: { a: [OTHER], b: [OTHER, MINE] } });
    mockRows.push(row('a', nowSec() - 3600), row('b', nowSec() - 3600));
    const w = new SessionWatcher(codeHome);
    await w.refreshTmuxPaths();
    const res = await remove(w, 'a');
    expect(res.payload.archiveSkipped).toBe('claimed_by_other');
    expect(fs.existsSync(chained)).toBe(true);
  });

  describe('the running process', () => {
    async function holder(uuid: string): Promise<ChildProcess> {
      const tasks = path.join(root, 'scratch', encodeProjectDir(project), uuid, 'tasks');
      fs.mkdirSync(tasks, { recursive: true });
      const p = spawn('bash', ['-c', 'exec 9<"$0"; exec sleep 30', tasks]);
      children.push(p);
      await new Promise((r) => setTimeout(r, 150));
      return p;
    }

    it('contradicts a mapping that passes the time check: left alone', async () => {
      // Written after the session started, so modification times cannot tell.
      const wrong = transcript(OTHER, 5);
      const p = await holder(NEW_ID);
      mockRows.push(row('fresh', nowSec() - 60, p.pid!));
      const w = new SessionWatcher(codeHome);
      await w.refreshTmuxPaths();
      (w as any).setConversationMapping('fresh', OTHER);
      const res = await remove(w, 'fresh');
      expect(res.payload.archiveSkipped).toBe('process_owns_other');
      expect(fs.existsSync(wrong)).toBe(true);
    });

    it('confirms the mapping: archived', async () => {
      const mine = transcript(MINE, 5);
      const p = await holder(MINE);
      mockRows.push(row('s', nowSec() - 60, p.pid!));
      const w = new SessionWatcher(codeHome);
      await w.refreshTmuxPaths();
      expect((w as any).tmuxConversationIds.get('s')).toBe(MINE);
      const res = await remove(w, 's');
      expect(res.payload.jsonlArchived).toBe(true);
      expect(fs.existsSync(mine)).toBe(false);
    });

    it('still names the pre-compaction id: the continuation is archived', async () => {
      transcript(MINE, 60);
      const next = transcript(NEW_ID, 5);
      const p = await holder(MINE);
      persist({ mappings: { s: NEW_ID }, history: { s: [MINE, NEW_ID] } });
      mockRows.push(row('s', nowSec() - 3600, p.pid!));
      const w = new SessionWatcher(codeHome);
      await w.refreshTmuxPaths();
      const res = await remove(w, 's');
      expect(res.payload.jsonlArchived).toBe(true);
      expect(fs.existsSync(next)).toBe(false);
    });
  });

  describe('a session already dead', () => {
    it('archives its own transcript after a restart, from the persisted mapping', async () => {
      const mine = transcript(MINE, 3600);
      persist({
        mappings: { dead: MINE },
        history: { dead: [MINE] },
        identity: { dead: { created: String(nowSec() - 7200), panePid: 1, encodedPath: '' } },
      });
      snapshot([{ id: 'dead', conversationPath: mine }]);
      const w = new SessionWatcher(codeHome);
      await w.refreshTmuxPaths();
      expect((w as any).tmuxConversationIds.has('dead')).toBe(false); // refresh pruned it
      const res = await remove(w, 'dead');
      expect(res.payload.jsonlArchived).toBe(true);
      expect(fs.existsSync(mine)).toBe(false);
    });

    it('died while the daemon was down: the snapshot written alive proves ownership', async () => {
      const mine = transcript(MINE, 60);
      persist({ mappings: { s: MINE }, history: { s: [MINE] } });
      mockRows.push(row('s', nowSec() - 3600));
      const before = new SessionWatcher(codeHome);
      await before.refreshTmuxPaths();
      before.persistSessions();
      const saved = JSON.parse(
        fs.readFileSync(path.join(codeHome, 'companion-sessions-snapshot.json'), 'utf-8')
      );
      expect(saved[0]).toMatchObject({ ownedConversationId: MINE, ownedTranscriptPath: mine });

      // Nothing else proves it now: the mappings file no longer holds the session.
      persist({ mappings: {} });
      mockRows.length = 0;
      const after = new SessionWatcher(codeHome);
      await after.refreshTmuxPaths();
      const res = await remove(after, 's');
      expect(res.payload.jsonlArchived).toBe(true);
      expect(fs.existsSync(mine)).toBe(false);
    });

    it('a snapshot path with no mapping behind it archives nothing', async () => {
      const old = transcript(OTHER, 3600);
      snapshot([{ id: 'dead', conversationPath: old }]);
      const w = new SessionWatcher(codeHome);
      await w.refreshTmuxPaths();
      const res = await remove(w, 'dead');
      expect(res.success).toBe(true);
      expect(res.payload.archiveSkipped).toBe('no_mapping');
      expect(fs.existsSync(old)).toBe(true);
      expect(w.getSessions().some((s) => s.id === 'dead')).toBe(false);
    });

    it('a transcript last written before it existed archives nothing', async () => {
      const old = transcript(OTHER, 15 * 3600);
      snapshot([
        {
          id: 'dead',
          conversationPath: old,
          ownedConversationId: OTHER,
          ownedTranscriptPath: old,
          sessionCreated: String(nowSec() - 60),
        },
      ]);
      const w = new SessionWatcher(codeHome);
      await w.refreshTmuxPaths();
      const res = await remove(w, 'dead');
      expect(res.payload.archiveSkipped).toBe('predates_session');
      expect(fs.existsSync(old)).toBe(true);
    });

    it("a snapshot naming another dead session's transcript archives nothing", async () => {
      const file = transcript(MINE, 3600);
      snapshot([
        { id: 'one', conversationPath: file, ownedConversationId: MINE, ownedTranscriptPath: file },
        { id: 'two', conversationPath: file, ownedConversationId: MINE, ownedTranscriptPath: file },
      ]);
      const w = new SessionWatcher(codeHome);
      await w.refreshTmuxPaths();
      const res = await remove(w, 'one');
      expect(res.payload.archiveSkipped).toBe('claimed_by_other');
      expect(fs.existsSync(file)).toBe(true);
    });
  });

  it('after removal the name loads nothing, even with the transcript left in place', async () => {
    transcript(OTHER, 15 * 3600);
    mockRows.push(row('fresh', nowSec()));
    const w = new SessionWatcher(codeHome);
    await w.refreshTmuxPaths();
    await remove(w, 'fresh');
    mockRows.length = 0;
    expect(w.ensureConversationLoaded('fresh', { quiet: true })).toBe(false);
    expect(w.getConversationInfo('fresh')).toBeNull();
  });
});
