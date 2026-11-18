package io.arkade.shielded.platform

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.FileProvider
import app.tauri.plugin.JSObject
import java.io.File
import java.io.OutputStream
import java.security.MessageDigest
import org.json.JSONObject

internal class AndroidUpdater(context: Context) {
    private val context = context.applicationContext
    private val manager = this.context.packageManager
    private val ownPackage = this.context.packageName
    // Rust stages into app_cache_dir()/shielded-updates, and Tauri resolves app_cache_dir() on Android to cacheDir itself, with no identifier folder.
    private val directory = File(this.context.cacheDir, "shielded-updates")

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

    fun info(): JSObject {
        val current = installed()
        return JSObject().apply {
            put("packageName", ownPackage); put("versionCode", version(current))
            put("signerSha256", signers(current).singleOrNull() ?: "")
            put("installerPackageName", installSource() ?: JSONObject.NULL)
        }
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

    // An implicit APK-MIME view intent is offered to every app that claims it, so the handoff goes
    // to a preinstalled handler or nowhere; any other app could fake the install screen.
    @Suppress("DEPRECATION")
    private fun systemInstaller(intent: Intent): String {
        val flags = PackageManager.MATCH_SYSTEM_ONLY or PackageManager.MATCH_DEFAULT_ONLY
        val resolved = if (Build.VERSION.SDK_INT >= 33)
            manager.resolveActivity(intent, PackageManager.ResolveInfoFlags.of(flags.toLong()))
        else manager.resolveActivity(intent, flags)
        return resolved?.activityInfo?.packageName
            ?: throw UpdateRejected("This device has no system installer for update packages. Install the update from the Shielded download page.")
    }

    // Android's installer asks for the install-unknown-apps permission itself and owns the outcome.
    fun openInstaller(args: UpdateArgs, activity: () -> Activity, authorize: (() -> Unit) -> Unit) = try {
        val file = AndroidUpdatePolicy.privateApk(directory, args.path)
        // Without a discard action, a staged file that fails here would fail every retry; gone, it is downloaded again.
        try { verify(file, args) } catch (error: UpdateRejected) { file.delete(); throw error }
        val uri = FileProvider.getUriForFile(context, "$ownPackage.updates", file)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        intent.setPackage(systemInstaller(intent))
        authorize {
            if (AndroidUpdatePolicy.handoffExpired(args.deadline, System.currentTimeMillis()))
                throw UpdateRejected("Android took too long to open its installer. Try again.")
            activity().startActivity(intent)
        }
    } catch (error: Exception) {
        throw error as? UpdateRejected ?: UpdateRejected((error as? AmbiguousUpdateAuthorization)?.message
            ?: "Android could not open this update in its installer. You can retry.")
    }
}
