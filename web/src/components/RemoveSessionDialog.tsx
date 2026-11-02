import { connectionManager } from '../services/ConnectionManager';
import { ConfirmDialog } from './ConfirmDialog';

/** The daemon exits the session gracefully first (about 2 s), then archives. */
const REMOVE_TIMEOUT_MS = 30000;

async function removeSession(serverId: string, sessionId: string): Promise<void> {
  const conn = connectionManager.getConnection(serverId);
  if (!conn || !conn.isConnected()) {
    throw new Error('Not connected to this server. The session was not removed.');
  }
  let response;
  try {
    response = await conn.sendRequest('remove_session', { sessionId }, REMOVE_TIMEOUT_MS);
  } catch (err) {
    const timedOut = err instanceof Error && err.message === 'Request timeout';
    throw new Error(timedOut
      ? 'The server did not answer. The session may or may not have been removed.'
      : 'The connection dropped. The session may or may not have been removed.');
  }
  if (!response.success) {
    throw new Error(response.error ? `Could not remove the session: ${response.error}` : 'Could not remove the session.');
  }
}

export function RemoveSessionDialog({ serverId, sessionId, onClose }: { serverId: string; sessionId: string; onClose: () => void }) {
  return (
    <ConfirmDialog
      title="Remove this session?"
      message="The session will disappear from the list. Its conversation log will be archived if it belongs only to this session. This cannot be undone via the app."
      confirmLabel="Remove"
      busyLabel="Removing..."
      danger
      onConfirm={() => removeSession(serverId, sessionId)}
      onClose={onClose}
    />
  );
}
