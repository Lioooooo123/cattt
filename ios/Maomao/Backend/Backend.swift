import Foundation

/// 聊天走哪儿：本地模拟，还是本机跑的后端（server/）。
///
/// DEBUG 面板里切换，存在 UserDefaults；模拟器验收时也可以用启动参数：
/// `xcrun simctl launch booted com.maomao.app -backendMode local -backendToken mm_dev_…`
struct BackendConfig: Equatable {
    enum Mode: String, CaseIterable {
        case mock
        case local
        case paired
    }

    var mode: Mode
    var baseURL: URL
    /// 配对设备凭证（`mm_dvc_…`），或 DEBUG 下 `pnpm create-dev-user` 生成的开发者 token。
    var token: String

    var accountID: String? = nil
    var pairedHost: PairedHost? = nil
    var isRemote: Bool { mode != .mock }
    var storageIdentity: String {
        if let pairedHost, mode == .paired { return pairedHost.storageIdentity }
        return isRemote ? baseURL.absoluteString + "\n" + token : "local-only"
    }
    static let localURL = URL(string: "http://localhost:8787")!

    static func load() -> BackendConfig {
        if let paired = PairVault.load() {
            return BackendConfig(mode: .paired, baseURL: paired.url(host: paired.hosts[0]), token: paired.deviceToken, accountID: paired.accountID, pairedHost: paired)
        }
        #if DEBUG
        let defaults = UserDefaults.standard
        let mode = Mode(rawValue: defaults.string(forKey: "backendMode") ?? "") ?? .mock
        if mode == .local {
            return BackendConfig(mode: mode, baseURL: defaults.string(forKey: "backendURL").flatMap(URL.init(string:)) ?? localURL,
                                 token: defaults.string(forKey: "backendToken") ?? "")
        }
        #endif
        return BackendConfig(mode: .mock, baseURL: localURL, token: "")
    }

    func save() {
        #if DEBUG
        let defaults = UserDefaults.standard
        defaults.set(mode.rawValue, forKey: "backendMode")
        if CredentialPersistencePolicy.maySaveDeveloperToken(mode: mode.rawValue, accountID: accountID) {
            defaults.set(baseURL.absoluteString, forKey: "backendURL")
            defaults.set(token, forKey: "backendToken")
        }
        #endif
    }

}

// MARK: - 接口数据

/// 服务端字段是 snake_case，解码时统一转。
struct APIMessage: Decodable {
    let clientMessageId: String?
    let diaryEntryId: String?
    let seq: Int
    let id: String
    let role: String
    let text: String
    let status: String
    /// 猫的消息：这一轮记下了用户明确要记的
    let remembered: Bool
    /// 猫的消息：被标了不要再提
    let boundary: Bool
    let contextAllowed: Bool?
    let ticketId: String?
}

struct APITurn: Decodable {
    let id: String
    let status: String
    let catMessageId: String?
    let extracted: Bool
    let remembered: Bool
}

/// SSE 事件的 data。见 docs/方案/后端-开发者版-方案-2026-09-11.md 第 7 节。
enum TurnEventData {
    struct Accepted: Decodable { let turnId: String; let userMessageId: String }
    struct Delta: Decodable { let text: String }
    struct Done: Decodable { let messageId: String?; let status: String }
    struct Failure: Decodable { let code: String; let retryable: Bool }
}

enum APIError: LocalizedError {
    case http(status: Int, code: String?)
    case badResponse

    var errorDescription: String? {
        switch self {
        case let .http(status, code):
            switch (status, code) {
            case (401, "pairing_code_invalid"): return "配对码不对或已过期，请在电脑上重新生成"
            case (401, _): return "登录已失效，请重新登录"
            case (409, "no_cat"): return "这个账号还没有猫"
            case (404, "diary_unavailable"): return "这条日记已停止共享，请重新选择"
            default: return "HTTP \(status)" + (code.map { " \($0)" } ?? "")
            }
        case .badResponse: return "服务端返回的东西看不懂"
        }
    }
}

// MARK: - 客户端

struct APIClient {
    let config: BackendConfig

    var session: URLSession = APIClient.defaultSession
    init(config: BackendConfig, session: URLSession? = nil) {
        self.config = config
        if config.mode == .paired {
            self.session = PairTransport.session(fingerprint: config.pairedHost?.fingerprint ?? "")
        } else { self.session = session ?? Self.defaultSession }
    }
    private static let defaultSession: URLSession = {
        let configuration = URLSessionConfiguration.default
        // 流式回复期间服务端每 15 秒发一次心跳，60 秒没动静才算断
        configuration.timeoutIntervalForRequest = 60
        return URLSession(configuration: configuration)
    }()

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }()

    static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        try decoder.decode(type, from: data)
    }

    func request(_ method: String, _ path: String, body: [String: Any]? = nil) -> URLRequest {
        var request = URLRequest(url: config.baseURL.appending(path: path))
        request.httpMethod = method
        request.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        return request
    }

    func json<T: Decodable>(_ type: T.Type, _ request: URLRequest) async throws -> T {
        let (data, response) = try await data(for: request)
        try Self.check(response, body: data)
        return try Self.decode(type, from: data)
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        do { return try await session.data(for: request) }
        catch {
            if config.mode == .paired { NotificationCenter.default.post(name: .pairedConnectionFailed, object: config.storageIdentity) }
            throw error
        }
    }

    private static func check(_ response: URLResponse, body: Data) throws {
        guard let http = response as? HTTPURLResponse else { throw APIError.badResponse }
        guard (200..<300).contains(http.statusCode) else {
            struct Envelope: Decodable { struct Inner: Decodable { let code: String }; let error: Inner }
            let code = try? decoder.decode(Envelope.self, from: body).error.code
            throw APIError.http(status: http.statusCode, code: code)
        }
    }

    /// 本机后端按用户时区格式化时间；失败由调用方静默忽略。
    func reportTimeZone() async throws {
        struct OK: Decodable {}
        _ = try await json(OK.self, request("PUT", "v1/me/time-zone", body: ["time_zone": TimeZone.current.identifier]))
    }

    // MARK: 聊天

    /// 发一条消息。响应就是这一轮回复的 SSE 流。
    func send(clientMessageID: String, text: String, diaryEntryID: String? = nil) -> AsyncThrowingStream<SSEEvent, Error> {
        var body = ["client_message_id": clientMessageID, "text": text]
        if let diaryEntryID { body["diary_entry_id"] = diaryEntryID }
        return sse(request("POST", "v1/messages", body: body))
    }

    /// 对已有的用户消息重新回复（超时后「再试一次」）。
    func reply(to userMessageID: String, requestID: String) -> AsyncThrowingStream<SSEEvent, Error> {
        sse(request("POST", "v1/messages/\(userMessageID)/reply", body: ["request_id": requestID]))
    }

    /// 断线续传：从上次收到的事件之后接着读。
    func resume(turnID: String, after lastEventID: String?) -> AsyncThrowingStream<SSEEvent, Error> {
        var request = request("GET", "v1/turns/\(turnID)/stream")
        if let lastEventID { request.setValue(lastEventID, forHTTPHeaderField: "Last-Event-ID") }
        return sse(request)
    }

    /// 停止。带上屏幕上已经显示的长度（UTF-16），服务端只存这么多，存下的和用户看到的一致。
    func cancel(turnID: String, visibleLength: Int? = nil) async throws {
        struct OK: Decodable {}
        let body: [String: Any]? = visibleLength.map { ["visible_length": $0] }
        _ = try await json(OK.self, request("POST", "v1/turns/\(turnID)/cancel", body: body))
    }

    func turn(_ turnID: String) async throws -> APITurn {
        try await json(APITurn.self, request("GET", "v1/turns/\(turnID)"))
    }

    func messages(limit: Int = 50, before: Int? = nil, after: Int? = nil) async throws -> [APIMessage] {
        struct Page: Decodable { let messages: [APIMessage] }
        var request = request("GET", "v1/messages")
        request.url?.append(queryItems: [URLQueryItem(name: "limit", value: String(limit))])
        if let after { request.url?.append(queryItems: [URLQueryItem(name: "after", value: String(after))]) }
        if let before { request.url?.append(queryItems: [URLQueryItem(name: "before", value: String(before))]) }
        return try await json(Page.self, request).messages
    }

    func markBoundary(messageID: String) async throws {
        struct OK: Decodable {}
        _ = try await json(OK.self, request("POST", "v1/messages/\(messageID)/boundary"))
    }

    /// 「我的」页的两个数：长期记忆、不要再提的。
    func counts() async throws -> (memories: Int, boundaries: Int) {
        struct Item: Decodable { let id: String }
        struct Memories: Decodable { let memories: [Item] }
        struct Boundaries: Decodable { let boundaries: [Item] }
        async let memories = json(Memories.self, request("GET", "v1/memories"))
        async let boundaries = json(Boundaries.self, request("GET", "v1/boundaries"))
        return try await (memories.memories.count, boundaries.boundaries.count)
    }

    /// 创建流程走完：把名字、外观、气质和四条特征写到服务端那只猫上。
    func updateCat(name: String, appearance: String, temperament: String, traits: [String: Int]) async throws {
        struct Cat: Decodable { let id: String }
        _ = try await json(Cat.self, request("PUT", "v1/cat", body: [
            "name": name, "appearance": appearance, "temperament": temperament, "traits": traits,
        ]))
    }

    /// 团子的日记：把当天事实交给服务端写。写不出来就抛错，App 用本地模板兜底。
    func catDiary(facts: [String: Any]) async throws -> String {
        struct Diary: Decodable { let text: String }
        return try await json(Diary.self, request("POST", "v1/cat/diary", body: facts)).text
    }

    // MARK: SSE

    /// 逐字节切行。`URLSession.AsyncBytes.lines` 会吞掉空行，而 SSE 靠空行分隔事件，所以自己切。
    func sse(_ request: URLRequest) -> AsyncThrowingStream<SSEEvent, Error> {
        var request = request
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("1", forHTTPHeaderField: "X-Maomao-Snapshot")
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let (bytes, response) = try await session.bytes(for: request)
                    if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                        var body = Data()
                        for try await byte in bytes.prefix(4096) { body.append(byte) }
                        try Self.check(response, body: body)
                    }
                    var parser = SSEParser()
                    var line: [UInt8] = []
                    for try await byte in bytes {
                        if byte == UInt8(ascii: "\n") {
                            if let event = parser.feed(line: line) { continuation.yield(event) }
                            line.removeAll(keepingCapacity: true)
                        } else {
                            line.append(byte)
                        }
                    }
                    continuation.finish()
                } catch {
                    if config.mode == .paired { NotificationCenter.default.post(name: .pairedConnectionFailed, object: config.storageIdentity) }
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

struct SSEEvent {
    let id: String?
    let event: String
    let data: Data
}

/// 按行喂进来，遇到空行吐出一个完整事件。`:` 开头的是服务端的保活注释，忽略。
struct SSEParser {
    private var id: String?
    private var event = ""
    private var data: [String] = []

    mutating func feed(line raw: [UInt8]) -> SSEEvent? {
        var bytes = raw
        if bytes.last == UInt8(ascii: "\r") { bytes.removeLast() }
        guard !bytes.isEmpty else {
            defer { id = nil; event = ""; data = [] }
            guard !event.isEmpty || !data.isEmpty else { return nil }
            return SSEEvent(id: id, event: event.isEmpty ? "message" : event, data: Data(data.joined(separator: "\n").utf8))
        }
        let line = String(decoding: bytes, as: UTF8.self)
        if line.hasPrefix(":") { return nil }
        let field: Substring
        var value: Substring
        if let colon = line.firstIndex(of: ":") {
            field = line[..<colon]
            value = line[line.index(after: colon)...]
            if value.hasPrefix(" ") { value = value.dropFirst() }
        } else {
            field = Substring(line)
            value = ""
        }
        switch field {
        case "id": id = String(value)
        case "event": event = String(value)
        case "data": data.append(String(value))
        default: break
        }
        return nil
    }
}

// MARK: - 记忆管理
struct APIMemory: Decodable, Identifiable {
    let id: String
    let subject: String
    let predicate: String
    let value: String
    let status: String
    let sourceMessageId: String
    let sourceText: String?
    let sourceAllowed: Bool
    let lastConfirmedAt: String
    let revision: Int
    let edited: Bool
}
struct APIBoundary: Decodable, Identifiable {
    let id: String
    let description: String?
    let sourceMessageId: String
    let sourceText: String
}
struct APIMemorySettings: Decodable {
    let learn: Bool
    let use: Bool
    let revision: Int
}
struct APIMemoryImpact: Decodable {
    struct Source: Decodable, Identifiable { let id: String; let text: String; let role: String; let allowed: Bool; let legacy: Bool? }
    struct Memory: Decodable, Identifiable { let id: String; let value: String }
    let revision: Int
    let watermark: Int
    let messages: [Source]
    let memories: [Memory]
}
extension APIClient {
    func memoryList() async throws -> [APIMemory] {
        struct Page: Decodable { let memories: [APIMemory] }
        return try await json(Page.self, request("GET", "v1/memories")).memories
    }
    func boundaryList() async throws -> [APIBoundary] {
        struct Page: Decodable { let boundaries: [APIBoundary] }
        return try await json(Page.self, request("GET", "v1/boundaries")).boundaries
    }
    func memorySettings() async throws -> APIMemorySettings {
        try await json(APIMemorySettings.self, request("GET", "v1/memory-settings"))
    }
    func changeMemorySettings(learn: Bool? = nil, use: Bool? = nil, revision: Int) async throws -> APIMemorySettings {
        var body: [String: Any] = ["revision": revision]
        if let learn { body["learn"] = learn }
        if let use { body["use"] = use }
        return try await json(APIMemorySettings.self, request("PATCH", "v1/memory-settings", body: body))
    }
    func editMemory(_ memory: APIMemory, value: String) async throws {
        struct OK: Decodable {}
        _ = try await json(OK.self, request("PATCH", "v1/memories/\(memory.id)", body: ["value": value, "revision": memory.revision]))
    }
    func memoryImpact(_ id: String) async throws -> APIMemoryImpact {
        try await json(APIMemoryImpact.self, request("GET", "v1/memories/\(id)/impact"))
    }
    func sourceImpact(_ id: String) async throws -> APIMemoryImpact {
        try await json(APIMemoryImpact.self, request("GET", "v1/messages/\(id)/usage"))
    }
    func deleteMemory(_ id: String, withdrawSources: Bool, revision: Int, watermark: Int) async throws {
        struct OK: Decodable {}
        var req = request("DELETE", "v1/memories/\(id)")
        req.url?.append(queryItems: [URLQueryItem(name: "withdraw_sources", value: String(withdrawSources)), URLQueryItem(name: "revision", value: String(revision)), URLQueryItem(name: "watermark", value: String(watermark))])
        _ = try await json(OK.self, req)
    }
    func withdrawSource(_ id: String, revision: Int, watermark: Int) async throws {
        struct OK: Decodable {}
        _ = try await json(OK.self, request("POST", "v1/messages/\(id)/withdraw", body: ["revision": revision, "watermark": watermark]))
    }
    func revokeBoundary(_ id: String) async throws {
        struct OK: Decodable {}
        _ = try await json(OK.self, request("DELETE", "v1/boundaries/\(id)"))
    }
}
