import { useState, useMemo, useEffect, useCallback } from 'react';
import { ServerSummary, ActiveSession, SessionSummary, WorkGroup, WorkerSession } from '../types';
import { useConnections } from '../hooks/useConnections';
import { useServers } from '../hooks/useServers';
import { connectionManager } from '../services/ConnectionManager';
import { NewSessionPanel } from './NewSessionPanel';
import { TmuxModal } from './TmuxModal';
import { ServerForm } from './ServerForm';
import { ContextMenu, ContextMenuEntry } from './ContextMenu';
import { getFontScale, saveFontScale } from '../services/storage';

interface SessionSidebarProps {
  summaries: Map<string, ServerSummary>;
  activeSession: ActiveSession | null;
  onSelectSession: (serverId: string, sessionId: string) => void;
  onSessionCreated?: (serverId: string, sessionName: string) => void;
  onOpenInSplit?: (serverId: string, sessionId: string) => void;
  onCloseSplit?: () => void;
  secondarySession?: ActiveSession | null;
  onToggleDashboardMode?: () => void;
  dashboardMode?: boolean;
  onNotificationSettings?: () => void;
  onSettings?: () => void;
  mutedSessions?: Set<string>;
  onToggleMute?: (serverId: string, sessionId: string) => void;
  workGroups?: Map<string, WorkGroup[]>;
  mobileOpen?: boolean;
}

const STATUS_DOT_CLASS: Record<SessionSummary['status'], string> = {
  waiting: 'status-dot-amber',
  working: 'status-dot-blue',
  idle: 'status-dot-gray',
  error: 'status-dot-red',
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

const STATUS_PRIORITY: Record<SessionSummary['status'], number> = {
  waiting: 0,
  working: 0,
  error: 1,
  idle: 2,
};

function sortSessions(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((a, b) => {
    // Active sessions (waiting/working) always above idle
    const pDiff = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
    if (pDiff !== 0) return pDiff;
    // Within same priority, most recently active first
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

interface ContextMenuState {
  type: 'server' | 'session' | 'worker';
  position: { x: number; y: number };
  serverId: string;
  sessionId?: string;
  tmuxSessionName?: string;
  workerId?: string;
  workerGroupId?: string;
}

export function SessionSidebar({
  summaries,
  activeSession,
  onSelectSession,
  onSessionCreated,
  onOpenInSplit,
  onCloseSplit,
  secondarySession,
  onToggleDashboardMode,
  dashboardMode,
  onNotificationSettings,
  onSettings,
  mutedSessions,
  onToggleMute,
  workGroups,
  mobileOpen,
}: SessionSidebarProps) {
  const { snapshots } = useConnections();
  const { getServer, toggleEnabled, deleteServer } = useServers();
  const [newSessionServerId, setNewSessionServerId] = useState<string | null>(null);
  const [tmuxServerId, setTmuxServerId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [fontScale, setFontScale] = useState(getFontScale);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  // undefined = not open, null = adding new, string = editing existing
  const [editingServerId, setEditingServerId] = useState<string | undefined | null>(undefined);

  // Listen for 'open-add-server' custom event (from command palette)
  useEffect(() => {
    const handler = () => setEditingServerId(null);
    window.addEventListener('open-add-server', handler);
    return () => window.removeEventListener('open-add-server', handler);
  }, []);

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

  const handleServerContextMenu = useCallback((e: React.MouseEvent, serverId: string) => {
    e.preventDefault();
    setContextMenu({
      type: 'server',
      position: { x: e.clientX, y: e.clientY },
      serverId,
    });
  }, []);

  const handleSessionContextMenu = useCallback((e: React.MouseEvent, serverId: string, sessionId: string, tmuxSessionName?: string) => {
    e.preventDefault();
    setContextMenu({
      type: 'session',
      position: { x: e.clientX, y: e.clientY },
      serverId,
      sessionId,
      tmuxSessionName,
    });
  }, []);

  const handleWorkerContextMenu = useCallback((e: React.MouseEvent, serverId: string, worker: WorkerSession, group: WorkGroup) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      type: 'worker',
      position: { x: e.clientX, y: e.clientY },
      serverId,
      sessionId: worker.sessionId,
      tmuxSessionName: worker.tmuxSessionName,
      workerId: worker.id,
      workerGroupId: group.id,
    });
  }, []);

  const buildWorkerMenuItems = useCallback((serverId: string, sessionId: string, tmuxSessionName?: string): ContextMenuEntry[] => {
    const isMuted = mutedSessions?.has(sessionId) ?? false;
    const items: ContextMenuEntry[] = [];

    if (onToggleMute) {
      items.push({
        label: isMuted ? 'Unmute' : 'Mute',
        onClick: () => onToggleMute(serverId, sessionId),
      });
    }

    if (tmuxSessionName) {
      if (items.length > 0) items.push(null);
      items.push({
        label: 'Kill Worker',
        danger: true,
        onClick: () => {
          const conn = connectionManager.getConnection(serverId);
          if (conn) {
            conn.sendRequest('kill_tmux_session', { sessionName: tmuxSessionName });
          }
        },
      });
    }

    return items;
  }, [mutedSessions, onToggleMute]);

  const buildServerMenuItems = useCallback((serverId: string): ContextMenuEntry[] => {
    const snap = snapshots.find((s) => s.serverId === serverId);
    const server = getServer(serverId);
    const isConnected = snap?.state.status === 'connected';
    const isDisabled = server?.enabled === false;
    const conn = connectionManager.getConnection(serverId);

    const items: ContextMenuEntry[] = [
      { label: 'Edit Server', onClick: () => setEditingServerId(serverId) },
      { label: 'New Session', onClick: () => setNewSessionServerId(serverId), disabled: !isConnected },
      null,
    ];

    if (!isConnected) {
      items.push({ label: 'Connect', onClick: () => { if (server) connectionManager.connectServer(server); }, disabled: isDisabled });
    } else {
      items.push({ label: 'Disconnect', onClick: () => connectionManager.disconnectServer(serverId) });
      items.push({ label: 'Reconnect', onClick: () => conn?.reconnect() });
    }

    items.push(null);
    items.push({
      label: isDisabled ? 'Enable' : 'Disable',
      onClick: () => toggleEnabled(serverId),
    });
    items.push({
      label: 'Delete',
      danger: true,
      onClick: () => {
        if (window.confirm(`Delete server "${server?.name || server?.host}"?`)) {
          deleteServer(serverId);
        }
      },
    });

    return items;
  }, [snapshots, getServer, toggleEnabled, deleteServer]);

  const buildSessionMenuItems = useCallback((serverId: string, sessionId: string, tmuxSessionName?: string): ContextMenuEntry[] => {
    const isMuted = mutedSessions?.has(sessionId) ?? false;
    const isSecondary = secondarySession?.serverId === serverId && secondarySession?.sessionId === sessionId;
    const isActive = activeSession?.serverId === serverId && activeSession?.sessionId === sessionId;

    const items: ContextMenuEntry[] = [];

    // Split view options (desktop only)
    if (onOpenInSplit && !isActive && !isSecondary) {
      items.push({
        label: 'Open in Split',
        onClick: () => onOpenInSplit(serverId, sessionId),
      });
    }
    if (onCloseSplit && isSecondary) {
      items.push({
        label: 'Close Split',
        onClick: () => onCloseSplit(),
      });
    }

    if (onToggleMute) {
      if (items.length > 0) items.push(null);
      items.push({
        label: isMuted ? 'Unmute' : 'Mute',
        onClick: () => onToggleMute(serverId, sessionId),
      });
    }

    if (tmuxSessionName) {
      if (items.length > 0) items.push(null);
      items.push({
        label: 'Kill Session',
        danger: true,
        onClick: () => {
          const conn = connectionManager.getConnection(serverId);
          if (conn) {
            conn.sendRequest('kill_tmux_session', { sessionName: tmuxSessionName });
          }
        },
      });
    }

    return items;
  }, [mutedSessions, onToggleMute, onOpenInSplit, onCloseSplit, secondarySession, activeSession]);

  return (
    <aside className={`sidebar${mobileOpen ? ' sidebar-open' : ''}`}>
      <div className="sidebar-header">
        <span className="sidebar-title">Companion</span>
        <div className="sidebar-header-actions">
          {onToggleDashboardMode && (
            <button
              className={`dashboard-mode-toggle ${dashboardMode ? 'active' : ''}`}
              onClick={onToggleDashboardMode}
              title={dashboardMode ? 'Exit dashboard view' : 'Dashboard view'}
            >
              Grid
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
          {onSettings && (
            <button
              className="sidebar-settings-btn"
              onClick={onSettings}
              title="Settings"
            >
              &#x2699;
            </button>
          )}
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
            <button className="sidebar-add-btn" onClick={() => setEditingServerId(null)}>
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
              <div
                className="sidebar-server-name"
                onContextMenu={(e) => handleServerContextMenu(e, snap.serverId)}
              >
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
                (() => {
                  // Group sessions by projectPath for multi-session projects
                  const projectGroups: { path: string; name: string; sessions: SessionSummary[] }[] = [];
                  const groupMap = new Map<string, SessionSummary[]>();
                  const groupOrder: string[] = [];
                  for (const session of topLevelSessions) {
                    const key = session.projectPath || session.name;
                    if (!groupMap.has(key)) {
                      groupMap.set(key, []);
                      groupOrder.push(key);
                    }
                    groupMap.get(key)!.push(session);
                  }
                  for (const key of groupOrder) {
                    const sessions = groupMap.get(key)!;
                    projectGroups.push({
                      path: key,
                      name: key.split('/').pop() || key,
                      sessions,
                    });
                  }

                  return projectGroups.map((group) => {
                    const showGroupHeader = group.sessions.length > 1;
                    const isGroupCollapsedProject = collapsedGroups.has(`project:${group.path}`);

                    return (
                      <div key={group.path}>
                        {showGroupHeader && (
                          <div
                            className="sidebar-project-header"
                            onClick={() => toggleGroupCollapse(`project:${group.path}`)}
                          >
                            <span className="sidebar-group-toggle-inline">
                              {isGroupCollapsedProject ? '\u25B6' : '\u25BC'}
                            </span>
                            <span className="sidebar-project-name">{group.name}</span>
                            <span className="sidebar-session-count">{group.sessions.length}</span>
                          </div>
                        )}
                        {(!showGroupHeader || !isGroupCollapsedProject) &&
                          group.sessions.map((session) => {
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
                        onContextMenu={(e) => handleSessionContextMenu(e, snap.serverId, session.id, session.tmuxSessionName)}
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
                                onContextMenu={(e) => handleWorkerContextMenu(e, snap.serverId, worker, foremanGroup)}
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
                  });
                })()}
            </div>
          );
        })}

        <button
          className="sidebar-add-server-btn"
          onClick={() => setEditingServerId(null)}
        >
          + Add Server
        </button>
      </div>

      {tmuxServerId && (
        <TmuxModal
          serverId={tmuxServerId}
          serverName={tmuxServerName}
          onClose={() => setTmuxServerId(null)}
        />
      )}

      {contextMenu && (
        <ContextMenu
          items={
            contextMenu.type === 'server'
              ? buildServerMenuItems(contextMenu.serverId)
              : contextMenu.type === 'worker'
              ? buildWorkerMenuItems(contextMenu.serverId, contextMenu.sessionId!, contextMenu.tmuxSessionName)
              : buildSessionMenuItems(contextMenu.serverId, contextMenu.sessionId!, contextMenu.tmuxSessionName)
          }
          position={contextMenu.position}
          onClose={() => setContextMenu(null)}
        />
      )}

      {editingServerId !== undefined && (
        <ServerForm
          serverId={editingServerId ?? undefined}
          onClose={() => setEditingServerId(undefined)}
        />
      )}

      <div className="sidebar-footer">
        <span className="sidebar-footer-label">Text</span>
        <div className="sidebar-font-btns">
          {([
            { label: 'S', value: 0.85 },
            { label: 'M', value: 1.0 },
            { label: 'L', value: 1.15 },
            { label: 'XL', value: 1.3 },
          ] as const).map((p) => (
            <button
              key={p.label}
              className={`sidebar-font-btn ${fontScale === p.value ? 'active' : ''}`}
              onClick={() => {
                saveFontScale(p.value);
                setFontScale(p.value);
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
