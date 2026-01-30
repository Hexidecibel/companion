import { useState, useCallback, useMemo } from 'react';
import { ActiveSession } from '../types';
import { useAllServerSummaries } from '../hooks/useAllServerSummaries';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useConnections } from '../hooks/useConnections';
import { SessionSidebar } from './SessionSidebar';
import { SessionView } from './SessionView';

interface DashboardProps {
  onManageServers: () => void;
}

export function Dashboard({ onManageServers }: DashboardProps) {
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const summaries = useAllServerSummaries();
  const { snapshots } = useConnections();

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

  // Keyboard shortcuts
  const shortcuts = useMemo(() => [
    {
      key: 'j',
      handler: () => navigateSession(1),
    },
    {
      key: 'ArrowDown',
      handler: () => navigateSession(1),
    },
    {
      key: 'k',
      handler: () => navigateSession(-1),
    },
    {
      key: 'ArrowUp',
      handler: () => navigateSession(-1),
    },
    {
      key: '/',
      handler: () => {
        const textarea = document.querySelector('.input-bar-textarea') as HTMLElement | null;
        textarea?.focus();
      },
    },
  ], [navigateSession]);

  useKeyboardShortcuts(shortcuts);

  return (
    <div className="dashboard">
      <SessionSidebar
        summaries={summaries}
        activeSession={activeSession}
        onSelectSession={handleSelectSession}
        onManageServers={onManageServers}
        onSessionCreated={handleSessionCreated}
      />
      <main className="dashboard-main">
        <SessionView
          serverId={activeSession?.serverId ?? null}
          sessionId={activeSession?.sessionId ?? null}
        />
      </main>
    </div>
  );
}
