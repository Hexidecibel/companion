import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';

// Mock chokidar
const mockWatcher = new EventEmitter();
(mockWatcher as any).close = jest.fn().mockResolvedValue(undefined);

jest.mock('chokidar', () => ({
  watch: jest.fn(() => mockWatcher),
}));

jest.mock('fs');

import chokidar from 'chokidar';
import { ConversationWatcher } from '../src/watcher';

const mockFs = fs as jest.Mocked<typeof fs>;
const mockChokidar = chokidar as jest.Mocked<typeof chokidar>;

describe('ConversationWatcher', () => {
  const claudeHome = '/home/user/.claude';
  let watcher: ConversationWatcher;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue([]);
    mockFs.readFileSync.mockReturnValue('');
    mockFs.statSync.mockReturnValue({ mtimeMs: Date.now() } as fs.Stats);
    watcher = new ConversationWatcher(claudeHome);
  });

  afterEach(() => {
    watcher.stop();
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

  it('should emit update event on file change', (done) => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        type: 'assistant',
        message: { content: 'Hello' },
        uuid: 'msg-1',
      })
    );

    watcher.start();
    watcher.on('update', (data) => {
      expect(data.conversationPath).toContain('conversation.jsonl');
      done();
    });

    // Simulate file change
    mockWatcher.emit('change', '/home/user/.claude/projects/test/conversation.jsonl');
  });

  it('should emit update event on file add', (done) => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        type: 'user',
        message: { content: 'Hi' },
        uuid: 'msg-1',
      })
    );

    watcher.start();
    watcher.on('update', (data) => {
      expect(data.messages).toBeDefined();
      done();
    });

    // Simulate file add
    mockWatcher.emit('add', '/home/user/.claude/projects/test/conversation.jsonl');
  });

  it('should only process .jsonl files', () => {
    const updateSpy = jest.fn();
    watcher.on('update', updateSpy);
    watcher.start();

    // These should not trigger updates
    mockWatcher.emit('change', '/home/user/.claude/projects/test/config.json');
    mockWatcher.emit('change', '/home/user/.claude/projects/test/readme.md');

    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('should get current conversation state', () => {
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

    const state = watcher.getCurrentState();

    expect(state).toBeDefined();
    expect(state!.messages).toHaveLength(1);
  });

  it('should stop watching on stop()', async () => {
    watcher.start();
    await watcher.stop();

    expect((mockWatcher as any).close).toHaveBeenCalled();
  });

  it('should get highlights from current conversation', () => {
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

    const highlights = watcher.getHighlights();

    expect(highlights).toHaveLength(2);
    expect(highlights[0].type).toBe('user');
    expect(highlights[1].type).toBe('assistant');
  });
});
