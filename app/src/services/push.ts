import { Platform } from 'react-native';
import { wsService } from './websocket';

let pushToken: string | null = null;

// Simplified push service - expo-notifications removed due to Expo Go SDK 53+ incompatibility
// Push notifications will work when building a standalone app with Firebase

export async function registerForPushNotifications(): Promise<string | null> {
  // In Expo Go, we can't get push tokens
  // This will work in standalone builds with proper Firebase setup
  console.log('Push notifications: Disabled in Expo Go (SDK 53+)');
  return null;
}

export async function setupNotificationChannel(): Promise<void> {
  // No-op in Expo Go
}

export function addNotificationReceivedListener(
  callback: (notification: unknown) => void
) {
  // Return a dummy subscription
  return { remove: () => {} };
}

export function addNotificationResponseReceivedListener(
  callback: (response: unknown) => void
) {
  // Return a dummy subscription
  return { remove: () => {} };
}

export async function registerWithDaemon(deviceId: string): Promise<boolean> {
  if (!pushToken) {
    // No token available in Expo Go
    return false;
  }

  if (!wsService.isConnected()) {
    console.log('Push notifications: Not connected to daemon');
    return false;
  }

  try {
    const response = await wsService.sendRequest('register_push', {
      deviceId,
      fcmToken: pushToken,
      tokenType: 'fcm',
    });

    if (response.success) {
      console.log('Push notifications: Registered with daemon');
      return true;
    } else {
      console.error('Push notifications: Registration failed:', response.error);
      return false;
    }
  } catch (error) {
    console.error('Push notifications: Error registering:', error);
    return false;
  }
}

export async function unregisterWithDaemon(deviceId: string): Promise<boolean> {
  if (!wsService.isConnected()) {
    return false;
  }

  try {
    const response = await wsService.sendRequest('unregister_push', {
      deviceId,
    });
    return response.success;
  } catch (error) {
    console.error('Push notifications: Error unregistering:', error);
    return false;
  }
}

export async function clearBadge(): Promise<void> {
  // No-op in Expo Go
}

export function getToken(): string | null {
  return pushToken;
}

export function getTokenType(): 'fcm' | 'expo' {
  return 'fcm';
}
