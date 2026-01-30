import { useConnectionContext } from '../context/ConnectionContext';

export function useConnections() {
  const { snapshots, connectedCount, totalCount } = useConnectionContext();

  return {
    snapshots,
    connectedCount,
    totalCount,
    allConnected: connectedCount === totalCount && totalCount > 0,
    anyConnected: connectedCount > 0,
  };
}
