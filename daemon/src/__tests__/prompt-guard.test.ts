/**
 * Input-injection guard: prompt-box parsing (shapes captured from a live
 * Claude Code 2.1.301 pane with `capture-pane -p -e`) and the InputInjector
 * paths that use it (draft refusal, typing deferral, choice / babysit paths).
 */
import {
  readPromptBox,
  detectOverlay,
  stripDim,
  secondsSinceClientActivity,
  heraldRefusalText,
} from '../prompt-guard';
import { impact } from '../impact/state';

const mockTmux = jest.fn();
jest.mock('child_process', () => ({
  spawn: jest.fn(),
  execFile: (
    _file: string,
    args: string[],
    _options: unknown,
    callback: (err: Error | null, stdout: string, stderr: string) => void
  ) => {
    const res = mockTmux(args) as { status: number; stdout: string };
    const err = res.status === 0 ? null : Object.assign(new Error('fail'), { code: res.status });
    callback(err, res.stdout ?? '', '');
    return { on: () => {} };
  },
}));

import { InputInjector } from '../input-injector';
import { LocalSessionSource } from '../herald/session-source';

const E = '\x1b';
const RULE = `${E}[38;5;244m${'─'.repeat(118)}`;
const FOOTER = `${E}[39m  ${E}[38;5;211m⏵⏵${E}[39m ${E}[38;5;211mbypass permissions on${E}[38;5;246m (shift+tab to cycle)${E}[39m`;
const HEADER = [
  ` ▐▛███▛█   ${E}[1mClaude${E}[0m ${E}[1mCode${E}[0m ${E}[38;5;246mv2.1.301${E}[39m`,
  '',
  `${E}[38;5;231m●${E}[39m The ${E}[38;5;153msleep 8${E}[39m command finished without errors. Done.`,
];
const pane = (...box: string[]) => [...HEADER, RULE, ...box, RULE, FOOTER, '', '', ''].join('\n');

const EMPTY = pane(`${E}[39m❯\u00a0`);
const PLACEHOLDER = pane(`${E}[39m❯\u00a0${E}[2mTry "how does <filepath> work?"${E}[0m`);
const SUGGESTION = pane(`${E}[39m❯\u00a0${E}[2mis it done yet?${E}[0m`);
const DRAFT = pane(`${E}[39m❯\u00a0my draft text here`);
const MULTILINE = pane(`${E}[39m❯\u00a0`, '  line two');
const WORKING = [
  '❯ Run the bash command: sleep 8; then say done',
  '● Bash(sleep 8)',
  '  ⎿  Running… (3s)',
  '✻ Recombobulating… (4s · ↓ 39 tokens)',
  RULE,
  `${E}[39m❯\u00a0typed while working`,
  RULE,
  FOOTER,
].join('\n');
const CHOICE_BOX = [
  ' Which approach?',
  ' ❯ 1. Fast',
  '   2. Careful',
  '   3. Type something.',
  ' Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');
const DETAILS_OVERLAY = [
  ...HEADER,
  RULE,
  '  Shell details',
  '  Status:   running',
  '  Command:  sleep 120',
  '  ← to go back · Esc/Enter/Space to close · x to stop',
].join('\n');

describe('readPromptBox', () => {
  it('reads an empty box as empty', () => {
    expect(readPromptBox(EMPTY)).toEqual({ found: true, draft: '' });
  });
  it('treats the dim placeholder and dim prompt suggestions as empty', () => {
    expect(readPromptBox(PLACEHOLDER)).toEqual({ found: true, draft: '' });
    expect(readPromptBox(SUGGESTION)).toEqual({ found: true, draft: '' });
  });
  it('reads a typed draft (single and multi-line)', () => {
    expect(readPromptBox(DRAFT)).toEqual({ found: true, draft: 'my draft text here' });
    expect(readPromptBox(MULTILINE).draft).toBe('line two');
  });
  it('reads a draft typed while Claude is working; past prompts above the box do not count', () => {
    expect(readPromptBox(WORKING).draft).toBe('typed while working');
  });
  it('finds no prompt box while a choice box or overlay is up', () => {
    expect(readPromptBox(CHOICE_BOX).found).toBe(false);
    expect(readPromptBox(DETAILS_OVERLAY).found).toBe(false);
  });
  it('stripDim keeps 256-colour text and drops only dim runs', () => {
    expect(stripDim(`${E}[38;5;2mgreen${E}[39m ${E}[2mdim${E}[22m back`)).toBe('green  back');
  });
});

describe('detectOverlay', () => {
  it('matches the real task overlays', () => {
    expect(detectOverlay(DETAILS_OVERLAY)).toBe(true);
    expect(
      detectOverlay(
        '  ┃ Agent (local)  running ┃\n  ┃ ↑↓ to select · Enter to view · Esc to close ┃'
      )
    ).toBe(true);
  });
  it('ignores "Esc to close" in conversation text and when the prompt box is visible', () => {
    expect(detectOverlay('The modal says: press Esc to close the dialog.')).toBe(false);
    expect(detectOverlay('Some panel content\nPress Esc to close')).toBe(false);
    const quoted = pane(`${E}[39m❯\u00a0`).replace(
      'Done.',
      'Done.\n  ↑↓ to select · Enter to view · Esc to close'
    );
    expect(detectOverlay(quoted)).toBe(false);
  });
  it('ignores the choice box and trust prompt ("Esc to cancel")', () => {
    expect(detectOverlay(CHOICE_BOX)).toBe(false);
    expect(
      detectOverlay(' ❯ No, exit\n   Yes, I trust this folder\n Enter to confirm · Esc to cancel')
    ).toBe(false);
  });
});

describe('secondsSinceClientActivity', () => {
  it('uses the most recent attached client; null when none', () => {
    expect(secondsSinceClientActivity('', 10_000)).toBeNull();
    expect(secondsSinceClientActivity('5\n9\n', 10_000)).toBe(1);
  });
});

// ---------------------------------------------------------------- injector

describe('InputInjector guard', () => {
  let clock = 1_800_000_000_000;
  const sleep = jest.fn(async (ms: number) => {
    clock += ms;
  });
  let paneText = EMPTY;
  let clients = '';
  const make = () => new InputInjector('s', { now: () => clock, sleep });
  const calls = () => mockTmux.mock.calls.map((c) => c[0] as string[]);
  const typed = () => calls().filter((a) => a[0] === 'send-keys' && a.includes('-l'));
  const collisions = () => impact.report().day.counters.inputCollisions;

  beforeEach(() => {
    mockTmux.mockReset();
    sleep.mockClear();
    paneText = EMPTY;
    clients = '';
    mockTmux.mockImplementation((args: string[]) => {
      if (args[0] === 'capture-pane') return { status: 0, stdout: paneText };
      if (args[0] === 'list-clients') return { status: 0, stdout: clients };
      return { status: 0, stdout: '' };
    });
  });

  it('sends into an empty box and into a placeholder box', async () => {
    expect(await make().sendInputDetailed('hi', 's')).toEqual({ ok: true });
    paneText = PLACEHOLDER;
    expect(await make().sendInput('hi', 's')).toBe(true);
    expect(typed()).toHaveLength(2);
    // The guard captures with escapes (dim placeholder detection).
    expect(calls().find((a) => a[0] === 'capture-pane')).toContain('-e');
  });

  it('refuses when the prompt holds an unsent draft and counts a collision', async () => {
    paneText = DRAFT;
    const before = collisions();
    const r = await make().sendInputDetailed('hi', 's');
    expect(r).toMatchObject({ ok: false, reason: 'draft', code: 'prompt_has_draft' });
    expect(!r.ok && r.message).toMatch(/unsent draft/);
    expect(typed()).toHaveLength(0);
    expect(calls().some((a) => a[0] === 'send-keys')).toBe(false);
    expect(collisions()).toBe(before + 1);
  });

  it('waits while an attached client typed in the last 2 s, then sends once quiet', async () => {
    const t0 = clock;
    // Activity at t0 (seconds); quiet after 2 s of fake time.
    clients = `${Math.floor(t0 / 1000)}\n`;
    const r = await make().sendInputDetailed('hi', 's');
    expect(r).toEqual({ ok: true });
    expect(sleep).toHaveBeenCalled();
    expect(clock - t0).toBeGreaterThanOrEqual(1500);
    expect(typed()).toHaveLength(1);
  });

  it('refuses when the client keeps typing through the wait window', async () => {
    mockTmux.mockImplementation((args: string[]) => {
      if (args[0] === 'list-clients') return { status: 0, stdout: `${Math.floor(clock / 1000)}` };
      if (args[0] === 'capture-pane') return { status: 0, stdout: EMPTY };
      return { status: 0, stdout: '' };
    });
    const before = collisions();
    const r = await make().sendInputDetailed('hi', 's');
    expect(r).toMatchObject({ ok: false, reason: 'typing', code: 'user_typing' });
    expect(typed()).toHaveLength(0);
    expect(collisions()).toBe(before + 1);
  });

  it('choice answers ignore drafts and typing (choice box has no prompt box)', async () => {
    paneText = CHOICE_BOX;
    clients = `${Math.floor(clock / 1000)}`;
    expect(await make().sendChoice([1], 3, false, undefined, 's')).toBe(true);
    const keys = calls().filter((a) => a[0] === 'send-keys');
    expect(keys.map((k) => k[k.length - 1])).toEqual(['2']);
    expect(calls().some((a) => a[0] === 'list-clients')).toBe(false);
  });

  it('does not send Escape for a quoted "Esc to close" above a visible prompt box', async () => {
    paneText = pane(`${E}[39m❯\u00a0`).replace(
      'Done.',
      'Done.\n  ↑↓ to select · Enter to view · Esc to close'
    );
    expect(await make().sendInput('hi', 's')).toBe(true);
    expect(calls().some((a) => a.includes('Escape'))).toBe(false);
  });
});

// ------------------------------------------------- Herald / babysit wording

describe('LocalSessionSource refusal plumbing', () => {
  const deps = (r: unknown) =>
    ({
      watcher: {} as never,
      injector: {
        sendInput: jest.fn(),
        sendInputDetailed: jest.fn(async () => r),
        sendChoice: jest.fn(async () => true),
        checkSessionExists: jest.fn(async () => true),
      },
      sessionNames: { getAll: () => ({}) },
    }) as never;

  it('records the refusal for Herald and clears it on the next send', async () => {
    const src = new LocalSessionSource(
      deps({ ok: false, reason: 'draft', code: 'prompt_has_draft', message: 'x' })
    );
    expect(await src.sendText('a', 'hi', 't')).toBe(false);
    expect(src.lastSendRefusal('a')?.reason).toBe('draft');
    expect(heraldRefusalText('Out4', 'draft')).toBe(
      "Out4 has an unsent draft in its prompt box, so I didn't type over it. Send or clear it, then try again."
    );
    const ok = new LocalSessionSource(deps({ ok: true }));
    expect(await ok.sendText('a', 'hi', 't')).toBe(true);
    expect(ok.lastSendRefusal('a')).toBeNull();
  });
});
