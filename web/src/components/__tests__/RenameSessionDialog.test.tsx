import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

const getConnection = vi.fn();
vi.mock('../../services/ConnectionManager', () => ({
  connectionManager: { getConnection: (id: string) => getConnection(id) },
}));

import { RenameSessionDialog } from '../RenameSessionDialog';

function open(currentName = 'old') {
  const onClose = vi.fn();
  render(<RenameSessionDialog serverId="srv" sessionId="companion-x" currentName={currentName} onClose={onClose} />);
  return { onClose, input: screen.getByLabelText('Session name') as HTMLInputElement };
}
const conn = (sendRequest: unknown, connected = true) => ({ isConnected: () => connected, sendRequest });
const type = (input: HTMLInputElement, value: string) => {
  fireEvent.change(input, { target: { value } });
  fireEvent.submit(input.closest('form')!);
};

describe('RenameSessionDialog', () => {
  beforeEach(() => getConnection.mockReset());
  afterEach(cleanup);

  it('sends the trimmed name to that server and closes', async () => {
    const sendRequest = vi.fn().mockResolvedValue({ success: true });
    getConnection.mockReturnValue(conn(sendRequest));
    const { input, onClose } = open();
    type(input, '  new name ');
    expect(getConnection).toHaveBeenCalledWith('srv');
    expect(sendRequest).toHaveBeenCalledWith('rename_session', { sessionId: 'companion-x', name: 'new name' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('an empty name clears the friendly name; an unchanged one sends nothing', async () => {
    const sendRequest = vi.fn().mockResolvedValue({ success: true });
    getConnection.mockReturnValue(conn(sendRequest));
    const first = open();
    type(first.input, '');
    expect(sendRequest).toHaveBeenCalledWith('rename_session', { sessionId: 'companion-x', name: '' });
    await waitFor(() => expect(first.onClose).toHaveBeenCalled());
    cleanup();
    sendRequest.mockClear();
    const second = open();
    type(second.input, 'old');
    await waitFor(() => expect(second.onClose).toHaveBeenCalled());
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it.each([
    ['refused', () => vi.fn().mockResolvedValue({ success: false, error: 'bad' }), true, /Could not rename the session: bad/],
    ['no answer', () => vi.fn().mockRejectedValue(new Error('Request timeout')), true, /may or may not have been renamed/],
    ['offline', () => vi.fn(), false, /Not connected/],
  ])('stays open with a visible error: %s', async (_name, make, connected, text) => {
    getConnection.mockReturnValue(conn(make(), connected));
    const { input, onClose } = open();
    type(input, 'new');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(text));
    expect(onClose).not.toHaveBeenCalled();
  });
});
