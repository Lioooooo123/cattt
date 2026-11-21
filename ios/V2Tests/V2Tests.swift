import XCTest
@testable import Maomao

final class V2Tests: XCTestCase {
    private let message = #"{"id":"m","conversation_id":"c","cursor":"opaque+/?","author":{"kind":"cat"},"text":"你好","modality":"text","status":"complete","client_message_id":null,"reply_to_message_id":null,"turn_id":null,"created_at":1234567890123}"#
    func testCatMessageAndNullTurn() throws {
        let sent = try V2.decoder.decode(V2.Sent.self, from: Data("{\"message\":\(message),\"turn\":null}".utf8))
        XCTAssertNil(sent.turn)
        XCTAssertEqual(sent.message.author.kind, .cat)
        XCTAssertNil(sent.message.author.memberId)
        XCTAssertEqual(sent.message.createdAt, 1234567890123)
        XCTAssertEqual(sent.message.cursor, "opaque+/?")
    }
    func testNullLastMessage() throws {
        let json = #"{"id":"c","kind":"group","owner_member_id":null,"participant_member_ids":["a","b"],"publisher_host_id":"h","created_at":1,"last_message":null}"#
        let result = try V2.decoder.decode(V2.Conversation.self, from: Data(json.utf8))
        XCTAssertNil(result.lastMessage)
        XCTAssertEqual(result.title, "我们仨")
    }
    func testEmptyPage() throws {
        let page = try V2.decoder.decode(V2.MessagesPage.self, from: Data(#"{"messages":[],"has_more_before":false,"has_more_after":false}"#.utf8))
        XCTAssertTrue(page.messages.isEmpty)
        XCTAssertFalse(page.hasMoreAfter)
        XCTAssertFalse(page.hasMoreBefore)
    }
    func testInvalidMessageRejected() {
        XCTAssertThrowsError(try V2.decoder.decode(V2.Message.self, from: Data("{}".utf8)))
    }
    func testErrorCodes() throws {
        let codes: [(String, V2.APIError)] = [("unauthorized", .unauthorized), ("not_found", .notFound), ("idempotency_conflict", .idempotencyConflict), ("not_publisher", .notPublisher), ("invalid_request", .invalidRequest), ("pairing_code_invalid", .pairingCodeInvalid), ("future", .other("future"))]
        for (code, expected) in codes {
            let envelope = try V2.decoder.decode(V2.ErrorEnvelope.self, from: Data("{\"error\":{\"code\":\"\(code)\",\"message\":\"ignored\"}}".utf8))
            XCTAssertEqual(V2.APIError(code: envelope.error.code), expected)
        }
    }
    func testRequestBuilding() throws {
        let client = V2Client(baseURL: URL(string: "https://localhost:8789")!, token: "test", session: .shared)
        let request = try client.request("POST", "conversations/c/messages", query: [URLQueryItem(name: "before", value: "opaque+/=?")], body: ["client_message_id": "key", "text": "你好"])
        XCTAssertEqual(request.url?.path, "/v2/conversations/c/messages")
        XCTAssertEqual(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "opaque+/=?")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test")
        XCTAssertEqual(request.httpMethod, "POST")
        let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: String]
        XCTAssertEqual(body, ["client_message_id": "key", "text": "你好"])
        for status in [200, 201] { XCTAssertNoThrow(try client.validate(HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, data: Data())) }
        XCTAssertThrowsError(try client.validate(HTTPURLResponse(url: request.url!, statusCode: 409, httpVersion: nil, headerFields: nil)!, data: Data(#"{"error":{"code":"idempotency_conflict"}}"#.utf8))) { XCTAssertEqual($0 as? V2.APIError, .idempotencyConflict) }
    }
    func testSSEMultilineAndHeartbeat() {
        var parser = V2SSE()
        XCTAssertNil(parser.line(": heartbeat"))
        XCTAssertNil(parser.line(""))
        XCTAssertNil(parser.line("id: opaque.123"))
        XCTAssertNil(parser.line("event: snapshot"))
        XCTAssertNil(parser.line("data: first"))
        XCTAssertNil(parser.line("data: second"))
        XCTAssertEqual(parser.line(""), V2SSE.Event(id: "opaque.123", name: "snapshot", data: "first\nsecond"))
        XCTAssertNil(parser.line(": heartbeat"))
        XCTAssertNil(parser.line(""))
    }
    func testReducerSnapshotReplacesAndTerminals() throws {
        for terminal in ["superseded", "done", "error"] {
            var reducer = V2TurnStream()
            try reducer.apply(.init(id: "1", name: "accepted", data: #"{"turn_id":"t","trigger_message_id":"m"}"#))
            XCTAssertEqual(reducer.turnID, "t")
            XCTAssertEqual(reducer.triggerMessageID, "m")
            try reducer.apply(.init(id: "2", name: "delta", data: #"{"text":"old"}"#))
            try reducer.apply(.init(id: "3", name: "snapshot", data: #"{"text":"new"}"#))
            try reducer.apply(.init(id: "4", name: "delta", data: #"{"text":"!"}"#))
            XCTAssertEqual(reducer.text, "new!")
            try reducer.apply(.init(id: "5", name: terminal, data: "{}"))
            try reducer.apply(.init(id: "6", name: "delta", data: #"{"text":"late"}"#))
            XCTAssertEqual(reducer.text, "new!")
            XCTAssertEqual(reducer.lastEventID, "5")
            XCTAssertEqual(reducer.terminal, terminal)
        }
    }
    func testMalformedStreamPayload() {
        var reducer = V2TurnStream()
        XCTAssertThrowsError(try reducer.apply(.init(id: "1", name: "delta", data: "bad")))
        XCTAssertNil(reducer.lastEventID)
    }
    func testPairLinks() {
        let pin = String(repeating: "a", count: 64)
        for version in [1, 2] {
            let url = URL(string: "maomao://pair?v=\(version)&h=localhost,127.0.0.1&p=8789&c=ABCD-EFGH&fp=\(pin)")!
            XCTAssertEqual(PairInvitation.parse(url, versions: [1, 2])?.version, version)
            XCTAssertEqual(PairInvitation.parse(url, versions: [1, 2])?.code, "ABCDEFGH")
        }
        XCTAssertNil(PairInvitation.parse(URL(string: "maomao://pair?v=3")!))
        XCTAssertNil(PairInvitation.parse(URL(string: "maomao://pair?v=2&v=2")!))
    }
    @MainActor func testOutboxRetriesKeepKeyAcrossRestart() throws {
        let suite = "V2Tests." + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let outbox = V2Outbox(identity: "a", defaults: defaults)
        XCTAssertTrue(outbox.entries.isEmpty)
        let first = outbox.enqueue(conversation: "group", text: "你好")
        let restarted = V2Outbox(identity: "a", defaults: defaults)
        XCTAssertEqual(restarted.entries, [first])
        XCTAssertEqual(restarted.entries.first?.id, first.id)
        XCTAssertTrue(V2Outbox(identity: "b", defaults: defaults).entries.isEmpty)
        restarted.acknowledge(first.id)
        XCTAssertTrue(V2Outbox(identity: "a", defaults: defaults).entries.isEmpty)
    }
}
