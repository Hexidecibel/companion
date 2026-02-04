import { useState, useCallback } from 'react';
import { browserNotifications, BrowserNotifPrefs } from '../services/BrowserNotifications';

interface UseNotificationsReturn {
  supported: boolean;
  permission: NotificationPermission;
  prefs: BrowserNotifPrefs;
  requestPermission: () => Promise<void>;
  updatePrefs: (prefs: Partial<BrowserNotifPrefs>) => void;
  testNotification: () => void;
}

export function useNotifications(_serverId: string | null): UseNotificationsReturn {
  const [permission, setPermission] = useState<NotificationPermission>(
    browserNotifications.getPermission(),
  );
  const [prefs, setPrefs] = useState<BrowserNotifPrefs>(browserNotifications.getPrefs());
  const supported = browserNotifications.isSupported();

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
