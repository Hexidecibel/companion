import {
  buildPendingPrompt,
  choiceSignature,
  derivePendingApproval,
  lastAssistantLine,
  normalizeChoice,
  resolveChoiceLabels,
} from '../pending-prompt';
import { defaultAgent, getAgentAdapter } from '../agents';
import type { ConversationMessage, TerminalChoicePrompt } from '../types';

const claude = defaultAgent();

function assistant(over: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id: 'a1',
    type: 'assistant',
    content: '',
    timestamp: 1000,
    ...over,
  } as ConversationMessage;
}

const APPROVAL_OPTIONS = [
  { label: 'yes', description: 'Approve: Run: ls' },
  { label: "yes, and don't ask again for this session", description: 'Always allow: Run: ls' },
  { label: 'no', description: 'Reject this action' },
];

function pendingBash(id = 'tu1'): ConversationMessage {
  return assistant({
    toolCalls: [{ id, name: 'Bash', input: { command: 'ls -la' }, status: 'pending' }] as never,
    options: APPROVAL_OPTIONS,
    isWaitingForChoice: true,
  });
}

const AUQ_PANE: TerminalChoicePrompt = {
  question: 'Which approach?',
  header: 'Approach',
  options: [
    { label: 'Robust', description: 'lenient' },
    { label: 'Exact', description: '' },
  ],
};

const PERMISSION_PANE_4: TerminalChoicePrompt = {
  question: 'Do you want to proceed?',
  header: 'Bash command',
  options: [
    { label: 'Yes' },
    { label: 'Yes, always allow' },
    { label: 'Yes, and switch to auto mode' },
    { label: 'No' },
  ],
};

describe('resolveChoiceLabels', () => {
  const four = PERMISSION_PANE_4.options;
  it('4-row on-screen approval: "no" is row 3 of 4, never the positional row 2', () => {
    expect(resolveChoiceLabels(['no'], four)).toEqual([3]);
    expect(resolveChoiceLabels(['No'], four)).toEqual([3]);
    expect(resolveChoiceLabels(['yes'], four)).toEqual([0]);
  });
  it("transcript's always-allow label maps to the always-allow row", () => {
    expect(resolveChoiceLabels(["yes, and don't ask again for this session"], four)).toEqual([1]);
    // Claude Code 2.1.317's wording.
    const real = [
      { label: 'Yes' },
      { label: 'Yes, and always allow access to /tmp/x from this project' },
      { label: 'Yes, and switch to auto mode · auto mode handles these prompts for you' },
      { label: 'No' },
    ];
    expect(resolveChoiceLabels(["yes, and don't ask again for this session"], real)).toEqual([1]);
    expect(resolveChoiceLabels(['no'], real)).toEqual([3]);
  });
  it('prefix match on a whole word, key hints ignored', () => {
    const opts = [
      { label: 'Yes' },
      { label: 'Yes, allow all edits during this session (shift+tab)' },
      { label: 'No, and tell Claude what to do differently (esc)' },
    ];
    expect(resolveChoiceLabels(['no'], opts)).toEqual([2]);
    expect(resolveChoiceLabels(["yes, and don't ask again for this session"], opts)).toEqual([1]);
    // "no" must not match "Nope" / "Notes" style rows.
    expect(resolveChoiceLabels(['no'], [{ label: 'Yes' }, { label: 'Notes' }])).toBeNull();
  });
  it('unknown or ambiguous label: null (caller sends nothing)', () => {
    expect(resolveChoiceLabels(['maybe'], four)).toBeNull();
    expect(resolveChoiceLabels(['yes, and'], four)).toBeNull();
    expect(resolveChoiceLabels(['yes'], [{ label: 'Yes, a' }, { label: 'Yes, b' }])).toBeNull();
    expect(resolveChoiceLabels([], four)).toBeNull();
  });
});

describe('pending-prompt', () => {
  it('trust prompt comes first, kind trust', () => {
    const p = buildPendingPrompt({
      messages: [pendingBash()],
      agent: claude,
      trust: {
        question: 'Do you trust the files in this folder?',
        options: [{ label: 'No, exit' }, { label: 'Yes, I trust this folder' }],
        kind: 'trust',
      },
    });
    expect(p?.kind).toBe('trust');
    expect(p?.options.map((o) => o.label)).toEqual(['No, exit', 'Yes, I trust this folder']);
    expect(p?.signature).toBeTruthy();
  });

  it('transcript approval without a pane box: parser options (fallback, answered by label)', () => {
    const p = buildPendingPrompt({ messages: [pendingBash()], agent: claude });
    expect(p).toMatchObject({ kind: 'approval', header: 'Bash', question: 'Bash: ls -la' });
    expect(p!.options.map((o) => o.label)).toEqual(APPROVAL_OPTIONS.map((o) => o.label));
    // A new approval occurrence (other tool_use id) gets a new signature.
    expect(
      buildPendingPrompt({ messages: [pendingBash('tu2')], agent: claude })!.signature
    ).not.toBe(p!.signature);
  });

  it('approval with a pane box: the ON-SCREEN options and signature win', () => {
    const fallback = buildPendingPrompt({ messages: [pendingBash()], agent: claude })!;
    const p = buildPendingPrompt({
      messages: [pendingBash()],
      agent: claude,
      paneChoice: PERMISSION_PANE_4,
    })!;
    expect(p).toMatchObject({ kind: 'approval', header: 'Bash', question: 'Bash: ls -la' });
    expect(p.options.map((o) => o.label)).toEqual([
      'Yes',
      'Yes, always allow',
      'Yes, and switch to auto mode',
      'No',
    ]);
    expect(p.signature).not.toBe(fallback.signature);
    // Stable for the same box.
    expect(
      buildPendingPrompt({
        messages: [pendingBash()],
        agent: claude,
        paneChoice: PERMISSION_PANE_4,
      })!.signature
    ).toBe(p.signature);
  });

  it('derivePendingApproval matches Herald (tool, detail, id)', () => {
    expect(derivePendingApproval([pendingBash()], claude)).toEqual({
      tool: 'Bash',
      detail: 'ls -la',
      toolUseId: 'tu1',
    });
    expect(derivePendingApproval([assistant({ content: 'hi' })], claude)).toBeNull();
  });

  it('transcript AskUserQuestion: first question, questionCount when several', () => {
    const q = (n: string) => ({
      question: `${n}?`,
      header: n,
      options: [
        { label: 'A', description: '' },
        { label: 'B', description: 'bee' },
      ],
      multiSelect: false,
    });
    const p = buildPendingPrompt({
      messages: [assistant({ isWaitingForChoice: true, questions: [q('One'), q('Two')] as never })],
      agent: claude,
    });
    expect(p).toMatchObject({ kind: 'choice', question: 'One?', header: 'One', questionCount: 2 });
    expect(p!.options).toEqual([{ label: 'A' }, { label: 'B', description: 'bee' }]);
  });

  it('pane choice: AUQ is a choice, a permission box or Codex box is an approval', () => {
    const p = buildPendingPrompt({ messages: [], agent: claude, paneChoice: AUQ_PANE });
    expect(p).toMatchObject({ kind: 'choice', question: 'Which approach?', header: 'Approach' });
    expect(p!.signature).toBe(normalizeChoice(AUQ_PANE)!.signature);
    const perm = buildPendingPrompt({
      messages: [],
      agent: claude,
      paneChoice: {
        question: 'Do you want to proceed?',
        options: [{ label: 'Yes' }, { label: 'No' }],
      },
    });
    expect(perm?.kind).toBe('approval');
    const codex = buildPendingPrompt({
      messages: [],
      agent: getAgentAdapter('codex'),
      paneChoice: AUQ_PANE,
    });
    expect(codex?.kind).toBe('approval');
  });

  it('no prompt: null (a one-option box is not a choice)', () => {
    expect(
      buildPendingPrompt({ messages: [assistant({ content: 'Done.' })], agent: claude })
    ).toBeNull();
    expect(
      buildPendingPrompt({
        messages: [],
        agent: claude,
        paneChoice: { question: 'x', options: [{ label: 'only' }] },
      })
    ).toBeNull();
  });

  it('signature is stable and changes with the labels', () => {
    const a = choiceSignature({ question: 'q', options: [{ label: 'x' }, { label: 'y' }] });
    expect(choiceSignature({ question: 'q', options: [{ label: 'x' }, { label: 'y' }] })).toBe(a);
    expect(choiceSignature({ question: 'q', options: [{ label: 'x' }, { label: 'z' }] })).not.toBe(
      a
    );
  });

  it('lastAssistantLine: last non-empty line, flattened, clipped to 140', () => {
    const msgs = [
      assistant({ content: 'old' }),
      assistant({ content: 'First line\n\n**Want me to commit?**\n\n' }),
      { id: 'u', type: 'user', content: 'tool result', timestamp: 2 } as ConversationMessage,
    ];
    expect(lastAssistantLine(msgs)).toBe('Want me to commit?');
    const long = lastAssistantLine([assistant({ content: 'x'.repeat(500) })])!;
    expect(long.length).toBeLessThanOrEqual(140);
    expect(lastAssistantLine([])).toBeUndefined();
    // Code is skipped (closed or unclosed fence): the prose line before it shows.
    expect(lastAssistantLine([assistant({ content: 'Run this:\n```bash\nrm -rf x\n```' })])).toBe(
      'Run this:'
    );
    expect(lastAssistantLine([assistant({ content: 'Partial:\n```ts\nconst a = 1;' })])).toBe(
      'Partial:'
    );
  });
});
