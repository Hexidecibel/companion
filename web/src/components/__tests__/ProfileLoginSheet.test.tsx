import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProfileLoginSheet } from '../ProfileLoginSheet';
import type { ProfileLoginFlow } from '../../types/profiles';

const open = vi.hoisted(() => vi.fn(async () => undefined));
const copied = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../utils/externalLinks', () => ({ openExternal: open }));
vi.mock('../../utils/clipboard', () => ({ copyToClipboard: copied }));
vi.mock('../TerminalPanel', () => ({
  TerminalPanel: ({ tmuxSessionName }: { tmuxSessionName: string }) => (
    <div>terminal {tmuxSessionName}</div>
  ),
}));

const base: ProfileLoginFlow = {
  flowId: 'f1',
  profileId: 'work',
  profileLabel: 'Work',
  agent: 'claude',
  state: 'starting',
  sessionName: 'login-work',
  startedAt: 1,
  expiresAt: 2,
};
const URL = 'https://claude.com/x?state=1';

function show(flow: Partial<ProfileLoginFlow>) {
  const h = {
    onClose: vi.fn(),
    onSubmitCode: vi.fn(async () => ({})),
    onCancel: vi.fn(async () => ({})),
    onRetry: vi.fn(),
  };
  render(<ProfileLoginSheet serverId="s" flow={{ ...base, ...flow }} {...h} />);
  return h;
}

describe('ProfileLoginSheet', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it('names the account', () => {
    show({});
    expect(screen.getByRole('heading').textContent).toBe('Logging in to Work (Claude)');
  });

  it('Claude: paste box, copy link, submit sends the trimmed code', async () => {
    const h = show({ state: 'awaiting_code', url: URL });
    fireEvent.change(screen.getByLabelText('Paste the code here'), {
      target: { value: '  abc#d ' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    });
    expect(h.onSubmitCode).toHaveBeenCalledWith('abc#d');
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(copied).toHaveBeenCalledWith(URL);
  });

  it('Codex: the code, no paste box; opening the page also copies the code', () => {
    show({
      agent: 'codex',
      state: 'open_link',
      url: 'https://auth.openai.com/codex/device',
      deviceCode: 'ABCD-EFGH2',
    });
    expect(screen.getByLabelText('One-time code').textContent).toBe('ABCD-EFGH2');
    expect(screen.queryByLabelText('Paste the code here')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open sign-in page' }));
    expect(copied).toHaveBeenCalledWith('ABCD-EFGH2');
    expect(open).toHaveBeenCalledWith('https://auth.openai.com/codex/device');
  });

  it('success shows the account and closes by itself', () => {
    vi.useFakeTimers();
    const h = show({ state: 'success' });
    expect(screen.getByText('Logged in to Work')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(h.onClose).toHaveBeenCalled();
  });

  it('failure shows the message and Try again', () => {
    const h = show({ state: 'failed', message: 'The login was interrupted.' });
    expect(screen.getByText('The login was interrupted.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(h.onRetry).toHaveBeenCalled();
  });

  it('unreadable output offers the terminal', () => {
    show({ unparsed: true });
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }));
    expect(screen.getByText('terminal login-work')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('Cancel asks the daemon', () => {
    const h = show({ state: 'awaiting_code', url: URL });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(h.onCancel).toHaveBeenCalled();
  });
});
