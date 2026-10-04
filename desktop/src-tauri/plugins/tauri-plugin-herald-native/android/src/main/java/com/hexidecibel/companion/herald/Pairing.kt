package com.hexidecibel.companion.herald

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log

private const val TAG = "HeraldPairing"

/** Pure helpers (unit-tested on the JVM). */
object PairingText {
    /** A `companion://pair?...` link, else null. */
    fun companionLink(uri: String?): String? {
        if (uri == null) return null
        val t = uri.trim()
        return if (t.startsWith("companion://pair", ignoreCase = true) && t.length <= 2048) t else null
    }

    /** TXT attributes as strings (missing / invalid UTF-8 values become ""). */
    fun txt(attrs: Map<String, ByteArray?>): Map<String, String> =
        attrs.mapValues { (_, v) -> v?.let { String(it, Charsets.UTF_8) } ?: "" }

    /** IPv4 first; drop loopback / link-local IPv6 that a WebView cannot dial. */
    fun orderAddresses(addrs: List<String>): List<String> =
        addrs.filter { !it.startsWith("127.") && !it.lowercase().startsWith("fe80") && it != "::1" }
            .distinct()
            .sortedBy { if (it.contains(':')) 1 else 0 }
}

data class FoundDaemon(
    val name: String,
    val host: String,
    val addresses: List<String>,
    val port: Int,
    val txt: Map<String, String>,
)

/**
 * Browse `_companion._tcp` for a fixed time and resolve what turns up. Resolves
 * run one at a time (older Android allows only one in flight).
 */
class NsdBrowser(context: Context) {
    private val nsd = context.applicationContext.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val main = Handler(Looper.getMainLooper())

    fun browse(timeoutMs: Long, done: (List<FoundDaemon>) -> Unit) {
        val queue = ArrayDeque<NsdServiceInfo>()
        val seen = HashSet<String>()
        val results = LinkedHashMap<String, FoundDaemon>()
        var resolving = false
        var finished = false

        fun next() {
            if (finished || resolving) return
            val info = queue.removeFirstOrNull() ?: return
            resolving = true
            @Suppress("DEPRECATION")
            nsd.resolveService(info, object : NsdManager.ResolveListener {
                override fun onResolveFailed(si: NsdServiceInfo, errorCode: Int) {
                    main.post {
                        resolving = false
                        next()
                    }
                }

                override fun onServiceResolved(si: NsdServiceInfo) {
                    main.post {
                        resolving = false
                        val addrs = mutableListOf<String>()
                        if (Build.VERSION.SDK_INT >= 34) {
                            si.hostAddresses.forEach { a -> a.hostAddress?.let { addrs.add(it) } }
                        } else {
                            @Suppress("DEPRECATION")
                            si.host?.hostAddress?.let { addrs.add(it) }
                        }
                        val ordered = PairingText.orderAddresses(addrs)
                        if (ordered.isNotEmpty()) {
                            results[si.serviceName] = FoundDaemon(
                                name = si.serviceName,
                                host = ordered.first(),
                                addresses = ordered,
                                port = si.port,
                                txt = PairingText.txt(si.attributes),
                            )
                        }
                        next()
                    }
                }
            })
        }

        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {}
            override fun onDiscoveryStopped(serviceType: String) {}
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                Log.w(TAG, "discovery failed: $errorCode")
            }
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
            override fun onServiceLost(si: NsdServiceInfo) {}
            override fun onServiceFound(si: NsdServiceInfo) {
                main.post {
                    if (seen.add(si.serviceName)) {
                        queue.addLast(si)
                        next()
                    }
                }
            }
        }

        try {
            nsd.discoverServices("_companion._tcp", NsdManager.PROTOCOL_DNS_SD, listener)
        } catch (e: Exception) {
            Log.w(TAG, "discoverServices threw", e)
            done(emptyList())
            return
        }
        main.postDelayed({
            finished = true
            try {
                nsd.stopServiceDiscovery(listener)
            } catch (_: Exception) {
            }
            done(results.values.toList())
        }, timeoutMs.coerceIn(500, 10_000))
    }
}
