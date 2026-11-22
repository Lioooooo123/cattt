import SwiftUI
import UserNotifications
import UIKit

extension AppStore {
    /// 只有服务端明确的约定凭证才能触发首次系统授权，不根据回复文字猜测。
    func requestNotificationPermissionAfterAgreement(sourceMessageID: String?) {
        guard v2Chat == nil, backend.isRemote, !backend.token.isEmpty else { return }
        let client = api
        Task { @MainActor in
            guard let tickets = try? await client.tickets(includeEndedFollowups: true), backend == client.config else { return }
            await reconcileFollowupNotifications(tickets, config: client.config)
            guard AgreementNotificationGate.accepted(sourceID: sourceMessageID, savedSources: tickets.filter { $0.kind == "followup" && $0.mandateKind == "explicit" && $0.stage != "cancelled" && $0.stage != "dropped" }.compactMap(\.sourceMessageId)) else { return }
            let center = UNUserNotificationCenter.current()
            let settings = await center.notificationSettings()
            if settings.authorizationStatus == .notDetermined { _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge]) }
            await reconcileFollowupNotifications(tickets, config: client.config)
        }
    }
    func reconcileFollowupNotifications(_ tickets: [APITicket], config: BackendConfig) async {
        await FollowupNotifications.reconcile(tickets) { self.v2Chat == nil && self.backend == config }
    }

    func refreshFollowupNotifications() async {
        guard backend.isRemote, !backend.token.isEmpty else { return }
        let client = api
        guard let tickets = try? await client.tickets(includeEndedFollowups: true), backend == client.config else { return }
        await reconcileFollowupNotifications(tickets, config: client.config)
    }
    func resolveNotificationIntent() {
        guard v2Chat == nil else { return }
        if NotificationBridge.pendingLocal {
            NotificationBridge.pendingLocal = false
            screen = .chat
            refreshInbox()
        }
        guard let intent = NotificationBridge.pending,
              intent.canResolve(accountID: backend.accountID, connected: backend.isRemote && !backend.token.isEmpty), !resolvingNotification else { return }
        resolvingNotification = true
        let client = api
        Task { @MainActor in
            defer { resolvingNotification = false }
            do {
                let target = try await client.resolveNotification(intent.notificationID)
                guard backend == client.config else { return }
                if target.route == "chat", let message = target.message {
                    if !messages.contains(where: { $0.serverID == message.id }) { messages.append(ChatMessage(api: message)); messages.sort { ($0.serverSequence ?? 0) < ($1.serverSequence ?? 0) } }
                    screen = .chat; notificationMessageID = message.id
                } else if target.route == "mailbox", let id = target.letterId {
                    refreshInbox(); openMailbox(anchor: mailboxAnchor); notificationLetterID = id
                } else { throw APIError.badResponse }
                NotificationBridge.pending = nil
            } catch { identityError = "连上家里的电脑并同步后，再打开这条消息" }
        }
    }
}
