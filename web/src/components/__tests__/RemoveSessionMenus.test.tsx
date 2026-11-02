import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { ServerSummary, SessionSummary } from '../../types';

const sendRequest = vi.fn();
const deleteServer = vi.fn();
const snap = { serverId: 'srv', serverName: 'Hub', state: { status: 'connected' } };

vi.mock('../../services/ConnectionManager', () => ({
  connectionManager: {
    getConnection: () => ({ isConnected: () => true, sendRequest, reconnect: vi.fn() }),
    onChange: () => () => undefined,
    getSnapshots: () => [],
  },
}));
vi.mock('../../hooks/useConnections', () => ({ useConnections: () => ({ snapshots: [snap] }) }));
vi.mock('../../hooks/useServers', () => ({
  useServers: () => ({
    getServer: () => ({ id: 'srv', name: 'Hub', host: 'h', enabled: true }),
    toggleEnabled: vi.fn(),
    deleteServer,
  }),
}));
vi.mock('../../hooks/useConnectionHealth', () => ({ useConnectionHealth: () => [] }));
vi.mock('../../hooks/useSessionMute', () => ({
  useSessionMute: () => ({ mutedSessions: new Set(), toggleMute: vi.fn() }),
}));
vi.mock('../herald/HeraldLauncher', () => ({ HeraldLauncher: () => null }));
vi.mock('../agents/AgentsNavButton', () => ({ AgentsNavButton: () => null }));
vi.mock('../review/ReviewSidebarPill', () => ({ ReviewSidebarPill: () => null }));
vi.mock('../stuck/StuckBadge', () => ({ StuckBadge: () => null }));
vi.mock('../babysit/BabysitBadge', () => ({ BabysitBadge: () => null }));
vi.mock('../ServerFreshness', () => ({ ServerFreshness: () => null }));
vi.mock('../NewSessionPanel', () => ({ NewSessionPanel: () => null }));
vi.mock('../TmuxModal', () => ({ TmuxModal: () => null }));
vi.mock('../ServerForm', () => ({ ServerForm: () => null }));

import { SessionSidebar } from '../SessionSidebar';
import { ServerCard } from '../MobileDashboard';

const session = {
  id: 'companion-x', name: 'x', projectPath: '/p', status: 'idle', lastActivity: 1, tmuxSessionName: 'companion-x',
} as SessionSummary;
const summary = { sessions: [session], totalSessions: 1, waitingCount: 0, workingCount: 0 } as unknown as ServerSummary;

/** WKWebView without a confirm panel: nothing shows and the answer is Cancel. */
function webviewWithoutConfirm() {
  return vi.spyOn(window, 'confirm').mockReturnValue(false);
}

async function removeThroughDialog(confirmSpy: ReturnType<typeof webviewWithoutConfirm>) {
  fireEvent.click(screen.getByRole('button', { name: 'Remove Session' }));
  expect(screen.getByText('Remove this session?')).toBeTruthy();
  expect(sendRequest).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
  expect(confirmSpy).not.toHaveBeenCalled();
  expect(sendRequest.mock.calls[0].slice(0, 2)).toEqual(['remove_session', { sessionId: 'companion-x' }]);
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
}

describe('Remove Session without the webview confirm', () => {
  beforeEach(() => {
    sendRequest.mockReset();
    sendRequest.mockResolvedValue({ success: true });
    deleteServer.mockReset();
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  function sidebar() {
    render(<SessionSidebar summaries={new Map([['srv', summary]])} activeSession={null} onSelectSession={vi.fn()} />);
  }

  it('desktop sidebar', async () => {
    const spy = webviewWithoutConfirm();
    sidebar();
    fireEvent.contextMenu(document.querySelector('.sidebar-session')!);
    await removeThroughDialog(spy);
  });

  it('desktop sidebar: delete server asks in-app', async () => {
    const spy = webviewWithoutConfirm();
    sidebar();
    fireEvent.contextMenu(document.querySelector('.sidebar-server-name')!);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByText('Delete server "Hub"?')).toBeTruthy();
    expect(deleteServer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(deleteServer).toHaveBeenCalledWith('srv');
    expect(spy).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('mobile list: the dialog never selects the row behind it', async () => {
    const spy = webviewWithoutConfirm();
    const onSelectSession = vi.fn();
    const noop = vi.fn();
    render(
      <ServerCard
        snap={snap as never}
        summary={summary}
        onSelectSession={onSelectSession}
        onToggleEnabled={noop}
        onDelete={noop}
        onEdit={noop}
        isEnabled
        onNewSession={noop}
        onNewProject={noop}
        onTmuxSessions={noop}
        newSessionOpen={false}
      />,
    );
    fireEvent.contextMenu(document.querySelector('.mobile-session-item')!);
    await removeThroughDialog(spy);
    expect(onSelectSession).not.toHaveBeenCalled();
  });
});

describe('Rename from the session menus', () => {
  beforeEach(() => sendRequest.mockReset().mockResolvedValue({ success: true }));
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  async function renameThroughDialog(prompt: { mock: { calls: unknown[] } }) {
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const input = screen.getByLabelText('Session name');
    fireEvent.change(input, { target: { value: 'renamed' } });
    fireEvent.submit(input.closest('form')!);
    expect(sendRequest).toHaveBeenCalledWith('rename_session', { sessionId: 'companion-x', name: 'renamed' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(prompt.mock.calls).toEqual([]);
  }

  it('desktop sidebar uses the in-app dialog, never window.prompt', async () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue(null);
    render(<SessionSidebar summaries={new Map([['srv', summary]])} activeSession={null} onSelectSession={vi.fn()} />);
    fireEvent.contextMenu(document.querySelector('.sidebar-session')!);
    await renameThroughDialog(prompt);
  });

  it('mobile list uses the in-app dialog and never selects the row', async () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue(null);
    const onSelectSession = vi.fn();
    const noop = vi.fn();
    render(
      <ServerCard
        snap={snap as never}
        summary={summary}
        onSelectSession={onSelectSession}
        onToggleEnabled={noop}
        onDelete={noop}
        onEdit={noop}
        isEnabled
        onNewSession={noop}
        onNewProject={noop}
        onTmuxSessions={noop}
        newSessionOpen={false}
      />,
    );
    fireEvent.contextMenu(document.querySelector('.mobile-session-item')!);
    await renameThroughDialog(prompt);
    expect(onSelectSession).not.toHaveBeenCalled();
  });
});
