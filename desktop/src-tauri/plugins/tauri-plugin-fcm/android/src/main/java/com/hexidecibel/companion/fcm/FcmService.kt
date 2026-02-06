package com.hexidecibel.companion.fcm

import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

private const val TAG = "FcmService"

/**
 * Firebase Messaging Service that handles:
 * 1. Token refresh events — forwards to FcmPlugin for re-registration with daemon
 * 2. Foreground message receipt — forwards to FcmPlugin for web client event
 *
 * Background/notification messages are handled automatically by Firebase
 * and shown in the system tray.
 */
class FcmService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        Log.d(TAG, "FCM token refreshed: ${token.take(20)}...")
        FcmPlugin.instance?.onTokenRefresh(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)
        Log.d(TAG, "FCM message received from: ${message.from}")

        val title = message.notification?.title
        val body = message.notification?.body
        val data = message.data

        // Forward to plugin for foreground handling
        FcmPlugin.instance?.onNotificationReceived(title, body, data)
    }
}
