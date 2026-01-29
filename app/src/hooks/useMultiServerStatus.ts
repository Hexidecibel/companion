import { useState, useEffect, useRef, useCallback } from 'react';
import { Server, ServerStatus, ServerSummary } from '../types';

const POLL_INTERVAL = 5000; // 5 seconds
const CONNECTION_TIMEOUT = 10000; // 10 seconds
const MAX_CONCURRENT = 5;

interface ServerConnection {
  ws: WebSocket | null;
  authenticated: boolean;
  lastPoll: number;
}

export function useMultiServerStatus(servers: Server[]) {
  const [statuses, setStatuses] = useState<Map<string, ServerStatus>>(new Map());
  const connections = useRef<Map<string, ServerConnection>>(new Map());
  const pollTimers = useRef<Map<string, NodeJS.Timeout>>(new Map());

  // Initialize status for a server
  const initStatus = useCallback((server: Server): ServerStatus => ({
    serverId: server.id,
    serverName: server.name,
    connected: false,
    connecting: false,
    lastUpdated: Date.now(),
  }), []);

  // Update status for a specific server
  const updateStatus = useCallback((serverId: string, update: Partial<ServerStatus>) => {
    setStatuses(prev => {
      const newMap = new Map(prev);
      const current = newMap.get(serverId);
      if (current) {
        newMap.set(serverId, { ...current, ...update, lastUpdated: Date.now() });
      }
      return newMap;
    });
  }, []);

  // Connect to a server
  const connectToServer = useCallback((server: Server) => {
    const existingConn = connections.current.get(server.id);
    if (existingConn?.ws?.readyState === WebSocket.OPEN) {
      return; // Already connected
    }

    updateStatus(server.id, { connecting: true, error: undefined });

    const protocol = server.useTls ? 'wss' : 'ws';
    const url = `${protocol}://${server.host}:${server.port}`;

    try {
      const ws = new WebSocket(url);

      const timeout = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          ws.close();
          updateStatus(server.id, {
            connecting: false,
            connected: false,
            error: 'Connection timeout',
          });
        }
      }, CONNECTION_TIMEOUT);

      ws.onopen = () => {
        clearTimeout(timeout);
        // Server will send 'connected' message, then we authenticate
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);

          // Wait for 'connected' message before authenticating
          if (message.type === 'connected') {
            ws.send(JSON.stringify({
              type: 'authenticate',
              token: server.token,
            }));
            return;
          }

          if (message.type === 'authenticated' && message.success) {
            connections.current.set(server.id, {
              ws,
              authenticated: true,
              lastPoll: 0,
            });
            updateStatus(server.id, {
              connecting: false,
              connected: true,
              error: undefined,
            });
            // Start polling
            pollServer(server);
          } else if (message.type === 'server_summary' && message.success) {
            updateStatus(server.id, {
              summary: message.payload as ServerSummary,
            });
          } else if (message.type === 'error') {
            updateStatus(server.id, {
              error: message.error || 'Unknown error',
            });
          }
        } catch (err) {
          console.error('Failed to parse message:', err);
        }
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        updateStatus(server.id, {
          connecting: false,
          connected: false,
          error: 'Connection failed',
        });
      };

      ws.onclose = () => {
        clearTimeout(timeout);
        connections.current.delete(server.id);
        updateStatus(server.id, {
          connecting: false,
          connected: false,
        });
        // Clear poll timer
        const timer = pollTimers.current.get(server.id);
        if (timer) {
          clearInterval(timer);
          pollTimers.current.delete(server.id);
        }
      };

      connections.current.set(server.id, {
        ws,
        authenticated: false,
        lastPoll: 0,
      });
    } catch (err) {
      updateStatus(server.id, {
        connecting: false,
        connected: false,
        error: 'Failed to connect',
      });
    }
  }, [updateStatus]);

  // Poll a server for status
  const pollServer = useCallback((server: Server) => {
    const conn = connections.current.get(server.id);
    if (!conn?.ws || conn.ws.readyState !== WebSocket.OPEN || !conn.authenticated) {
      return;
    }

    // Send request
    conn.ws.send(JSON.stringify({
      type: 'get_server_summary',
      requestId: `poll-${Date.now()}`,
    }));
    conn.lastPoll = Date.now();

    // Set up recurring poll
    if (!pollTimers.current.has(server.id)) {
      const timer = setInterval(() => {
        const c = connections.current.get(server.id);
        if (c?.ws?.readyState === WebSocket.OPEN && c.authenticated) {
          c.ws.send(JSON.stringify({
            type: 'get_server_summary',
            requestId: `poll-${Date.now()}`,
          }));
        }
      }, POLL_INTERVAL);
      pollTimers.current.set(server.id, timer);
    }
  }, []);

  // Disconnect from a server
  const disconnectFromServer = useCallback((serverId: string) => {
    const conn = connections.current.get(serverId);
    if (conn?.ws) {
      conn.ws.close();
    }
    connections.current.delete(serverId);

    const timer = pollTimers.current.get(serverId);
    if (timer) {
      clearInterval(timer);
      pollTimers.current.delete(serverId);
    }
  }, []);

  // Connect to all servers (respecting max concurrent)
  const connectAll = useCallback(() => {
    // Initialize statuses for all servers
    setStatuses(prev => {
      const newMap = new Map(prev);
      servers.forEach(server => {
        if (!newMap.has(server.id)) {
          newMap.set(server.id, initStatus(server));
        }
      });
      return newMap;
    });

    // Connect to enabled servers only (limit concurrent connections)
    const enabledServers = servers.filter(s => s.enabled !== false);
    const toConnect = enabledServers.slice(0, MAX_CONCURRENT);
    toConnect.forEach(server => {
      connectToServer(server);
    });
  }, [servers, initStatus, connectToServer]);

  // Refresh a specific server
  const refreshServer = useCallback((serverId: string) => {
    const server = servers.find(s => s.id === serverId);
    if (server) {
      const conn = connections.current.get(serverId);
      if (conn?.ws?.readyState === WebSocket.OPEN && conn.authenticated) {
        conn.ws.send(JSON.stringify({
          type: 'get_server_summary',
          requestId: `refresh-${Date.now()}`,
        }));
      } else {
        connectToServer(server);
      }
    }
  }, [servers, connectToServer]);

  // Refresh all servers
  const refreshAll = useCallback(() => {
    servers.forEach(server => {
      refreshServer(server.id);
    });
  }, [servers, refreshServer]);

  // Effect to connect when servers change
  // Don't disconnect on unmount - connections persist so dashboard
  // loads instantly when navigating back from session view
  useEffect(() => {
    // Clean up connections for servers no longer in the list
    const currentServerIds = new Set(servers.map(s => s.id));
    connections.current.forEach((_, serverId) => {
      if (!currentServerIds.has(serverId)) {
        disconnectFromServer(serverId);
      }
    });

    connectAll();
  }, [connectAll, disconnectFromServer, servers]);

  // Get status array for easier rendering
  const statusArray = Array.from(statuses.values());

  // Computed values
  const totalWaiting = statusArray.reduce(
    (sum, s) => sum + (s.summary?.waitingCount || 0),
    0
  );
  const totalWorking = statusArray.reduce(
    (sum, s) => sum + (s.summary?.workingCount || 0),
    0
  );
  const connectedCount = statusArray.filter(s => s.connected).length;

  return {
    statuses: statusArray,
    statusMap: statuses,
    totalWaiting,
    totalWorking,
    connectedCount,
    refreshServer,
    refreshAll,
    connectToServer: (server: Server) => connectToServer(server),
    disconnectFromServer,
  };
}
