import { useState, useEffect } from 'react';
import { ConnectionState } from '../types';
import { connectionManager } from '../services/ConnectionManager';

export function useConnection(serverId: string) {
  const [state, setState] = useState<ConnectionState>({
    status: 'disconnected',
    reconnectAttempts: 0,
  });

  useEffect(() => {
    const conn = connectionManager.getConnection(serverId);
    if (conn) {
      setState(conn.getState());
      const unsub = conn.onStateChange(setState);
      return unsub;
    }
  }, [serverId]);

  return {
    connectionState: state,
    isConnected: state.status === 'connected',
    isConnecting: state.status === 'connecting' || state.status === 'reconnecting',
    hasError: state.status === 'error',
    error: state.error,
  };
}
