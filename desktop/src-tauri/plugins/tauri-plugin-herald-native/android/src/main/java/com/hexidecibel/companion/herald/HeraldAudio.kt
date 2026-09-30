package com.hexidecibel.companion.herald

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import app.tauri.plugin.Channel
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject

private const val TAG = "HeraldAudio"

/** Capture rate: what Herald's STT / VAD want; the page upsamples into its graph. */
const val CAPTURE_RATE = 16000
/** 40 ms per message: low latency for the VAD, ~25 messages a second over the bridge. */
private const val CHUNK_SAMPLES = 640

// AudioDeviceInfo types newer than minSdk, by value.
private const val TYPE_USB_HEADSET = 22
private const val TYPE_BUILTIN_SPEAKER_SAFE = 24
private const val TYPE_REMOTE_SUBMIX = 25
private const val TYPE_BLE_HEADSET = 26
private const val TYPE_BLE_SPEAKER = 27
private const val TYPE_HDMI_EARC = 29
private const val TYPE_BLE_BROADCAST = 30

/**
 * Herald's native microphone and audio route on Android.
 *
 * Why capture natively: when the WebView opens the mic (getUserMedia),
 * Chromium switches the phone into communication mode, and with Bluetooth
 * earbuds connected that starts SCO: the earbuds drop from A2DP (music
 * quality) to a phone call for as long as Herald listens, music included.
 * An AudioRecord on the built-in mic with the VOICE_RECOGNITION source never
 * touches the audio mode or SCO, so the earbuds stay in A2DP. The page gets the
 * PCM over a channel and feeds it into its own audio graph, where the in-graph
 * echo canceller (WebRTC AEC3) handles the phone speaker case.
 *
 * `aec = true` uses VOICE_COMMUNICATION + the platform AcousticEchoCanceler
 * instead (off by default: quality varies by device, and many devices only run
 * it in communication mode, which is the trap above).
 */
class HeraldAudio(private val context: Context, private val onRoute: (JSObject) -> Unit) {
    private val am: AudioManager
        get() = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val main = Handler(Looper.getMainLooper())
    private var record: AudioRecord? = null
    private var echo: AcousticEchoCanceler? = null
    private var thread: Thread? = null
    @Volatile private var running = false
    private var avoidBluetooth = true
    private var registered = false

    private val deviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) = routeChanged()
        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) = routeChanged()
    }

    fun listen() {
        if (registered) return
        am.registerAudioDeviceCallback(deviceCallback, main)
        registered = true
    }

    fun dispose() {
        stop()
        if (registered) am.unregisterAudioDeviceCallback(deviceCallback)
        registered = false
    }

    private fun routeChanged() {
        // A headset came or went: keep capturing from the built-in mic.
        record?.let { r -> if (avoidBluetooth) builtinMic()?.let { r.setPreferredDevice(it) } }
        try {
            onRoute(route())
        } catch (e: Exception) {
            Log.w(TAG, "route event", e)
        }
    }

    // ---- route ------------------------------------------------------------------

    private fun port(d: AudioDeviceInfo): JSObject {
        val o = JSObject()
        val (type, profile) = when (d.type) {
            AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, TYPE_BUILTIN_SPEAKER_SAFE -> "builtin-speaker" to null
            AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "builtin-receiver" to null
            AudioDeviceInfo.TYPE_BUILTIN_MIC -> "builtin-mic" to null
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "wired-headphones" to null
            AudioDeviceInfo.TYPE_WIRED_HEADSET -> "wired-headset" to null
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "bluetooth" to "a2dp"
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "bluetooth" to "hfp"
            TYPE_BLE_HEADSET, TYPE_BLE_SPEAKER, TYPE_BLE_BROADCAST -> "bluetooth" to "le"
            TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_USB_DEVICE, AudioDeviceInfo.TYPE_USB_ACCESSORY -> "usb" to null
            AudioDeviceInfo.TYPE_HDMI, AudioDeviceInfo.TYPE_HDMI_ARC, TYPE_HDMI_EARC -> "hdmi" to null
            AudioDeviceInfo.TYPE_LINE_ANALOG, AudioDeviceInfo.TYPE_LINE_DIGITAL, AudioDeviceInfo.TYPE_AUX_LINE -> "jack" to null
            TYPE_REMOTE_SUBMIX, AudioDeviceInfo.TYPE_TELEPHONY -> "virtual" to null
            else -> "unknown" to null
        }
        o.put("type", type)
        if (profile != null) o.put("profile", profile)
        o.put("name", d.productName?.toString() ?: "")
        o.put("id", d.id.toString())
        return o
    }

    /** Where media plays right now (API 33+ asks the policy; older: the usual priority). */
    private fun mediaOutputs(): List<AudioDeviceInfo> {
        if (Build.VERSION.SDK_INT >= 33) {
            val attrs = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).build()
            val devs = am.getAudioDevicesForAttributes(attrs)
            if (devs.isNotEmpty()) return devs
        }
        val outs = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
        val priority = intArrayOf(
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, TYPE_BLE_HEADSET, TYPE_BLE_SPEAKER, TYPE_USB_HEADSET,
            AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_USB_DEVICE,
            AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
        )
        for (t in priority) outs.firstOrNull { it.type == t }?.let { return listOf(it) }
        return emptyList()
    }

    private fun builtinMic(): AudioDeviceInfo? =
        am.getDevices(AudioManager.GET_DEVICES_INPUTS).firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_MIC }

    fun route(): JSObject {
        val r = JSObject()
        r.put("platform", "android")
        val outs = JSArray()
        for (d in mediaOutputs()) outs.put(port(d))
        r.put("outputs", outs)
        val inputs = JSArray()
        val routed = record?.routedDevice
        val current = routed ?: builtinMic()
        if (current != null) inputs.put(port(current))
        r.put("inputs", inputs)
        val avail = JSArray()
        for (d in am.getDevices(AudioManager.GET_DEVICES_INPUTS)) avail.put(port(d))
        r.put("availableInputs", avail)
        return r
    }

    // ---- capture ----------------------------------------------------------------

    val capturing: Boolean
        get() = running

    /** Start capturing (RECORD_AUDIO already granted). Returns what was opened. */
    @Synchronized
    fun start(aec: Boolean, avoidBluetooth: Boolean, channel: Channel): JSObject {
        stop()
        this.avoidBluetooth = avoidBluetooth
        val source = if (aec) MediaRecorder.AudioSource.VOICE_COMMUNICATION else MediaRecorder.AudioSource.VOICE_RECOGNITION
        val minBuf = AudioRecord.getMinBufferSize(CAPTURE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val bufBytes = maxOf(minBuf, CAPTURE_RATE / 5 * 2) // at least 200 ms
        @Suppress("MissingPermission")
        val rec = AudioRecord(source, CAPTURE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufBytes)
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            rec.release()
            throw IllegalStateException("microphone busy or unavailable")
        }
        if (avoidBluetooth) builtinMic()?.let { rec.setPreferredDevice(it) }
        var aecOn = false
        if (aec && AcousticEchoCanceler.isAvailable()) {
            echo = AcousticEchoCanceler.create(rec.audioSessionId)?.also {
                it.enabled = true
                aecOn = it.enabled
            }
        }
        rec.startRecording()
        if (rec.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
            rec.release()
            echo?.release()
            echo = null
            throw IllegalStateException("microphone could not start (another app may be using it)")
        }
        record = rec
        running = true
        val t = Thread({ pump(rec, channel) }, "HeraldMic")
        t.priority = Thread.MAX_PRIORITY
        thread = t
        t.start()
        val res = JSObject()
        res.put("sampleRate", CAPTURE_RATE)
        res.put("aec", aecOn)
        res.put("device", (rec.routedDevice ?: builtinMic())?.productName?.toString() ?: "Phone microphone")
        res.put("deviceType", (rec.routedDevice ?: builtinMic())?.let { port(it).getString("type") } ?: "builtin-mic")
        return res
    }

    private fun pump(rec: AudioRecord, channel: Channel) {
        val frame = ShortArray(CHUNK_SAMPLES)
        val bytes = ByteArray(CHUNK_SAMPLES * 2)
        var seq = 0L
        while (running) {
            var n = 0
            while (n < CHUNK_SAMPLES && running) {
                val r = rec.read(frame, n, CHUNK_SAMPLES - n)
                if (r < 0) {
                    Log.w(TAG, "read error $r")
                    running = false
                    val end = JSObject()
                    end.put("ended", true)
                    end.put("error", "read $r")
                    try { channel.send(end) } catch (_: Exception) {}
                    return
                }
                n += r
            }
            if (n < CHUNK_SAMPLES) break
            for (i in 0 until CHUNK_SAMPLES) {
                val v = frame[i].toInt()
                bytes[2 * i] = (v and 0xff).toByte()
                bytes[2 * i + 1] = ((v shr 8) and 0xff).toByte()
            }
            val msg = JSObject()
            msg.put("pcm", Base64.encodeToString(bytes, Base64.NO_WRAP))
            msg.put("seq", seq++)
            try {
                channel.send(msg)
            } catch (e: Exception) {
                Log.w(TAG, "channel send", e)
            }
        }
    }

    @Synchronized
    fun stop() {
        running = false
        thread?.let { t ->
            try {
                t.join(300)
            } catch (_: InterruptedException) {}
        }
        thread = null
        record?.let {
            try {
                it.stop()
            } catch (_: Exception) {}
            it.release()
        }
        record = null
        echo?.release()
        echo = null
    }
}
