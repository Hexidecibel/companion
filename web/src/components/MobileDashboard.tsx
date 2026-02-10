import { useState, useMemo, useRef, useCallback } from 'react';
import { ServerSummary, SessionSummary, ActiveSession } from '../types';
import { useConnections } from '../hooks/useConnections';
import { useServers } from '../hooks/useServers';
import { ServerForm } from './ServerForm';
import { NewSessionPanel } from './NewSessionPanel';
import { TmuxModal } from './TmuxModal';
import { ConnectionSnapshot } from '../services/ConnectionManager';
import { connectionManager } from '../services/ConnectionManager';

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
  onSessionCreated?: (serverId: string, sessionName: string) => void;
  onSettings?: () => void;
}

export function MobileDashboard({
  summaries,
  onSelectSession,
  onSessionCreated,
  onSettings,
}: MobileDashboardProps) {
  const { snapshots } = useConnections();
  const { servers, toggleEnabled, deleteServer } = useServers();
  const [addingServer, setAddingServer] = useState(false);
  const [editingServerId, setEditingServerId] = useState<string | undefined>();
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [newSessionServerId, setNewSessionServerId] = useState<string | null>(null);
  const [tmuxServerId, setTmuxServerId] = useState<string | null>(null);

  // Check if any session across all servers needs attention
  const hasWaiting = useMemo(() => {
    for (const summary of summaries.values()) {
      if (summary.waitingCount > 0) return true;
    }
    return false;
  }, [summaries]);

  const tmuxServerName = useMemo(() => {
    if (!tmuxServerId) return '';
    const snap = snapshots.find((s) => s.serverId === tmuxServerId);
    return snap?.serverName ?? '';
  }, [tmuxServerId, snapshots]);

  return (
    <div className="mobile-dashboard">
      <header className="mobile-dashboard-header">
        <h1 className="mobile-dashboard-title">Companion</h1>
        <div className="mobile-dashboard-header-actions">
          {hasWaiting && (
            <span className="mobile-attention-dot" title="Sessions need attention" />
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

        {snapshots.map((snap) => {
          const server = servers.find(s => s.id === snap.serverId);
          const isEnabled = server?.enabled !== false;
          return (
            <div key={snap.serverId}>
              <ServerCard
                snap={snap}
                summary={summaries.get(snap.serverId)}
                onSelectSession={onSelectSession}
                onToggleEnabled={() => toggleEnabled(snap.serverId)}
                onDelete={() => {
                  if (confirmDelete === snap.serverId) {
                    deleteServer(snap.serverId);
                    setConfirmDelete(null);
                  } else {
                    setConfirmDelete(snap.serverId);
                  }
                }}
                onEdit={() => setEditingServerId(snap.serverId)}
                isEnabled={isEnabled}
                onNewSession={() =>
                  setNewSessionServerId(
                    newSessionServerId === snap.serverId ? null : snap.serverId,
                  )
                }
                onTmuxSessions={() =>
                  setTmuxServerId(
                    tmuxServerId === snap.serverId ? null : snap.serverId,
                  )
                }
                newSessionOpen={newSessionServerId === snap.serverId}
              />
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
              {confirmDelete === snap.serverId && (
                <div className="mobile-confirm-delete">
                  Tap delete again to confirm, or{' '}
                  <button className="mobile-confirm-cancel" onClick={() => setConfirmDelete(null)}>
                    cancel
                  </button>
                </div>
              )}
            </div>
          );
        })}

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

      {tmuxServerId && (
        <TmuxModal
          serverId={tmuxServerId}
          serverName={tmuxServerName}
          onClose={() => setTmuxServerId(null)}
        />
      )}
    </div>
  );
}

// --- Server Card Sub-component ---

// --- Mobile Session Item with long-press to kill ---

interface MobileSessionItemProps {
  session: SessionSummary;
  serverId: string;
  onSelect: () => void;
}

function MobileSessionItem({ session, serverId, onSelect }: MobileSessionItemProps) {
  const [confirmKill, setConfirmKill] = useState(false);
  const [killing, setKilling] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didLongPress = useRef(false);

  const startLongPress = useCallback((_e: React.TouchEvent | React.MouseEvent) => {
    if (!session.tmuxSessionName) return;
    didLongPress.current = false;
    longPressTimer.current = setTimeout(() => {
      didLongPress.current = true;
      setConfirmKill(true);
      // Vibrate on mobile if available
      if (navigator.vibrate) navigator.vibrate(50);
    }, 500);
  }, [session.tmuxSessionName]);

  const cancelLongPress = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const handleClick = useCallback(() => {
    if (didLongPress.current) {
      didLongPress.current = false;
      return;
    }
    if (confirmKill) return;
    onSelect();
  }, [confirmKill, onSelect]);

  const handleKill = useCallback(async () => {
    if (!session.tmuxSessionName) return;
    setKilling(true);
    const conn = connectionManager.getConnection(serverId);
    if (conn) {
      await conn.sendRequest('kill_tmux_session', { sessionName: session.tmuxSessionName });
    }
    setKilling(false);
    setConfirmKill(false);
  }, [serverId, session.tmuxSessionName]);

  return (
    <div
      className={`mobile-session-item ${session.status === 'waiting' ? 'mobile-session-waiting' : ''}`}
      onClick={handleClick}
      onTouchStart={startLongPress}
      onTouchEnd={cancelLongPress}
      onTouchMove={cancelLongPress}
      onContextMenu={(e) => {
        e.preventDefault();
        if (session.tmuxSessionName) setConfirmKill(true);
      }}
    >
      {session.status === 'working' ? (
        <span className="mobile-session-spinner" />
      ) : session.status === 'waiting' ? (
        <span className="mobile-attention-dot" />
      ) : (
        <span className={`status-dot ${STATUS_DOT_CLASS[session.status]}`} />
      )}
      <div className="mobile-session-info">
        <div className="mobile-session-name">{session.name}</div>
        {confirmKill ? (
          <div className="mobile-session-kill-confirm">
            <button
              className="mobile-kill-btn"
              onClick={(e) => { e.stopPropagation(); handleKill(); }}
              disabled={killing}
            >
              {killing ? 'Killing...' : 'Kill Session'}
            </button>
            <button
              className="mobile-kill-cancel-btn"
              onClick={(e) => { e.stopPropagation(); setConfirmKill(false); }}
            >
              Cancel
            </button>
          </div>
        ) : (
          session.currentActivity && (
            <div className="mobile-session-activity">{session.currentActivity}</div>
          )
        )}
      </div>
      {!confirmKill && (
        <span className="mobile-session-time">
          {formatRelativeTime(session.lastActivity)}
        </span>
      )}
    </div>
  );
}

interface ServerCardProps {
  snap: ConnectionSnapshot;
  summary: ServerSummary | undefined;
  onSelectSession: (serverId: string, sessionId: string) => void;
  onToggleEnabled: () => void;
  onDelete: () => void;
  onEdit: () => void;
  isEnabled: boolean;
  onNewSession: () => void;
  onTmuxSessions: () => void;
  newSessionOpen: boolean;
}

function ServerCard({ snap, summary, onSelectSession, onToggleEnabled, onDelete, onEdit, isEnabled, onNewSession, onTmuxSessions, newSessionOpen }: ServerCardProps) {
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
          <span className="mobile-attention-dot" />
        )}
        <div className="mobile-server-actions">
          {isConnected && (
            <>
              <button
                className={`mobile-server-new-btn ${newSessionOpen ? 'active' : ''}`}
                onClick={onNewSession}
                title="New session"
              >
                +
              </button>
              <button
                className="mobile-server-tmux-btn"
                onClick={onTmuxSessions}
                title="Tmux sessions"
              >
                T
              </button>
            </>
          )}
          <button
            className={`mobile-server-toggle-btn ${isEnabled ? 'active' : ''}`}
            onClick={onToggleEnabled}
            title={isEnabled ? 'Disable server' : 'Enable server'}
          >
            {isEnabled ? 'On' : 'Off'}
          </button>
          <button className="mobile-server-edit-btn" onClick={onEdit} title="Edit server">
            &#x270E;
          </button>
          <button className="mobile-server-delete-btn" onClick={onDelete} title="Delete server">
            &#x2715;
          </button>
        </div>
      </div>

      {!isConnected && (
        <div className="mobile-server-status">
          {isConnecting ? 'Connecting...' : snap.state.error || 'Disconnected'}
        </div>
      )}

      {isConnected && sessions.length === 0 && (
        <div className="mobile-server-status">No active sessions</div>
      )}

      {isConnected && (() => {
        // Group sessions by projectPath for multi-session projects
        const groupMap = new Map<string, SessionSummary[]>();
        const groupOrder: string[] = [];
        for (const session of sessions) {
          const key = session.projectPath || session.name;
          if (!groupMap.has(key)) {
            groupMap.set(key, []);
            groupOrder.push(key);
          }
          groupMap.get(key)!.push(session);
        }

        return groupOrder.map((key) => {
          const groupSessions = groupMap.get(key)!;
          const showHeader = groupSessions.length > 1;
          const groupName = key.split('/').pop() || key;

          return (
            <div key={key}>
              {showHeader && (
                <div className="mobile-project-header">
                  {groupName}
                  <span className="mobile-project-count">{groupSessions.length}</span>
                </div>
              )}
              {groupSessions.map((session) => (
                <MobileSessionItem
                  key={session.id}
                  session={session}
                  serverId={snap.serverId}
                  onSelect={() => onSelectSession(snap.serverId, session.id)}
                />
              ))}
            </div>
          );
        });
      })()}
    </div>
  );
}
