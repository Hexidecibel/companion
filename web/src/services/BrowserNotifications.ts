const STORAGE_KEY = 'companion_browser_notifications';

interface BrowserNotifPrefs {
  enabled: boolean;
  waiting_for_input: boolean;
  error_detected: boolean;
  session_completed: boolean;
  worker_waiting: boolean;
  worker_error: boolean;
  work_group_ready: boolean;
}

const DEFAULT_PREFS: BrowserNotifPrefs = {
  enabled: true,
  waiting_for_input: true,
  error_detected: true,
  session_completed: true,
  worker_waiting: true,
  worker_error: true,
  work_group_ready: true,
};

class BrowserNotificationService {
  private permission: NotificationPermission = 'default';

  constructor() {
    if ('Notification' in window) {
      this.permission = Notification.permission;
    }
  }

  isSupported(): boolean {
    return 'Notification' in window;
  }

  getPermission(): NotificationPermission {
    return this.permission;
  }

  async requestPermission(): Promise<NotificationPermission> {
    if (!this.isSupported()) return 'denied';
    this.permission = await Notification.requestPermission();
    return this.permission;
  }

  show(title: string, options?: { body?: string; tag?: string; force?: boolean }): void {
    if (!this.isSupported()) return;
    if (this.permission !== 'granted') return;
    // Don't show if tab is focused (unless forced, e.g. test button)
    if (!options?.force && document.hasFocus()) return;

    const prefs = this.getPrefs();
    if (!prefs.enabled) return;

    const notification = new Notification(title, {
      body: options?.body,
      tag: options?.tag || 'companion-notification',
      icon: '/favicon.ico',
    });

    // Auto-close after 10 seconds
    setTimeout(() => notification.close(), 10_000);

    // Click focuses the tab
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  }

  getPrefs(): BrowserNotifPrefs {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) return { ...DEFAULT_PREFS, ...JSON.parse(stored) };
    } catch {
      // ignore
    }
    return DEFAULT_PREFS;
  }

  setPrefs(prefs: Partial<BrowserNotifPrefs>): BrowserNotifPrefs {
    const current = this.getPrefs();
    const updated = { ...current, ...prefs };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    return updated;
  }

  isEventEnabled(eventType: string): boolean {
    const prefs = this.getPrefs();
    if (!prefs.enabled) return false;
    switch (eventType) {
      case 'waiting_for_input': return prefs.waiting_for_input;
      case 'error_detected': return prefs.error_detected;
      case 'session_completed': return prefs.session_completed;
      case 'worker_waiting': return prefs.worker_waiting;
      case 'worker_error': return prefs.worker_error;
      case 'work_group_ready': return prefs.work_group_ready;
      default: return true;
    }
  }
}

export const browserNotifications = new BrowserNotificationService();
export type { BrowserNotifPrefs };
