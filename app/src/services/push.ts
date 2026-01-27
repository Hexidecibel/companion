import { Platform, PermissionsAndroid } from 'react-native';
import { wsService } from './websocket';

let pushToken: string | null = null;
let tokenType: 'fcm' | 'expo' = 'fcm';
let messagingModule: any = null;

// Try to load Firebase messaging (only works in standalone builds, not Expo Go)
try {
  messagingModule = require('@react-native-firebase/messaging').default;
  console.log('Push notifications: Firebase messaging loaded');
} catch (e) {
  console.log('Push notifications: Firebase not available (Expo Go), push disabled');
}

export async function registerForPushNotifications(): Promise<string | null> {
  if (!messagingModule) {
    console.log('Push notifications: Disabled (no Firebase)');
    return null;
  }

  try {
    // Request permission on iOS
    if (Platform.OS === 'ios') {
      const authStatus = await messagingModule().requestPermission();
      const enabled =
        authStatus === messagingModule.AuthorizationStatus.AUTHORIZED ||
        authStatus === messagingModule.AuthorizationStatus.PROVISIONAL;

      if (!enabled) {
        console.log('Push notifications: Permission denied');
        return null;
      }
    }

    // Request permission on Android 13+
    if (Platform.OS === 'android' && Platform.Version >= 33) {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
      );
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
        console.log('Push notifications: Android permission denied');
        return null;
      }
      console.log('Push notifications: Android permission granted');
    }

    // Get FCM token
    const token = await messagingModule().getToken();
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
  if (!messagingModule) {
    return { remove: () => {} };
  }

  // Handle foreground messages
  const unsubscribe = messagingModule().onMessage(async (remoteMessage: unknown) => {
    console.log('Push: Foreground message received:', remoteMessage);
    callback(remoteMessage);
  });

  return { remove: unsubscribe };
}

export function addNotificationResponseReceivedListener(
  callback: (response: unknown) => void
) {
  if (!messagingModule) {
    return { remove: () => {} };
  }

  // Handle notification tap when app is in background
  messagingModule().onNotificationOpenedApp((remoteMessage: unknown) => {
    console.log('Push: Notification opened app:', remoteMessage);
    callback(remoteMessage);
  });

  // Check if app was opened from a notification when it was quit
  messagingModule()
    .getInitialNotification()
    .then((remoteMessage: unknown) => {
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

// Listen for token refresh (only if Firebase is available)
if (messagingModule) {
  try {
    messagingModule().onTokenRefresh((token: string) => {
      console.log('Push notifications: Token refreshed');
      pushToken = token;
    });
  } catch (e) {
    // Ignore if listener fails
  }
}
