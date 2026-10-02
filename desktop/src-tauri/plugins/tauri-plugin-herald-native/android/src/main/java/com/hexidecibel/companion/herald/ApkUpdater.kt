package com.hexidecibel.companion.herald

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileInputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Sideload updater (Android only; the user always confirms in the system
 * installer, nothing installs silently).
 *
 * 1. `info()`: installed versionCode / versionName / signing certificates and
 *    whether "Install unknown apps" is granted to this app.
 * 2. `fetchFeed(url)`: the feed entry (android.json) over HTTPS (native, so
 *    no WebView CORS).
 * 3. `install(...)`: download into cache/updates, check the SHA-256 against the
 *    feed, check with PackageManager that the archive is this package, the
 *    advertised and a newer versionCode, and signed by the SAME certificates as
 *    the installed app (UpdateChecks.verifyArchive); then hand it to the system
 *    installer through the app's FileProvider (ACTION_VIEW). A verified file is
 *    kept until the next install so "allow, then tap Install again" does not
 *    download twice.
 */
class ApkUpdater(private val activity: Activity) {
    class UpdateError(val code: String, message: String) : Exception(message)

    private val pm: PackageManager get() = activity.packageManager
    private val pkg: String get() = activity.packageName
    private val dir: File get() = File(activity.cacheDir, "updates").apply { mkdirs() }

    fun canInstall(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) pm.canRequestPackageInstalls() else true

    fun installedInfo(): PackageInfo = packageInfo(pkg)

    fun installedCode(): Long = versionCodeOf(installedInfo())

    fun installedCerts(): List<String> = certsOf(installedInfo())

    fun fetchFeed(url: String): String {
        val conn = open(url, 10_000)
        try {
            if (conn.responseCode != 200) throw UpdateError("feed_failed", "feed answered ${conn.responseCode}")
            val bytes = conn.inputStream.use { s -> s.readNBytesCompat(MAX_FEED_BYTES) }
            return String(bytes, Charsets.UTF_8)
        } finally {
            conn.disconnect()
        }
    }

    /** Returns the verified APK file (download skipped when a verified copy exists). */
    fun downloadVerified(url: String, sha256: String, versionCode: Long, onProgress: (Long, Long) -> Unit): File {
        if (!UpdateChecks.isSha256Hex(sha256)) throw UpdateError("verify_failed", "feed has no valid sha256")
        val target = File(dir, "companion-$versionCode.apk")
        if (target.exists()) {
            val have = FileInputStream(target).use { UpdateChecks.sha256Hex(it) }
            if (UpdateChecks.hashMatches(sha256, have) && verify(target, sha256, have, versionCode) == null) return target
            target.delete()
        }
        dir.listFiles()?.forEach { if (it.name != target.name) it.delete() }

        val part = File(dir, "${target.name}.part")
        val conn = open(url, 60_000)
        val actual: String
        try {
            if (conn.responseCode != 200) throw UpdateError("download_failed", "download answered ${conn.responseCode}")
            val total = conn.contentLengthLong
            if (total > MAX_APK_BYTES) throw UpdateError("download_failed", "update is too large")
            var lastReport = 0L
            actual = conn.inputStream.use { input ->
                part.outputStream().use { out ->
                    val tee = object : java.io.FilterInputStream(input) {
                        override fun read(b: ByteArray, off: Int, len: Int): Int {
                            val n = super.read(b, off, len)
                            if (n > 0) out.write(b, off, n)
                            return n
                        }
                    }
                    UpdateChecks.sha256Hex(tee) { got ->
                        if (got > MAX_APK_BYTES) throw UpdateError("download_failed", "update is too large")
                        if (got - lastReport >= 256 * 1024 || got == total) {
                            lastReport = got
                            onProgress(got, total)
                        }
                    }
                }
            }
        } catch (e: UpdateError) {
            part.delete()
            throw e
        } catch (e: Exception) {
            part.delete()
            throw UpdateError("download_failed", e.message ?: "download failed")
        } finally {
            conn.disconnect()
        }
        val reason = verify(part, sha256, actual, versionCode)
        if (reason != null) {
            part.delete()
            throw UpdateError("verify_failed", reason)
        }
        if (!part.renameTo(target)) {
            part.delete()
            throw UpdateError("download_failed", "could not store the update")
        }
        return target
    }

    /** Opens the system installer for a verified file (user confirms). */
    fun launchInstaller(apk: File) {
        if (!canInstall()) throw UpdateError("install_permission", "Install unknown apps is not allowed for Companion")
        val uri = FileProvider.getUriForFile(activity, "$pkg.fileprovider", apk)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        activity.startActivity(intent)
    }

    /** "Install unknown apps" for this app (Android 8+), else the security settings. */
    fun openInstallSettings() {
        val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$pkg"))
        } else {
            @Suppress("DEPRECATION")
            Intent(Settings.ACTION_SECURITY_SETTINGS)
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        activity.startActivity(intent)
    }

    private fun verify(file: File, expectedSha: String, actualSha: String, versionCode: Long): String? {
        val archive = archiveInfo(file)
        return UpdateChecks.verifyArchive(
            installedPackage = pkg,
            installedVersionCode = installedCode(),
            installedCerts = installedCerts(),
            expectedVersionCode = versionCode,
            expectedSha256 = expectedSha,
            actualSha256 = actualSha,
            apkPackage = archive?.packageName,
            apkVersionCode = archive?.let { versionCodeOf(it) } ?: -1,
            apkCerts = archive?.let { certsOfArchive(it) } ?: emptyList(),
        )
    }

    private fun open(url: String, readTimeout: Int): HttpURLConnection {
        val u = URL(url)
        if (u.protocol != "https") throw UpdateError("bad_url", "update URLs must be https")
        val conn = u.openConnection() as HttpURLConnection
        conn.connectTimeout = 15_000
        conn.readTimeout = readTimeout
        conn.instanceFollowRedirects = true
        conn.setRequestProperty("Cache-Control", "no-cache")
        return conn
    }

    @Suppress("DEPRECATION")
    private fun packageInfo(name: String): PackageInfo {
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) PackageManager.GET_SIGNING_CERTIFICATES
        else PackageManager.GET_SIGNATURES
        return if (Build.VERSION.SDK_INT >= 33) pm.getPackageInfo(name, PackageManager.PackageInfoFlags.of(flags.toLong()))
        else pm.getPackageInfo(name, flags)
    }

    @Suppress("DEPRECATION")
    private fun archiveInfo(file: File): PackageInfo? {
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P)
            PackageManager.GET_SIGNING_CERTIFICATES or PackageManager.GET_SIGNATURES
        else PackageManager.GET_SIGNATURES
        return if (Build.VERSION.SDK_INT >= 33) pm.getPackageArchiveInfo(file.path, PackageManager.PackageInfoFlags.of(flags.toLong()))
        else pm.getPackageArchiveInfo(file.path, flags)
    }

    @Suppress("DEPRECATION")
    private fun versionCodeOf(info: PackageInfo): Long =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()

    @Suppress("DEPRECATION")
    private fun certsOf(info: PackageInfo): List<String> {
        val sigs: Array<Signature>? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val si = info.signingInfo
            when {
                si == null -> info.signatures
                si.hasMultipleSigners() -> si.apkContentsSigners
                else -> si.signingCertificateHistory
            }
        } else info.signatures
        return sigs.orEmpty().map { UpdateChecks.sha256Hex(it.toByteArray()) }
    }

    /** Archives: signingInfo when the platform parsed it, else the v1 signatures. */
    @Suppress("DEPRECATION")
    private fun certsOfArchive(info: PackageInfo): List<String> {
        val primary = certsOf(info)
        return if (primary.isNotEmpty()) primary else info.signatures.orEmpty().map { UpdateChecks.sha256Hex(it.toByteArray()) }
    }

    private fun java.io.InputStream.readNBytesCompat(max: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val buf = ByteArray(8192)
        while (true) {
            val n = read(buf)
            if (n < 0) break
            out.write(buf, 0, n)
            if (out.size() > max) throw UpdateError("feed_failed", "feed is too large")
        }
        return out.toByteArray()
    }

    companion object {
        const val MAX_FEED_BYTES = 64 * 1024
        const val MAX_APK_BYTES = 400L * 1024 * 1024
    }
}
