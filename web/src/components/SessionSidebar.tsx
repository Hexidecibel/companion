import { useState, useMemo } from 'react';
import { ServerSummary, ActiveSession, SessionSummary } from '../types';
import { useConnections } from '../hooks/useConnections';
import { NewSessionPanel } from './NewSessionPanel';

interface SessionSidebarProps {
  summaries: Map<string, ServerSummary>;
  activeSession: ActiveSession | null;
  onSelectSession: (serverId: string, sessionId: string) => void;
  onManageServers: () => void;
  onSessionCreated?: (serverId: string, sessionName: string) => void;
}

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

type StatusFilter = 'all' | 'waiting' | 'working' | 'idle';

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

function filterSessions(sessions: SessionSummary[], filter: StatusFilter): SessionSummary[] {
  if (filter === 'all') return sessions;
  return sessions.filter((s) => s.status === filter);
}

export function SessionSidebar({
  summaries,
  activeSession,
  onSelectSession,
  onManageServers,
  onSessionCreated,
}: SessionSidebarProps) {
  const { snapshots } = useConnections();
  const [newSessionServerId, setNewSessionServerId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  // Count total sessions across all servers for filter visibility
  const totalSessionCount = useMemo(() => {
    let count = 0;
    for (const snap of snapshots) {
      const summary = summaries.get(snap.serverId);
      if (summary) count += summary.sessions.length;
    }
    return count;
  }, [snapshots, summaries]);

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">Companion</span>
        <button
          className="icon-btn small"
          onClick={onManageServers}
          title="Manage servers"
        >
          &equiv;
        </button>
      </div>

      {totalSessionCount > 1 && (
        <div className="sidebar-filter">
          {(['all', 'waiting', 'working', 'idle'] as StatusFilter[]).map((f) => (
            <button
              key={f}
              className={`sidebar-filter-btn ${statusFilter === f ? 'active' : ''}`}
              onClick={() => setStatusFilter(f)}
            >
              {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      )}

      <div className="sidebar-sessions">
        {snapshots.length === 0 && (
          <div className="sidebar-empty">
            <span>No servers configured</span>
            <button className="sidebar-add-btn" onClick={onManageServers}>
              Add Server
            </button>
          </div>
        )}

        {snapshots.map((snap) => {
          const summary = summaries.get(snap.serverId);
          const isConnected = snap.state.status === 'connected';
          const sessions = summary
            ? filterSessions(sortSessions(summary.sessions), statusFilter)
            : [];

          return (
            <div key={snap.serverId} className="sidebar-server-group">
              <div className="sidebar-server-name">
                <span className={`status-dot ${isConnected ? 'status-dot-green' : 'status-dot-gray'}`} />
                <span>{snap.serverName}</span>
                {isConnected && summary && summary.sessions.length > 0 && (
                  <span className="sidebar-session-count">{summary.sessions.length}</span>
                )}
                {isConnected && (
                  <button
                    className="sidebar-new-session-btn"
                    onClick={() =>
                      setNewSessionServerId(
                        newSessionServerId === snap.serverId ? null : snap.serverId,
                      )
                    }
                    title="New session"
                  >
                    +
                  </button>
                )}
              </div>

              {newSessionServerId === snap.serverId && (
                <NewSessionPanel
                  serverId={snap.serverId}
                  serverName={snap.serverName}
                  onCreated={(sid, name) => {
                    setNewSessionServerId(null);
                    onSessionCreated?.(sid, name);
                  }}
                  onClose={() => setNewSessionServerId(null)}
                />
              )}

              {!isConnected && (
                <div className="sidebar-server-offline">
                  {snap.state.status === 'connecting' || snap.state.status === 'reconnecting'
                    ? 'Connecting...'
                    : 'Disconnected'}
                </div>
              )}

              {isConnected && summary && summary.sessions.length === 0 && (
                <div className="sidebar-server-offline">No active sessions</div>
              )}

              {isConnected && summary && summary.sessions.length > 0 && sessions.length === 0 && (
                <div className="sidebar-server-offline">No {statusFilter} sessions</div>
              )}

              {isConnected &&
                sessions.map((session) => {
                  const isActive =
                    activeSession?.serverId === snap.serverId &&
                    activeSession?.sessionId === session.id;

                  return (
                    <div
                      key={session.id}
                      className={`sidebar-session ${isActive ? 'active' : ''}`}
                      onClick={() => onSelectSession(snap.serverId, session.id)}
                    >
                      <span className={`status-dot ${STATUS_DOT_CLASS[session.status]}`} />
                      <div className="sidebar-session-info">
                        <span className="sidebar-session-name">{session.name}</span>
                        {session.currentActivity && (
                          <span className="sidebar-session-activity">
                            {session.currentActivity}
                          </span>
                        )}
                      </div>
                      <span className="sidebar-session-time">
                        {formatRelativeTime(session.lastActivity)}
                      </span>
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
