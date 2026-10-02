package com.hexidecibel.companion.herald

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream

class UpdateChecksTest {
    private val cert = "ab".repeat(32)
    private val other = "cd".repeat(32)
    private val bytes = "APK-BYTES".toByteArray()
    private val sha = UpdateChecks.sha256Hex(bytes)

    private fun verify(
        sha256: String = sha,
        pkg: String? = "com.hexidecibel.companion",
        code: Long = 1000505,
        certs: List<String> = listOf(cert),
        installedCerts: List<String> = listOf(cert),
        installedCode: Long = 1000500,
    ) = UpdateChecks.verifyArchive(
        "com.hexidecibel.companion", installedCode, installedCerts,
        1000505, sha256, sha, pkg, code, certs,
    )

    @Test fun hashesStreamAndBytesAlike() {
        assertEquals(sha, UpdateChecks.sha256Hex(ByteArrayInputStream(bytes)))
        assertEquals(64, sha.length)
    }

    @Test fun acceptsAMatchingNewerSameSignerApk() = assertNull(verify())

    @Test fun rejectsAChecksumMismatch() = assertEquals("checksum mismatch", verify(sha256 = "0".repeat(64)))

    @Test fun rejectsAForeignPackage() = assertTrue(verify(pkg = "evil.app")!!.contains("evil.app"))

    @Test fun rejectsUnparsableArchives() = assertEquals("not an Android package", verify(pkg = null))

    @Test fun rejectsAVersionOtherThanAdvertised() = assertTrue(verify(code = 1000506)!!.contains("advertised"))

    @Test fun rejectsNotNewer() = assertTrue(verify(installedCode = 1000505)!!.contains("not newer"))

    @Test fun rejectsADifferentSigner() {
        assertEquals("signed with a different certificate", verify(certs = listOf(other)))
        assertEquals("signed with a different certificate", verify(certs = emptyList()))
        assertEquals("signed with a different certificate", verify(certs = listOf(cert, other)))
    }

    @Test fun failsClosedWithoutInstalledCerts() = assertTrue(verify(installedCerts = emptyList())!!.contains("installed"))

    @Test fun signerComparisonIgnoresCaseColonsAndOrder() {
        val colon = cert.uppercase().chunked(2).joinToString(":")
        assertTrue(UpdateChecks.sameSigners(listOf(cert, other), listOf(other, colon)))
        assertFalse(UpdateChecks.sameSigners(emptyList(), emptyList()))
    }

    @Test fun versionComparison() {
        assertTrue(UpdateChecks.isNewer(1000501, 1000500))
        assertFalse(UpdateChecks.isNewer(1000500, 1000500))
        assertFalse(UpdateChecks.isNewer(1000499, 1000500))
    }
}
