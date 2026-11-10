import Foundation
import Security

enum SeedVaultError: Error { case unavailable }

final class SeedVault {
    private let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "io.arkade.shielded.native.v1",
        kSecAttrAccount as String: "seed",
        kSecAttrSynchronizable as String: false,
    ]

    func get() throws -> String? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecReturnAttributes as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let item = result as? [String: Any],
              item[kSecAttrAccessible as String] as? String == kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String,
              let data = item[kSecValueData as String] as? Data,
              let value = String(data: data, encoding: .utf8), validSeed(value) else { throw SeedVaultError.unavailable }
        return value
    }

    func set(_ value: String) throws {
        guard validSeed(value) else { throw SeedVaultError.unavailable }
        let attributes: [String: Any] = [
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            attributes.forEach { item[$0.key] = $0.value }
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw SeedVaultError.unavailable }
        } else if status != errSecSuccess { throw SeedVaultError.unavailable }
    }

    func clear() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw SeedVaultError.unavailable }
    }

    private func validSeed(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
}
