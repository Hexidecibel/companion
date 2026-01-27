import * as admin from 'firebase-admin';
import * as fs from 'fs';
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

interface BatchedNotification {
  preview: string;
  timestamp: number;
}

interface DeviceNotificationPrefs {
  quietHoursEnabled: boolean;
  quietHoursStart: string; // "HH:MM"
  quietHoursEnd: string;   // "HH:MM"
  throttleMinutes: number;
}

const DEFAULT_DEVICE_PREFS: DeviceNotificationPrefs = {
  quietHoursEnabled: false,
  quietHoursStart: '22:00',
  quietHoursEnd: '08:00',
  throttleMinutes: 0,
};

export class PushNotificationService {
  private devices: Map<string, RegisteredDevice> = new Map();
  private instantNotifyDevices: Set<string> = new Set();
  private devicePrefs: Map<string, DeviceNotificationPrefs> = new Map();
  private lastNotificationTime: Map<string, number> = new Map();
  private pendingPush: NodeJS.Timeout | null = null;
  private pushDelayMs: number;
  private firebaseInitialized: boolean = false;

  // Batched notifications for non-instant devices
  private batchedNotifications: BatchedNotification[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private readonly BATCH_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

  constructor(credentialsPath: string | undefined, pushDelayMs: number) {
    this.pushDelayMs = pushDelayMs;

    // Initialize Firebase if credentials provided
    if (credentialsPath && fs.existsSync(credentialsPath)) {
      try {
        const serviceAccount = JSON.parse(fs.readFileSync(credentialsPath, 'utf-8'));
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
        });
        this.firebaseInitialized = true;
        console.log('Push notifications: Firebase Admin SDK initialized');
      } catch (err) {
        console.error('Push notifications: Failed to initialize Firebase:', err);
        console.log('Push notifications: Falling back to Expo Push');
      }
    } else {
      console.log('Push notifications: No Firebase credentials, using Expo Push');
    }
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

  setNotificationPrefs(deviceId: string, prefs: DeviceNotificationPrefs): void {
    this.devicePrefs.set(deviceId, prefs);
    console.log(`Push notifications: Updated prefs for ${deviceId}:`, prefs);
  }

  private isInQuietHours(deviceId: string): boolean {
    const prefs = this.devicePrefs.get(deviceId) || DEFAULT_DEVICE_PREFS;
    if (!prefs.quietHoursEnabled) {
      return false;
    }

    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    const [startH, startM] = prefs.quietHoursStart.split(':').map(Number);
    const [endH, endM] = prefs.quietHoursEnd.split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    // Handle overnight quiet hours (e.g., 22:00 - 08:00)
    if (startMinutes > endMinutes) {
      // Quiet hours span midnight
      return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    } else {
      // Same-day quiet hours
      return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    }
  }

  private isThrottled(deviceId: string): boolean {
    const prefs = this.devicePrefs.get(deviceId) || DEFAULT_DEVICE_PREFS;
    if (prefs.throttleMinutes <= 0) {
      return false;
    }

    const lastTime = this.lastNotificationTime.get(deviceId);
    if (!lastTime) {
      return false;
    }

    const elapsed = Date.now() - lastTime;
    const throttleMs = prefs.throttleMinutes * 60 * 1000;
    return elapsed < throttleMs;
  }

  private recordNotificationSent(deviceId: string): void {
    this.lastNotificationTime.set(deviceId, Date.now());
  }

  registerDevice(deviceId: string, pushToken: string): void {
    this.devices.set(deviceId, {
      token: pushToken,
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

    // Send instant notifications immediately to devices that want them
    // But filter out devices in quiet hours or throttled
    const instantDevices = Array.from(this.devices.entries())
      .filter(([deviceId]) => this.instantNotifyDevices.has(deviceId))
      .filter(([deviceId]) => !this.isInQuietHours(deviceId))
      .filter(([deviceId]) => !this.isThrottled(deviceId));

    if (instantDevices.length > 0) {
      console.log(`Push notifications: Sending instant notification to ${instantDevices.length} device(s)`);
      this.sendNotificationsToDevices(preview, instantDevices);
    }

    // Log skipped devices
    const skippedQuiet = Array.from(this.devices.entries())
      .filter(([deviceId]) => this.instantNotifyDevices.has(deviceId))
      .filter(([deviceId]) => this.isInQuietHours(deviceId));
    if (skippedQuiet.length > 0) {
      console.log(`Push notifications: Skipped ${skippedQuiet.length} device(s) in quiet hours`);
    }

    const skippedThrottled = Array.from(this.devices.entries())
      .filter(([deviceId]) => this.instantNotifyDevices.has(deviceId))
      .filter(([deviceId]) => !this.isInQuietHours(deviceId))
      .filter(([deviceId]) => this.isThrottled(deviceId));
    if (skippedThrottled.length > 0) {
      console.log(`Push notifications: Skipped ${skippedThrottled.length} device(s) due to throttle`);
    }

    // For non-instant devices, batch notifications
    const batchedDevices = Array.from(this.devices.entries())
      .filter(([deviceId]) => !this.instantNotifyDevices.has(deviceId));

    if (batchedDevices.length > 0) {
      // Add to batch queue
      this.batchedNotifications.push({
        preview,
        timestamp: Date.now(),
      });
      console.log(`Push notifications: Added to batch queue (${this.batchedNotifications.length} pending)`);

      // Start batch timer if not already running
      if (!this.batchTimer) {
        console.log(`Push notifications: Starting batch timer (${this.BATCH_INTERVAL_MS / 1000 / 60} minutes)`);
        this.batchTimer = setTimeout(() => {
          this.sendBatchedNotifications();
        }, this.BATCH_INTERVAL_MS);
      }
    }
  }

  private sendBatchedNotifications(): void {
    const batchedDevices = Array.from(this.devices.entries())
      .filter(([deviceId]) => !this.instantNotifyDevices.has(deviceId));

    if (batchedDevices.length === 0 || this.batchedNotifications.length === 0) {
      this.batchedNotifications = [];
      this.batchTimer = null;
      return;
    }

    // Create summary message
    const count = this.batchedNotifications.length;
    const lastPreview = this.batchedNotifications[this.batchedNotifications.length - 1].preview;
    const summary = count === 1
      ? lastPreview
      : `${count} messages waiting - Latest: ${lastPreview.substring(0, 100)}`;

    console.log(`Push notifications: Sending batched notification (${count} messages) to ${batchedDevices.length} device(s)`);

    this.sendNotifications(
      summary,
      batchedDevices.map(([_, d]) => d.token)
    );

    // Clear batch
    this.batchedNotifications = [];
    this.batchTimer = null;
  }

  cancelPendingNotification(): void {
    if (this.pendingPush) {
      clearTimeout(this.pendingPush);
      this.pendingPush = null;
      console.log('Push notifications: Cancelled pending notification');
    }

    // Also clear batched notifications when user responds
    if (this.batchedNotifications.length > 0) {
      this.batchedNotifications = [];
      console.log('Push notifications: Cleared batched notifications');
    }
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
  }

  private async sendNotificationsToDevices(
    preview: string,
    devices: [string, RegisteredDevice][]
  ): Promise<void> {
    // Record notification time for throttling
    for (const [deviceId] of devices) {
      this.recordNotificationSent(deviceId);
    }
    // Send using existing method
    await this.sendNotifications(preview, devices.map(([_, d]) => d.token));
  }

  private async sendNotifications(preview: string, tokens: string[]): Promise<void> {
    if (tokens.length === 0) {
      return;
    }

    // Truncate preview to reasonable length
    const truncatedPreview =
      preview.length > 200 ? preview.substring(0, 197) + '...' : preview;

    // Determine if tokens are FCM (no ExponentPushToken prefix) or Expo
    const fcmTokens = tokens.filter(t => !t.startsWith('ExponentPushToken'));
    const expoTokens = tokens.filter(t => t.startsWith('ExponentPushToken'));

    // Send via Firebase if we have FCM tokens and Firebase is initialized
    if (fcmTokens.length > 0 && this.firebaseInitialized) {
      await this.sendViaFirebase(truncatedPreview, fcmTokens);
    }

    // Send via Expo Push if we have Expo tokens
    if (expoTokens.length > 0) {
      await this.sendViaExpo(truncatedPreview, expoTokens);
    }
  }

  private async sendViaFirebase(preview: string, tokens: string[]): Promise<void> {
    const message: admin.messaging.MulticastMessage = {
      tokens,
      notification: {
        title: 'Claude is waiting',
        body: preview,
      },
      data: {
        type: 'waiting_for_input',
        preview,
        timestamp: Date.now().toString(),
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'claude_waiting',
          sound: 'default',
        },
      },
    };

    try {
      const response = await admin.messaging().sendEachForMulticast(message);
      console.log(`Push notifications (FCM): Sent to ${response.successCount}/${tokens.length} devices`);

      // Log detailed errors for failed tokens
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          console.error(`Push notifications (FCM): Failed for token ${tokens[idx].substring(0, 20)}...: ${resp.error?.code} - ${resp.error?.message}`);
          if (resp.error?.code === 'messaging/registration-token-not-registered') {
            const deviceId = Array.from(this.devices.entries()).find(
              ([_, d]) => d.token === tokens[idx]
            )?.[0];
            if (deviceId) {
              this.unregisterDevice(deviceId);
            }
          }
        }
      });
    } catch (err) {
      console.error('Push notifications (FCM): Error sending:', err);
    }
  }

  private async sendViaExpo(preview: string, tokens: string[]): Promise<void> {
    const messages: ExpoPushMessage[] = tokens.map((token) => ({
      to: token,
      title: 'Claude is waiting',
      body: preview,
      data: {
        type: 'waiting_for_input',
        preview,
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
          const deviceId = Array.from(this.devices.entries()).find(
            ([_, d]) => d.token === tokens[idx]
          )?.[0];
          if (deviceId) {
            this.unregisterDevice(deviceId);
          }
        }
      });

      console.log(`Push notifications (Expo): Sent to ${successCount}/${tokens.length} devices`);
    } catch (err) {
      console.error('Push notifications (Expo): Error sending:', err);
    }
  }

  isEnabled(): boolean {
    return true;
  }

  getRegisteredDeviceCount(): number {
    return this.devices.size;
  }
}
