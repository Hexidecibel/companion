import { useState, useEffect, useCallback } from 'react';
import { connectionManager } from '../services/ConnectionManager';

interface UseSessionMuteReturn {
  mutedSessions: Set<string>;
  isMuted: (sessionId: string) => boolean;
  toggleMute: (sessionId: string) => Promise<void>;
}

export function useSessionMute(serverId: string | null): UseSessionMuteReturn {
  const [mutedSessions, setMutedSessions] = useState<Set<string>>(new Set());

  // Fetch muted sessions on mount
  useEffect(() => {
    if (!serverId) return;
    const conn = connectionManager.getConnection(serverId);
    if (!conn || !conn.isConnected()) return;

    conn.sendRequest('get_muted_sessions').then((response) => {
      if (response.success && response.payload) {
        const payload = response.payload as { sessionIds: string[] };
        setMutedSessions(new Set(payload.sessionIds ?? []));
      }
    });

    // Listen for mute changes broadcast from other clients
    const unsubscribe = conn.onMessage((msg) => {
      if (msg.type === 'session_mute_changed' && msg.payload) {
        const payload = msg.payload as { sessionId: string; muted: boolean };
        setMutedSessions(prev => {
          const next = new Set(prev);
          if (payload.muted) {
            next.add(payload.sessionId);
          } else {
            next.delete(payload.sessionId);
          }
          return next;
        });
      }
    });

    return unsubscribe;
  }, [serverId]);

  const isMuted = useCallback((sessionId: string) => {
    return mutedSessions.has(sessionId);
  }, [mutedSessions]);

  const toggleMute = useCallback(async (sessionId: string) => {
    if (!serverId) return;
    const conn = connectionManager.getConnection(serverId);
    if (!conn || !conn.isConnected()) return;

    const currentlyMuted = mutedSessions.has(sessionId);
    const newMuted = !currentlyMuted;

    // Optimistic update
    setMutedSessions(prev => {
      const next = new Set(prev);
      if (newMuted) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });

    const response = await conn.sendRequest('set_session_muted', {
      sessionId,
      muted: newMuted,
    });

    if (!response.success) {
      // Revert on failure
      setMutedSessions(prev => {
        const next = new Set(prev);
        if (currentlyMuted) next.add(sessionId);
        else next.delete(sessionId);
        return next;
      });
    }
  }, [serverId, mutedSessions]);

  return { mutedSessions, isMuted, toggleMute };
}
