import { useState, useCallback, useMemo, useEffect } from 'react';
import { ActiveSession, SessionSummary, WorkGroup } from '../types';
import { useAllServerSummaries } from '../hooks/useAllServerSummaries';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useConnections } from '../hooks/useConnections';
import { useWorkGroups } from '../hooks/useWorkGroups';
import { SessionSidebar } from './SessionSidebar';
import { SessionView } from './SessionView';
import { MobileDashboard } from './MobileDashboard';
import { ShortcutHelpOverlay } from './ShortcutHelpOverlay';
import { NotificationSettingsModal } from './NotificationSettingsModal';
import { useSessionMute } from '../hooks/useSessionMute';
import { useBrowserNotificationListener } from '../hooks/useBrowserNotificationListener';
import { initPush, registerWithAllServers } from '../services/push';
import { isTauri, isTauriDesktop, isMobileViewport } from '../utils/platform';
import { useServers } from '../hooks/useServers';

interface DashboardProps {
  onSettings?: () => void;
}

export function Dashboard({ onSettings }: DashboardProps) {
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const [showNotifSettings, setShowNotifSettings] = useState(false);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [merging, setMerging] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(isMobileViewport());
  const summaries = useAllServerSummaries();
  const sessionMute = useSessionMute(activeSession?.serverId ?? null);
  const { snapshots } = useConnections();
  const { isParallelWorkersEnabled } = useServers();

  // Use work groups for the active server (only if enabled)
  const workersEnabled = activeSession ? isParallelWorkersEnabled(activeSession.serverId) : true;
  const activeWorkGroups = useWorkGroups(activeSession?.serverId ?? null);

  // Browser notification listener - listens on ALL connected servers
  useBrowserNotificationListener();

  // Initialize push notifications on mobile (request permission, register FCM token)
  useEffect(() => {
    initPush();
  }, []);

  // Re-register push token when connections change (new server connected)
  useEffect(() => {
    const connected = snapshots.filter(s => s.state.status === 'connected');
    if (connected.length > 0) {
      registerWithAllServers();
    }
  }, [snapshots]);

  // Track viewport width for mobile/desktop layout switching
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Tauri menu event handler
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlisten = await listen<string>('menu-event', (event) => {
          switch (event.payload) {
            case 'reload':
              window.location.reload();
              break;
            case 'toggle-sidebar':
              setSidebarOpen(prev => !prev);
              break;
            case 'zoom-in':
              document.documentElement.style.fontSize =
                (parseFloat(getComputedStyle(document.documentElement).fontSize) + 1) + 'px';
              break;
            case 'zoom-out':
              document.documentElement.style.fontSize =
                Math.max(10, parseFloat(getComputedStyle(document.documentElement).fontSize) - 1) + 'px';
              break;
            case 'zoom-reset':
              document.documentElement.style.fontSize = '';
              break;
            case 'new-session':
              // Focus the input bar — same as '/' shortcut
              (document.querySelector('.input-bar-textarea') as HTMLElement | null)?.focus();
              break;
            case 'fullscreen': {
              if (document.fullscreenElement) {
                document.exitFullscreen();
              } else {
                document.documentElement.requestFullscreen();
              }
              break;
            }
          }
        });
      } catch {
        // Not in Tauri
      }
    })();
    return () => { unlisten?.(); };
  }, []);

  // Update tray tooltip with waiting session count (desktop only)
  useEffect(() => {
    if (!isTauriDesktop()) return;
    const waitingCount = Array.from(summaries.values()).reduce((count, serverSummary) => {
      return count + serverSummary.sessions.filter(s => s.status === 'waiting').length;
    }, 0);
    const tooltip = waitingCount > 0
      ? `Companion - ${waitingCount} session${waitingCount > 1 ? 's' : ''} waiting`
      : 'Companion';
    (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('set_tray_tooltip', { tooltip });
      } catch {
        // Not in Tauri
      }
    })();
  }, [summaries]);

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

  // Is the active session a foreman of the work group? (only show if workers enabled)
  const isForemanView = workersEnabled && activeWorkGroup?.foremanSessionId === activeSession?.sessionId;

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
    if (isMobileViewport()) {
      setSidebarOpen(false);
      // Push history so Android back gesture returns to dashboard
      history.pushState({ session: true }, '');
    }
  }, []);

  // Push a base history entry on mobile so back from dashboard doesn't exit the app
  useEffect(() => {
    if (!isMobile) return;
    if (!history.state?.base) {
      history.replaceState({ base: true }, '');
    }
  }, [isMobile]);

  // Handle popstate (Android back gesture) — close overlays first, then deselect session
  useEffect(() => {
    if (!isMobile) return;
    const handler = (_e: PopStateEvent) => {
      if (showNotifSettings) {
        // Close notification settings modal first
        setShowNotifSettings(false);
        history.pushState({ session: true }, '');
      } else if (document.body.dataset.overlay === 'true') {
        // An overlay panel (terminal, work group) is open — close it first
        window.dispatchEvent(new CustomEvent('close-overlay'));
        history.pushState({ session: true }, '');
      } else if (activeSession) {
        setActiveSession(null);
        // Re-push base entry so next back doesn't exit
        history.pushState({ base: true }, '');
      } else {
        // On dashboard with nowhere to go — re-push to prevent app exit
        history.pushState({ base: true }, '');
      }
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, [isMobile, activeSession, showNotifSettings]);

  const handleSessionCreated = useCallback((_serverId: string, sessionName: string) => {
    // If sessionName is empty, the JSONL UUID isn't known yet (session was just created).
    // Clear active session so the UI doesn't try to load a non-existent session.
    // The new session will appear in the server summary once the CLI creates its JSONL file.
    if (!sessionName) {
      setActiveSession(null);
    } else {
      setActiveSession({ serverId: _serverId, sessionId: sessionName });
    }
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

  // Auto-switch if active session no longer exists in summaries
  // (e.g., stale session replaced by a newer one on the daemon)
  useEffect(() => {
    if (!activeSession) return;
    const serverSummary = summaries.get(activeSession.serverId);
    if (!serverSummary) return;
    const stillExists = serverSummary.sessions.some((s) => s.id === activeSession.sessionId);
    if (!stillExists && flatSessions.length > 0) {
      setActiveSession(flatSessions[0]);
    }
  }, [activeSession, summaries, flatSessions]);

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

  const handleDismissGroup = useCallback(async () => {
    if (!activeSession || !activeWorkGroup) return;
    await activeWorkGroups.dismissGroup(activeSession.serverId, activeWorkGroup.id);
  }, [activeSession, activeWorkGroup, activeWorkGroups]);

  const handleToggleMute = useCallback((_serverId: string, sessionId: string) => {
    sessionMute.toggleMute(sessionId);
  }, [sessionMute]);

  const toggleSidebar = useCallback(() => setSidebarOpen(prev => !prev), []);
  const handleMobileBack = useCallback(() => setActiveSession(null), []);

  // --- Mobile layout: MobileDashboard or full-screen SessionView ---
  if (isMobile) {
    if (activeSession) {
      return (
        <div className="dashboard">
          <main className="dashboard-main" style={{ width: '100%' }}>
            <SessionView
              serverId={activeSession.serverId}
              sessionId={activeSession.sessionId}
              tmuxSessionName={activeSessionSummary?.tmuxSessionName}
              workGroup={isForemanView ? activeWorkGroup : undefined}
              onViewWorker={handleViewWorker}
              onSendWorkerInput={handleSendWorkerInput}
              onMergeGroup={handleMergeGroup}
              onCancelGroup={handleCancelGroup}
              onRetryWorker={handleRetryWorker}
              onDismissGroup={handleDismissGroup}
              merging={merging}
              onToggleSidebar={handleMobileBack}
            />
          </main>

          {showNotifSettings && (
            <NotificationSettingsModal
              serverId={activeSession.serverId}
              onClose={() => setShowNotifSettings(false)}
            />
          )}
        </div>
      );
    }

    return (
      <MobileDashboard
        summaries={summaries}
        activeSession={activeSession}
        onSelectSession={handleSelectSession}
        onSessionCreated={handleSessionCreated}
        onSettings={onSettings}
      />
    );
  }

  // --- Desktop layout: Sidebar + SessionView ---
  return (
    <div className="dashboard">
      <div
        className={`sidebar-backdrop${sidebarOpen ? ' visible' : ''}`}
        onClick={() => setSidebarOpen(false)}
      />
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
        mobileOpen={sidebarOpen}
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
          onDismissGroup={handleDismissGroup}
          merging={merging}
          onToggleSidebar={toggleSidebar}
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
