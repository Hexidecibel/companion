# Privacy Policy

**Companion**
Last updated: February 2026

## Overview

Companion is a self-hosted application. Your data stays on your own server and devices. We do not collect, store, or transmit any user data to external services.

## How Companion Works

Companion consists of a daemon (server component) that you run on your own machine, and client apps (Android, iOS, web, desktop) that connect to your daemon over your local network or the internet. All communication happens directly between your devices and your self-hosted server.

## Data Collection

**We do not collect any data.** Specifically:

- No analytics or telemetry
- No crash reporting sent to us
- No usage tracking
- No advertising
- No user accounts on our servers
- No data shared with third parties

## Data Stored on Your Devices

The client apps store the following locally on your device:

- **Server connection details** (IP address, port, authentication token) in local storage or the platform keychain
- **Push notification tokens** (if you enable push notifications) — sent only to your own daemon server
- **UI preferences** (theme, layout settings, muted sessions) in local storage

## Data Stored on Your Server

The daemon you run on your own server stores:

- **Configuration** (port, token, TLS settings) at `~/.companion/config.json`
- **Session mappings** and **notification history** at `~/.companion/`
- **Push notification device tokens** (if push is configured) — stored only on your server

All of this data lives on hardware you control.

## Firebase Cloud Messaging

If you choose to enable push notifications, the app uses Firebase Cloud Messaging (FCM) to deliver notifications to your mobile device. This requires:

- A Firebase project that **you** create and control
- FCM credentials stored on **your** server
- A device token sent from your device to **your** daemon

Google processes the push message delivery through FCM infrastructure. The notification payload contains only a summary (e.g., "Session waiting for input") and no conversation content. See [Google's privacy policy](https://policies.google.com/privacy) for how FCM handles message delivery.

Push notifications are entirely optional. The app works fully without them.

## Network Communication

All network traffic between your devices and your daemon uses WebSocket connections. TLS encryption is supported and recommended for connections over the internet. No data is sent to any server other than the daemon you operate.

## Third-Party Services

Companion does not integrate with any third-party analytics, advertising, or tracking services. The only external service interaction is FCM for push notifications, which is optional and configured by you.

## Children's Privacy

Companion is a developer tool and is not directed at children under 13. We do not knowingly collect information from children.

## Changes to This Policy

If this privacy policy changes, the updated version will be published in the project repository.

## Contact

For questions about this privacy policy, open an issue at [github.com/Hexidecibel/companion](https://github.com/Hexidecibel/companion/issues).
