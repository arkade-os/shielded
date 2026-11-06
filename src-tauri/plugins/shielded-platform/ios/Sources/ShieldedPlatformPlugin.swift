import Foundation
import Tauri
import WebKit

private struct SeedArgs: Decodable { let value: String }

final class ShieldedPlatformPlugin: Plugin {
    private weak var webview: WKWebView?
    private let worker = DispatchQueue(label: "io.arkade.shielded.vault")
    private let vault = SeedVault()

    override func load(webview: WKWebView) { self.webview = webview }

    private func trusted() -> Bool {
        guard let url = webview?.url, url.port == nil, url.user == nil, url.password == nil else { return false }
        return (url.scheme == "tauri" && url.host == "localhost") ||
            (["http", "https"].contains(url.scheme ?? "") && url.host == "tauri.localhost")
    }

    private func secret(_ invoke: Invoke, operation: @escaping () throws -> JsonObject?) {
        DispatchQueue.main.async {
            guard self.trusted(), let identity = self.webview.map(ObjectIdentifier.init) else { invoke.reject("Native access is restricted to the bundled wallet"); return }
            self.worker.async {
                do {
                    guard DispatchQueue.main.sync(execute: { self.webview.map(ObjectIdentifier.init) == identity && self.trusted() }) else { throw SeedVaultError.unavailable }
                    let result = try operation()
                    DispatchQueue.main.async {
                        guard self.webview.map(ObjectIdentifier.init) == identity, self.trusted() else { invoke.reject("Secure wallet storage unavailable"); return }
                        if let result = result { invoke.resolve(result) } else { invoke.resolve() }
                    }
                } catch { DispatchQueue.main.async { invoke.reject("Secure wallet storage unavailable") } }
            }
        }
    }

    @objc public func secretGet(_ invoke: Invoke) {
        secret(invoke) { ["value": try self.vault.get() as Any? ?? NSNull()] }
    }

    @objc public func secretSet(_ invoke: Invoke) {
        secret(invoke) {
            try self.vault.set(invoke.parseArgs(SeedArgs.self).value)
            return nil
        }
    }
}

@_cdecl("init_plugin_shielded_platform")
public func initPlugin() -> Plugin { ShieldedPlatformPlugin() }
