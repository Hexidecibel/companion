import { useConnections } from '../hooks/useConnections';
import { useServers } from '../hooks/useServers';
import { ConnectionStatus } from './ConnectionStatus';

export function StatusPage() {
  const { servers } = useServers();
  const { snapshots, connectedCount, totalCount } = useConnections();

  const getSnapshot = (serverId: string) =>
    snapshots.find((s) => s.serverId === serverId);

  return (
    <div className="screen">
      <header className="form-header">
        <div className="header-spacer" />
        <h2>Companion</h2>
        <div className="header-spacer" />
      </header>

      <div className="status-page">
        <div className="status-summary">
          <div className="summary-count">
            <span className="count-number">{connectedCount}</span>
            <span className="count-label">
              / {totalCount} server{totalCount !== 1 ? 's' : ''} connected
            </span>
          </div>
        </div>

        {servers.length === 0 ? (
          <div className="empty-state">
            <p>No servers configured</p>
          </div>
        ) : (
          <div className="server-cards">
            {servers.map((server) => {
              const snapshot = getSnapshot(server.id);
              const isDisabled = server.enabled === false;

              return (
                <div
                  key={server.id}
                  className={`server-card ${isDisabled ? 'disabled' : ''}`}
                >
                  <div className="server-card-header">
                    <span className="server-card-name">{server.name || server.host}</span>
                    {isDisabled ? (
                      <span className="connection-badge badge-disabled">Disabled</span>
                    ) : snapshot ? (
                      <ConnectionStatus state={snapshot.state} />
                    ) : null}
                  </div>
                  <div className="server-card-detail">
                    {server.host}:{server.port}
                    {server.useTls ? ' (TLS)' : ''}
                  </div>
                  {snapshot?.state.error && !isDisabled && (
                    <div className="server-card-error">{snapshot.state.error}</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
