/**
 * Unified push notification service.
 *
 * Platform behavior:
 * - Tauri mobile (Android/iOS): Uses the FCM plugin to get a push token,
 *   registers it with the daemon for remote push notifications.
 * - Tauri desktop: No remote push — uses tauri-plugin-notification for local only.
 * - Browser: No remote push — uses Web Notification API for local only.
 *
 * Remote push registration uses the same daemon protocol as the React Native app:
 *   register_push { deviceId, fcmToken, tokenType }
 */

import { isTauriMobile } from '../utils/platform';
import { connectionManager } from './ConnectionManager';
import { DEVICE_ID_KEY } from './storageKeys';

let pushToken: string | null = null;
let deviceId: string | null = null;
let tokenRefreshUnlisten: (() => void) | null = null;

/** Generate or retrieve a persistent device ID. */
function getDeviceId(): string {
  if (deviceId) return deviceId;
  const stored = localStorage.getItem(DEVICE_ID_KEY);
  if (stored) {
    deviceId = stored;
    return stored;
  }
  const id = 'web-' + crypto.randomUUID();
  localStorage.setItem(DEVICE_ID_KEY, id);
  deviceId = id;
  return id;
}

/** Check if remote push notifications are supported on this platform. */
export function isRemotePushSupported(): boolean {
  return isTauriMobile();
}

/** Request notification permission via the FCM plugin (mobile only). */
export async function requestPermission(): Promise<boolean> {
  if (!isTauriMobile()) return false;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const granted = await invoke<boolean>('plugin:fcm|request_notification_permission');
    return granted;
  } catch {
    return false;
  }
}

/** Check if notification permission is granted (mobile only). */
export async function isPermissionGranted(): Promise<boolean> {
  if (!isTauriMobile()) return true; // Desktop/browser handle their own
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<boolean>('plugin:fcm|is_notification_permission_granted');
  } catch {
    return false;
  }
}

/** Get the FCM push token (mobile only). Returns null on other platforms. */
export async function getToken(): Promise<string | null> {
  if (!isTauriMobile()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const token = await invoke<string | null>('plugin:fcm|get_fcm_token');
    if (token) {
      pushToken = token;
    }
    return token;
  } catch {
    return null;
  }
}

/**
 * Register the push token with a specific daemon server.
 * Sends the FCM token via the existing register_push WebSocket protocol.
 */
export async function registerWithServer(serverId: string): Promise<boolean> {
  if (!pushToken) {
    await getToken();
  }
  if (!pushToken) return false;

  const conn = connectionManager.getConnection(serverId);
  if (!conn || !conn.isConnected()) return false;

  try {
    const response = await conn.sendRequest('register_push', {
      deviceId: getDeviceId(),
      fcmToken: pushToken,
      tokenType: 'fcm',
    });
    return response.success;
  } catch {
    return false;
  }
}

/** Unregister push token from a specific daemon server. */
export async function unregisterFromServer(serverId: string): Promise<boolean> {
  const conn = connectionManager.getConnection(serverId);
  if (!conn || !conn.isConnected()) return false;

  try {
    const response = await conn.sendRequest('unregister_push', {
      deviceId: getDeviceId(),
    });
    return response.success;
  } catch {
    return false;
  }
}

/**
 * Register push token with ALL connected servers.
 * Should be called after getting a token and whenever a new server connects.
 */
export async function registerWithAllServers(): Promise<void> {
  if (!pushToken) {
    await getToken();
  }
  if (!pushToken) return;

  const snapshots = connectionManager.getSnapshots();
  for (const snap of snapshots) {
    if (snap.state.status === 'connected') {
      await registerWithServer(snap.serverId);
    }
  }
}

/**
 * Listen for FCM token refresh events (mobile only).
 * When a token refreshes, re-register with all connected servers.
 */
export async function startTokenRefreshListener(): Promise<void> {
  if (!isTauriMobile()) return;
  if (tokenRefreshUnlisten) return; // Already listening

  try {
    const { listen } = await import('@tauri-apps/api/event');
    tokenRefreshUnlisten = await listen<{ token: string }>('plugin:fcm://tokenRefresh', (event) => {
      pushToken = event.payload.token;
      registerWithAllServers();
    });
  } catch {
    // Plugin events not available
  }
}

/** Stop listening for token refresh events. */
export function stopTokenRefreshListener(): void {
  if (tokenRefreshUnlisten) {
    tokenRefreshUnlisten();
    tokenRefreshUnlisten = null;
  }
}

/**
 * Initialize push notifications.
 * Call this once on app startup (from Dashboard or App.tsx).
 * On mobile: requests permission, gets token, registers with servers, starts refresh listener.
 * On other platforms: no-op.
 */
export async function initPush(): Promise<void> {
  if (!isRemotePushSupported()) return;

  const granted = await requestPermission();
  if (!granted) {
    // Check again — requestPermission might have triggered the system dialog
    const actuallyGranted = await isPermissionGranted();
    if (!actuallyGranted) return;
  }

  await getToken();
  if (pushToken) {
    await registerWithAllServers();
    await startTokenRefreshListener();
  }
}

/** Get the current push token (if any). */
export function getCurrentToken(): string | null {
  return pushToken;
}

/** Get the current device ID. */
export function getCurrentDeviceId(): string {
  return getDeviceId();
}
