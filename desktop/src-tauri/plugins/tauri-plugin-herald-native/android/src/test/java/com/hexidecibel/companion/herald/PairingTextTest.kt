package com.hexidecibel.companion.herald

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PairingTextTest {
    @Test
    fun acceptsOnlyPairingLinks() {
        val link = "companion://pair?host=10.0.0.2&port=9877&otp=abc"
        assertEquals(link, PairingText.companionLink(" $link "))
        assertEquals(link, PairingText.companionLink(link))
        assertNull(PairingText.companionLink("https://example.com"))
        assertNull(PairingText.companionLink("companion://other"))
        assertNull(PairingText.companionLink(null))
    }

    @Test
    fun decodesTxt() {
        val txt = PairingText.txt(mapOf("id" to "ab".toByteArray(), "pairing" to "1".toByteArray(), "x" to null))
        assertEquals(mapOf("id" to "ab", "pairing" to "1", "x" to ""), txt)
    }

    @Test
    fun ordersAddressesIpv4First() {
        assertEquals(
            listOf("192.168.1.5", "fd7a::1"),
            PairingText.orderAddresses(listOf("fe80::1", "fd7a::1", "127.0.0.1", "192.168.1.5", "192.168.1.5")),
        )
    }
}
