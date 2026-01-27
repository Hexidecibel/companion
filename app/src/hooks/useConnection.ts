import { useState, useEffect, useCallback } from 'react';
import { Platform } from 'react-native';
import { Server, ConnectionState } from '../types';
import { wsService } from '../services/websocket';
import { registerWithDaemon } from '../services/push';
import { getSettings } from '../services/storage';

export function useConnection(server: Server | null) {
  const [connectionState, setConnectionState] = useState<ConnectionState>(wsService.getState());

  useEffect(() => {
    const unsubscribe = wsService.onStateChange(setConnectionState);
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (server) {
      // Only connect if not already connected to this server
      const currentServerId = wsService.getServerId();
      if (currentServerId !== server.id || !wsService.isConnected()) {
        wsService.connect(server);
      }
    } else {
      wsService.disconnect();
    }

    return () => {
      // Don't disconnect on unmount - let the service manage the connection
    };
  }, [server?.id, server?.host, server?.port, server?.token]);

  // Register for push notifications when connected (if enabled)
  useEffect(() => {
    const registerPushIfEnabled = async () => {
      if (connectionState.status === 'connected') {
        const settings = await getSettings();
        if (settings.pushEnabled) {
          const deviceId = `${Platform.OS}-${server?.id || 'unknown'}`;
          // registerWithDaemon will request permission and get token if needed
          registerWithDaemon(deviceId);
        }
      }
    };
    registerPushIfEnabled();
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
    isConnecting: connectionState.status === 'connecting' || connectionState.status === 'reconnecting',
    hasError: connectionState.status === 'error',
    error: connectionState.error,
    reconnectAttempts: connectionState.reconnectAttempts,
    reconnect,
    disconnect,
  };
}
