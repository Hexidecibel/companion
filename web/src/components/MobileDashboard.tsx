import { useState, useMemo, useRef, useCallback } from 'react';
import { ServerSummary, SessionSummary, ActiveSession } from '../types';
import { useConnections } from '../hooks/useConnections';
import { useServers } from '../hooks/useServers';
import { useSessionMute } from '../hooks/useSessionMute';
import { ServerForm } from './ServerForm';
import { NewSessionPanel } from './NewSessionPanel';
import { TmuxModal } from './TmuxModal';
import { ContextMenu, ContextMenuEntry } from './ContextMenu';
import { ConnectionSnapshot } from '../services/ConnectionManager';
import { Sparkline } from './Sparkline';
import { connectionManager } from '../services/ConnectionManager';
import { DigestData } from '../hooks/useAwayDigest';
import { AwayDigest } from './AwayDigest';

const STATUS_DOT_CLASS: Record<SessionSummary['status'], string> = {
  waiting: 'status-dot-blue status-dot-pulse',
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
  onCostDashboard?: (serverId: string) => void;
  onOpenInSplit?: (serverId: string, sessionId: string) => void;
  onCloseSplit?: () => void;
  secondarySession?: ActiveSession | null;
  digest?: DigestData;
  onDismissDigest?: () => void;
}

export function MobileDashboard({
  summaries,
  onSelectSession,
  onSessionCreated,
  onSettings,
  onCostDashboard,
  onOpenInSplit,
  onCloseSplit,
  secondarySession,
  digest,
  onDismissDigest,
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
        {digest && onDismissDigest && (
          <AwayDigest
            digest={digest}
            onDismiss={onDismissDigest}
            onSelectSession={(sessionId) => {
              // Find which server has this session
              for (const snap of snapshots) {
                const summary = summaries.get(snap.serverId);
                if (summary?.sessions.some(s => s.id === sessionId)) {
                  onSelectSession(snap.serverId, sessionId);
                  onDismissDigest();
                  return;
                }
              }
            }}
          />
        )}

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
                onCostDashboard={onCostDashboard ? () => onCostDashboard(snap.serverId) : undefined}
                onOpenInSplit={onOpenInSplit}
                onCloseSplit={onCloseSplit}
                secondarySessionId={secondarySession?.serverId === snap.serverId ? secondarySession.sessionId : null}
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
  onOpenInSplit?: (serverId: string, sessionId: string) => void;
  onCloseSplit?: () => void;
  isSecondary?: boolean;
  isMuted?: boolean;
  onToggleMute?: (sessionId: string) => void;
}

function MobileSessionItem({ session, serverId, onSelect, onOpenInSplit, onCloseSplit, isSecondary, isMuted, onToggleMute }: MobileSessionItemProps) {
  const [killing, setKilling] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didLongPress = useRef(false);

  const openMenu = useCallback((x: number, y: number) => {
    setContextMenu({ x, y });
    if (navigator.vibrate) navigator.vibrate(50);
  }, []);

  const startLongPress = useCallback((e: React.TouchEvent | React.MouseEvent) => {
    didLongPress.current = false;
    const pos = 'touches' in e
      ? { x: e.touches[0].clientX, y: e.touches[0].clientY }
      : { x: e.clientX, y: e.clientY };
    longPressTimer.current = setTimeout(() => {
      didLongPress.current = true;
      openMenu(pos.x, pos.y);
    }, 500);
  }, [openMenu]);

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
    if (contextMenu) return;
    onSelect();
  }, [contextMenu, onSelect]);

  const handleKill = useCallback(async () => {
    if (!session.tmuxSessionName) return;
    setKilling(true);
    const conn = connectionManager.getConnection(serverId);
    if (conn) {
      await conn.sendRequest('kill_tmux_session', { sessionName: session.tmuxSessionName });
    }
    setKilling(false);
  }, [serverId, session.tmuxSessionName]);

  const menuItems = useMemo((): ContextMenuEntry[] => {
    const items: ContextMenuEntry[] = [];
    if (isSecondary && onCloseSplit) {
      items.push({ label: 'Close Split', onClick: onCloseSplit });
    } else if (onOpenInSplit) {
      items.push({ label: 'Open in Split', onClick: () => onOpenInSplit(serverId, session.id) });
    }
    items.push({
      label: 'Rename',
      onClick: () => {
        const newName = window.prompt('Session name:', session.friendlyName || '');
        if (newName !== null) {
          const conn = connectionManager.getConnection(serverId);
          if (conn) conn.sendRequest('rename_session', { sessionId: session.id, name: newName });
        }
      },
    });
    if (onToggleMute) {
      items.push({ label: isMuted ? 'Unmute' : 'Mute', onClick: () => onToggleMute(session.id) });
    }
    if (session.tmuxSessionName) {
      items.push(null);
      items.push({ label: killing ? 'Killing...' : 'Kill Session', onClick: handleKill, danger: true, disabled: killing });
    }
    return items;
  }, [isSecondary, onCloseSplit, onOpenInSplit, onToggleMute, isMuted, session, serverId, killing, handleKill]);

  return (
    <div
      className={`mobile-session-item ${session.status === 'waiting' ? 'mobile-session-waiting' : ''}`}
      onClick={handleClick}
      onTouchStart={startLongPress}
      onTouchEnd={cancelLongPress}
      onTouchMove={cancelLongPress}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY);
      }}
    >
      {session.status === 'working' ? (
        <span className="mobile-session-spinner" />
      ) : (
        <span className={`status-dot ${STATUS_DOT_CLASS[session.status]}`} />
      )}
      <div className="mobile-session-info">
        <div className="mobile-session-name">{session.friendlyName || session.name}</div>
        {session.currentActivity && (
          <div className="mobile-session-activity">{session.currentActivity}</div>
        )}
      </div>
      {session.recentTimestamps && session.recentTimestamps.length > 0 && (
        <Sparkline timestamps={session.recentTimestamps} />
      )}
      <span className="mobile-session-time">
        {formatRelativeTime(session.lastActivity)}
      </span>
      {contextMenu && menuItems.length > 0 && (
        <ContextMenu
          items={menuItems}
          position={contextMenu}
          onClose={() => setContextMenu(null)}
        />
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
  onCostDashboard?: () => void;
  onOpenInSplit?: (serverId: string, sessionId: string) => void;
  onCloseSplit?: () => void;
  secondarySessionId?: string | null;
  newSessionOpen: boolean;
}

export { ServerCard };
export type { ServerCardProps };

function ServerCard({ snap, summary, onSelectSession, onToggleEnabled, onDelete, onEdit, isEnabled, onNewSession, onTmuxSessions, onCostDashboard, onOpenInSplit, onCloseSplit, secondarySessionId, newSessionOpen }: ServerCardProps) {
  const isConnected = snap.state.status === 'connected';
  const isConnecting = snap.state.status === 'connecting' || snap.state.status === 'reconnecting';
  const sessions = summary ? sortSessions(summary.sessions) : [];
  const waitingCount = summary?.waitingCount ?? 0;
  const { mutedSessions, toggleMute } = useSessionMute(snap.serverId);

  const dotClass = isConnected
    ? 'status-dot-green'
    : isConnecting
      ? 'status-dot-blue status-dot-pulse'
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
              {onCostDashboard && (
                <button
                  className="mobile-server-tmux-btn"
                  onClick={onCostDashboard}
                  title="Cost dashboard"
                >
                  $
                </button>
              )}
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
                  onOpenInSplit={onOpenInSplit}
                  onCloseSplit={onCloseSplit}
                  isSecondary={secondarySessionId === session.id}
                  isMuted={mutedSessions.has(session.id)}
                  onToggleMute={toggleMute}
                />
              ))}
            </div>
          );
        });
      })()}
    </div>
  );
}
