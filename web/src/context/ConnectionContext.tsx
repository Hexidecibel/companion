import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import { Server } from '../types';
import { connectionManager, ConnectionSnapshot } from '../services/ConnectionManager';
import { getServers, addServer as storageAddServer, updateServer as storageUpdateServer, deleteServer as storageDeleteServer } from '../services/storage';

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

  // Load servers from storage on mount
  useEffect(() => {
    const loaded = getServers();
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
