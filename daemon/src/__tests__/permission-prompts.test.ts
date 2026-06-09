import {
  parsePermissionPrompt,
  parseTextChoicePrompt,
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

    // Content should be stripped of the prompt text (question line + options block)
    expect(asst!.content).toBe('Let me run this command.');
    // Read is not an approval tool, but the SAFE text-choice detector now fires
    // because there is an arrow selector + adjacent "Do you want…?" question line.
    expect(asst!.options).toHaveLength(3);
    expect(asst!.isWaitingForChoice).toBe(true);
  });

  it('sets options from a text-only choice prompt with an arrow selector', () => {
    // Text has an interactive choice box but there's no pending approval tool —
    // this is the terminal-mode / text-rendered case the detector must cover.
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
    // The question line + options block are stripped from content.
    expect(msgs[0].content).toBe('');
    // Options ARE set now (arrow selector is a strong interactive signal).
    expect(msgs[0].options).toHaveLength(2);
    expect(msgs[0].options![0].label).toBe('Yes');
    expect(msgs[0].options![1].label).toBe('No');
    expect(msgs[0].isWaitingForChoice).toBe(true);
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

  it('text choice prompt with no matching tool still yields options (terminal-mode case)', () => {
    // A real interactive choice rendered only as text (no tool_use). With a question
    // line + arrow selector, the safe detector populates options.
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
    // Options set from the safe text-choice detector (it is the last message).
    expect(asst?.options).toHaveLength(2);
    expect(asst?.isWaitingForChoice).toBe(true);
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

// ---------------------------------------------------------------------------
// 7. parseTextChoicePrompt — safe text-based multi-choice detection
// ---------------------------------------------------------------------------

describe('parseTextChoicePrompt — enumeration styles', () => {
  it('matches "N." numbered list with arrow selector', () => {
    const text = ['Pick a deploy mode:', '❯ 1. Candidate', '  2. One-shot'].join('\n');
    const r = parseTextChoicePrompt(text);
    expect(r).not.toBeNull();
    expect(r!.options.map((o) => o.label)).toEqual(['Candidate', 'One-shot']);
  });

  it('matches "N)" paren-numbered list with a question line', () => {
    const text = ['Which path do you want?', '1) Fast path', '2) Safe path'].join('\n');
    const r = parseTextChoicePrompt(text);
    expect(r).not.toBeNull();
    expect(r!.options).toHaveLength(2);
    expect(r!.question).toBe('Which path do you want?');
  });

  it('matches "(N)" bracket-numbered list with an Esc affordance', () => {
    const text = ['(1) Yes', '(2) No', 'Esc to cancel · Tab to amend'].join('\n');
    const r = parseTextChoicePrompt(text);
    expect(r).not.toBeNull();
    expect(r!.options.map((o) => o.label)).toEqual(['Yes', 'No']);
    expect(r!.cleanContent).not.toContain('Esc to cancel');
  });

  it('matches arrow-prefixed "❯ N." and strips the marker', () => {
    const text = ['Choose one:', '❯ 1. Alpha', '  2. Beta', '  3. Gamma'].join('\n');
    const r = parseTextChoicePrompt(text);
    expect(r).not.toBeNull();
    expect(r!.options).toHaveLength(3);
    expect(r!.options[0].label).toBe('Alpha'); // marker stripped
  });

  it('matches ">"-prefixed current-selection marker', () => {
    const text = ['Select an option:', '  1. One', '> 2. Two'].join('\n');
    const r = parseTextChoicePrompt(text);
    expect(r).not.toBeNull();
    expect(r!.options[1].label).toBe('Two');
  });

  it('matches lettered "a." / "b." list with a question line', () => {
    const text = ['Which option would you like?', 'a. Apple', 'b. Banana'].join('\n');
    const r = parseTextChoicePrompt(text);
    expect(r).not.toBeNull();
    expect(r!.options.map((o) => o.label)).toEqual(['Apple', 'Banana']);
  });

  it('strips keyboard-shortcut hints from labels', () => {
    const text = ['Do you want to allow this?', '❯ 1. Yes (y)', '  2. No (n)'].join('\n');
    const r = parseTextChoicePrompt(text);
    expect(r!.options[0].label).toBe('Yes');
    expect(r!.options[1].label).toBe('No');
  });

  it('strips the question line and option block from cleanContent', () => {
    const text = [
      'Here is some context.',
      'Do you want to continue?',
      '❯ 1. Yes',
      '  2. No',
    ].join('\n');
    const r = parseTextChoicePrompt(text);
    expect(r!.cleanContent).toBe('Here is some context.');
  });
});

describe('parseTextChoicePrompt — false-positive guards', () => {
  it('does NOT match a prose numbered list with no interactive signal', () => {
    const text = [
      'Here are the steps I will take:',
      '1. Read the file',
      '2. Edit the function',
      '3. Run the tests',
    ].join('\n');
    expect(parseTextChoicePrompt(text)).toBeNull();
  });

  it('does NOT match a single enumerated item even with a question', () => {
    const text = ['Do you want to proceed?', '❯ 1. Yes'].join('\n');
    expect(parseTextChoicePrompt(text)).toBeNull();
  });

  it('does NOT match vitest stack-frame output that uses the ❯ arrow', () => {
    const text = [
      ' FAIL  src/assurance.test.ts',
      'TypeError: Cannot read properties of undefined',
      ' ❯ buildInternalTool src/configTemplates.ts:132:31',
      ' ❯ src/configTemplates.ts:151:35',
      ' ❯ src/index.ts:25:31',
    ].join('\n');
    expect(parseTextChoicePrompt(text)).toBeNull();
  });

  it('does NOT match a vitest failed-test summary with ❯ test file lines', () => {
    const text = [
      ' ❯ src/assurance.test.ts (9 tests | 2 failed) 10ms',
      '   × evaluateAssurance > baseline level boundaries 5ms',
    ].join('\n');
    expect(parseTextChoicePrompt(text)).toBeNull();
  });

  it('does NOT match plain prose without any list', () => {
    expect(parseTextChoicePrompt('Do you want me to build the web UI now?')).toBeNull();
    expect(parseTextChoicePrompt('Just some regular output text.')).toBeNull();
    expect(parseTextChoicePrompt('')).toBeNull();
  });

  it('does NOT glue together a non-sequential numbered run', () => {
    // "1." then "5." are not a contiguous ascending list -> not a chooser
    const text = ['Choose:', '1. First thing', '5. Unrelated line'].join('\n');
    expect(parseTextChoicePrompt(text)).toBeNull();
  });
});
