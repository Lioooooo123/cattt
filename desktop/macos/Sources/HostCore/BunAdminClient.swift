import CryptoKit
import Darwin
import Foundation
import Security

public enum BunAdminError: Error, LocalizedError, Equatable {
    case invalidDescriptor, invalidAddress, invalidID, fingerprintMismatch, missingToken, unavailable, invalidResponse
    case response(Int, String?)

    public var errorDescription: String? {
        switch self {
        case .invalidDescriptor: return "结对描述符无效，或证书与其中的指纹不符。请让对方重新导出。"
        case .invalidAddress: return "请输入局域网 IPv4 或 .local 地址，以及有效的端口。"
        case .invalidID: return "标识无效，请刷新设置。"
        case .fingerprintMismatch: return "请输入通过可信途径核对的完整 64 位指纹。"
        case .missingToken: return "本机管理凭证尚未就绪，请检查宿主状态。"
        case .unavailable: return "无法连接本机宿主，请检查菜单栏中的服务状态后重试。"
        case .invalidResponse: return "宿主返回了无法读取的设置数据，请检查应用与宿主版本。"
        case .response(let status, let code):
            switch code {
            case "unauthorized": return "本机管理鉴权失败，请检查当前数据目录和宿主进程。"
            case "peer_certificate_invalid": return "对端证书校验失败，请检查系统日期并重新交换描述符。"
            case "peer_household_conflict": return "只有空白宿主可以加入已有家庭。请检查两台 Mac 的家庭归属。"
            case "peer_protocol_unsupported": return "两台 Mac 的同步协议不兼容，请更新后重新结对。"
            case "peer_connection_failed": return "无法完成对端握手。请确认两台 Mac 在同一局域网、地址正确，且对方已核对完整指纹并批准。"
            case "peer_not_active": return "这台 Mac 当前没有有效结对，请刷新状态或重新批准并连接。"
            case "peer_sync_pending": return "请等创建家庭的 Mac 同步首位成员和群聊，再生成邀请。"
            case "members_already_initialized": return "首位成员已建立，或当前 Mac 加入了已有家庭。"
            case "member_limit": return "家庭没有空余名额。若有待接受的邀请，可以先撤销。"
            case "invalid_request": return "宿主拒绝了请求，请核对当前家庭、成员归属和输入。"
            default: return status == 404
                ? "宿主没有提供这个管理入口，请检查同步监听及成品版本。"
                : "宿主操作失败（HTTP \(status)），请重试或查看 logs/bun.log。"
            }
        }
    }
}

public struct PeerAddress: Codable, Equatable {
    public let host: String
    public let port: UInt16

    private var isLocal: Bool {
        if host == "localhost" { return true }
        if host.utf8.count <= 253, host.range(
            of: #"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+local$"#,
            options: [.regularExpression, .caseInsensitive]
        ) != nil { return true }
        var address = in_addr()
        guard inet_pton(AF_INET, host, &address) == 1 else { return false }
        let bytes = UInt32(bigEndian: address.s_addr)
        let first = bytes >> 24
        let second = (bytes >> 16) & 255
        return first == 10 || first == 127 || (first == 192 && second == 168)
            || (first == 169 && second == 254) || (first == 172 && (16...31).contains(second))
    }

    var isValid: Bool { port > 0 && !host.utf8.contains(0) && isLocal }
}

public struct PeerDescriptor: Codable, Equatable {
    public let hostID: String
    public let householdID: String
    public let protocolVersion: Int
    public let fingerprint: String
    public let address: PeerAddress
    private let caCertificate: String
    private let certificate: String

    enum CodingKeys: String, CodingKey {
        case hostID = "host_id", householdID = "household_id", protocolVersion = "protocol_version"
        case fingerprint, address, caCertificate = "ca_certificate", certificate
    }

    public static let maxImportBytes = 32_768

    public static func importJSON(_ data: Data) throws -> Self {
        guard data.count <= maxImportBytes,
              let identity = try? JSONDecoder().decode(Self.self, from: data),
              identity.isValid else { throw BunAdminError.invalidDescriptor }
        return identity
    }

    public func exportJSON() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(self)
    }

    public func atAddress(host: String, port: UInt16) throws -> Self {
        let address = PeerAddress(host: host.trimmingCharacters(in: .whitespacesAndNewlines), port: port)
        guard address.isValid else { throw BunAdminError.invalidAddress }
        return Self(hostID: hostID, householdID: householdID, protocolVersion: protocolVersion,
                    fingerprint: fingerprint, address: address, caCertificate: caCertificate, certificate: certificate)
    }

    public func matchesVerifiedFingerprint(_ input: String) -> Bool {
        fingerprint == input.filter { !$0.isWhitespace && $0 != ":" }.lowercased()
    }

    private static func certificateDER(_ pem: String) -> Data? {
        let lines = pem.split(whereSeparator: \.isNewline)
        guard pem.utf8.count <= 8_192, lines.first == "-----BEGIN CERTIFICATE-----",
              lines.last == "-----END CERTIFICATE-----",
              let der = Data(base64Encoded: lines.dropFirst().dropLast().joined()),
              SecCertificateCreateWithData(nil, der as CFData) != nil else { return nil }
        return der
    }

    var isValid: Bool {
        guard [hostID, householdID].allSatisfy({
            UUID(uuidString: $0) != nil && $0.utf8.dropFirst(14).first == 55
        }), protocolVersion > 0, address.isValid,
           Self.certificateDER(caCertificate) != nil, let leaf = Self.certificateDER(certificate) else { return false }
        return SHA256.hash(data: leaf).map { String(format: "%02x", $0) }.joined() == fingerprint
    }
}

public struct BunPeerIdentity {
    public let descriptor: PeerDescriptor
    public let expiresAt: Date?
}

public enum PeerPairingAction {
    case approve, connect, allowJoin, join
}

public struct PeerSyncState: Decodable {
    public enum Status: String, Decodable {
        case unpaired, revoked, paused, pending, pulling, caughtUp = "caught_up"
        case waiting, unavailable, upgradeRequired = "upgrade_required", error

        public var title: String {
            switch self {
            case .unpaired: return "已批准，等待握手"
            case .revoked: return "信任已撤销"
            case .paused: return "本机拉取已暂停"
            case .pending: return "等待同步"
            case .pulling: return "正在拉取"
            case .caughtUp: return "上次检查已追平"
            case .waiting: return "等待依赖数据"
            case .unavailable: return "暂时连不到对方"
            case .upgradeRequired: return "同步协议需要更新"
            case .error: return "同步失败"
            }
        }

        public var recovery: String? {
            switch self {
            case .unpaired: return "在对方 Mac 上核对指纹，并完成批准或连接。"
            case .waiting: return "已保存上次水位，宿主会继续重试。"
            case .unavailable: return "检查对方是否在线，以及局域网地址和双方批准状态。宿主会自动重试。"
            case .upgradeRequired: return "更新两台 Mac 的宿主后重新核对指纹并连接。"
            case .error: return "已保存上次水位。若持续失败，请查看开发数据目录里的 logs/bun.log。"
            default: return nil
            }
        }
    }

    public struct Cursor: Decodable, Equatable {
        public let sourceHostID: String
        public let generation: String
        public let sequence: Int64

        enum CodingKeys: String, CodingKey {
            case sourceHostID = "source_host_id", generation, sequence = "seq"
        }
    }

    public let status: Status
    public let paused: Bool
    public let cursor: Cursor?
    public let lastSuccessAt: Int64?
    public let lastAttemptAt: Int64?
    public let errorCode: String?

    enum CodingKeys: String, CodingKey {
        case status, paused, cursor
        case lastSuccessAt = "last_success_at", lastAttemptAt = "last_attempt_at", errorCode = "error_code"
    }
}

public struct BunPeer: Decodable, Identifiable {
    public enum Status: String, Decodable { case approved, paired, revoked }

    public let id: String
    public let address: PeerAddress
    public let fingerprint: String
    public let status: Status
    public let access: String?
    public let sync: PeerSyncState

    enum CodingKeys: String, CodingKey {
        case id = "host_id", address, fingerprint, status, access, sync
    }
}

public struct BunMember: Decodable, Identifiable {
    public let id: String
    public let displayName: String
    public let homeHostID: String

    enum CodingKeys: String, CodingKey {
        case id, displayName = "display_name", homeHostID = "home_host_id"
    }
}

public struct BunMemberState: Decodable {
    public struct Household: Decodable {
        public let id: String
        public let name: String
        public let originHostID: String

        enum CodingKeys: String, CodingKey { case id, name, originHostID = "origin_host_id" }
    }

    public let hostID: String
    public let household: Household
    public let members: [BunMember]
    public let maxMembers: Int

    public var isCreator: Bool { household.originHostID == hostID }
    public var localMembers: [BunMember] { members.filter { $0.homeHostID == hostID } }

    enum CodingKeys: String, CodingKey {
        case hostID = "host_id", household, members, maxMembers = "max_members"
    }
}

public struct BunOpenInvite: Decodable, Identifiable {
    public let id: String
    public let displayName: String?
    public let expiresAt: Int64

    enum CodingKeys: String, CodingKey { case id, displayName = "display_name", expiresAt = "expires_at" }
}

public struct BunPhoneCode: Decodable {
    public let code: String
    public let expiresAt: Int64
    public let url: URL
    public let caFingerprint: String

    enum CodingKeys: String, CodingKey {
        case code, expiresAt = "expires_at", url = "pair_url", caFingerprint = "ca_fingerprint"
    }
}

public struct BunMemberInvite: Decodable {
    public let id: String
    public let code: String
    public let expiresAt: Int64
    public let url: URL

    enum CodingKeys: String, CodingKey {
        case id = "invite_id", code, expiresAt = "expires_at", url = "invite_url"
    }
}

public struct BunAdminClient {
    private let dataDirectory: URL
    private let baseURL: URL
    private let session: URLSession

    public init(dataDirectory: URL, port: UInt16) {
        self.dataDirectory = dataDirectory
        baseURL = URL(string: "http://127.0.0.1:\(port)")!
        session = URLSession(configuration: .ephemeral, delegate: BunLoopbackDelegate(), delegateQueue: nil)
    }

    public func identity() async throws -> BunPeerIdentity {
        let (data, response) = try await send("peer-identity")
        let descriptor = try PeerDescriptor.importJSON(data)
        let expiresAt = response.value(forHTTPHeaderField: "x-cattt-peer-certificate-expires-at")
            .flatMap(Int64.init).map { Date(timeIntervalSince1970: Double($0) / 1_000) }
        return BunPeerIdentity(descriptor: descriptor, expiresAt: expiresAt)
    }

    public func peers() async throws -> [BunPeer] {
        struct Result: Decodable { let peers: [BunPeer] }
        return try await get(Result.self, "peers").peers
    }

    public func pair(_ identity: PeerDescriptor, verifiedFingerprint: String, action: PeerPairingAction) async throws -> BunPeer {
        guard identity.matchesVerifiedFingerprint(verifiedFingerprint) else { throw BunAdminError.fingerprintMismatch }
        struct Body: Encodable {
            let identity: PeerDescriptor
            let confirmed_fingerprint: String
            let allow_join: Bool?
            let join_household: Bool?
        }
        struct Result: Decodable { let peer: BunPeer }
        let connecting = action == .connect || action == .join
        let path = connecting ? "peers/connect" : try resource("peers", id: identity.hostID)
        return try await change(Result.self, path, method: connecting ? "POST" : "PUT", body: Body(
            identity: identity, confirmed_fingerprint: identity.fingerprint,
            allow_join: action == .allowJoin ? true : nil, join_household: action == .join ? true : nil
        )).peer
    }

    public func setPaused(_ paused: Bool, hostID: String) async throws -> BunPeer {
        struct Result: Decodable { let peer: BunPeer }
        return try await change(Result.self, resource("peers", id: hostID) + "/sync",
                                method: "PUT", body: ["paused": paused]).peer
    }

    public func revokePeer(hostID: String) async throws {
        try await remove(resource("peers", id: hostID))
    }

    public func members() async throws -> BunMemberState {
        try await get(BunMemberState.self, "members")
    }

    public func createFirstMember(name: String) async throws -> BunMember {
        struct Result: Decodable { let member: BunMember }
        return try await change(Result.self, "members", body: ["display_name": name]).member
    }

    public func phoneCode(memberID: String) async throws -> BunPhoneCode {
        try await change(BunPhoneCode.self, "pairing-codes", body: ["member_id": memberID])
    }

    public func invite(name: String) async throws -> BunMemberInvite {
        try await change(BunMemberInvite.self, "invites", body: ["display_name": name])
    }

    public func openInvites() async throws -> [BunOpenInvite] {
        struct Result: Decodable { let invites: [BunOpenInvite] }
        return try await get(Result.self, "invites").invites
    }

    public func revokeInvite(id: String) async throws {
        try await remove(resource("invites", id: id))
    }

    private func resource(_ collection: String, id: String) throws -> String {
        guard UUID(uuidString: id) != nil else { throw BunAdminError.invalidID }
        return "\(collection)/\(id)"
    }

    private func get<T: Decodable>(_ type: T.Type, _ path: String) async throws -> T {
        try decode(type, from: await send(path).0)
    }

    private func change<T: Decodable, Body: Encodable>(
        _ type: T.Type, _ path: String, method: String = "POST", body: Body
    ) async throws -> T {
        try decode(type, from: await send(path, method: method, body: JSONEncoder().encode(body)).0)
    }

    private func remove(_ path: String) async throws {
        struct Result: Decodable { let ok: Bool }
        let result = try decode(Result.self, from: await send(path, method: "DELETE").0)
        guard result.ok else { throw BunAdminError.invalidResponse }
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do { return try JSONDecoder().decode(type, from: data) }
        catch { throw BunAdminError.invalidResponse }
    }

    private func send(_ path: String, method: String = "GET", body: Data? = nil) async throws -> (Data, HTTPURLResponse) {
        struct Failure: Decodable {
            struct Detail: Decodable { let code: String }
            let error: Detail
        }
        let token = try Self.adminToken(in: dataDirectory)
        var request = URLRequest(url: baseURL.appendingPathComponent("host/" + path), timeoutInterval: 12)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        let data: Data
        let rawResponse: URLResponse
        do { (data, rawResponse) = try await session.data(for: request) }
        catch {
            try Task.checkCancellation()
            throw BunAdminError.unavailable
        }
        guard let response = rawResponse as? HTTPURLResponse else { throw BunAdminError.invalidResponse }
        guard (200..<300).contains(response.statusCode) else {
            let failure = try? JSONDecoder().decode(Failure.self, from: data)
            throw BunAdminError.response(response.statusCode, failure?.error.code)
        }
        return (data, response)
    }

    static func adminToken(in dataDirectory: URL) throws -> String {
        guard let token = try? String(contentsOf: dataDirectory.appendingPathComponent("host-admin.token"), encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !token.isEmpty else { throw BunAdminError.missingToken }
        return token
    }
}
