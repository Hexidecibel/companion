import { useState, useEffect, useCallback, useRef } from 'react';
import { Server, ServerStatus, ServerSummary } from '../types';
import { wsService } from '../services/websocket';

const POLL_INTERVAL = 5000; // 5 seconds

// Module-level cache: survives component unmount/remount
let cachedSummary: ServerSummary | undefined;
let cachedConnected = false;

export function useMultiServerStatus(servers: Server[]) {
  // Use the first enabled server - don't connect to disabled servers
  const server = servers.find((s) => s.enabled !== false) || null;

  const makeStatus = useCallback(
    (connected: boolean, connecting: boolean, error?: string): ServerStatus => ({
      serverId: server?.id || '',
      serverName: server?.name || '',
      connected,
      connecting,
      error,
      summary: cachedSummary,
      lastUpdated: Date.now(),
    }),
    [server?.id, server?.name]
  );

  const [status, setStatus] = useState<ServerStatus>(() => makeStatus(cachedConnected, false));

  const pollTimer = useRef<NodeJS.Timeout | null>(null);

  // Poll for server summary
  const pollSummary = useCallback(() => {
    if (!wsService.isConnected()) return;

    wsService
      .sendRequest('get_server_summary', undefined, 10000)
      .then((response) => {
        if (response.success && response.payload) {
          cachedSummary = response.payload as ServerSummary;
          setStatus((prev) => ({ ...prev, summary: cachedSummary, lastUpdated: Date.now() }));
        }
      })
      .catch(() => {
        /* silent fail on poll */
      });
  }, []);

  // Single effect: connect, track state, and poll
  useEffect(() => {
    if (!server) {
      // All servers disabled - disconnect if connected
      if (wsService.isConnected()) {
        wsService.disconnect();
      }
      cachedConnected = false;
      cachedSummary = undefined;
      return;
    }

    // Connect if needed
    if (wsService.getServerId() !== server.id || !wsService.isConnected()) {
      wsService.connect(server);
    }

    // Track connection state
    const unsubscribe = wsService.onStateChange((state) => {
      const connected = state.status === 'connected';
      const connecting = state.status === 'connecting' || state.status === 'reconnecting';
      cachedConnected = connected;

      setStatus({
        serverId: server.id,
        serverName: server.name,
        connected,
        connecting,
        error: state.error,
        summary: cachedSummary,
        lastUpdated: Date.now(),
      });

      // When we become connected, immediately poll for summary
      if (connected) {
        pollSummary();
      }
    });

    // If already connected, poll now
    if (wsService.isConnected()) {
      pollSummary();
    }

    // Set up recurring poll
    const timer = setInterval(pollSummary, POLL_INTERVAL);
    pollTimer.current = timer;

    return () => {
      unsubscribe();
      clearInterval(timer);
      pollTimer.current = null;
      // Do NOT disconnect wsService - it persists across screens
    };
  }, [server?.id, server?.name, pollSummary]);

  // Refresh
  const refreshServer = useCallback(
    (_serverId: string) => {
      pollSummary();
    },
    [pollSummary]
  );

  const refreshAll = useCallback(() => {
    pollSummary();
  }, [pollSummary]);

  // Send a request through wsService
  const sendRequest = useCallback(
    (_serverId: string, type: string, payload?: unknown): Promise<any> => {
      return wsService.sendRequest(type, payload);
    },
    []
  );

  const statusArray = server ? [status] : [];
  const totalWaiting = status.summary?.waitingCount || 0;
  const totalWorking = status.summary?.workingCount || 0;
  const connectedCount = status.connected ? 1 : 0;

  return {
    statuses: statusArray,
    statusMap: new Map(server ? [[server.id, status]] : []),
    totalWaiting,
    totalWorking,
    connectedCount,
    refreshServer,
    refreshAll,
    sendRequest,
    connectToServer: (s: Server) => wsService.connect(s),
    disconnectFromServer: (_serverId: string) => wsService.disconnect(),
  };
}
