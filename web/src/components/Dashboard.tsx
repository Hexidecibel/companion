import { useState, useCallback, useMemo, useEffect, useRef, lazy, Suspense } from 'react';
import { ActiveSession, SessionSummary, WorkGroup } from '../types';
import { useAllServerSummaries } from '../hooks/useAllServerSummaries';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useConnections } from '../hooks/useConnections';
import { useWorkGroups } from '../hooks/useWorkGroups';
import { SessionSidebar } from './SessionSidebar';
import { SessionView } from './SessionView';
import { MobileDashboard } from './MobileDashboard';
import { ShortcutHelpOverlay } from './ShortcutHelpOverlay';
import { ComponentErrorBoundary } from './ComponentErrorBoundary';
import { useSessionMute } from '../hooks/useSessionMute';

const NotificationSettingsModal = lazy(() => import('./NotificationSettingsModal').then(m => ({ default: m.NotificationSettingsModal })));
const RemoteCapabilitiesPanel = lazy(() => import('./RemoteCapabilitiesPanel').then(m => ({ default: m.RemoteCapabilitiesPanel })));
import { useBrowserNotificationListener } from '../hooks/useBrowserNotificationListener';
import { initPush, registerWithAllServers } from '../services/push';
import { isTauri, isTauriDesktop, isMobileViewport } from '../utils/platform';
import { useServers } from '../hooks/useServers';
import { SIDEBAR_WIDTH_KEY, SPLIT_RATIO_KEY } from '../services/storageKeys';

interface DashboardProps {
  onSettings?: () => void;
}

export function Dashboard({ onSettings }: DashboardProps) {
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const [showNotifSettings, setShowNotifSettings] = useState(false);
  const [capabilitiesServerId, setCapabilitiesServerId] = useState<string | null>(null);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [merging, setMerging] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(isMobileViewport());
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return stored ? parseInt(stored, 10) : 280;
  });
  const draggingRef = useRef(false);
  const suppressPopstate = useRef(false);
  const [secondarySession, setSecondarySession] = useState<ActiveSession | null>(null);
  const [splitRatio, setSplitRatio] = useState(() => {
    const stored = localStorage.getItem(SPLIT_RATIO_KEY);
    return stored ? parseFloat(stored) : 50;
  });
  const [splitDragging, setSplitDragging] = useState(false);
  const [splitPreviewRatio, setSplitPreviewRatio] = useState<number | null>(null);
  const splitContainerRef = useRef<HTMLElement | null>(null);
  const summaries = useAllServerSummaries();
  const sessionMute = useSessionMute(activeSession?.serverId ?? null);
  const { snapshots } = useConnections();
  const { isParallelWorkersEnabled } = useServers();

  // Use work groups for the active server (only if enabled and git is available)
  const gitEnabled = activeSession
    ? (snapshots.find(s => s.serverId === activeSession.serverId)?.gitEnabled ?? true)
    : true;
  const workersEnabled = gitEnabled && (activeSession ? isParallelWorkersEnabled(activeSession.serverId) : true);
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

  // Jump number map: sessionId -> 1-based index (max 9) for Ctrl+Alt badge display
  const jumpNumberMap = useMemo(() => {
    const map = new Map<string, number>();
    for (let i = 0; i < Math.min(flatSessions.length, 9); i++) {
      map.set(flatSessions[i].sessionId, i + 1);
    }
    return map;
  }, [flatSessions]);

  // Track Ctrl+Alt held state for showing jump number badges
  const [showJumpNumbers, setShowJumpNumbers] = useState(false);

  useEffect(() => {
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && e.altKey) setShowJumpNumbers(true);
    };
    const handleKeyUp = () => {
      setShowJumpNumbers(false);
    };
    const handleBlur = () => setShowJumpNumbers(false);
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, []);

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
    if (isMobile) {
      setSidebarOpen(false);
      // Push history so Android back gesture returns to dashboard.
      // We always push here so the popstate handler has an entry to pop.
      history.pushState({ session: true }, '');
    }
  }, [isMobile]);

  // Ensure the base history entry has the 'base' flag on mobile so the popstate
  // handler recognizes it as the floor. App.tsx sets { screen, base } on mount;
  // this is a fallback in case it was overwritten.
  useEffect(() => {
    if (!isMobile) return;
    if (!history.state?.base) {
      history.replaceState({ ...history.state, base: true }, '');
    }
  }, [isMobile]);

  // Handle popstate (Android back gesture) — close overlays first, then deselect session
  useEffect(() => {
    if (!isMobile) return;
    const handler = (_e: PopStateEvent) => {
      // If the popstate was triggered programmatically (e.g. handleMobileBack),
      // skip handling since the caller already managed the state transition.
      if (suppressPopstate.current) {
        suppressPopstate.current = false;
        return;
      }

      if (showNotifSettings) {
        // Close notification settings modal first
        setShowNotifSettings(false);
        history.pushState({ session: true }, '');
      } else if (document.body.dataset.overlay === 'true') {
        // An overlay panel (terminal, work group) is open — close it first
        window.dispatchEvent(new CustomEvent('close-overlay'));
        // Re-push so the next back still has an entry to pop
        if (activeSession) {
          history.pushState({ session: true }, '');
        } else {
          history.pushState({ base: true }, '');
        }
      } else if (activeSession) {
        setActiveSession(null);
        // Re-push base entry so next back on dashboard doesn't exit the app
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
    { key: '[', meta: true, alt: true, handler: () => navigateSession(-1) },
    { key: ']', meta: true, alt: true, handler: () => navigateSession(1) },
    { key: '1', meta: true, alt: true, handler: () => selectSessionByIndex(0) },
    { key: '2', meta: true, alt: true, handler: () => selectSessionByIndex(1) },
    { key: '3', meta: true, alt: true, handler: () => selectSessionByIndex(2) },
    { key: '4', meta: true, alt: true, handler: () => selectSessionByIndex(3) },
    { key: '5', meta: true, alt: true, handler: () => selectSessionByIndex(4) },
    { key: '6', meta: true, alt: true, handler: () => selectSessionByIndex(5) },
    { key: '7', meta: true, alt: true, handler: () => selectSessionByIndex(6) },
    { key: '8', meta: true, alt: true, handler: () => selectSessionByIndex(7) },
    { key: '9', meta: true, alt: true, handler: () => selectSessionByIndex(8) },
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

  const handleOpenCostDashboard = useCallback(() => {
    if (activeSession) {
      window.dispatchEvent(new CustomEvent('open-cost-dashboard', { detail: { serverId: activeSession.serverId } }));
    }
  }, [activeSession]);

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

  const handleMobileBack = useCallback(() => {
    setActiveSession(null);
    if (isMobile && history.state?.session) {
      // There's a session entry on the stack — pop it via history.back().
      // Suppress the popstate handler so we don't double-handle.
      suppressPopstate.current = true;
      history.back();
    }
  }, [isMobile]);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return;
      const newWidth = Math.min(Math.max(ev.clientX, 180), 600);
      setSidebarWidth(newWidth);
    };

    const onMouseUp = (ev: MouseEvent) => {
      draggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      const finalWidth = Math.min(Math.max(ev.clientX, 180), 600);
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(finalWidth));
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  const handleSplitDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setSplitDragging(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const container = splitContainerRef.current;
    if (!container) return;

    const onMouseMove = (ev: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const ratio = ((ev.clientX - rect.left) / rect.width) * 100;
      const clamped = Math.min(Math.max(ratio, 20), 80);
      setSplitPreviewRatio(clamped);
    };

    const onMouseUp = (ev: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      let ratio = ((ev.clientX - rect.left) / rect.width) * 100;
      ratio = Math.min(Math.max(ratio, 20), 80);

      // Snap to nearest snap point if within threshold
      const snapPoints = [33, 50, 67];
      const threshold = 8;
      for (const snap of snapPoints) {
        if (Math.abs(ratio - snap) < threshold) {
          ratio = snap;
          break;
        }
      }

      setSplitRatio(ratio);
      setSplitPreviewRatio(null);
      setSplitDragging(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem(SPLIT_RATIO_KEY, String(ratio));
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  const handleOpenInSplit = useCallback((serverId: string, sessionId: string) => {
    setSecondarySession({ serverId, sessionId });
  }, []);

  const handleCloseSplit = useCallback(() => {
    setSecondarySession(null);
  }, []);

  // --- Mobile layout: MobileDashboard or full-screen SessionView ---
  if (isMobile) {
    if (activeSession) {
      return (
        <div className="dashboard">
          <main className="dashboard-main" style={{ width: '100%' }}>
            <ComponentErrorBoundary name="SessionView">
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
            </ComponentErrorBoundary>
          </main>

          {showNotifSettings && (
            <Suspense fallback={null}>
              <NotificationSettingsModal
                serverId={activeSession.serverId}
                onClose={() => setShowNotifSettings(false)}
              />
            </Suspense>
          )}
        </div>
      );
    }

    return (
      <>
        <MobileDashboard
          summaries={summaries}
          activeSession={activeSession}
          onSelectSession={handleSelectSession}
          onSessionCreated={handleSessionCreated}
          onSettings={onSettings}
          onCostDashboard={(serverId: string) => window.dispatchEvent(new CustomEvent('open-cost-dashboard', { detail: { serverId } }))}
          onRemoteCapabilities={(serverId: string) => setCapabilitiesServerId(serverId)}
          onOpenInSplit={handleOpenInSplit}
          onCloseSplit={handleCloseSplit}
          secondarySession={secondarySession}
        />
        {capabilitiesServerId && (
          <Suspense fallback={null}>
            <RemoteCapabilitiesPanel
              serverId={capabilitiesServerId}
              serverName={snapshots.find(s => s.serverId === capabilitiesServerId)?.serverName ?? 'Server'}
              onClose={() => setCapabilitiesServerId(null)}
            />
          </Suspense>
        )}
      </>
    );
  }

  // --- Desktop layout: Sidebar + SessionView ---
  return (
    <div className="dashboard">
      <div
        className={`sidebar-backdrop${sidebarOpen ? ' visible' : ''}`}
        onClick={() => setSidebarOpen(false)}
      />
      <ComponentErrorBoundary name="SessionSidebar">
        <SessionSidebar
          summaries={summaries}
          activeSession={activeSession}
          onSelectSession={handleSelectSession}
          onSessionCreated={handleSessionCreated}
          onOpenInSplit={handleOpenInSplit}
          onCloseSplit={handleCloseSplit}
          secondarySession={secondarySession}
          onNotificationSettings={activeSession ? () => setShowNotifSettings(true) : undefined}
          onCostDashboard={activeSession ? handleOpenCostDashboard : undefined}
          onSettings={onSettings}
          onRemoteCapabilities={(serverId) => setCapabilitiesServerId(serverId)}
          mutedSessions={sessionMute.mutedSessions}
          onToggleMute={handleToggleMute}
          workGroups={allWorkGroups}
          mobileOpen={sidebarOpen}
          showJumpNumbers={showJumpNumbers}
          jumpNumberMap={jumpNumberMap}
          style={{ width: sidebarWidth }}
        />
      </ComponentErrorBoundary>
      <div className="sidebar-drag-handle" onMouseDown={handleDragStart} />
      <main
        className={`dashboard-main${secondarySession ? ' split-enabled' : ''}`}
        ref={splitContainerRef as React.RefObject<HTMLElement>}
      >
        <ComponentErrorBoundary name="SessionView">
          <SessionView
            serverId={activeSession?.serverId ?? null}
            sessionId={activeSession?.sessionId ?? null}
            tmuxSessionName={activeSessionSummary?.tmuxSessionName}
            projectPath={activeSessionSummary?.projectPath}
            workGroup={isForemanView ? activeWorkGroup : undefined}
            onViewWorker={handleViewWorker}
            onSendWorkerInput={handleSendWorkerInput}
            onMergeGroup={handleMergeGroup}
            onCancelGroup={handleCancelGroup}
            onRetryWorker={handleRetryWorker}
            onDismissGroup={handleDismissGroup}
            merging={merging}
            onToggleSidebar={toggleSidebar}
            style={secondarySession ? { flex: `0 0 ${splitPreviewRatio ?? splitRatio}%` } : undefined}
          />
        </ComponentErrorBoundary>
        {secondarySession && (
          <>
            <div
              className={`split-divider-area${splitDragging ? ' dragging' : ''}`}
              onMouseDown={handleSplitDragStart}
            >
              <div className="split-divider-line" />
              <button
                className="split-close-btn"
                onClick={handleCloseSplit}
                title="Close split view"
              >
                &#x2715;
              </button>
            </div>
            {splitDragging && (
              <div className="split-snap-indicators">
                {[33, 50, 67].map(pos => (
                  <div
                    key={pos}
                    className={`split-snap-line${Math.abs((splitPreviewRatio ?? splitRatio) - pos) < 8 ? ' active' : ''}`}
                    style={{ left: `${pos}%` }}
                  />
                ))}
              </div>
            )}
            <ComponentErrorBoundary name="SessionView (split)">
              <SessionView
                serverId={secondarySession.serverId}
                sessionId={secondarySession.sessionId}
                tmuxSessionName={(() => {
                  const ss = summaries.get(secondarySession.serverId);
                  return ss?.sessions.find(s => s.id === secondarySession.sessionId)?.tmuxSessionName;
                })()}
                projectPath={(() => {
                  const ss = summaries.get(secondarySession.serverId);
                  return ss?.sessions.find(s => s.id === secondarySession.sessionId)?.projectPath;
                })()}
                style={{ flex: `0 0 ${100 - (splitPreviewRatio ?? splitRatio)}%` }}
              />
            </ComponentErrorBoundary>
          </>
        )}
      </main>

      {showNotifSettings && activeSession && (
        <Suspense fallback={null}>
          <NotificationSettingsModal
            serverId={activeSession.serverId}
            onClose={() => setShowNotifSettings(false)}
          />
        </Suspense>
      )}

      {capabilitiesServerId && (
        <Suspense fallback={null}>
          <RemoteCapabilitiesPanel
            serverId={capabilitiesServerId}
            serverName={snapshots.find(s => s.serverId === capabilitiesServerId)?.serverName ?? 'Server'}
            onClose={() => setCapabilitiesServerId(null)}
          />
        </Suspense>
      )}

      {showShortcutHelp && (
        <ShortcutHelpOverlay onClose={() => setShowShortcutHelp(false)} />
      )}
    </div>
  );
}
