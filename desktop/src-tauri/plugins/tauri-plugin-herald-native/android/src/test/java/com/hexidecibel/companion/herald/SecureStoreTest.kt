package com.hexidecibel.companion.herald

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

class SecureStoreTest {
    private class MemStore : KeyValueStore {
        val map = HashMap<String, String>()
        override fun get(key: String) = map[key]
        override fun put(key: String, value: String) { map[key] = value }
        override fun remove(key: String) { map.remove(key) }
    }

    private fun softwareKey(): SecretKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()

    private fun store(mem: MemStore = MemStore(), key: SecretKey = softwareKey()) =
        SecureStore(mem, AesGcmCipher { key })

    @Test
    fun roundTripsAndNeverStoresPlaintext() {
        val mem = MemStore()
        val s = store(mem)
        s.set("server-token.abc", "cdt1.secret-token-value")
        assertEquals("cdt1.secret-token-value", s.get("server-token.abc"))
        val raw = mem.map.values.single()
        assertFalse(raw.contains("secret"))
        assertFalse(String(SecureStore.fromHex(raw), Charsets.ISO_8859_1).contains("secret-token"))
    }

    @Test
    fun freshIvEachWrite() {
        val mem = MemStore()
        val s = store(mem)
        s.set("k", "same")
        val a = mem.map.values.single()
        s.set("k", "same")
        val b = mem.map.values.single()
        assertNotEquals(a, b)
        assertEquals("same", s.get("k"))
    }

    @Test
    fun missingDeletedAndUnreadableReadAsNull() {
        val mem = MemStore()
        val s = store(mem)
        assertNull(s.get("nope"))
        s.set("k", "v")
        s.delete("k")
        assertNull(s.get("k"))
        assertTrue(mem.map.isEmpty())
        // Tampered ciphertext.
        s.set("k", "v")
        val key = mem.map.keys.single()
        val hex = mem.map[key]!!
        mem.map[key] = hex.substring(0, hex.length - 2) + (if (hex.endsWith("00")) "01" else "00")
        assertNull(s.get("k"))
        // Another device's key (a restored backup): not readable, no crash.
        s.set("k", "v")
        assertNull(store(mem).get("k"))
    }

    @Test
    fun aBlobCopiedUnderAnotherNameDoesNotDecrypt() {
        val mem = MemStore()
        val key = softwareKey()
        val s = store(mem, key)
        s.set("a", "token-a")
        mem.map[SecureStore.PREFIX + "b"] = mem.map[SecureStore.PREFIX + "a"]!!
        assertNull(s.get("b"))
        assertEquals("token-a", s.get("a"))
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsBadNames() {
        store().set("../etc", "x")
    }

    @Test
    fun hexRoundTrip() {
        val b = byteArrayOf(0, 1, 127, -128, -1)
        assertEquals("00017f80ff", SecureStore.toHex(b))
        assertTrue(b.contentEquals(SecureStore.fromHex("00017f80ff")))
    }
}
