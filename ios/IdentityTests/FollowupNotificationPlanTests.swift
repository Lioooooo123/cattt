import Foundation

@main struct FollowupNotificationPlanTests {
    static func main() throws {
        func date(_ value: String) -> Date { APITicket.parseDate(value)! }
        func ticket(_ id: String = "one", _ due: String = "2026-11-12T12:00:00Z", zone: String = "UTC", status: String = "open", mandate: String = "explicit", stage: String = "scheduled") -> APITicket {
            APITicket(id: id, kind: "followup", mandateKind: mandate, goal: "聊聊", sourceMessageId: "source", status: status, stage: stage, dueAt: due, timeZone: zone)
        }
        let now = date("2026-11-12T00:00:00Z")
        func plan(_ tickets: [APITicket], _ pending: [String] = []) -> FollowupNotificationPlan {
            FollowupNotificationPlan(tickets: tickets, now: now, pendingIDs: pending)
        }
        precondition(plan([ticket()]).add.first?.fireDate == date("2026-11-12T12:00:00Z"))
        precondition(plan([ticket("night", "2026-11-12T22:00:00Z")]).add.first?.fireDate == date("2026-11-13T09:00:00Z"))
        precondition(plan([ticket("early", "2026-11-12T08:59:00Z")]).add.first?.fireDate == date("2026-11-12T09:00:00Z"))
        precondition(plan([ticket("china", "2026-11-12T15:00:00Z", zone: "Asia/Shanghai")]).add.first?.fireDate == date("2026-11-13T01:00:00Z"))
        precondition(plan([ticket("dst", "2026-11-12T04:00:00Z", zone: "America/New_York")]).add.first?.fireDate == date("2026-11-12T14:00:00Z"))
        let invalid = [ticket("past", "2026-11-11T12:00:00Z"), ticket("equal", "2026-11-12T00:00:00Z"), ticket("cancel", status: "ended", stage: "cancelled"), ticket("inferred", mandate: "inferred"), ticket("bad", "invalid"), ticket("zone", zone: "invalid"), ticket("done", stage: "asked")]
        precondition(plan(invalid).add.isEmpty)
        precondition(plan([], ["followup-stale", "other"]).remove == ["followup-stale"])
        let replaced = plan([ticket("one", "2026-11-12T13:00:00Z")], ["followup-one", "followup-old"])
        precondition(replaced.add.first?.id == "followup-one" && replaced.add.first?.fireDate == date("2026-11-12T13:00:00Z"))
        precondition(replaced.remove == ["followup-old"])
        let many = (0..<70).map { ticket(String($0), ISO8601DateFormatter().string(from: date("2026-11-12T09:00:00Z").addingTimeInterval(Double($0 * 60)))) }
        precondition(plan(Array(many.reversed())).add.count == 64)
        precondition(plan(many).add.last?.id == "followup-63")
        precondition(plan(many, ["other"]).add.count == 63)
        precondition(plan([]).add.isEmpty && plan([]).remove.isEmpty)
        print("FollowupNotificationPlanTests: passed")
    }
}
