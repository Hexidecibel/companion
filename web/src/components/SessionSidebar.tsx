import { useState, useMemo } from 'react';
import { ServerSummary, ActiveSession, SessionSummary, WorkGroup } from '../types';
import { useConnections } from '../hooks/useConnections';
import { NewSessionPanel } from './NewSessionPanel';
import { TmuxModal } from './TmuxModal';

interface SessionSidebarProps {
  summaries: Map<string, ServerSummary>;
  activeSession: ActiveSession | null;
  onSelectSession: (serverId: string, sessionId: string) => void;
  onManageServers: () => void;
  onSessionCreated?: (serverId: string, sessionName: string) => void;
  onToggleSplit?: () => void;
  splitEnabled?: boolean;
  secondarySession?: ActiveSession | null;
  onNotificationSettings?: () => void;
  mutedSessions?: Set<string>;
  workGroups?: Map<string, WorkGroup[]>;
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

const WORKER_STATUS_DOT: Record<string, string> = {
  spawning: 'status-dot-gray',
  working: 'status-dot-blue',
  waiting: 'status-dot-amber',
  completed: 'status-dot-green',
  error: 'status-dot-red',
};

export function SessionSidebar({
  summaries,
  activeSession,
  onSelectSession,
  onManageServers,
  onSessionCreated,
  onToggleSplit,
  splitEnabled,
  secondarySession,
  onNotificationSettings,
  mutedSessions,
  workGroups,
}: SessionSidebarProps) {
  const { snapshots } = useConnections();
  const [newSessionServerId, setNewSessionServerId] = useState<string | null>(null);
  const [tmuxServerId, setTmuxServerId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // Count total sessions across all servers for filter visibility
  const totalSessionCount = useMemo(() => {
    let count = 0;
    for (const snap of snapshots) {
      const summary = summaries.get(snap.serverId);
      if (summary) count += summary.sessions.length;
    }
    return count;
  }, [snapshots, summaries]);

  // Find the server name for the tmux modal
  const tmuxServerName = useMemo(() => {
    if (!tmuxServerId) return '';
    const snap = snapshots.find((s) => s.serverId === tmuxServerId);
    return snap?.serverName ?? '';
  }, [tmuxServerId, snapshots]);

  // Build a set of session IDs that are workers in any active work group
  const workerSessionIds = useMemo(() => {
    const ids = new Set<string>();
    if (!workGroups) return ids;
    for (const groups of workGroups.values()) {
      for (const group of groups) {
        if (group.status === 'completed' || group.status === 'cancelled') continue;
        for (const worker of group.workers) {
          if (worker.sessionId) ids.add(worker.sessionId);
        }
      }
    }
    return ids;
  }, [workGroups]);

  const toggleGroupCollapse = (groupId: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">Companion</span>
        <div className="sidebar-header-actions">
          {onToggleSplit && (
            <button
              className={`sidebar-split-btn ${splitEnabled ? 'active' : ''}`}
              onClick={onToggleSplit}
              title={splitEnabled ? 'Disable split view' : 'Enable split view'}
            >
              {splitEnabled ? '\u25A3' : '\u25A1'}
            </button>
          )}
          {onNotificationSettings && (
            <button
              className="sidebar-bell-btn"
              onClick={onNotificationSettings}
              title="Notification settings"
            >
              &#x1F514;
            </button>
          )}
          <button
            className="icon-btn small"
            onClick={onManageServers}
            title="Manage servers"
          >
            &equiv;
          </button>
        </div>
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
          const allSessions = summary
            ? filterSessions(sortSessions(summary.sessions), statusFilter)
            : [];

          // Get active work groups for this server
          const serverGroups = (workGroups?.get(snap.serverId) || [])
            .filter(g => g.status === 'active' || g.status === 'merging');

          // Separate foreman sessions (that have a work group) from regular sessions
          const foremanSessionIds = new Set(serverGroups.map(g => g.foremanSessionId));

          // Sessions that are NOT workers (foremen + regular sessions)
          const topLevelSessions = allSessions.filter(s => !workerSessionIds.has(s.id));

          return (
            <div key={snap.serverId} className="sidebar-server-group">
              <div className="sidebar-server-name">
                <span className={`status-dot ${isConnected ? 'status-dot-green' : 'status-dot-gray'}`} />
                <span>{snap.serverName}</span>
                {isConnected && summary && summary.sessions.length > 0 && (
                  <span className="sidebar-session-count">{summary.sessions.length}</span>
                )}
                {isConnected && (
                  <>
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
                    <button
                      className="sidebar-tmux-btn"
                      onClick={() =>
                        setTmuxServerId(
                          tmuxServerId === snap.serverId ? null : snap.serverId,
                        )
                      }
                      title="Tmux sessions"
                    >
                      T
                    </button>
                  </>
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

              {isConnected && summary && summary.sessions.length > 0 && allSessions.length === 0 && (
                <div className="sidebar-server-offline">No {statusFilter} sessions</div>
              )}

              {isConnected &&
                topLevelSessions.map((session) => {
                  const isActive =
                    activeSession?.serverId === snap.serverId &&
                    activeSession?.sessionId === session.id;
                  const isSecondary =
                    secondarySession?.serverId === snap.serverId &&
                    secondarySession?.sessionId === session.id;

                  let sessionClass = 'sidebar-session';
                  if (isActive) sessionClass += ' active';
                  else if (isSecondary) sessionClass += ' active-secondary';

                  // Check if this session is a foreman with a work group
                  const foremanGroup = foremanSessionIds.has(session.id)
                    ? serverGroups.find(g => g.foremanSessionId === session.id)
                    : undefined;

                  const isGroupCollapsed = foremanGroup ? collapsedGroups.has(foremanGroup.id) : false;

                  return (
                    <div key={session.id}>
                      <div
                        className={sessionClass}
                        onClick={() => onSelectSession(snap.serverId, session.id)}
                      >
                        {foremanGroup && (
                          <button
                            className="sidebar-group-toggle"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleGroupCollapse(foremanGroup.id);
                            }}
                          >
                            {isGroupCollapsed ? '\u25B6' : '\u25BC'}
                          </button>
                        )}
                        <span className={`status-dot ${STATUS_DOT_CLASS[session.status]}`} />
                        <div className="sidebar-session-info">
                          <span className="sidebar-session-name">
                            {session.name}
                            {foremanGroup && (
                              <span className="sidebar-foreman-label"> (foreman)</span>
                            )}
                            {mutedSessions?.has(session.id) && (
                              <span className="sidebar-muted-icon" title="Notifications muted">&#x1F515;</span>
                            )}
                          </span>
                          {foremanGroup && (
                            <div className="sidebar-group-progress">
                              <div className="sidebar-group-progress-bar">
                                <div
                                  className="sidebar-group-progress-fill"
                                  style={{
                                    width: `${foremanGroup.workers.length > 0
                                      ? (foremanGroup.workers.filter(w => w.status === 'completed').length / foremanGroup.workers.length) * 100
                                      : 0}%`,
                                  }}
                                />
                              </div>
                              <span className="sidebar-group-progress-text">
                                {foremanGroup.workers.filter(w => w.status === 'completed').length}/{foremanGroup.workers.length}
                              </span>
                            </div>
                          )}
                          {!foremanGroup && session.currentActivity && (
                            <span className="sidebar-session-activity">
                              {session.currentActivity}
                            </span>
                          )}
                        </div>
                        <span className="sidebar-session-time">
                          {formatRelativeTime(session.lastActivity)}
                        </span>
                      </div>

                      {/* Worker sessions nested under foreman */}
                      {foremanGroup && !isGroupCollapsed && (
                        <div className="sidebar-worker-list">
                          {foremanGroup.workers.map((worker, idx) => {
                            const isWorkerActive =
                              activeSession?.serverId === snap.serverId &&
                              activeSession?.sessionId === worker.sessionId;
                            const isLast = idx === foremanGroup.workers.length - 1;

                            return (
                              <div
                                key={worker.id}
                                className={`sidebar-worker ${isWorkerActive ? 'active' : ''}`}
                                onClick={() => onSelectSession(snap.serverId, worker.sessionId)}
                              >
                                <span className="sidebar-worker-connector">
                                  {isLast ? '\u2514' : '\u251C'}
                                </span>
                                <span className={`status-dot ${WORKER_STATUS_DOT[worker.status] || 'status-dot-gray'}`} />
                                <div className="sidebar-session-info">
                                  <span className="sidebar-session-name">
                                    {worker.taskSlug}
                                  </span>
                                  {worker.lastActivity && worker.status === 'working' && (
                                    <span className="sidebar-session-activity">
                                      {worker.lastActivity}
                                    </span>
                                  )}
                                  {worker.status === 'waiting' && (
                                    <span className="sidebar-session-activity sidebar-worker-waiting">
                                      Waiting for input
                                    </span>
                                  )}
                                  {worker.status === 'completed' && (
                                    <span className="sidebar-session-activity sidebar-worker-done">
                                      Done
                                    </span>
                                  )}
                                  {worker.status === 'error' && (
                                    <span className="sidebar-session-activity sidebar-worker-error">
                                      Error
                                    </span>
                                  )}
                                </div>
                                <span className="sidebar-session-time">
                                  {formatRelativeTime(worker.startedAt)}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>

      {tmuxServerId && (
        <TmuxModal
          serverId={tmuxServerId}
          serverName={tmuxServerName}
          onClose={() => setTmuxServerId(null)}
        />
      )}
    </aside>
  );
}
