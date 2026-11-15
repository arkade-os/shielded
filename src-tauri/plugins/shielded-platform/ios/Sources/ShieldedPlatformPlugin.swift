import Foundation
import Tauri
import UIKit
import WebKit

@_silgen_name("shielded_native_did_become_active")
private func nativeDidBecomeActive()

private struct SeedArgs: Decodable { let value: String }
private struct PasskeyArgs: Decodable { let request: String }
private struct PasskeySupportArgs: Decodable { let configured: Bool }

final class ShieldedPlatformPlugin: Plugin {
    private weak var webview: WKWebView?
    private let worker = DispatchQueue(label: "io.arkade.shielded.vault")
    private let vault = SeedVault()
    private let passkeys = PlatformPasskeys()
    private var activationObserver: NSObjectProtocol?

    override init() {
        super.init()
        activationObserver = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            nativeDidBecomeActive()
        }
    }

    override func load(webview: WKWebView) {
        passkeys.cancel()
        self.webview = webview
    }

    deinit {
        if let observer = activationObserver { NotificationCenter.default.removeObserver(observer) }
    }

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

    @objc public func secretCreate(_ invoke: Invoke) {
        secret(invoke) {
            try self.vault.create(invoke.parseArgs(SeedArgs.self).value)
            return nil
        }
    }

    @objc public func secretClear(_ invoke: Invoke) {
        secret(invoke) {
            try self.vault.clear()
            return nil
        }
    }

    @objc public func passkeySupport(_ invoke: Invoke) {
        DispatchQueue.main.async {
            guard self.trusted() else { invoke.reject("Native access is restricted to the bundled wallet"); return }
            do {
                let configured = try invoke.parseArgs(PasskeySupportArgs.self).configured
                let available = PlatformPasskeys.supported(configured)
                var response: JsonObject = ["available": available]
                if !available { response["reason"] = "Apple passkeys require iOS 18 and an associated-domain signing configuration." }
                invoke.resolve(response)
            } catch { invoke.reject(PlatformPasskeyError.unavailable.rawValue) }
        }
    }

    private func passkey(_ invoke: Invoke, create: Bool) {
        DispatchQueue.main.async {
            guard self.trusted(), let webview = self.webview, let window = webview.window else { invoke.reject(PlatformPasskeyError.unavailable.rawValue); return }
            let identity = ObjectIdentifier(webview)
            do {
                let request = try invoke.parseArgs(PasskeyArgs.self).request
                self.passkeys.run(request, create: create, window: window) { result in
                    guard self.webview.map(ObjectIdentifier.init) == identity, self.webview?.window === window, self.trusted() else { invoke.reject(PlatformPasskeyError.unavailable.rawValue); return }
                    switch result {
                    case .success(let response): invoke.resolve(["response": response])
                    case .failure(let error): invoke.reject(error.rawValue)
                    }
                }
            } catch { invoke.reject(PlatformPasskeyError.unavailable.rawValue) }
        }
    }

    @objc public func passkeyCreate(_ invoke: Invoke) { passkey(invoke, create: true) }
    @objc public func passkeyGet(_ invoke: Invoke) { passkey(invoke, create: false) }
}

@_cdecl("init_plugin_shielded_platform")
public func initPlugin() -> Plugin { ShieldedPlatformPlugin() }
