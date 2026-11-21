import Foundation
import XCTest
@testable import HostCore

private final class DesktopChatProtocol: URLProtocol {
    static var responder: (URLRequest) throws -> (Int, String, String) = { _ in (404, "", "application/json") }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            let (status, body, contentType) = try Self.responder(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                            headerFields: ["Content-Type": contentType])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

private final class MemoryDeviceCredentials: DeviceCredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String] = [:]

    func load(account: String) throws -> String? {
        lock.lock(); defer { lock.unlock() }
        return values[account]
    }

    func save(_ credential: String, account: String) throws {
        lock.lock(); defer { lock.unlock() }
        values[account] = credential
    }

    func delete(account: String) throws {
        lock.lock(); defer { lock.unlock() }
        values.removeValue(forKey: account)
    }
}

final class DesktopChatTests: XCTestCase {
    private func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DesktopChatProtocol.self]
        return URLSession(configuration: configuration)
    }

    private func temporaryDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private static func requestBody(_ request: URLRequest) throws -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { throw URLError(.badServerResponse) }
        stream.open()
        defer { stream.close() }
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 4096)
        defer { buffer.deallocate() }
        var data = Data()
        while true {
            let count = stream.read(buffer, maxLength: 4096)
            if count < 0 { throw stream.streamError ?? URLError(.badServerResponse) }
            if count == 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }

    func testPairingStoresCredentialAndHistoryUsesLocalAPI() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        try Data("admin-only-test".utf8).write(to: directory.appendingPathComponent("host-admin.token"))
        let credentials = MemoryDeviceCredentials()
        DesktopChatProtocol.responder = { request in
            switch request.url!.path {
            case "/host/pairing-codes":
                XCTAssertEqual(request.httpMethod, "POST")
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer admin-only-test")
                return (200, #"{"code":"ABCD-EFGH"}"#, "application/json")
            case "/pair":
                let value = try XCTUnwrap(JSONSerialization.jsonObject(with: Self.requestBody(request)) as? [String: String])
                XCTAssertEqual(value["code"], "ABCD-EFGH")
                XCTAssertEqual(value["device_name"], "Mac 电脑端")
                return (200, #"{"device_token":"mm_dvc_desktop-test","account_id":"owner","cat":{"name":"团子"}}"#, "application/json")
            case "/v1/me":
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer mm_dvc_desktop-test")
                return (200, #"{"account_id":"owner","cat":{"name":"团子"}}"#, "application/json")
            case "/v1/messages":
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer mm_dvc_desktop-test")
                XCTAssertEqual(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "100")
                return (200, #"{"messages":[{"id":"m1","seq":1,"role":"user","text":"你好","status":"done","client_message_id":"c1"}]}"#, "application/json")
            default:
                return (404, #"{"error":{"code":"not_found"}}"#, "application/json")
            }
        }
        let client = DesktopChatClient(dataDirectory: directory, session: makeSession(), credentialStore: credentials)
        let connection = try await client.connect()
        XCTAssertEqual(connection.identity.cat.name, "团子")
        XCTAssertFalse(connection.repairedCredential)
        let account = KeychainDeviceCredentialStore.account(for: directory)
        XCTAssertEqual(try credentials.load(account: account), "mm_dvc_desktop-test")
        let history = try await client.history()
        XCTAssertEqual(history.map(\.text), ["你好"])
    }

    func testSavedCredentialIsReusedAndRevokedCredentialIsRepairedOnce() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        try Data("admin-only-test".utf8).write(to: directory.appendingPathComponent("host-admin.token"))
        let credentials = MemoryDeviceCredentials()
        let account = KeychainDeviceCredentialStore.account(for: directory)
        try credentials.save("mm_dvc_cached", account: account)
        var pairingRequests = 0
        DesktopChatProtocol.responder = { request in
            switch request.url!.path {
            case "/v1/me":
                if request.value(forHTTPHeaderField: "Authorization") == "Bearer mm_dvc_cached" {
                    return (401, #"{"error":{"code":"unauthorized"}}"#, "application/json")
                }
                return (200, #"{"account_id":"owner","cat":{"name":"团子"}}"#, "application/json")
            case "/host/pairing-codes":
                pairingRequests += 1
                return (200, #"{"code":"WXYZ-1234"}"#, "application/json")
            case "/pair":
                return (200, #"{"device_token":"mm_dvc_repaired","account_id":"owner","cat":{"name":"团子"}}"#, "application/json")
            default:
                return (404, "", "application/json")
            }
        }
        let client = DesktopChatClient(dataDirectory: directory, session: makeSession(), credentialStore: credentials)
        let connection = try await client.connect()
        XCTAssertTrue(connection.repairedCredential)
        XCTAssertEqual(pairingRequests, 1)
        XCTAssertEqual(try credentials.load(account: account), "mm_dvc_repaired")
    }

    func testValidSavedCredentialIsReusedWithoutAnotherPairingCode() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let credentials = MemoryDeviceCredentials()
        let account = KeychainDeviceCredentialStore.account(for: directory)
        try credentials.save("mm_dvc_existing", account: account)
        XCTAssertNotEqual(account, KeychainDeviceCredentialStore.account(for: directory.appendingPathComponent("other-data")))
        var requests: [String] = []
        DesktopChatProtocol.responder = { request in
            requests.append(request.url!.path)
            guard request.url!.path == "/v1/me" else { return (500, "", "application/json") }
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer mm_dvc_existing")
            return (200, #"{"account_id":"owner","cat":{"name":"团子"}}"#, "application/json")
        }
        let client = DesktopChatClient(dataDirectory: directory, session: makeSession(), credentialStore: credentials)
        let connection = try await client.connect()
        XCTAssertFalse(connection.repairedCredential)
        XCTAssertEqual(requests, ["/v1/me"])
    }

    func testPostSSEReplyAndResumeContracts() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let credentials = MemoryDeviceCredentials()
        try credentials.save("mm_dvc_stream", account: KeychainDeviceCredentialStore.account(for: directory))
        let turnID = "33333333-3333-4333-8333-333333333333"
        let userMessageID = "11111111-1111-4111-8111-111111111111"
        let replyRequestID = "22222222-2222-4222-8222-222222222222"
        DesktopChatProtocol.responder = { request in
            let body = "id: pg-1\nevent: accepted\ndata: {\"turn_id\":\"\(turnID)\",\"user_message_id\":\"\(userMessageID)\"}\n\nid: pg-2\nevent: delta\ndata: {\"text\":\"你好\"}\n\nid: pg-3\nevent: done\ndata: {\"message_id\":\"44444444-4444-4444-8444-444444444444\",\"status\":\"done\"}\n\n"
            switch request.url!.path {
            case "/v1/messages":
                XCTAssertEqual(request.httpMethod, "POST")
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer mm_dvc_stream")
                let value = try XCTUnwrap(JSONSerialization.jsonObject(with: try Self.requestBody(request)) as? [String: String])
                XCTAssertEqual(value["client_message_id"], "client-1")
                XCTAssertEqual(value["text"], "你好")
            case "/v1/messages/\(userMessageID)/reply":
                XCTAssertEqual(request.httpMethod, "POST")
                let value = try XCTUnwrap(JSONSerialization.jsonObject(with: try Self.requestBody(request)) as? [String: String])
                XCTAssertEqual(value["request_id"], replyRequestID)
            case "/v1/turns/\(turnID)/stream":
                XCTAssertEqual(request.value(forHTTPHeaderField: "Last-Event-ID"), "pg-2")
                XCTAssertEqual(request.value(forHTTPHeaderField: "X-Maomao-Snapshot"), "1")
            case "/v1/turns/\(turnID)/cancel":
                XCTAssertEqual(request.httpMethod, "POST")
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer mm_dvc_stream")
                let value = try XCTUnwrap(JSONSerialization.jsonObject(with: try Self.requestBody(request)) as? [String: Int])
                XCTAssertEqual(value["visible_length"], 4)
                return (200, #"{"ok":true}"#, "application/json")
            default:
                XCTFail("unexpected path: \(request.url!.path)")
            }
            return (200, body, "text/event-stream")
        }
        let client = DesktopChatClient(dataDirectory: directory, session: makeSession(), credentialStore: credentials)

        let send = try await client.send(clientMessageID: "client-1", text: "你好")
        var sentEvents: [String] = []
        for try await frame in send { sentEvents.append(frame.event) }
        XCTAssertEqual(sentEvents, ["accepted", "delta", "done"])

        let reply = try await client.reply(to: userMessageID, requestID: replyRequestID)
        for try await _ in reply {}
        let resumed = try await client.resume(turnID: turnID, after: "pg-2")
        for try await _ in resumed {}
        try await client.cancel(turnID: turnID, visibleLength: 4)
    }

    func testSSEParserAndEmptyHistoryCases() async throws {
        var parser = SSEParser()
        XCTAssertNil(parser.consume(": keepalive"))
        XCTAssertNil(parser.consume("id: pg-1"))
        XCTAssertNil(parser.consume("event: delta"))
        XCTAssertNil(parser.consume("data: first"))
        XCTAssertNil(parser.consume("data: second"))
        let frame = try XCTUnwrap(parser.consume(""))
        XCTAssertEqual(frame.event, "delta")
        XCTAssertEqual(frame.id, "pg-1")
        XCTAssertEqual(frame.data, "first\nsecond")
        XCTAssertNil(parser.finish())
        var empty = SSEParser()
        XCTAssertNil(empty.finish())

        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let credentials = MemoryDeviceCredentials()
        try credentials.save("mm_dvc_empty", account: KeychainDeviceCredentialStore.account(for: directory))
        var statusCode = 200
        DesktopChatProtocol.responder = { request in
            XCTAssertEqual(request.url!.path, "/v1/messages")
            if statusCode == 200 { return (200, #"{"messages":[]}"#, "application/json") }
            return (503, #"{"error":{"code":"unavailable"}}"#, "application/json")
        }
        let client = DesktopChatClient(dataDirectory: directory, session: makeSession(), credentialStore: credentials)
        let emptyHistory = try await client.history()
        XCTAssertTrue(emptyHistory.isEmpty)
        statusCode = 503
        do {
            _ = try await client.history()
            XCTFail("expected server error")
        } catch let error as DesktopChatError {
            XCTAssertEqual(error, .http(status: 503, code: "unavailable"))
        }
    }

    func testTranscriptHistoryStreamingErrorAndStableRetryRoutes() throws {
        var transcript = DesktopChatTranscript()
        transcript.loadHistory([])
        XCTAssertTrue(transcript.messages.isEmpty)
        transcript.beginSend(clientMessageID: "stable-id", text: "再聊一次")
        transcript.accept(turnID: "turn-id", userMessageID: "user-id", eventID: "pg-1")
        transcript.applyText("团", snapshot: false)
        transcript.applyText("团子", snapshot: true)
        XCTAssertEqual(transcript.messages.last?.text, "团子")
        transcript.fail(message: "连接中断", retryable: true)
        guard case let .reply(userMessageID, requestID) = try XCTUnwrap(transcript.retryRequest()) else {
            return XCTFail("accepted messages must retry through the reply endpoint")
        }
        XCTAssertEqual(userMessageID, "user-id")
        guard case let .reply(_, repeatedRequestID) = try XCTUnwrap(transcript.retryRequest()) else {
            return XCTFail("retry request id must stay stable")
        }
        XCTAssertEqual(requestID, repeatedRequestID)

        var stopped = DesktopChatTranscript()
        stopped.beginSend(clientMessageID: "stop-id", text: "停一下")
        stopped.accept(turnID: "stop-turn", userMessageID: "stop-user", eventID: "pg-1")
        stopped.applyText("猫咪🐱", snapshot: false)
        let cancellation = try XCTUnwrap(stopped.cancellationDetails())
        XCTAssertEqual(cancellation.turnID, "stop-turn")
        XCTAssertEqual(cancellation.visibleLength, 4)
        stopped.complete(messageID: "stop-cat", stopped: true)
        XCTAssertEqual(stopped.messages.last?.state, .stopped)

        var unsent = DesktopChatTranscript()
        unsent.beginSend(clientMessageID: "same-client-id", text: "尚未送达")
        unsent.fail(message: "网络不可用", retryable: true)
        XCTAssertEqual(unsent.retryRequest(), .send(clientMessageID: "same-client-id", text: "尚未送达"))
        unsent.complete(messageID: nil)
        XCTAssertNil(unsent.retryRequest())
    }

    private struct HistoryEnvelope: Decodable { let messages: [DesktopServerMessage] }
}
