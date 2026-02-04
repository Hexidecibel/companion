import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import { Server } from '../types';
import { connectionManager, ConnectionSnapshot } from '../services/ConnectionManager';
import { getServers, addServer as storageAddServer, updateServer as storageUpdateServer, deleteServer as storageDeleteServer } from '../services/storage';

const LOCAL_SERVER_ID = '__local__';

/**
 * Check URL hash for a token (e.g. /web#token=xxx) and auto-create a server
 * entry using the current browser location. This lets the setup page at /
 * link directly to the web client with zero manual config.
 */
function autoDetectLocalServer(existingServers: Server[]): Server | null {
  const hash = window.location.hash; // e.g. "#token=abc123"
  if (!hash.startsWith('#token=')) return null;

  const token = decodeURIComponent(hash.slice('#token='.length));
  if (!token) return null;

  // Clear the token from the URL so it's not visible/bookmarkable
  history.replaceState(null, '', window.location.pathname + window.location.search);

  const host = window.location.hostname;
  const port = parseInt(window.location.port, 10) || (window.location.protocol === 'https:' ? 443 : 80);
  const useTls = window.location.protocol === 'https:';

  // Check if we already have a server for this host:port - update its token
  const existing = existingServers.find(
    (s) => s.host === host && s.port === port,
  );
  if (existing) {
    return { ...existing, token, enabled: true };
  }

  return {
    id: LOCAL_SERVER_ID,
    name: host === 'localhost' || host === '127.0.0.1' ? 'Local' : host,
    host,
    port,
    token,
    useTls,
    enabled: true,
  };
}

interface ConnectionContextValue {
  servers: Server[];
  snapshots: ConnectionSnapshot[];
  connectedCount: number;
  totalCount: number;
  addServer: (server: Server) => void;
  updateServer: (server: Server) => void;
  deleteServer: (id: string) => void;
  refreshServers: () => void;
}

const ConnectionContext = createContext<ConnectionContextValue | null>(null);

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [servers, setServers] = useState<Server[]>([]);
  const [snapshots, setSnapshots] = useState<ConnectionSnapshot[]>([]);

  // Load servers from storage on mount, auto-detect local server from URL hash
  useEffect(() => {
    let loaded = getServers();

    const autoServer = autoDetectLocalServer(loaded);
    if (autoServer) {
      const existingIdx = loaded.findIndex((s) => s.id === autoServer.id);
      if (existingIdx !== -1) {
        loaded[existingIdx] = autoServer;
        storageUpdateServer(autoServer);
      } else {
        loaded.push(autoServer);
        storageAddServer(autoServer);
      }
    }

    setServers(loaded);
    connectionManager.connectAll(loaded);
  }, []);

  // Subscribe to connection state changes
  useEffect(() => {
    const unsub = connectionManager.onChange((newSnapshots) => {
      setSnapshots(newSnapshots);
    });
    return unsub;
  }, []);

  const refreshServers = useCallback(() => {
    const loaded = getServers();
    setServers(loaded);
    connectionManager.connectAll(loaded);
  }, []);

  const addServer = useCallback((server: Server) => {
    storageAddServer(server);
    const updated = getServers();
    setServers(updated);
    connectionManager.connectServer(server);
  }, []);

  const updateServer = useCallback((server: Server) => {
    storageUpdateServer(server);
    const updated = getServers();
    setServers(updated);
    connectionManager.connectServer(server);
  }, []);

  const deleteServer = useCallback((id: string) => {
    connectionManager.disconnectServer(id);
    storageDeleteServer(id);
    const updated = getServers();
    setServers(updated);
  }, []);

  const connectedCount = snapshots.filter((s) => s.state.status === 'connected').length;
  const totalCount = servers.filter((s) => s.enabled !== false).length;

  return (
    <ConnectionContext.Provider
      value={{
        servers,
        snapshots,
        connectedCount,
        totalCount,
        addServer,
        updateServer,
        deleteServer,
        refreshServers,
      }}
    >
      {children}
    </ConnectionContext.Provider>
  );
}

export function useConnectionContext(): ConnectionContextValue {
  const ctx = useContext(ConnectionContext);
  if (!ctx) {
    throw new Error('useConnectionContext must be used within ConnectionProvider');
  }
  return ctx;
}
