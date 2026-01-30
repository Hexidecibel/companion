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

  return {
    servers,
    getServer,
    addServer,
    updateServer,
    deleteServer,
    toggleEnabled,
    refreshServers,
  };
}
