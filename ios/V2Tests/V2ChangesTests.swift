import XCTest
@testable import Maomao

@MainActor
final class V2ChangesTests: XCTestCase {
    private let scope = V2SyncScope(householdID: "house", homeHostID: "home", memberID: "a")

    func testWorldBackfillKeepsExistingOfflineProjectionsUntilFirstFetchSucceeds() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let old = V2ChangesStore(directory: directory)
        bind(old, Feed([.success(try page("old", entries: [diary(1)]))]))
        old.setForeground(true)
        await old.refresh()?.value
        let file = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).first)
        var previous = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        previous.removeValue(forKey: "includesWorld")
        try JSONSerialization.data(withJSONObject: previous).write(to: file)

        let reopened = V2ChangesStore(directory: directory)
        let feed = Feed([.failure(URLError(.notConnectedToInternet)), .success(try page("replayed", entries: [diary(1)]))])
        bind(reopened, feed)
        XCTAssertEqual(reopened.snapshot.diaries.count, 1)
        reopened.setForeground(true)
        await reopened.refresh()?.value
        XCTAssertEqual(reopened.snapshot.diaries.count, 1)
        await reopened.refresh()?.value
        XCTAssertEqual(feed.cursors, [nil, nil])
        XCTAssertEqual(reopened.snapshot.cursor, "replayed")
        XCTAssertEqual(reopened.snapshot.diaries.count, 1)
    }

    func testSameRevisionReplacesProjectionAndTombstoneRejectsReplayAfterRestart() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = V2ChangesStore(directory: directory)
        let first = try page("one", more: true, entries: [diary(1), memory(2), file(3), description(4)])
        let second = try page("two", more: true, entries: [diary(5, readable: false), file(6, available: false)])
        let third = try page("three", entries: [tombstone("memory", "m", 7), tombstone("file_description", "desc", 8)])
        let feed = Feed([.success(first), .success(second), .success(third)])
        bind(store, feed)
        store.setForeground(true)
        await store.refresh()?.value

        XCTAssertEqual(feed.cursors, [nil, "one", "two"])
        XCTAssertEqual(store.snapshot.diaries.first?.revision, 3)
        XCTAssertEqual(store.snapshot.diaries.first?.catAllowed, true)
        XCTAssertEqual(store.snapshot.diaries.first?.catReadable, false)
        XCTAssertNil(store.snapshot.diaries.first?.source)
        XCTAssertEqual(store.snapshot.attachments.first?.rev, 3)
        XCTAssertEqual(store.snapshot.attachments.first?.available, false)
        XCTAssertTrue(store.snapshot.memories.isEmpty)
        XCTAssertNil(store.snapshot.fileDescription(fileID: "f", fileRev: 3))

        let reopened = V2ChangesStore(directory: directory)
        let replay = Feed([.success(try page("four", entries: [memory(2), description(4)]))])
        bind(reopened, replay)
        XCTAssertEqual(reopened.snapshot.cursor, "three")
        reopened.setForeground(true)
        await reopened.refresh()?.value
        XCTAssertEqual(replay.cursors, ["three"])
        XCTAssertTrue(reopened.snapshot.memories.isEmpty)
        XCTAssertNil(reopened.snapshot.fileDescription(fileID: "f", fileRev: 3))
        XCTAssertEqual(reopened.snapshot.change(kind: .memory, id: "m")?.sequence, 7)
        XCTAssertEqual(reopened.snapshot.cursor, "four")
    }

    func testExplicitResetStartsNewGenerationAndPreservesLocalOperationsAndOtherScopes() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let local = directory.appending(path: "local-operations")
        let pending = Data(#"{"draft":"keep","send":"request-key","withdraw":"revocation-key"}"#.utf8)
        try pending.write(to: local)
        let store = V2ChangesStore(directory: directory)
        bind(store, Feed([.success(try page("old", entries: [diary(80), tombstone("memory", "m", 81)]))]))
        store.setForeground(true)
        await store.refresh()?.value
        for other in [
            V2SyncScope(householdID: "house", homeHostID: "home", memberID: "b"),
            V2SyncScope(householdID: "house", homeHostID: "other", memberID: "a"),
            V2SyncScope(householdID: "other", homeHostID: "home", memberID: "a")
        ] {
            let feed = Feed([.success(try page("other", entries: []))])
            store.bind(scope: other, open: { feed.fetch })
            XCTAssertTrue(store.snapshot.diaries.isEmpty)
            await store.refresh()?.value
            XCTAssertEqual(feed.cursors, [nil])
        }

        let feed = Feed([.failure(V2.ChangesError.resetRequired(generation: "g2")),
                         .success(try page("new", generation: "g2", entries: [memory(1)]))])
        bind(store, feed)
        await store.refresh()?.value
        XCTAssertEqual(feed.cursors, ["old", nil])
        XCTAssertEqual(store.snapshot.generation, "g2")
        XCTAssertEqual(store.snapshot.cursor, "new")
        XCTAssertTrue(store.snapshot.diaries.isEmpty)
        XCTAssertEqual(store.snapshot.memories.map(\.id), ["m"])
        XCTAssertEqual(try Data(contentsOf: local), pending)
        let partner = V2SyncScope(householdID: "house", homeHostID: "home", memberID: "b")
        store.setForeground(false)
        store.bind(scope: partner, open: { throw URLError(.notConnectedToInternet) })
        XCTAssertEqual(store.snapshot.cursor, "other")
    }

    func testEmptyPageCommitsBeforeFailedNextRequestAndRetryAfterRestart() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = V2ChangesStore(directory: directory)
        let feed = Feed([.success(try page("empty", more: true, entries: [])), .failure(URLError(.networkConnectionLost))])
        bind(store, feed)
        store.setForeground(true)
        await store.refresh()?.value
        XCTAssertEqual(feed.cursors, [nil, "empty"])
        XCTAssertEqual(store.snapshot.cursor, "empty")
        XCTAssertNotNil(store.lastError)

        let reopened = V2ChangesStore(directory: directory)
        let retry = Feed([.success(try page("end", entries: []))])
        bind(reopened, retry)
        reopened.setForeground(true)
        await reopened.refresh()?.value
        XCTAssertEqual(retry.cursors, ["empty"])
        XCTAssertEqual(reopened.snapshot.cursor, "end")
        XCTAssertNil(reopened.lastError)
    }

    func testAtomicFailureKeepsPreviousRowsAndCursorOnDiskAndInMemory() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        var fail = false
        let store = V2ChangesStore(directory: directory) { data, url in
            if fail { throw CocoaError(.fileWriteOutOfSpace) }
            try data.write(to: url, options: .atomic)
        }
        let feed = Feed([.success(try page("old", entries: [diary(1)])),
                         .success(try page("failed", entries: [diary(2, readable: false), memory(3)])),
                         .failure(V2.ChangesError.resetRequired(generation: "g2"))])
        bind(store, feed)
        store.setForeground(true)
        await store.refresh()?.value
        fail = true
        await store.refresh()?.value
        await store.refresh()?.value
        XCTAssertEqual(feed.cursors, [nil, "old", "old"])
        XCTAssertEqual(store.snapshot.cursor, "old")
        XCTAssertEqual(store.snapshot.diaries.first?.catReadable, true)
        XCTAssertTrue(store.snapshot.memories.isEmpty)
        XCTAssertNotNil(store.lastError)

        let reopened = V2ChangesStore(directory: directory)
        bind(reopened, Feed([]))
        XCTAssertEqual(reopened.snapshot.cursor, "old")
        XCTAssertEqual(reopened.snapshot.diaries.first?.catReadable, true)
        XCTAssertTrue(reopened.snapshot.memories.isEmpty)
    }

    func testLateResponseCannotCommitAfterRebindingOrBackgroundCancellation() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = V2ChangesStore(directory: directory)
        let late = SuspendedFetch()
        store.bind(scope: scope, open: { late.fetch })
        store.setForeground(true)
        let oldTask = store.refresh()
        await late.waitForRequest()
        store.setForeground(false)
        store.setForeground(true)
        store.setForeground(false)

        let b = V2SyncScope(householdID: "house", homeHostID: "home", memberID: "b")
        let current = Feed([.success(try page("current", entries: []))])
        store.bind(scope: b, open: { current.fetch })
        store.setForeground(true)
        await store.refresh()?.value
        late.finish(try page("late", entries: [diary(1)]))
        await oldTask?.value
        XCTAssertEqual(late.calls, 1)
        XCTAssertEqual(store.scope, b)
        XCTAssertEqual(store.snapshot.cursor, "current")
        XCTAssertTrue(store.snapshot.diaries.isEmpty)

        store.setForeground(false)
        bind(store, Feed([]))
        XCTAssertNil(store.snapshot.cursor)

        store.bind(scope: scope, open: { late.fetch })
        store.setForeground(true)
        let cancelled = store.refresh()
        await late.waitForRequest()
        cancelled?.cancel()
        late.finish(try page("cancelled", entries: [diary(2)]))
        await cancelled?.value
        XCTAssertFalse(store.isSyncing)
        XCTAssertNil(store.snapshot.cursor)
    }

    func testWrongHomeAndUnexpectedGenerationNeverResetCache() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = V2ChangesStore(directory: directory)
        let feed = Feed([.success(try page("old", entries: [diary(1)])),
                         .failure(V2.ChangesError.wrongHomeHost(writerHostID: "other")),
                         .success(try page("unexpected", generation: "g2", entries: []))])
        bind(store, feed)
        store.setForeground(true)
        for _ in 0..<3 { await store.refresh()?.value }
        XCTAssertEqual(feed.cursors, [nil, "old", "old"])
        XCTAssertEqual(store.snapshot.cursor, "old")
        XCTAssertEqual(store.snapshot.diaries.map(\.id), ["d"])
        XCTAssertEqual(store.lastError as? V2.ChangesError, .invalidResponse)
    }

    func testWireValidationAndOpaqueCursor() throws {
        let client = V2Client(baseURL: URL(string: "https://localhost:8789")!, token: "test", session: .shared)
        let build = try client.changesRequest(cursor: "opaque+/%=?&", limit: 5)
        XCTAssertEqual(build.url?.path, "/v2/changes")
        XCTAssertEqual(URLComponents(url: try XCTUnwrap(build.url), resolvingAgainstBaseURL: false)?.queryItems,
                       [.init(name: "cursor", value: "opaque+/%=?&"), .init(name: "limit", value: "5")])
        XCTAssertEqual(build.value(forHTTPHeaderField: "Authorization"), "Bearer test")
        XCTAssertNil(try client.changesRequest(cursor: nil, limit: nil).url?.query)
        func response(_ status: Int, url: String = "https://localhost:8789/v2/changes") -> HTTPURLResponse {
            HTTPURLResponse(url: URL(string: url)!, statusCode: status, httpVersion: nil, headerFields: nil)!
        }
        let reset = Data(#"{"error":{"code":"cursor_reset_required"},"reset":true,"generation":"g2"}"#.utf8)
        XCTAssertThrowsError(try client.decodeChanges(response(409), data: reset)) {
            XCTAssertEqual($0 as? V2.ChangesError, .resetRequired(generation: "g2"))
        }
        XCTAssertThrowsError(try client.decodeChanges(response(409), data: Data(#"{"error":{"code":"wrong_home_host","writer_host_id":"host"}}"#.utf8))) {
            XCTAssertEqual($0 as? V2.ChangesError, .wrongHomeHost(writerHostID: "host"))
        }
        XCTAssertThrowsError(try client.decodeChanges(response(409), data: Data(#"{"error":{"code":"cursor_reset_required"}}"#.utf8))) {
            XCTAssertEqual($0 as? V2.ChangesError, .invalidResponse)
        }
        XCTAssertThrowsError(try client.decodeChanges(response(200, url: "https://other.local:8789/v2/changes"), data: reset))
        XCTAssertThrowsError(try page("bad", entries: [diary(1).replacingOccurrences(of: #""id":"d","revision""#, with: #""id":"wrong","revision""#)]))
        XCTAssertThrowsError(try page("bad", entries: [diary(0)]))
        let withUnknown = try page("ok", entries: [tombstone("future_kind", "t", 1), diary(2)])
        XCTAssertEqual(withUnknown.changes.map(\.id), ["d"])
    }

    func testActorScopeUsesConfirmedHomeHostAndRejectsAnotherMember() throws {
        let member = V2.Member(id: "a", householdId: "house", displayName: "A", homeHostId: "home")
        let household = V2.Household(id: "house", name: "家")
        let identity = V2.PairResult(deviceId: "device", deviceToken: "token", member: member, household: household)
        XCTAssertEqual(V2SyncScope(identity: identity), scope)
        let actual = V2.Me(actor: .init(memberId: "a", deviceId: "device", hostId: "home", householdId: "house"),
                           member: member, household: household)
        XCTAssertNoThrow(try scope.validate(actual, deviceID: "device"))
        let partner = V2.Me(actor: .init(memberId: "b", deviceId: "device", hostId: "home", householdId: "house"),
                            member: member, household: household)
        XCTAssertThrowsError(try scope.validate(partner, deviceID: "device"))
        let peer = V2.Me(actor: .init(memberId: "a", deviceId: "device", hostId: "peer", householdId: "house"),
                         member: member, household: household)
        XCTAssertThrowsError(try scope.validate(peer, deviceID: "device")) {
            XCTAssertEqual($0 as? V2.ChangesError, .wrongHomeHost(writerHostID: "home"))
        }
    }

    private func bind(_ store: V2ChangesStore, _ feed: Feed) {
        store.bind(scope: scope, open: { feed.fetch })
    }

    private func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appending(path: "V2ChangesTests-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
        return url
    }

    private func page(_ next: String, generation: String = "g1", more: Bool = false, entries: [String]) throws -> V2.ChangesPage {
        let json = #"{"generation":"\#(generation)","reset":false,"changes":[\#(entries.joined(separator: ","))],"next":"\#(next)","has_more":\#(more)}"#
        return try V2.decoder.decode(V2.ChangesPage.self, from: Data(json.utf8))
    }

    private func diary(_ sequence: Int, readable: Bool = true) -> String {
        let source = readable ? #"{"member_id":"a","conversation_id":"c","message_id":"msg","revision":9}"# : "null"
        return #"{"kind":"diary","id":"d","sequence":\#(sequence),"op":"upsert","value":{"id":"d","revision":3,"updated_at":123,"deleted_at":null,"owner_member_id":"a","text":"今天","recorded_at":123,"local_day":"2026-11-22","time_zone":"Asia/Shanghai","cat_allowed":true,"cat_readable":\#(readable),"source":\#(source),"can_edit":true}}"#
    }

    private func memory(_ sequence: Int) -> String {
        #"{"kind":"memory","id":"m","sequence":\#(sequence),"op":"upsert","value":{"id":"m","revision":1,"updated_at":123,"deleted_at":null,"subject_member_id":null,"predicate":"喜欢","value":"团子","source":null,"can_edit":true}}"#
    }

    private func file(_ sequence: Int, available: Bool = true) -> String {
        #"{"kind":"file","id":"f","sequence":\#(sequence),"op":"upsert","value":{"id":"f","owner_member_id":"a","conversation_id":"c","source_message_id":null,"source_message_rev":null,"sha256":"123","byte_size":3,"file_name":"图.png","media_type":"image/png","description":null,"rev":3,"created_at":1,"updated_at":2,"available":\#(available)}}"#
    }

    private func description(_ sequence: Int) -> String {
        #"{"kind":"file_description","id":"desc","sequence":\#(sequence),"op":"upsert","value":{"id":"desc","revision":1,"file_id":"f","file_rev":3,"sha256":"123","source_message_id":null,"source_message_rev":null,"text":"小猫","model_id":"test","created_at":1}}"#
    }

    private func tombstone(_ kind: String, _ id: String, _ sequence: Int) -> String {
        #"{"kind":"\#(kind)","id":"\#(id)","sequence":\#(sequence),"op":"delete"}"#
    }

    @MainActor private final class Feed {
        var responses: [Result<V2.ChangesPage, Error>]
        var cursors: [String?] = []

        init(_ responses: [Result<V2.ChangesPage, Error>]) { self.responses = responses }

        func fetch(_ cursor: String?) async throws -> V2.ChangesPage {
            cursors.append(cursor)
            guard !responses.isEmpty else { throw URLError(.badServerResponse) }
            return try responses.removeFirst().get()
        }
    }

    @MainActor private final class SuspendedFetch {
        private var response: CheckedContinuation<V2.ChangesPage, Error>?
        private var request: CheckedContinuation<Void, Never>?
        private(set) var calls = 0

        func fetch(_ cursor: String?) async throws -> V2.ChangesPage {
            calls += 1
            return try await withCheckedThrowingContinuation {
                response = $0
                request?.resume()
                request = nil
            }
        }

        func waitForRequest() async {
            guard response == nil else { return }
            await withCheckedContinuation { request = $0 }
        }

        func finish(_ page: V2.ChangesPage) {
            response?.resume(returning: page)
            response = nil
        }
    }
}
