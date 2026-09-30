package com.hexidecibel.companion.herald

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.util.Log
import android.view.KeyEvent
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

private const val TAG = "HeraldNative"

@InvokeArg
class ActiveArgs {
    var active: Boolean = false
}

/**
 * Herald voice glue for Android.
 *
 * Earbud / headset button: while Herald is enabled on this device the web layer
 * turns a MediaSession on. A play/pause (or headset hook) press becomes a
 * `media` plugin event `{ action: "toggle" }`, which the web layer runs exactly
 * like a remote trigger `toggle` (speaking: stop; listening: cancel; else listen).
 *
 * Android routes media buttons to the session of the app that played audio most
 * recently, so the earbud reaches Herald once Herald has spoken (or nothing else
 * has played since); starting music in another app takes the button back.
 *
 * Audio focus: while Herald speaks we hold AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK,
 * so music and podcasts duck under Herald instead of fighting it.
 */
@TauriPlugin
class HeraldNativePlugin(private val activity: Activity) : Plugin(activity) {
    private var session: MediaSession? = null
    private var focusRequest: AudioFocusRequest? = null
    private val focusListener = AudioManager.OnAudioFocusChangeListener { }

    private val audioManager: AudioManager
        get() = activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    override fun load(webView: WebView) {
        super.load(webView)
        // wry already sets this; make the TTS autoplay requirement explicit so a
        // reply triggered by an earbud press (no touch gesture) can play.
        webView.settings.mediaPlaybackRequiresUserGesture = false
    }

    @Command
    fun setMediaSession(invoke: Invoke) {
        val args = invoke.parseArgs(ActiveArgs::class.java)
        activity.runOnUiThread {
            try {
                if (args.active) enableSession() else disableSession()
                invoke.resolve()
            } catch (e: Exception) {
                Log.e(TAG, "media session", e)
                invoke.reject(e.message ?: "media session failed")
            }
        }
    }

    @Command
    fun setAudioFocus(invoke: Invoke) {
        val args = invoke.parseArgs(ActiveArgs::class.java)
        try {
            if (args.active) requestFocus() else abandonFocus()
            invoke.resolve()
        } catch (e: Exception) {
            Log.e(TAG, "audio focus", e)
            invoke.reject(e.message ?: "audio focus failed")
        }
    }

    private fun enableSession() {
        if (session != null) return
        val s = MediaSession(activity, "CompanionHerald")
        s.setCallback(object : MediaSession.Callback() {
            override fun onMediaButtonEvent(mediaButtonIntent: Intent): Boolean {
                val ev = keyEventOf(mediaButtonIntent) ?: return super.onMediaButtonEvent(mediaButtonIntent)
                return when (ev.keyCode) {
                    KeyEvent.KEYCODE_HEADSETHOOK,
                    KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
                    KeyEvent.KEYCODE_MEDIA_PLAY,
                    KeyEvent.KEYCODE_MEDIA_PAUSE -> {
                        // One action per press: act on the first down, swallow the rest.
                        if (ev.action == KeyEvent.ACTION_DOWN && ev.repeatCount == 0) emitToggle()
                        true
                    }
                    else -> super.onMediaButtonEvent(mediaButtonIntent)
                }
            }

            // Bluetooth AVRCP and system media controls may call these directly.
            override fun onPlay() = emitToggle()
            override fun onPause() = emitToggle()
        })
        s.setPlaybackState(
            PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE)
                .setState(PlaybackState.STATE_PAUSED, 0L, 1f)
                .build()
        )
        s.isActive = true
        session = s
        Log.d(TAG, "media session on")
    }

    private fun disableSession() {
        session?.let {
            it.isActive = false
            it.release()
        }
        session = null
        Log.d(TAG, "media session off")
    }

    private fun emitToggle() {
        val data = JSObject()
        data.put("action", "toggle")
        trigger("media", data)
    }

    @Suppress("DEPRECATION")
    private fun keyEventOf(intent: Intent): KeyEvent? =
        if (Build.VERSION.SDK_INT >= 33) {
            intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, KeyEvent::class.java)
        } else {
            intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT)
        }

    @Suppress("DEPRECATION")
    private fun requestFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val req = focusRequest ?: AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ASSISTANT)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                .setOnAudioFocusChangeListener(focusListener)
                .build()
            focusRequest = req
            audioManager.requestAudioFocus(req)
        } else {
            audioManager.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
        }
    }

    @Suppress("DEPRECATION")
    private fun abandonFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
        } else {
            audioManager.abandonAudioFocus(focusListener)
        }
    }
}
