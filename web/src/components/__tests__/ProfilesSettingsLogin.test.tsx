import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProfilesCard } from '../ProfilesSettings';
import type { ProfileLoginFlow } from '../../types/profiles';

const state = vi.hoisted(() => ({
  flows: {} as Record<string, unknown>,
  login: vi.fn(),
}));
const tab = vi.hoisted(() => ({ navigate: vi.fn(), close: vi.fn() }));
const prepare = vi.hoisted(() => vi.fn(() => tab as typeof tab | null));

vi.mock('../../hooks/useProfiles', () => ({
  useProfiles: () => ({
    profiles: [
      { id: 'work', label: 'Work', agent: 'claude', home: '/h', isDefault: false, loginState: 'logged_out' },
      { id: 'x2', label: 'X', agent: 'codex', home: '/x', isDefault: false, loginState: 'logged_out' },
    ],
    supported: true,
    error: null,
    login: state.login,
    refresh: vi.fn(),
    loginFlows: state.flows,
    submitLoginCode: vi.fn(async () => ({})),
    cancelLogin: vi.fn(async () => ({})),
  }),
}));
vi.mock('../../utils/externalLinks', () => ({
  prepareExternalTab: prepare,
  openExternal: vi.fn(),
}));
vi.mock('../TerminalPanel', () => ({ TerminalPanel: () => null }));

const flow = (over: Partial<ProfileLoginFlow>): ProfileLoginFlow => ({
  flowId: 'f1',
  profileId: 'work',
  profileLabel: 'Work',
  agent: 'claude',
  state: 'starting',
  sessionName: 'login-work',
  startedAt: 1,
  expiresAt: 2,
  ...over,
});

describe('ProfilesCard login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.flows = {};
    sessionStorage.clear();
  });

  it('Claude: the tab opened during the tap goes to the link when it arrives', async () => {
    state.login.mockImplementation(async () => {
      const f = flow({});
      state.flows = { work: f };
      return { sessionName: f.sessionName, command: 'x', flow: f };
    });
    const { rerender } = render(<ProfilesCard serverId="s" serverName="S" />);
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Log in' })[0]);
    });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(tab.navigate).not.toHaveBeenCalled();
    state.flows = { work: flow({ state: 'awaiting_code', url: 'https://claude.com/a' }) };
    rerender(<ProfilesCard serverId="s" serverName="S" />);
    expect(tab.navigate).toHaveBeenCalledWith('https://claude.com/a');
    expect(screen.getByLabelText('Paste the code here')).toBeTruthy();
  });

  it('Codex opens nothing by itself', async () => {
    const f = flow({ flowId: 'f2', profileId: 'x2', agent: 'codex', profileLabel: 'X' });
    state.login.mockImplementation(async () => {
      state.flows = { x2: f };
      return { sessionName: 'login-x2', command: 'x', flow: f };
    });
    render(<ProfilesCard serverId="s" serverName="S" />);
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Log in' })[1]);
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('a login started on another device shows as in progress and opens nothing', () => {
    state.flows = { work: flow({ state: 'awaiting_code', url: 'https://claude.com/a' }) };
    render(<ProfilesCard serverId="s" serverName="S" />);
    expect(screen.getByText('Login in progress')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(tab.navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(tab.navigate).not.toHaveBeenCalled();
  });

  it('coming back on the device that started it restores the sheet, without reopening', () => {
    sessionStorage.setItem('companion.login.started.s.work', 'f1');
    state.flows = { work: flow({ state: 'awaiting_code', url: 'https://claude.com/a' }) };
    render(<ProfilesCard serverId="s" serverName="S" />);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(tab.navigate).not.toHaveBeenCalled();
  });

  it('a blocked popup still leaves the sheet with its Open button', async () => {
    prepare.mockReturnValueOnce(null);
    const f = flow({ state: 'awaiting_code', url: 'https://claude.com/a' });
    state.login.mockImplementation(async () => {
      state.flows = { work: f };
      return { sessionName: f.sessionName, command: 'x', flow: f };
    });
    render(<ProfilesCard serverId="s" serverName="S" />);
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Log in' })[0]);
    });
    expect(screen.getByRole('button', { name: 'Open sign-in page' })).toBeTruthy();
  });

  it('an older daemon keeps the old note', async () => {
    state.login.mockResolvedValue({ sessionName: 'login-work', command: 'claude auth login' });
    render(<ProfilesCard serverId="s" serverName="S" />);
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Log in' })[0]);
    });
    expect(tab.close).toHaveBeenCalled();
    expect(screen.getByText(/Open it from the session list/)).toBeTruthy();
  });
});
