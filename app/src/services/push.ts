import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { wsService } from './websocket';

let fcmToken: string | null = null;

// Configure how notifications are handled when app is in foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export async function registerForPushNotifications(): Promise<string | null> {
  // Only works on physical devices
  if (!Device.isDevice) {
    console.log('Push notifications: Must use physical device');
    return null;
  }

  try {
    // Check existing permissions
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    // Request permissions if not granted
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') {
      console.log('Push notifications: Permission not granted');
      return null;
    }

    // Get the token
    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    const tokenData = await Notifications.getExpoPushTokenAsync({
      projectId,
    });

    fcmToken = tokenData.data;
    console.log('Push notifications: Token obtained');

    return fcmToken;
  } catch (error) {
    console.error('Push notifications: Error getting token:', error);
    return null;
  }
}

export async function setupNotificationChannel(): Promise<void> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('claude_waiting', {
      name: 'Claude Waiting',
      description: 'Notifications when Claude is waiting for your input',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#3b82f6',
      sound: 'default',
    });
  }
}

export function addNotificationReceivedListener(
  callback: (notification: Notifications.Notification) => void
) {
  return Notifications.addNotificationReceivedListener(callback);
}

export function addNotificationResponseReceivedListener(
  callback: (response: Notifications.NotificationResponse) => void
) {
  return Notifications.addNotificationResponseReceivedListener(callback);
}

export async function registerWithDaemon(deviceId: string): Promise<boolean> {
  if (!fcmToken) {
    console.log('Push notifications: No token to register');
    return false;
  }

  if (!wsService.isConnected()) {
    console.log('Push notifications: Not connected to daemon');
    return false;
  }

  try {
    const response = await wsService.sendRequest('register_push', {
      deviceId,
      fcmToken,
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
  try {
    await Notifications.setBadgeCountAsync(0);
  } catch (error) {
    // Ignore badge errors
  }
}

export function getToken(): string | null {
  return fcmToken;
}
