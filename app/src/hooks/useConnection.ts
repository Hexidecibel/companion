import { useState, useEffect, useCallback } from 'react';
import { Platform } from 'react-native';
import { Server, ConnectionState } from '../types';
import { wsService } from '../services/websocket';
import { registerWithDaemon } from '../services/push';

export function useConnection(server: Server | null) {
  const [connectionState, setConnectionState] = useState<ConnectionState>(wsService.getState());

  useEffect(() => {
    const unsubscribe = wsService.onStateChange(setConnectionState);
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (server) {
      // wsService.connect() already guards against double-connect
      wsService.connect(server);
    } else {
      wsService.disconnect();
    }

    return () => {
      // Don't disconnect on unmount - let the service manage the connection
    };
  }, [server?.id, server?.host, server?.port, server?.token]);

  // Register for push notifications when connected
  useEffect(() => {
    if (connectionState.status === 'connected' && server?.id) {
      const deviceId = `${Platform.OS}-${server.id}`;
      registerWithDaemon(deviceId);
    }
  }, [connectionState.status, server?.id]);

  const reconnect = useCallback(() => {
    wsService.reconnect();
  }, []);

  const disconnect = useCallback(() => {
    wsService.disconnect();
  }, []);

  return {
    connectionState,
    isConnected: connectionState.status === 'connected',
    isConnecting:
      connectionState.status === 'connecting' || connectionState.status === 'reconnecting',
    hasError: connectionState.status === 'error',
    error: connectionState.error,
    reconnectAttempts: connectionState.reconnectAttempts,
    reconnect,
    disconnect,
  };
}
