import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

const getConnection = vi.fn();
vi.mock('../../services/ConnectionManager', () => ({
  connectionManager: { getConnection: (id: string) => getConnection(id) },
}));

import { RemoveSessionDialog } from '../RemoveSessionDialog';

function open() {
  const onClose = vi.fn();
  render(<RemoveSessionDialog serverId="srv" sessionId="companion-x" onClose={onClose} />);
  expect(screen.getByText('Remove this session?')).toBeTruthy();
  expect(screen.getByText(/conversation log will be archived.*cannot be undone via the app\./)).toBeTruthy();
  return onClose;
}
const conn = (sendRequest: unknown, connected = true) => ({ isConnected: () => connected, sendRequest });

describe('RemoveSessionDialog', () => {
  beforeEach(() => getConnection.mockReset());
  afterEach(cleanup);

  it('Cancel sends nothing', () => {
    const sendRequest = vi.fn();
    getConnection.mockReturnValue(conn(sendRequest));
    const onClose = open();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(sendRequest).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('removes the session on that server and closes on success', async () => {
    const sendRequest = vi.fn().mockResolvedValue({ type: 'session_removed', success: true });
    getConnection.mockReturnValue(conn(sendRequest));
    const onClose = open();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(getConnection).toHaveBeenCalledWith('srv');
    expect(sendRequest.mock.calls[0].slice(0, 2)).toEqual(['remove_session', { sessionId: 'companion-x' }]);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it.each([
    ['no connection', () => undefined, /Not connected/],
    ['a disconnected server', () => conn(vi.fn(), false), /Not connected/],
    ['a refusal', () => conn(vi.fn().mockResolvedValue({ success: false, error: 'boom' })), /Could not remove the session: boom/],
    ['a timeout', () => conn(vi.fn().mockRejectedValue(new Error('Request timeout'))), /did not answer/],
    ['a dropped socket', () => conn(vi.fn().mockRejectedValue(new Error('WebSocket is not connected'))), /connection dropped/],
  ])('shows an error and stays open on %s', async (_name, make, text) => {
    getConnection.mockReturnValue(make());
    const onClose = open();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(text));
    expect(onClose).not.toHaveBeenCalled();
  });
});
