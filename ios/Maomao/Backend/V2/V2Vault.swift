import Foundation
import Security

struct V2Connection: Codable {
    let hosts: [String]
    let port: Int
    let fingerprint: String
    let identity: V2.PairResult
    func select() async throws -> V2Client {
        try await Self.select(hosts: hosts, port: port, fingerprint: fingerprint, token: identity.deviceToken)
    }
    static func select(hosts: [String], port: Int, fingerprint: String, token: String = "") async throws -> V2Client {
        let session = PairTransport.session(fingerprint: fingerprint)
        for host in hosts {
            try Task.checkCancellation()
            var url = URLComponents()
            url.scheme = "https"; url.host = host; url.port = port
            let client = V2Client(baseURL: url.url!, token: token, session: session)
            var request = try V2Client(baseURL: client.baseURL, token: "", session: session).request("GET", "healthz")
            request.timeoutInterval = 4
            if let (_, response) = try? await session.data(for: request), (response as? HTTPURLResponse)?.statusCode == 200 { return client }
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
    private static func key(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "com.maomao.v2-device", kSecAttrAccount as String: account]
    }

    static func load() -> V2Connection? {
        guard let connection = read(V2Connection.self, account: "host"),
              PairFingerprint.valid(connection.fingerprint), !connection.hosts.isEmpty,
              connection.hosts.allSatisfy(PairInvitation.validHost), (1...65535).contains(connection.port) else { return nil }
        return connection
    }

    static func save(_ connection: V2Connection?) throws {
        try write(connection, account: "host")
    }

    static var retirements: [V2Connection] {
        read([V2Connection].self, account: "retirements") ?? []
    }

    static func retire(_ connection: V2Connection) throws {
        var pending = retirements
        if pending.contains(where: { $0.identity.deviceId == connection.identity.deviceId }) { return }
        pending.append(connection)
        try write(pending, account: "retirements")
    }

    static func finishRetiring(_ deviceID: String) throws {
        let rest = retirements.filter { $0.identity.deviceId != deviceID }
        try write(rest.isEmpty ? nil : rest, account: "retirements")
    }

    private static func read<Value: Decodable>(_ type: Value.Type, account: String) -> Value? {
        var query = key(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    private static func write<Value: Encodable>(_ value: Value?, account: String) throws {
        let query = key(account)
        guard let value else {
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw PairingError.storage }
            return
        }
        let update: [String: Any] = [kSecValueData as String: try JSONEncoder().encode(value),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound { status = SecItemAdd(query.merging(update) { _, b in b } as CFDictionary, nil) }
        guard status == errSecSuccess else { throw PairingError.storage }
    }
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
