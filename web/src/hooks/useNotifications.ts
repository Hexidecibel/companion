import { useState, useEffect, useCallback } from 'react';
import { connectionManager } from '../services/ConnectionManager';
import { browserNotifications, BrowserNotifPrefs } from '../services/BrowserNotifications';

interface UseNotificationsReturn {
  supported: boolean;
  permission: NotificationPermission;
  prefs: BrowserNotifPrefs;
  requestPermission: () => Promise<void>;
  updatePrefs: (prefs: Partial<BrowserNotifPrefs>) => void;
  testNotification: () => void;
}

export function useNotifications(serverId: string | null): UseNotificationsReturn {
  const [permission, setPermission] = useState<NotificationPermission>(
    browserNotifications.getPermission(),
  );
  const [prefs, setPrefs] = useState<BrowserNotifPrefs>(browserNotifications.getPrefs());
  const supported = browserNotifications.isSupported();

  // Listen for WS broadcast events and show browser notifications
  useEffect(() => {
    if (!serverId || !supported) return;

    const conn = connectionManager.getConnection(serverId);
    if (!conn) return;

    const unsubscribe = conn.onMessage((msg) => {
      if (!msg.success) return;

      const eventType = msg.type;
      if (!['status_change', 'error_detected', 'session_completed'].includes(eventType)) return;

      // Check if this event type is enabled for browser notifications
      if (eventType === 'status_change') {
        const payload = msg.payload as { isWaitingForInput?: boolean; sessionId?: string } | undefined;
        if (!payload?.isWaitingForInput) return;
        if (!browserNotifications.isEventEnabled('waiting_for_input')) return;
        browserNotifications.show('Waiting for input', {
          body: 'A session is waiting for your input',
          tag: `waiting-${payload.sessionId || 'unknown'}`,
        });
      } else if (eventType === 'error_detected') {
        if (!browserNotifications.isEventEnabled('error_detected')) return;
        const payload = msg.payload as { content?: string; sessionName?: string } | undefined;
        browserNotifications.show('Error detected', {
          body: payload?.content?.substring(0, 100) || 'An error was detected in a session',
          tag: `error-${Date.now()}`,
        });
      } else if (eventType === 'session_completed') {
        if (!browserNotifications.isEventEnabled('session_completed')) return;
        const payload = msg.payload as { sessionName?: string } | undefined;
        browserNotifications.show('Session completed', {
          body: payload?.sessionName ? `Session "${payload.sessionName}" has completed` : 'A session has completed',
          tag: `completed-${Date.now()}`,
        });
      }
    });

    return unsubscribe;
  }, [serverId, supported]);

  const requestPermission = useCallback(async () => {
    const result = await browserNotifications.requestPermission();
    setPermission(result);
  }, []);

  const updatePrefs = useCallback((updates: Partial<BrowserNotifPrefs>) => {
    const updated = browserNotifications.setPrefs(updates);
    setPrefs(updated);
  }, []);

  const testNotification = useCallback(() => {
    browserNotifications.show('Test Notification', {
      body: 'Browser notifications are working!',
      tag: 'test',
      force: true,
    });
  }, []);

  return { supported, permission, prefs, requestPermission, updatePrefs, testNotification };
}
