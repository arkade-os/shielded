package io.arkade.shielded.platform

import android.app.Activity
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.util.concurrent.Executors
import org.json.JSONObject

@InvokeArg
class SeedArgs { var value: String = "" }

@TauriPlugin
class ShieldedPlatformPlugin(activity: Activity) : Plugin(activity) {
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private val vault = AndroidSeedVault(activity)
    private var webview: WebView? = null

    override fun load(webView: WebView) { webview = webView }

    private fun trusted(): Boolean {
        val url = webview?.url?.let { Uri.parse(it) } ?: return false
        return url.port == -1 && url.userInfo == null &&
            ((url.scheme == "tauri" && url.host == "localhost") ||
             (url.scheme in listOf("http", "https") && url.host == "tauri.localhost"))
    }

    private fun secret(invoke: Invoke, operation: () -> JSObject?) {
        main.post {
            if (!trusted()) { invoke.reject("Native access is restricted to the bundled wallet"); return@post }
            worker.execute {
                try {
                    val result = operation()
                    main.post {
                        if (!trusted()) invoke.reject("Secure wallet storage unavailable")
                        else if (result == null) invoke.resolve() else invoke.resolve(result)
                    }
                } catch (_: Exception) { invoke.reject("Secure wallet storage unavailable") }
            }
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

    override fun onDestroy(activity: AppCompatActivity) { worker.shutdown() }
}
