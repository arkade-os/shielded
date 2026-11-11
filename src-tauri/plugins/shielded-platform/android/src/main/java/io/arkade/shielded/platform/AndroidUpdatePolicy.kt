package io.arkade.shielded.platform

import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest

internal class UpdateRejected(message: String) : Exception(message)

// Production access is serialized by AndroidUpdater's companion lock.
internal class AndroidUpdateJournal<T : Any> {
    private var receipt: T? = null

    fun read(load: () -> T?): T? = receipt ?: load()

    fun write(record: T, persist: (T) -> Unit) {
        receipt = record
        persist(record)
        receipt = null
    }
}

internal object AndroidUpdatePolicy {
    const val MAX_BYTES = 128L * 1024 * 1024
    private val digest = Regex("[a-f0-9]{64}")
    private val filename = Regex("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\.apk")

    fun metadata(bytes: Long, sha256: String, versionCode: Long) {
        if (bytes !in 1..MAX_BYTES || !digest.matches(sha256) || versionCode !in 1..2_100_000_000L)
            throw UpdateRejected("Invalid Android update metadata")
    }

    fun privateApk(directory: File, path: String): File {
        val file = File(path)
        val canonical = file.canonicalFile
        if (!file.isAbsolute || !filename.matches(file.name) || canonical.name != file.name ||
            canonical.parentFile != directory.canonicalFile || !canonical.isFile)
            throw UpdateRejected("The verified update file is unavailable. Download it again.")
        return canonical
    }

    fun identity(ownPackage: String, archivePackage: String, installedVersion: Long, archiveVersion: Long,
        expectedVersion: Long, installedSigners: List<String>, archiveSigners: List<String>, pinned: String) {
        if (installedSigners != listOf(pinned))
            throw UpdateRejected("This wallet uses a different signing key. Keep it installed; this release cannot update it in place.")
        if (ownPackage != archivePackage) throw UpdateRejected("The update is for a different Android application")
        if (archiveSigners != listOf(pinned)) throw UpdateRejected("The Android update has an untrusted signing certificate")
        if (archiveVersion != expectedVersion || archiveVersion <= installedVersion)
            throw UpdateRejected("The Android update version is not newer than this installation")
    }

    fun copyVerified(input: InputStream, output: OutputStream, bytes: Long, sha256: String) {
        metadata(bytes, sha256, 1)
        val hash = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(64 * 1024)
        var copied = 0L
        while (true) {
            val size = input.read(buffer)
            if (size < 0) break
            if (size == 0) continue
            if (size.toLong() > bytes - copied) throw UpdateRejected("The Android update size does not match")
            hash.update(buffer, 0, size)
            output.write(buffer, 0, size)
            copied += size
        }
        if (copied != bytes) throw UpdateRejected("The Android update download is incomplete")
        if (hex(hash.digest()) != sha256) throw UpdateRejected("The Android update checksum does not match")
    }

    fun callback(token: String, session: Int, expectedToken: String, expectedSession: Int) =
        token.isNotEmpty() && session >= 0 && token == expectedToken && session == expectedSession

    fun mayHaveCommitted(commitStarted: Boolean, error: Exception) = commitStarted || error is AmbiguousUpdateAuthorization

    fun terminalResult(token: String, session: Int, target: Long, recordToken: String, recordSession: Int,
        recordTarget: Long, status: String, error: String?): Pair<String, String?>? =
        if (target == recordTarget && callback(token, session, recordToken, recordSession) && status in listOf("installed", "failed"))
            status to error else null

    fun recoverInstallFailure(possibleCommit: Boolean, ownsAttempt: Boolean, persist: (String) -> Unit): String {
        val status = if (possibleCommit) "confirmation-required" else "failed"
        if (ownsAttempt) try { persist(status) } catch (_: Exception) { }
        return status
    }

    fun afterAbandon(abandoned: Boolean, sessionExists: Boolean, currentVersion: Long?, targetVersion: Long): String = when {
        currentVersion != null && targetVersion > 0 && currentVersion >= targetVersion -> "installed"
        currentVersion == null || !abandoned || sessionExists -> "confirmation-required"
        else -> "failed"
    }

    fun reconcile(status: String, currentVersion: Long, targetVersion: Long, sessionExists: Boolean, inProcess: Boolean): String = when {
        targetVersion > 0 && currentVersion >= targetVersion -> "installed"
        status !in listOf("preparing", "installing", "confirmation-required") -> status
        !sessionExists -> "failed"
        inProcess -> status
        status == "preparing" -> "failed"
        else -> "confirmation-required"
    }

    fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }
}
