import { useState, useCallback } from 'react';
import { ActiveSession } from '../types';
import { useAllServerSummaries } from '../hooks/useAllServerSummaries';
import { SessionSidebar } from './SessionSidebar';
import { SessionView } from './SessionView';

interface DashboardProps {
  onManageServers: () => void;
}

export function Dashboard({ onManageServers }: DashboardProps) {
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const summaries = useAllServerSummaries();

  const handleSelectSession = useCallback((serverId: string, sessionId: string) => {
    setActiveSession({ serverId, sessionId });
  }, []);

  const handleSessionCreated = useCallback((_serverId: string, sessionName: string) => {
    // The sidebar polls every 5s and will pick up the new session.
    // We optimistically set activeSession so the UI feels immediate.
    setActiveSession({ serverId: _serverId, sessionId: sessionName });
  }, []);

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
