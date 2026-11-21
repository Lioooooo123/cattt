import Foundation
import Security

struct V2Connection: Codable {
    let hosts: [String]
    let port: Int
    let fingerprint: String
    let identity: V2.PairResult
    func client(host: String) -> V2Client {
        var url = URLComponents()
        url.scheme = "https"; url.host = host; url.port = port
        return V2Client(baseURL: url.url!, token: identity.deviceToken, session: PairTransport.session(fingerprint: fingerprint))
    }
    func select() async throws -> V2Client {
        for host in hosts {
            try Task.checkCancellation()
            let client = client(host: host)
            var request = try client.request("GET", "healthz")
            request.timeoutInterval = 4
            if let (_, response) = try? await client.session.data(for: request), (response as? HTTPURLResponse)?.statusCode == 200 { return client }
        }
        throw PairingError.unavailable
    }
}

extension V2Connection {
    private enum CodingKeys: String, CodingKey { case hosts, port, fingerprint, identity }
    private struct StoredMember: Codable {
        let id: String; let householdId: String; let displayName: String; let homeHostId: String
        init(_ member: V2.Member) {
            id = member.id; householdId = member.householdId; displayName = member.displayName; homeHostId = member.homeHostId
        }
        var value: V2.Member { .init(id: id, householdId: householdId, displayName: displayName, homeHostId: homeHostId) }
    }
    private struct StoredIdentity: Codable {
        let deviceId: String; let deviceToken: String; let member: StoredMember; let household: V2.Household
        init(_ identity: V2.PairResult) {
            deviceId = identity.deviceId; deviceToken = identity.deviceToken
            member = StoredMember(identity.member); household = identity.household
        }
        var value: V2.PairResult { .init(deviceId: deviceId, deviceToken: deviceToken, member: member.value, household: household) }
    }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        self.init(hosts: try values.decode([String].self, forKey: .hosts), port: try values.decode(Int.self, forKey: .port),
                  fingerprint: try values.decode(String.self, forKey: .fingerprint), identity: try values.decode(StoredIdentity.self, forKey: .identity).value)
    }
    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(hosts, forKey: .hosts); try values.encode(port, forKey: .port)
        try values.encode(fingerprint, forKey: .fingerprint); try values.encode(StoredIdentity(identity), forKey: .identity)
    }
}

enum V2Vault {
    private static let key: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "com.maomao.v2-device", kSecAttrAccount as String: "host"]
    static func load() -> V2Connection? {
        var query = key
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data, let connection = try? JSONDecoder().decode(V2Connection.self, from: data),
              PairFingerprint.valid(connection.fingerprint), !connection.hosts.isEmpty,
              connection.hosts.allSatisfy(PairInvitation.validHost), (1...65535).contains(connection.port) else { return nil }
        return connection
    }
    static func save(_ connection: V2Connection?) throws {
        guard let connection else {
            let status = SecItemDelete(key as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw PairingError.storage }
            return
        }
        let update: [String: Any] = [kSecValueData as String: try JSONEncoder().encode(connection),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(key as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound { status = SecItemAdd(key.merging(update) { _, b in b } as CFDictionary, nil) }
        guard status == errSecSuccess else { throw PairingError.storage }
    }
}

@MainActor
final class V2Outbox {
    struct Entry: Codable, Identifiable, Equatable {
        let id: String
        let conversationID: String
        let text: String
    }
    private let defaults: UserDefaults
    private let storageKey: String
    private(set) var entries: [Entry]
    init(identity: String, defaults: UserDefaults = .standard) {
        self.defaults = defaults
        storageKey = "v2.outbox." + identity
        entries = defaults.data(forKey: storageKey).flatMap { try? JSONDecoder().decode([Entry].self, from: $0) } ?? []
    }
    @discardableResult func enqueue(conversation: String, text: String) -> Entry {
        let entry = Entry(id: UUID().uuidString, conversationID: conversation, text: text)
        entries.append(entry); persist()
        return entry
    }
    func acknowledge(_ id: String) { entries.removeAll { $0.id == id }; persist() }
    private func persist() { defaults.set(try? JSONEncoder().encode(entries), forKey: storageKey) }
}

@MainActor
final class V2ReplyRequests {
    private let defaults: UserDefaults
    private let prefix: String
    init(deviceID: String, defaults: UserDefaults = .standard) {
        self.defaults = defaults
        prefix = "v2.reply." + deviceID + "."
    }
    func requestID(message: String) -> String {
        let key = prefix + message
        if let existing = defaults.string(forKey: key) { return existing }
        let id = UUID().uuidString
        defaults.set(id, forKey: key)
        return id
    }
    func acknowledge(message: String) { defaults.removeObject(forKey: prefix + message) }
}
