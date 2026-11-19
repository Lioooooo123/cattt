import Foundation
import UserNotifications

@MainActor enum FollowupNotifications {
    private static var revision = 0
    static func remove(_ ticketID: String) {
        revision += 1
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: ["followup-" + ticketID])
    }
    static func reconcile(_ tickets: [APITicket], isCurrent: () -> Bool) async {
        revision += 1
        let expected = revision
        let center = UNUserNotificationCenter.current()
        let pending = await center.pendingNotificationRequests()
        guard revision == expected, isCurrent() else { return }
        let plan = FollowupNotificationPlan(tickets: tickets, now: Date(), pendingIDs: pending.map(\.identifier))
        center.removePendingNotificationRequests(withIdentifiers: plan.remove)
        for notice in plan.add {
            guard revision == expected, isCurrent() else { return }
            let content = UNMutableNotificationContent()
            content.title = notice.title
            content.body = notice.body
            content.sound = .default
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(secondsFromGMT: 0)!
            var components = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: notice.fireDate)
            components.timeZone = calendar.timeZone
            let request = UNNotificationRequest(identifier: notice.id, content: content,
                                                trigger: UNCalendarNotificationTrigger(dateMatching: components, repeats: false))
            try? await center.add(request)
        }
    }
}
