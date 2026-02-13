# Notifications

Push notifications, escalation tiers, quiet hours, and per-session controls.

## Overview

Companion uses a 2-tier escalation model to notify you when the CLI needs input:

1. **Browser / OS notification** — sent immediately
2. **Push notification** (FCM) — sent after a configurable delay (default 60s)

This lets you catch things quickly if you're at your desk, while still getting a phone buzz if you've walked away.

## Browser Notifications

Desktop and web clients send native OS notifications immediately when a session enters the "waiting for input" state. These use the browser Notification API (web) or native OS notifications via Tauri (desktop — macOS Notification Center, Linux libnotify).

No setup required — just allow notifications when prompted.

## Push Notifications (FCM)

Push notifications reach your phone even when the app is closed. They use Firebase Cloud Messaging (FCM) on Android and APNs (via FCM) on iOS.

### Firebase Setup

1. Create a project at [Firebase Console](https://console.firebase.google.com)
2. Add an Android app with package name `com.companion.app`
3. Download the service account credentials JSON
4. Place it on your server (e.g., `~/.companion/fcm-credentials.json`)
5. Set the path in your daemon config:
   ```json
   {
     "fcm_credentials_path": "~/.companion/fcm-credentials.json"
   }
   ```
6. Restart the daemon

The mobile app registers its FCM token automatically on connect via the `register_push` message.

### Custom Tauri Plugin

The Android and iOS apps use a custom Tauri plugin (`desktop/src-tauri/plugins/tauri-plugin-fcm/`) to handle FCM token registration and incoming push messages natively.

## Escalation Flow

When a session enters "waiting for input":

1. **Immediate**: browser/OS notification sent to all connected clients
2. **After delay** (`push_delay_ms`, default 60000ms): FCM push sent to registered devices
3. If the session is answered before the delay expires, the push is cancelled

### Consolidated Batching

If multiple sessions are waiting simultaneously, push notifications are batched into a single consolidated message (e.g., "3 sessions need input") rather than sending one per session.

## Quiet Hours

Schedule a window where push notifications are suppressed. Browser notifications still fire.

Configure via the escalation settings in the app or through the daemon API:

```json
{
  "quietHoursStart": "22:00",
  "quietHoursEnd": "08:00"
}
```

## Rate Limiting

Push notifications are rate-limited to prevent notification storms during rapid state changes. If a session flips between waiting/working quickly, only the first notification fires within the cooldown window.

## Per-Session Mute

Mute individual sessions to suppress all notifications (both browser and push) for that session.

- Toggle via `Cmd/Ctrl+Shift+M` or the mute button in the toolbar
- Mute state is synced between web and mobile via the daemon
- Muted sessions still show status changes in the UI — just no notifications

## Per-Server Preferences

Each server connection can have its own notification preferences (instant vs delayed, quiet hours). Configure in the server edit screen.

## Usage Threshold Alerts

The usage dashboard can send push notifications when utilization crosses configurable thresholds (50%, 75%, 90%, 95%). These use the same FCM pipeline as session notifications.

## Devices

The daemon tracks registered push devices. You can view and remove devices via the escalation settings screen in the app.

## Away Digest

When you return after 5+ minutes of inactivity, a "While you were away" banner summarizes what happened — completed sessions, waiting sessions, and errors. This is built from the daemon's notification history (persisted to disk).
