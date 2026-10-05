package com.hexidecibel.companion.herald

import android.Manifest
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
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

private const val TAG = "HeraldNative"

@InvokeArg
class ActiveArgs {
    var active: Boolean = false
}

@InvokeArg
class DiscoverArgs {
    var timeoutMs: Long = 3000
}

@InvokeArg
class FeedArgs {
    var url: String = ""
}

@InvokeArg
class InstallUpdateArgs {
    var url: String = ""
    var sha256: String = ""
    var versionCode: Long = 0
    var onProgress: Channel? = null
}

@InvokeArg
class SecureKeyArgs {
    var key: String = ""
}

@InvokeArg
class SecureSetArgs {
    var key: String = ""
    var value: String = ""
}

@InvokeArg
class CaptureArgs {
    /** Platform echo cancellation (VOICE_COMMUNICATION + AcousticEchoCanceler). */
    var aec: Boolean = false
    /** Capture from the built-in mic even when a Bluetooth headset is connected (keeps it in A2DP). */
    var avoidBluetooth: Boolean = true
    lateinit var onAudio: Channel
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
@TauriPlugin(permissions = [Permission(strings = [Manifest.permission.RECORD_AUDIO], alias = "microphone")])
class HeraldNativePlugin(private val activity: Activity) : Plugin(activity) {
    private val updater = ApkUpdater(activity)
    private val audio = HeraldAudio(activity.applicationContext) { route -> trigger("audioRoute", route) }
    private val nsdBrowser = NsdBrowser(activity)
    /** A companion:// link that arrived before the page listened (cold start). */
    private var pendingLink: String? = null
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
        // Route changes (earbuds, headset, USB) go to the page as `audioRoute` events.
        audio.listen()
        // Cold start from a companion:// link: keep it until the page asks.
        PairingText.companionLink(activity.intent?.dataString)?.let { pendingLink = it }
    }

    // ---- pairing ----

    /** singleTask: a companion:// link while running arrives here; the page listens for `deepLink`. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val url = PairingText.companionLink(intent.dataString) ?: return
        val out = JSObject()
        out.put("url", url)
        trigger("deepLink", out)
    }

    @Command
    fun takePendingLink(invoke: Invoke) {
        val out = JSObject()
        pendingLink?.let { out.put("url", it) }
        pendingLink = null
        invoke.resolve(out)
    }

    /** Browse mDNS for Companion daemons; resolves { daemons: [{ name, host, addresses, port, txt }] }. */
    @Command
    fun discoverDaemons(invoke: Invoke) {
        val args = invoke.parseArgs(DiscoverArgs::class.java)
        activity.runOnUiThread {
            nsdBrowser.browse(args.timeoutMs) { found ->
                val list = org.json.JSONArray()
                for (d in found) {
                    val o = JSObject()
                    o.put("name", d.name)
                    o.put("host", d.host)
                    o.put("addresses", org.json.JSONArray(d.addresses))
                    o.put("port", d.port)
                    val t = JSObject()
                    d.txt.forEach { (k, v) -> t.put(k, v) }
                    o.put("txt", t)
                    list.put(o)
                }
                val out = JSObject()
                out.put("daemons", list)
                invoke.resolve(out)
            }
        }
    }

    override fun onDestroy() {
        audio.dispose()
        super.onDestroy()
    }

    // ---- secure storage (paired-device tokens; SecureStore.kt) ----

    private val secure by lazy { SecureStore.forContext(activity) }

    /** Resolves { value } (absent when there is none or it cannot be read). */
    @Command
    fun secureGet(invoke: Invoke) {
        val args = invoke.parseArgs(SecureKeyArgs::class.java)
        Thread {
            try {
                val out = JSObject()
                secure.get(args.key)?.let { out.put("value", it) }
                invoke.resolve(out)
            } catch (e: Exception) {
                invoke.reject("secure_get failed: ${e.message}")
            }
        }.start()
    }

    @Command
    fun secureSet(invoke: Invoke) {
        val args = invoke.parseArgs(SecureSetArgs::class.java)
        Thread {
            try {
                secure.set(args.key, args.value)
                invoke.resolve(JSObject())
            } catch (e: Exception) {
                invoke.reject("secure_set failed: ${e.message}")
            }
        }.start()
    }

    @Command
    fun secureDelete(invoke: Invoke) {
        val args = invoke.parseArgs(SecureKeyArgs::class.java)
        Thread {
            try {
                secure.delete(args.key)
                invoke.resolve(JSObject())
            } catch (e: Exception) {
                invoke.reject("secure_delete failed: ${e.message}")
            }
        }.start()
    }

    // ---- sideload updater (ApkUpdater) ----

    /** Installed versionCode / versionName / signing certs + "Install unknown apps" state. */
    @Command
    fun appUpdateInfo(invoke: Invoke) {
        try {
            val info = updater.installedInfo()
            val out = JSObject()
            out.put("packageName", activity.packageName)
            out.put("versionCode", updater.installedCode())
            out.put("versionName", info.versionName ?: "")
            out.put("canInstall", updater.canInstall())
            out.put("sdk", Build.VERSION.SDK_INT)
            invoke.resolve(out)
        } catch (e: Exception) {
            invoke.reject(e.message ?: "update info failed")
        }
    }

    /** GET the feed entry (android.json) natively; resolves { body }. */
    @Command
    fun appUpdateFetchFeed(invoke: Invoke) {
        val args = invoke.parseArgs(FeedArgs::class.java)
        Thread {
            try {
                val out = JSObject()
                out.put("body", updater.fetchFeed(args.url))
                invoke.resolve(out)
            } catch (e: ApkUpdater.UpdateError) {
                invoke.reject("${e.code}: ${e.message}", e.code)
            } catch (e: Exception) {
                invoke.reject("feed_failed: ${e.message}", "feed_failed")
            }
        }.start()
    }

    /**
     * Download + verify (sha256, package, versionCode, same signing certificate),
     * then open the system installer. Rejects with code install_permission when
     * "Install unknown apps" is off (the verified file is kept for the retry),
     * verify_failed / download_failed / bad_url otherwise.
     */
    @Command
    fun appUpdateInstall(invoke: Invoke) {
        val args = invoke.parseArgs(InstallUpdateArgs::class.java)
        Thread {
            try {
                val apk = updater.downloadVerified(args.url, args.sha256, args.versionCode) { got, total ->
                    val p = JSObject()
                    p.put("received", got)
                    p.put("total", total)
                    args.onProgress?.send(p)
                }
                activity.runOnUiThread {
                    try {
                        updater.launchInstaller(apk)
                        val out = JSObject()
                        out.put("state", "installer_opened")
                        invoke.resolve(out)
                    } catch (e: ApkUpdater.UpdateError) {
                        invoke.reject("${e.code}: ${e.message}", e.code)
                    } catch (e: Exception) {
                        Log.e(TAG, "installer", e)
                        invoke.reject("install_failed: ${e.message}", "install_failed")
                    }
                }
            } catch (e: ApkUpdater.UpdateError) {
                Log.w(TAG, "update: ${e.code}: ${e.message}")
                invoke.reject("${e.code}: ${e.message}", e.code)
            } catch (e: Exception) {
                Log.e(TAG, "update", e)
                invoke.reject("download_failed: ${e.message}", "download_failed")
            }
        }.start()
    }

    /** Deep-link to "Install unknown apps" for Companion. */
    @Command
    fun appUpdateOpenSettings(invoke: Invoke) {
        activity.runOnUiThread {
            try {
                updater.openInstallSettings()
                invoke.resolve()
            } catch (e: Exception) {
                invoke.reject(e.message ?: "settings failed")
            }
        }
    }

    /** Current output / input ports (see HeraldAudio.route). */
    @Command
    fun getAudioRoute(invoke: Invoke) {
        try {
            invoke.resolve(audio.route())
        } catch (e: Exception) {
            invoke.reject(e.message ?: "audio route failed")
        }
    }

    /**
     * Native microphone -> the page (16 kHz PCM16 base64 chunks on `onAudio`).
     * Asks for RECORD_AUDIO first when needed (rejects with code NotAllowedError).
     */
    @Command
    fun startCapture(invoke: Invoke) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", invoke, "micPermissionCallback")
            return
        }
        doStartCapture(invoke)
    }

    @PermissionCallback
    private fun micPermissionCallback(invoke: Invoke) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) doStartCapture(invoke)
        else invoke.reject("Microphone permission denied", "NotAllowedError")
    }

    private fun doStartCapture(invoke: Invoke) {
        val args = invoke.parseArgs(CaptureArgs::class.java)
        try {
            invoke.resolve(audio.start(args.aec, args.avoidBluetooth, args.onAudio))
        } catch (e: Exception) {
            Log.e(TAG, "capture", e)
            invoke.reject(e.message ?: "capture failed", "NotReadableError")
        }
    }

    @Command
    fun stopCapture(invoke: Invoke) {
        audio.stop()
        invoke.resolve()
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
