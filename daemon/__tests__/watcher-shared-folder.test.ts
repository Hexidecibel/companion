/**
 * Sessions sharing a folder keep their own transcripts, and a mapped transcript
 * not in memory still reads. 2026-10-31: creating a second session in
 * /mnt/hexinas/apps force-loaded older files; a compaction flag left from an
 * in-place compaction moved the working session onto an Oct 27 transcript, and
 * elimination gave the new session an old one. Separately, get_highlights
 * returned nothing for a persisted mapping whose file the age filter skipped.
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

const LIVE = '43557bb2-00af-4884-89ff-46802004cef7';
const OLD_A = '4bd6da92-b1b8-4367-b9ce-d1bc712e09d5';
const OLD_B = '7684a1e4-052c-42a0-b6fa-5cbf1d9f3e63';
const NEWEST = 'aaaaaaaa-1111-4222-8333-444444444444';
const nowSec = () => Math.floor(Date.now() / 1000);

describe('SessionWatcher: sessions sharing a folder', () => {
  let root: string;
  let codeHome: string;
  let project: string;
  let dir: string;
  let children: ChildProcess[] = [];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-shared-'));
    codeHome = path.join(root, '.claude');
    project = path.join(root, 'apps');
    dir = path.join(codeHome, 'projects', encodeProjectDir(project));
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(dir, { recursive: true });
    mockRows.length = 0;
  });
  afterEach(() => {
    for (const c of children) c.kill('SIGKILL');
    children = [];
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A transcript in the current record shape, last written `ageSec` ago. */
  function transcript(id: string, text: string, ageSec: number): string {
    const file = path.join(dir, `${id}.jsonl`);
    const at = new Date(Date.now() - ageSec * 1000);
    const iso = at.toISOString();
    const lines = [
      { type: 'mode', mode: 'default', sessionId: id },
      { type: 'api-request-shape', sessionId: id },
      {
        type: 'user',
        uuid: `${id}-u`,
        timestamp: iso,
        sessionId: id,
        cwd: project,
        message: { role: 'user', content: text },
      },
      {
        type: 'assistant',
        uuid: `${id}-a`,
        timestamp: iso,
        sessionId: id,
        message: { role: 'assistant', content: [{ type: 'text', text: `reply to ${text}` }] },
      },
    ];
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    fs.utimesSync(file, at, at);
    return file;
  }

  function row(name: string, createdSec: number, panePid: number = process.pid) {
    return {
      name,
      sessionId: `$${name}`,
      created: String(createdSec),
      workingDir: project,
      panePid,
    };
  }

  function persist(mappings: Record<string, string>, history?: Record<string, string[]>) {
    fs.mkdirSync(codeHome, { recursive: true });
    fs.writeFileSync(
      path.join(codeHome, 'companion-session-mappings.json'),
      JSON.stringify({ mappings, history: history || {} })
    );
  }

  const texts = (w: SessionWatcher, s: string) => w.getFreshMessages(s).map((m) => m.content);

  it('a new session in the folder moves nothing onto old transcripts', async () => {
    transcript(OLD_A, 'old a', 4 * 86400);
    transcript(OLD_B, 'old b', 15 * 3600);
    transcript(LIVE, 'build a game', 10);
    mockRows.push(row('working', nowSec() - 3600));
    const w = new SessionWatcher(codeHome);
    await w.refreshTmuxPaths();
    (w as any).processFileChange(path.join(dir, `${LIVE}.jsonl`), LIVE);
    expect((w as any).tmuxConversationIds.get('working')).toBe(LIVE);
    // It compacted in place, so no continuation file will come.
    (w as any).compactedSessions.set('working', Date.now() - 1800_000);

    mockRows.push(row('fresh', nowSec()));
    w.markSessionAsNew('fresh');
    await w.refreshTmuxPaths();

    expect((w as any).tmuxConversationIds.get('working')).toBe(LIVE);
    expect((w as any).tmuxConversationIds.has('fresh')).toBe(false);
    expect(texts(w, 'working')).toContain('build a game');
    expect(w.getConversationChain('working')).toEqual([path.join(dir, `${LIVE}.jsonl`)]);
    expect(w.getFreshMessages('fresh')).toEqual([]);

    // Still nothing of anyone else's once the new-session guard has expired.
    (w as any).newlyCreatedSessions.clear();
    await w.refreshTmuxPaths();
    expect((w as any).tmuxConversationIds.has('fresh')).toBe(false);
    expect(w.getFreshMessages('fresh')).toEqual([]);

    // Its first prompt writes its own file, which it claims.
    const first = transcript(NEWEST, 'first prompt', 0);
    (w as any).processFileChange(first, NEWEST);
    expect((w as any).tmuxConversationIds.get('fresh')).toBe(NEWEST);
    expect(texts(w, 'fresh')).toContain('first prompt');
  });

  it('a continuation born after the compaction still extends the chain', async () => {
    const liveFile = transcript(LIVE, 'before compaction', 60);
    mockRows.push(row('a', nowSec() - 3600), row('b', nowSec() - 3600));
    transcript(OLD_B, 'b chat', 30);
    persist({ a: LIVE, b: OLD_B }, { a: [LIVE], b: [OLD_B] });
    const w = new SessionWatcher(codeHome);
    await w.refreshTmuxPaths();
    (w as any).compactedSessions.set('a', Date.now() - 5000);
    const next = transcript(NEWEST, 'after compaction', 0);
    (w as any).processFileChange(next, NEWEST);
    expect((w as any).tmuxConversationIds.get('a')).toBe(NEWEST);
    expect(w.getConversationChain('a')).toEqual([liveFile, next]);
  });

  it('heals persisted wrong mappings from the open tasks dir', async () => {
    transcript(OLD_A, 'old a', 4 * 86400);
    transcript(OLD_B, 'old b', 15 * 3600);
    transcript(LIVE, 'build a game', 10);
    persist({ working: OLD_A, fresh: OLD_B }, { working: [LIVE, OLD_A], fresh: [OLD_B] });
    const tasks = path.join(root, 'scratch', encodeProjectDir(project), LIVE, 'tasks');
    fs.mkdirSync(tasks, { recursive: true });
    const holder = spawn('bash', ['-c', 'exec 9<"$0"; exec sleep 30', tasks]);
    const idle = spawn('sleep', ['30']);
    children.push(holder, idle);
    await new Promise((r) => setTimeout(r, 150));
    mockRows.push(row('working', nowSec() - 3600, holder.pid!), row('fresh', nowSec() - 60, idle.pid!));

    const w = new SessionWatcher(codeHome);
    await w.refreshTmuxPaths();

    expect((w as any).tmuxConversationIds.get('working')).toBe(LIVE);
    expect((w as any).tmuxConversationIds.has('fresh')).toBe(false);
    expect(w.getConversationChain('working')).toEqual([path.join(dir, `${LIVE}.jsonl`)]);
    expect(texts(w, 'working')).toContain('build a game');
    expect(w.getFreshMessages('fresh')).toEqual([]);
  });

  it('reads a persisted mapping whose file is not in memory yet', async () => {
    transcript(OLD_A, 'idle chat', 3600);
    persist({ idle: OLD_A }, { idle: [OLD_A] });
    mockRows.push(row('idle', nowSec() - 7200));
    const w = new SessionWatcher(codeHome);
    await w.refreshTmuxPaths();
    expect(w.getConversationChain('idle')).toHaveLength(1);
    const statusEvents: unknown[] = [];
    w.on('status-change', (e) => statusEvents.push(e));
    expect(texts(w, 'idle')).toContain('idle chat');
    expect(w.getMessages('idle').length).toBeGreaterThan(0);
    expect(statusEvents).toEqual([]);
  });

  it('loads the mapped file on demand, not the newest in the folder', async () => {
    transcript(OLD_A, 'mine', 3600);
    transcript(OLD_B, 'a sibling, newer', 1800);
    persist({ idle: OLD_A }, { idle: [OLD_A] });
    mockRows.push(row('idle', nowSec() - 7200));
    const w = new SessionWatcher(codeHome);
    await w.refreshTmuxPaths();
    expect(w.ensureConversationLoaded('idle', { quiet: true })).toBe(true);
    expect(texts(w, 'idle')).toContain('mine');
  });
});
