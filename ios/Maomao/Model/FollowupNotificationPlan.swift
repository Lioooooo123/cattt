import Foundation

struct APITicket: Decodable, Identifiable {
    let id: String
    let kind: String
    let mandateKind: String?
    let goal: String
    let sourceMessageId: String?
    let status: String
    let stage: String
    let dueAt: String?
    let timeZone: String?

    var stageText: String {
        switch stage {
        case "queued": return "在等前面的事"
        case "thinking": return "我在想"
        case "waiting", "quiet_waiting": return "在等你"
        case "ready": return "好了"
        case "failed", "blocked": return "没办成"
        case "cancelled": return "已取消"
        case "dropped": return "先放下了"
        default: return "约好了"
        }
    }
    var date: Date? { dueAt.flatMap(Self.parseDate) }
    static func parseDate(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}

struct FollowupNotificationPlan {
    struct Notice: Equatable {
        let id: String
        let fireDate: Date
        var conversationID: String? = nil
        let title = "团子"
        let body = "约好的时间到了，想聊时再来。"
    }
    let add: [Notice]
    let remove: [String]

    init(tickets: [APITicket], now: Date, pendingIDs: [String]) {
        let otherCount = pendingIDs.filter { !$0.hasPrefix("followup-") }.count
        let candidates = tickets.compactMap { ticket -> Notice? in
            guard ticket.kind == "followup", ticket.mandateKind == "explicit",
                  ticket.status == "open", ticket.stage == "scheduled",
                  let due = ticket.date, due > now,
                  let zone = ticket.timeZone.flatMap(TimeZone.init(identifier:)) else { return nil }
            guard let fire = Self.fireDate(due, in: zone) else { return nil }
            return Notice(id: "followup-" + ticket.id, fireDate: fire)
        }.sorted { $0.fireDate == $1.fireDate ? $0.id < $1.id : $0.fireDate < $1.fireDate }
        add = Array(candidates.prefix(max(0, 64 - otherCount)))
        let selected = Set(add.map(\.id))
        remove = pendingIDs.filter { $0.hasPrefix("followup-") && !selected.contains($0) }
    }

    static func fireDate(_ due: Date, in zone: TimeZone) -> Date? {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let hour = calendar.component(.hour, from: due)
        if (9..<22).contains(hour) { return due }
        let day = hour >= 22 ? calendar.date(byAdding: .day, value: 1, to: due) : due
        return day.flatMap { calendar.date(bySettingHour: 9, minute: 0, second: 0, of: $0) }
    }
}
