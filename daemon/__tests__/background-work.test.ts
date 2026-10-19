import {
  BackgroundWorkMonitor,
  FOOTER_TTL_MS,
  SHELL_ONLY_MAX_MS,
  backgroundWorkLabel,
  overlaySessionState,
  parsePaneFooter,
} from '../src/background-work';
import type { ConversationMessage } from '../src/types';

const RULE = '─'.repeat(120);
const C = (code: string, t: string) => `\x1b[38;5;${code}m${t}\x1b[39m`;

/** Live pane (Claude Code 2.1.303): idle main thread, 1 background shell + 1 background agent. */
const IDLE_WITH_BACKGROUND = [
  '● Agent(Sleep 200 then reply ok)',
  '  ⎿  Backgrounded agent (↓ to manage · ctrl+o to expand)',
  '● started',
  '✻ Waiting for 1 background agent to finish',
  RULE,
  '❯ ',
  RULE,
  '  ⏵⏵ bypass permissions on · 2 shells · ↓ to manage',
  '  ● main',
  '  ◯ general-purpose  Sleep 200 then reply ok                       30s · ↓ 37.8k tokens',
].join('\n');

/** Same footer as `capture-pane -e` returns it: every word in its own colour run. */
const IDLE_ANSI_NO_SHELLS = [
  C('246', '✻') + ' ' + C('246', 'Cogitated for 4s · done 7:05 PM'),
  '',
  C('244', RULE),
  '\x1b[39m❯ ',
  C('244', RULE),
  '\x1b[39m  ' + [C('211', '⏵⏵'), C('211', 'bypass'), C('211', 'permissions'), C('211', 'on')].join(' ') +
    C('246', ' (shift+tab to cycle)'),
  '',
].join('\n');

const PERMISSION_BOX = [
  '● Bash(rm -rf build)',
  '╭──────────────────────────────────────────╮',
  '│ Bash command                             │',
  '│   rm -rf build                           │',
  '│ Do you want to proceed?                  │',
  '│ ❯ 1. Yes                                 │',
  '│   2. No, and tell Claude what to do      │',
  '╰──────────────────────────────────────────╯',
].join('\n');

const msg = (over: Partial<ConversationMessage>): ConversationMessage => ({
  id: over.id || 'm',
  type: 'assistant',
  content: '',
  timestamp: 1_000_000,
  ...over,
});

describe('parsePaneFooter', () => {
  it('reads shells and bypass mode under the prompt box (live capture)', () => {
    expect(parsePaneFooter(IDLE_WITH_BACKGROUND)).toEqual({ shells: 2, bypass: true });
  });

  it('handles ANSI colour runs and a footer without shells', () => {
    expect(parsePaneFooter(IDLE_ANSI_NO_SHELLS)).toEqual({ shells: 0, bypass: true });
  });

  it('reads "1 shell" and a footer without bypass mode', () => {
    const pane = [RULE, '❯ ', RULE, '  ? for shortcuts · 1 shell · ↓ to manage'].join('\n');
    expect(parsePaneFooter(pane)).toEqual({ shells: 1, bypass: false });
  });

  it('returns null when no prompt box is at the bottom (a permission box is up)', () => {
    expect(parsePaneFooter(PERMISSION_BOX)).toBeNull();
    expect(parsePaneFooter('')).toBeNull();
  });

  it('ignores "2 shells" written in the conversation above the box', () => {
    const pane = ['I started 2 shells for you.', RULE, '❯ ', RULE, '  ⏵⏵ accept edits on'].join('\n');
    expect(parsePaneFooter(pane)).toEqual({ shells: 0, bypass: false });
  });
});

describe('overlaySessionState', () => {
  const now = 1_000_000 + 60_000;
  const ended = [msg({ type: 'user', content: 'go', id: 'u' }), msg({ content: 'started', id: 'a' })];

  it('an idle main thread with running agents is working with backgroundWork', () => {
    const o = overlaySessionState({ waiting: true, messages: ended, agents: 2, footer: null, now });
    expect(o).toEqual({
      waiting: false,
      backgroundWork: { agents: 2, shells: 0 },
      currentActivity: '2 agents running',
    });
  });

  it('counts footer shells too, and is waiting again once the work is gone', () => {
    const footer = { shells: 1, bypass: false };
    expect(overlaySessionState({ waiting: true, messages: ended, agents: 1, footer, now })).toMatchObject({
      waiting: false,
      backgroundWork: { agents: 1, shells: 1 },
      currentActivity: '1 agent, 1 shell running',
    });
    expect(
      overlaySessionState({ waiting: true, messages: ended, agents: 0, footer: { shells: 0, bypass: false }, now })
    ).toEqual({ waiting: true });
  });

  it('shells alone stop holding the session after SHELL_ONLY_MAX_MS (a background dev server)', () => {
    const footer = { shells: 1, bypass: false };
    expect(overlaySessionState({ waiting: true, messages: ended, agents: 0, footer, now }).waiting).toBe(false);
    const later = 1_000_000 + SHELL_ONLY_MAX_MS + 1;
    expect(overlaySessionState({ waiting: true, messages: ended, agents: 0, footer, now: later })).toEqual({
      waiting: true,
    });
  });

  it('never hides a genuine question: pending AskUserQuestion / ExitPlanMode stay waiting', () => {
    for (const name of ['AskUserQuestion', 'ExitPlanMode']) {
      const messages = [msg({ toolCalls: [{ id: 't', name, input: {}, status: 'pending' }] })];
      expect(overlaySessionState({ waiting: true, messages, agents: 3, footer: { shells: 2, bypass: true }, now })).toEqual({
        waiting: true,
      });
    }
  });

  it('a pending Bash is a permission prompt unless bypass mode is on (then it is running)', () => {
    const messages = [msg({ toolCalls: [{ id: 't', name: 'Bash', input: { command: 'sleep 20' }, status: 'pending' }] })];
    expect(overlaySessionState({ waiting: true, messages, agents: 2, footer: null, now })).toEqual({ waiting: true });
    expect(
      overlaySessionState({ waiting: true, messages, agents: 0, footer: { shells: 0, bypass: false }, now })
    ).toEqual({ waiting: true });
    expect(
      overlaySessionState({
        waiting: true,
        messages,
        currentActivity: 'Approve? sleep 20',
        agents: 0,
        footer: { shells: 0, bypass: true },
        now,
      })
    ).toEqual({ waiting: false, currentActivity: 'Running: sleep 20' });
  });

  it('leaves a working session alone', () => {
    expect(overlaySessionState({ waiting: false, messages: ended, agents: 5, footer: null, now })).toEqual({
      waiting: false,
    });
  });

  it('labels', () => {
    expect(backgroundWorkLabel({ agents: 1, shells: 0 })).toBe('1 agent running');
    expect(backgroundWorkLabel({ agents: 0, shells: 2 })).toBe('2 shells running');
  });
});

describe('BackgroundWorkMonitor', () => {
  it('uses only fresh footers and the tracker for agents', () => {
    let t = 5_000_000;
    let agents = 0;
    const m = new BackgroundWorkMonitor({ runningAgents: () => agents, now: () => t });
    const ended = [msg({ content: 'started', timestamp: t })];
    m.noteCapture('s1', IDLE_WITH_BACKGROUND);
    expect(m.footer('s1')).toEqual({ shells: 2, bypass: true });
    expect(m.overlay('s1', true, ended).backgroundWork).toEqual({ agents: 0, shells: 2 });
    agents = 1;
    expect(m.overlay('s1', true, ended).backgroundWork).toEqual({ agents: 1, shells: 2 });
    t += FOOTER_TTL_MS + 1;
    expect(m.footer('s1')).toBeNull();
    expect(m.overlay('s1', true, ended).backgroundWork).toEqual({ agents: 1, shells: 0 });
    agents = 0;
    expect(m.overlay('s1', true, ended)).toEqual({ waiting: true });
  });

  it('a throwing tracker counts as no agents', () => {
    const m = new BackgroundWorkMonitor({
      runningAgents: () => {
        throw new Error('boom');
      },
    });
    expect(m.overlay('x', true, [msg({ content: 'done' })])).toEqual({ waiting: true });
  });
});
