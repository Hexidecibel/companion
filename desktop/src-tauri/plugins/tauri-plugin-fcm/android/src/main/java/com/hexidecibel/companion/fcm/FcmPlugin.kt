package com.hexidecibel.companion.fcm

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.firebase.messaging.FirebaseMessaging

private const val TAG = "FcmPlugin"
private const val PERMISSION_REQUEST_CODE = 9877

@TauriPlugin
class FcmPlugin(private val activity: android.app.Activity) : Plugin(activity) {

    companion object {
        @Volatile
        var instance: FcmPlugin? = null
            private set
    }

    override fun load(webView: android.webkit.WebView) {
        super.load(webView)
        instance = this
        Log.d(TAG, "FCM plugin loaded")
    }

    @Command
    fun getToken(invoke: Invoke) {
        FirebaseMessaging.getInstance().token
            .addOnSuccessListener { token ->
                Log.d(TAG, "FCM token: ${token.take(20)}...")
                val ret = JSObject()
                ret.put("token", token)
                invoke.resolve(ret)
            }
            .addOnFailureListener { e ->
                Log.e(TAG, "Failed to get FCM token", e)
                val ret = JSObject()
                ret.put("token", JSObject.NULL)
                invoke.resolve(ret)
            }
    }

    @Command
    fun requestPermission(invoke: Invoke) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val granted = ContextCompat.checkSelfPermission(
                activity,
                Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED

            if (granted) {
                val ret = JSObject()
                ret.put("granted", true)
                invoke.resolve(ret)
            } else {
                ActivityCompat.requestPermissions(
                    activity,
                    arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                    PERMISSION_REQUEST_CODE
                )
                // For simplicity, resolve immediately — the permission dialog is async.
                // The web client should call isPermissionGranted after a delay to verify.
                val ret = JSObject()
                ret.put("granted", false)
                invoke.resolve(ret)
            }
        } else {
            // Pre-Android 13: notifications are allowed by default
            val ret = JSObject()
            ret.put("granted", true)
            invoke.resolve(ret)
        }
    }

    @Command
    fun isPermissionGranted(invoke: Invoke) {
        val granted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.checkSelfPermission(
                activity,
                Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
        } else {
            true
        }
        val ret = JSObject()
        ret.put("granted", granted)
        invoke.resolve(ret)
    }

    /**
     * Called from FcmService when a new token is issued.
     * Emits a "tokenRefresh" event to the web client.
     */
    fun onTokenRefresh(token: String) {
        val data = JSObject()
        data.put("token", token)
        trigger("tokenRefresh", data)
    }

    /**
     * Called from FcmService when a push notification is received in the foreground.
     * Emits a "notificationReceived" event to the web client.
     */
    fun onNotificationReceived(title: String?, body: String?, data: Map<String, String>) {
        val obj = JSObject()
        obj.put("title", title ?: "")
        obj.put("body", body ?: "")
        val dataObj = JSObject()
        for ((key, value) in data) {
            dataObj.put(key, value)
        }
        obj.put("data", dataObj)
        trigger("notificationReceived", obj)
    }
}
