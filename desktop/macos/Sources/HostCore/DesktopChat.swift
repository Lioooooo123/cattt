import CryptoKit
import Foundation
import Security

public protocol DeviceCredentialStore: Sendable {
    func load(account: String) throws -> String?
    func save(_ credential: String, account: String) throws
    func delete(account: String) throws
}

public enum DeviceCredentialError: Error, LocalizedError {
    case keychain(OSStatus)

    public var errorDescription: String? {
        switch self {
        case .keychain(let status): return "读取电脑端凭证失败（钥匙串错误 \(status)）"
        }
    }
}

public struct KeychainDeviceCredentialStore: DeviceCredentialStore {
    private let service = "app.cattt.host.desktop-device-token"

    public init() {}

    public static func account(for dataDirectory: URL) -> String {
        let path = dataDirectory.standardizedFileURL.resolvingSymlinksInPath().path
        return SHA256.hash(data: Data(path.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    public func load(account: String) throws -> String? {
        var query = baseQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else {
            throw DeviceCredentialError.keychain(status)
        }
        return value
    }

    public func save(_ credential: String, account: String) throws {
        let query = baseQuery(account: account)
        let attributes: [String: Any] = [
            kSecValueData as String: Data(credential.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            attributes.forEach { item[$0.key] = $0.value }
            let addStatus = SecItemAdd(item as CFDictionary, nil)
            guard addStatus == errSecSuccess else { throw DeviceCredentialError.keychain(addStatus) }
        } else if status != errSecSuccess {
            throw DeviceCredentialError.keychain(status)
        }
    }

    public func delete(account: String) throws {
        let status = SecItemDelete(baseQuery(account: account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw DeviceCredentialError.keychain(status)
        }
    }

    private func baseQuery(account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }
}

public struct DesktopChatIdentity: Decodable, Equatable, Sendable {
    public struct Cat: Decodable, Equatable, Sendable {
        public let name: String
    }
    public let accountId: String
    public let cat: Cat
}

public struct DesktopServerMessage: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let seq: Int
    public let role: String
    public let text: String
    public let status: String
    public let clientMessageId: String?
    public let turnId: String?
    public let createdAt: String?
}

public struct SSEFrame: Equatable, Sendable {
    public let event: String
    public let id: String?
    public let data: String
}

public struct SSEParser {
    private var event: String?
    private var pendingID: String?
    private var lastID: String?
    private var dataLines: [String] = []
    private var hasData = false

    public init() {}

    public mutating func consume(_ line: String) -> SSEFrame? {
        if line.isEmpty { return finishEvent() }
        guard !line.hasPrefix(":") else { return nil }
        let separator = line.firstIndex(of: ":")
        let field = separator.map { String(line[..<$0]) } ?? line
        var value = separator.map { String(line[line.index(after: $0)...]) } ?? ""
        if value.first == " " { value.removeFirst() }
        switch field {
        case "event": event = value
        case "id": if !value.contains("\0") { pendingID = value }
        case "data": dataLines.append(value); hasData = true
        default: break
        }
        return nil
    }

    public mutating func finish() -> SSEFrame? { finishEvent() }

    private mutating func finishEvent() -> SSEFrame? {
        guard hasData || event != nil || pendingID != nil else { return nil }
        if let pendingID { lastID = pendingID }
        let frame = SSEFrame(event: event ?? "message", id: lastID,
                             data: dataLines.joined(separator: "\n"))
        event = nil
        pendingID = nil
        dataLines.removeAll(keepingCapacity: true)
        hasData = false
        return frame
    }
}

public enum DesktopChatError: Error, LocalizedError, Equatable {
    case http(status: Int, code: String?)
    case badResponse
    case missingAdminCredential
    case invalidPairingResponse

    public var errorDescription: String? {
        switch self {
        case let .http(status, code):
            switch (status, code) {
            case (401, _): return "电脑端连接凭证已失效，请重试连接"
            case (409, "no_cat"): return "宿主还没有团子，请先完成初始化"
            case (404, "not_found"): return "这条消息已无法重新回复，请刷新聊天记录"
            case (429, _): return "团子现在有点忙，请稍后重试"
            default: return "本机服务返回错误（HTTP \(status)\(code.map { " · \($0)" } ?? "")）"
            }
        case .badResponse: return "本机服务返回的数据无法读取"
        case .missingAdminCredential: return "找不到本机宿主管理凭证，请从菜单检查宿主状态"
        case .invalidPairingResponse: return "本机配对没有返回有效的设备凭证"
        }
    }
}

public actor DesktopChatClient {
    public static let loopbackURL = URL(string: "http://127.0.0.1:8787")!
    private let dataDirectory: URL
    private let account: String
    private let session: URLSession
    private let credentialStore: any DeviceCredentialStore
    private var activeCredential: String?

    public init(dataDirectory: URL, session: URLSession = .shared,
                credentialStore: any DeviceCredentialStore = KeychainDeviceCredentialStore()) {
        self.dataDirectory = dataDirectory
        self.account = KeychainDeviceCredentialStore.account(for: dataDirectory)
        self.session = session
        self.credentialStore = credentialStore
    }

    @discardableResult
    public func connect() async throws -> (identity: DesktopChatIdentity, repairedCredential: Bool) {
        let saved = try credentialStore.load(account: account)
        if let saved {
            do {
                let identity = try await fetchIdentity(token: saved)
                activeCredential = saved
                return (identity, false)
            } catch DesktopChatError.http(status: 401, code: _) {
                try credentialStore.delete(account: account)
                activeCredential = nil
            }
        }

        let token = try await provisionDevice()
        do {
            let identity = try await fetchIdentity(token: token)
            try credentialStore.save(token, account: account)
            activeCredential = token
            return (identity, saved != nil)
        } catch {
            try? credentialStore.delete(account: account)
            activeCredential = nil
            throw error
        }
    }

    public func history(limit: Int = 100) async throws -> [DesktopServerMessage] {
        let data = try await authorizedData(path: "v1/messages?limit=\(min(100, max(1, limit)))", method: "GET")
        struct Envelope: Decodable { let messages: [DesktopServerMessage] }
        return try Self.decoder.decode(Envelope.self, from: data).messages
    }

    public func send(clientMessageID: String, text: String) async throws -> AsyncThrowingStream<SSEFrame, Error> {
        let body = try JSONSerialization.data(withJSONObject: ["client_message_id": clientMessageID, "text": text])
        return try await eventStream(path: "v1/messages", method: "POST", body: body)
    }

    public func reply(to userMessageID: String, requestID: String) async throws -> AsyncThrowingStream<SSEFrame, Error> {
        let body = try JSONSerialization.data(withJSONObject: ["request_id": requestID])
        return try await eventStream(path: "v1/messages/\(userMessageID)/reply", method: "POST", body: body)
    }

    public func resume(turnID: String, after eventID: String?) async throws -> AsyncThrowingStream<SSEFrame, Error> {
        var request = URLRequest(url: Self.endpoint("v1/turns/\(turnID)/stream"))
        request.httpMethod = "GET"
        if let eventID { request.setValue(eventID, forHTTPHeaderField: "Last-Event-ID") }
        return try await authorizedEventStream(request)
    }

    public func cancel(turnID: String, visibleLength: Int) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["visible_length": max(0, visibleLength)])
        _ = try await authorizedData(path: "v1/turns/\(turnID)/cancel", method: "POST", body: body)
    }

    private func eventStream(path: String, method: String, body: Data) async throws -> AsyncThrowingStream<SSEFrame, Error> {
        var request = URLRequest(url: Self.endpoint(path))
        request.httpMethod = method
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return try await authorizedEventStream(request)
    }

    private func authorizedEventStream(_ request: URLRequest) async throws -> AsyncThrowingStream<SSEFrame, Error> {
        let token = try await currentCredential()
        var request = request
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("1", forHTTPHeaderField: "X-Maomao-Snapshot")
        request.timeoutInterval = 60
        return Self.eventStream(request, session: session)
    }

    private static func eventStream(_ request: URLRequest, session: URLSession) -> AsyncThrowingStream<SSEFrame, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let (bytes, response) = try await session.bytes(for: request)
                    if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                        var body = Data()
                        for try await byte in bytes.prefix(4096) { body.append(byte) }
                        try check(response, body: body)
                    } else {
                        try check(response, body: Data())
                    }
                    var parser = SSEParser()
                    var lineBytes: [UInt8] = []
                    var skipLineFeed = false
                    func dispatchLine() {
                        let line = String(decoding: lineBytes, as: UTF8.self)
                        if let frame = parser.consume(line) { continuation.yield(frame) }
                        lineBytes.removeAll(keepingCapacity: true)
                    }
                    for try await byte in bytes {
                        try Task.checkCancellation()
                        if byte == 0x0D {
                            dispatchLine()
                            skipLineFeed = true
                        } else if byte == 0x0A {
                            if skipLineFeed { skipLineFeed = false }
                            else { dispatchLine() }
                        } else {
                            skipLineFeed = false
                            lineBytes.append(byte)
                        }
                    }
                    if !lineBytes.isEmpty { dispatchLine() }
                    if let frame = parser.finish() { continuation.yield(frame) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func authorizedData(path: String, method: String, body: Data? = nil) async throws -> Data {
        let token = try await currentCredential()
        do {
            return try await requestData(path: path, method: method, body: body, token: token)
        } catch DesktopChatError.http(status: 401, code: _) {
            try credentialStore.delete(account: account)
            activeCredential = nil
            _ = try await connect()
            guard let refreshed = activeCredential else { throw DesktopChatError.badResponse }
            return try await requestData(path: path, method: method, body: body, token: refreshed)
        }
    }

    private func currentCredential() async throws -> String {
        if let activeCredential { return activeCredential }
        let saved = try credentialStore.load(account: account)
        if let saved { activeCredential = saved; return saved }
        _ = try await connect()
        guard let activeCredential else { throw DesktopChatError.badResponse }
        return activeCredential
    }

    private func fetchIdentity(token: String) async throws -> DesktopChatIdentity {
        let data = try await requestData(path: "v1/me", method: "GET", token: token)
        return try Self.decoder.decode(DesktopChatIdentity.self, from: data)
    }

    private func provisionDevice() async throws -> String {
        let adminURL = dataDirectory.appendingPathComponent("host-admin.token")
        guard let adminToken = try? String(contentsOf: adminURL, encoding: .utf8)
                .trimmingCharacters(in: .whitespacesAndNewlines), !adminToken.isEmpty else {
            throw DesktopChatError.missingAdminCredential
        }
        var issue = URLRequest(url: Self.endpoint("host/pairing-codes"))
        issue.httpMethod = "POST"
        issue.setValue("Bearer \(adminToken)", forHTTPHeaderField: "Authorization")
        issue.timeoutInterval = 10
        let issueData = try await rawData(for: issue)
        struct PairingCode: Decodable { let code: String }
        guard let code = try? Self.decoder.decode(PairingCode.self, from: issueData).code else {
            throw DesktopChatError.invalidPairingResponse
        }
        let body = try JSONSerialization.data(withJSONObject: ["code": code, "device_name": "Mac 电脑端"])
        var pair = URLRequest(url: Self.endpoint("pair"))
        pair.httpMethod = "POST"
        pair.httpBody = body
        pair.setValue("application/json", forHTTPHeaderField: "Content-Type")
        pair.timeoutInterval = 10
        let pairData = try await rawData(for: pair)
        struct PairResponse: Decodable { let deviceToken: String }
        guard let token = try? Self.decoder.decode(PairResponse.self, from: pairData).deviceToken,
              token.hasPrefix("mm_dvc_") else { throw DesktopChatError.invalidPairingResponse }
        return token
    }

    private func requestData(path: String, method: String, body: Data? = nil, token: String) async throws -> Data {
        var request = URLRequest(url: Self.endpoint(path))
        request.httpMethod = method
        request.httpBody = body
        request.timeoutInterval = 20
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        return try await rawData(for: request)
    }

    private func rawData(for request: URLRequest) async throws -> Data {
        let (data, response) = try await session.data(for: request)
        try Self.check(response, body: data)
        return data
    }

    private static func endpoint(_ path: String) -> URL {
        URL(string: path, relativeTo: loopbackURL.appending(path: "/"))!.absoluteURL
    }

    private static func check(_ response: URLResponse, body: Data) throws {
        guard let http = response as? HTTPURLResponse else { throw DesktopChatError.badResponse }
        guard (200..<300).contains(http.statusCode) else {
            struct ErrorEnvelope: Decodable { struct Detail: Decodable { let code: String? }; let error: Detail }
            let code = try? decoder.decode(ErrorEnvelope.self, from: body).error.code
            throw DesktopChatError.http(status: http.statusCode, code: code)
        }
    }

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }()
}

public struct DesktopChatEntry: Identifiable, Equatable, Sendable {
    public enum Role: String, Sendable { case user, cat }
    public enum State: Equatable, Sendable { case sent, sending, streaming, done, stopped, failed }
    public let id: String
    public let role: Role
    public var text: String
    public var state: State
    public var serverID: String?
    public var clientMessageID: String?
    public var error: String?
    public var retryable: Bool

    public init(id: String, role: Role, text: String, state: State, serverID: String? = nil,
                clientMessageID: String? = nil, error: String? = nil, retryable: Bool = false) {
        self.id = id
        self.role = role
        self.text = text
        self.state = state
        self.serverID = serverID
        self.clientMessageID = clientMessageID
        self.error = error
        self.retryable = retryable
    }
}

public enum DesktopChatRequest: Equatable, Sendable {
    case send(clientMessageID: String, text: String)
    case reply(userMessageID: String, requestID: String)
    case resume(turnID: String, after: String?)
}

public struct DesktopChatTranscript: Equatable, Sendable {
    public private(set) var messages: [DesktopChatEntry] = []
    public private(set) var clientMessageID: String?
    public private(set) var pendingText: String?
    public private(set) var userMessageID: String?
    public private(set) var turnID: String?
    public private(set) var lastEventID: String?
    public private(set) var replyRequestID: String?

    public init() {}

    public mutating func loadHistory(_ history: [DesktopServerMessage]) {
        messages = history.map { message in
            DesktopChatEntry(id: message.id,
                             role: message.role == "user" ? .user : .cat,
                             text: message.text,
                             state: message.role == "user" ? .sent : .done,
                             serverID: message.id,
                             clientMessageID: message.clientMessageId)
        }
    }

    public mutating func beginSend(clientMessageID: String, text: String) {
        self.clientMessageID = clientMessageID
        self.pendingText = text
        userMessageID = nil
        turnID = nil
        lastEventID = nil
        replyRequestID = nil
        messages.append(DesktopChatEntry(id: "local-\(clientMessageID)", role: .user,
                                         text: text, state: .sending, clientMessageID: clientMessageID))
    }

    public mutating func accept(turnID: String, userMessageID: String, eventID: String?) {
        self.turnID = turnID
        self.userMessageID = userMessageID
        if let eventID { lastEventID = eventID }
        if let index = messages.firstIndex(where: { $0.clientMessageID == clientMessageID }) {
            messages[index].state = .sent
            messages[index].serverID = userMessageID
        }
    }

    public mutating func recordEventID(_ id: String?) { if let id { lastEventID = id } }

    public mutating func applyText(_ text: String, snapshot: Bool) {
        guard let clientMessageID else { return }
        let id = "stream-\(clientMessageID)"
        if let index = messages.firstIndex(where: { $0.id == id }) {
            if snapshot { messages[index].text = text } else { messages[index].text += text }
            messages[index].state = .streaming
        } else {
            messages.append(DesktopChatEntry(id: id, role: .cat, text: text, state: .streaming))
        }
    }

    public mutating func complete(messageID: String?, stopped: Bool = false) {
        if let clientMessageID,
           let index = messages.firstIndex(where: { $0.id == "stream-\(clientMessageID)" }) {
            messages[index].state = stopped ? .stopped : .done
            messages[index].serverID = messageID
        } else if stopped, let clientMessageID {
            messages.append(DesktopChatEntry(id: "stream-\(clientMessageID)", role: .cat,
                                             text: "", state: .stopped, serverID: messageID))
        }
        clientMessageID = nil
        pendingText = nil
        userMessageID = nil
        turnID = nil
        lastEventID = nil
        replyRequestID = nil
    }

    public mutating func fail(message: String, retryable: Bool) {
        if let clientMessageID,
           let index = messages.firstIndex(where: { $0.clientMessageID == clientMessageID }) {
            messages[index].state = .failed
            messages[index].error = message
            messages[index].retryable = retryable
        }
        if let clientMessageID,
           let index = messages.firstIndex(where: { $0.id == "stream-\(clientMessageID)" }) {
            messages[index].state = .failed
            messages[index].error = message
            messages[index].retryable = retryable
        }
    }

    public mutating func retryRequest() -> DesktopChatRequest? {
        guard let clientMessageID, let pendingText else { return nil }
        if let userMessageID {
            let requestID = replyRequestID ?? UUID().uuidString
            replyRequestID = requestID
            return .reply(userMessageID: userMessageID, requestID: requestID)
        }
        return .send(clientMessageID: clientMessageID, text: pendingText)
    }

    public func resumeRequest() -> DesktopChatRequest? {
        guard let turnID else { return nil }
        return .resume(turnID: turnID, after: lastEventID)
    }

    public func cancellationDetails() -> (turnID: String, visibleLength: Int)? {
        guard let turnID, let clientMessageID else { return nil }
        let visibleLength = messages.first(where: { $0.id == "stream-\(clientMessageID)" })?.text.utf16.count ?? 0
        return (turnID, visibleLength)
    }
}
