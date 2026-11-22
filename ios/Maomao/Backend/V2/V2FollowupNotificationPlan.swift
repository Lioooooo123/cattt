import Foundation

extension V2SyncScope {
    var followupNotificationPrefix: String {
        let key = [householdID, homeHostID, memberID].joined(separator: "\u{0}")
        return FollowupNotificationPlan.v2Prefix + PairFingerprint.digest(Data(key.utf8)) + "-"
    }
}

extension FollowupNotificationPlan {
    static let v2Prefix = "followup-v2-"

    init(tickets: [V2.Ticket], scope: V2SyncScope?, now: Date, pending: [String: Date]) {
        let candidates = scope.map { scope in
            tickets.compactMap { ticket -> Notice? in
                guard ticket.forMemberID == scope.memberID, ticket.kind == "followup",
                      ticket.mandateKind == "explicit", ticket.isOpen, ticket.stage == "scheduled",
                      let due = ticket.date, due > now, let zone = TimeZone(identifier: ticket.timeZone),
                      let fire = Self.fireDate(due, in: zone) else { return nil }
                let rounded = Date(timeIntervalSince1970: ceil(fire.timeIntervalSince1970))
                return Notice(id: scope.followupNotificationPrefix + ticket.id, fireDate: rounded,
                              conversationID: ticket.conversationID)
            }
        } ?? []
        let oldPrefix = scope == nil ? Self.v2Prefix : "followup-"
        let available = max(0, 64 - pending.keys.filter { !$0.hasPrefix(oldPrefix) }.count)
        let selected = candidates.sorted { ($0.fireDate, $0.id) < ($1.fireDate, $1.id) }.prefix(available)
        let selectedIDs = Set(selected.map(\.id))
        add = selected.filter { pending[$0.id] != $0.fireDate }
        remove = pending.keys.filter { $0.hasPrefix(oldPrefix) && !selectedIDs.contains($0) }.sorted()
    }
}
