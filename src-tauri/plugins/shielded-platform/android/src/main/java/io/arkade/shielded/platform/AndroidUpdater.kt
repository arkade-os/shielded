package io.arkade.shielded.platform

import android.app.Activity
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import app.tauri.plugin.JSObject
import java.io.File
import java.io.OutputStream
import java.security.MessageDigest
import java.util.UUID
import org.json.JSONObject

internal class AndroidUpdater(context: Context) {
    private val context = context.applicationContext
    private val manager = this.context.packageManager
    private val installer = manager.packageInstaller
    private val preferences = this.context.getSharedPreferences("shielded.android.updates.v1", Context.MODE_PRIVATE)
    private val ownPackage = this.context.packageName
    private val directory = File(this.context.cacheDir, "$ownPackage/shielded-updates")

    private data class Record(val token: String, val session: Int, val target: Long, val status: String, val error: String? = null)

    companion object {
        private val lock = Any()
        private var preparing: String? = null
        private var submitted: String? = null
        private var submittedAt = 0L
        private var pending: Pair<String, Intent>? = null
        private var launched: String? = null
        private const val TOKEN = "io.arkade.shielded.UPDATE_TOKEN"
    }

    @Suppress("DEPRECATION")
    private fun installed(): PackageInfo = manager.getPackageInfo(ownPackage,
        if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES)

    @Suppress("DEPRECATION")
    private fun signers(info: PackageInfo): List<String> {
        val values = if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures
        return values?.map { AndroidUpdatePolicy.hex(MessageDigest.getInstance("SHA-256").digest(it.toByteArray())) } ?: emptyList()
    }

    @Suppress("DEPRECATION")
    private fun version(info: PackageInfo) = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()

    @Suppress("DEPRECATION")
    private fun installSource(): String? = if (Build.VERSION.SDK_INT >= 30) manager.getInstallSourceInfo(ownPackage).installingPackageName
        else manager.getInstallerPackageName(ownPackage)

    private fun canInstall() = Build.VERSION.SDK_INT < 26 || manager.canRequestPackageInstalls()
    private fun read(): Record? {
        val token = preferences.getString("token", null) ?: return null
        return Record(token, preferences.getInt("session", -1), preferences.getLong("target", 0),
            preferences.getString("status", "failed") ?: "failed", preferences.getString("error", null))
    }

    private fun write(record: Record) {
        if (!preferences.edit().putString("token", record.token).putInt("session", record.session)
            .putLong("target", record.target).putString("status", record.status).putString("error", record.error).commit())
            throw UpdateRejected("Could not save the Android update state")
    }

    private fun reconcile(currentVersion: Long): Record? {
        val record = read() ?: return null
        val inProcess = preparing == record.token || (submitted == record.token && SystemClock.elapsedRealtime() - submittedAt < 10 * 60_000)
        val sessionExists = record.session >= 0 && installer.getSessionInfo(record.session) != null
        val status = AndroidUpdatePolicy.reconcile(record.status, currentVersion, record.target, sessionExists, inProcess)
        val next = when {
            status == "installed" -> record.copy(status = status, error = null)
            status == record.status && (status != "confirmation-required" || pending?.first == record.token) -> record
            status == "failed" -> {
                if (record.status == "preparing" && sessionExists) runCatching { installer.abandonSession(record.session) }
                record.copy(status = status, error = "The Android update was interrupted. Install it again.")
            }
            else -> record.copy(status = status, error = if (pending?.first == record.token) null
                else "The Android update was interrupted. Continue to reset this installation attempt, then retry.")
        }
        if (next != record) write(next)
        return next
    }

    fun info(): JSObject = synchronized(lock) {
        val current = installed()
        val certificates = signers(current)
        val source = installSource()
        val record = reconcile(version(current))
        val error = when {
            ownPackage != BuildConfig.SHIELDED_PACKAGE_NAME -> "This Android application identity is not supported"
            certificates != listOf(BuildConfig.SHIELDED_UPDATE_CERT_SHA256) -> "This wallet uses a different signing key. Keep it installed; this release cannot update it in place."
            source == "com.android.vending" -> "Updates for this installation are managed by Google Play"
            else -> record?.error
        }
        JSObject().apply {
            put("packageName", ownPackage); put("versionCode", version(current))
            put("signerSha256", certificates.singleOrNull() ?: "")
            put("installerPackageName", source ?: JSONObject.NULL); put("canRequestInstalls", canInstall())
            put("installStatus", if (record?.status == "preparing") "installing" else record?.status ?: "idle")
            put("installError", error ?: JSONObject.NULL)
        }
    }

    fun permission(activity: Activity) {
        if (Build.VERSION.SDK_INT >= 26 && !canInstall())
            activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$ownPackage")))
    }

    private fun result(status: String, error: String? = null) = JSObject().apply {
        put("installStatus", status); put("installError", error ?: JSONObject.NULL)
    }

    @Suppress("DEPRECATION")
    private fun verify(file: File, args: UpdateArgs) {
        AndroidUpdatePolicy.metadata(args.bytes, args.sha256, args.versionCode)
        if (ownPackage != BuildConfig.SHIELDED_PACKAGE_NAME || installSource() == "com.android.vending")
            throw UpdateRejected("Use the store that manages this Android installation")
        if (file.length() != args.bytes) throw UpdateRejected("The Android update size does not match")
        val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        val archive = manager.getPackageArchiveInfo(file.absolutePath, flags)
            ?: throw UpdateRejected("Android could not read this update package")
        val current = installed()
        AndroidUpdatePolicy.identity(ownPackage, archive.packageName, version(current), version(archive), args.versionCode,
            signers(current), signers(archive), BuildConfig.SHIELDED_UPDATE_CERT_SHA256)
        file.inputStream().use { input -> AndroidUpdatePolicy.copyVerified(input, object : OutputStream() {
            override fun write(value: Int) {}
            override fun write(buffer: ByteArray, offset: Int, length: Int) {}
        }, args.bytes, args.sha256) }
    }

    fun verifyOnly(args: UpdateArgs) {
        verify(AndroidUpdatePolicy.privateApk(directory, args.path), args)
    }

    fun install(args: UpdateArgs, authorize: (() -> Unit) -> Unit): JSObject {
        val token = UUID.randomUUID().toString()
        synchronized(lock) {
            val record = reconcile(version(installed()))
            if (preparing != null || record?.status in listOf("preparing", "installing", "confirmation-required"))
                throw UpdateRejected("An Android update is already awaiting completion")
            preparing = token
        }
        var sessionId = -1
        var commitStarted = false
        try {
            val file = AndroidUpdatePolicy.privateApk(directory, args.path)
            verify(file, args)
            if (!canInstall()) return result("permission-required")
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
                setAppPackageName(ownPackage); setSize(args.bytes)
                if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
                if (Build.VERSION.SDK_INT >= 33) setPackageSource(PackageInstaller.PACKAGE_SOURCE_DOWNLOADED_FILE)
                if (Build.VERSION.SDK_INT >= 36) setAutoInstallDependenciesEnabled(false)
            }
            sessionId = installer.createSession(params)
            synchronized(lock) { write(Record(token, sessionId, args.versionCode, "preparing")) }
            installer.openSession(sessionId).use { session ->
                file.inputStream().use { input ->
                    session.openWrite("base.apk", 0, args.bytes).use { output ->
                        AndroidUpdatePolicy.copyVerified(input, output, args.bytes, args.sha256)
                        session.fsync(output)
                    }
                }
                val intent = Intent(context, UpdateReceiver::class.java).apply {
                    action = "$ownPackage.UPDATE_RESULT"
                    data = Uri.parse("shielded-update://result/$token")
                    putExtra(TOKEN, token)
                }
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
                val callback = PendingIntent.getBroadcast(context, sessionId, intent, flags)
                authorize {
                    synchronized(lock) {
                        if (preparing != token) throw UpdateRejected("Android update authorization expired")
                        write(Record(token, sessionId, args.versionCode, "installing"))
                        submitted = token
                        submittedAt = SystemClock.elapsedRealtime()
                        commitStarted = true
                        session.commit(callback.intentSender)
                    }
                }
            }
            return result("installing")
        } catch (error: Exception) {
            synchronized(lock) {
                if (!commitStarted) {
                    if (sessionId >= 0) runCatching { installer.abandonSession(sessionId) }
                    if (read()?.token == token) write(Record(token, sessionId, args.versionCode, "failed",
                        (error as? UpdateRejected)?.message ?: "Android could not prepare the update. You can retry."))
                } else {
                    submitted = null
                    write(Record(token, sessionId, args.versionCode, "confirmation-required", "Android could not confirm installation. Continue to check this attempt."))
                }
            }
            if (commitStarted) return result("confirmation-required", "Android could not confirm installation. Continue to check this attempt.")
            throw error
        } finally {
            synchronized(lock) { if (preparing == token) preparing = null }
        }
    }

    fun confirm(activity: Activity): JSObject = synchronized(lock) {
        val record = reconcile(version(installed())) ?: throw UpdateRejected("There is no Android installation to continue")
        if (record.status != "confirmation-required") return result(record.status, record.error)
        val intent = pending?.takeIf { it.first == record.token }?.second
        if (intent == null) {
            runCatching { installer.abandonSession(record.session) }
            write(record.copy(status = "failed", error = "Update confirmation was interrupted. Install the update again."))
            submitted = null
            return result("failed", "Update confirmation was interrupted. Install the update again.")
        }
        if (launched != record.token) {
            activity.startActivity(Intent(intent))
            launched = record.token
        }
        result("confirmation-required")
    }

    fun resumed() { synchronized(lock) { launched = null } }

    @Suppress("DEPRECATION")
    fun receive(intent: Intent) = synchronized(lock) {
        val record = read() ?: return
        if (intent.action != "$ownPackage.UPDATE_RESULT" || !AndroidUpdatePolicy.callback(intent.getStringExtra(TOKEN) ?: "",
                intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1), record.token, record.session) ||
            record.status !in listOf("installing", "confirmation-required")) return
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val next = when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirmation = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                    else intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                if (confirmation == null) {
                    runCatching { installer.abandonSession(record.session) }
                    record.copy(status = "failed", error = "Android did not provide update confirmation. Retry the installation.")
                }
                else { pending = record.token to confirmation; record.copy(status = "confirmation-required", error = null) }
            }
            PackageInstaller.STATUS_SUCCESS -> record.copy(status = "installed", error = null)
            PackageInstaller.STATUS_FAILURE_ABORTED -> record.copy(status = "failed", error = "The Android update was cancelled. Your wallet is unchanged.")
            else -> record.copy(status = "failed", error = "Android could not install the update (code $status). Your wallet is unchanged.")
        }
        if (next.status != "confirmation-required") { pending = null; launched = null }
        submitted = null
        write(next)
    }
}
