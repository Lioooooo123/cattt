import Foundation

enum DesktopV2Error: Error, LocalizedError {
    case enrollment, noLocalMember, unauthorized, wrongIdentity, trust, receiptRejected, service

    var errorDescription: String? {
        switch self {
        case .enrollment: return "请先确认这台 Mac 上的成员身份"
        case .noLocalMember: return "这台 Mac 没有本机成员。请先完成家庭结对。"
        case .unauthorized: return "聊天凭证已失效，请重新确认身份"
        case .wrongIdentity: return "宿主返回的成员或设备身份与批准内容不一致"
        case .trust: return "本机 HTTPS 证书或宿主身份不匹配"
        case .receiptRejected: return "宿主拒绝了这条待转交的消息，可以重新发送"
        case .service: return "本机服务暂不可用"
        }
    }
}

struct DesktopV2Enrollment {
    struct Status: Decodable {
        struct LAN: Decodable { let enabled: Bool; let port: UInt16 }
        let host_id: String
        let household_id: String
        let has_members: Bool
        let local_members: [V2.Member]
        let ca_fingerprint: String
        let lan: LAN
        let maintenance: Bool
        let sync_generation: String
    }

    struct Endpoint {
        let status: Status
        let scope: DesktopV2Scope
        let baseURL: URL
        let secure: URLSession

        func client(token: String) -> V2Client {
            V2Client(baseURL: baseURL, token: token, session: secure)
        }
    }

    struct Connection {
        let me: V2.Me
        let client: V2Client
    }

    private struct StoredCredential: Codable {
        let memberID: String
        let deviceID: String
        let token: String
    }

    private let data: URL
    private let port: UInt16
    private let tlsPort: UInt16
    private let keychain: any DeviceCredentialStore
    private let admin = URLSession(configuration: .ephemeral, delegate: BunLoopbackDelegate(), delegateQueue: nil)

    init(host: BunHost, keychain: any DeviceCredentialStore = KeychainDeviceCredentialStore(service: "app.cattt.host.bun-development.desktop-v2")) {
        data = host.data
        port = host.port
        tlsPort = host.lanPort
        self.keychain = keychain
    }

    func status() async throws -> Status {
        try await manage("GET", "status")
    }

    func discover() async throws -> Endpoint {
        let status = try await self.status()
        guard !status.maintenance, status.lan.enabled, status.lan.port == tlsPort else { throw DesktopV2Error.service }
        let pem = try String(contentsOf: data.appendingPathComponent("tls/ca.crt"), encoding: .utf8)
        guard let trust = HostTrustDelegate(pem), trust.fingerprint == status.ca_fingerprint else { throw DesktopV2Error.trust }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 30
        let secure = URLSession(configuration: configuration, delegate: trust, delegateQueue: nil)
        let scope = DesktopV2Scope(data: data, hostID: status.host_id, householdID: status.household_id, fingerprint: trust.fingerprint)
        let endpoint = Endpoint(status: status, scope: scope, baseURL: URL(string: "https://127.0.0.1:\(tlsPort)")!, secure: secure)
        struct Health: Decodable { let ok: Bool; let host_id: String; let protocol_version: Int }
        let client = endpoint.client(token: "")
        let health = try await client.json(Health.self, client.request("GET", "healthz"))
        guard health.ok, health.host_id == scope.hostID, health.protocol_version == 1 else { throw DesktopV2Error.trust }
        return endpoint
    }

    func saved(_ endpoint: Endpoint) async throws -> Connection? {
        guard let value = try keychain.load(account: endpoint.scope.key) else { return nil }
        let credential = try JSONDecoder().decode(StoredCredential.self, from: Data(value.utf8))
        do {
            return try await verify(credential, on: endpoint)
        } catch V2.APIError.unauthorized {
            throw DesktopV2Error.unauthorized
        }
    }

    func bootstrap(name: String) async throws -> V2.Member {
        struct Result: Decodable { let member: V2.Member }
        let result: Result = try await manage("POST", "members", body: ["display_name": name])
        return result.member
    }

    func approve(memberID: String, on endpoint: Endpoint) async throws -> Connection {
        guard endpoint.status.local_members.contains(where: { $0.id == memberID }) else {
            throw DesktopV2Error.enrollment
        }
        struct Approval: Decodable { let code: String; let port: UInt16; let ca_fingerprint: String }
        let approval: Approval = try await manage("POST", "pairing-codes", body: ["member_id": memberID])
        guard approval.port == tlsPort, approval.ca_fingerprint == endpoint.scope.fingerprint else { throw DesktopV2Error.trust }
        let pair = try await endpoint.client(token: "").pair(code: approval.code, deviceName: "团子 · 本机 Mac")
        guard pair.member.id == memberID, pair.household.id == endpoint.scope.householdID else { throw DesktopV2Error.wrongIdentity }
        let credential = StoredCredential(memberID: memberID, deviceID: pair.deviceId, token: pair.deviceToken)
        let connection = try await verify(credential, on: endpoint)
        let encoded = try JSONEncoder().encode(credential)
        try keychain.save(String(decoding: encoded, as: UTF8.self), account: endpoint.scope.key)
        return connection
    }

    private func verify(_ credential: StoredCredential, on endpoint: Endpoint) async throws -> Connection {
        let client = endpoint.client(token: credential.token)
        let me = try await client.me()
        guard me.actor.hostId == endpoint.scope.hostID, me.member.homeHostId == endpoint.scope.hostID,
              me.actor.householdId == endpoint.scope.householdID, me.household.id == endpoint.scope.householdID,
              me.actor.memberId == credential.memberID, me.member.id == credential.memberID,
              me.actor.deviceId == credential.deviceID else { throw DesktopV2Error.wrongIdentity }
        return Connection(me: me, client: client)
    }

    private func manage<Result: Decodable>(_ method: String, _ path: String, body: [String: String]? = nil) async throws -> Result {
        let token = try String(contentsOf: data.appendingPathComponent("host-admin.token"), encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else { throw DesktopV2Error.service }
        let url = URL(string: "http://127.0.0.1:\(port)")!
        var request = URLRequest(url: url.appending(path: "host/" + path), timeoutInterval: 5)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await admin.data(for: request)
        try V2Client(baseURL: url, token: "", session: admin).validate(response, data: data)
        return try JSONDecoder().decode(Result.self, from: data)
    }
}
