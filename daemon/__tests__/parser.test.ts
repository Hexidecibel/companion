import * as fs from 'fs';
import {
  parseConversationFile,
  extractHighlights,
  detectWaitingForInput,
  detectCurrentActivity,
  getSessionStatus,
} from '../src/parser';
import { ConversationMessage } from '../src/types';

// Mock fs module
jest.mock('fs');
const mockFs = fs as jest.Mocked<typeof fs>;

describe('parseConversationFile', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return empty array when file does not exist', () => {
    mockFs.existsSync.mockReturnValue(false);

    const result = parseConversationFile('/nonexistent/file.jsonl');

    expect(result).toEqual([]);
    expect(mockFs.existsSync).toHaveBeenCalledWith('/nonexistent/file.jsonl');
  });

  it('should parse user and assistant messages', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'Hello' },
        timestamp: '2024-01-01T00:00:00Z',
        uuid: 'msg-1',
      }) +
        '\n' +
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: 'Hi there!' },
          timestamp: '2024-01-01T00:00:01Z',
          uuid: 'msg-2',
        })
    );

    const result = parseConversationFile('/test/conversation.jsonl');

    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('user');
    expect(result[0].content).toBe('Hello');
    expect(result[1].type).toBe('assistant');
    expect(result[1].content).toBe('Hi there!');
  });

  it('should handle array content with text blocks', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello from array' }],
        },
        timestamp: '2024-01-01T00:00:00Z',
        uuid: 'msg-1',
      })
    );

    const result = parseConversationFile('/test/conversation.jsonl');

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('Hello from array');
  });

  it('should extract tool calls from content', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me read that file.' },
            {
              type: 'tool_use',
              name: 'Read',
              tool_use_id: 'tool-1',
              input: { file_path: '/test/file.ts' },
            },
          ],
        },
        timestamp: '2024-01-01T00:00:00Z',
        uuid: 'msg-1',
      })
    );

    const result = parseConversationFile('/test/conversation.jsonl');

    expect(result).toHaveLength(1);
    expect(result[0].toolCalls).toHaveLength(1);
    expect(result[0].toolCalls![0].name).toBe('Read');
    expect(result[0].toolCalls![0].input).toEqual({ file_path: '/test/file.ts' });
  });

  it('should extract AskUserQuestion options', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'AskUserQuestion',
              tool_use_id: 'tool-1',
              input: {
                questions: [
                  {
                    question: 'Which option?',
                    header: 'Choice',
                    options: [
                      { label: 'Option A', description: 'First option' },
                      { label: 'Option B', description: 'Second option' },
                    ],
                  },
                ],
              },
            },
          ],
        },
        timestamp: '2024-01-01T00:00:00Z',
        uuid: 'msg-1',
      })
    );

    const result = parseConversationFile('/test/conversation.jsonl');

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('Which option?');
    expect(result[0].options).toHaveLength(2);
    expect(result[0].options![0].label).toBe('Option A');
    expect(result[0].isWaitingForChoice).toBe(true);
  });

  it('should skip malformed JSON lines', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      '{ invalid json }\n' +
        JSON.stringify({
          type: 'user',
          message: { content: 'Valid message' },
          uuid: 'msg-1',
        })
    );

    const result = parseConversationFile('/test/conversation.jsonl');

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('Valid message');
  });

  it('should limit messages to specified count', () => {
    mockFs.existsSync.mockReturnValue(true);
    const messages = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({
        type: 'user',
        message: { content: `Message ${i}` },
        uuid: `msg-${i}`,
      })
    ).join('\n');
    mockFs.readFileSync.mockReturnValue(messages);

    const result = parseConversationFile('/test/conversation.jsonl', 5);

    expect(result).toHaveLength(5);
  });
});

describe('extractHighlights', () => {
  it('should filter messages with content', () => {
    const messages: ConversationMessage[] = [
      { id: '1', type: 'user', content: 'Hello', timestamp: 1 },
      { id: '2', type: 'assistant', content: '', timestamp: 2 },
      { id: '3', type: 'assistant', content: 'Response', timestamp: 3 },
    ];

    const highlights = extractHighlights(messages);

    expect(highlights).toHaveLength(2);
    expect(highlights[0].content).toBe('Hello');
    expect(highlights[1].content).toBe('Response');
  });

  it('should preserve options in highlights', () => {
    const messages: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: 'Choose one',
        timestamp: 1,
        options: [{ label: 'A', description: 'Option A' }],
        isWaitingForChoice: true,
      },
    ];

    const highlights = extractHighlights(messages);

    expect(highlights[0].options).toHaveLength(1);
    expect(highlights[0].isWaitingForChoice).toBe(true);
  });
});

describe('detectWaitingForInput', () => {
  it('should return false for empty messages', () => {
    expect(detectWaitingForInput([])).toBe(false);
  });

  it('should return true when last message ends with question mark', () => {
    const messages: ConversationMessage[] = [
      { id: '1', type: 'assistant', content: 'How can I help?', timestamp: 1 },
    ];

    expect(detectWaitingForInput(messages)).toBe(true);
  });

  it('should return true for common question patterns', () => {
    const patterns = [
      'Would you like me to continue?',
      'Do you want me to proceed?',
      'Should I make those changes?',
      'Let me know if you have questions.',
      'Please confirm the action.',
      'Please provide the file path.',
    ];

    for (const pattern of patterns) {
      const messages: ConversationMessage[] = [
        { id: '1', type: 'assistant', content: pattern, timestamp: 1 },
      ];
      expect(detectWaitingForInput(messages)).toBe(true);
    }
  });

  it('should return false when last message is from user', () => {
    const messages: ConversationMessage[] = [
      { id: '1', type: 'user', content: 'Hello?', timestamp: 1 },
    ];

    expect(detectWaitingForInput(messages)).toBe(false);
  });

  it('should return false when assistant has pending tool calls', () => {
    const messages: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: 'Reading file...',
        timestamp: 1,
        toolCalls: [
          { id: 't1', name: 'Read', input: {}, status: 'pending' },
        ],
      },
    ];

    expect(detectWaitingForInput(messages)).toBe(false);
  });
});

describe('detectCurrentActivity', () => {
  it('should return undefined for empty messages', () => {
    expect(detectCurrentActivity([])).toBeUndefined();
  });

  it('should return Processing when last message is from user', () => {
    const messages: ConversationMessage[] = [
      { id: '1', type: 'user', content: 'Do something', timestamp: 1 },
    ];

    expect(detectCurrentActivity(messages)).toBe('Processing...');
  });

  it('should describe tool activity', () => {
    const toolTests = [
      { name: 'Read', expected: 'Reading file' },
      { name: 'Write', expected: 'Writing file' },
      { name: 'Edit', expected: 'Editing file' },
      { name: 'Bash', expected: 'Running command' },
      { name: 'Glob', expected: 'Searching files' },
      { name: 'Grep', expected: 'Searching code' },
      { name: 'Task', expected: 'Running agent' },
      { name: 'WebFetch', expected: 'Fetching web page' },
      { name: 'WebSearch', expected: 'Searching web' },
      { name: 'AskUserQuestion', expected: 'Waiting for response' },
    ];

    for (const { name, expected } of toolTests) {
      const messages: ConversationMessage[] = [
        {
          id: '1',
          type: 'assistant',
          content: '',
          timestamp: 1,
          toolCalls: [{ id: 't1', name, input: {}, status: 'completed' }],
        },
      ];

      expect(detectCurrentActivity(messages)).toBe(expected);
    }
  });

  it('should include file path in activity description', () => {
    const messages: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: '',
        timestamp: 1,
        toolCalls: [
          {
            id: 't1',
            name: 'Read',
            input: { file_path: '/path/to/file.ts' },
            status: 'completed',
          },
        ],
      },
    ];

    expect(detectCurrentActivity(messages)).toBe('Reading file: file.ts');
  });

  it('should truncate long commands', () => {
    const longCommand = 'npm run build && npm run test && npm run lint && npm run deploy';
    const messages: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: '',
        timestamp: 1,
        toolCalls: [
          {
            id: 't1',
            name: 'Bash',
            input: { command: longCommand },
            status: 'completed',
          },
        ],
      },
    ];

    const activity = detectCurrentActivity(messages);
    expect(activity).toContain('Running command:');
    expect(activity).toContain('...');
    expect(activity!.length).toBeLessThan(longCommand.length + 20);
  });
});

describe('getSessionStatus', () => {
  it('should return correct status', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        type: 'assistant',
        message: { content: 'How can I help?' },
        timestamp: '2024-01-01T00:00:00Z',
        uuid: 'msg-1',
      })
    );

    const status = getSessionStatus('/test/conversation.jsonl', true);

    expect(status.isRunning).toBe(true);
    expect(status.isWaitingForInput).toBe(true);
    expect(status.conversationId).toBe('/test/conversation.jsonl');
  });

  it('should not be waiting for input when process is not running', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        type: 'assistant',
        message: { content: 'How can I help?' },
        uuid: 'msg-1',
      })
    );

    const status = getSessionStatus('/test/conversation.jsonl', false);

    expect(status.isRunning).toBe(false);
    expect(status.isWaitingForInput).toBe(false);
  });
});
