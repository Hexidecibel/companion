import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingPrompt, SessionSummary } from '../../types';

const sendRequest = vi.fn();
vi.mock('../../services/ConnectionManager', () => ({
  connectionManager: { getConnection: () => ({ isConnected: () => true, sendRequest }) },
}));
vi.mock('../babysit/BabysitBadge', () => ({ BabysitBadge: () => null }));
let stuckFindings: unknown[] = [];
vi.mock('../../hooks/useStuck', () => ({ useStuckFindings: () => stuckFindings }));
vi.mock('../stuck/StuckBadge', () => ({ StuckBadge: () => null }));

import { SessionTile, inlineAnswerable } from '../mission/SessionTile';

const NOW = 1_000_000_000;
const sess = (p: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 'sid', name: 'companion', projectPath: '/p/companion', status: 'idle', lastActivity: NOW - 5 * 60_000,
  tmuxSessionName: 'tmux-c', ...p,
});
const prompt = (p: Partial<PendingPrompt> = {}): PendingPrompt => ({
  kind: 'choice', question: 'Which DB?', header: 'Storage',
  options: [{ label: 'Postgres' }, { label: 'SQLite', description: 'file' }, { label: 'Type something.' }],
  signature: 'sig-1', ...p,
});

function tile(session: SessionSummary, extra: Partial<Parameters<typeof SessionTile>[0]> = {}) {
  const onOpen = vi.fn();
  const utils = render(<SessionTile serverId="s1" session={session} now={NOW} onOpen={onOpen} {...extra} />);
  return { onOpen, ...utils };
}

describe('SessionTile', () => {
  beforeEach(() => {
    sendRequest.mockReset();
    stuckFindings = [];
  });

  it('working: activity line, blue tone, relative time; tap opens', () => {
    const { onOpen, container } = tile(sess({ status: 'working', currentActivity: 'Editing watcher.ts', lastMessage: 'old' }));
    expect(screen.getByText('Editing watcher.ts')).toBeTruthy();
    expect(screen.getByText('5m')).toBeTruthy();
    expect(container.querySelector('.mission-tile--working')).toBeTruthy();
    fireEvent.click(screen.getByTestId('mission-tile'));
    expect(onOpen).toHaveBeenCalledWith('s1', 'sid', false);
  });

  it('idle: falls back to lastMessage; absent fields render fine', () => {
    tile(sess({ lastMessage: 'Done, all tests pass.' }));
    expect(screen.getByText('Done, all tests pass.')).toBeTruthy();
    const bare = sess();
    render(<SessionTile serverId="s1" session={bare} onOpen={() => {}} />);
  });

  it('done (unseen): calm green, shows lastMessage, no prompt or waiting time', () => {
    const { container, onOpen } = tile(
      sess({ status: 'waiting', attention: 'done', waitingSince: NOW - 3 * 60_000, lastMessage: 'Shipped it.' }),
      { unseen: true },
    );
    expect(container.querySelector('.mission-tile--done')).toBeTruthy();
    expect(container.querySelector('.mission-tile__dot--done')).toBeTruthy();
    expect(screen.getByText('Shipped it.')).toBeTruthy();
    expect(screen.queryByText(/Waiting for you/)).toBeNull();
    expect(screen.queryByText(/^waiting/)).toBeNull();
    expect(container.querySelector('.mission-tile__unseen')).toBeTruthy();
    fireEvent.click(screen.getByTestId('mission-tile'));
    expect(onOpen).toHaveBeenCalledWith('s1', 'sid', false);
  });

  it('done that was already viewed renders as idle', () => {
    const { container } = tile(sess({ status: 'waiting', attention: 'done', lastMessage: 'Shipped it.' }), { unseen: false });
    expect(container.querySelector('.mission-tile--idle')).toBeTruthy();
  });

  it('attention needs_you: amber waiting tone with the open hint', () => {
    const { container } = tile(sess({ status: 'waiting', attention: 'needs_you' }));
    expect(container.querySelector('.mission-tile--waiting')).toBeTruthy();
    expect(screen.getByText('Waiting for you, open to answer')).toBeTruthy();
  });

  it('stuck sessions get the stuck tone', () => {
    stuckFindings = [{ severity: 'high', summary: 'loop' }];
    const { container } = tile(sess({ status: 'working' }));
    expect(container.querySelector('.mission-tile--stuck')).toBeTruthy();
  });

  it('waiting without pendingPrompt (older daemon): "Waiting for you, open to answer"', () => {
    const { onOpen } = tile(sess({ status: 'waiting' }));
    expect(screen.getByText('Waiting for you, open to answer')).toBeTruthy();
    fireEvent.click(screen.getByTestId('mission-tile'));
    expect(onOpen).toHaveBeenCalledWith('s1', 'sid', true);
  });

  it('waiting shows "waiting Nm" from waitingSince', () => {
    tile(sess({ status: 'waiting', waitingSince: NOW - 3 * 60_000 }));
    expect(screen.getByText('waiting 3m')).toBeTruthy();
  });

  it('single-select choice: option buttons (free-text option hidden) send send_choice with the signature', async () => {
    sendRequest.mockResolvedValue({ type: 'send_choice', success: true });
    const { onOpen } = tile(sess({ status: 'waiting', pendingPrompt: prompt() }));
    expect(screen.getByText('Which DB?')).toBeTruthy();
    expect(screen.getByText('Storage')).toBeTruthy();
    expect(screen.queryByText('Type something.')).toBeNull();
    fireEvent.click(screen.getByText('SQLite'));
    await waitFor(() => expect(screen.getByText('Answered')).toBeTruthy());
    expect(onOpen).not.toHaveBeenCalled();
    expect(sendRequest).toHaveBeenCalledWith('send_choice', {
      selectedIndices: [1], optionCount: 3, multiSelect: false, selectedLabels: ['SQLite'],
      sessionId: 'sid', tmuxSessionName: 'tmux-c', expectSignature: 'sig-1',
    });
  });

  it('approval answers inline without promptKind', async () => {
    sendRequest.mockResolvedValue({ type: 'send_choice', success: true });
    tile(sess({ status: 'waiting', pendingPrompt: prompt({ kind: 'approval', question: 'Bash: npm test', header: undefined, options: [{ label: 'Yes' }, { label: 'No' }] }) }));
    fireEvent.click(screen.getByText('Yes'));
    await waitFor(() => expect(sendRequest).toHaveBeenCalled());
    expect(sendRequest.mock.calls[0][1]).not.toHaveProperty('promptKind');
    expect(sendRequest.mock.calls[0][1]).toMatchObject({ selectedIndices: [0], optionCount: 2 });
  });

  it('approval tap sends the label with the index and signature (daemon resolves it on screen)', async () => {
    sendRequest.mockResolvedValue({ type: 'send_choice', success: true });
    tile(sess({ status: 'waiting', pendingPrompt: prompt({
      kind: 'approval', question: 'Bash: rm x', header: 'Bash', signature: 'ap-1',
      options: [{ label: 'yes' }, { label: "yes, and don't ask again for this session" }, { label: 'no' }],
    }) }));
    fireEvent.click(screen.getByText('no'));
    await waitFor(() => expect(sendRequest).toHaveBeenCalled());
    expect(sendRequest.mock.calls[0][1]).toMatchObject({
      selectedIndices: [2], selectedLabels: ['no'], expectSignature: 'ap-1',
    });
  });

  it('"Chat about this" is never offered as a one-tap answer', () => {
    tile(sess({ status: 'waiting', pendingPrompt: prompt({ options: [{ label: 'A' }, { label: 'B' }, { label: 'Type something.' }, { label: 'Chat about this' }] }) }));
    expect(screen.getByText('A')).toBeTruthy();
    expect(screen.queryByText('Chat about this')).toBeNull();
  });

  it('trust prompt: yes/no with promptKind trust, title is the first line', async () => {
    sendRequest.mockResolvedValue({ type: 'send_choice', success: true });
    tile(sess({ status: 'waiting', pendingPrompt: prompt({ kind: 'trust', question: 'Trust this folder?\n/home/x', header: 'Claude', options: [{ label: 'Yes, trust' }, { label: 'No, exit' }] }) }));
    expect(screen.getByText('Trust this folder?')).toBeTruthy();
    fireEvent.click(screen.getByText('No, exit'));
    await waitFor(() => expect(sendRequest).toHaveBeenCalled());
    expect(sendRequest.mock.calls[0][1]).toMatchObject({ selectedIndices: [1], optionCount: 2, promptKind: 'trust', selectedLabels: ['No, exit'] });
  });

  it('multi-select and multi-question prompts say "Open to answer" (no buttons)', () => {
    const { unmount } = tile(sess({ status: 'waiting', pendingPrompt: prompt({ multiSelect: true }) }));
    expect(screen.getByText('Open to answer')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Postgres' })).toBeNull();
    unmount();
    tile(sess({ status: 'waiting', pendingPrompt: prompt({ questionCount: 2 }) }));
    expect(screen.getByText('Open to answer')).toBeTruthy();
  });

  it('a stale reply shows "Prompt changed, tap to open", which opens the session', async () => {
    sendRequest.mockResolvedValue({ type: 'send_choice', success: false, error: 'stale_prompt' });
    const { onOpen } = tile(sess({ status: 'waiting', pendingPrompt: prompt() }));
    fireEvent.click(screen.getByText('Postgres'));
    const stale = await screen.findByText('Prompt changed, tap to open');
    fireEvent.click(stale);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith('s1', 'sid', true);
  });

  it('a stale state clears when a new prompt (new signature) arrives', async () => {
    sendRequest.mockRejectedValue(new Error('stale_prompt'));
    const s = sess({ status: 'waiting', pendingPrompt: prompt() });
    const { rerender } = render(<SessionTile serverId="s1" session={s} now={NOW} onOpen={() => {}} />);
    fireEvent.click(screen.getByText('Postgres'));
    await screen.findByText('Prompt changed, tap to open');
    rerender(<SessionTile serverId="s1" session={{ ...s, pendingPrompt: prompt({ signature: 'sig-2', question: 'Which cache?' }) }} now={NOW} onOpen={() => {}} />);
    expect(screen.queryByText('Prompt changed, tap to open')).toBeNull();
    expect(screen.getByText('Which cache?')).toBeTruthy();
  });

  it('other failures show an error and re-enable the buttons', async () => {
    sendRequest.mockResolvedValue({ type: 'send_choice', success: false, error: 'boom' });
    tile(sess({ status: 'waiting', pendingPrompt: prompt() }));
    fireEvent.click(screen.getByText('Postgres'));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect((screen.getByText('Postgres') as HTMLButtonElement).disabled).toBe(false);
  });

  it('unseen dot and server label', () => {
    tile(sess(), { unseen: true, serverLabel: 'hexi' });
    expect(screen.getByLabelText('New activity')).toBeTruthy();
    expect(screen.getByText('hexi')).toBeTruthy();
  });

  it('right-click / long-press menu moves the tile', () => {
    const onMoveUp = vi.fn();
    tile(sess(), { onMoveUp });
    fireEvent.contextMenu(screen.getByTestId('mission-tile'));
    fireEvent.click(screen.getByText('Move up'));
    expect(onMoveUp).toHaveBeenCalled();
  });

  it('inlineAnswerable', () => {
    expect(inlineAnswerable(undefined)).toBe(false);
    expect(inlineAnswerable(prompt())).toBe(true);
    expect(inlineAnswerable(prompt({ options: [{ label: 'Other' }] }))).toBe(false);
    expect(inlineAnswerable(prompt({ kind: 'trust', options: [{ label: 'Yes' }] }))).toBe(false);
  });
});
