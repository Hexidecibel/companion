package com.hexidecibel.companion.herald

import java.io.InputStream
import java.security.MessageDigest

/**
 * Pure checks for the sideload updater (no Android types, unit-tested on the JVM:
 * android/src/test/.../UpdateChecksTest.kt). ApkUpdater feeds them what the
 * PackageManager reports for the installed app and the downloaded archive.
 */
object UpdateChecks {
    fun normalizeHex(s: String): String = s.replace(":", "").trim().lowercase()

    fun isSha256Hex(s: String): Boolean = Regex("^[0-9a-f]{64}$").matches(normalizeHex(s))

    /** Streams [input] through SHA-256 (lowercase hex); [onBytes] gets running totals. */
    fun sha256Hex(input: InputStream, onBytes: ((Long) -> Unit)? = null): String {
        val md = MessageDigest.getInstance("SHA-256")
        val buf = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            md.update(buf, 0, n)
            total += n
            onBytes?.invoke(total)
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    fun hashMatches(expected: String, actual: String): Boolean =
        isSha256Hex(expected) && isSha256Hex(actual) && normalizeHex(expected) == normalizeHex(actual)

    /** Same non-empty set of signing certificate digests (order-insensitive). */
    fun sameSigners(installed: Collection<String>, apk: Collection<String>): Boolean {
        val a = installed.map { normalizeHex(it) }.toSet()
        val b = apk.map { normalizeHex(it) }.toSet()
        return a.isNotEmpty() && a == b
    }

    /** True when the feed offers something newer than what is installed. */
    fun isNewer(feedVersionCode: Long, installedVersionCode: Long): Boolean =
        feedVersionCode > installedVersionCode

    /**
     * null when the downloaded archive may be handed to the system installer,
     * else the reason it may not (the file is deleted by the caller).
     */
    fun verifyArchive(
        installedPackage: String,
        installedVersionCode: Long,
        installedCerts: Collection<String>,
        expectedVersionCode: Long,
        expectedSha256: String,
        actualSha256: String,
        apkPackage: String?,
        apkVersionCode: Long,
        apkCerts: Collection<String>,
    ): String? {
        if (!hashMatches(expectedSha256, actualSha256)) return "checksum mismatch"
        if (apkPackage == null) return "not an Android package"
        if (apkPackage != installedPackage) return "package is $apkPackage, not $installedPackage"
        if (apkVersionCode != expectedVersionCode) return "version $apkVersionCode is not the advertised $expectedVersionCode"
        if (!isNewer(apkVersionCode, installedVersionCode)) return "version $apkVersionCode is not newer than installed $installedVersionCode"
        if (installedCerts.isEmpty()) return "cannot read the installed app's signing certificate"
        if (!sameSigners(installedCerts, apkCerts)) return "signed with a different certificate"
        return null
    }
}
