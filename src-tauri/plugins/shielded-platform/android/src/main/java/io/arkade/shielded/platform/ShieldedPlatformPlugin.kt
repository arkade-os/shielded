package io.arkade.shielded.platform

import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.doOnAttach
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.util.concurrent.Executors
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import java.util.WeakHashMap
import org.json.JSONObject

@InvokeArg
class SeedArgs { var value: String = "" }

@InvokeArg
class UpdateArgs {
    var path: String = ""
    var sha256: String = ""
    var bytes: Long = 0
    var versionCode: Long = 0
}

private val baseInsets = WeakHashMap<View, Insets>()

@TauriPlugin
class ShieldedPlatformPlugin(activity: Activity) : Plugin(activity) {
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private var updateWorker = Executors.newSingleThreadExecutor()
    private val updater = AndroidUpdater(activity)
    private val vault = AndroidSeedVault(activity)
    private var webview: WebView? = null
    @Volatile private var generation = 0L
    private var destroyed = false
    private var activeActivity: Activity? = activity
    private var resumed = false

    override fun load(webView: WebView) {
        webview = webView
        generation++
        destroyed = false
        val container = webView.parent as? View ?: return
        val padding = baseInsets.getOrPut(container) {
            Insets.of(container.paddingLeft, container.paddingTop, container.paddingRight, container.paddingBottom)
        }
        val handledTypes = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
        ViewCompat.setOnApplyWindowInsetsListener(container) { view, insets ->
            val safe = insets.getInsets(handledTypes)
            val position = IntArray(2)
            view.getLocationInWindow(position)
            val windowLeft = position[0]
            val windowTop = position[1]
            val windowRight = windowLeft + view.width
            val windowBottom = windowTop + view.height
            val topInset = if (windowTop < safe.top) (safe.top - windowTop - padding.top).coerceAtLeast(0) else 0
            val leftInset = if (windowLeft < safe.left) (safe.left - windowLeft - padding.left).coerceAtLeast(0) else 0
            val rightEdge = view.rootView.width
            val bottomEdge = view.rootView.height
            val rightInset = if (rightEdge > 0 && windowRight > rightEdge - safe.right) (windowRight - (rightEdge - safe.right) - padding.right).coerceAtLeast(0) else 0
            val bottomInset = if (bottomEdge > 0 && windowBottom > bottomEdge - safe.bottom) (windowBottom - (bottomEdge - safe.bottom) - padding.bottom).coerceAtLeast(0) else 0
            view.setPadding(
                padding.left + leftInset, padding.top + topInset,
                padding.right + rightInset, padding.bottom + bottomInset
            )
            // The native container handles these edges; keep keyboard updates flowing to WebView.
            WindowInsetsCompat.Builder(insets).setInsets(handledTypes, Insets.NONE).build()
        }
        container.doOnAttach { ViewCompat.requestApplyInsets(it) }
    }

    private fun trusted(): Boolean {
        val url = webview?.url?.let { Uri.parse(it) } ?: return false
        return url.port == -1 && url.userInfo == null &&
            ((url.scheme == "tauri" && url.host == "localhost") ||
             (url.scheme in listOf("http", "https") && url.host == "tauri.localhost"))
    }

    private fun secret(invoke: Invoke, operation: () -> JSObject?) {
        main.post {
            if (destroyed || !trusted()) { invoke.reject("Native access is restricted to the bundled wallet"); return@post }
            val ticket = generation
            val source = webview
            try {
                worker.execute {
                    try {
                        val authorization = FutureTask { generation == ticket && !destroyed && webview === source && trusted() }
                        check(main.post(authorization) && authorization.get(10, TimeUnit.SECONDS))
                        check(generation == ticket)
                        val result = operation()
                        main.post {
                            if (generation != ticket || destroyed || webview !== source || !trusted()) invoke.reject("Secure wallet storage unavailable")
                            else if (result == null) invoke.resolve() else invoke.resolve(result)
                        }
                    } catch (_: Exception) {
                        main.post { invoke.reject("Secure wallet storage unavailable") }
                    }
                }
            } catch (_: Exception) { invoke.reject("Secure wallet storage unavailable") }
        }
    }

    @Command
    fun secretGet(invoke: Invoke) = secret(invoke) {
        JSObject().put("value", vault.get() ?: JSONObject.NULL) as JSObject
    }

    @Command
    fun secretSet(invoke: Invoke) = secret(invoke) {
        val args = invoke.parseArgs(SeedArgs::class.java)
        try { vault.set(args.value) } finally { args.value = "" }
        null
    }

    @Command
    fun secretClear(invoke: Invoke) = secret(invoke) {
        vault.clear()
        null
    }

    @Command
    fun clipboardText(invoke: Invoke) {
        main.post {
            if (destroyed || !trusted()) { invoke.reject("Native access is restricted to the bundled wallet"); return@post }
            val context = activeActivity ?: run { invoke.reject("Return to Shielded to paste"); return@post }
            val clip = (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip
            // Plain text only: coerceToText would resolve a content:// clip on this main thread, and no payment code arrives that way.
            val text = clip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.text?.toString()?.takeIf { it.length <= 8192 }
            invoke.resolve(JSObject().put("text", text ?: JSONObject.NULL) as JSObject)
        }
    }

    private fun update(invoke: Invoke, install: Boolean = false, operation: ((() -> Unit) -> Unit) -> JSObject?) {
        val dispatch = AndroidUpdateDispatch(install)
        fun fail(message: String) {
            when (dispatch.fail()) {
                UpdateDispatchFailure.INSTALL_FAILED -> invoke.resolve(JSObject().apply {
                    put("installStatus", "failed"); put("installError", message)
                })
                UpdateDispatchFailure.REJECTED -> invoke.reject(message)
                null -> Unit
            }
        }
        fun message(error: Exception) = (error as? UpdateRejected)?.message ?: "Android update unavailable. You can retry."
        try {
            val accepted = main.post {
                try {
                    if (destroyed || !trusted()) { fail("Native access is restricted to the bundled wallet"); return@post }
                    val ticket = generation
                    val source = webview
                    updateWorker.execute {
                        try {
                            val authorize: (() -> Unit) -> Unit = { action ->
                                AndroidUpdateAuthorization({ main.post(it) }, {
                                    generation == ticket && !destroyed && webview === source && trusted() && resumed
                                }).run(action)
                            }
                            // Read-only checks remain available while paused; installer actions require the resumed Activity.
                            val authorization = FutureTask { generation == ticket && !destroyed && webview === source && trusted() }
                            val allowed = try { main.post(authorization) && authorization.get(10, TimeUnit.SECONDS) }
                                finally { if (!authorization.isDone) authorization.cancel(false) }
                            if (!allowed) throw UpdateRejected("Android update authorization unavailable")
                            if (!dispatch.begin()) return@execute
                            val result = operation(authorize)
                            val replyAccepted = main.post {
                                try {
                                    if (generation != ticket || destroyed || webview !== source || !trusted()) fail("Android update unavailable")
                                    else if (dispatch.complete()) { if (result == null) invoke.resolve() else invoke.resolve(result) }
                                } catch (error: Exception) { fail(message(error)) }
                            }
                            if (!replyAccepted) fail("Android update response unavailable")
                        } catch (error: Exception) {
                            if (error is InterruptedException) Thread.currentThread().interrupt()
                            fail(message(error))
                        }
                    }
                } catch (error: Exception) { fail(message(error)) }
            }
            if (!accepted) fail("Android update authorization unavailable")
        } catch (error: Exception) { fail(message(error)) }
    }

    @Command
    fun updateInfo(invoke: Invoke) = update(invoke) { updater.info() }

    @Command
    fun updateVerify(invoke: Invoke) = update(invoke) {
        updater.verifyOnly(invoke.parseArgs(UpdateArgs::class.java))
        null
    }

    @Command
    fun updatePermission(invoke: Invoke) = update(invoke) { authorize ->
        authorize { updater.permission(activeActivity ?: throw UpdateRejected("Return to Shielded to allow Android updates")) }
        null
    }

    @Command
    fun updateInstall(invoke: Invoke) = update(invoke, install = true) { authorize ->
        updater.install(invoke.parseArgs(UpdateArgs::class.java), authorize)
    }

    @Command
    fun updateConfirm(invoke: Invoke) = update(invoke) { authorize ->
        var result: JSObject? = null
        authorize { result = updater.confirm(activeActivity ?: throw UpdateRejected("Return to Shielded to confirm the Android update")) }
        result
    }

    override fun onResume(activity: AppCompatActivity) {
        if (activeActivity !== activity) generation++
        activeActivity = activity
        destroyed = false
        resumed = true
        if (updateWorker.isShutdown) updateWorker = Executors.newSingleThreadExecutor()
        updater.resumed()
    }

    override fun onPause(activity: AppCompatActivity) {
        if (activeActivity === activity) resumed = false
    }

    override fun onDestroy(activity: AppCompatActivity) {
        if (activeActivity !== activity) return
        generation++
        destroyed = true
        resumed = false
        activeActivity = null
        updateWorker.shutdown()
    }
}
