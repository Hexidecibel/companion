import { useState, useEffect, useCallback, useRef } from 'react';
import { Server, ServerStatus, ServerSummary } from '../types';
import { connectionManager } from '../services/connectionManager';

const POLL_INTERVAL = 5000;

// Module-level cache: survives component unmount/remount so we don't lose
// state on re-navigation
const cachedSummaries = new Map<string, ServerSummary>();
const cachedStatuses = new Map<string, ServerStatus>();

export function useMultiServerStatus(servers: Server[]) {
  const [statusMap, setStatusMap] = useState<Map<string, ServerStatus>>(cachedStatuses);
  const pollTimers = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());

  const pollSummary = useCallback((serverId: string) => {
    const conn = connectionManager.getConnection(serverId);
    if (!conn?.isConnected()) return;

    conn
      .sendRequest('get_server_summary', undefined, 10000)
      .then((response) => {
        if (response.success && response.payload) {
          const summary = response.payload as ServerSummary;
          cachedSummaries.set(serverId, summary);
          setStatusMap((prev) => {
            const next = new Map(prev);
            const existing = next.get(serverId);
            if (existing) {
              const updated = { ...existing, summary, lastUpdated: Date.now() };
              next.set(serverId, updated);
              cachedStatuses.set(serverId, updated);
            }
            return next;
          });
        }
      })
      .catch(() => {
        /* silent fail on poll */
      });
  }, []);

  const startPolling = useCallback(
    (serverId: string) => {
      // Clear existing timer for this server
      const existing = pollTimers.current.get(serverId);
      if (existing) clearInterval(existing);

      const timer = setInterval(() => pollSummary(serverId), POLL_INTERVAL);
      pollTimers.current.set(serverId, timer);
    },
    [pollSummary]
  );

  const stopPolling = useCallback((serverId: string) => {
    const timer = pollTimers.current.get(serverId);
    if (timer) {
      clearInterval(timer);
      pollTimers.current.delete(serverId);
    }
  }, []);

  // Sync servers with ConnectionManager and track states
  useEffect(() => {
    connectionManager.syncServers(servers);

    const enabledServers = servers.filter((s) => s.enabled !== false);

    // Initialize status for all enabled servers
    setStatusMap((prev) => {
      const next = new Map(prev);

      // Remove statuses for servers no longer enabled
      for (const id of next.keys()) {
        if (!enabledServers.find((s) => s.id === id)) {
          next.delete(id);
          cachedStatuses.delete(id);
          cachedSummaries.delete(id);
        }
      }

      // Add statuses for new servers
      for (const server of enabledServers) {
        if (!next.has(server.id)) {
          const conn = connectionManager.getConnection(server.id);
          const state = conn?.getState();
          const connected = state?.status === 'connected';
          const connecting =
            state?.status === 'connecting' || state?.status === 'reconnecting';
          const initial: ServerStatus = {
            serverId: server.id,
            serverName: server.name,
            connected,
            connecting: connecting || (!connected && !state?.error),
            error: state?.error,
            summary: cachedSummaries.get(server.id),
            lastUpdated: Date.now(),
          };
          next.set(server.id, initial);
          cachedStatuses.set(server.id, initial);
        }
      }

      return next;
    });

    // Listen for state changes from all connections
    const unsubscribe = connectionManager.onStateChange((serverId, state) => {
      const server = servers.find((s) => s.id === serverId);
      if (!server) return;

      const connected = state.status === 'connected';
      const connecting =
        state.status === 'connecting' || state.status === 'reconnecting';

      setStatusMap((prev) => {
        const next = new Map(prev);
        const existing = next.get(serverId);
        const updated: ServerStatus = {
          serverId,
          serverName: server.name,
          connected,
          connecting,
          error: state.error,
          summary: existing?.summary || cachedSummaries.get(serverId),
          lastUpdated: Date.now(),
        };
        next.set(serverId, updated);
        cachedStatuses.set(serverId, updated);
        return next;
      });

      // When connected, immediately poll and start recurring poll
      if (connected) {
        pollSummary(serverId);
        startPolling(serverId);
      } else {
        stopPolling(serverId);
      }
    });

    // For servers already connected, poll now and start recurring
    for (const server of enabledServers) {
      const conn = connectionManager.getConnection(server.id);
      if (conn?.isConnected()) {
        pollSummary(server.id);
        startPolling(server.id);
      }
    }

    return () => {
      unsubscribe();
      for (const timer of pollTimers.current.values()) {
        clearInterval(timer);
      }
      pollTimers.current.clear();
    };
  }, [servers, pollSummary, startPolling, stopPolling]);

  const refreshServer = useCallback(
    (serverId: string) => {
      pollSummary(serverId);
    },
    [pollSummary]
  );

  const refreshAll = useCallback(() => {
    for (const serverId of statusMap.keys()) {
      pollSummary(serverId);
    }
  }, [statusMap, pollSummary]);

  const sendRequest = useCallback(
    (serverId: string, type: string, payload?: unknown): Promise<any> => {
      const conn = connectionManager.getConnection(serverId);
      if (!conn) return Promise.reject(new Error('No connection for server'));
      return conn.sendRequest(type, payload);
    },
    []
  );

  // Compute aggregates
  const statuses = Array.from(statusMap.values());
  const totalWaiting = statuses.reduce(
    (sum, s) => sum + (s.summary?.waitingCount || 0),
    0
  );
  const totalWorking = statuses.reduce(
    (sum, s) => sum + (s.summary?.workingCount || 0),
    0
  );
  const connectedCount = statuses.filter((s) => s.connected).length;

  return {
    statuses,
    statusMap,
    totalWaiting,
    totalWorking,
    connectedCount,
    refreshServer,
    refreshAll,
    sendRequest,
    connectToServer: (s: Server) => connectionManager.addConnection(s),
    disconnectFromServer: (serverId: string) => {
      const conn = connectionManager.getConnection(serverId);
      if (conn) conn.disconnect();
    },
  };
}
