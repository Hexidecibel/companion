import { useState, useCallback, useMemo, useEffect } from 'react';
import { ActiveSession, SessionSummary, WorkGroup } from '../types';
import { useAllServerSummaries } from '../hooks/useAllServerSummaries';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useConnections } from '../hooks/useConnections';
import { useWorkGroups } from '../hooks/useWorkGroups';
import { SessionSidebar } from './SessionSidebar';
import { SessionView } from './SessionView';
import { ShortcutHelpOverlay } from './ShortcutHelpOverlay';
import { NotificationSettingsModal } from './NotificationSettingsModal';
import { useSessionMute } from '../hooks/useSessionMute';

interface DashboardProps {
  onSettings?: () => void;
}

export function Dashboard({ onSettings }: DashboardProps) {
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const [showNotifSettings, setShowNotifSettings] = useState(false);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [merging, setMerging] = useState(false);
  const summaries = useAllServerSummaries();
  const sessionMute = useSessionMute(activeSession?.serverId ?? null);
  const { snapshots } = useConnections();

  // Use work groups for the active server
  const activeWorkGroups = useWorkGroups(activeSession?.serverId ?? null);

  // Merge all work groups into a per-server map for sidebar
  const allWorkGroups = useMemo(() => {
    const map = new Map<string, WorkGroup[]>();
    if (activeSession?.serverId && activeWorkGroups.groups.length > 0) {
      map.set(activeSession.serverId, activeWorkGroups.groups);
    }
    return map;
  }, [activeSession?.serverId, activeWorkGroups.groups]);

  // Find the work group for the current active session (if it's a foreman)
  const activeWorkGroup = useMemo((): WorkGroup | undefined => {
    if (!activeSession) return undefined;
    return activeWorkGroups.getGroupForSession(activeSession.sessionId);
  }, [activeSession, activeWorkGroups]);

  // Is the active session a foreman of the work group?
  const isForemanView = activeWorkGroup?.foremanSessionId === activeSession?.sessionId;

  // Build flat session list for j/k navigation
  const flatSessions = useMemo(() => {
    const result: { serverId: string; sessionId: string }[] = [];
    for (const snap of snapshots) {
      const summary = summaries.get(snap.serverId);
      if (!summary) continue;
      for (const session of summary.sessions) {
        result.push({ serverId: snap.serverId, sessionId: session.id });
      }
    }
    return result;
  }, [snapshots, summaries]);

  const navigateSession = useCallback((direction: 1 | -1) => {
    if (flatSessions.length === 0) return;
    if (!activeSession) {
      setActiveSession(flatSessions[0]);
      return;
    }
    const idx = flatSessions.findIndex(
      (s) => s.serverId === activeSession.serverId && s.sessionId === activeSession.sessionId,
    );
    const next = idx + direction;
    if (next >= 0 && next < flatSessions.length) {
      setActiveSession(flatSessions[next]);
    }
  }, [flatSessions, activeSession]);

  const handleSelectSession = useCallback((serverId: string, sessionId: string) => {
    setActiveSession({ serverId, sessionId });
  }, []);

  const handleSessionCreated = useCallback((_serverId: string, sessionName: string) => {
    setActiveSession({ serverId: _serverId, sessionId: sessionName });
  }, []);

  // Select session by index (Cmd+1-9)
  const selectSessionByIndex = useCallback((index: number) => {
    if (index < flatSessions.length) {
      setActiveSession(flatSessions[index]);
    }
  }, [flatSessions]);

  // Keyboard shortcuts
  const shortcuts = useMemo(() => [
    { key: 'j', handler: () => navigateSession(1) },
    { key: 'ArrowDown', handler: () => navigateSession(1) },
    { key: 'k', handler: () => navigateSession(-1) },
    { key: 'ArrowUp', handler: () => navigateSession(-1) },
    { key: '/', handler: () => {
      const textarea = document.querySelector('.input-bar-textarea') as HTMLElement | null;
      textarea?.focus();
    }},
    { key: '?', handler: () => setShowShortcutHelp(prev => !prev) },
    { key: 'Escape', handler: () => {
      if (showShortcutHelp) setShowShortcutHelp(false);
      else if (showNotifSettings) setShowNotifSettings(false);
    }},
    { key: '[', meta: true, handler: () => navigateSession(-1) },
    { key: ']', meta: true, handler: () => navigateSession(1) },
    { key: '1', meta: true, handler: () => selectSessionByIndex(0) },
    { key: '2', meta: true, handler: () => selectSessionByIndex(1) },
    { key: '3', meta: true, handler: () => selectSessionByIndex(2) },
    { key: '4', meta: true, handler: () => selectSessionByIndex(3) },
    { key: '5', meta: true, handler: () => selectSessionByIndex(4) },
    { key: '6', meta: true, handler: () => selectSessionByIndex(5) },
    { key: '7', meta: true, handler: () => selectSessionByIndex(6) },
    { key: '8', meta: true, handler: () => selectSessionByIndex(7) },
    { key: '9', meta: true, handler: () => selectSessionByIndex(8) },
  ], [navigateSession, selectSessionByIndex, showShortcutHelp, showNotifSettings]);

  useKeyboardShortcuts(shortcuts);

  // Look up tmuxSessionName for the active session
  const activeSessionSummary: SessionSummary | undefined = useMemo(() => {
    if (!activeSession) return undefined;
    const serverSummary = summaries.get(activeSession.serverId);
    if (!serverSummary) return undefined;
    return serverSummary.sessions.find((s) => s.id === activeSession.sessionId);
  }, [activeSession, summaries]);

  // Listen for command palette event to open notification settings
  useEffect(() => {
    const handler = () => setShowNotifSettings(true);
    window.addEventListener('open-notification-settings', handler);
    return () => window.removeEventListener('open-notification-settings', handler);
  }, []);

  // Work group action handlers
  const handleViewWorker = useCallback((workerSessionId: string) => {
    if (activeSession) {
      setActiveSession({ serverId: activeSession.serverId, sessionId: workerSessionId });
    }
  }, [activeSession]);

  const handleSendWorkerInput = useCallback(async (workerId: string, text: string) => {
    if (!activeSession || !activeWorkGroup) return;
    await activeWorkGroups.sendWorkerInput(activeSession.serverId, activeWorkGroup.id, workerId, text);
  }, [activeSession, activeWorkGroup, activeWorkGroups]);

  const handleMergeGroup = useCallback(async () => {
    if (!activeSession || !activeWorkGroup) return;
    setMerging(true);
    await activeWorkGroups.mergeGroup(activeSession.serverId, activeWorkGroup.id);
    setMerging(false);
  }, [activeSession, activeWorkGroup, activeWorkGroups]);

  const handleCancelGroup = useCallback(async () => {
    if (!activeSession || !activeWorkGroup) return;
    await activeWorkGroups.cancelGroup(activeSession.serverId, activeWorkGroup.id);
  }, [activeSession, activeWorkGroup, activeWorkGroups]);

  const handleRetryWorker = useCallback(async (workerId: string) => {
    if (!activeSession || !activeWorkGroup) return;
    await activeWorkGroups.retryWorker(activeSession.serverId, activeWorkGroup.id, workerId);
  }, [activeSession, activeWorkGroup, activeWorkGroups]);

  const handleToggleMute = useCallback((_serverId: string, sessionId: string) => {
    sessionMute.toggleMute(sessionId);
  }, [sessionMute]);

  return (
    <div className="dashboard">
      <SessionSidebar
        summaries={summaries}
        activeSession={activeSession}
        onSelectSession={handleSelectSession}
        onSessionCreated={handleSessionCreated}
        onNotificationSettings={activeSession ? () => setShowNotifSettings(true) : undefined}
        onSettings={onSettings}
        mutedSessions={sessionMute.mutedSessions}
        onToggleMute={handleToggleMute}
        workGroups={allWorkGroups}
      />
      <main className="dashboard-main">
        <SessionView
          serverId={activeSession?.serverId ?? null}
          sessionId={activeSession?.sessionId ?? null}
          tmuxSessionName={activeSessionSummary?.tmuxSessionName}
          workGroup={isForemanView ? activeWorkGroup : undefined}
          onViewWorker={handleViewWorker}
          onSendWorkerInput={handleSendWorkerInput}
          onMergeGroup={handleMergeGroup}
          onCancelGroup={handleCancelGroup}
          onRetryWorker={handleRetryWorker}
          merging={merging}
        />
      </main>

      {showNotifSettings && activeSession && (
        <NotificationSettingsModal
          serverId={activeSession.serverId}
          onClose={() => setShowNotifSettings(false)}
        />
      )}

      {showShortcutHelp && (
        <ShortcutHelpOverlay onClose={() => setShowShortcutHelp(false)} />
      )}
    </div>
  );
}
