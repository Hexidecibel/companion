package com.hexidecibel.companion.herald

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Secrets (paired-device tokens) at rest on Android.
 *
 * Each value is encrypted with AES-256-GCM under a key that lives in the
 * Android Keystore (hardware-backed where the device has it; the key never
 * leaves the Keystore and cannot be exported) and stored, encrypted, in a
 * private SharedPreferences file. The entry name is bound as associated data,
 * so a blob copied under another name does not decrypt. A value that does not
 * decrypt (tampered, restored from a backup onto another device whose
 * Keystore lacks the key) reads as missing: the app then asks to pair again.
 *
 * The storage and cipher are injected so the format is unit tested on the JVM
 * with a software key (SecureStoreTest); production uses the Keystore key.
 */
interface KeyValueStore {
    fun get(key: String): String?
    fun put(key: String, value: String)
    fun remove(key: String)
}

interface ValueCipher {
    fun encrypt(plain: ByteArray, aad: ByteArray): ByteArray
    fun decrypt(blob: ByteArray, aad: ByteArray): ByteArray
}

/** AES/GCM/NoPadding; blob = version(1) | ivLen(1) | iv | ciphertext+tag. */
class AesGcmCipher(private val key: () -> SecretKey) : ValueCipher {
    override fun encrypt(plain: ByteArray, aad: ByteArray): ByteArray {
        val c = Cipher.getInstance(TRANSFORMATION)
        // The provider picks a fresh random IV (Keystore keys require that).
        c.init(Cipher.ENCRYPT_MODE, key())
        c.updateAAD(aad)
        val ct = c.doFinal(plain)
        val iv = c.iv
        require(iv.size in 1..255) { "bad iv" }
        return byteArrayOf(VERSION, iv.size.toByte()) + iv + ct
    }

    override fun decrypt(blob: ByteArray, aad: ByteArray): ByteArray {
        require(blob.size > 2 && blob[0] == VERSION) { "unknown format" }
        val ivLen = blob[1].toInt() and 0xff
        require(ivLen > 0 && blob.size > 2 + ivLen) { "truncated" }
        val iv = blob.copyOfRange(2, 2 + ivLen)
        val c = Cipher.getInstance(TRANSFORMATION)
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, iv))
        c.updateAAD(aad)
        return c.doFinal(blob, 2 + ivLen, blob.size - 2 - ivLen)
    }

    companion object {
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val TAG_BITS = 128
        const val VERSION: Byte = 1
    }
}

/** The app's AES key in the Android Keystore, created on first use. */
object KeystoreKeys {
    private const val PROVIDER = "AndroidKeyStore"

    fun getOrCreate(alias: String): SecretKey {
        val ks = KeyStore.getInstance(PROVIDER)
        ks.load(null)
        (ks.getKey(alias, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
        gen.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build()
        )
        return gen.generateKey()
    }
}

/** Private SharedPreferences, written synchronously (a token must not be lost to a kill). */
class PrefsKeyValueStore(context: Context, file: String = "companion_secure") : KeyValueStore {
    private val prefs = context.getSharedPreferences(file, Context.MODE_PRIVATE)
    override fun get(key: String): String? = prefs.getString(key, null)
    override fun put(key: String, value: String) {
        check(prefs.edit().putString(key, value).commit()) { "could not save" }
    }
    override fun remove(key: String) {
        prefs.edit().remove(key).commit()
    }
}

class SecureStore(private val store: KeyValueStore, private val cipher: ValueCipher) {
    /** The decrypted value, or null when absent or unreadable. */
    fun get(name: String): String? {
        checkName(name)
        val enc = store.get(PREFIX + name) ?: return null
        return try {
            String(cipher.decrypt(fromHex(enc), aad(name)), Charsets.UTF_8)
        } catch (e: Exception) {
            null
        }
    }

    fun set(name: String, value: String) {
        checkName(name)
        require(value.length <= MAX_VALUE) { "value too long" }
        store.put(PREFIX + name, toHex(cipher.encrypt(value.toByteArray(Charsets.UTF_8), aad(name))))
    }

    fun delete(name: String) {
        checkName(name)
        store.remove(PREFIX + name)
    }

    companion object {
        const val PREFIX = "s1."
        const val MAX_VALUE = 8192
        const val KEY_ALIAS = "companion_secure_v1"
        private val NAME = Regex("^[A-Za-z0-9._:-]{1,128}$")

        fun checkName(name: String) = require(NAME.matches(name)) { "bad key name" }

        private fun aad(name: String) = "companion-secure:$name".toByteArray(Charsets.UTF_8)

        fun toHex(b: ByteArray): String {
            val sb = StringBuilder(b.size * 2)
            for (x in b) {
                val v = x.toInt() and 0xff
                sb.append(HEX[v ushr 4]).append(HEX[v and 0x0f])
            }
            return sb.toString()
        }

        fun fromHex(s: String): ByteArray {
            require(s.length % 2 == 0) { "odd hex" }
            return ByteArray(s.length / 2) { i ->
                ((Character.digit(s[2 * i], 16) shl 4) or Character.digit(s[2 * i + 1], 16)).toByte()
            }
        }

        private const val HEX = "0123456789abcdef"

        /** Production: Keystore key + private prefs. */
        fun forContext(context: Context) =
            SecureStore(PrefsKeyValueStore(context.applicationContext), AesGcmCipher { KeystoreKeys.getOrCreate(KEY_ALIAS) })
    }
}
