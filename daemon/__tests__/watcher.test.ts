import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { exec } from 'child_process';

// Tmux session state for mock
const tmuxSessions: Map<string, { workingDir: string; tagged: boolean; created?: string; panePid?: number }> = new Map();

// Mock child_process with configurable tmux responses.
// Node's real exec has a custom promisify that returns { stdout, stderr }.
// We replicate this so promisify(exec) works correctly in the watcher.
jest.mock('child_process', () => {
  const { promisify } = require('util');

  function mockExec(cmd: string, cb: Function) {
    if (cmd.includes('list-sessions')) {
      const names = Array.from(tmuxSessions.keys()).join('\n');
      if (names) {
        cb(null, names, '');
      } else {
        cb(new Error('no tmux'), '', '');
      }
    } else if (cmd.includes('show-environment')) {
      const match = cmd.match(/-t "([^"]+)"/);
      const name = match?.[1];
      const session = name ? tmuxSessions.get(name) : undefined;
      if (session?.tagged) {
        cb(null, 'COMPANION_APP=1', '');
      } else {
        cb(null, '', '');
      }
    } else if (cmd.includes('display-message')) {
      const match = cmd.match(/-t "([^"]+)"/);
      const name = match?.[1];
      const session = name ? tmuxSessions.get(name) : undefined;
      if (session && cmd.includes('session_created')) {
        cb(null, `${session.workingDir}\t${session.created ?? ''}\t${session.panePid ?? ''}\n`, '');
      } else if (session) {
        cb(null, session.workingDir, '');
      } else {
        cb(new Error('no session'), '', '');
      }
    } else {
      cb(new Error('unknown command'), '', '');
    }
  }

  // Add custom promisify to match Node's exec behavior (returns { stdout, stderr })
  (mockExec as any)[promisify.custom] = (cmd: string) => {
    return new Promise((resolve, reject) => {
      mockExec(cmd, (err: Error | null, stdout: string, stderr: string) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    });
  };

  const fn = jest.fn(mockExec);
  // Copy the custom promisify symbol to the jest.fn wrapper
  (fn as any)[promisify.custom] = (mockExec as any)[promisify.custom];

  return { exec: fn };
});

// Mock chokidar
const mockWatcher = new EventEmitter();
(mockWatcher as any).close = jest.fn();
(mockWatcher as any).add = jest.fn();

jest.mock('chokidar', () => ({
  watch: jest.fn(() => mockWatcher),
}));

// Auto-mock fs, but ensure `promises` exists as a STABLE object at mock time.
// The watcher's `import * as fs` compiles to __importStar, which copies own
// properties into a per-module namespace object; if `promises` were undefined at
// import time the watcher would capture that undefined and never see a later
// reassignment. Defining it in the factory means every module shares the same
// promises object (and the same jest.fns), so beforeEach can configure them.
jest.mock('fs', () => {
  const automock = jest.createMockFromModule<typeof import('fs')>('fs') as any;
  automock.promises = {
    readFile: jest.fn(),
    stat: jest.fn(),
  };
  return automock;
});

import chokidar from 'chokidar';
import { SessionWatcher } from '../src/watcher';

const mockFs = fs as jest.Mocked<typeof fs>;
const mockChokidar = chokidar as jest.Mocked<typeof chokidar>;

// Helper: create a JSONL line from a message
function jsonlLine(msg: { type: string; message: { content: string }; uuid: string }): string {
  return JSON.stringify(msg);
}

// Helper: combine JSONL lines
function jsonlContent(...lines: string[]): string {
  return lines.join('\n');
}

// Standard test paths
const CODE_HOME = '/home/user/.claude';
const PROJECTS_DIR = `${CODE_HOME}/projects`;
const PROJECT_DIR_A = `${PROJECTS_DIR}/-home-user-project-a`;
const PROJECT_DIR_B = `${PROJECTS_DIR}/-home-user-project-b`;
const FILE_UUID_1 = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const FILE_UUID_2 = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const FILE_UUID_3 = 'c3d4e5f6-a7b8-9012-cdef-123456789012';
const FILE_A1 = `${PROJECT_DIR_A}/${FILE_UUID_1}.jsonl`;
const FILE_A2 = `${PROJECT_DIR_A}/${FILE_UUID_2}.jsonl`;
const FILE_B1 = `${PROJECT_DIR_B}/${FILE_UUID_3}.jsonl`;

// Tmux session names matching project directories
const TMUX_SESSION_A = 'companion-project-a';
const TMUX_SESSION_B = 'companion-project-b';

// Helper: add a tagged tmux session for a project
function addTmuxSession(name: string, workingDir: string) {
  tmuxSessions.set(name, { workingDir, tagged: true });
}

// Helper: start watcher ensuring tmux resolution completes.
// Fake timers can block the multi-step async refreshTmuxPaths,
// so we temporarily switch to real timers for startup.
async function startWatcher(w: SessionWatcher): Promise<void> {
  jest.useRealTimers();
  await w.start();
  // Give the async exec chain time to complete
  await new Promise(resolve => setTimeout(resolve, 50));
  jest.useFakeTimers();
}

describe('SessionWatcher', () => {
  let watcher: SessionWatcher;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    tmuxSessions.clear();
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue('');
    mockFs.statSync.mockReturnValue({ mtimeMs: Date.now(), birthtimeMs: Date.now(), isDirectory: () => false } as any);
    // The watcher now reads JSONL off the event loop via fs.promises in its
    // recurring hot paths. Delegate those to the synchronous mocks at call time
    // (do NOT reassign the promises object — modules share the reference captured
    // at import) so each test's readFileSync/statSync setup still applies.
    (mockFs.promises.readFile as jest.Mock).mockImplementation((...args: any[]) =>
      Promise.resolve((mockFs.readFileSync as any)(...args))
    );
    (mockFs.promises.stat as jest.Mock).mockImplementation((p: any) =>
      Promise.resolve((mockFs.statSync as any)(p))
    );
    watcher = new SessionWatcher(CODE_HOME);
  });

  afterEach(() => {
    watcher.stop();
    jest.useRealTimers();
  });

  // ========================================
  // Initialization
  // ========================================

  it('should initialize watcher for projects directory', async () => {
    await startWatcher(watcher);

    expect(mockChokidar.watch).toHaveBeenCalledWith(
      expect.stringContaining('projects'),
      expect.objectContaining({
        persistent: true,
        ignoreInitial: false,
        depth: 2,
      })
    );
  });

  // ========================================
  // Session tracking with tmux sessions
  // ========================================

  describe('session tracking', () => {
    it('should use tmux session name as session ID', async () => {
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      const content = jsonlLine({ type: 'user', message: { content: 'Hello' }, uuid: 'msg-1' });
      mockFs.readFileSync.mockReturnValue(content);

      await startWatcher(watcher);
      mockWatcher.emit('add', FILE_A1);
      await jest.advanceTimersByTimeAsync(200);

      const sessions = watcher.getSessions();
      expect(sessions.length).toBe(1);
      expect(sessions[0].id).toBe(TMUX_SESSION_A);
      expect(sessions[0].name).toBe(TMUX_SESSION_A);
    });

    it('should skip files outside projects directory', async () => {
      const content = jsonlLine({ type: 'user', message: { content: 'Hello' }, uuid: 'msg-1' });
      mockFs.readFileSync.mockReturnValue(content);

      await startWatcher(watcher);
      const updateSpy = jest.fn();
      watcher.on('conversation-update', updateSpy);

      // File directly in .claude root (not in projects/)
      mockWatcher.emit('add', '/home/user/.claude/history.jsonl');
      await jest.advanceTimersByTimeAsync(200);

      expect(updateSpy).not.toHaveBeenCalled();
    });
  });

  // ========================================
  // Multi-session per directory
  // ========================================

  describe('multi-session per directory', () => {
    it('should track conversations under same tmux session', async () => {
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      const content = jsonlLine({ type: 'user', message: { content: 'Hello' }, uuid: 'msg-1' });
      mockFs.readFileSync.mockReturnValue(content);

      await startWatcher(watcher);

      // Two different JSONL files in the same project directory
      mockWatcher.emit('add', FILE_A1);
      await jest.advanceTimersByTimeAsync(200);
      mockWatcher.emit('add', FILE_A2);
      await jest.advanceTimersByTimeAsync(200);

      const sessions = watcher.getSessions();
      // Both files map to the same tmux session, so only 1 session entry
      expect(sessions.length).toBe(1);
      expect(sessions[0].id).toBe(TMUX_SESSION_A);
    });

    it('should separate sessions from different project directories', async () => {
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      addTmuxSession(TMUX_SESSION_B, '/home/user/project-b');
      const content = jsonlLine({ type: 'user', message: { content: 'Hello' }, uuid: 'msg-1' });
      mockFs.readFileSync.mockReturnValue(content);

      await startWatcher(watcher);
      mockWatcher.emit('add', FILE_A1);
      await jest.advanceTimersByTimeAsync(200);
      mockWatcher.emit('add', FILE_B1);
      await jest.advanceTimersByTimeAsync(200);

      const sessions = watcher.getSessions();
      expect(sessions.length).toBe(2);

      const names = sessions.map(s => s.id);
      expect(names).toContain(TMUX_SESSION_A);
      expect(names).toContain(TMUX_SESSION_B);
    });
  });

  // ========================================
  // File change events
  // ========================================

  describe('file change events', () => {
    it('should emit conversation-update event on file change', async () => {
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      mockFs.readFileSync.mockReturnValue(
        jsonlLine({ type: 'assistant', message: { content: 'Hello' }, uuid: 'msg-1' })
      );

      await startWatcher(watcher);
      const updateSpy = jest.fn();
      watcher.on('conversation-update', updateSpy);

      mockWatcher.emit('change', FILE_A1);
      await jest.advanceTimersByTimeAsync(200);

      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ path: FILE_A1 })
      );
    });

    it('should emit conversation-update event on file add', async () => {
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      mockFs.readFileSync.mockReturnValue(
        jsonlLine({ type: 'user', message: { content: 'Hi' }, uuid: 'msg-1' })
      );

      await startWatcher(watcher);
      const updateSpy = jest.fn();
      watcher.on('conversation-update', updateSpy);

      mockWatcher.emit('add', FILE_A1);
      await jest.advanceTimersByTimeAsync(200);

      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ messages: expect.anything() })
      );
    });

    it('should debounce rapid file changes', async () => {
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      const content1 = jsonlLine({ type: 'user', message: { content: 'msg1' }, uuid: 'msg-1' });
      const content2 = jsonlContent(
        jsonlLine({ type: 'user', message: { content: 'msg1' }, uuid: 'msg-1' }),
        jsonlLine({ type: 'assistant', message: { content: 'reply' }, uuid: 'msg-2' })
      );

      await startWatcher(watcher);
      const updateSpy = jest.fn();
      watcher.on('conversation-update', updateSpy);

      // Rapid changes - only the last should process
      mockFs.readFileSync.mockReturnValue(content1);
      mockWatcher.emit('change', FILE_A1);
      await jest.advanceTimersByTimeAsync(50); // Less than debounce (150ms)

      mockFs.readFileSync.mockReturnValue(content2);
      mockWatcher.emit('change', FILE_A1);
      await jest.advanceTimersByTimeAsync(200); // Past debounce

      // Should process only once (debounced)
      expect(updateSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ========================================
  // Session switching
  // ========================================

  describe('session switching', () => {
    beforeEach(async () => {
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      addTmuxSession(TMUX_SESSION_B, '/home/user/project-b');
      const content = jsonlLine({ type: 'user', message: { content: 'Hello' }, uuid: 'msg-1' });
      mockFs.readFileSync.mockReturnValue(content);

      await startWatcher(watcher);
      mockWatcher.emit('add', FILE_A1);
      await jest.advanceTimersByTimeAsync(200);
      mockWatcher.emit('add', FILE_B1);
      await jest.advanceTimersByTimeAsync(200);
    });

    it('should switch active session by tmux name', () => {
      const switched = watcher.setActiveSession(TMUX_SESSION_B);
      expect(switched).toBe(true);
      expect(watcher.getActiveSessionId()).toBe(TMUX_SESSION_B);
    });

    it('should return false for non-existent session', () => {
      const switched = watcher.setActiveSession('non-existent-session');
      expect(switched).toBe(false);
    });

    it('should return messages for active session', () => {
      watcher.setActiveSession(TMUX_SESSION_A);
      const messages = watcher.getMessages();
      expect(messages).toBeDefined();
      expect(messages.length).toBeGreaterThanOrEqual(1);
    });

    it('should return messages for specific session ID', () => {
      watcher.setActiveSession(TMUX_SESSION_A);
      const messages = watcher.getMessages(TMUX_SESSION_B);
      expect(messages).toBeDefined();
    });
  });

  // ========================================
  // Status detection
  // ========================================

  describe('status detection', () => {
    it('should get status from current conversation', async () => {
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      mockFs.readFileSync.mockReturnValue(
        jsonlContent(
          jsonlLine({ type: 'user', message: { content: 'Hello' }, uuid: 'msg-1' }),
          jsonlLine({ type: 'assistant', message: { content: 'Hi there!' }, uuid: 'msg-2' })
        )
      );

      await startWatcher(watcher);
      mockWatcher.emit('add', FILE_A1);
      await jest.advanceTimersByTimeAsync(200);

      const status = watcher.getStatus();
      expect(status.isRunning).toBe(true);
      expect(status.conversationId).toBeDefined();
    });

    it('should detect waiting for input state', async () => {
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      mockFs.readFileSync.mockReturnValue(
        jsonlLine({ type: 'assistant', message: { content: 'What would you like me to do?' }, uuid: 'msg-1' })
      );

      await startWatcher(watcher);
      mockWatcher.emit('add', FILE_A1);
      await jest.advanceTimersByTimeAsync(200);

      expect(watcher.isWaiting()).toBe(true);
    });

    it('should not be waiting when assistant is working', async () => {
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      mockFs.readFileSync.mockReturnValue(
        jsonlLine({ type: 'user', message: { content: 'Do something' }, uuid: 'msg-1' })
      );

      await startWatcher(watcher);
      mockWatcher.emit('add', FILE_A1);
      await jest.advanceTimersByTimeAsync(200);

      expect(watcher.isWaiting()).toBe(false);
    });

    it('should emit status-change when waiting state changes', async () => {
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      await startWatcher(watcher);
      const statusSpy = jest.fn();
      watcher.on('status-change', statusSpy);

      // First message - user sent, not waiting
      mockFs.readFileSync.mockReturnValue(
        jsonlLine({ type: 'user', message: { content: 'Do something' }, uuid: 'msg-1' })
      );
      mockWatcher.emit('add', FILE_A1);
      await jest.advanceTimersByTimeAsync(200);

      // Second message - assistant replies, now waiting
      mockFs.readFileSync.mockReturnValue(
        jsonlContent(
          jsonlLine({ type: 'user', message: { content: 'Do something' }, uuid: 'msg-1' }),
          jsonlLine({ type: 'assistant', message: { content: 'What do you want?' }, uuid: 'msg-2' })
        )
      );
      mockWatcher.emit('change', FILE_A1);
      await jest.advanceTimersByTimeAsync(200);

      expect(statusSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('error-detected (turn ended on an unresolved error)', () => {
    const J = (o: unknown) => JSON.stringify(o);
    const prompt = J({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'run the tests' } });
    const call = (id: string, command: string) =>
      J({
        type: 'assistant',
        uuid: `a-${id}`,
        message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
      });
    const result = (id: string, content: string, isError: boolean) =>
      J({
        type: 'user',
        uuid: `r-${id}`,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] },
      });
    const final = (text: string) =>
      J({ type: 'assistant', uuid: 'a-final', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } });

    async function feed(content: string) {
      mockFs.readFileSync.mockReturnValue(content);
      mockWatcher.emit('change', FILE_A1);
      await jest.advanceTimersByTimeAsync(200);
    }

    it('emits once when the turn ends on an error, with a redacted tool + line preview', async () => {
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      await startWatcher(watcher);
      const spy = jest.fn();
      watcher.on('error-detected', spy);

      await feed(prompt);
      await feed(jsonlContent(prompt, call('t1', 'npm test')));
      await feed(jsonlContent(prompt, call('t1', 'npm test'), result('t1', 'Exit code 1\nFAIL auth.test.ts', true)));
      expect(spy).not.toHaveBeenCalled(); // mid-turn: Claude is still going
      const ended = jsonlContent(
        prompt,
        call('t1', 'npm test'),
        result('t1', 'Exit code 1\nFAIL auth.test.ts', true),
        final('The auth test still fails.')
      );
      await feed(ended);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: TMUX_SESSION_A,
          content: 'Bash: FAIL auth.test.ts',
          tool: 'Bash',
          line: 'FAIL auth.test.ts',
        })
      );
      // The same ended turn re-read (another write, a poll) does not re-notify.
      await feed(ended + '\n');
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('stays silent for an error Claude recovered from', async () => {
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      await startWatcher(watcher);
      const spy = jest.fn();
      watcher.on('error-detected', spy);

      await feed(prompt);
      await feed(
        jsonlContent(
          prompt,
          call('t1', 'npm test'),
          result('t1', 'Exit code 1\nFAIL auth.test.ts', true),
          call('t2', 'npm test'),
          result('t2', 'PASS auth.test.ts', false),
          final('Fixed: the auth tests pass now.')
        )
      );
      expect(spy).not.toHaveBeenCalled();
    });

    it('does not replay an old errored turn the first time a file is seen', async () => {
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      await startWatcher(watcher);
      const spy = jest.fn();
      watcher.on('error-detected', spy);
      await feed(jsonlContent(prompt, call('t1', 'make'), result('t1', 'Exit code 2\nmake: *** error', true), final('The build failed.')));
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // ========================================
  // Conversation chain (single file per session)
  // ========================================

  describe('conversation chain', () => {
    it('should return single file for session', async () => {
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      const content = jsonlLine({ type: 'user', message: { content: 'Hello' }, uuid: 'msg-1' });
      mockFs.readFileSync.mockReturnValue(content);

      await startWatcher(watcher);
      mockWatcher.emit('add', FILE_A1);
      await jest.advanceTimersByTimeAsync(200);

      const chain = watcher.getConversationChain(TMUX_SESSION_A);
      expect(chain).toEqual([FILE_A1]);
    });

    it('should return empty for non-existent session', async () => {
      await startWatcher(watcher);
      const chain = watcher.getConversationChain('non-existent');
      expect(chain).toEqual([]);
    });
  });

  // ========================================
  // Server summary
  // ========================================

  describe('server summary', () => {
    it('should return sessions in server summary', async () => {
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      addTmuxSession(TMUX_SESSION_B, '/home/user/project-b');
      const content = jsonlLine({ type: 'user', message: { content: 'Hello' }, uuid: 'msg-1' });
      mockFs.readFileSync.mockReturnValue(content);

      await startWatcher(watcher);
      mockWatcher.emit('add', FILE_A1);
      await jest.advanceTimersByTimeAsync(200);
      mockWatcher.emit('add', FILE_B1);
      await jest.advanceTimersByTimeAsync(200);

      const summary = await watcher.getServerSummary();
      expect(summary.sessions.length).toBe(2);
      expect(summary.totalSessions).toBe(2);
    });

    it('should include projectPath in session summaries', async () => {
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      const content = jsonlLine({ type: 'user', message: { content: 'Hello' }, uuid: 'msg-1' });
      mockFs.readFileSync.mockReturnValue(content);

      await startWatcher(watcher);
      mockWatcher.emit('add', FILE_A1);
      await jest.advanceTimersByTimeAsync(200);

      const summary = await watcher.getServerSummary();
      expect(summary.sessions[0].projectPath).toBeDefined();
      expect(summary.sessions[0].projectPath.length).toBeGreaterThan(0);
    });

    it('should use tmux session name as session ID in summaries', async () => {
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      const content = jsonlLine({ type: 'user', message: { content: 'Hello' }, uuid: 'msg-1' });
      mockFs.readFileSync.mockReturnValue(content);

      await startWatcher(watcher);
      mockWatcher.emit('add', FILE_A1);
      await jest.advanceTimersByTimeAsync(200);

      const summary = await watcher.getServerSummary();
      expect(summary.sessions[0].id).toBe(TMUX_SESSION_A);
    });

    it('should filter sessions by tmux when sessions provided', async () => {
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      addTmuxSession(TMUX_SESSION_B, '/home/user/project-b');
      const content = jsonlLine({ type: 'user', message: { content: 'Hello' }, uuid: 'msg-1' });
      mockFs.readFileSync.mockReturnValue(content);

      await startWatcher(watcher);
      mockWatcher.emit('add', FILE_A1);
      await jest.advanceTimersByTimeAsync(200);
      mockWatcher.emit('add', FILE_B1);
      await jest.advanceTimersByTimeAsync(200);

      // Only provide tmux session for project A
      const tmuxFilter = [{
        name: TMUX_SESSION_A,
        windows: 1,
        attached: false,
        tagged: true,
        workingDir: '/home/user/project-a',
      }];

      const summary = await watcher.getServerSummary(tmuxFilter);
      expect(summary.sessions.length).toBe(1);
      expect(summary.sessions[0].id).toBe(TMUX_SESSION_A);
    });

    it('should count waiting and working sessions', async () => {
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      addTmuxSession(TMUX_SESSION_B, '/home/user/project-b');
      await startWatcher(watcher);

      // Session 1: assistant waiting
      mockFs.readFileSync.mockReturnValue(
        jsonlLine({ type: 'assistant', message: { content: 'What next?' }, uuid: 'msg-1' })
      );
      mockWatcher.emit('add', FILE_A1);
      await jest.advanceTimersByTimeAsync(200);

      // Session 2: user sent, assistant working
      mockFs.readFileSync.mockReturnValue(
        jsonlLine({ type: 'user', message: { content: 'Do something' }, uuid: 'msg-2' })
      );
      mockWatcher.emit('add', FILE_B1);
      await jest.advanceTimersByTimeAsync(200);

      const summary = await watcher.getServerSummary();
      expect(summary.waitingCount).toBe(1);
      expect(summary.workingCount).toBe(1);
    });
  });

  // ========================================
  // tmux filtering
  // ========================================

  describe('tmux session filtering', () => {
    it('should track conversations when matching tmux sessions exist', async () => {
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      const content = jsonlLine({ type: 'user', message: { content: 'Hello' }, uuid: 'msg-1' });
      mockFs.readFileSync.mockReturnValue(content);

      await startWatcher(watcher);
      mockWatcher.emit('add', FILE_A1);
      await jest.advanceTimersByTimeAsync(200);

      const sessions = watcher.getSessions();
      expect(sessions.length).toBe(1);
    });

    it('should not expose sessions without matching tmux session', async () => {
      // No tmux sessions set up
      const content = jsonlLine({ type: 'user', message: { content: 'Hello' }, uuid: 'msg-1' });
      mockFs.readFileSync.mockReturnValue(content);

      await startWatcher(watcher);
      mockWatcher.emit('add', FILE_A1);
      await jest.advanceTimersByTimeAsync(200);

      // Conversations are tracked internally but not exposed without tmux
      const sessions = watcher.getSessions();
      expect(sessions.length).toBe(0);
    });
  });

  describe('project paths with dots', () => {
    it('links a session whose cwd contains a dot to its transcript dir', async () => {
      const dotDir = '/home/user/.cache/proj_x';
      addTmuxSession('dot-sess', dotDir);
      const content = jsonlLine({ type: 'user', message: { content: 'Hello' }, uuid: 'msg-1' });
      mockFs.readFileSync.mockReturnValue(content);

      await startWatcher(watcher);
      mockWatcher.emit('add', `${PROJECTS_DIR}/-home-user--cache-proj-x/${FILE_UUID_1}.jsonl`);
      await jest.advanceTimersByTimeAsync(200);

      const sessions = watcher.getSessions();
      expect(sessions.map((s) => s.id)).toEqual(['dot-sess']);
      expect(sessions[0].projectPath).toBe(dotDir);
    });
  });

  describe('reused tmux session names', () => {
    const MAPPINGS = `${CODE_HOME}/companion-session-mappings.json`;
    function persisted(identity: Record<string, unknown>) {
      const content = jsonlLine({ type: 'user', message: { content: 'Hello' }, uuid: 'msg-1' });
      mockFs.readFileSync.mockImplementation(((p: any) =>
        String(p) === MAPPINGS
          ? JSON.stringify({
              mappings: { [TMUX_SESSION_A]: FILE_UUID_1 },
              history: { [TMUX_SESSION_A]: [FILE_UUID_1] },
              identity: { [TMUX_SESSION_A]: identity },
            })
          : content) as any);
    }
    const ids = (w: SessionWatcher) => (w as any).tmuxConversationIds as Map<string, string>;
    async function restart() {
      watcher.stop();
      watcher = new SessionWatcher(CODE_HOME);
      await startWatcher(watcher);
    }

    it('keeps the mapping while the same tmux session runs', async () => {
      persisted({ created: '1700000000', panePid: 4242, encodedPath: '-home-user-project-a', claudePid: null });
      tmuxSessions.set(TMUX_SESSION_A, { workingDir: '/home/user/project-a', tagged: true, created: '1700000000', panePid: 4242 });
      await restart();
      expect(ids(watcher).get(TMUX_SESSION_A)).toBe(FILE_UUID_1);
    });

    it('drops the stale mapping when a session with the same name was created again', async () => {
      persisted({ created: '1700000000', panePid: 4242, encodedPath: '-home-user-project-a', claudePid: null });
      tmuxSessions.set(TMUX_SESSION_A, { workingDir: '/home/user/project-b', tagged: true, created: String(Math.floor(Date.now() / 1000)), panePid: 5151 });
      await restart();
      expect(ids(watcher).has(TMUX_SESSION_A)).toBe(false);
      // Treated as new: no path fallback to an older transcript until its own appears.
      expect((watcher as any).newlyCreatedSessions.has(TMUX_SESSION_A)).toBe(true);
    });

    it('markSessionAsNew (app spawn with a reused name) clears the old mapping', async () => {
      persisted({ created: '1700000000', panePid: 4242, encodedPath: '-home-user-project-a', claudePid: null });
      tmuxSessions.set(TMUX_SESSION_A, { workingDir: '/home/user/project-a', tagged: true, created: '1700000000', panePid: 4242 });
      await restart();
      expect(ids(watcher).get(TMUX_SESSION_A)).toBe(FILE_UUID_1);
      watcher.markSessionAsNew(TMUX_SESSION_A);
      expect(ids(watcher).has(TMUX_SESSION_A)).toBe(false);
      expect((watcher as any).tmuxConversationHistory.has(TMUX_SESSION_A)).toBe(false);
    });
  });

  // A `/login` (or any directly-run command) run inside a live claude writes
  // its own short transcript while the conversation goes on in the old file.
  // Observed 2026-10-02: the mapping flipped to that file and back, history
  // ended up [main, login], and the chain rendered the login file (with a
  // "Previous session" divider) AFTER the newest message.
  describe('chain ordering with side transcripts', () => {
    const MAPPINGS = `${CODE_HOME}/companion-session-mappings.json`;
    const FILE_A3 = `${PROJECT_DIR_A}/${FILE_UUID_3}.jsonl`;
    const line = (o: object) => JSON.stringify(o);
    const conv = (startIso: string, text: string) =>
      [
        line({ type: 'user', message: { content: `${text} prompt` }, uuid: `${text}-u`, timestamp: startIso }),
        line({ type: 'assistant', message: { content: `${text} reply` }, uuid: `${text}-a`, timestamp: startIso }),
      ].join('\n');
    const LOGIN = [
      line({ type: 'mode', mode: 'normal', sessionId: FILE_UUID_2 }),
      line({
        type: 'user',
        isMeta: true,
        message: { role: 'user', content: '<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request, and its output goes straight to the user.</local-command-caveat>' },
        uuid: 'cav',
        timestamp: '2026-10-02T05:32:04.041Z',
      }),
      line({
        type: 'user',
        message: { role: 'user', content: '<command-name>/login</command-name>\n            <command-message>login</command-message>\n            <command-args></command-args>' },
        uuid: 'cmd',
        timestamp: '2026-10-02T05:32:04.040Z',
      }),
      line({
        type: 'user',
        message: { role: 'user', content: '<local-command-stdout>Login successful</local-command-stdout>' },
        uuid: 'out',
        timestamp: '2026-10-02T05:32:04.040Z',
      }),
    ].join('\n');

    let files: Record<string, string>;
    function serve(extra: Record<string, string> = {}) {
      files = { ...extra };
      const fds = new Map<number, string>();
      let nextFd = 100;
      mockFs.readFileSync.mockImplementation(((p: any) => {
        const f = files[String(p)];
        if (f === undefined) throw new Error('ENOENT');
        return f;
      }) as any);
      mockFs.existsSync.mockImplementation(((p: any) => String(p) in files || !String(p).endsWith('.jsonl')) as any);
      mockFs.openSync.mockImplementation(((p: any) => {
        if (!(String(p) in files)) throw new Error('ENOENT');
        fds.set(nextFd, String(p));
        return nextFd++;
      }) as any);
      mockFs.readSync.mockImplementation(((fd: number, buf: Buffer, off: number, len: number, pos: number) => {
        const data = Buffer.from(files[fds.get(fd) || ''] || '', 'utf-8');
        return data.copy(buf, off, pos, Math.min(data.length, pos + len));
      }) as any);
    }
    const ids = (w: SessionWatcher) => (w as any).tmuxConversationIds as Map<string, string>;
    const hist = (w: SessionWatcher) => (w as any).tmuxConversationHistory as Map<string, string[]>;

    it('a login-only transcript never takes over the mapping or joins the chain', async () => {
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      serve({ [FILE_A1]: conv('2026-09-30T07:00:51.344Z', 'main') });
      await startWatcher(watcher);
      mockWatcher.emit('add', FILE_A1);
      await jest.advanceTimersByTimeAsync(200);
      expect(ids(watcher).get(TMUX_SESSION_A)).toBe(FILE_UUID_1);

      files[FILE_A2] = LOGIN;
      mockWatcher.emit('add', FILE_A2);
      await jest.advanceTimersByTimeAsync(200);
      expect(ids(watcher).get(TMUX_SESSION_A)).toBe(FILE_UUID_1);

      files[FILE_A1] += '\n' + line({ type: 'user', message: { content: 'keep going' }, uuid: 'u2', timestamp: '2026-10-02T05:32:20.000Z' });
      mockWatcher.emit('change', FILE_A1);
      await jest.advanceTimersByTimeAsync(200);
      expect(watcher.getConversationChain(TMUX_SESSION_A)).toEqual([FILE_A1]);
    });

    it('a re-detected mapping moves to the end of history', async () => {
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      serve({});
      await startWatcher(watcher);
      (watcher as any).setConversationMapping(TMUX_SESSION_A, FILE_UUID_1);
      (watcher as any).setConversationMapping(TMUX_SESSION_A, FILE_UUID_2);
      (watcher as any).setConversationMapping(TMUX_SESSION_A, FILE_UUID_1);
      expect(hist(watcher).get(TMUX_SESSION_A)).toEqual([FILE_UUID_2, FILE_UUID_1]);
    });

    it('migrates the observed scrambled mapping on restart: the newest message stays last', async () => {
      serve({
        [MAPPINGS]: JSON.stringify({
          mappings: { [TMUX_SESSION_A]: FILE_UUID_1 },
          history: { [TMUX_SESSION_A]: [FILE_UUID_1, FILE_UUID_2, FILE_UUID_1] },
        }),
        [FILE_A1]: conv('2026-09-30T07:00:51.344Z', 'main'),
        [FILE_A2]: LOGIN,
      });
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      watcher.stop();
      watcher = new SessionWatcher(CODE_HOME);
      expect(hist(watcher).get(TMUX_SESSION_A)).toEqual([FILE_UUID_2, FILE_UUID_1]);
      await startWatcher(watcher);
      expect(ids(watcher).get(TMUX_SESSION_A)).toBe(FILE_UUID_1);
      expect(watcher.getConversationChain(TMUX_SESSION_A)).toEqual([FILE_A1]);
    });

    it('orders a compaction chain by first entry, not by history order', async () => {
      serve({
        [MAPPINGS]: JSON.stringify({
          mappings: { [TMUX_SESSION_A]: FILE_UUID_3 },
          history: { [TMUX_SESSION_A]: [FILE_UUID_3, FILE_UUID_2, FILE_UUID_1] },
        }),
        [FILE_A1]: conv('2026-09-01T00:00:00.000Z', 'first'),
        [FILE_A2]: conv('2026-09-02T00:00:00.000Z', 'second'),
        [FILE_A3]: conv('2026-09-03T00:00:00.000Z', 'third'),
      });
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      watcher.stop();
      watcher = new SessionWatcher(CODE_HOME);
      await startWatcher(watcher);
      expect(watcher.getConversationChain(TMUX_SESSION_A)).toEqual([FILE_A1, FILE_A2, FILE_A3]);
    });
  });

  // ========================================
  // Stop / cleanup
  // ========================================

  describe('lifecycle', () => {
    it('should stop watching on stop()', async () => {
      await startWatcher(watcher);
      watcher.stop();
      expect((mockWatcher as any).close).toHaveBeenCalled();
    });

    it('should clear active session', async () => {
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      const content = jsonlLine({ type: 'user', message: { content: 'Hello' }, uuid: 'msg-1' });
      mockFs.readFileSync.mockReturnValue(content);

      await startWatcher(watcher);
      mockWatcher.emit('add', FILE_A1);
      await jest.advanceTimersByTimeAsync(200);

      expect(watcher.getActiveSessionId()).toBe(TMUX_SESSION_A);

      watcher.clearActiveSession();
      expect(watcher.getActiveSessionId()).toBeNull();
    });
  });

  // ========================================
  // Active conversation
  // ========================================

  describe('active conversation', () => {
    it('should return null when no active session', async () => {
      await startWatcher(watcher);
      expect(watcher.getActiveConversation()).toBeNull();
    });

    it('should return conversation file info for active session', async () => {
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      const content = jsonlLine({ type: 'user', message: { content: 'Hello' }, uuid: 'msg-1' });
      mockFs.readFileSync.mockReturnValue(content);

      await startWatcher(watcher);
      mockWatcher.emit('add', FILE_A1);
      await jest.advanceTimersByTimeAsync(200);

      const conv = watcher.getActiveConversation();
      expect(conv).not.toBeNull();
      expect(conv!.path).toBe(FILE_A1);
      expect(conv!.projectPath).toBeDefined();
    });
  });

  // ========================================
  // Edge cases
  // ========================================

  describe('edge cases', () => {
    it('should handle empty JSONL file', async () => {
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      mockFs.readFileSync.mockReturnValue('');

      await startWatcher(watcher);
      mockWatcher.emit('add', FILE_A1);
      await jest.advanceTimersByTimeAsync(200);

      // Should not crash, session may or may not be tracked
      const messages = watcher.getMessages();
      expect(messages).toBeDefined();
    });

    it('should handle malformed JSONL content', async () => {
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      mockFs.readFileSync.mockReturnValue('not valid json\nstill not valid');

      await startWatcher(watcher);

      // Should not throw
      await expect(
        (async () => {
          mockWatcher.emit('add', FILE_A1);
          await jest.advanceTimersByTimeAsync(200);
        })()
      ).resolves.not.toThrow();
    });

    it('should auto-set first added session as active', async () => {
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      const content = jsonlLine({ type: 'user', message: { content: 'Hello' }, uuid: 'msg-1' });
      mockFs.readFileSync.mockReturnValue(content);

      await startWatcher(watcher);
      expect(watcher.getActiveSessionId()).toBeNull();

      mockWatcher.emit('add', FILE_A1);
      await jest.advanceTimersByTimeAsync(200);

      // First session should become active automatically
      expect(watcher.getActiveSessionId()).toBe(TMUX_SESSION_A);
    });

    it('should handle subagent files gracefully', async () => {
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      const content = jsonlLine({ type: 'user', message: { content: 'Hello' }, uuid: 'msg-1' });
      mockFs.readFileSync.mockReturnValue(content);

      await startWatcher(watcher);
      const updateSpy = jest.fn();
      watcher.on('conversation-update', updateSpy);

      // Subagent files are in a subdirectory
      mockWatcher.emit('add', `${PROJECT_DIR_A}/subagents/${FILE_UUID_1}.jsonl`);
      await jest.advanceTimersByTimeAsync(200);

      // Subagent files should not trigger conversation updates
      expect(updateSpy).not.toHaveBeenCalled();
    });
  });

  // ========================================
  // Session-conversation mapping persistence
  // ========================================

  describe('quiet on-demand loads (Herald)', () => {
    const waitingContent = jsonlLine({
      type: 'assistant',
      message: { content: 'Which approach should I take?' },
      uuid: 'msg-1',
    });

    function spyAll(w: SessionWatcher) {
      const seen: string[] = [];
      for (const ev of ['status-change', 'conversation-update', 'other-session-activity', 'pending-approval', 'compaction', 'session-completed', 'error-detected']) {
        w.on(ev, () => seen.push(ev));
      }
      return seen;
    }

    it('ensureConversationLoaded({ quiet }) caches the transcript but emits nothing', async () => {
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      await startWatcher(watcher);
      const seen = spyAll(watcher);
      mockFs.readdirSync.mockReturnValue([`${FILE_UUID_1}.jsonl`] as any);
      mockFs.readFileSync.mockReturnValue(waitingContent);

      expect(watcher.ensureConversationLoaded(TMUX_SESSION_A, { quiet: true })).toBe(true);
      await jest.advanceTimersByTimeAsync(5000);

      expect(watcher.getMessages(TMUX_SESSION_A).length).toBeGreaterThan(0);
      expect(seen).toEqual([]);
    });

    it('a non-quiet load of the same transcript still emits (unchanged default)', async () => {
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      await startWatcher(watcher);
      const seen = spyAll(watcher);
      mockFs.readdirSync.mockReturnValue([`${FILE_UUID_1}.jsonl`] as any);
      mockFs.readFileSync.mockReturnValue(waitingContent);

      expect(watcher.ensureConversationLoaded(TMUX_SESSION_A)).toBe(true);
      expect(seen).toContain('status-change');
    });
  });

  describe('read-only shared state (sandbox)', () => {
    const MAPPINGS_PATH = `${CODE_HOME}/companion-session-mappings.json`;
    const SNAPSHOT_PATH = `${CODE_HOME}/companion-sessions-snapshot.json`;
    afterEach(() => {
      delete process.env.COMPANION_READONLY_SHARED_STATE;
      delete process.env.COMPANION_SANDBOX;
    });

    it.each([['COMPANION_READONLY_SHARED_STATE'], ['COMPANION_SANDBOX']])(
      '%s=1 never writes the shared mappings / snapshot files',
      async (envVar) => {
        process.env[envVar] = '1';
        addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
        mockFs.readFileSync.mockReturnValue(
          jsonlLine({ type: 'user', message: { content: 'Hello' }, uuid: 'msg-1' })
        );
        await startWatcher(watcher);
        mockWatcher.emit('add', FILE_A1);
        await jest.advanceTimersByTimeAsync(200);
        jest.useRealTimers();
        await (watcher as any).refreshTmuxPaths();
        jest.useFakeTimers();
        watcher.persistSessions();

        const written = [...mockFs.renameSync.mock.calls.map((c) => c[1]), ...mockFs.writeFileSync.mock.calls.map((c) => c[0])];
        expect(written).not.toContain(MAPPINGS_PATH);
        expect(written).not.toContain(SNAPSHOT_PATH);
      }
    );

    it('writes them normally when the switch is off', async () => {
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      mockFs.readFileSync.mockReturnValue('[]');
      await startWatcher(watcher);
      watcher.persistSessions();
      expect(mockFs.renameSync.mock.calls.map((c) => c[1])).toContain(SNAPSHOT_PATH);
    });
  });

  describe('mapping persistence', () => {
    const MAPPINGS_PATH = `${CODE_HOME}/companion-session-mappings.json`;
    const TMUX_A1 = 'companion-project-a-1';
    const TMUX_A2 = 'companion-project-a-2';

    it('should load persisted mappings on construction', () => {
      const persistedMappings = { [TMUX_A1]: FILE_UUID_1, [TMUX_A2]: FILE_UUID_2 };
      mockFs.readFileSync.mockImplementation((p: any) => {
        if (typeof p === 'string' && p.includes('companion-session-mappings.json')) {
          return JSON.stringify(persistedMappings);
        }
        return '';
      });

      const w = new SessionWatcher(CODE_HOME);
      const mappings = (w as any).tmuxConversationIds as Map<string, string>;
      expect(mappings.get(TMUX_A1)).toBe(FILE_UUID_1);
      expect(mappings.get(TMUX_A2)).toBe(FILE_UUID_2);
      w.stop();
    });

    it('should not crash if no persisted mappings file exists', () => {
      mockFs.readFileSync.mockImplementation((p: any) => {
        if (typeof p === 'string' && p.includes('companion-session-mappings.json')) {
          throw new Error('ENOENT');
        }
        return '';
      });

      expect(() => {
        const w = new SessionWatcher(CODE_HOME);
        w.stop();
      }).not.toThrow();
    });

    it('should persist mappings when they change', async () => {
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      const content = jsonlLine({ type: 'user', message: { content: 'Hello' }, uuid: 'msg-1' });
      mockFs.readFileSync.mockReturnValue(content);

      await startWatcher(watcher);
      mockWatcher.emit('add', FILE_A1);
      await jest.advanceTimersByTimeAsync(200);

      // Trigger the periodic 5s refreshTmuxPaths which calls refreshConversationMappings
      // which calls persistMappings when the mapping log key changes
      jest.useRealTimers();
      // Manually trigger the refresh cycle
      await (watcher as any).refreshTmuxPaths();
      jest.useFakeTimers();

      // persistMappings uses atomicWriteFileSync: write to tmp, then rename to MAPPINGS_PATH.
      expect(mockFs.renameSync).toHaveBeenCalledWith(
        expect.any(String),
        MAPPINGS_PATH
      );
    });

    it('should not prune persisted mappings when JSONL file exists on disk', async () => {
      // Load persisted mappings
      const persistedMappings = { [TMUX_SESSION_A]: FILE_UUID_1 };
      mockFs.readFileSync.mockImplementation((p: any) => {
        if (typeof p === 'string' && p.includes('companion-session-mappings.json')) {
          return JSON.stringify(persistedMappings);
        }
        return '';
      });
      mockFs.existsSync.mockReturnValue(true);

      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      const w = new SessionWatcher(CODE_HOME);

      // After construction + refreshTmuxPaths, mapping should survive
      jest.useRealTimers();
      await new Promise(resolve => setTimeout(resolve, 100));
      jest.useFakeTimers();

      const mappings = (w as any).tmuxConversationIds as Map<string, string>;
      expect(mappings.get(TMUX_SESSION_A)).toBe(FILE_UUID_1);
      w.stop();
    });

    it('should prune persisted mappings when JSONL file is deleted', async () => {
      const persistedMappings = { [TMUX_SESSION_A]: FILE_UUID_1 };
      mockFs.readFileSync.mockImplementation((p: any) => {
        if (typeof p === 'string' && p.includes('companion-session-mappings.json')) {
          return JSON.stringify(persistedMappings);
        }
        return '';
      });
      // JSONL file does NOT exist on disk
      mockFs.existsSync.mockImplementation((p: any) => {
        if (typeof p === 'string' && p.endsWith('.jsonl')) return false;
        return true;
      });

      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      const w = new SessionWatcher(CODE_HOME);

      jest.useRealTimers();
      await new Promise(resolve => setTimeout(resolve, 100));
      jest.useFakeTimers();

      const mappings = (w as any).tmuxConversationIds as Map<string, string>;
      expect(mappings.has(TMUX_SESSION_A)).toBe(false);
      w.stop();
    });
  });

  // ========================================
  // Newly created session guard
  // ========================================

  describe('newly created session guard', () => {
    it('should prevent stale conversation mapping for new sessions (shared path)', async () => {
      // Two sessions sharing the same project directory
      const TMUX_EXISTING = 'companion-project-a-old';
      const TMUX_NEW = 'companion-project-a-new';
      addTmuxSession(TMUX_EXISTING, '/home/user/project-a');
      addTmuxSession(TMUX_NEW, '/home/user/project-a');
      const content = jsonlLine({ type: 'user', message: { content: 'Old message' }, uuid: 'msg-1' });
      mockFs.readFileSync.mockReturnValue(content);

      await startWatcher(watcher);

      // Mark the new session BEFORE any JSONL is loaded
      watcher.markSessionAsNew(TMUX_NEW);

      // Load an existing JSONL (belongs to TMUX_EXISTING)
      mockWatcher.emit('add', FILE_A1);
      await jest.advanceTimersByTimeAsync(200);

      // The new session should NOT pick up the old JSONL
      const messages = watcher.getMessages(TMUX_NEW);
      expect(messages).toEqual([]);

      // But the existing session should still work
      const existingMessages = watcher.getMessages(TMUX_EXISTING);
      expect(existingMessages.length).toBeGreaterThan(0);
    });

    it('should clear guard when direct mapping is established', async () => {
      const TMUX_EXISTING = 'companion-project-a-old';
      const TMUX_NEW = 'companion-project-a-new';
      addTmuxSession(TMUX_EXISTING, '/home/user/project-a');
      addTmuxSession(TMUX_NEW, '/home/user/project-a');
      const content = jsonlLine({ type: 'user', message: { content: 'Hello' }, uuid: 'msg-1' });
      mockFs.readFileSync.mockReturnValue(content);

      await startWatcher(watcher);
      watcher.markSessionAsNew(TMUX_NEW);

      // Manually set a direct mapping (simulates new JSONL detected for this session)
      const mappings = (watcher as any).tmuxConversationIds as Map<string, string>;
      mappings.set(TMUX_NEW, FILE_UUID_2);

      // Load the JSONL for the new session
      mockWatcher.emit('add', FILE_A2);
      await jest.advanceTimersByTimeAsync(200);

      // Now getMessages should work because direct mapping bypasses the guard
      const messages = watcher.getMessages(TMUX_NEW);
      expect(messages.length).toBeGreaterThan(0);

      // Guard should be cleared
      const newlyCreated = (watcher as any).newlyCreatedSessions as Map<string, number>;
      expect(newlyCreated.has(TMUX_NEW)).toBe(false);
    });
  });

  // ========================================
  // Compaction re-mapping
  // ========================================

  describe('compaction re-mapping', () => {
    const TMUX_A1 = 'companion-project-a-1';
    const TMUX_A2 = 'companion-project-a-2';
    const FILE_UUID_NEW = 'd4e5f6a7-b8c9-0123-defa-456789012345';
    const FILE_A_NEW = `${PROJECT_DIR_A}/${FILE_UUID_NEW}.jsonl`;

    it('should re-map compacted session to new JSONL', async () => {
      // Two sessions in same dir, each with their own JSONL
      addTmuxSession(TMUX_A1, '/home/user/project-a');
      addTmuxSession(TMUX_A2, '/home/user/project-a');
      const content = jsonlLine({ type: 'user', message: { content: 'Hello' }, uuid: 'msg-1' });
      mockFs.readFileSync.mockReturnValue(content);

      await startWatcher(watcher);

      // Load both JSONLs
      mockWatcher.emit('add', FILE_A1);
      await jest.advanceTimersByTimeAsync(200);
      mockWatcher.emit('add', FILE_A2);
      await jest.advanceTimersByTimeAsync(200);

      // Set up direct mappings
      const mappings = (watcher as any).tmuxConversationIds as Map<string, string>;
      mappings.set(TMUX_A1, FILE_UUID_1);
      mappings.set(TMUX_A2, FILE_UUID_2);

      // Simulate: TMUX_A1 compacted (flag the session)
      const compacted = (watcher as any).compactedSessions as Set<string>;
      compacted.add(TMUX_A1);

      // New JSONL appears (compaction successor)
      mockWatcher.emit('add', FILE_A_NEW);
      await jest.advanceTimersByTimeAsync(200);

      // TMUX_A1 should now be mapped to the new file
      expect(mappings.get(TMUX_A1)).toBe(FILE_UUID_NEW);
      // TMUX_A2 mapping should be unchanged
      expect(mappings.get(TMUX_A2)).toBe(FILE_UUID_2);
      // Compacted flag should be cleared
      expect(compacted.has(TMUX_A1)).toBe(false);
    });

    it('should not re-map when no session is flagged as compacted', async () => {
      addTmuxSession(TMUX_A1, '/home/user/project-a');
      addTmuxSession(TMUX_A2, '/home/user/project-a');
      const content = jsonlLine({ type: 'user', message: { content: 'Hello' }, uuid: 'msg-1' });
      mockFs.readFileSync.mockReturnValue(content);

      await startWatcher(watcher);

      mockWatcher.emit('add', FILE_A1);
      await jest.advanceTimersByTimeAsync(200);
      mockWatcher.emit('add', FILE_A2);
      await jest.advanceTimersByTimeAsync(200);

      const mappings = (watcher as any).tmuxConversationIds as Map<string, string>;
      mappings.set(TMUX_A1, FILE_UUID_1);
      mappings.set(TMUX_A2, FILE_UUID_2);

      // NO compaction flag — new file should NOT trigger re-mapping
      mockWatcher.emit('add', FILE_A_NEW);
      await jest.advanceTimersByTimeAsync(200);

      // Mappings unchanged
      expect(mappings.get(TMUX_A1)).toBe(FILE_UUID_1);
      expect(mappings.get(TMUX_A2)).toBe(FILE_UUID_2);
    });

    it('should not flag compaction on initial file load (no prevTracked)', async () => {
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');

      // Content with a compaction-style message (context summary)
      const compactionContent = jsonlContent(
        jsonlLine({ type: 'summary', message: { content: '[Context compacted]' }, uuid: 'compact-1' }),
        jsonlLine({ type: 'user', message: { content: 'Continue' }, uuid: 'msg-2' })
      );
      mockFs.readFileSync.mockReturnValue(compactionContent);

      await startWatcher(watcher);

      // First load — prevTracked is null
      mockWatcher.emit('add', FILE_A1);
      await jest.advanceTimersByTimeAsync(200);

      // compactedSessions should NOT contain this session (initial load)
      const compacted = (watcher as any).compactedSessions as Set<string>;
      expect(compacted.has(TMUX_SESSION_A)).toBe(false);
    });

    it('should only re-map exactly one compacted session', async () => {
      // Edge case: both sessions compacted simultaneously
      addTmuxSession(TMUX_A1, '/home/user/project-a');
      addTmuxSession(TMUX_A2, '/home/user/project-a');
      const content = jsonlLine({ type: 'user', message: { content: 'Hello' }, uuid: 'msg-1' });
      mockFs.readFileSync.mockReturnValue(content);

      await startWatcher(watcher);

      mockWatcher.emit('add', FILE_A1);
      await jest.advanceTimersByTimeAsync(200);
      mockWatcher.emit('add', FILE_A2);
      await jest.advanceTimersByTimeAsync(200);

      const mappings = (watcher as any).tmuxConversationIds as Map<string, string>;
      mappings.set(TMUX_A1, FILE_UUID_1);
      mappings.set(TMUX_A2, FILE_UUID_2);

      // BOTH sessions compacted — ambiguous, should NOT re-map
      const compacted = (watcher as any).compactedSessions as Set<string>;
      compacted.add(TMUX_A1);
      compacted.add(TMUX_A2);

      mockWatcher.emit('add', FILE_A_NEW);
      await jest.advanceTimersByTimeAsync(200);

      // Neither should be re-mapped (ambiguous — 2 compacted, 1 new file)
      expect(mappings.get(TMUX_A1)).toBe(FILE_UUID_1);
      expect(mappings.get(TMUX_A2)).toBe(FILE_UUID_2);
    });
  });
});
