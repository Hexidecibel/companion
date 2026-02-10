import { useCallback } from 'react';
import { Server } from '../types';
import { useConnectionContext } from '../context/ConnectionContext';

export function useServers() {
  const { servers, addServer, updateServer, deleteServer, refreshServers } = useConnectionContext();

  const getServer = useCallback(
    (id: string): Server | undefined => servers.find((s) => s.id === id),
    [servers],
  );

  const toggleEnabled = useCallback(
    (id: string) => {
      const server = servers.find((s) => s.id === id);
      if (server) {
        updateServer({ ...server, enabled: server.enabled === false ? true : false });
      }
    },
    [servers, updateServer],
  );

  const toggleParallelWorkers = useCallback(
    (id: string) => {
      const server = servers.find((s) => s.id === id);
      if (server) {
        updateServer({ ...server, parallelWorkersEnabled: server.parallelWorkersEnabled === false });
      }
    },
    [servers, updateServer],
  );

  const isParallelWorkersEnabled = useCallback(
    (id: string): boolean => {
      const server = servers.find((s) => s.id === id);
      return server?.parallelWorkersEnabled !== false; // default true
    },
    [servers],
  );

  return {
    servers,
    getServer,
    addServer,
    updateServer,
    deleteServer,
    toggleEnabled,
    toggleParallelWorkers,
    isParallelWorkersEnabled,
    refreshServers,
  };
}
