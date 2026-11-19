import Foundation
import Security

enum PairVault {
    private static let key: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "com.maomao.paired-host", kSecAttrAccount as String: "host"]
    static func load() -> PairedHost? {
        var query = key
        query[kSecReturnData as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data,
              let paired = try? JSONDecoder().decode(PairedHost.self, from: data),
              PairFingerprint.valid(paired.fingerprint), !paired.hosts.isEmpty,
              paired.hosts.allSatisfy(PairInvitation.validHost), (1...65535).contains(paired.port) else { return nil }
        return paired
    }
    static func save(_ paired: PairedHost?) throws {
        guard let paired else {
            let status = SecItemDelete(key as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw PairingError.storage }
            return
        }
        let update: [String: Any] = [kSecValueData as String: try JSONEncoder().encode(paired),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(key as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound { status = SecItemAdd(key.merging(update) { _, b in b } as CFDictionary, nil) }
        guard status == errSecSuccess else { throw PairingError.storage }
    }
}
