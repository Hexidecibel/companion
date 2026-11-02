/**
 * The agents' "Trust this folder?" start-up prompt as a tappable choice
 * (agents/trust.ts) and its keys.
 */
import * as fs from 'fs';
import * as path from 'path';
import { claudeAdapter, codexAdapter } from '..';
import { CLAUDE_TRUST, CODEX_TRUST, parseTrustPrompt } from '../trust';
import { classifyCodexStartupPane, codexChoiceKeys } from '../codex/terminal';
import { isPermissionChoice } from '../../herald/babysit/tracker';

const FIX = path.join(__dirname, 'fixtures', 'codex');
const CLAUDE_FIX = path.join(__dirname, 'fixtures', 'claude');
const readClaude = (f: string) => fs.readFileSync(path.join(CLAUDE_FIX, f), 'utf-8');
const read = (f: string) => fs.readFileSync(path.join(FIX, f), 'utf-8');

const CLAUDE_NEW = [
  ' Accessing workspace:',
  '',
  ' /home/hexi/local/src/newproj',
  '',
  " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.",
  '',
  " Claude Code'll be able to read, edit, and execute files here.",
  '',
  ' Security guide',
  '',
  ' ❯ 1. Yes, I trust this folder',
  '   2. No, exit',
  '',
  ' Enter to confirm · Esc to cancel',
  '',
].join('\n');

const CLAUDE_BOXED = [
  '╭────────────────────────────────────────────────────╮',
  '│ Do you trust the files in this folder?             │',
  '│                                                    │',
  '│ /home/hexi/x                                       │',
  '│                                                    │',
  '│ Claude Code may read, write, or execute files.     │',
  '│                                                    │',
  '│ ❯ 1. Yes, proceed                                  │',
  '│   2. No, exit                                      │',
  '╰────────────────────────────────────────────────────╯',
  '   Enter to confirm · Esc to exit',
].join('\n');

describe('trust prompt', () => {
  it('Codex: the live capture is a "Yes, trust" / "No" choice', () => {
    const pane = read('live-trust.txt');
    expect(classifyCodexStartupPane(pane)).toBe('trust_prompt');
    const c = codexAdapter.terminal.detectActiveChoicePrompt(pane)!;
    expect(c.kind).toBe('trust');
    expect(c.header).toBe('Codex');
    expect(c.question).toBe('Trust this folder?\n/tmp/claude-1000/cdx/gitdir');
    expect(c.options.map((o) => o.label)).toEqual(['Yes, trust', 'No']);
    expect(c.multiSelect).toBe(false);
  });

  it('Claude: both the boxed and the newer wording', () => {
    for (const [pane, dir] of [
      [CLAUDE_NEW, '/home/hexi/local/src/newproj'],
      [CLAUDE_BOXED, '/home/hexi/x'],
    ]) {
      const c = claudeAdapter.terminal.detectActiveChoicePrompt(pane)!;
      expect(c.kind).toBe('trust');
      expect(c.question).toBe(`Trust this folder?\n${dir}`);
      expect(c.options.map((o) => o.label)).toEqual(['Yes, trust', 'No']);
    }
    // Numbered rows: their digit.
    const c = claudeAdapter.terminal.detectActiveChoicePrompt(CLAUDE_NEW)!;
    expect(
      claudeAdapter.terminal
        .choiceKeys({
          selectedIndices: [0],
          optionCount: 2,
          multiSelect: false,
          trust: true,
          trustLayout: c.trustLayout,
        })
        .steps.filter((s) => s.type === 'key')
    ).toEqual([{ type: 'key', key: '1' }]);
  });

  // Claude Code 2.1.316: real captures. No digits, "No" first and selected.
  const keysOf = (pane: string, index: number) => {
    const c = claudeAdapter.terminal.detectActiveChoicePrompt(pane)!;
    return claudeAdapter.terminal
      .choiceKeys({
        selectedIndices: [index],
        optionCount: 2,
        multiSelect: false,
        trust: true,
        trustLayout: c.trustLayout,
      })
      .steps.filter((s) => s.type === 'key')
      .map((s) => (s as { key: string }).key);
  };

  it('Claude live capture (2.1.316): a card, with yes first whatever the screen order', () => {
    const pane = readClaude('live-trust.txt');
    const c = claudeAdapter.terminal.detectActiveChoicePrompt(pane)!;
    expect(c.kind).toBe('trust');
    expect(c.question).toBe('Trust this folder?\n/home/hexi/.cache/trust-repro/plain');
    expect(c.options.map((o) => o.label)).toEqual(['Yes, trust', 'No']);
    expect(claudeAdapter.terminal.classifyStartupPane(pane)).toBe('trust_prompt');
    expect(keysOf(pane, 0)).toEqual(['Down', 'Enter']); // verified live; digits do nothing
    expect(keysOf(pane, 1)).toEqual(['Enter']);
    expect(isPermissionChoice({ ...c, trust: true } as never)).toBe(true);
  });

  it('Claude live capture: after "No, exit" the old dialog above a shell prompt is no prompt', () => {
    expect(
      claudeAdapter.terminal.detectActiveChoicePrompt(readClaude('live-trust-after-no.txt'))
    ).toBeNull();
  });

  it('Claude live capture: a 50-column pane wraps the wording', () => {
    const c = claudeAdapter.terminal.detectActiveChoicePrompt(readClaude('live-trust-narrow.txt'))!;
    expect(c.kind).toBe('trust');
    expect(c.question).toBe('Trust this folder?\n/home/hexi/.cache/trust-repro/plain2');
  });

  it('a wrapped long folder path comes back whole', () => {
    const c = claudeAdapter.terminal.detectActiveChoicePrompt(
      [
        ' Accessing workspace:',
        '',
        ' /home/hexi/some/very/long/',
        ' folder/name',
        '',
        ' Quick safety check: Is this a project you created or one you trust?',
        '',
        ' ❯ No, exit',
        '   Yes, I trust this folder',
        '',
        ' Enter to confirm · Esc to cancel',
      ].join('\n')
    )!;
    expect(c.question).toBe('Trust this folder?\n/home/hexi/some/very/long/folder/name');
  });

  it('the cursor already on yes takes Enter only', () => {
    const pane = readClaude('live-trust.txt')
      .replace('❯ No, exit', '  No, exit')
      .replace('  Yes, I trust', '❯ Yes, I trust');
    expect(keysOf(pane, 0)).toEqual(['Enter']);
    expect(keysOf(pane, 1)).toEqual(['Up', 'Enter']);
  });

  it('Claude live capture: the bypass warning is its own card', () => {
    const pane = readClaude('live-bypass.txt');
    expect(claudeAdapter.terminal.classifyStartupPane(pane)).toBe('bypass_warning');
    const c = claudeAdapter.terminal.detectActiveChoicePrompt(pane)!;
    expect(c.kind).toBe('trust');
    expect(c.question).toBe('Allow Bypass Permissions mode?');
    expect(c.options.map((o) => o.label)).toEqual(['Yes, I accept', 'No']);
    expect(keysOf(pane, 0)).toEqual(['Down', 'Enter']);
  });

  it('Claude keys without the rows send nothing (Enter alone would be "No, exit")', () => {
    expect(
      claudeAdapter.terminal.choiceKeys({
        selectedIndices: [0],
        optionCount: 2,
        multiSelect: false,
        trust: true,
      }).steps
    ).toEqual([]);
  });

  it('is not the approval box, an idle composer or text that talks about trust', () => {
    expect(parseTrustPrompt(read('live-approval-exec.txt'), CODEX_TRUST)).toBeNull();
    expect(parseTrustPrompt(read('live-idle.ansi'), CODEX_TRUST)).toBeNull();
    const chat = [
      '● Codex asks "Trust this folder?" with:',
      '  1. Trust and continue',
      '  2. Back to Agent Command Center',
      '  Next I will add the handler.',
      '',
      '❯ ',
    ].join('\n');
    expect(parseTrustPrompt(chat, CODEX_TRUST)).toBeNull();
    expect(parseTrustPrompt(chat, CLAUDE_TRUST)).toBeNull();
    // Codex's approval box still parses as before.
    expect(
      codexAdapter.terminal.detectActiveChoicePrompt(read('live-approval-exec.txt'))?.kind
    ).toBe(undefined);
  });

  it('Codex keys: Yes = 1 + Enter, No = 2 then Ctrl+C (Codex exits), nothing else', () => {
    const yes = codexChoiceKeys({
      selectedIndices: [0],
      optionCount: 2,
      multiSelect: false,
      trust: true,
    });
    expect(yes.steps.filter((s) => s.type === 'key')).toEqual([
      { type: 'key', key: '1' },
      { type: 'key', key: 'Enter' },
    ]);
    const no = codexChoiceKeys({
      selectedIndices: [1],
      optionCount: 2,
      multiSelect: false,
      trust: true,
    });
    expect(no.steps.filter((s) => s.type === 'key')).toEqual([
      { type: 'key', key: '2' },
      { type: 'key', key: 'C-c' },
    ]);
    expect(
      codexChoiceKeys({
        selectedIndices: [0],
        optionCount: 2,
        multiSelect: false,
        trust: true,
        otherText: 'x',
      }).steps
    ).toEqual([]);
    expect(
      codexChoiceKeys({ selectedIndices: [2], optionCount: 2, multiSelect: false, trust: true })
        .steps
    ).toEqual([]);
  });

  it("is never the babysitter's to answer", () => {
    const c = codexAdapter.terminal.detectActiveChoicePrompt(read('live-trust.txt'))!;
    expect(
      isPermissionChoice({
        question: c.question,
        header: c.header,
        options: c.options,
        multiSelect: false,
        signature: 'x',
        trust: true,
      })
    ).toBe(true);
  });
});
