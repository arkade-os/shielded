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
import androidx.lifecycle.Lifecycle
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
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

@InvokeArg
class PasskeyArgs { var request: String = "" }

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

    // Tauri registers this plugin after the Activity's first onResume, so a latched flag would miss
    // that resume and refuse every installer action until the next app switch.
    private fun resumed() = (activeActivity as? AppCompatActivity)
        ?.lifecycle?.currentState?.isAtLeast(Lifecycle.State.RESUMED) == true

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
            val context = activeActivity ?: run { invoke.reject("Shielded is not on screen, so the clipboard could not be read."); return@post }
            val clip = (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip
            // Plain text only: coerceToText would resolve a content:// clip on this main thread, and no payment code arrives that way.
            val text = clip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.text?.toString()?.takeIf { it.length <= 8192 }
            invoke.resolve(JSObject().put("text", text ?: JSONObject.NULL) as JSObject)
        }
    }

    // No `resumed` gate: the prompt pauses this Activity, and the SDK's confirming get can start before onResume.
    private fun passkey(invoke: Invoke, ceremony: (Activity, String, Executor, PasskeyReply) -> Unit) {
        main.post {
            if (destroyed || !trusted()) { invoke.reject("Native access is restricted to the bundled wallet"); return@post }
            val context = activeActivity ?: run { invoke.reject(PASSKEY_UNAVAILABLE); return@post }
            val ticket = generation
            val source = webview
            val reply: PasskeyReply = { response, error ->
                if (response != null && generation == ticket && !destroyed && webview === source && trusted()) invoke.resolve(JSObject().put("response", response))
                else invoke.reject(if (passkeyCancelled(error)) PASSKEY_CANCELLED else PASSKEY_UNAVAILABLE)
            }
            try { ceremony(context, invoke.parseArgs(PasskeyArgs::class.java).request, Executor { main.post(it) }, reply) }
            catch (error: Exception) { reply(null, error) }
        }
    }

    @Command
    fun passkeyCreate(invoke: Invoke) = passkey(invoke, ::createPasskey)

    @Command
    fun passkeyGet(invoke: Invoke) = passkey(invoke, ::getPasskey)

    private fun update(invoke: Invoke, operation: ((() -> Unit) -> Unit) -> JSObject?) {
        val replied = AtomicBoolean(false)
        fun fail(message: String) { if (replied.compareAndSet(false, true)) invoke.reject(message) }
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
                                    generation == ticket && !destroyed && webview === source && trusted() && resumed()
                                }).run(action)
                            }
                            // Read-only checks remain available while paused; installer actions require the resumed Activity.
                            val authorization = FutureTask { generation == ticket && !destroyed && webview === source && trusted() }
                            val allowed = try { main.post(authorization) && authorization.get(10, TimeUnit.SECONDS) }
                                finally { if (!authorization.isDone) authorization.cancel(false) }
                            if (!allowed) throw UpdateRejected("Android update authorization unavailable")
                            val result = operation(authorize)
                            val replyAccepted = main.post {
                                try {
                                    if (generation != ticket || destroyed || webview !== source || !trusted()) fail("Android update unavailable")
                                    else if (replied.compareAndSet(false, true)) { if (result == null) invoke.resolve() else invoke.resolve(result) }
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
    fun updateOpenInstaller(invoke: Invoke) = update(invoke) { authorize ->
        updater.openInstaller(invoke.parseArgs(UpdateArgs::class.java), {
            activeActivity ?: throw UpdateRejected("Shielded is not on screen, so the Android installer could not open. Try again.")
        }, authorize)
        null
    }

    override fun onResume(activity: AppCompatActivity) {
        if (activeActivity !== activity) generation++
        activeActivity = activity
        destroyed = false
        if (updateWorker.isShutdown) updateWorker = Executors.newSingleThreadExecutor()
    }

    override fun onDestroy(activity: AppCompatActivity) {
        if (activeActivity !== activity) return
        generation++
        destroyed = true
        activeActivity = null
        updateWorker.shutdown()
    }
}
