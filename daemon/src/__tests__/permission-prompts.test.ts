import {
  parsePermissionPrompt,
  mapPermissionLabel,
  parseConversationFile,
  extractHighlights,
} from '../parser';
import { ConversationMessage } from '../types';

// ---------------------------------------------------------------------------
// JSONL fixture helpers (same pattern as parser.test.ts)
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

// ---------------------------------------------------------------------------
// 1. parsePermissionPrompt regex
// ---------------------------------------------------------------------------

describe('parsePermissionPrompt', () => {
  it('matches a standard permission prompt with numbered options', () => {
    const text = [
      'Some output text',
      'Do you want to proceed with this action?',
      '❯ 1. Yes',
      '  2. Yes, allow all',
      '  3. No',
    ].join('\n');

    const result = parsePermissionPrompt(text);
    expect(result).not.toBeNull();
    expect(result!.question).toBe('Do you want to proceed with this action?');
    expect(result!.options).toHaveLength(3);
    expect(result!.options[0].label).toBe('yes');
    expect(result!.options[1].label).toBe("yes, and don't ask again for this session");
    expect(result!.options[2].label).toBe('no');
  });

  it('strips the prompt from content', () => {
    const text = [
      'Let me edit the file.',
      'Do you want to allow this edit?',
      '❯ 1. Yes',
      '  2. No',
    ].join('\n');

    const result = parsePermissionPrompt(text);
    expect(result).not.toBeNull();
    expect(result!.cleanContent).toBe('Let me edit the file.');
  });

  it('handles selector arrow on different options', () => {
    const text = [
      'Do you want to run this command?',
      '  1. Yes',
      '❯ 2. No',
    ].join('\n');

    const result = parsePermissionPrompt(text);
    expect(result).not.toBeNull();
    expect(result!.options).toHaveLength(2);
  });

  it('strips Esc footer line', () => {
    const text = [
      'Do you want to execute this?',
      '❯ 1. Yes',
      '  2. No',
      'Esc to cancel · Tab to amend',
    ].join('\n');

    const result = parsePermissionPrompt(text);
    expect(result).not.toBeNull();
    expect(result!.options).toHaveLength(2);
    // Footer should not appear in clean content
    expect(result!.cleanContent).not.toContain('Esc to cancel');
  });

  it('strips keyboard shortcut hints from option labels', () => {
    const text = [
      'Do you want to allow this?',
      '❯ 1. Yes (y)',
      '  2. Yes, allow all (shift+tab)',
      '  3. No (n)',
    ].join('\n');

    const result = parsePermissionPrompt(text);
    expect(result).not.toBeNull();
    expect(result!.options[0].label).toBe('yes');
    expect(result!.options[1].label).toBe("yes, and don't ask again for this session");
    expect(result!.options[2].label).toBe('no');
  });

  it('returns null for non-prompt text', () => {
    expect(parsePermissionPrompt('Just regular output')).toBeNull();
    expect(parsePermissionPrompt('Here is the file content.')).toBeNull();
    expect(parsePermissionPrompt('')).toBeNull();
  });

  it('returns null when there are no numbered options', () => {
    const text = 'Do you want to do this?\nSure, go ahead.';
    expect(parsePermissionPrompt(text)).toBeNull();
  });

  it('returns null for question without "Do you want to" prefix', () => {
    const text = [
      'Should I proceed?',
      '❯ 1. Yes',
      '  2. No',
    ].join('\n');
    expect(parsePermissionPrompt(text)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. mapPermissionLabel
// ---------------------------------------------------------------------------

describe('mapPermissionLabel', () => {
  it('normalizes "Yes" to "yes"', () => {
    expect(mapPermissionLabel('Yes')).toBe('yes');
  });

  it('normalizes "No" to "no"', () => {
    expect(mapPermissionLabel('No')).toBe('no');
  });

  it('normalizes "Yes, allow all" to session-level permission', () => {
    expect(mapPermissionLabel('Yes, allow all')).toBe(
      "yes, and don't ask again for this session"
    );
  });

  it('normalizes "Don\'t ask again" variants', () => {
    expect(mapPermissionLabel("Yes, don't ask again")).toBe(
      "yes, and don't ask again for this session"
    );
  });

  it('lowercases unknown labels', () => {
    expect(mapPermissionLabel('Custom Option')).toBe('custom option');
  });
});

// ---------------------------------------------------------------------------
// 3. Tool-based approval options
// ---------------------------------------------------------------------------

describe('tool-based approval options', () => {
  it('generates yes/always/no options for pending Bash tool', () => {
    const content = jsonl(
      assistantWithTools('', [
        { name: 'Bash', id: 'bash1', input: { command: 'npm test' } },
      ])
    );
    const msgs = parseConversationFile('test.jsonl', Infinity, content);
    expect(msgs[0].options).toBeDefined();
    expect(msgs[0].options).toHaveLength(3);
    expect(msgs[0].options![0].label).toBe('yes');
    expect(msgs[0].options![1].label).toBe("yes, and don't ask again for this session");
    expect(msgs[0].options![2].label).toBe('no');
    expect(msgs[0].isWaitingForChoice).toBe(true);
  });

  it('generates yes/always/no options for pending Edit tool', () => {
    const content = jsonl(
      assistantWithTools('', [
        { name: 'Edit', id: 'e1', input: { file_path: '/src/app.ts' } },
      ])
    );
    const msgs = parseConversationFile('test.jsonl', Infinity, content);
    expect(msgs[0].options).toBeDefined();
    expect(msgs[0].options).toHaveLength(3);
    expect(msgs[0].options![0].description).toContain('Edit: /src/app.ts');
  });

  it('generates yes/always/no options for pending Write tool', () => {
    const content = jsonl(
      assistantWithTools('', [
        { name: 'Write', id: 'w1', input: { file_path: '/src/new.ts' } },
      ])
    );
    const msgs = parseConversationFile('test.jsonl', Infinity, content);
    expect(msgs[0].options).toBeDefined();
    expect(msgs[0].options).toHaveLength(3);
    expect(msgs[0].options![0].description).toContain('Write: /src/new.ts');
  });

  it('generates yes/no (2 options) for pending EnterPlanMode tool', () => {
    const content = jsonl(
      assistantWithTools('', [
        { name: 'EnterPlanMode', id: 'pm1', input: {} },
      ])
    );
    const msgs = parseConversationFile('test.jsonl', Infinity, content);
    expect(msgs[0].options).toBeDefined();
    expect(msgs[0].options).toHaveLength(2);
    expect(msgs[0].options![0].label).toBe('yes');
    expect(msgs[0].options![1].label).toBe('no');
  });

  it('does not generate options for completed approval tools', () => {
    const content = jsonl(
      assistantWithTools('', [
        { name: 'Bash', id: 'bash1', input: { command: 'ls' } },
      ]),
      toolResult('bash1', 'file1\nfile2')
    );
    const msgs = parseConversationFile('test.jsonl', Infinity, content);
    const asst = msgs.find((m) => m.type === 'assistant');
    expect(asst?.options).toBeUndefined();
    expect(asst?.isWaitingForChoice).toBeFalsy();
  });

  it('does not generate options for pending Task tool (background agent)', () => {
    const content = jsonl(
      assistantWithTools('', [
        { name: 'Task', id: 'task1', input: { description: 'Research' } },
      ])
    );
    const msgs = parseConversationFile('test.jsonl', Infinity, content);
    expect(msgs[0].options).toBeUndefined();
  });

  it('does not generate options for pending ExitPlanMode tool', () => {
    const content = jsonl(
      assistantWithTools('', [
        { name: 'ExitPlanMode', id: 'ep1', input: {} },
      ])
    );
    const msgs = parseConversationFile('test.jsonl', Infinity, content);
    // ExitPlanMode is excluded from approval option generation
    expect(msgs[0].options).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Text prompt stripping (the fix)
// ---------------------------------------------------------------------------

describe('text prompt stripping (the fix)', () => {
  it('strips permission prompt text from content', () => {
    // Assistant message with permission prompt text but NO pending approval tool
    const promptText = [
      'Let me run this command.',
      'Do you want to proceed with this action?',
      '❯ 1. Yes',
      '  2. Yes, allow all',
      '  3. No',
    ].join('\n');

    const content = jsonl(
      assistantWithTools(promptText, [
        { name: 'Read', id: 'r1', input: { file_path: '/src/app.ts' } },
      ]),
      toolResult('r1', 'file contents')
    );

    const msgs = parseConversationFile('test.jsonl', Infinity, content);
    const asst = msgs.find((m) => m.type === 'assistant');

    // Content should be stripped of the prompt text
    expect(asst!.content).toBe('Let me run this command.');
    // No options should be set (Read is not an approval tool, and text-based path no longer sets options)
    expect(asst!.options).toBeUndefined();
  });

  it('does NOT set options from text regex alone', () => {
    // Text has a permission prompt but there's no pending approval tool
    const promptText = [
      'Do you want to allow this edit?',
      '❯ 1. Yes',
      '  2. No',
    ].join('\n');

    const content = jsonl(
      // Assistant with just text (no tool_use blocks)
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: promptText }],
        },
        uuid: 'asst-text-only',
        timestamp: '2026-01-28T10:01:00.000Z',
      }
    );

    const msgs = parseConversationFile('test.jsonl', Infinity, content);
    // Content should be cleaned
    expect(msgs[0].content).toBe('');
    // Options must NOT be set from text regex
    expect(msgs[0].options).toBeUndefined();
    expect(msgs[0].isWaitingForChoice).toBeFalsy();
  });

  it('preserves tool-based options when text prompt is also present', () => {
    // Both a pending Bash tool AND text prompt present
    const promptText = [
      'I need to run this command.',
      'Do you want to proceed with this action?',
      '❯ 1. Yes',
      '  2. Yes, allow all',
      '  3. No',
    ].join('\n');

    const content = jsonl(
      assistantWithTools(promptText, [
        { name: 'Bash', id: 'bash1', input: { command: 'npm test' } },
      ])
    );

    const msgs = parseConversationFile('test.jsonl', Infinity, content);
    // Content should be stripped of the prompt
    expect(msgs[0].content).toBe('I need to run this command.');
    // Options should come from the tool-based path (3 options for standard approval)
    expect(msgs[0].options).toBeDefined();
    expect(msgs[0].options).toHaveLength(3);
    expect(msgs[0].isWaitingForChoice).toBe(true);
  });

  it('cleans content even when tool options are already set', () => {
    // Pending Edit tool sets options first, then text cleanup happens
    const promptText = [
      'Editing the file now.',
      'Do you want to allow this edit?',
      '❯ 1. Yes',
      '  2. No',
    ].join('\n');

    const content = jsonl(
      assistantWithTools(promptText, [
        { name: 'Edit', id: 'e1', input: { file_path: '/src/main.ts' } },
      ])
    );

    const msgs = parseConversationFile('test.jsonl', Infinity, content);
    // Content should still be cleaned
    expect(msgs[0].content).toBe('Editing the file now.');
    // Options come from tool path
    expect(msgs[0].options).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 5. extractHighlights visibility
// ---------------------------------------------------------------------------

describe('extractHighlights visibility for permission prompts', () => {
  it('shows options when message is last and has pending approval tool', () => {
    const msgs: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: '',
        timestamp: 1,
        toolCalls: [{ id: 'bash1', name: 'Bash', input: { command: 'ls' }, status: 'pending' }],
        options: [
          { label: 'yes', description: 'Approve' },
          { label: "yes, and don't ask again for this session", description: 'Always' },
          { label: 'no', description: 'Reject' },
        ],
        isWaitingForChoice: true,
      },
    ];
    const highlights = extractHighlights(msgs);
    expect(highlights[0].options).toHaveLength(3);
    expect(highlights[0].isWaitingForChoice).toBe(true);
  });

  it('hides options when user has responded after', () => {
    const msgs: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: '',
        timestamp: 1,
        toolCalls: [{ id: 'bash1', name: 'Bash', input: { command: 'ls' }, status: 'pending' }],
        options: [
          { label: 'yes', description: 'Approve' },
          { label: 'no', description: 'Reject' },
        ],
        isWaitingForChoice: true,
      },
      { id: '2', type: 'user', content: 'yes', timestamp: 2 },
    ];
    const highlights = extractHighlights(msgs);
    const asst = highlights.find((h) => h.type === 'assistant');
    expect(asst?.options).toBeUndefined();
    expect(asst?.isWaitingForChoice).toBe(false);
    // Tool should be marked as running (user approved)
    expect(asst?.toolCalls?.[0].status).toBe('running');
  });

  it('hides options when all tools completed', () => {
    const msgs: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: 'Done',
        timestamp: 1,
        toolCalls: [
          { id: 'bash1', name: 'Bash', input: { command: 'ls' }, status: 'completed', output: 'ok' },
        ],
        options: [
          { label: 'yes', description: 'Approve' },
          { label: 'no', description: 'Reject' },
        ],
        isWaitingForChoice: true,
      },
    ];
    const highlights = extractHighlights(msgs);
    expect(highlights[0].options).toBeUndefined();
  });

  it('shows options on non-last message if it has pending interactive tool', () => {
    const msgs: ConversationMessage[] = [
      {
        id: '1',
        type: 'assistant',
        content: 'Approve?',
        timestamp: 1,
        toolCalls: [{ id: 'bash1', name: 'Bash', input: { command: 'rm -rf /tmp' }, status: 'pending' }],
        options: [
          { label: 'yes', description: 'Approve' },
          { label: 'no', description: 'Reject' },
        ],
        isWaitingForChoice: true,
      },
      // Another assistant message after (unusual but possible)
      {
        id: '2',
        type: 'assistant',
        content: 'Still waiting...',
        timestamp: 2,
      },
    ];
    const highlights = extractHighlights(msgs);
    const first = highlights.find((h) => h.id === '1');
    // Should show options because it has a pending approval tool
    expect(first?.options).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 6. End-to-end scenarios
// ---------------------------------------------------------------------------

describe('end-to-end permission prompt scenarios', () => {
  it('full approval flow: pending tool -> user approves -> tool completes', () => {
    const content = jsonl(
      userMsg('Run the tests'),
      assistantWithTools('Let me run the tests.', [
        { name: 'Bash', id: 'bash1', input: { command: 'npm test' } },
      ], { timestamp: '2026-01-28T10:01:00.000Z' }),
      // User approves (tool_result from approval)
      toolResult('bash1', 'All tests passed', { timestamp: '2026-01-28T10:02:00.000Z' }),
      assistantText('All tests passed!', { timestamp: '2026-01-28T10:03:00.000Z' })
    );

    const msgs = parseConversationFile('test.jsonl', Infinity, content);
    const highlights = extractHighlights(msgs);

    // The Bash tool should now be completed
    const assistantMsg = highlights.find(
      (h) => h.type === 'assistant' && h.toolCalls?.some((tc) => tc.name === 'Bash')
    );
    expect(assistantMsg?.toolCalls?.[0].status).toBe('completed');
    expect(assistantMsg?.options).toBeUndefined();
  });

  it('text prompt with no matching tool does not create options', () => {
    // Simulates the false-positive scenario: permission text but no pending approval tool
    const promptText = [
      'Here is the analysis.',
      'Do you want to allow this edit?',
      '❯ 1. Yes',
      '  2. No',
    ].join('\n');

    const content = jsonl(
      userMsg('Analyze the code'),
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: promptText }],
        },
        uuid: 'asst-fp',
        timestamp: '2026-01-28T10:01:00.000Z',
      }
    );

    const msgs = parseConversationFile('test.jsonl', Infinity, content);
    const highlights = extractHighlights(msgs);

    const asst = highlights.find((h) => h.type === 'assistant');
    // Content cleaned of prompt text
    expect(asst!.content).toBe('Here is the analysis.');
    // No options — the fix prevents false positives
    expect(asst?.options).toBeUndefined();
    expect(asst?.isWaitingForChoice).toBe(false);
  });

  it('multiple tools: only the approval tool generates options', () => {
    const content = jsonl(
      assistantWithTools('Reading and then editing.', [
        { name: 'Read', id: 'r1', input: { file_path: '/src/app.ts' } },
        { name: 'Edit', id: 'e1', input: { file_path: '/src/app.ts' } },
      ]),
      toolResult('r1', 'file contents')
      // Edit tool still pending
    );

    const msgs = parseConversationFile('test.jsonl', Infinity, content);
    // Options should come from the Edit tool (approval tool)
    expect(msgs[0].options).toBeDefined();
    expect(msgs[0].options).toHaveLength(3);
    expect(msgs[0].isWaitingForChoice).toBe(true);
  });

  it('pending Bash with prompt text: options come from tool, text is cleaned', () => {
    const promptText = [
      'Running command.',
      'Do you want to proceed with this action?',
      '❯ 1. Yes',
      '  2. Yes, allow all',
      '  3. No',
      'Esc to cancel · Tab to amend',
    ].join('\n');

    const content = jsonl(
      assistantWithTools(promptText, [
        { name: 'Bash', id: 'bash1', input: { command: 'rm -rf /tmp/test' } },
      ])
    );

    const msgs = parseConversationFile('test.jsonl', Infinity, content);
    const highlights = extractHighlights(msgs);

    const asst = highlights[0];
    // Text is cleaned
    expect(asst.content).toBe('Running command.');
    // Options come from tool-based path
    expect(asst.options).toHaveLength(3);
    expect(asst.options![0].description).toContain('rm -rf /tmp/test');
  });
});
