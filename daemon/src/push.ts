import * as admin from 'firebase-admin';
import * as fs from 'fs';
import { NotificationEventType } from './types';
import { NotificationStore } from './notification-store';

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
  private store: NotificationStore;
  private firebaseInitialized: boolean = false;

  constructor(credentialsPath: string | undefined, _pushDelayMs: number, store: NotificationStore) {
    this.store = store;

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

  getStore(): NotificationStore {
    return this.store;
  }

  registerDevice(deviceId: string, pushToken: string): void {
    this.store.setDevice({
      token: pushToken,
      deviceId,
      registeredAt: Date.now(),
      lastSeen: Date.now(),
    });
    console.log(`Push notifications: Registered device ${deviceId}`);
  }

  unregisterDevice(deviceId: string): void {
    this.store.removeDevice(deviceId);
    console.log(`Push notifications: Unregistered device ${deviceId}`);
  }

  updateDeviceLastSeen(deviceId: string): void {
    this.store.updateDeviceLastSeen(deviceId);
  }

  /**
   * Send push notification to ALL registered devices unconditionally.
   * Called by escalation service when push timer fires.
   */
  sendToAllDevices(
    preview: string,
    eventType: NotificationEventType,
    sessionId?: string,
    sessionName?: string
  ): void {
    const allDevices = this.store.getDevices();
    if (allDevices.length === 0) {
      console.log('Push notifications: No devices registered, skipping');
      return;
    }

    const title = this.getTitleForEvent(eventType);
    const tokens = allDevices.map((d) => d.token);

    console.log(`Push notifications: Sending to ${allDevices.length} device(s) for ${eventType}`);
    this.sendNotifications(preview, tokens, sessionId, sessionName, title);
  }

  private getTitleForEvent(eventType: NotificationEventType): string {
    switch (eventType) {
      case 'waiting_for_input':
        return 'Waiting for input';
      case 'error_detected':
        return 'Error detected';
      case 'session_completed':
        return 'Session completed';
      case 'worker_waiting':
        return 'Worker needs input';
      case 'worker_error':
        return 'Worker error';
      case 'work_group_ready':
        return 'Work group ready to merge';
    }
  }

  private async sendNotifications(
    preview: string,
    tokens: string[],
    sessionId?: string,
    sessionName?: string,
    title?: string
  ): Promise<void> {
    if (tokens.length === 0) return;

    const truncatedPreview = preview.length > 200 ? preview.substring(0, 197) + '...' : preview;
    const notificationTitle = title || 'Waiting for input';

    const fcmTokens = tokens.filter((t) => !t.startsWith('ExponentPushToken'));
    const expoTokens = tokens.filter((t) => t.startsWith('ExponentPushToken'));

    if (fcmTokens.length > 0 && this.firebaseInitialized) {
      await this.sendViaFirebase(
        truncatedPreview,
        fcmTokens,
        sessionId,
        sessionName,
        notificationTitle
      );
    }

    if (expoTokens.length > 0) {
      await this.sendViaExpo(
        truncatedPreview,
        expoTokens,
        sessionId,
        sessionName,
        notificationTitle
      );
    }
  }

  private async sendViaFirebase(
    preview: string,
    tokens: string[],
    sessionId?: string,
    sessionName?: string,
    title?: string
  ): Promise<void> {
    const data: Record<string, string> = {
      type: 'waiting_for_input',
      preview,
      timestamp: Date.now().toString(),
    };
    if (sessionId) data.sessionId = sessionId;
    if (sessionName) data.sessionName = sessionName;

    const message: admin.messaging.MulticastMessage = {
      tokens,
      notification: {
        title: title || 'Waiting for input',
        body: preview,
      },
      data,
      android: {
        priority: 'high',
        notification: {
          channelId: 'input_waiting',
          sound: 'default',
        },
      },
    };

    try {
      const response = await admin.messaging().sendEachForMulticast(message);
      console.log(
        `Push notifications (FCM): Sent to ${response.successCount}/${tokens.length} devices`
      );

      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          console.error(
            `Push notifications (FCM): Failed for token ${tokens[idx].substring(0, 20)}...: ${resp.error?.code} - ${resp.error?.message}`
          );
          if (resp.error?.code === 'messaging/registration-token-not-registered') {
            const allDevices = this.store.getDevices();
            const device = allDevices.find((d) => d.token === tokens[idx]);
            if (device) {
              this.unregisterDevice(device.deviceId);
            }
          }
        }
      });
    } catch (err) {
      console.error('Push notifications (FCM): Error sending:', err);
    }
  }

  private async sendViaExpo(
    preview: string,
    tokens: string[],
    sessionId?: string,
    sessionName?: string,
    title?: string
  ): Promise<void> {
    const notifData: Record<string, string> = {
      type: 'waiting_for_input',
      preview,
      timestamp: Date.now().toString(),
    };
    if (sessionId) notifData.sessionId = sessionId;
    if (sessionName) notifData.sessionName = sessionName;

    const messages: ExpoPushMessage[] = tokens.map((token) => ({
      to: token,
      title: title || 'Waiting for input',
      body: preview,
      data: notifData,
      sound: 'default',
      badge: 1,
      channelId: 'input_waiting',
      priority: 'high',
    }));

    try {
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
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
          const allDevices = this.store.getDevices();
          const device = allDevices.find((d) => d.token === tokens[idx]);
          if (device) {
            this.unregisterDevice(device.deviceId);
          }
        }
      });

      console.log(`Push notifications (Expo): Sent to ${successCount}/${tokens.length} devices`);
    } catch (err) {
      console.error('Push notifications (Expo): Error sending:', err);
    }
  }

  /**
   * Send a test push notification to all registered devices.
   */
  async sendTestNotification(): Promise<{ sent: number; failed: number }> {
    const devices = this.store.getDevices();
    if (devices.length === 0) return { sent: 0, failed: 0 };

    const tokens = devices.map((d) => d.token);
    const preview = 'This is a test notification from Companion.';
    const title = 'Test Notification';

    const fcmTokens = tokens.filter((t) => !t.startsWith('ExponentPushToken'));
    const expoTokens = tokens.filter((t) => t.startsWith('ExponentPushToken'));

    let sent = 0;
    let failed = 0;

    if (fcmTokens.length > 0 && this.firebaseInitialized) {
      try {
        await this.sendViaFirebase(preview, fcmTokens, undefined, undefined, title);
        sent += fcmTokens.length;
      } catch {
        failed += fcmTokens.length;
      }
    }

    if (expoTokens.length > 0) {
      try {
        await this.sendViaExpo(preview, expoTokens, undefined, undefined, title);
        sent += expoTokens.length;
      } catch {
        failed += expoTokens.length;
      }
    }

    console.log(`Push notifications: Test sent to ${sent} device(s), ${failed} failed`);
    return { sent, failed };
  }

  isEnabled(): boolean {
    return true;
  }

  getRegisteredDeviceCount(): number {
    return this.store.getDeviceCount();
  }
}
