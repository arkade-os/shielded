import AuthenticationServices
import CryptoKit
import Foundation
import UIKit

enum PlatformPasskeyError: String, Error {
    case cancelled = "Passkey cancelled"
    case unavailable = "Passkey unavailable"
}

private struct PasskeyInput {
    let challenge: Data
    let salt: Data
    let userID: Data
    let userName: String
    let credentials: [Data]
    static let rpID = "shielded.mutinynet.arkade.sh"

    init(_ raw: String, create: Bool) throws {
        guard raw.utf8.count <= 65536,
              let data = raw.data(using: .utf8),
              let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let extensions = json["extensions"] as? [String: Any],
              let prf = extensions["prf"] as? [String: Any],
              let eval = prf["eval"] as? [String: Any], eval["second"] == nil else { throw PlatformPasskeyError.unavailable }
        challenge = try Self.bytes(json["challenge"], min: 32, max: 32)
        salt = try Self.bytes(eval["first"], min: 1, max: 1024)
        if create {
            guard let rp = json["rp"] as? [String: Any], rp["id"] as? String == Self.rpID,
                  let user = json["user"] as? [String: Any],
                  let name = user["name"] as? String, !name.isEmpty, name.utf8.count <= 256, !name.contains("\0"),
                  let selection = json["authenticatorSelection"] as? [String: Any],
                  selection["userVerification"] as? String == "required", selection["residentKey"] as? String == "required",
                  let algorithms = json["pubKeyCredParams"] as? [[String: Any]],
                  algorithms.contains(where: { $0["type"] as? String == "public-key" && $0["alg"] as? Int == -7 }),
                  json["excludeCredentials"] == nil || (json["excludeCredentials"] as? [Any])?.isEmpty == true else { throw PlatformPasskeyError.unavailable }
            userID = try Self.bytes(user["id"], min: 1, max: 64)
            userName = name
            credentials = []
        } else {
            guard json["rpId"] as? String == Self.rpID, json["userVerification"] as? String == "required" else { throw PlatformPasskeyError.unavailable }
            let allowed: [[String: Any]]
            if let value = json["allowCredentials"] {
                guard let entries = value as? [[String: Any]], entries.count <= 32 else { throw PlatformPasskeyError.unavailable }
                allowed = entries
            } else { allowed = [] }
            credentials = try allowed.map { entry in
                guard entry["type"] as? String == "public-key" else { throw PlatformPasskeyError.unavailable }
                return try Self.bytes(entry["id"], min: 1, max: 1024)
            }
            userID = Data()
            userName = ""
        }
    }

    private static func bytes(_ value: Any?, min: Int, max: Int) throws -> Data {
        guard let encoded = value as? String, !encoded.isEmpty, encoded.utf8.count <= (max * 4 + 2) / 3,
              encoded.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else { throw PlatformPasskeyError.unavailable }
        let padded = encoded.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + String(repeating: "=", count: (4 - encoded.count % 4) % 4)
        guard let bytes = Data(base64Encoded: padded), (min...max).contains(bytes.count), bytes.passkeyBase64 == encoded else { throw PlatformPasskeyError.unavailable }
        return bytes
    }
}

private extension Data {
    var passkeyBase64: String { base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
}

final class PlatformPasskeys {
    private var active: AnyObject?

    static func supported(_ configured: Bool) -> Bool {
        if #available(iOS 18.0, *) { return configured }
        return false
    }

    func run(_ request: String, create: Bool, window: UIWindow, complete: @escaping (Result<String, PlatformPasskeyError>) -> Void) {
        guard #available(iOS 18.0, *), active == nil else { complete(.failure(.unavailable)); return }
        do {
            let ceremony = try PasskeyCeremony(input: PasskeyInput(request, create: create), create: create, window: window) { [weak self] result in
                self?.active = nil
                complete(result)
            }
            active = ceremony
            ceremony.start()
        } catch { complete(.failure(.unavailable)) }
    }

    func cancel() {
        if #available(iOS 18.0, *), let ceremony = active as? PasskeyCeremony { ceremony.cancel() }
    }
}

@available(iOS 18.0, *)
private final class PasskeyCeremony: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    private let window: UIWindow
    private let input: PasskeyInput
    private let create: Bool
    private var controller: ASAuthorizationController?
    private var completion: ((Result<String, PlatformPasskeyError>) -> Void)?

    init(input: PasskeyInput, create: Bool, window: UIWindow, completion: @escaping (Result<String, PlatformPasskeyError>) -> Void) throws {
        self.input = input
        self.create = create
        self.window = window
        self.completion = completion
        super.init()
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: PasskeyInput.rpID)
        let request: ASAuthorizationRequest
        // These are WebAuthn PRF inputs; AuthenticationServices applies its domain separation.
        let values = ASAuthorizationPublicKeyCredentialPRFAssertionInput.InputValues.saltInput1(input.salt, saltInput2: nil)
        if create {
            let registration = provider.createCredentialRegistrationRequest(challenge: input.challenge, name: input.userName, userID: input.userID)
            registration.userVerificationPreference = .required
            registration.prf = .inputValues(values)
            request = registration
        } else {
            let assertion = provider.createCredentialAssertionRequest(challenge: input.challenge)
            assertion.allowedCredentials = input.credentials.map { ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0) }
            assertion.userVerificationPreference = .required
            assertion.prf = .inputValues(values)
            request = assertion
        }
        controller = ASAuthorizationController(authorizationRequests: [request])
        controller?.delegate = self
        controller?.presentationContextProvider = self
    }

    func start() { controller?.performRequests() }
    func cancel() { controller?.cancel(); finish(.failure(.cancelled)) }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor { window }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        do {
            let id: Data, handle: Data?, key: SymmetricKey?, enabled: Bool?
            if create, let credential = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration {
                id = credential.credentialID
                handle = nil
                key = credential.prf?.first
                enabled = credential.prf?.isSupported ?? false
            } else if !create, let credential = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion {
                id = credential.credentialID
                handle = credential.userID.isEmpty ? nil : credential.userID
                key = credential.prf?.first
                enabled = nil
                guard input.credentials.isEmpty || input.credentials.contains(id) else { throw PlatformPasskeyError.unavailable }
            } else { throw PlatformPasskeyError.unavailable }
            guard (1...1024).contains(id.count), (handle?.count ?? 0) <= 64 else { throw PlatformPasskeyError.unavailable }
            var prf: [String: Any] = [:]
            if let enabled = enabled { prf["enabled"] = enabled }
            if let key = key {
                var bytes = key.withUnsafeBytes { Data($0) }
                defer { bytes.resetBytes(in: 0..<bytes.count) }
                guard bytes.count == 32 else { throw PlatformPasskeyError.unavailable }
                prf["results"] = ["first": bytes.passkeyBase64]
            }
            let response: [String: Any] = ["id": id.passkeyBase64, "rawId": id.passkeyBase64, "type": "public-key", "response": ["userHandle": handle.map { $0.passkeyBase64 } as Any? ?? NSNull()], "clientExtensionResults": ["prf": prf]]
            let encoded = try JSONSerialization.data(withJSONObject: response)
            guard let json = String(data: encoded, encoding: .utf8) else { throw PlatformPasskeyError.unavailable }
            finish(.success(json))
        } catch { finish(.failure(.unavailable)) }
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        let cancelled = (error as? ASAuthorizationError)?.code == .canceled
        finish(.failure(cancelled ? .cancelled : .unavailable))
    }

    private func finish(_ result: Result<String, PlatformPasskeyError>) {
        guard Thread.isMainThread else { DispatchQueue.main.async { self.finish(result) }; return }
        guard let complete = completion else { return }
        completion = nil
        controller?.delegate = nil
        controller?.presentationContextProvider = nil
        controller = nil
        complete(result)
    }
}
