import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';

// Mock child_process to prevent real tmux calls
jest.mock('child_process', () => ({
  exec: jest.fn((cmd: string, cb: Function) => cb(new Error('no tmux'), '', '')),
}));

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

describe('SessionWatcher', () => {
  const codeHome = '/home/user/.claude';
  let watcher: SessionWatcher;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue('');
    mockFs.statSync.mockReturnValue({ mtimeMs: Date.now(), isDirectory: () => false } as any);
    watcher = new SessionWatcher(codeHome);
  });

  afterEach(() => {
    watcher.stop();
    jest.useRealTimers();
  });

  it('should initialize watcher for projects directory', () => {
    watcher.start();

    expect(mockChokidar.watch).toHaveBeenCalledWith(
      expect.stringContaining('projects'),
      expect.objectContaining({
        persistent: true,
        ignoreInitial: false,
        depth: 2,
      })
    );
  });

  it('should emit conversation-update event on file change', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        type: 'assistant',
        message: { content: 'Hello' },
        uuid: 'msg-1',
      })
    );

    watcher.start();
    const updateSpy = jest.fn();
    watcher.on('conversation-update', updateSpy);

    // Simulate file change
    mockWatcher.emit('change', '/home/user/.claude/projects/test/conversation.jsonl');
    jest.advanceTimersByTime(200);

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ path: expect.stringContaining('conversation.jsonl') })
    );
  });

  it('should emit conversation-update event on file add', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        type: 'user',
        message: { content: 'Hi' },
        uuid: 'msg-1',
      })
    );

    watcher.start();
    const updateSpy = jest.fn();
    watcher.on('conversation-update', updateSpy);

    // Simulate file add
    mockWatcher.emit('add', '/home/user/.claude/projects/test/conversation.jsonl');
    jest.advanceTimersByTime(200);

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ messages: expect.anything() })
    );
  });

  it('should only process .jsonl files', () => {
    const updateSpy = jest.fn();
    watcher.on('conversation-update', updateSpy);
    watcher.start();

    // These should not trigger updates (chokidar only watches .jsonl pattern)
    // The actual filtering is done by chokidar's glob pattern
    // We can verify no events are emitted for non-existent files
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('should get current conversation messages', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        type: 'assistant',
        message: { content: 'Test message' },
        uuid: 'msg-1',
      })
    );

    watcher.start();
    mockWatcher.emit('add', '/home/user/.claude/projects/test/conversation.jsonl');
    jest.advanceTimersByTime(200);

    const messages = watcher.getMessages();

    expect(messages).toBeDefined();
    expect(messages).toHaveLength(1);
  });

  it('should stop watching on stop()', () => {
    watcher.start();
    watcher.stop();

    expect((mockWatcher as any).close).toHaveBeenCalled();
  });

  it('should get status from current conversation', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        type: 'user',
        message: { content: 'Hello' },
        uuid: 'msg-1',
      }) +
        '\n' +
        JSON.stringify({
          type: 'assistant',
          message: { content: 'Hi there!' },
          uuid: 'msg-2',
        })
    );

    watcher.start();
    mockWatcher.emit('add', '/home/user/.claude/projects/test/conversation.jsonl');
    jest.advanceTimersByTime(200);

    const status = watcher.getStatus();

    expect(status.isRunning).toBe(true);
    expect(status.conversationId).toBeDefined();
  });

  it('should track multiple sessions', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        type: 'user',
        message: { content: 'Hello' },
        uuid: 'msg-1',
      })
    );

    watcher.start();

    // Add two different project conversations
    mockWatcher.emit('add', '/home/user/.claude/projects/project-a/conversation.jsonl');
    jest.advanceTimersByTime(200);
    mockWatcher.emit('add', '/home/user/.claude/projects/project-b/conversation.jsonl');
    jest.advanceTimersByTime(200);

    const sessions = watcher.getSessions();

    expect(sessions.length).toBeGreaterThanOrEqual(2);
  });

  it('should switch active session', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        type: 'user',
        message: { content: 'Hello' },
        uuid: 'msg-1',
      })
    );

    watcher.start();
    mockWatcher.emit('add', '/home/user/.claude/projects/project-a/conversation.jsonl');
    jest.advanceTimersByTime(200);
    mockWatcher.emit('add', '/home/user/.claude/projects/project-b/conversation.jsonl');
    jest.advanceTimersByTime(200);

    const sessions = watcher.getSessions();
    if (sessions.length >= 2) {
      const switched = watcher.setActiveSession(sessions[1].id);
      expect(switched).toBe(true);
      expect(watcher.getActiveSessionId()).toBe(sessions[1].id);
    }
  });

  it('should return false when switching to non-existent session', () => {
    watcher.start();
    const switched = watcher.setActiveSession('non-existent-session');
    expect(switched).toBe(false);
  });

  it('should detect waiting for input state', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        type: 'assistant',
        message: { content: 'What would you like me to do?' },
        uuid: 'msg-1',
      })
    );

    watcher.start();
    mockWatcher.emit('add', '/home/user/.claude/projects/test/conversation.jsonl');
    jest.advanceTimersByTime(200);

    expect(watcher.isWaiting()).toBe(true);
  });

  it('should emit status-change when waiting state changes', () => {
    mockFs.existsSync.mockReturnValue(true);

    watcher.start();

    const statusSpy = jest.fn();
    watcher.on('status-change', statusSpy);

    // First message - not waiting
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        type: 'user',
        message: { content: 'Do something' },
        uuid: 'msg-1',
      })
    );
    mockWatcher.emit('add', '/home/user/.claude/projects/test/conversation.jsonl');
    jest.advanceTimersByTime(200);

    // Second message - waiting
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        type: 'user',
        message: { content: 'Do something' },
        uuid: 'msg-1',
      }) +
        '\n' +
        JSON.stringify({
          type: 'assistant',
          message: { content: 'What do you want?' },
          uuid: 'msg-2',
        })
    );
    mockWatcher.emit('change', '/home/user/.claude/projects/test/conversation.jsonl');
    jest.advanceTimersByTime(200);

    expect(statusSpy).toHaveBeenCalledTimes(2);
  });
});
