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

export class PushNotificationService {
  private devices: Map<string, RegisteredDevice> = new Map();
  private instantNotifyDevices: Set<string> = new Set();
  private pendingPush: NodeJS.Timeout | null = null;
  private pushDelayMs: number;
  private firebaseInitialized: boolean = false;

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
    const instantDevices = Array.from(this.devices.entries())
      .filter(([deviceId]) => this.instantNotifyDevices.has(deviceId));

    if (instantDevices.length > 0) {
      console.log(`Push notifications: Sending instant notification to ${instantDevices.length} device(s)`);
      this.sendNotifications(
        preview,
        instantDevices.map(([_, d]) => d.token)
      );
    }

    // Only schedule if not already scheduled - don't reset the timer
    if (this.pendingPush) {
      console.log('Push notifications: Notification already scheduled, keeping existing timer');
      return;
    }

    // Schedule delayed notifications for other devices
    const delayedDevices = Array.from(this.devices.entries())
      .filter(([deviceId]) => !this.instantNotifyDevices.has(deviceId));

    if (delayedDevices.length > 0) {
      console.log(`Push notifications: Scheduling notification for ${delayedDevices.length} device(s) in ${this.pushDelayMs}ms`);
      this.pendingPush = setTimeout(() => {
        console.log('Push notifications: Timer fired, sending notification now');
        this.sendNotifications(
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
