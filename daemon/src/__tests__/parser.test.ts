import * as fs from 'fs';
import {
  parseConversationFile,
  detectWaitingForInput,
  extractHighlights,
  detectCurrentActivityFast,
  detectIdle,
  detectCurrentActivity,
  getSessionStatus,
  getPendingApprovalTools,
  detectCompaction,
  extractUsageFromFile,
  extractFileChanges,
  parseConversationChain,
  getRecentActivity,
} from '../parser';
import { ConversationMessage } from '../types';

jest.mock('fs');
const mockedFs = jest.mocked(fs);

// ---------------------------------------------------------------------------
// JSONL fixture helpers
// ---------------------------------------------------------------------------

function jsonl(...entries: object[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n');
}

function userMsg(content: string, opts: { uuid?: string; timestamp?: string } = {}): object {
  return {
    type: 'user',
    message: { role: 'user', content },
    uuid: opts.uuid || `user-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: opts.timestamp || '2026-01-28T10:00:00.000Z',
  };
}

function assistantText(text: string, opts: { uuid?: string; timestamp?: string } = {}): object {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
    uuid: opts.uuid || `asst-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: opts.timestamp || '2026-01-28T10:01:00.000Z',
  };
}

function assistantWithTools(
  text: string,
  toolUses: Array<{ name: string; id: string; input?: Record<string, unknown> }>,
  opts: { uuid?: string; timestamp?: string } = {}
): object {
  const content: object[] = [];
  if (text) content.push({ type: 'text', text });
  for (const t of toolUses) {
    content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input || {} });
  }
  return {
    type: 'assistant',
    message: { role: 'assistant', content },
    uuid: opts.uuid || `asst-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: opts.timestamp || '2026-01-28T10:01:00.000Z',
  };
}

function toolResult(toolUseId: string, output: string, opts: { timestamp?: string } = {}): object {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: output }],
    },
    uuid: `result-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: opts.timestamp || '2026-01-28T10:02:00.000Z',
  };
}

function summaryEntry(summary: string, opts: { timestamp?: string } = {}): object {
  return {
    type: 'summary',
    summary,
    timestamp: opts.timestamp || '2026-01-28T09:00:00.000Z',
  };
}

function compactBoundary(opts: { timestamp?: string } = {}): object {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    timestamp: opts.timestamp || '2026-01-28T09:00:00.000Z',
  };
}

function usageEntry(
  inputTokens: number,
  outputTokens: number,
  opts: {
    cacheCreation?: number;
    cacheRead?: number;
    model?: string;
    msgId?: string;
    timestamp?: string;
  } = {}
): object {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      id: opts.msgId || `msg-${Math.random().toString(36).slice(2, 8)}`,
      content: [{ type: 'text', text: 'response' }],
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        ...(opts.cacheCreation ? { cache_creation_input_tokens: opts.cacheCreation } : {}),
        ...(opts.cacheRead ? { cache_read_input_tokens: opts.cacheRead } : {}),
      },
      model: opts.model || 'claude-sonnet-4-5-20250929',
    },
    uuid: `usage-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: opts.timestamp || '2026-01-28T10:00:00.000Z',
  };
}

// ---------------------------------------------------------------------------
// parseConversationFile
// ---------------------------------------------------------------------------

describe('parseConversationFile', () => {
  it('parses user and assistant text messages', () => {
    const content = jsonl(userMsg('Hello'), assistantText('Hi there!'));
    const msgs = parseConversationFile('test.jsonl', Infinity, content);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].type).toBe('user');
    expect(msgs[0].content).toBe('Hello');
    expect(msgs[1].type).toBe('assistant');
    expect(msgs[1].content).toBe('Hi there!');
  });

  it('extracts tool calls from assistant messages', () => {
    const content = jsonl(
      assistantWithTools('Let me read that.', [
        { name: 'Read', id: 'tool1', input: { file_path: '/src/app.ts' } },
      ]),
      toolResult('tool1', 'file contents here')
    );
    const msgs = parseConversationFile('test.jsonl', Infinity, content);
    const asst = msgs.find((m) => m.type === 'assistant');
    expect(asst?.toolCalls).toHaveLength(1);
    expect(asst!.toolCalls![0].name).toBe('Read');
    expect(asst!.toolCalls![0].output).toBe('file contents here');
    expect(asst!.toolCalls![0].status).toBe('completed');
  });

  it('marks tools without results as pending', () => {
    const content = jsonl(
      assistantWithTools('', [{ name: 'Bash', id: 'tool1', input: { command: 'ls' } }])
    );
    const msgs = parseConversationFile('test.jsonl', Infinity, content);
    expect(msgs[0].toolCalls![0].status).toBe('pending');
    expect(msgs[0].toolCalls![0].output).toBeUndefined();
  });

  it('handles string content (user messages)', () => {
    const entry = {
      type: 'user',
      message: { role: 'user', content: 'plain string' },
      uuid: 'u1',
      timestamp: '2026-01-28T10:00:00.000Z',
    };
    const msgs = parseConversationFile('test.jsonl', Infinity, JSON.stringify(entry));
    expect(msgs[0].content).toBe('plain string');
  });

  it('skips malformed JSON lines without crashing', () => {
    const content = [
      JSON.stringify(userMsg('Before')),
      '{invalid json!!!',
      JSON.stringify(assistantText('After')),
    ].join('\n');
    const msgs = parseConversationFile('test.jsonl', Infinity, content);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe('Before');
    expect(msgs[1].content).toBe('After');
  });

  it('returns empty array for empty content', () => {
    expect(parseConversationFile('test.jsonl', Infinity, '')).toEqual([]);
  });

  it('reads from filesystem when no preReadContent', () => {
    mockedFs.existsSync.mockReturnValue(false);
    expect(parseConversationFile('nonexistent.jsonl')).toEqual([]);
    expect(mockedFs.existsSync).toHaveBeenCalledWith('nonexistent.jsonl');
  });

  it('respects the limit parameter', () => {
    const content = jsonl(
      userMsg('m1', { timestamp: '2026-01-28T10:00:00.000Z' }),
      assistantText('m2', { timestamp: '2026-01-28T10:01:00.000Z' }),
      userMsg('m3', { timestamp: '2026-01-28T10:02:00.000Z' }),
      assistantText('m4', { timestamp: '2026-01-28T10:03:00.000Z' }),
      userMsg('m5', { timestamp: '2026-01-28T10:04:00.000Z' })
    );
    const msgs = parseConversationFile('test.jsonl', 3, content);
    expect(msgs.length).toBeLessThanOrEqual(3);
  });

  it('handles legacy summary type (compaction)', () => {
    const content = jsonl(summaryEntry('Here is the summary of context'), userMsg('Continue'));
    const msgs = parseConversationFile('test.jsonl', Infinity, content);
    const system = msgs.find((m) => m.type === 'system');
    expect(system).toBeDefined();
    expect(system!.content).toBe('Here is the summary of context');
    expect(system!.isCompaction).toBe(true);
  });

  it('handles compact_boundary format', () => {
    // compact_boundary appears BEFORE the summary user message in the JSONL.
    // But parseConversationFile processes from the end backwards, so the user
    // message at index i+1 gets processed first, then the compact_boundary at
    // index i converts it to a system compaction message.
    const content = jsonl(
      compactBoundary({ timestamp: '2026-01-28T09:00:00.000Z' }),
      userMsg('Summary of what happened', { timestamp: '2026-01-28T09:00:01.000Z' }),
      assistantText('Continuing...', { timestamp: '2026-01-28T09:01:00.000Z' })
    );
    const msgs = parseConversationFile('test.jsonl', Infinity, content);
    const compaction = msgs.find((m) => m.isCompaction);
    expect(compaction).toBeDefined();
    expect(compaction!.type).toBe('system');
  });

  it('computes tool durations from timestamps', () => {
    const content = jsonl(
      assistantWithTools('', [{ name: 'Bash', id: 'tool1', input: { command: 'sleep 1' } }], {
        timestamp: '2026-01-28T10:00:00.000Z',
      }),
      toolResult('tool1', 'done', { timestamp: '2026-01-28T10:00:05.000Z' })
    );
    const msgs = parseConversationFile('test.jsonl', Infinity, content);
    const tc = msgs.find((m) => m.toolCalls)?.toolCalls?.[0];
    expect(tc?.startedAt).toBeDefined();
    expect(tc?.completedAt).toBeDefined();
    expect(tc!.completedAt! - tc!.startedAt!).toBe(5000);
  });

  it('extracts AskUserQuestion options from pending tool', () => {
    const content = jsonl(
      assistantWithTools('', [
        {
          name: 'AskUserQuestion',
          id: 'ask1',
          input: {
            questions: [
              {
                question: 'Which approach?',
                header: 'Approach',
                options: [
                  { label: 'Option A', description: 'First approach' },
                  { label: 'Option B', description: 'Second approach' },
                ],
                multiSelect: false,
              },
            ],
          },
        },
      ])
    );
    const msgs = parseConversationFile('test.jsonl', Infinity, content);
    expect(msgs[0].options).toHaveLength(2);
    expect(msgs[0].options![0].label).toBe('Option A');
    expect(msgs[0].questions).toHaveLength(1);
    expect(msgs[0].isWaitingForChoice).toBe(true);
    expect(msgs[0].content).toBe('Which approach?');
  });

  it('extracts multiSelect AskUserQuestion with multiple questions', () => {
    const content = jsonl(
      assistantWithTools('', [
        {
          name: 'AskUserQuestion',
          id: 'ask2',
          input: {
            questions: [
              {
                question: 'Which features do you want to enable?',
                header: 'Features',
                options: [
                  { label: 'Dark mode', description: 'Enable dark theme' },
                  { label: 'Notifications', description: 'Push notifications' },
                  { label: 'Auto-save', description: 'Save automatically' },
                ],
                multiSelect: true,
              },
              {
                question: 'Which platform?',
                header: 'Platform',
                options: [
                  { label: 'iOS', description: 'Apple devices' },
                  { label: 'Android', description: 'Google devices' },
                ],
                multiSelect: false,
              },
            ],
          },
        },
      ])
    );
    const msgs = parseConversationFile('test.jsonl', Infinity, content);
    expect(msgs[0].isWaitingForChoice).toBe(true);
    expect(msgs[0].questions).toHaveLength(2);
    // First question: multiSelect
    expect(msgs[0].questions![0].multiSelect).toBe(true);
    expect(msgs[0].questions![0].options).toHaveLength(3);
    expect(msgs[0].questions![0].question).toBe('Which features do you want to enable?');
    // Second question: single select
    expect(msgs[0].questions![1].multiSelect).toBe(false);
    expect(msgs[0].questions![1].options).toHaveLength(2);
    // Legacy options field uses first question
    expect(msgs[0].options).toHaveLength(3);
    expect(msgs[0].multiSelect).toBe(true);
  });

  it('generates approval options for pending Bash tool', () => {
    const content = jsonl(
      assistantWithTools('', [
        { name: 'Bash', id: 'bash1', input: { command: 'rm -rf /tmp/test' } },
      ])
    );
    const msgs = parseConversationFile('test.jsonl', Infinity, content);
    expect(msgs[0].options).toBeDefined();
    expect(msgs[0].options!.length).toBe(3);
    expect(msgs[0].options![0].label).toBe('yes');
    expect(msgs[0].isWaitingForChoice).toBe(true);
  });

  it('does not generate approval options for pending Task tool', () => {
    const content = jsonl(
      assistantWithTools('Running agent', [
        { name: 'Task', id: 'task1', input: { description: 'Research' } },
      ])
    );
    const msgs = parseConversationFile('test.jsonl', Infinity, content);
    expect(msgs[0].options).toBeUndefined();
  });

  it('detects skill invocation via Skill tool_use pattern', () => {
    const content = jsonl(
      userMsg('Please commit'),
      assistantWithTools('', [{ name: 'Skill', id: 'sk1', input: { skill: 'commit' } }]),
      toolResult('sk1', 'loaded'),
      // The expanded skill prompt from the user
      userMsg('You are a commit helper...')
    );
    const msgs = parseConversationFile('test.jsonl', Infinity, content);
    const expanded = msgs.find((m) => m.content === 'You are a commit helper...');
    expect(expanded?.skillName).toBe('commit');
  });

  it('handles tool_result with array content blocks', () => {
    const entry = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool1',
            content: [
              { type: 'text', text: 'line1' },
              { type: 'text', text: 'line2' },
            ],
          },
        ],
      },
      uuid: 'r1',
      timestamp: '2026-01-28T10:02:00.000Z',
    };
    const content = jsonl(
      assistantWithTools('', [{ name: 'Read', id: 'tool1', input: { file_path: '/f' } }]),
      entry
    );
    const msgs = parseConversationFile('test.jsonl', Infinity, content);
    const asst = msgs.find((m) => m.type === 'assistant');
    expect(asst?.toolCalls?.[0].output).toBe('line1\nline2');
  });

  it('handles queue-operation entries with task-notification', () => {
    const queueOp = {
      type: 'queue-operation',
      content:
        '<task-notification><task-id>abc</task-id><output-file>/tmp/out</output-file><status>completed</status><summary>Agent finished research</summary></task-notification>',
      timestamp: '2026-01-28T10:05:00.000Z',
    };
    const msgs = parseConversationFile('test.jsonl', Infinity, JSON.stringify(queueOp));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('system');
    expect(msgs[0].content).toBe('Agent finished research');
    expect(msgs[0].toolCalls?.[0].name).toBe('TaskOutput');
    expect(msgs[0].toolCalls?.[0].status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// detectWaitingForInput
// ---------------------------------------------------------------------------

describe('detectWaitingForInput', () => {
  it('returns false for empty messages', () => {
    expect(detectWaitingForInput([])).toBe(false);
  });

  it('returns true when last message is assistant with pending approval tool', () => {
    const msgs: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: '',
        timestamp: 1,
        toolCalls: [{ id: 't1', name: 'Bash', input: { command: 'ls' }, status: 'pending' }],
      },
    ];
    expect(detectWaitingForInput(msgs)).toBe(true);
  });

  it('returns true when last message is assistant with pending AskUserQuestion', () => {
    const msgs: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: 'question?',
        timestamp: 1,
        toolCalls: [{ id: 't1', name: 'AskUserQuestion', input: {}, status: 'pending' }],
      },
    ];
    expect(detectWaitingForInput(msgs)).toBe(true);
  });

  it('returns true when last message is assistant with pending ExitPlanMode', () => {
    const msgs: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: '',
        timestamp: 1,
        toolCalls: [{ id: 't1', name: 'ExitPlanMode', input: {}, status: 'pending' }],
      },
    ];
    expect(detectWaitingForInput(msgs)).toBe(true);
  });

  it('returns false when tools are still running', () => {
    const msgs: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: '',
        timestamp: 1,
        toolCalls: [{ id: 't1', name: 'Bash', input: {}, status: 'running' }],
      },
    ];
    expect(detectWaitingForInput(msgs)).toBe(false);
  });

  it('returns true when assistant finished with all tools completed', () => {
    const msgs: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: 'Done!',
        timestamp: 1,
        toolCalls: [{ id: 't1', name: 'Read', input: {}, status: 'completed', output: 'data' }],
      },
    ];
    expect(detectWaitingForInput(msgs)).toBe(true);
  });

  it('returns true when assistant has no tools (plain text response)', () => {
    const msgs: ConversationMessage[] = [
      { id: '1', type: 'assistant', content: 'Here is your answer.', timestamp: 1 },
    ];
    expect(detectWaitingForInput(msgs)).toBe(true);
  });

  it('returns false when last message is user', () => {
    const msgs: ConversationMessage[] = [
      { id: '1', type: 'assistant', content: 'Hi', timestamp: 1 },
      { id: '2', type: 'user', content: 'Thanks', timestamp: 2 },
    ];
    expect(detectWaitingForInput(msgs)).toBe(false);
  });

  it('returns true when assistant has mix of completed and error tools', () => {
    const msgs: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: '',
        timestamp: 1,
        toolCalls: [
          { id: 't1', name: 'Bash', input: {}, status: 'completed', output: 'ok' },
          { id: 't2', name: 'Read', input: {}, status: 'error' },
        ],
      },
    ];
    expect(detectWaitingForInput(msgs)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// detectIdle
// ---------------------------------------------------------------------------

describe('detectIdle', () => {
  it('returns false for empty messages', () => {
    expect(detectIdle([])).toBe(false);
  });

  it('returns false when tools are running', () => {
    const msgs: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: '',
        timestamp: 1,
        toolCalls: [{ id: 't1', name: 'Bash', input: {}, status: 'running' }],
      },
    ];
    expect(detectIdle(msgs)).toBe(false);
  });

  it('returns false when tools are pending', () => {
    const msgs: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: '',
        timestamp: 1,
        toolCalls: [{ id: 't1', name: 'Bash', input: {}, status: 'pending' }],
      },
    ];
    expect(detectIdle(msgs)).toBe(false);
  });

  it('returns false when last message is user (assistant still processing)', () => {
    const msgs: ConversationMessage[] = [
      { id: '1', type: 'user', content: 'do something', timestamp: 1 },
    ];
    expect(detectIdle(msgs)).toBe(false);
  });

  // detectIdle returns !detectWaitingForInput when all tools completed and no question.
  // Since detectWaitingForInput returns true when assistant finished (all tools completed),
  // detectIdle returns false (it's waiting for user input, not idle).
  // Idle means the conversation is done — no one is waiting.
  it('returns false when assistant all-tools-completed (waiting for user)', () => {
    const msgs: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: 'Done!',
        timestamp: 1,
        toolCalls: [{ id: 't1', name: 'Read', input: {}, status: 'completed', output: 'ok' }],
      },
    ];
    // detectWaitingForInput returns true here, so detectIdle returns false
    expect(detectIdle(msgs)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectCurrentActivity
// ---------------------------------------------------------------------------

describe('detectCurrentActivity', () => {
  it('returns undefined for empty messages', () => {
    expect(detectCurrentActivity([])).toBeUndefined();
  });

  it('returns "Processing..." when last message is user', () => {
    const msgs: ConversationMessage[] = [
      { id: '1', type: 'user', content: 'do stuff', timestamp: 1 },
    ];
    expect(detectCurrentActivity(msgs)).toBe('Processing...');
  });

  it('returns tool description for running tool', () => {
    const msgs: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: '',
        timestamp: 1,
        toolCalls: [
          { id: 't1', name: 'Read', input: { file_path: '/src/app.ts' }, status: 'running' },
        ],
      },
    ];
    const activity = detectCurrentActivity(msgs);
    expect(activity).toContain('app.ts');
  });

  it('returns approval message for pending Bash tool', () => {
    const msgs: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: '',
        timestamp: 1,
        toolCalls: [
          { id: 't1', name: 'Bash', input: { command: 'npm install' }, status: 'pending' },
        ],
      },
    ];
    expect(detectCurrentActivity(msgs)).toBe('Approve? npm install');
  });

  it('returns approval message for pending Write tool with file path', () => {
    const msgs: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: '',
        timestamp: 1,
        toolCalls: [
          {
            id: 't1',
            name: 'Write',
            input: { file_path: '/src/index.ts' },
            status: 'pending',
          },
        ],
      },
    ];
    expect(detectCurrentActivity(msgs)).toBe('Approve write: index.ts?');
  });

  it('returns approval message for pending Edit tool', () => {
    const msgs: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: '',
        timestamp: 1,
        toolCalls: [
          {
            id: 't1',
            name: 'Edit',
            input: { file_path: '/src/parser.ts' },
            status: 'pending',
          },
        ],
      },
    ];
    expect(detectCurrentActivity(msgs)).toBe('Approve edit: parser.ts?');
  });

  it('returns undefined when assistant has no tools', () => {
    const msgs: ConversationMessage[] = [
      { id: '1', type: 'assistant', content: 'Done', timestamp: 1 },
    ];
    expect(detectCurrentActivity(msgs)).toBeUndefined();
  });

  it('reports last tool (uses last in array)', () => {
    const msgs: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: '',
        timestamp: 1,
        toolCalls: [
          { id: 't1', name: 'Read', input: { file_path: '/a' }, status: 'completed', output: 'ok' },
          { id: 't2', name: 'Grep', input: { pattern: 'TODO' }, status: 'running' },
        ],
      },
    ];
    const activity = detectCurrentActivity(msgs);
    // detectCurrentActivity uses getToolDescription for the last tool name,
    // then appends file_path or command if available. Grep has no file_path/command.
    expect(activity).toBe('Searching code');
  });

  it('truncates long Bash commands', () => {
    const longCmd = 'a'.repeat(50);
    const msgs: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: '',
        timestamp: 1,
        toolCalls: [{ id: 't1', name: 'Bash', input: { command: longCmd }, status: 'pending' }],
      },
    ];
    const activity = detectCurrentActivity(msgs);
    expect(activity).toContain('...');
    // Approval message truncates at 40 chars
    expect(activity!.length).toBeLessThan(60);
  });
});

// ---------------------------------------------------------------------------
// extractHighlights
// ---------------------------------------------------------------------------

describe('extractHighlights', () => {
  it('filters out empty messages', () => {
    const msgs: ConversationMessage[] = [
      { id: '1', type: 'assistant', content: '', timestamp: 1 },
      { id: '2', type: 'assistant', content: 'Hello', timestamp: 2 },
    ];
    const highlights = extractHighlights(msgs);
    expect(highlights).toHaveLength(1);
    expect(highlights[0].content).toBe('Hello');
  });

  it('filters out skill command triggers (<command-name>)', () => {
    const msgs: ConversationMessage[] = [
      { id: '1', type: 'user', content: '<command-name>/commit</command-name>', timestamp: 1 },
      { id: '2', type: 'assistant', content: 'Committing...', timestamp: 2 },
    ];
    const highlights = extractHighlights(msgs);
    // The <command-name> user message should be filtered out
    expect(highlights.every((h) => !h.content.includes('<command-name>'))).toBe(true);
  });

  it('maps pending tool status to "running" when user responded after', () => {
    const msgs: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: '',
        timestamp: 1,
        toolCalls: [{ id: 't1', name: 'Bash', input: { command: 'ls' }, status: 'pending' }],
        options: [{ label: 'yes', description: 'Approve' }],
        isWaitingForChoice: true,
      },
      { id: '2', type: 'user', content: 'yes', timestamp: 2 },
    ];
    const highlights = extractHighlights(msgs);
    const asst = highlights.find((h) => h.type === 'assistant');
    expect(asst?.toolCalls?.[0].status).toBe('running');
  });

  it('merges consecutive tool-only assistant messages', () => {
    const msgs: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: '',
        timestamp: 1,
        toolCalls: [{ id: 't1', name: 'Read', input: {}, status: 'completed', output: 'a' }],
      },
      {
        id: '2',
        type: 'assistant',
        content: '',
        timestamp: 2,
        toolCalls: [{ id: 't2', name: 'Grep', input: {}, status: 'completed', output: 'b' }],
      },
    ];
    const highlights = extractHighlights(msgs);
    expect(highlights).toHaveLength(1);
    expect(highlights[0].toolCalls).toHaveLength(2);
  });

  it('does not merge assistant messages that have text content', () => {
    const msgs: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: 'Found it.',
        timestamp: 1,
        toolCalls: [{ id: 't1', name: 'Read', input: {}, status: 'completed', output: 'a' }],
      },
      {
        id: '2',
        type: 'assistant',
        content: '',
        timestamp: 2,
        toolCalls: [{ id: 't2', name: 'Grep', input: {}, status: 'completed', output: 'b' }],
      },
    ];
    const highlights = extractHighlights(msgs);
    expect(highlights).toHaveLength(2);
  });

  it('preserves options only on the last message (or pending approval)', () => {
    const msgs: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: 'Q?',
        timestamp: 1,
        options: [{ label: 'A', description: 'pick A' }],
        isWaitingForChoice: true,
        toolCalls: [{ id: 't1', name: 'AskUserQuestion', input: {}, status: 'pending' }],
      },
    ];
    const highlights = extractHighlights(msgs);
    expect(highlights[0].options).toHaveLength(1);
    expect(highlights[0].isWaitingForChoice).toBe(true);
  });

  it('clears options when user has responded after', () => {
    const msgs: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: 'Q?',
        timestamp: 1,
        options: [{ label: 'A', description: 'pick A' }],
        isWaitingForChoice: true,
        toolCalls: [
          { id: 't1', name: 'AskUserQuestion', input: {}, status: 'completed', output: 'A' },
        ],
      },
      { id: '2', type: 'user', content: 'A', timestamp: 2 },
    ];
    const highlights = extractHighlights(msgs);
    const asst = highlights.find((h) => h.type === 'assistant');
    expect(asst?.options).toBeUndefined();
  });

  it('includes system messages (compaction)', () => {
    const msgs: ConversationMessage[] = [
      { id: 'c1', type: 'system', content: 'Context compacted', timestamp: 1, isCompaction: true },
      { id: '2', type: 'user', content: 'Continue', timestamp: 2 },
    ];
    const highlights = extractHighlights(msgs);
    const sys = highlights.find((h) => h.type === 'system');
    expect(sys).toBeDefined();
    expect(sys!.isCompaction).toBe(true);
  });

  it('includes assistant messages with only toolCalls (no text)', () => {
    const msgs: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: '',
        timestamp: 1,
        toolCalls: [{ id: 't1', name: 'Read', input: {}, status: 'completed', output: 'data' }],
      },
    ];
    const highlights = extractHighlights(msgs);
    expect(highlights).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// detectCurrentActivityFast
// ---------------------------------------------------------------------------

describe('detectCurrentActivityFast', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('returns undefined for missing file', () => {
    mockedFs.existsSync.mockReturnValue(false);
    expect(detectCurrentActivityFast('/tmp/missing.jsonl')).toBeUndefined();
  });

  it('detects running tool from tail of file', () => {
    const lines = jsonl(
      assistantWithTools('', [{ name: 'Grep', id: 'g1', input: { pattern: 'test' } }])
    );
    const buf = Buffer.from(lines);
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.statSync.mockReturnValue({ size: buf.length } as fs.Stats);
    mockedFs.openSync.mockReturnValue(42);
    mockedFs.readSync.mockImplementation(((_fd: number, buffer: any) => {
      buf.copy(buffer);
      return buf.length;
    }) as any);
    mockedFs.closeSync.mockReturnValue(undefined);

    const result = detectCurrentActivityFast('/tmp/test.jsonl');
    expect(result).toBe('Searching code');
  });

  it('returns "Processing..." when last entry is user message', () => {
    const lines = jsonl(userMsg('Do something'));
    const buf = Buffer.from(lines);
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.statSync.mockReturnValue({ size: buf.length } as fs.Stats);
    mockedFs.openSync.mockReturnValue(42);
    mockedFs.readSync.mockImplementation(((_fd: number, buffer: any) => {
      buf.copy(buffer);
      return buf.length;
    }) as any);
    mockedFs.closeSync.mockReturnValue(undefined);

    expect(detectCurrentActivityFast('/tmp/test.jsonl')).toBe('Processing...');
  });

  it('skips completed tools (has tool_result)', () => {
    const lines = jsonl(
      assistantWithTools('', [{ name: 'Read', id: 'r1', input: { file_path: '/f' } }]),
      toolResult('r1', 'file contents'),
      assistantText('Here is the file.')
    );
    const buf = Buffer.from(lines);
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.statSync.mockReturnValue({ size: buf.length } as fs.Stats);
    mockedFs.openSync.mockReturnValue(42);
    mockedFs.readSync.mockImplementation(((_fd: number, buffer: any) => {
      buf.copy(buffer);
      return buf.length;
    }) as any);
    mockedFs.closeSync.mockReturnValue(undefined);

    // All tools completed, assistant said something without tools → undefined
    expect(detectCurrentActivityFast('/tmp/test.jsonl')).toBeUndefined();
  });

  it('returns approval prompt for pending Bash tool', () => {
    const lines = jsonl(
      assistantWithTools('', [{ name: 'Bash', id: 'b1', input: { command: 'npm test' } }])
    );
    const buf = Buffer.from(lines);
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.statSync.mockReturnValue({ size: buf.length } as fs.Stats);
    mockedFs.openSync.mockReturnValue(42);
    mockedFs.readSync.mockImplementation(((_fd: number, buffer: any) => {
      buf.copy(buffer);
      return buf.length;
    }) as any);
    mockedFs.closeSync.mockReturnValue(undefined);

    expect(detectCurrentActivityFast('/tmp/test.jsonl')).toBe('Approve? npm test');
  });
});

// ---------------------------------------------------------------------------
// getSessionStatus
// ---------------------------------------------------------------------------

describe('getSessionStatus', () => {
  it('returns composite status for a conversation', () => {
    const content = jsonl(userMsg('Hello'), assistantText('Hi there!'));
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(content);

    const status = getSessionStatus('/tmp/test.jsonl', true);
    expect(status.isRunning).toBe(true);
    expect(status.isWaitingForInput).toBe(true); // assistant finished
    expect(status.lastActivity).toBeGreaterThan(0);
    expect(status.conversationId).toBe('/tmp/test.jsonl');
  });

  it('sets isWaitingForInput=false when process is not running', () => {
    const content = jsonl(assistantText('Hi'));
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(content);

    const status = getSessionStatus('/tmp/test.jsonl', false);
    expect(status.isRunning).toBe(false);
    expect(status.isWaitingForInput).toBe(false);
  });

  it('reports currentActivity when process is running', () => {
    const content = jsonl(
      assistantWithTools('', [{ name: 'Bash', id: 'b1', input: { command: 'npm test' } }])
    );
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(content);

    const status = getSessionStatus('/tmp/test.jsonl', true);
    expect(status.currentActivity).toContain('Approve');
  });
});

// ---------------------------------------------------------------------------
// getPendingApprovalTools
// ---------------------------------------------------------------------------

describe('getPendingApprovalTools', () => {
  it('returns empty for empty messages', () => {
    expect(getPendingApprovalTools([])).toEqual([]);
  });

  it('returns empty when last message is user', () => {
    const msgs: ConversationMessage[] = [{ id: '1', type: 'user', content: 'hi', timestamp: 1 }];
    expect(getPendingApprovalTools(msgs)).toEqual([]);
  });

  it('returns pending Bash tool', () => {
    const msgs: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: '',
        timestamp: 1,
        toolCalls: [{ id: 'bash1', name: 'Bash', input: { command: 'ls' }, status: 'pending' }],
      },
    ];
    const tools = getPendingApprovalTools(msgs);
    expect(tools).toEqual([{ name: 'Bash', id: 'bash1' }]);
  });

  it('excludes Task tools (background agents)', () => {
    const msgs: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: '',
        timestamp: 1,
        toolCalls: [
          { id: 'task1', name: 'Task', input: { description: 'research' }, status: 'pending' },
          { id: 'bash1', name: 'Bash', input: { command: 'ls' }, status: 'pending' },
        ],
      },
    ];
    const tools = getPendingApprovalTools(msgs);
    expect(tools).toEqual([{ name: 'Bash', id: 'bash1' }]);
  });

  it('excludes completed tools', () => {
    const msgs: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: '',
        timestamp: 1,
        toolCalls: [
          {
            id: 'bash1',
            name: 'Bash',
            input: { command: 'ls' },
            status: 'completed',
            output: 'ok',
          },
        ],
      },
    ];
    expect(getPendingApprovalTools(msgs)).toEqual([]);
  });

  it('returns multiple pending approval tools', () => {
    const msgs: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: '',
        timestamp: 1,
        toolCalls: [
          { id: 'w1', name: 'Write', input: { file_path: '/a' }, status: 'pending' },
          { id: 'e1', name: 'Edit', input: { file_path: '/b' }, status: 'pending' },
        ],
      },
    ];
    const tools = getPendingApprovalTools(msgs);
    expect(tools).toHaveLength(2);
    expect(tools[0]).toEqual({ name: 'Write', id: 'w1' });
    expect(tools[1]).toEqual({ name: 'Edit', id: 'e1' });
  });

  it('excludes non-approval tools (Read, Grep, etc.)', () => {
    const msgs: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: '',
        timestamp: 1,
        toolCalls: [
          { id: 'r1', name: 'Read', input: { file_path: '/f' }, status: 'pending' },
          { id: 'g1', name: 'Grep', input: { pattern: 'x' }, status: 'pending' },
        ],
      },
    ];
    expect(getPendingApprovalTools(msgs)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// detectCompaction
// ---------------------------------------------------------------------------

describe('detectCompaction', () => {
  it('returns null for empty content', () => {
    mockedFs.existsSync.mockReturnValue(false);
    const result = detectCompaction('/tmp/test.jsonl', 'sess1', 'Session 1', '/project');
    expect(result.event).toBeNull();
    expect(result.lastLine).toBe(0);
  });

  it('detects legacy summary compaction', () => {
    const content = jsonl(
      summaryEntry('Summary of previous context', { timestamp: '2026-01-28T09:00:00.000Z' })
    );
    const result = detectCompaction(
      '/tmp/test.jsonl',
      'sess1',
      'Session 1',
      '/project',
      0,
      content
    );
    expect(result.event).not.toBeNull();
    expect(result.event!.summary).toBe('Summary of previous context');
    expect(result.event!.sessionId).toBe('sess1');
    expect(result.event!.sessionName).toBe('Session 1');
    expect(result.event!.projectPath).toBe('/project');
  });

  it('detects compact_boundary format with following user summary', () => {
    const content = jsonl(
      compactBoundary({ timestamp: '2026-01-28T09:00:00.000Z' }),
      userMsg('Summary of what happened before', { timestamp: '2026-01-28T09:00:01.000Z' })
    );
    const result = detectCompaction(
      '/tmp/test.jsonl',
      'sess1',
      'Session 1',
      '/project',
      0,
      content
    );
    expect(result.event).not.toBeNull();
    expect(result.event!.summary).toBe('Summary of what happened before');
  });

  it('skips lines before lastCheckedLine', () => {
    const content = jsonl(summaryEntry('Old summary'), userMsg('Continue'), assistantText('Done'));
    const result = detectCompaction(
      '/tmp/test.jsonl',
      'sess1',
      'Session 1',
      '/project',
      3,
      content
    );
    expect(result.event).toBeNull();
  });

  it('returns lastLine equal to total lines', () => {
    const content = jsonl(userMsg('line1'), assistantText('line2'));
    const result = detectCompaction(
      '/tmp/test.jsonl',
      'sess1',
      'Session 1',
      '/project',
      0,
      content
    );
    expect(result.lastLine).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// extractUsageFromFile
// ---------------------------------------------------------------------------

describe('extractUsageFromFile', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('returns zeros for missing file', () => {
    mockedFs.existsSync.mockReturnValue(false);
    const usage = extractUsageFromFile('/tmp/missing.jsonl', 'session1');
    expect(usage.totalInputTokens).toBe(0);
    expect(usage.totalOutputTokens).toBe(0);
    expect(usage.messageCount).toBe(0);
  });

  it('extracts input/output tokens', () => {
    const content = jsonl(usageEntry(1000, 500, { msgId: 'msg1' }));
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(content);

    const usage = extractUsageFromFile('/tmp/test.jsonl', 'session1');
    expect(usage.totalInputTokens).toBe(1000);
    expect(usage.totalOutputTokens).toBe(500);
    expect(usage.messageCount).toBe(1);
  });

  it('accumulates tokens across multiple messages', () => {
    const content = jsonl(
      usageEntry(1000, 500, { msgId: 'msg1' }),
      usageEntry(2000, 800, { msgId: 'msg2' })
    );
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(content);

    const usage = extractUsageFromFile('/tmp/test.jsonl', 'session1');
    expect(usage.totalInputTokens).toBe(3000);
    expect(usage.totalOutputTokens).toBe(1300);
    expect(usage.messageCount).toBe(2);
  });

  it('deduplicates by message ID (streaming entries)', () => {
    const content = jsonl(
      usageEntry(1000, 500, { msgId: 'msg1' }),
      usageEntry(1000, 500, { msgId: 'msg1' }) // duplicate
    );
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(content);

    const usage = extractUsageFromFile('/tmp/test.jsonl', 'session1');
    expect(usage.totalInputTokens).toBe(1000);
    expect(usage.messageCount).toBe(1);
  });

  it('extracts cache tokens', () => {
    const content = jsonl(
      usageEntry(1000, 500, { msgId: 'msg1', cacheCreation: 200, cacheRead: 300 })
    );
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(content);

    const usage = extractUsageFromFile('/tmp/test.jsonl', 'session1');
    expect(usage.totalCacheCreationTokens).toBe(200);
    expect(usage.totalCacheReadTokens).toBe(300);
  });

  it('tracks currentContextTokens from last message', () => {
    const content = jsonl(
      usageEntry(1000, 500, { msgId: 'msg1' }),
      usageEntry(5000, 800, { msgId: 'msg2' })
    );
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(content);

    const usage = extractUsageFromFile('/tmp/test.jsonl', 'session1');
    expect(usage.currentContextTokens).toBe(5000);
  });

  it('uses filePath as sessionId', () => {
    mockedFs.existsSync.mockReturnValue(false);
    const usage = extractUsageFromFile('/tmp/test.jsonl', 'my-session');
    expect(usage.sessionId).toBe('/tmp/test.jsonl');
    expect(usage.sessionName).toBe('my-session');
  });
});

// ---------------------------------------------------------------------------
// extractFileChanges
// ---------------------------------------------------------------------------

describe('extractFileChanges', () => {
  it('returns empty for empty content', () => {
    expect(extractFileChanges('')).toEqual([]);
  });

  it('extracts completed Write tool calls', () => {
    const content = jsonl(
      assistantWithTools('', [{ name: 'Write', id: 'w1', input: { file_path: '/src/app.ts' } }], {
        timestamp: '2026-01-28T10:00:00.000Z',
      }),
      toolResult('w1', 'ok')
    );
    const changes = extractFileChanges(content);
    expect(changes).toHaveLength(1);
    expect(changes[0].path).toBe('/src/app.ts');
    expect(changes[0].action).toBe('write');
  });

  it('extracts completed Edit tool calls', () => {
    const content = jsonl(
      assistantWithTools('', [{ name: 'Edit', id: 'e1', input: { file_path: '/src/utils.ts' } }], {
        timestamp: '2026-01-28T10:00:00.000Z',
      }),
      toolResult('e1', 'ok')
    );
    const changes = extractFileChanges(content);
    expect(changes).toHaveLength(1);
    expect(changes[0].path).toBe('/src/utils.ts');
    expect(changes[0].action).toBe('edit');
  });

  it('excludes incomplete tool calls (no tool_result)', () => {
    const content = jsonl(
      assistantWithTools('', [{ name: 'Write', id: 'w1', input: { file_path: '/src/pending.ts' } }])
    );
    const changes = extractFileChanges(content);
    expect(changes).toHaveLength(0);
  });

  it('deduplicates by file path, keeping latest timestamp', () => {
    const content = jsonl(
      assistantWithTools('', [{ name: 'Edit', id: 'e1', input: { file_path: '/src/app.ts' } }], {
        timestamp: '2026-01-28T10:00:00.000Z',
      }),
      toolResult('e1', 'ok', { timestamp: '2026-01-28T10:00:01.000Z' }),
      assistantWithTools('', [{ name: 'Edit', id: 'e2', input: { file_path: '/src/app.ts' } }], {
        timestamp: '2026-01-28T10:05:00.000Z',
      }),
      toolResult('e2', 'ok', { timestamp: '2026-01-28T10:05:01.000Z' })
    );
    const changes = extractFileChanges(content);
    expect(changes).toHaveLength(1);
    expect(changes[0].timestamp).toBe(new Date('2026-01-28T10:05:00.000Z').getTime());
  });

  it('upgrades to "write" if both edit and write on same file', () => {
    const content = jsonl(
      assistantWithTools('', [{ name: 'Edit', id: 'e1', input: { file_path: '/src/app.ts' } }], {
        timestamp: '2026-01-28T10:00:00.000Z',
      }),
      toolResult('e1', 'ok'),
      assistantWithTools('', [{ name: 'Write', id: 'w1', input: { file_path: '/src/app.ts' } }], {
        timestamp: '2026-01-28T10:01:00.000Z',
      }),
      toolResult('w1', 'ok')
    );
    const changes = extractFileChanges(content);
    expect(changes).toHaveLength(1);
    expect(changes[0].action).toBe('write');
  });

  it('sorts results by path', () => {
    const content = jsonl(
      assistantWithTools('', [{ name: 'Write', id: 'w1', input: { file_path: '/z/file.ts' } }], {
        timestamp: '2026-01-28T10:00:00.000Z',
      }),
      toolResult('w1', 'ok'),
      assistantWithTools('', [{ name: 'Write', id: 'w2', input: { file_path: '/a/file.ts' } }], {
        timestamp: '2026-01-28T10:01:00.000Z',
      }),
      toolResult('w2', 'ok')
    );
    const changes = extractFileChanges(content);
    expect(changes[0].path).toBe('/a/file.ts');
    expect(changes[1].path).toBe('/z/file.ts');
  });

  it('ignores non-Write/Edit tools', () => {
    const content = jsonl(
      assistantWithTools('', [
        { name: 'Bash', id: 'b1', input: { command: 'ls' } },
        { name: 'Read', id: 'r1', input: { file_path: '/f' } },
      ]),
      toolResult('b1', 'ok'),
      toolResult('r1', 'ok')
    );
    expect(extractFileChanges(content)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseConversationChain
// ---------------------------------------------------------------------------

describe('parseConversationChain', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('returns empty for empty file list', () => {
    const result = parseConversationChain([], 10, 0);
    expect(result.highlights).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.hasMore).toBe(false);
  });

  it('parses a single file', () => {
    const content = jsonl(
      userMsg('Hello', { timestamp: '2026-01-28T10:00:00.000Z' }),
      assistantText('Hi!', { timestamp: '2026-01-28T10:01:00.000Z' })
    );
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(content);

    const result = parseConversationChain(['/file1.jsonl'], 10, 0);
    expect(result.highlights.length).toBeGreaterThanOrEqual(2);
    expect(result.hasMore).toBe(false);
  });

  it('inserts session boundary between files', () => {
    const file1 = jsonl(
      userMsg('Old msg', { timestamp: '2026-01-28T09:00:00.000Z' }),
      assistantText('Old reply', { timestamp: '2026-01-28T09:01:00.000Z' })
    );
    const file2 = jsonl(
      userMsg('New msg', { timestamp: '2026-01-28T10:00:00.000Z' }),
      assistantText('New reply', { timestamp: '2026-01-28T10:01:00.000Z' })
    );
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((path) => {
      if (String(path).includes('file1')) return file1;
      return file2;
    });

    const result = parseConversationChain(['/file1.jsonl', '/file2.jsonl'], 100, 0);
    const boundary = result.highlights.find((h) => h.content.includes('Previous session'));
    expect(boundary).toBeDefined();
  });

  it('supports pagination with offset', () => {
    const content = jsonl(
      userMsg('m1', { timestamp: '2026-01-28T10:00:00.000Z' }),
      assistantText('m2', { timestamp: '2026-01-28T10:01:00.000Z' }),
      userMsg('m3', { timestamp: '2026-01-28T10:02:00.000Z' }),
      assistantText('m4', { timestamp: '2026-01-28T10:03:00.000Z' })
    );
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(content);

    const page1 = parseConversationChain(['/file.jsonl'], 2, 0);
    const page2 = parseConversationChain(['/file.jsonl'], 2, 2);

    // Both pages should have results; page2 should have earlier messages
    expect(page1.highlights.length).toBeLessThanOrEqual(2);
    expect(page2.highlights.length).toBeLessThanOrEqual(2);
    expect(page1.total).toBe(page2.total);
  });
});

// ---------------------------------------------------------------------------
// getRecentActivity
// ---------------------------------------------------------------------------

describe('getRecentActivity', () => {
  it('returns empty for empty messages', () => {
    expect(getRecentActivity([])).toEqual([]);
  });

  it('returns tool activities in chronological order', () => {
    const msgs: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: '',
        timestamp: 100,
        toolCalls: [
          {
            id: 't1',
            name: 'Read',
            input: { file_path: '/a.ts' },
            status: 'completed',
            output: 'data',
          },
        ],
      },
      {
        id: '2',
        type: 'assistant',
        content: '',
        timestamp: 200,
        toolCalls: [
          {
            id: 't2',
            name: 'Bash',
            input: { command: 'npm test' },
            status: 'completed',
            output: 'pass',
          },
        ],
      },
    ];
    const activity = getRecentActivity(msgs);
    expect(activity).toHaveLength(2);
    // Chronological: Read first, Bash second
    expect(activity[0].toolName).toBe('Read');
    expect(activity[1].toolName).toBe('Bash');
  });

  it('respects limit parameter', () => {
    const msgs: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: '',
        timestamp: 100,
        toolCalls: [
          { id: 't1', name: 'Read', input: { file_path: '/a' }, status: 'completed', output: '' },
          { id: 't2', name: 'Read', input: { file_path: '/b' }, status: 'completed', output: '' },
          { id: 't3', name: 'Read', input: { file_path: '/c' }, status: 'completed', output: '' },
        ],
      },
    ];
    const activity = getRecentActivity(msgs, 2);
    expect(activity).toHaveLength(2);
  });

  it('formats summary with file_path', () => {
    const msgs: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: '',
        timestamp: 100,
        toolCalls: [
          {
            id: 't1',
            name: 'Read',
            input: { file_path: '/src/app.ts' },
            status: 'completed',
            output: '',
          },
        ],
      },
    ];
    const activity = getRecentActivity(msgs);
    expect(activity[0].summary).toBe('Read: /src/app.ts');
    expect(activity[0].input).toBe('/src/app.ts');
  });

  it('formats summary with command', () => {
    const msgs: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: '',
        timestamp: 100,
        toolCalls: [
          {
            id: 't1',
            name: 'Bash',
            input: { command: 'npm test' },
            status: 'completed',
            output: 'ok',
          },
        ],
      },
    ];
    const activity = getRecentActivity(msgs);
    expect(activity[0].summary).toBe('Bash: npm test');
    expect(activity[0].input).toBe('npm test');
  });

  it('formats summary with pattern', () => {
    const msgs: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: '',
        timestamp: 100,
        toolCalls: [
          {
            id: 't1',
            name: 'Grep',
            input: { pattern: 'TODO' },
            status: 'completed',
            output: 'matches',
          },
        ],
      },
    ];
    const activity = getRecentActivity(msgs);
    expect(activity[0].summary).toBe('Grep: Pattern: TODO');
  });

  it('skips user messages', () => {
    const msgs: ConversationMessage[] = [
      { id: '1', type: 'user', content: 'hello', timestamp: 100 },
    ];
    expect(getRecentActivity(msgs)).toEqual([]);
  });

  it('truncates long output', () => {
    const longOutput = 'x'.repeat(5000);
    const msgs: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: '',
        timestamp: 100,
        toolCalls: [
          {
            id: 't1',
            name: 'Bash',
            input: { command: 'cat big' },
            status: 'completed',
            output: longOutput,
          },
        ],
      },
    ];
    const activity = getRecentActivity(msgs);
    expect(activity[0].output!.length).toBeLessThanOrEqual(2000);
  });
});
