package io.arkade.shielded.platform

import android.app.Activity
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
import org.json.JSONObject

@InvokeArg
class SeedArgs { var value: String = "" }

@TauriPlugin
class ShieldedPlatformPlugin(activity: Activity) : Plugin(activity) {
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private val vault = AndroidSeedVault(activity)
    private var webview: WebView? = null
    @Volatile private var generation = 0L
    private var destroyed = false
    private var activeActivity: Activity? = activity

    override fun load(webView: WebView) {
        webview = webView
        generation++
        destroyed = false
        val container = webView.parent as? View ?: return
        val padding = Insets.of(container.paddingLeft, container.paddingTop, container.paddingRight, container.paddingBottom)
        val handledTypes = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
        ViewCompat.setOnApplyWindowInsetsListener(container) { view, insets ->
            val safe = insets.getInsets(handledTypes)
            view.setPadding(padding.left + safe.left, padding.top + safe.top, padding.right + safe.right, padding.bottom + safe.bottom)
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

    override fun onResume(activity: AppCompatActivity) {
        if (activeActivity !== activity) generation++
        activeActivity = activity
        destroyed = false
    }

    override fun onDestroy(activity: AppCompatActivity) {
        if (activeActivity !== activity) return
        generation++
        destroyed = true
        activeActivity = null
    }
}
