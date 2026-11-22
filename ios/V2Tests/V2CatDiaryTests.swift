import Foundation
import XCTest
@testable import Maomao

@MainActor
final class V2CatDiaryTests: XCTestCase {
    private let daily = """
    {"id":"daily-a","origin":"daily","revision":1,"local_day":"2026-11-22","time_zone":"Pacific/Kiritimati",
     "recorded_at":1795255200000,"updated_at":1795341900000,"text":"团子看见了小石头。","sources":[]}
    """
    private let legacy = """
    {"id":"legacy-a","origin":"legacy","revision":2,"owner_member_id":"a","local_day":"2025-01-04",
     "time_zone":"America/New_York","recorded_at":1736051400000,"updated_at":1736051400000,"text":"旧日记"}
    """

    func testProjectionUsesRecordedLocalDayAndReplacesRevokedTextAtSameRevision() async throws {
        var response = try snapshot(entries: [daily, legacy])
        var writes: [V2.CatDiarySource] = []
        let store = V2CatDiaryStore(read: { response }, authorize: { writes.append($0) })

        await store.refresh()
        XCTAssertEqual(store.snapshot?.entries(on: "2025-01-04").map(\.origin), [.legacy])
        XCTAssertEqual(store.snapshot?.entries(on: "2026-11-22").map(\.id), ["daily-a"])
        XCTAssertEqual(store.today(at: Date(timeIntervalSince1970: 1795255200), fallback: .gmt), "2026-11-22")
        XCTAssertEqual(store.snapshot?.entries(on: "2026-11-22").first?.text, "团子看见了小石头。")

        response = try snapshot(entries: [daily.replacingOccurrences(of: "团子看见了小石头。", with: "心里软软的。"), legacy])
        store.invalidateEntries()
        XCTAssertNil(store.snapshot)
        await store.refresh()
        XCTAssertEqual(store.snapshot?.entries(on: "2026-11-22").first?.text, "心里软软的。")
        XCTAssertTrue(writes.isEmpty)
    }

    func testLateReadAfterDeactivationCannotUpdateEitherAccount() async throws {
        let oldResponse = try snapshot(entries: [daily])
        let newResponse = try snapshot(entries: [legacy])
        var finish: CheckedContinuation<V2.CatDiarySnapshot, Error>?
        let old = V2CatDiaryStore(read: { try await withCheckedThrowingContinuation { finish = $0 } }, authorize: { _ in })
        let new = V2CatDiaryStore(read: { newResponse }, authorize: { _ in })
        let read = Task { await old.refresh() }
        while finish == nil { await Task.yield() }

        old.deactivate()
        await new.refresh()
        finish?.resume(returning: oldResponse)
        await read.value
        XCTAssertNil(old.snapshot)
        XCTAssertEqual(new.snapshot?.entries.map(\.id), ["legacy-a"])
    }

    func testAuthorizationIsExplicitAndReportsPublisherWaitWithManualRetry() async throws {
        let empty = try snapshot(entries: [])
        let source = V2.CatDiarySource(kind: .message, id: "owned", revision: 3)
        var submissions: [V2.CatDiarySource] = []
        let store = V2CatDiaryStore(read: { empty }, authorize: {
            submissions.append($0)
            if submissions.count == 1 { throw V2.APIError(code: "not_publisher") }
        })

        await store.refresh()
        XCTAssertTrue(submissions.isEmpty)
        await store.confirm(source)
        XCTAssertEqual(store.authorization[source], .waitingForPublisher)
        await store.refresh()
        XCTAssertEqual(submissions, [source])
        await store.confirm(source)
        XCTAssertEqual(store.authorization[source], .confirmed)
        await store.confirm(source)
        XCTAssertEqual(submissions, [source, source])
        XCTAssertNil(store.authorization[.init(kind: .message, id: "owned", revision: 4)])
    }

    func testUnavailableSourceAndOfflineReadDiscardOldProjection() async throws {
        let prior = try snapshot(entries: [daily])
        let source = V2.CatDiarySource(kind: .diary, id: "diary", revision: 3)
        var isOffline = false
        let store = V2CatDiaryStore(read: {
            if isOffline { throw URLError(.notConnectedToInternet) }
            return prior
        }, authorize: { _ in throw V2.APIError(code: "source_unavailable") })
        await store.refresh()
        XCTAssertNotNil(store.snapshot)
        await store.confirm(source)
        XCTAssertEqual(store.authorization[source], .unavailable)
        XCTAssertNil(store.snapshot)
        isOffline = true
        await store.refresh()
        XCTAssertNil(store.snapshot)
        XCTAssertNotNil(store.readError)
    }

    func testAuthorizationSendsOnlyKindIDAndRevision() throws {
        let client = V2Client(baseURL: URL(string: "https://localhost:9900")!, token: "synthetic", session: .shared)
        let request = try client.catDiarySourceRequest(.init(kind: .diary, id: "entry", revision: 2))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: AnyHashable])
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/v2/cat-diary/sources")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic")
        XCTAssertEqual(body, ["kind": "diary", "id": "entry", "revision": 2])
    }

    private func snapshot(entries: [String]) throws -> V2.CatDiarySnapshot {
        let json = """
        {"entries":[\(entries.joined(separator: ","))],"calendar":{"time_zone":"Pacific/Kiritimati","version":1}}
        """
        return try V2.decoder.decode(V2.CatDiarySnapshot.self, from: Data(json.utf8))
    }
}
