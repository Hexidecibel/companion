import AsyncStorage from '@react-native-async-storage/async-storage';

const NOTIFICATION_PREFS_KEY = '@claude_companion_notification_prefs';

export interface NotificationPreferences {
  enabled: boolean;
  instantNotify: boolean;
  // Future: quietHoursStart, quietHoursEnd, soundEnabled, etc.
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  enabled: true,
  instantNotify: false,
};

export async function getNotificationPreferences(
  serverId: string
): Promise<NotificationPreferences> {
  try {
    const json = await AsyncStorage.getItem(NOTIFICATION_PREFS_KEY);
    if (json) {
      const all = JSON.parse(json);
      if (all[serverId]) {
        return { ...DEFAULT_NOTIFICATION_PREFERENCES, ...all[serverId] };
      }
    }
  } catch (error) {
    console.error('Error loading notification preferences:', error);
  }
  return DEFAULT_NOTIFICATION_PREFERENCES;
}

export async function saveNotificationPreferences(
  serverId: string,
  prefs: NotificationPreferences
): Promise<void> {
  try {
    const json = await AsyncStorage.getItem(NOTIFICATION_PREFS_KEY);
    const all = json ? JSON.parse(json) : {};
    all[serverId] = prefs;
    await AsyncStorage.setItem(NOTIFICATION_PREFS_KEY, JSON.stringify(all));
  } catch (error) {
    console.error('Error saving notification preferences:', error);
  }
}

export async function getAllNotificationPreferences(): Promise<
  Record<string, NotificationPreferences>
> {
  try {
    const json = await AsyncStorage.getItem(NOTIFICATION_PREFS_KEY);
    if (json) {
      return JSON.parse(json);
    }
  } catch (error) {
    console.error('Error loading all notification preferences:', error);
  }
  return {};
}
