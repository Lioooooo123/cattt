import Foundation
import XCTest
@testable import Maomao

@MainActor
final class V2MemberResourceTests: XCTestCase {
    func testRequestUsesPersistedKeyContractRevisionAndUnchangedDiaryText() async throws {
        let client = V2Client(baseURL: URL(string: "https://localhost:8789")!, token: "test", session: .shared)
        let action = V2ResourceAction.editDiary(id: "entry", revision: 4, text: "  today\n")
        let id = UUID()
        let request = try client.resourceRequest(action, id: id)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
        XCTAssertEqual(request.url?.path, "/v2/diary/entry")
        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Idempotency-Key"), body["request_id"] as? String)
        XCTAssertEqual(body["request_id"] as? String, id.uuidString.lowercased())
        XCTAssertEqual(body["expected_revision"] as? Int, 4)
        XCTAssertEqual(body["text"] as? String, "  today\n")
        XCTAssertNil(body["cat_allowed"])
    }

    func testMemoryReceiptSurvivesRestartAndComesBeforeProjection() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let memoryID = UUID().uuidString.lowercased()
        let action = V2ResourceAction.reviseMemory(id: memoryID, revision: 1, value: "更正草稿")
        let source = makeStore(directory)
        try await projectMemory(memoryID, in: source, sequence: 1)
        let pending = try XCTUnwrap(source.enqueue(action))
        let key = pending.id.uuidString.lowercased()
        let path = "/v2/memories/\(memoryID)/requests/\(key)"
        func receipt(_ status: String, extra: String = "", url: String? = nil) -> String {
            #"{"action":{"request_id":"\#(key)","memory_id":"\#(memoryID)","receipt_url":"\#(url ?? path)","writer_host_id":"peer","status":"\#(status)"\#(extra)}}"#
        }
        let accepted = ReceiptMock([{ request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Idempotency-Key"), key)
            return (202, receipt("waiting_for_peer"))
        }])
        let client = accepted.client
        let posting = makeStore(directory, send: { try await client.mutateResource($0) })
        await posting.transmit(pending.id)
        XCTAssertEqual(accepted.methods, ["PATCH"])
        XCTAssertEqual(posting.pendingRequests.first?.problem, .waitingForPeer)
        XCTAssertEqual(posting.pendingRequests.first?.memoryReceipt?.receiptURL, path)
        XCTAssertEqual(posting.memories.first?.value, "原值")

        let queries = ReceiptMock([
            { request in
                XCTAssertEqual(request.url?.host, "localhost")
                XCTAssertEqual(request.url?.path, path)
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test")
                return (202, receipt("waiting_for_replication"))
            },
            { _ in throw URLError(.notConnectedToInternet) },
            { _ in (200, receipt("applied", extra: #","resulting_revision":2"#)) },
        ])
        let queryClient = queries.client
        let restarted = makeStore(directory, send: { try await queryClient.mutateResource($0) })
        XCTAssertEqual(restarted.pendingRequests.first?.action, action)
        await restarted.transmit(pending.id)
        XCTAssertEqual(restarted.pendingRequests.first?.memoryReceipt?.status, .waitingForReplication)
        try await projectMemory(nil, removing: memoryID, in: restarted, sequence: 2)
        XCTAssertEqual(restarted.pending(in: .knowledge).first?.problem, .waitingForPeer)
        await restarted.transmit(pending.id)
        XCTAssertEqual(restarted.pendingRequests.first?.memoryReceipt?.receiptURL, path)
        await restarted.transmit(pending.id)
        XCTAssertTrue(restarted.pendingRequests.isEmpty)
        XCTAssertEqual(queries.methods, ["GET", "GET", "GET"])
    }

    func testMemoryReceiptRefusesForeignURLAndKeepsRejectedWithdrawal() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let memoryID = UUID().uuidString.lowercased()
        let store = makeStore(directory)
        try await projectMemory(memoryID, in: store, sequence: 1)
        let pending = try XCTUnwrap(store.enqueue(.forgetMemory(id: memoryID, revision: 1)))
        let key = pending.id.uuidString.lowercased()
        let path = "/v2/memories/\(memoryID)/requests/\(key)"
        let mock = ReceiptMock([
            { _ in (202, #"{"action":{"request_id":"\#(key)","memory_id":"\#(memoryID)","receipt_url":"https://other.example\#(path)","writer_host_id":"peer","status":"queued"}}"#) },
            { _ in (202, #"{"action":{"request_id":"\#(key)","memory_id":"\#(memoryID)","receipt_url":"\#(path)","writer_host_id":"peer","status":"queued"}}"#) },
            { _ in (200, #"{"action":{"request_id":"\#(key)","memory_id":"\#(memoryID)","receipt_url":"\#(path)","writer_host_id":"peer","status":"rejected","error_code":"source_unavailable"}}"#) },
        ])
        let client = mock.client
        let reopened = makeStore(directory, send: { try await client.mutateResource($0) })
        await reopened.transmit(pending.id)
        XCTAssertNil(reopened.pendingRequests.first?.memoryReceipt)
        XCTAssertEqual(reopened.pendingRequests.first?.problem, .uncertain)
        await reopened.transmit(pending.id)
        await reopened.transmit(pending.id)
        XCTAssertEqual(mock.methods, ["DELETE", "DELETE", "GET"])
        XCTAssertEqual(reopened.pendingRequests.first?.problem, .rejected)
        XCTAssertEqual(reopened.pendingRequests.first?.errorCode, "source_unavailable")
        XCTAssertEqual(makeStore(directory).pendingRequests.first?.action, pending.action)
    }

    func testUnknownResultReplaysOriginalDraftAndPermissionTogetherAfterRestart() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let original = makeStore(directory, send: { _ in throw URLError(.networkConnectionLost) })
        let action = V2ResourceAction.addDiary(text: "  first\n", recordedAt: 1, day: "1970-01-01",
                                                timeZone: "UTC", catAllowed: true)
        let initial = try XCTUnwrap(original.enqueue(action))
        await original.transmit(initial.id)
        XCTAssertEqual(original.pendingRequests.first?.problem, .uncertain)
        let recovered = makeStore(directory, send: { request in
            XCTAssertEqual(request.id, initial.id)
            XCTAssertEqual(request.action, action)
            return .diary(.value(Self.diary()))
        })
        XCTAssertEqual(recovered.pendingRequests.first?.action, action)
        await recovered.transmit(initial.id)
        let reopened = makeStore(directory)
        XCTAssertTrue(reopened.pendingRequests.isEmpty)
        XCTAssertTrue(reopened.diary.isEmpty)
        try await project(Self.diary(), in: reopened, sequence: 1)
        XCTAssertEqual(makeStore(directory).diary.first?.text, "  first\n")
        XCTAssertEqual(reopened.diary.first?.catAllowed, true)
        XCTAssertTrue(makeStore(directory, member: "other").diary.isEmpty)
    }

    func testConflictKeepsOriginalDraftAndRequiresNewKeyAndFreshRevision() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = makeStore(directory, send: { _ in throw V2.APIError(code: "revision_conflict") })
        try await project(Self.diary(), in: store, sequence: 1)
        let old = try XCTUnwrap(store.enqueue(.editDiary(id: "entry", revision: 1, text: "draft")))
        await store.transmit(old.id)
        XCTAssertEqual(store.pendingRequests.first?.problem, .conflict)
        XCTAssertNil(store.enqueue(.editDiary(id: "entry", revision: 1, text: "draft"), replacing: old.id))
        try await project(Self.diary(revision: 2), in: store, sequence: 2)
        let corrected = try XCTUnwrap(store.enqueue(.editDiary(id: "entry", revision: 2, text: "draft"), replacing: old.id))
        XCTAssertNotEqual(corrected.id, old.id)
        XCTAssertEqual(store.pendingRequests, [corrected])
    }

    func testPartnerCannotEnqueueOrInheritPermissionAndProjectionCanChangeAtSameRevision() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = makeStore(directory)
        try await project(Self.diary(owner: "other"), in: store, sequence: 1)
        XCTAssertNil(store.enqueue(.editDiary(id: "entry", revision: 1, text: "mine")))
        XCTAssertNil(store.enqueue(.allowDiary(id: "entry", revision: 1, allowed: false)))
        XCTAssertNil(store.enqueue(.withdrawDiary(id: "entry", revision: 1)))
        try await project(Self.diary(owner: "other", catReadable: false), in: store, sequence: 2)
        XCTAssertEqual(store.diary.first?.catAllowed, true)
        XCTAssertEqual(store.diary.first?.catReadable, false)
        try await project(nil, in: store, sequence: 3)
        XCTAssertTrue(store.diary.isEmpty)
    }

    func testSourceWithdrawalKeepsDiaryTextAndAuthorSwitchWhileInvalidatingCatRead() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = makeStore(directory)
        let source = V2.ResourceSource(memberID: "me", conversationID: "c", messageID: "m", revision: 1)
        try await project(Self.diary(source: source), in: store, sequence: 1)
        try await project(Self.diary(catReadable: false), in: store, sequence: 2)
        let entry = try XCTUnwrap(store.diary.first)
        XCTAssertEqual(entry.text, "  first\n")
        XCTAssertTrue(entry.catAllowed)
        XCTAssertFalse(entry.catReadable)
        XCTAssertNil(entry.source)
    }

    func testDiaryTombstoneBlocksStaleEditButRetainsPersistentWithdrawal() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = makeStore(directory)
        try await project(Self.diary(), in: store, sequence: 1)
        _ = try XCTUnwrap(store.enqueue(.editDiary(id: "entry", revision: 1, text: "draft")))
        try await project(nil, in: store, sequence: 2)
        XCTAssertTrue(store.diary.isEmpty)
        XCTAssertEqual(store.pending(in: .diary).first?.problem, .conflict)
        XCTAssertEqual(makeStore(directory).pending(in: .diary).first?.problem, .conflict)
        XCTAssertNil(store.enqueue(.allowDiary(id: "entry", revision: 1, allowed: true)))

        let other = makeStore(directory, member: "other")
        try await project(Self.diary(owner: "other"), in: other, sequence: 1)
        let request = try XCTUnwrap(other.enqueue(.withdrawDiary(id: "entry", revision: 1)))
        try await project(nil, in: other, sequence: 2)
        XCTAssertEqual(makeStore(directory, member: "other").pending(in: .diary), [request])
    }

    private func project(_ diary: V2.SharedDiary?, in store: V2ResourceStore, sequence: Int) async throws {
        var row: [String: Any] = ["kind": "diary", "id": "entry", "sequence": sequence,
                                  "op": diary == nil ? "delete" : "upsert"]
        if let diary { row["value"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(diary)) }
        try await project(row, in: store, sequence: sequence)
    }

    private func projectMemory(_ id: String?, removing removed: String? = nil, in store: V2ResourceStore,
                               sequence: Int) async throws {
        var row: [String: Any] = ["kind": "memory", "id": id ?? removed!, "sequence": sequence,
                                  "op": id == nil ? "delete" : "upsert"]
        if let id {
            let memory = V2.Memory(id: id, revision: 1, updatedAt: 1, subjectMemberID: "me",
                                   predicate: "偏好", value: "原值", source: nil, canEdit: true)
            row["value"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(memory))
        }
        try await project(row, in: store, sequence: sequence)
    }

    private func project(_ row: [String: Any], in store: V2ResourceStore, sequence: Int) async throws {
        let data = try JSONSerialization.data(withJSONObject: [
            "generation": "one", "reset": false, "changes": [row], "next": String(sequence), "has_more": false,
        ])
        let changes = store.changes
        changes.bind(scope: changes.scope) { { _ in try JSONDecoder().decode(V2.ChangesPage.self, from: data) } }
        changes.setForeground(true)
        await changes.refresh()?.value
    }

    private func temporaryDirectory() -> URL {
        FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    }

    private func makeStore(_ directory: URL, member: String = "me",
                           send: @escaping (V2ResourcePending) async throws -> V2ResourceChange = { _ in
                               throw URLError(.notConnectedToInternet)
                           }) -> V2ResourceStore {
        let identity = V2.PairResult(deviceId: "phone", deviceToken: "unused",
            member: .init(id: member, householdId: "home", displayName: member, homeHostId: "mac"),
            household: .init(id: "home", name: "家"))
        let changes = V2ChangesStore(directory: directory.appending(path: "projections"))
        changes.bind(scope: V2SyncScope(identity: identity), open: nil)
        return V2ResourceStore(identity: identity, changes: changes, directory: directory,
                               selectClient: { throw URLError(.notConnectedToInternet) }, send: send)
    }

    private static func diary(owner: String = "me", revision: Int = 1, catReadable: Bool = true,
                              source: V2.ResourceSource? = nil) -> V2.SharedDiary {
        .init(id: "entry", revision: revision, updatedAt: 2, ownerMemberID: owner,
              text: "  first\n", recordedAt: 1, localDay: "1970-01-01", timeZone: "UTC",
              catAllowed: true, catReadable: catReadable, source: source, canEdit: true)
    }
}
