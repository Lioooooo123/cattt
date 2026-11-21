import Foundation

struct V2Client {
    let baseURL: URL
    let token: String
    let session: URLSession

    func request(_ method: String, _ path: String, query: [URLQueryItem] = [], body: [String: Any]? = nil) throws -> URLRequest {
        var parts = URLComponents(url: baseURL.appending(path: "v2/" + path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { parts.queryItems = query }
        var request = URLRequest(url: parts.url!)
        request.httpMethod = method
        if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }
    func validate(_ response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200...299).contains(http.statusCode) else {
            let envelope = try? V2.decoder.decode(V2.ErrorEnvelope.self, from: data)
            throw V2.APIError(code: envelope?.error.code ?? "http_\(http.statusCode)")
        }
    }
    func json<T: Decodable>(_ type: T.Type, _ request: URLRequest) async throws -> T {
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
        return try V2.decoder.decode(type, from: data)
    }
    func pair(code: String, deviceName: String) async throws -> V2.PairResult {
        try await json(V2.PairResult.self, request("POST", "pair", body: ["code": code, "device_name": deviceName]))
    }
    func me() async throws -> V2.Me { try await json(V2.Me.self, request("GET", "me")) }
    func members() async throws -> [V2.Member] {
        struct Result: Decodable { let members: [V2.Member] }
        return try await json(Result.self, request("GET", "members")).members
    }
    func conversations() async throws -> [V2.Conversation] {
        struct Result: Decodable { let conversations: [V2.Conversation] }
        return try await json(Result.self, request("GET", "conversations")).conversations
    }
    func conversation(_ id: String) async throws -> V2.Conversation {
        try await json(V2.Conversation.self, request("GET", "conversations/\(id)"))
    }
    func messages(_ id: String, before: String? = nil, after: String? = nil, limit: Int = 50) async throws -> V2.MessagesPage {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let before { query.append(URLQueryItem(name: "before", value: before)) }
        if let after { query.append(URLQueryItem(name: "after", value: after)) }
        return try await json(V2.MessagesPage.self, request("GET", "conversations/\(id)/messages", query: query))
    }
    func send(conversation: String, key: String, text: String) async throws -> V2.Sent {
        try await json(V2.Sent.self, request("POST", "conversations/\(conversation)/messages", body: ["client_message_id": key, "text": text]))
    }
    func turn(conversation: String, id: String) async throws -> V2.Turn {
        try await json(V2.Turn.self, request("GET", "conversations/\(conversation)/turns/\(id)"))
    }
    func cancel(conversation: String, turn: String, visibleLength: Int? = nil) async throws -> V2.Turn {
        var body: [String: Any] = [:]
        if let visibleLength { body["visible_length"] = visibleLength }
        return try await json(V2.Turn.self, request("POST", "conversations/\(conversation)/turns/\(turn)/cancel", body: body))
    }
    func reply(conversation: String, message: String, requestID: String) async throws -> V2.Turn {
        try await json(V2.Turn.self, request("POST", "conversations/\(conversation)/messages/\(message)/reply", body: ["request_id": requestID]))
    }
    func unpair() async throws {
        let (data, response) = try await session.data(for: request("POST", "device/unpair", body: [:]))
        try validate(response, data: data)
    }
    func stream(conversation: String, turn: String, lastEventID: String?, receive: @escaping (V2SSE.Event) async throws -> Void) async throws {
        var req = try request("GET", "conversations/\(conversation)/turns/\(turn)/stream")
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        if let lastEventID { req.setValue(lastEventID, forHTTPHeaderField: "Last-Event-ID") }
        let (bytes, response) = try await session.bytes(for: req)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            var data = Data()
            for try await byte in bytes { data.append(byte) }
            try validate(response, data: data)
            return
        }
        var parser = V2SSE()
        for try await line in bytes.lines {
            try Task.checkCancellation()
            if let event = parser.line(line) { try await receive(event) }
        }
    }
}
