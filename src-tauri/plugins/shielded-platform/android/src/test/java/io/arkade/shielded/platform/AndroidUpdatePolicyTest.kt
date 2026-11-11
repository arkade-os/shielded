package io.arkade.shielded.platform

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import org.junit.Assert.*
import org.junit.Test

class AndroidUpdatePolicyTest {
    private val certificate = "ab".repeat(32)
    private val payload = ByteArray(150_001) { (it % 251).toByte() }
    private fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun rejected(action: () -> Unit) {
        try { action(); fail("Expected rejection") } catch (_: UpdateRejected) { }
    }
    private fun identity(packageName: String = "io.arkade.shielded", version: Long = 100_002,
        current: List<String> = listOf(certificate), archive: List<String> = listOf(certificate)) =
        AndroidUpdatePolicy.identity("io.arkade.shielded", packageName, 100_001, version, 100_002, current, archive, certificate)

    @Test fun acceptsOnlyAnUpgradeOfThePinnedInstalledPackage() { identity() }

    @Test fun rejectsLegacyDebugAndOtherSigningIdentities() {
        rejected { identity(current = listOf("cd".repeat(32))) }
        rejected { identity(archive = listOf("cd".repeat(32))) }
        rejected { identity(current = emptyList()) }
        rejected { identity(archive = listOf(certificate, certificate)) }
    }

    @Test fun rejectsOtherPackagesAndChangedAdvertisedVersions() {
        rejected { identity(packageName = "io.evil.shielded") }
        rejected { identity(version = 100_003) }
    }

    @Test fun rejectsSameVersionAndDowngrades() {
        for (version in listOf(1L, 100_001L)) rejected {
            AndroidUpdatePolicy.identity("io.arkade.shielded", "io.arkade.shielded", 100_001, version, version,
                listOf(certificate), listOf(certificate), certificate)
        }
    }

    @Test fun copiesTheCompleteBoundedPayloadAndChecksItsDigest() {
        val output = ByteArrayOutputStream()
        AndroidUpdatePolicy.copyVerified(ByteArrayInputStream(payload), output, payload.size.toLong(), hash(payload))
        assertArrayEquals(payload, output.toByteArray())
    }

    @Test fun rejectsTruncationWithoutAcceptingAnIncompleteApk() {
        rejected { AndroidUpdatePolicy.copyVerified(ByteArrayInputStream(payload.dropLast(1).toByteArray()),
            ByteArrayOutputStream(), payload.size.toLong(), hash(payload)) }
    }

    @Test fun rejectsOversizedInputBeforeWritingTheExtraByte() {
        val output = ByteArrayOutputStream()
        rejected { AndroidUpdatePolicy.copyVerified(ByteArrayInputStream(payload + byteArrayOf(1)), output,
            payload.size.toLong(), hash(payload)) }
        assertTrue(output.size() <= payload.size)
    }

    @Test fun rejectsTamperingAtInstallationTime() {
        rejected { AndroidUpdatePolicy.copyVerified(ByteArrayInputStream(payload), ByteArrayOutputStream(),
            payload.size.toLong(), "00".repeat(32)) }
    }

    @Test fun acceptsOnlyPrivateUuidApks() {
        val root = Files.createTempDirectory("shielded-update-policy").toFile()
        try {
            val file = File(root, "e66f5b15-8d11-4949-af60-bfc55537971e.apk").apply { writeBytes(byteArrayOf(1)) }
            assertEquals(file.canonicalFile, AndroidUpdatePolicy.privateApk(root, file.absolutePath))
            rejected { AndroidUpdatePolicy.privateApk(root, File(root, "../outside.apk").absolutePath) }
            rejected { AndroidUpdatePolicy.privateApk(root, File(root, "wallet.db").absolutePath) }
            rejected { AndroidUpdatePolicy.privateApk(root, File(root, "nested/${file.name}").absolutePath) }
        } finally { root.deleteRecursively() }
    }

    @Test fun rejectsSymlinksToFilesOutsideThePrivateUpdateDirectory() {
        val root = Files.createTempDirectory("shielded-update-policy").toFile()
        val outside = Files.createTempFile("shielded-update-outside", ".apk")
        try {
            val link = File(root, "e66f5b15-8d11-4949-af60-bfc55537971e.apk")
            Files.createSymbolicLink(link.toPath(), outside)
            rejected { AndroidUpdatePolicy.privateApk(root, link.absolutePath) }
        } finally { root.deleteRecursively(); Files.deleteIfExists(outside) }
    }

    @Test fun rejectsMalformedOrUnboundedMetadata() {
        AndroidUpdatePolicy.metadata(payload.size.toLong(), hash(payload), 100_002)
        for (size in listOf(0L, -1L, AndroidUpdatePolicy.MAX_BYTES + 1)) rejected {
            AndroidUpdatePolicy.metadata(size, hash(payload), 100_002)
        }
        for (digest in listOf("", "A".repeat(64), "ab")) rejected {
            AndroidUpdatePolicy.metadata(payload.size.toLong(), digest, 100_002)
        }
        for (version in listOf(0L, 2_100_000_001L)) rejected {
            AndroidUpdatePolicy.metadata(payload.size.toLong(), hash(payload), version)
        }
    }

    @Test fun ignoresOldOrUnownedInstallerCallbacks() {
        assertTrue(AndroidUpdatePolicy.callback("token", 4, "token", 4))
        assertFalse(AndroidUpdatePolicy.callback("old", 4, "token", 4))
        assertFalse(AndroidUpdatePolicy.callback("token", 3, "token", 4))
        assertFalse(AndroidUpdatePolicy.callback("", -1, "", -1))
    }

    @Test fun pendingConfirmationIsNotAnInstalledUpdate() {
        assertEquals("confirmation-required", AndroidUpdatePolicy.reconcile("confirmation-required", 1, 2, true, false))
    }

    @Test fun processDeathDuringCopyIsRetryable() {
        assertEquals("failed", AndroidUpdatePolicy.reconcile("preparing", 1, 2, true, false))
        assertEquals("preparing", AndroidUpdatePolicy.reconcile("preparing", 1, 2, true, true))
    }

    @Test fun lostCallbacksCannotLeaveAPermanentInstallingState() {
        assertEquals("confirmation-required", AndroidUpdatePolicy.reconcile("installing", 1, 2, true, false))
        assertEquals("installing", AndroidUpdatePolicy.reconcile("installing", 1, 2, true, true))
    }

    @Test fun missingSessionsFailWithoutTouchingTheWallet() {
        assertEquals("failed", AndroidUpdatePolicy.reconcile("installing", 1, 2, false, false))
        assertEquals("failed", AndroidUpdatePolicy.reconcile("installing", 1, 2, false, true))
    }

    @Test fun installedVersionReconcilesALostSuccessCallback() {
        assertEquals("installed", AndroidUpdatePolicy.reconcile("installing", 2, 2, false, false))
        assertEquals("installed", AndroidUpdatePolicy.reconcile("failed", 3, 2, false, false))
    }
}
