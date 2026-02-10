import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { exec } from 'child_process';

// Tmux session state for mock
const tmuxSessions: Map<string, { workingDir: string; tagged: boolean }> = new Map();

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
      if (session) {
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

jest.mock('fs');

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
      jest.advanceTimersByTime(200);

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
      jest.advanceTimersByTime(200);

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
      jest.advanceTimersByTime(200);
      mockWatcher.emit('add', FILE_A2);
      jest.advanceTimersByTime(200);

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
      jest.advanceTimersByTime(200);
      mockWatcher.emit('add', FILE_B1);
      jest.advanceTimersByTime(200);

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
      jest.advanceTimersByTime(200);

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
      jest.advanceTimersByTime(200);

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
      jest.advanceTimersByTime(50); // Less than debounce (150ms)

      mockFs.readFileSync.mockReturnValue(content2);
      mockWatcher.emit('change', FILE_A1);
      jest.advanceTimersByTime(200); // Past debounce

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
      jest.advanceTimersByTime(200);
      mockWatcher.emit('add', FILE_B1);
      jest.advanceTimersByTime(200);
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
      jest.advanceTimersByTime(200);

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
      jest.advanceTimersByTime(200);

      expect(watcher.isWaiting()).toBe(true);
    });

    it('should not be waiting when assistant is working', async () => {
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      mockFs.readFileSync.mockReturnValue(
        jsonlLine({ type: 'user', message: { content: 'Do something' }, uuid: 'msg-1' })
      );

      await startWatcher(watcher);
      mockWatcher.emit('add', FILE_A1);
      jest.advanceTimersByTime(200);

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
      jest.advanceTimersByTime(200);

      // Second message - assistant replies, now waiting
      mockFs.readFileSync.mockReturnValue(
        jsonlContent(
          jsonlLine({ type: 'user', message: { content: 'Do something' }, uuid: 'msg-1' }),
          jsonlLine({ type: 'assistant', message: { content: 'What do you want?' }, uuid: 'msg-2' })
        )
      );
      mockWatcher.emit('change', FILE_A1);
      jest.advanceTimersByTime(200);

      expect(statusSpy).toHaveBeenCalledTimes(2);
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
      jest.advanceTimersByTime(200);

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
      jest.advanceTimersByTime(200);
      mockWatcher.emit('add', FILE_B1);
      jest.advanceTimersByTime(200);

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
      jest.advanceTimersByTime(200);

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
      jest.advanceTimersByTime(200);

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
      jest.advanceTimersByTime(200);
      mockWatcher.emit('add', FILE_B1);
      jest.advanceTimersByTime(200);

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
      jest.advanceTimersByTime(200);

      // Session 2: user sent, assistant working
      mockFs.readFileSync.mockReturnValue(
        jsonlLine({ type: 'user', message: { content: 'Do something' }, uuid: 'msg-2' })
      );
      mockWatcher.emit('add', FILE_B1);
      jest.advanceTimersByTime(200);

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
      jest.advanceTimersByTime(200);

      const sessions = watcher.getSessions();
      expect(sessions.length).toBe(1);
    });

    it('should not expose sessions without matching tmux session', async () => {
      // No tmux sessions set up
      const content = jsonlLine({ type: 'user', message: { content: 'Hello' }, uuid: 'msg-1' });
      mockFs.readFileSync.mockReturnValue(content);

      await startWatcher(watcher);
      mockWatcher.emit('add', FILE_A1);
      jest.advanceTimersByTime(200);

      // Conversations are tracked internally but not exposed without tmux
      const sessions = watcher.getSessions();
      expect(sessions.length).toBe(0);
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
      jest.advanceTimersByTime(200);

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
      jest.advanceTimersByTime(200);

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
      jest.advanceTimersByTime(200);

      // Should not crash, session may or may not be tracked
      const messages = watcher.getMessages();
      expect(messages).toBeDefined();
    });

    it('should handle malformed JSONL content', async () => {
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      mockFs.readFileSync.mockReturnValue('not valid json\nstill not valid');

      await startWatcher(watcher);

      // Should not throw
      expect(() => {
        mockWatcher.emit('add', FILE_A1);
        jest.advanceTimersByTime(200);
      }).not.toThrow();
    });

    it('should auto-set first added session as active', async () => {
      addTmuxSession(TMUX_SESSION_A, '/home/user/project-a');
      const content = jsonlLine({ type: 'user', message: { content: 'Hello' }, uuid: 'msg-1' });
      mockFs.readFileSync.mockReturnValue(content);

      await startWatcher(watcher);
      expect(watcher.getActiveSessionId()).toBeNull();

      mockWatcher.emit('add', FILE_A1);
      jest.advanceTimersByTime(200);

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
      jest.advanceTimersByTime(200);

      // Subagent files should not trigger conversation updates
      expect(updateSpy).not.toHaveBeenCalled();
    });
  });
});
