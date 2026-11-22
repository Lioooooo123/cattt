import Foundation
import UserNotifications

@MainActor enum FollowupNotifications {
    private static var revision = 0
    private static var pendingUpdate: Task<Void, Never>?

    static func remove(_ ticketID: String) {
        revision += 1
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: ["followup-" + ticketID])
    }

    static func reconcile(_ tickets: [APITicket], isCurrent: @escaping @MainActor () -> Bool) async {
        await enqueue(isCurrent: isCurrent) { pending in
            FollowupNotificationPlan(tickets: tickets, now: Date(), pendingIDs: pending.map(\.identifier))
        }.value
    }

    @discardableResult
    static func reconcileV2(_ tickets: [V2.Ticket], scope: V2SyncScope?,
                            isCurrent: @escaping @MainActor () -> Bool) -> Task<Void, Never> {
        enqueue(isCurrent: isCurrent) { pending in
            let dates = Dictionary(uniqueKeysWithValues: pending.map { request in
                (request.identifier, request.trigger?.nextCalendarDate ?? .distantPast)
            })
            return FollowupNotificationPlan(tickets: tickets, scope: scope, now: Date(), pending: dates)
        }
    }

    private static func enqueue(
        isCurrent: @escaping @MainActor () -> Bool,
        plan: @escaping @MainActor ([UNNotificationRequest]) -> FollowupNotificationPlan
    ) -> Task<Void, Never> {
        revision += 1
        let expected = revision
        let previous = pendingUpdate
        let task = Task { @MainActor in
            await previous?.value
            defer { if revision == expected { pendingUpdate = nil } }
            guard revision == expected, isCurrent() else { return }
            let center = UNUserNotificationCenter.current()
            let pending = await center.pendingNotificationRequests()
            guard revision == expected, isCurrent() else { return }
            let updates = plan(pending)
            center.removePendingNotificationRequests(withIdentifiers: updates.remove)
            for notice in updates.add {
                guard revision == expected, isCurrent() else { return }
                try? await center.add(request(for: notice))
            }
        }
        pendingUpdate = task
        return task
    }

    static func request(for notice: FollowupNotificationPlan.Notice) -> UNNotificationRequest {
        let content = UNMutableNotificationContent()
        content.title = notice.title
        content.body = notice.body
        content.sound = .default
        if let conversationID = notice.conversationID {
            content.userInfo = ["conversation_id": conversationID]
        }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        var components = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: notice.fireDate)
        components.timeZone = calendar.timeZone
        return UNNotificationRequest(identifier: notice.id, content: content,
                                     trigger: UNCalendarNotificationTrigger(dateMatching: components, repeats: false))
    }
}

private extension UNNotificationTrigger {
    var nextCalendarDate: Date? { (self as? UNCalendarNotificationTrigger)?.nextTriggerDate() }
}
