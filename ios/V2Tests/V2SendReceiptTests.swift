import Foundation
import XCTest
@testable import Maomao

final class V2SendReceiptTests: XCTestCase {
    private static let receipt = "/v2/conversations/c/message-requests/r"
    private static func pending(_ key: String, _ reason: String = "peer_pending", path: String = receipt) -> String {
        #"{"status":"pending","request_id":"r","client_message_id":"\#(key)","reason":"\#(reason)","receipt_url":"\#(path)"}"#
    }
    private static func message(_ key: String, author: String = "a", id: String = "m") -> String {
        #"{"id":"\#(id)","conversation_id":"c","cursor":"\#(id)","author":{"kind":"member","member_id":"\#(author)"},"text":"hello","modality":"text","status":"complete","client_message_id":"\#(key)","created_at":1}"#
    }
    private static func sent(_ key: String) -> String {
        #"{"message":\#(message(key)),"turn":null}"#
    }
    private static func accepted(_ key: String) -> String {
        #"{"status":"accepted","request_id":"r","client_message_id":"\#(key)","publisher_host_id":"peer","message":\#(message(key)),"turn":null}"#
    }
    private static func page(_ messages: [String] = []) -> String {
        #"{"messages":[\#(messages.joined(separator: ","))],"has_more_before":false,"has_more_after":false}"#
    }
    private static func key(_ request: URLRequest) throws -> String {
        let data: Data
        if let body = request.httpBody { data = body }
        else {
            let stream = try XCTUnwrap(request.httpBodyStream)
            stream.open()
            defer { stream.close() }
            var bytes = Data()
            var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                guard count > 0 else { break }
                bytes.append(contentsOf: buffer.prefix(count))
            }
            data = bytes
        }
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
        XCTAssertEqual(body["text"], "hello")
        return try XCTUnwrap(body["client_message_id"])
    }

    @MainActor private func makeStore(_ client: V2Client, _ directory: URL, member: String = "a",
                                     device: String = "d", household: String = "h", online: Bool = true) -> V2ChatStore {
        let identity = V2.PairResult(deviceId: device, deviceToken: "test",
            member: .init(id: member, householdId: household, displayName: member, homeHostId: "home"),
            household: .init(id: household, name: "家"))
        let connection = V2Connection(hosts: ["localhost"], port: 8789, fingerprint: "test", identity: identity)
        return V2ChatStore(connection: connection, outbox: V2Outbox(identity: identity, directory: directory),
                           selectClient: {
                               guard online else { throw PairingError.unavailable }
                               return client
                           })
    }

    @MainActor func testDraftsStayWithTheirConversationAndClearOnlyAfterQueueing() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let mock = ReceiptMock([])
        let store = makeStore(mock.client, directory, online: false)
        store.drafts["c"] = "hello"
        store.drafts["group"] = "留给我们仨的话"

        await store.sendDraft(in: "c")

        XCTAssertEqual(store.drafts["c"], "")
        XCTAssertEqual(store.drafts["group"], "留给我们仨的话")
        XCTAssertEqual(store.pending.map(\.text), ["hello"])
        XCTAssertEqual(store.pending.first?.conversationID, "c")
        XCTAssertTrue(mock.methods.isEmpty)
        store.deactivate()
        XCTAssertTrue(store.drafts.isEmpty, "Member-scoped drafts must not survive disconnect")
    }

    @MainActor func testOverLimitDraftIsNotClearedOrQueued() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let mock = ReceiptMock([])
        let store = makeStore(mock.client, directory, online: false)
        // Emoji occupy two UTF-16 units, matching the API's existing length limit.
        let text = String(repeating: "🐈", count: 2001)
        store.drafts["c"] = text
        await store.sendDraft(in: "c")
        XCTAssertEqual(store.drafts["c"], text)
        XCTAssertTrue(store.pending.isEmpty)
        XCTAssertTrue(mock.methods.isEmpty)
    }

    @MainActor func testFailedLocalSaveRestoresDraft() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try Data("not a directory".utf8).write(to: directory)
        let mock = ReceiptMock([])
        let store = makeStore(mock.client, directory, online: false)
        store.drafts["c"] = "hello"
        await store.sendDraft(in: "c")
        XCTAssertEqual(store.drafts["c"], "hello")
        XCTAssertTrue(store.pending.isEmpty)
        XCTAssertNotNil(store.error)
    }

    @MainActor func testOfflineBeforePostingLeavesAnUnsentEntryAcrossRestart() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let offline = ReceiptMock([])
        let store = makeStore(offline.client, directory, online: false)
        await store.send("hello", conversation: "c")
        let entry = try XCTUnwrap(store.pending.first)
        XCTAssertEqual(entry.submissionStarted, false)
        XCTAssertNotNil(store.failures[entry.id])
        XCTAssertTrue(offline.methods.isEmpty)

        let online = ReceiptMock([{ request in
            XCTAssertEqual(try Self.key(request), entry.id)
            return (202, Self.pending(entry.id))
        }])
        let restarted = makeStore(online.client, directory)
        let unsent = try XCTUnwrap(restarted.pending.first)
        XCTAssertEqual(unsent.submissionStarted, false)
        await restarted.transmit(unsent)
        XCTAssertEqual(restarted.pending.first?.submissionStarted, true)
        XCTAssertEqual(online.methods, ["POST"])
    }

    @MainActor func testDirect200And201ReplaceOptimisticRowAndSurviveUntilHistoryArrives() async throws {
        for status in [200, 201] {
            let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: directory) }
            let mock = ReceiptMock([{ request in (status, Self.sent(try Self.key(request))) }])
            let store = makeStore(mock.client, directory)
            await store.send("hello", conversation: "c")
            let entry = try XCTUnwrap(store.pending.first)
            XCTAssertEqual(entry.accepted?.message.id, "m")
            XCTAssertEqual(store.visibleOutbox("c").map(\.displayID), ["m"])
            let history = ReceiptMock([{ _ in (200, Self.page([Self.message(entry.id), Self.message(entry.id)])) }])
            let restarted = makeStore(history.client, directory)
            XCTAssertEqual(restarted.visibleOutbox("c").map(\.displayID), ["m"])
            await restarted.syncConversation("c")
            XCTAssertEqual(restarted.messages["c"]?.map(\.id), ["m"])
            XCTAssertTrue(restarted.pending.isEmpty)
            XCTAssertEqual(history.methods, ["GET"])
            XCTAssertEqual(mock.methods, ["POST"])
        }
    }

    @MainActor func testReceiptLossReplaysSameKeyOnceThenRestartPollsAndMergesRemoteHistory() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let lost = ReceiptMock([{ _ in throw URLError(.networkConnectionLost) }])
        let first = makeStore(lost.client, directory)
        await first.send("hello", conversation: "c")
        let key = try XCTUnwrap(first.pending.first?.id)
        XCTAssertNotNil(first.failures[key])
        XCTAssertEqual(first.pending.first?.submissionStarted, true)

        let replay = ReceiptMock([{ request in
            XCTAssertEqual(try Self.key(request), key)
            return (202, Self.pending(key, "publication_pending"))
        }])
        let restarted = makeStore(replay.client, directory)
        await restarted.transmit(try XCTUnwrap(restarted.pending.first))
        XCTAssertEqual(restarted.pending.first?.receipt?.reason, .publicationPending)
        XCTAssertEqual(restarted.pending.first?.receipt?.url, Self.receipt)

        let cat = #"{"id":"cat","conversation_id":"c","cursor":"cat","author":{"kind":"cat"},"text":"meow","modality":"text","status":"complete","reply_to_message_id":"m","created_at":2}"#
        let polling = ReceiptMock([
            { request in XCTAssertEqual(request.url?.path, Self.receipt); return (202, Self.pending(key)) },
            { request in XCTAssertEqual(request.url?.path, Self.receipt); return (202, Self.pending(key, "replication_pending")) },
            { request in XCTAssertEqual(request.url?.path, Self.receipt); return (200, Self.accepted(key)) },
            { _ in (200, Self.page([Self.message(key), cat, cat])) }
        ])
        let resumed = makeStore(polling.client, directory)
        for reason in [V2.PendingSend.Reason.peerPending, .replicationPending] {
            await resumed.transmit(try XCTUnwrap(resumed.pending.first))
            XCTAssertEqual(resumed.pending.first?.receipt?.reason, reason)
        }
        await resumed.transmit(try XCTUnwrap(resumed.pending.first))
        XCTAssertEqual(resumed.visibleOutbox("c").map(\.displayID), ["m"])
        XCTAssertTrue(resumed.activeTurns.isEmpty)
        await resumed.syncConversation("c")
        XCTAssertEqual(resumed.messages["c"]?.map(\.id), ["m", "cat"])
        XCTAssertTrue(resumed.pending.isEmpty)
        XCTAssertEqual(polling.methods, ["GET", "GET", "GET", "GET"])
    }

    @MainActor func testOtherMemberWithSameKeyCannotHideOrAcknowledgePendingSend() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let mock = ReceiptMock([{ request in (202, Self.pending(try Self.key(request))) }])
        let owner = makeStore(mock.client, directory)
        await owner.send("hello", conversation: "c")
        let queued = try XCTUnwrap(owner.pending.first)
        XCTAssertTrue(makeStore(mock.client, directory, member: "b").pending.isEmpty)
        XCTAssertTrue(makeStore(mock.client, directory, device: "other").pending.isEmpty)
        XCTAssertTrue(makeStore(mock.client, directory, household: "other").pending.isEmpty)
        XCTAssertTrue(owner.visibleOutbox("other").isEmpty)

        let history = ReceiptMock([
            { _ in (200, Self.page([Self.message(queued.id, author: "b", id: "other")])) },
            { _ in (202, Self.pending(queued.id)) }
        ])
        let resumed = makeStore(history.client, directory)
        await resumed.syncConversation("c")
        XCTAssertEqual(resumed.visibleOutbox("c").map(\.id), [queued.id])
        XCTAssertEqual(resumed.messages["c"]?.map(\.id), ["other"])
        XCTAssertEqual(history.methods, ["GET", "GET"])
        resumed.deactivate()
        await resumed.transmit(queued)
        XCTAssertEqual(history.methods, ["GET", "GET"])
    }

    @MainActor func testRejectedReceiptOnlyResendsWithFreshKeyOnExplicitAction() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let mock = ReceiptMock([{ request in (202, Self.pending(try Self.key(request))) }])
        let store = makeStore(mock.client, directory)
        await store.send("hello", conversation: "c")
        let key = try XCTUnwrap(store.pending.first?.id)

        let receipt = ReceiptMock([{ _ in
            (200, #"{"status":"rejected","request_id":"r","client_message_id":"\#(key)","error":{"code":"group_send_rejected"}}"#)
        }, { request in
            let fresh = try Self.key(request)
            XCTAssertNotEqual(fresh, key)
            return (201, Self.sent(fresh))
        }])
        let resumed = makeStore(receipt.client, directory)
        await resumed.transmit(try XCTUnwrap(resumed.pending.first))
        let rejected = try XCTUnwrap(resumed.pending.first)
        XCTAssertEqual(rejected.rejection, "group_send_rejected")
        await resumed.transmit(rejected)
        XCTAssertEqual(receipt.methods, ["GET"])
        await resumed.retry(rejected)
        XCTAssertEqual(receipt.methods, ["GET", "POST"])
        XCTAssertEqual(resumed.pending.count, 1)
        XCTAssertNotEqual(resumed.pending.first?.id, key)
    }

    @MainActor func testNonRelativeAndMismatchedReceiptPathsAreNeverRequested() async throws {
        for path in ["https://elsewhere.test" + Self.receipt, "//elsewhere.test" + Self.receipt,
                     "https://localhost:8789" + Self.receipt, Self.receipt + "?x=y", Self.receipt + "/../r",
                     "/v2/conversations/other/message-requests/r", "/v2/conversations/c/message-requests/wrong"] {
            let mock = ReceiptMock([{ _ in (202, Self.pending("key", path: path)) }])
            do {
                _ = try await mock.client.send(conversation: "c", key: "key", text: "hello")
                XCTFail("Accepted invalid receipt URL: \(path)")
            } catch {
                XCTAssertEqual(error as? V2.APIError, .invalidRequest)
            }
            XCTAssertEqual(mock.methods, ["POST"])
        }
    }
}

final class ReceiptMock: @unchecked Sendable {
    typealias Step = (URLRequest) throws -> (Int, String)
    private var steps: [Step]
    private var seen: [String] = []
    private let lock = NSLock()

    init(_ steps: [Step]) { self.steps = steps }

    var methods: [String] { lock.withLock { seen } }

    var client: V2Client {
        ReceiptProtocol.mock = self
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ReceiptProtocol.self]
        return V2Client(baseURL: URL(string: "https://localhost:8789")!, token: "test", session: URLSession(configuration: config))
    }

    func reply(_ request: URLRequest) throws -> (Int, String) {
        let step = try lock.withLock {
            seen.append(request.httpMethod ?? "")
            guard !steps.isEmpty else {
                XCTFail("Unexpected request: \(request)")
                throw URLError(.resourceUnavailable)
            }
            return steps.removeFirst()
        }
        return try step(request)
    }
}

private final class ReceiptProtocol: URLProtocol {
    nonisolated(unsafe) static var mock: ReceiptMock!
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, body) = try Self.mock.reply(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }
    override func stopLoading() {}
}
