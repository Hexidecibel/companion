import { useState, useCallback } from 'react';
import { TmuxSessionInfo } from '../types';
import { connectionManager } from '../services/ConnectionManager';

interface UseTmuxSessionsReturn {
  sessions: TmuxSessionInfo[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  killSession: (sessionName: string) => Promise<boolean>;
  createSession: (dir: string, startCli: boolean) => Promise<boolean>;
}

export function useTmuxSessions(serverId: string | null): UseTmuxSessionsReturn {
  const [sessions, setSessions] = useState<TmuxSessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!serverId) return;
    const conn = connectionManager.getConnection(serverId);
    if (!conn || !conn.isConnected()) return;

    setLoading(true);
    setError(null);
    try {
      const response = await conn.sendRequest('list_tmux_sessions');
      if (response.success && response.payload) {
        const payload = response.payload as { sessions: TmuxSessionInfo[] };
        setSessions(payload.sessions ?? []);
      } else {
        setError(response.error ?? 'Failed to list tmux sessions');
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  const killSession = useCallback(async (sessionName: string): Promise<boolean> => {
    if (!serverId) return false;
    const conn = connectionManager.getConnection(serverId);
    if (!conn || !conn.isConnected()) return false;

    try {
      const response = await conn.sendRequest('kill_tmux_session', { sessionName });
      if (response.success) {
        setSessions((prev) => prev.filter((s) => s.name !== sessionName));
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, [serverId]);

  const createSession = useCallback(async (dir: string, startCli: boolean): Promise<boolean> => {
    if (!serverId) return false;
    const conn = connectionManager.getConnection(serverId);
    if (!conn || !conn.isConnected()) return false;

    try {
      const response = await conn.sendRequest('create_tmux_session', { dir, startCli });
      if (response.success) {
        await refresh();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, [serverId, refresh]);

  return { sessions, loading, error, refresh, killSession, createSession };
}
