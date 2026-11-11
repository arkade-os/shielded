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

    @Test fun precommitFailureWithoutASavedRecordIsExplicitlyRetryable() {
        var saved = "idle"
        val status = AndroidUpdatePolicy.recoverInstallFailure(false, true) { saved = it }
        assertEquals("failed", status)
        assertEquals("failed", saved)
    }

    @Test fun precommitFailureReplacesAnOlderInstalledRecord() {
        var saved = "installed"
        assertEquals("failed", AndroidUpdatePolicy.recoverInstallFailure(false, true) { saved = it })
        assertEquals("failed", saved)
    }

    @Test fun failedPreferenceWritesCannotMakeAKnownFailureAmbiguous() {
        assertEquals("failed", AndroidUpdatePolicy.recoverInstallFailure(false, true) {
            throw UpdateRejected("Could not save the Android update state")
        })
    }

    @Test fun failedCallsCannotOverwriteANewerAttempt() {
        var writes = 0
        assertEquals("failed", AndroidUpdatePolicy.recoverInstallFailure(false, false) { writes++ })
        assertEquals(0, writes)
    }

    @Test fun possibleCommitsStayAmbiguousWhenPreferenceWritesFail() {
        assertEquals("confirmation-required", AndroidUpdatePolicy.recoverInstallFailure(true, true) {
            throw UpdateRejected("Could not save the Android update state")
        })
    }

    @Test fun possibleCommitsCannotOverwriteANewerAttempt() {
        var writes = 0
        assertEquals("confirmation-required", AndroidUpdatePolicy.recoverInstallFailure(true, false) { writes++ })
        assertEquals(0, writes)
    }

    @Test fun failedPersistenceCannotResurrectAnIdleOrInstalledRecord() {
        for (previous in listOf("idle", "installed", "installing")) {
            val journal = AndroidUpdateJournal<String>()
            val status = AndroidUpdatePolicy.recoverInstallFailure(false, true) { failure ->
                journal.write(failure) { throw UpdateRejected("Could not save the Android update state") }
            }
            assertEquals("failed", status)
            assertEquals("failed", journal.read { previous })
        }
    }

    @Test fun failedPersistenceRetainsAnAmbiguousCommitReceipt() {
        val journal = AndroidUpdateJournal<String>()
        assertEquals("confirmation-required", AndroidUpdatePolicy.recoverInstallFailure(true, true) { status ->
            journal.write(status) { throw UpdateRejected("Could not save the Android update state") }
        })
        assertEquals("confirmation-required", journal.read { "installed" })
    }

    @Test fun successfulPersistenceClearsTheFallbackForLaterInstallerCallbacks() {
        val journal = AndroidUpdateJournal<String>()
        var durable = "idle"
        try { journal.write("failed") { throw UpdateRejected("Could not save") } } catch (_: UpdateRejected) { }
        assertEquals("failed", journal.read { durable })
        journal.write("installing") { durable = it }
        durable = "installed"
        assertEquals("installed", journal.read { durable })
    }

    @Test fun failedAbandonmentCannotTurnAnUncertainCommitIntoARetry() {
        assertEquals("confirmation-required", AndroidUpdatePolicy.afterAbandon(false, true, 1, 2))
        assertEquals("confirmation-required", AndroidUpdatePolicy.afterAbandon(false, false, 1, 2))
        assertEquals("confirmation-required", AndroidUpdatePolicy.afterAbandon(true, false, null, 2))
    }

    @Test fun aRemainingOwnedSessionKeepsRetryLocked() {
        assertEquals("confirmation-required", AndroidUpdatePolicy.afterAbandon(true, true, 1, 2))
    }

    @Test fun confirmedAbandonmentAndAbsenceAllowAnExplicitRetry() {
        assertEquals("failed", AndroidUpdatePolicy.afterAbandon(true, false, 1, 2))
    }

    @Test fun anInstalledUpdateWinsAnAbandonmentRace() {
        assertEquals("installed", AndroidUpdatePolicy.afterAbandon(false, true, 2, 2))
        assertEquals("installed", AndroidUpdatePolicy.afterAbandon(true, false, 3, 2))
    }
}
