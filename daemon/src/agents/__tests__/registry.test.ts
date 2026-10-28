/* eslint-disable @typescript-eslint/unbound-method -- identity checks on wrapped functions */
import {
  claudeAdapter,
  codexAdapter,
  defaultAgent,
  getAgentAdapter,
  listAgentIds,
  DEFAULT_AGENT_ID,
} from '..';
import { claudeCommand } from '../../tmux-manager';
import { classifyStartupPane } from '../../herald/spawn';
import { encodeProjectDir, findClaudePid } from '../../session-identity';
import { parseConversationFile, detectActiveChoicePrompt } from '../../parser';
import { readPromptBox, detectOverlay } from '../../prompt-guard';

describe('agent registry', () => {
  it('has Claude as the default adapter and Codex as the second', () => {
    expect(DEFAULT_AGENT_ID).toBe('claude');
    expect(listAgentIds()).toEqual(['claude', 'codex']);
    expect(defaultAgent()).toBe(claudeAdapter);
    expect(getAgentAdapter()).toBe(claudeAdapter);
    expect(getAgentAdapter('claude')).toBe(claudeAdapter);
    expect(getAgentAdapter('codex')).toBe(codexAdapter);
    expect(getAgentAdapter('gemini')).toBe(claudeAdapter);
    expect(getAgentAdapter('__proto__')).toBe(claudeAdapter);
  });

  it('Claude transcript side wraps the existing code', () => {
    const t = claudeAdapter.transcript;
    expect(t.projectsDir('/h/.claude')).toBe('/h/.claude/projects');
    expect(t.encodeProjectDir).toBe(encodeProjectDir);
    expect(t.projectDirFor('/h/.claude', '/home/u/.x')).toBe('/h/.claude/projects/-home-u--x');
    expect(t.transcriptPath('/h/.claude', '-a-b', 'abc')).toBe(
      '/h/.claude/projects/-a-b/abc.jsonl'
    );
    expect(t.findAgentPid).toBe(findClaudePid);
    expect(t.parseFile).toBe(parseConversationFile);
    expect(t.subagents?.subagentDir('/p/-a/123.jsonl')).toBe('/p/-a/123/subagents');
  });

  it('Claude terminal side wraps the existing code', () => {
    const term = claudeAdapter.terminal;
    expect(term.launchCommand).toBe(claudeCommand);
    expect(term.launchCommand('bypassPermissions')).toBe(
      'claude --permission-mode bypassPermissions'
    );
    expect(term.classifyStartupPane).toBe(classifyStartupPane);
    expect(term.readPromptBox).toBe(readPromptBox);
    expect(term.detectOverlay).toBe(detectOverlay);
    expect(term.detectActiveChoicePrompt).toBe(detectActiveChoicePrompt);
    expect(term.approvalPromptRe.test('Do you want to proceed?')).toBe(true);
    expect(term.approvalPromptRe.test('all good')).toBe(false);
  });

  describe('choice keys', () => {
    const keys = (req: Parameters<typeof claudeAdapter.terminal.choiceKeys>[0]) =>
      claudeAdapter.terminal.choiceKeys(req).steps;

    it('single-select presses the digit', () => {
      expect(keys({ selectedIndices: [2], optionCount: 4, multiSelect: false })).toEqual([
        { type: 'key', key: '3' },
      ]);
    });

    it('single-select past 9 walks down then Enter', () => {
      const steps = keys({ selectedIndices: [10], optionCount: 12, multiSelect: false });
      expect(steps.filter((s) => s.type === 'key' && s.key === 'Down')).toHaveLength(10);
      expect(steps[steps.length - 1]).toEqual({ type: 'key', key: 'Enter' });
    });

    it('multi-select toggles sorted unique digits then Right + 1', () => {
      const plan = claudeAdapter.terminal.choiceKeys({
        selectedIndices: [2, 0, 2, 11],
        optionCount: 12,
        multiSelect: true,
      });
      expect(
        plan.steps.filter((s) => s.type === 'key').map((s) => (s as { key: string }).key)
      ).toEqual(['1', '3', 'Right', '1']);
      expect(plan.warnings).toEqual(['Multi-select option 12 exceeds digit range, skipping']);
    });

    it('Other presses optionCount+1, types the text, Enter', () => {
      const steps = keys({
        selectedIndices: [],
        optionCount: 3,
        multiSelect: false,
        otherText: 'hi',
      });
      expect(steps.filter((s) => s.type !== 'delay')).toEqual([
        { type: 'key', key: '4' },
        { type: 'text', text: 'hi' },
        { type: 'key', key: 'Enter' },
      ]);
    });
  });

  it('edit extraction keeps the ledger rules', () => {
    const e = claudeAdapter.transcript.edits;
    expect(e.editStart('Bash', { command: 'ls' })).toBeNull();
    expect(e.editStart('Edit', {})).toBeNull();
    expect(e.editStart('Write', { file_path: 'a.ts' })).toEqual({ file: 'a.ts', kind: 'create' });
    expect(e.editStart('NotebookEdit', { notebook_path: 'n.ipynb' })).toEqual({
      file: 'n.ipynb',
      kind: 'update',
    });
    // Write with no structured result was an overwrite
    expect(e.editOutcome('Write', 'create', undefined)).toEqual({ kind: 'update', hunks: null });
    expect(e.editOutcome('Write', 'create', { type: 'create', content: 'a\n' })).toEqual({
      kind: 'create',
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+a'] }],
    });
    // Only Write may create
    expect(e.editOutcome('Edit', 'update', { type: 'create', content: 'a\n' }).kind).toBe('update');
    const patch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }];
    expect(e.editOutcome('Edit', 'update', { structuredPatch: patch })).toEqual({
      kind: 'update',
      hunks: patch,
    });
    expect(e.editOutcome('Edit', 'update', { structuredPatch: 'nope' }).hunks).toBeNull();
  });
});
