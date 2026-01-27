import { Platform } from 'react-native';
import messaging from '@react-native-firebase/messaging';
import { wsService } from './websocket';

let pushToken: string | null = null;
let tokenType: 'fcm' | 'expo' = 'fcm';

export async function registerForPushNotifications(): Promise<string | null> {
  try {
    // Request permission on iOS
    if (Platform.OS === 'ios') {
      const authStatus = await messaging().requestPermission();
      const enabled =
        authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
        authStatus === messaging.AuthorizationStatus.PROVISIONAL;

      if (!enabled) {
        console.log('Push notifications: Permission denied');
        return null;
      }
    }

    // Get FCM token
    const token = await messaging().getToken();
    if (token) {
      pushToken = token;
      tokenType = 'fcm';
      console.log('Push notifications: Got FCM token:', token.substring(0, 20) + '...');
      return token;
    }

    console.log('Push notifications: No token received');
    return null;
  } catch (error) {
    console.error('Push notifications: Error getting token:', error);
    return null;
  }
}

export async function setupNotificationChannel(): Promise<void> {
  // Android notification channels are configured in app.json/app.config.js
  // Firebase handles this automatically
}

export function addNotificationReceivedListener(
  callback: (notification: unknown) => void
) {
  // Handle foreground messages
  const unsubscribe = messaging().onMessage(async (remoteMessage) => {
    console.log('Push: Foreground message received:', remoteMessage);
    callback(remoteMessage);
  });

  return { remove: unsubscribe };
}

export function addNotificationResponseReceivedListener(
  callback: (response: unknown) => void
) {
  // Handle notification tap when app is in background
  messaging().onNotificationOpenedApp((remoteMessage) => {
    console.log('Push: Notification opened app:', remoteMessage);
    callback(remoteMessage);
  });

  // Check if app was opened from a notification when it was quit
  messaging()
    .getInitialNotification()
    .then((remoteMessage) => {
      if (remoteMessage) {
        console.log('Push: App opened from quit state:', remoteMessage);
        callback(remoteMessage);
      }
    });

  // Return a dummy remove function (messaging listeners are global)
  return { remove: () => {} };
}

export async function registerWithDaemon(deviceId: string): Promise<boolean> {
  // Try to get token if we don't have one
  if (!pushToken) {
    await registerForPushNotifications();
  }

  if (!pushToken) {
    console.log('Push notifications: No token available');
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
      tokenType,
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
  // Firebase doesn't have a direct badge API on Android
  // iOS badge is managed by the system
}

export function getToken(): string | null {
  return pushToken;
}

export function getTokenType(): 'fcm' | 'expo' {
  return tokenType;
}

// Listen for token refresh
messaging().onTokenRefresh((token) => {
  console.log('Push notifications: Token refreshed');
  pushToken = token;
  // Re-register with daemon if connected
  // This will be handled by the app's connection logic
});
