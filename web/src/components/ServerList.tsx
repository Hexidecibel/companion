import { useServers } from '../hooks/useServers';
import { useConnections } from '../hooks/useConnections';
import { ConnectionStatus } from './ConnectionStatus';

interface ServerListProps {
  onBack: () => void;
  onAddServer: () => void;
  onEditServer: (id: string) => void;
}

export function ServerList({ onBack, onAddServer, onEditServer }: ServerListProps) {
  const { servers, deleteServer, toggleEnabled } = useServers();
  const { snapshots } = useConnections();

  const getSnapshot = (serverId: string) =>
    snapshots.find((s) => s.serverId === serverId);

  return (
    <div className="screen">
      <header className="form-header">
        <button className="icon-btn" onClick={onBack}>
          &larr;
        </button>
        <h2>Servers</h2>
        <button className="icon-btn" onClick={onAddServer}>
          +
        </button>
      </header>

      <div className="server-list">
        {servers.length === 0 && (
          <div className="empty-state">
            <p>No servers configured</p>
            <button className="btn-primary" onClick={onAddServer}>
              Add Server
            </button>
          </div>
        )}

        {servers.map((server) => {
          const snapshot = getSnapshot(server.id);
          const isDisabled = server.enabled === false;

          return (
            <div
              key={server.id}
              className={`server-item ${isDisabled ? 'disabled' : ''}`}
            >
              <div className="server-item-info" onClick={() => onEditServer(server.id)}>
                <div className="server-item-name">{server.name || server.host}</div>
                <div className="server-item-host">
                  {server.host}:{server.port}
                </div>
              </div>

              <div className="server-item-actions">
                {snapshot && !isDisabled && (
                  <ConnectionStatus state={snapshot.state} />
                )}
                {isDisabled && (
                  <span className="connection-badge badge-disabled">Disabled</span>
                )}
                <button
                  className="icon-btn small"
                  onClick={() => toggleEnabled(server.id)}
                  title={isDisabled ? 'Enable' : 'Disable'}
                >
                  {isDisabled ? '>' : '||'}
                </button>
                <button
                  className="icon-btn small danger"
                  onClick={() => {
                    if (confirm(`Delete server "${server.name || server.host}"?`)) {
                      deleteServer(server.id);
                    }
                  }}
                  title="Delete"
                >
                  x
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
