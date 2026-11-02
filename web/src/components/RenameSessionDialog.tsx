import { connectionManager } from '../services/ConnectionManager';
import { PromptDialog } from './PromptDialog';

async function renameSession(serverId: string, sessionId: string, name: string): Promise<void> {
  const conn = connectionManager.getConnection(serverId);
  if (!conn || !conn.isConnected()) {
    throw new Error('Not connected to this server. The session was not renamed.');
  }
  let response;
  try {
    response = await conn.sendRequest('rename_session', { sessionId, name });
  } catch {
    throw new Error('The server did not answer. The session may or may not have been renamed.');
  }
  if (!response.success) {
    throw new Error(response.error ? `Could not rename the session: ${response.error}` : 'Could not rename the session.');
  }
}

/** An empty name clears the friendly name, as it always has. */
export function RenameSessionDialog({ serverId, sessionId, currentName, onClose }: { serverId: string; sessionId: string; currentName: string; onClose: () => void }) {
  return (
    <PromptDialog
      title="Rename session"
      label="Session name"
      initialValue={currentName}
      submitLabel="Rename"
      busyLabel="Renaming..."
      onSubmit={(value) => {
        const name = value.trim();
        return name === currentName ? undefined : renameSession(serverId, sessionId, name);
      }}
      onClose={onClose}
    />
  );
}
