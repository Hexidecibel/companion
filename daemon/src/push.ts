import { RegisteredDevice } from './types';

interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  sound?: 'default' | null;
  badge?: number;
  channelId?: string;
  priority?: 'default' | 'normal' | 'high';
}

interface ExpoPushResponse {
  data: Array<{
    status: 'ok' | 'error';
    id?: string;
    message?: string;
    details?: { error: string };
  }>;
}

export class PushNotificationService {
  private devices: Map<string, RegisteredDevice> = new Map();
  private instantNotifyDevices: Set<string> = new Set();
  private pendingPush: NodeJS.Timeout | null = null;
  private pushDelayMs: number;

  constructor(_credentialsPath: string | undefined, pushDelayMs: number) {
    this.pushDelayMs = pushDelayMs;
    console.log('Push notifications: Expo Push service ready');
  }

  setInstantNotify(deviceId: string, enabled: boolean): void {
    if (enabled) {
      this.instantNotifyDevices.add(deviceId);
      console.log(`Push notifications: Instant notify enabled for ${deviceId}`);
    } else {
      this.instantNotifyDevices.delete(deviceId);
      console.log(`Push notifications: Instant notify disabled for ${deviceId}`);
    }
  }

  registerDevice(deviceId: string, expoPushToken: string): void {
    this.devices.set(deviceId, {
      token: expoPushToken,
      deviceId,
      registeredAt: Date.now(),
      lastSeen: Date.now(),
    });
    console.log(`Push notifications: Registered device ${deviceId}`);
  }

  unregisterDevice(deviceId: string): void {
    this.devices.delete(deviceId);
    console.log(`Push notifications: Unregistered device ${deviceId}`);
  }

  updateDeviceLastSeen(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (device) {
      device.lastSeen = Date.now();
    }
  }

  scheduleWaitingNotification(preview: string): void {
    if (this.devices.size === 0) {
      return;
    }

    // Cancel any pending notification
    this.cancelPendingNotification();

    // Send instant notifications immediately to devices that want them
    const instantDevices = Array.from(this.devices.entries())
      .filter(([deviceId]) => this.instantNotifyDevices.has(deviceId));

    if (instantDevices.length > 0) {
      console.log(`Push notifications: Sending instant notification to ${instantDevices.length} device(s)`);
      this.sendWaitingNotificationToDevices(
        preview,
        instantDevices.map(([_, d]) => d.token)
      );
    }

    // Schedule delayed notifications for other devices
    const delayedDevices = Array.from(this.devices.entries())
      .filter(([deviceId]) => !this.instantNotifyDevices.has(deviceId));

    if (delayedDevices.length > 0) {
      console.log(`Push notifications: Scheduling notification for ${delayedDevices.length} device(s) in ${this.pushDelayMs}ms`);
      this.pendingPush = setTimeout(() => {
        this.sendWaitingNotificationToDevices(
          preview,
          delayedDevices.map(([_, d]) => d.token)
        );
        this.pendingPush = null;
      }, this.pushDelayMs);
    }
  }

  cancelPendingNotification(): void {
    if (this.pendingPush) {
      clearTimeout(this.pendingPush);
      this.pendingPush = null;
      console.log('Push notifications: Cancelled pending notification');
    }
  }

  private async sendWaitingNotificationToDevices(preview: string, tokens: string[]): Promise<void> {
    if (tokens.length === 0) {
      return;
    }

    // Truncate preview to reasonable length
    const truncatedPreview =
      preview.length > 200 ? preview.substring(0, 197) + '...' : preview;

    const messages: ExpoPushMessage[] = tokens.map((token) => ({
      to: token,
      title: 'Claude is waiting',
      body: truncatedPreview,
      data: {
        type: 'waiting_for_input',
        preview: truncatedPreview,
        timestamp: Date.now().toString(),
      },
      sound: 'default',
      badge: 1,
      channelId: 'claude_waiting',
      priority: 'high',
    }));

    try {
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(messages),
      });

      const result = (await response.json()) as ExpoPushResponse;

      let successCount = 0;
      result.data.forEach((ticket, idx) => {
        if (ticket.status === 'ok') {
          successCount++;
        } else if (ticket.details?.error === 'DeviceNotRegistered') {
          // Remove invalid token
          const deviceId = Array.from(this.devices.entries()).find(
            ([_, d]) => d.token === tokens[idx]
          )?.[0];
          if (deviceId) {
            this.unregisterDevice(deviceId);
          }
        }
      });

      console.log(`Push notifications: Sent to ${successCount}/${tokens.length} devices`);
    } catch (err) {
      console.error('Push notifications: Error sending notification:', err);
    }
  }

  isEnabled(): boolean {
    return true; // Always enabled with Expo Push
  }

  getRegisteredDeviceCount(): number {
    return this.devices.size;
  }
}
