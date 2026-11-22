import XCTest
@testable import Maomao

@MainActor
final class V2FollowupNotificationsTests: XCTestCase {
    func testScopedPlanReschedulesDropsExpiredAndRemovesOldSpace() throws {
        let now = Date(timeIntervalSince1970: 1_795_348_800)
        let due = now.addingTimeInterval(600)
        let scope = V2SyncScope(householdID: "house", homeHostID: "home", memberID: "me")
        let ticket = try row(due)
        let other = try row(due, id: "other", member: "partner")
        let expired = try row(now.addingTimeInterval(-1), id: "expired")
        let first = FollowupNotificationPlan(tickets: [ticket, other, expired], scope: scope, now: now, pending: [:])
        let notice = try XCTUnwrap(first.add.first)
        XCTAssertEqual(first.add.count, 1)
        XCTAssertEqual(notice.fireDate, due)
        XCTAssertEqual(FollowupNotificationPlan(tickets: [ticket], scope: scope, now: now,
                                                 pending: [notice.id: due]).add, [])

        let updatedDue = due.addingTimeInterval(300)
        let edit = FollowupNotificationPlan(tickets: [try row(updatedDue)], scope: scope, now: now, pending: [notice.id: due])
        XCTAssertEqual(edit.add.map(\.id), [notice.id])
        XCTAssertEqual(edit.add.map(\.fireDate), [updatedDue])
        for otherScope in [
            V2SyncScope(householdID: "house", homeHostID: "home", memberID: "other"),
            V2SyncScope(householdID: "house", homeHostID: "another", memberID: "me"),
            V2SyncScope(householdID: "another", homeHostID: "home", memberID: "me"),
        ] {
            let change = FollowupNotificationPlan(tickets: [try row(due, member: otherScope.memberID)], scope: otherScope,
                                                  now: now, pending: [notice.id: due])
            XCTAssertEqual(change.remove, [notice.id])
            XCTAssertNotEqual(change.add.first?.id, notice.id)
        }
        let ended = FollowupNotificationPlan(tickets: [try row(due, status: "ended", stage: "cancelled")], scope: scope,
                                             now: now, pending: [notice.id: due])
        XCTAssertEqual(ended.remove, [notice.id])
        XCTAssertTrue(ended.add.isEmpty)
    }

    func testVerifiedProjectionRestoresOfflineAndClearsOnUnauthorizedWithoutReplayingTombstone() async throws {
        let dir = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let scope = V2SyncScope(householdID: "house", homeHostID: "host", memberID: "me")
        let store = V2ChangesStore(directory: dir)
        var observed: [[String]] = []
        store.onReminderSnapshot = { observed.append($0.map(\.id)) }
        let due = Date().addingTimeInterval(600)
        let ticket = try row(due)
        let value = try JSONSerialization.jsonObject(with: V2.encoder.encode(ticket))
        var next: Result<V2.ChangesPage, Error> = .success(try page("one", [entry(1, value: value)]))
        store.bind(scope: scope, open: { { _ in try next.get() } })
        store.setForeground(true)
        await store.refresh()?.value
        XCTAssertEqual(observed.last, ["ticket"])

        let reopened = V2ChangesStore(directory: dir)
        reopened.onReminderSnapshot = { observed.append($0.map(\.id)) }
        next = .failure(URLError(.notConnectedToInternet))
        reopened.bind(scope: scope, open: { { _ in try next.get() } })
        reopened.setForeground(true)
        await reopened.refresh()?.value
        XCTAssertEqual(observed.last, ["ticket"])

        reopened.invalidateReminder("ticket", in: scope)
        XCTAssertEqual(observed.last, [])
        next = .success(try page("repeated", [entry(1, value: value)]))
        await reopened.refresh()?.value
        XCTAssertEqual(observed.last, [])

        let edited = try V2.encoder.encode(row(due.addingTimeInterval(300)))
        next = .success(try page("edited", [entry(2, value: JSONSerialization.jsonObject(with: edited))]))
        await reopened.refresh()?.value
        XCTAssertEqual(observed.last, ["ticket"])

        next = .success(try page("two", [entry(3)]))
        await reopened.refresh()?.value
        XCTAssertEqual(observed.last, [])
        next = .success(try page("three", [entry(1, value: value)]))
        await reopened.refresh()?.value
        XCTAssertEqual(observed.last, [])
        next = .failure(V2.APIError(code: "unauthorized"))
        await reopened.refresh()?.value
        XCTAssertEqual(observed.last, [])
        XCTAssertNil(reopened.snapshot.cursor)
    }

    private func row(_ due: Date, id: String = "ticket", member: String = "me", status: String = "open",
                     stage: String = "scheduled") throws -> V2.Ticket {
        try V2.decoder.decode(V2.Ticket.self, from: JSONSerialization.data(withJSONObject: [
            "id": id, "revision": 1, "conversation_id": "conversation", "for_member_id": member,
            "publisher_host_id": "host", "kind": "followup", "mandate_kind": "explicit", "source_message_id": "source",
            "source_revision": 1, "goal": "测试提醒", "status": status, "stage": stage,
            "due_at": Int64(due.timeIntervalSince1970 * 1000), "time_zone": "Etc/UTC",
        ]))
    }

    private func entry(_ seq: Int, value: Any? = nil) -> [String: Any] {
        var row: [String: Any] = ["kind": "ticket", "sequence": seq, "id": "ticket", "op": value == nil ? "delete" : "upsert"]
        row["value"] = value
        return row
    }

    private func page(_ next: String, _ entries: [[String: Any]]) throws -> V2.ChangesPage {
        try V2.decoder.decode(V2.ChangesPage.self, from: JSONSerialization.data(withJSONObject: [
            "generation": "one", "next": next, "changes": entries, "reset": false, "has_more": false,
        ]))
    }
}
