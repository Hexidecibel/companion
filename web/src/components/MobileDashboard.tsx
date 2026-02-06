import { useState, useMemo } from 'react';
import { ServerSummary, SessionSummary, ActiveSession } from '../types';
import { useConnections } from '../hooks/useConnections';
import { useServers } from '../hooks/useServers';
import { ServerForm } from './ServerForm';
import { ConnectionSnapshot } from '../services/ConnectionManager';

const STATUS_DOT_CLASS: Record<SessionSummary['status'], string> = {
  waiting: 'status-dot-amber',
  working: 'status-dot-blue',
  idle: 'status-dot-gray',
  error: 'status-dot-red',
};

const STATUS_PRIORITY: Record<SessionSummary['status'], number> = {
  waiting: 0,
  working: 1,
  error: 2,
  idle: 3,
};

function formatRelativeTime(timestamp: number): string {
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return 'now';
  const mins = Math.floor(delta / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function sortSessions(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((a, b) => {
    const pDiff = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
    if (pDiff !== 0) return pDiff;
    return b.lastActivity - a.lastActivity;
  });
}

interface MobileDashboardProps {
  summaries: Map<string, ServerSummary>;
  activeSession: ActiveSession | null;
  onSelectSession: (serverId: string, sessionId: string) => void;
  onSettings?: () => void;
}

export function MobileDashboard({
  summaries,
  onSelectSession,
  onSettings,
}: MobileDashboardProps) {
  const { snapshots } = useConnections();
  const { toggleEnabled } = useServers();
  const [addingServer, setAddingServer] = useState(false);
  const [editingServerId, setEditingServerId] = useState<string | undefined>();

  // Count total waiting sessions across all servers
  const waitingCount = useMemo(() => {
    let count = 0;
    for (const summary of summaries.values()) {
      count += summary.waitingCount;
    }
    return count;
  }, [summaries]);

  return (
    <div className="mobile-dashboard">
      <header className="mobile-dashboard-header">
        <h1 className="mobile-dashboard-title">Companion</h1>
        <div className="mobile-dashboard-header-actions">
          {waitingCount > 0 && (
            <span className="mobile-waiting-badge">{waitingCount}</span>
          )}
          {onSettings && (
            <button
              className="mobile-settings-btn"
              onClick={onSettings}
              title="Settings"
            >
              &#x2699;
            </button>
          )}
        </div>
      </header>

      <div className="mobile-dashboard-content">
        {snapshots.length === 0 && !addingServer && (
          <div className="mobile-empty-state">
            <div className="mobile-empty-icon">&#x1F4E1;</div>
            <h2 className="mobile-empty-title">No Servers</h2>
            <p className="mobile-empty-subtitle">Add a server to get started</p>
            <button
              className="mobile-add-server-btn"
              onClick={() => setAddingServer(true)}
            >
              + Add Server
            </button>
          </div>
        )}

        {snapshots.map((snap) => (
          <ServerCard
            key={snap.serverId}
            snap={snap}
            summary={summaries.get(snap.serverId)}
            onSelectSession={onSelectSession}
            onToggleEnabled={() => toggleEnabled(snap.serverId)}
            onEdit={() => setEditingServerId(snap.serverId)}
          />
        ))}

        {snapshots.length > 0 && !addingServer && (
          <button
            className="mobile-add-server-inline"
            onClick={() => setAddingServer(true)}
          >
            + Add Server
          </button>
        )}

        {addingServer && (
          <div className="mobile-server-form-wrap">
            <ServerForm onClose={() => setAddingServer(false)} />
          </div>
        )}

        {editingServerId && (
          <div className="mobile-server-form-wrap">
            <ServerForm
              serverId={editingServerId}
              onClose={() => setEditingServerId(undefined)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// --- Server Card Sub-component ---

interface ServerCardProps {
  snap: ConnectionSnapshot;
  summary: ServerSummary | undefined;
  onSelectSession: (serverId: string, sessionId: string) => void;
  onToggleEnabled: () => void;
  onEdit: () => void;
}

function ServerCard({ snap, summary, onSelectSession, onEdit }: ServerCardProps) {
  const isConnected = snap.state.status === 'connected';
  const isConnecting = snap.state.status === 'connecting' || snap.state.status === 'reconnecting';
  const sessions = summary ? sortSessions(summary.sessions) : [];
  const waitingCount = summary?.waitingCount ?? 0;

  const dotClass = isConnected
    ? 'status-dot-green'
    : isConnecting
      ? 'status-dot-amber'
      : snap.state.error
        ? 'status-dot-red'
        : 'status-dot-gray';

  return (
    <div className="mobile-server-card">
      <div className="mobile-server-header">
        <span className={`status-dot ${dotClass}`} />
        <span className="mobile-server-name">{snap.serverName}</span>
        {waitingCount > 0 && (
          <span className="mobile-server-waiting-badge">{waitingCount}</span>
        )}
        <button className="mobile-server-edit-btn" onClick={onEdit} title="Edit server">
          &#x270E;
        </button>
      </div>

      {!isConnected && (
        <div className="mobile-server-status">
          {isConnecting ? 'Connecting...' : snap.state.error || 'Disconnected'}
        </div>
      )}

      {isConnected && sessions.length === 0 && (
        <div className="mobile-server-status">No active sessions</div>
      )}

      {isConnected && sessions.map((session) => (
        <div
          key={session.id}
          className="mobile-session-item"
          onClick={() => onSelectSession(snap.serverId, session.id)}
        >
          <span className={`status-dot ${STATUS_DOT_CLASS[session.status]}`} />
          <div className="mobile-session-info">
            <div className="mobile-session-name">{session.name}</div>
            {session.currentActivity && (
              <div className="mobile-session-activity">{session.currentActivity}</div>
            )}
          </div>
          <span className="mobile-session-time">
            {formatRelativeTime(session.lastActivity)}
          </span>
        </div>
      ))}
    </div>
  );
}
