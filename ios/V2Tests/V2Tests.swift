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
    func testByteLinesPreserveEmptyFrameBoundariesAndUTF8() throws {
        for newline in ["\n", "\r\n", "\r"] {
            let wire = [": heartbeat", "", "id: host.1", "event: delta", #"data: {"text":"团子🐱"}"#, "", "event: done", #"data: {"message_id":null,"status":"stopped"}"#, "", ""].joined(separator: newline)
            var lines = V2SSE.Lines()
            var parser = V2SSE()
            var reducer = V2TurnStream()
            var events: [V2SSE.Event] = []
            for byte in wire.utf8 {
                if let line = lines.append(byte), let event = parser.line(line) {
                    events.append(event)
                    try reducer.apply(event)
                }
            }
            XCTAssertEqual(events.map(\.name), ["delta", "done"])
            XCTAssertEqual(reducer.text, "团子🐱")
            XCTAssertEqual(reducer.terminal, "done")
        }
    }
    @MainActor func testTriggerTurnIDIsNotPersistedCatReply() throws {
        let member = V2.Member(id: "a", householdId: "h", displayName: "Han", homeHostId: "host")
        let identity = V2.PairResult(deviceId: UUID().uuidString, deviceToken: "test", member: member, household: .init(id: "h", name: "家"))
        let store = V2ChatStore(connection: .init(hosts: ["localhost"], port: 8789, fingerprint: String(repeating: "a", count: 64), identity: identity))
        let turn = V2.Turn(id: "t", conversationId: "c", status: .generating, triggerMessageId: "trigger", replyMessageId: nil, errorCode: nil, streamUrl: "/v2/conversations/c/turns/t/stream")
        let active = V2ChatStore.ActiveTurn(turn: turn)
        let trigger = V2.Message(id: "trigger", conversationId: "c", cursor: "1", author: .init(kind: .member, memberId: "partner"), text: "你好", modality: "text", status: "complete", clientMessageId: "key", replyToMessageId: nil, turnId: "t", createdAt: 1)
        store.messages["c"] = [trigger]
        XCTAssertFalse(store.hasPersistedReply(active, conversation: "c"))
        XCTAssertTrue(store.canReply(trigger))
        store.activeTurns["c"] = active
        XCTAssertFalse(store.canReply(trigger))
        let cat = V2.Message(id: "cat", conversationId: "c", cursor: "2", author: .init(kind: .cat, memberId: nil), text: "你好呀", modality: "text", status: "stopped", clientMessageId: nil, replyToMessageId: "trigger", turnId: "t", createdAt: 2)
        store.messages["c"] = [trigger, cat]
        XCTAssertTrue(store.hasPersistedReply(active, conversation: "c"))
        XCTAssertFalse(store.hasPersistedReply(active, conversation: "other"))
    }
    func testPublicIdentityUsesSnakeCaseOnly() throws {
        let member = #"{"id":"a","household_id":"h","display_name":"Han","home_host_id":"host"}"#
        let pair = #"{"device_id":"d","device_token":"test","member":\#(member),"household":{"id":"h","name":"家"}}"#
        let result = try V2.decoder.decode(V2.PairResult.self, from: Data(pair.utf8))
        XCTAssertEqual(result.member.displayName, "Han")
        XCTAssertEqual(result.member.householdId, "h")
        XCTAssertEqual(result.member.homeHostId, "host")
        XCTAssertEqual(result.deviceId, "d")
        XCTAssertThrowsError(try V2.decoder.decode(V2.Member.self, from: Data(#"{"id":"a","householdId":"h","displayName":"Han","homeHostId":"host"}"#.utf8)))
        XCTAssertThrowsError(try V2.decoder.decode(V2.PairResult.self, from: Data(pair.replacingOccurrences(of: "device_id", with: "deviceId").utf8)))
    }
    func testKeychainStorageSchemaStaysIndependentOfWireDTOs() throws {
        let stored = #"{"hosts":["localhost"],"port":8789,"fingerprint":"pin","identity":{"deviceId":"d","deviceToken":"test","member":{"id":"a","householdId":"h","displayName":"Han","homeHostId":"host"},"household":{"id":"h","name":"家"}}}"#
        let connection = try JSONDecoder().decode(V2Connection.self, from: Data(stored.utf8))
        XCTAssertEqual(connection.identity.member.displayName, "Han")
        XCTAssertEqual(connection.identity.deviceId, "d")
        let encoded = try JSONEncoder().encode(connection)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: encoded) as? NSDictionary, try JSONSerialization.jsonObject(with: Data(stored.utf8)) as? NSDictionary)
        XCTAssertEqual(try JSONDecoder().decode(V2Connection.self, from: encoded).identity.member, connection.identity.member)
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
            let payloads = ["superseded": #"{"turn_id":"t","by_turn_id":"next"}"#, "done": #"{"message_id":"reply","status":"stopped"}"#, "error": #"{"code":"model_unavailable","retryable":true}"#]
            try reducer.apply(.init(id: "5", name: terminal, data: payloads[terminal]!))
            try reducer.apply(.init(id: "6", name: "delta", data: #"{"text":"late"}"#))
            XCTAssertEqual(reducer.text, "new!")
            XCTAssertEqual(reducer.lastEventID, "5")
            XCTAssertEqual(reducer.terminal, terminal)
            switch terminal {
            case "superseded": XCTAssertEqual(reducer.byTurnID, "next"); XCTAssertEqual(reducer.status, .superseded)
            case "done": XCTAssertEqual(reducer.replyMessageID, "reply"); XCTAssertEqual(reducer.status, .stopped)
            default: XCTAssertEqual(reducer.errorCode, "model_unavailable"); XCTAssertEqual(reducer.retryable, true)
            }
        }
    }
    func testMalformedStreamPayload() {
        var reducer = V2TurnStream()
        XCTAssertThrowsError(try reducer.apply(.init(id: "1", name: "delta", data: "bad")))
        XCTAssertNil(reducer.lastEventID)
        XCTAssertThrowsError(try reducer.apply(.init(id: "2", name: "done", data: "{}")))
        XCTAssertNil(reducer.terminal)
    }
    func testTurnAndSendResponse() throws {
        for status in ["queued", "generating", "completed", "stopped", "superseded", "failed"] {
            let turn = #"{"id":"t","conversation_id":"c","status":"\#(status)","trigger_message_id":"m","reply_message_id":"r","error_code":null,"stream_url":"/v2/conversations/c/turns/t/stream"}"#
            let result = try V2.decoder.decode(V2.Sent.self, from: Data("{\"message\":\(message),\"turn\":\(turn)}".utf8))
            XCTAssertEqual(result.turn?.status.rawValue, status)
            XCTAssertEqual(result.turn?.triggerMessageId, "m")
            XCTAssertEqual(result.turn?.replyMessageId, "r")
            XCTAssertNil(result.turn?.errorCode)
            XCTAssertEqual(result.turn?.streamUrl, "/v2/conversations/c/turns/t/stream")
        }
    }
    func testReconnectSnapshotAndResumeHeader() throws {
        var reducer = V2TurnStream()
        try reducer.apply(.init(id: "host.1", name: "accepted", data: #"{"turn_id":"t","trigger_message_id":"m"}"#))
        try reducer.apply(.init(id: "host.2", name: "delta", data: #"{"text":"旧文本"}"#))
        let client = V2Client(baseURL: URL(string: "https://localhost:8789")!, token: "test", session: .shared)
        let request = try client.streamRequest(path: "/v2/conversations/c/turns/t/stream", lastEventID: reducer.lastEventID)
        XCTAssertEqual(request.url?.absoluteString, "https://localhost:8789/v2/conversations/c/turns/t/stream")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Last-Event-ID"), "host.2")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "text/event-stream")
        var reconnected = V2SSE()
        for line in ["id: host.3", "event: snapshot", #"data: {"text":"恢复后的全文🐱"}"#, ""] {
            if let event = reconnected.line(line) { try reducer.apply(event) }
        }
        XCTAssertEqual(reducer.text, "恢复后的全文🐱")
        XCTAssertEqual(reducer.lastEventID, "host.3")
        try reducer.apply(.init(id: "host.4", name: "done", data: #"{"message_id":null,"status":"stopped"}"#))
        XCTAssertNil(reducer.replyMessageID)
        XCTAssertEqual(reducer.status, .stopped)
        XCTAssertNoThrow(try reducer.apply(.init(id: "host.5", name: "delta", data: "malformed after terminal")))
        XCTAssertThrowsError(try client.streamRequest(path: "https://other.test/v2/conversations/c", lastEventID: nil))
        XCTAssertThrowsError(try client.streamRequest(path: "//other.test/v2/conversations/c", lastEventID: nil))
    }
    func testCancelAndReplyRequests() throws {
        let client = V2Client(baseURL: URL(string: "https://localhost:8789")!, token: "test", session: .shared)
        let text = "好🐱👨‍👩‍👧‍👦"
        XCTAssertEqual(text.utf16.count, 14)
        let cancel = try client.cancelRequest(conversation: "c", turn: "t", visibleLength: text.utf16.count)
        XCTAssertEqual(cancel.url?.path, "/v2/conversations/c/turns/t/cancel")
        XCTAssertEqual(cancel.httpMethod, "POST")
        XCTAssertEqual(try JSONSerialization.jsonObject(with: cancel.httpBody!) as? [String: Int], ["visible_length": 14])
        let empty = try client.cancelRequest(conversation: "c", turn: "t", visibleLength: nil)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: empty.httpBody!) as? [String: Int], [:])
        let zero = try client.cancelRequest(conversation: "c", turn: "t", visibleLength: 0)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: zero.httpBody!) as? [String: Int], ["visible_length": 0])
        let reply = try client.replyRequest(conversation: "c", message: "m", requestID: "uuid")
        XCTAssertEqual(reply.url?.path, "/v2/conversations/c/messages/m/reply")
        XCTAssertEqual(reply.httpMethod, "POST")
        XCTAssertEqual(try JSONSerialization.jsonObject(with: reply.httpBody!) as? [String: String], ["request_id": "uuid"])
    }
    @MainActor func testReplyKeyPersistsUntilAcknowledged() {
        let suite = "V2ReplyTests." + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let requests = V2ReplyRequests(deviceID: "a", defaults: defaults)
        let first = requests.requestID(message: "m")
        XCTAssertNotNil(UUID(uuidString: first))
        XCTAssertEqual(V2ReplyRequests(deviceID: "a", defaults: defaults).requestID(message: "m"), first)
        XCTAssertEqual(requests.requestID(message: "m"), first)
        XCTAssertNotEqual(requests.requestID(message: "other"), first)
        XCTAssertNotEqual(V2ReplyRequests(deviceID: "b", defaults: defaults).requestID(message: "m"), first)
        requests.acknowledge(message: "m")
        XCTAssertNotEqual(requests.requestID(message: "m"), first)
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
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let member = V2.Member(id: "a", householdId: "h", displayName: "Han", homeHostId: "host")
        let identity = V2.PairResult(deviceId: "device", deviceToken: "test", member: member, household: .init(id: "h", name: "家"))
        let legacy = V2Outbox.Entry(id: "old-key", conversationID: "group", text: "旧消息")
        defaults.set(try V2.encoder.encode([legacy]), forKey: "v2.outbox.device")
        let outbox = V2Outbox(identity: identity, directory: directory, defaults: defaults)
        XCTAssertEqual(outbox.entries, [legacy])
        XCTAssertNil(defaults.data(forKey: "v2.outbox.device"))
        let first = try outbox.enqueue(conversation: "group", text: "你好")
        let restarted = V2Outbox(identity: identity, directory: directory, defaults: defaults)
        XCTAssertEqual(restarted.entries, [legacy, first])
        try restarted.acknowledge(first.id)
        XCTAssertEqual(V2Outbox(identity: identity, directory: directory, defaults: defaults).entries, [legacy])
    }
}
