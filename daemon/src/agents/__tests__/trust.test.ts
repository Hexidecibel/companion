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
    // Claude's digit keys answer it in its own option order.
    expect(
      claudeAdapter.terminal.choiceKeys({
        selectedIndices: [0],
        optionCount: 2,
        multiSelect: false,
      }).steps
    ).toEqual([{ type: 'key', key: '1' }]);
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
