import UIKit
import UserNotifications

extension AppStore {
    func bindV2Notifications() {
        guard let chat = v2Chat, let scope = V2SyncScope(identity: chat.connection.identity) else {
            FollowupNotifications.reconcileV2([], scope: nil) { [weak self] in self?.v2Chat == nil }
            return
        }
        chat.changes.onReminderSnapshot = { [weak self, weak chat] tickets in
            guard let self, let chat, v2Chat === chat else { return }
            scheduleV2Reminders(tickets, chat: chat, scope: scope)
        }
        chat.work.onAgreementSaved = { [weak self, weak chat] in
            guard let self, let chat, v2Chat === chat else { return }
            Task { await self.allowV2Reminders(chat, scope: scope) }
        }
        scheduleV2Reminders(chat.changes.snapshot.reminderTickets, chat: chat, scope: scope)
    }

    private func scheduleV2Reminders(_ tickets: [V2.Ticket], chat: V2ChatStore, scope: V2SyncScope) {
        FollowupNotifications.reconcileV2(tickets, scope: scope) { [weak self, weak chat] in
            guard let self, let chat else { return false }
            return v2Chat === chat
        }
    }

    private func allowV2Reminders(_ chat: V2ChatStore, scope: V2SyncScope) async {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        guard v2Chat === chat else { return }
        if settings.authorizationStatus == .notDetermined {
            _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
        }
        guard v2Chat === chat else { return }
        scheduleV2Reminders(chat.changes.snapshot.reminderTickets, chat: chat, scope: scope)
        await syncV2PushRegistration(chat)
    }

    func syncV2PushRegistration(_ chat: V2ChatStore) async {
        #if !targetEnvironment(simulator)
        guard v2Chat === chat, !syncingV2Push,
              let scope = V2SyncScope(identity: chat.connection.identity),
              let topic = Bundle.main.bundleIdentifier else { return }
        syncingV2Push = true
        defer { syncingV2Push = false }
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        guard v2Chat === chat, !Task.isCancelled else { return }

        let authorized = [.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus)
        let token = authorized ? NotificationBridge.token : nil
        if authorized && token == nil {
            UIApplication.shared.registerForRemoteNotifications()
            return
        }
        if settings.authorizationStatus == .notDetermined { return }
        let state = token ?? ""
        guard registeredV2PushState != state else { return }
        do {
            let client = try await chat.connection.select()
            try scope.validate(await client.me(), deviceID: chat.connection.identity.deviceId)
            guard v2Chat === chat, !Task.isCancelled else { return }
            try await client.updatePushRegistration(token: token, topic: topic)
            if v2Chat === chat { registeredV2PushState = state }
        } catch let error as V2.APIError where error.code == "push_disabled" {
            if v2Chat === chat { registeredV2PushState = state }
        } catch {
            // 前台轮询会重试。暂时连不到家时，已排入系统的本机通知继续有效。
        }
        #endif
    }

    func resolveV2LocalReminder() {
        guard let intent = NotificationBridge.pendingV2Local else { return }
        NotificationBridge.pendingV2Local = nil
        guard let chat = v2Chat, let scope = V2SyncScope(identity: chat.connection.identity),
              intent.identifier.hasPrefix(scope.followupNotificationPrefix) else { return }
        chat.notificationConversationID = intent.conversationID
        screen = .chat
        chat.changes.refresh()
    }

    func resolveV2PushIntent(_ chat: V2ChatStore) async {
        guard v2Chat === chat, !resolvingV2Push, let intent = NotificationBridge.pendingV2 else { return }
        guard intent.matches(chat.connection.identity) else {
            NotificationBridge.pendingV2 = nil
            return
        }
        resolvingV2Push = true
        defer { resolvingV2Push = false }
        do {
            let client = try await chat.connection.select()
            let target = try await client.notificationTarget(intent.id)
            guard v2Chat === chat, NotificationBridge.pendingV2 == intent else { return }
            switch target.route {
            case "chat":
                guard let conversation = target.conversationID, let message = target.messageID else { return }
                chat.notificationMessageID = message
                chat.notificationConversationID = conversation
                screen = .chat
            case "mailbox":
                guard let letter = target.letterID else { return }
                notificationLetterID = letter
                openMailbox(anchor: mailboxAnchor)
                chat.changes.refresh()
            default: return
            }
            NotificationBridge.pendingV2 = nil
        } catch let error as V2.APIError where ["not_found", "unauthorized"].contains(error.code) {
            if NotificationBridge.pendingV2 == intent { NotificationBridge.pendingV2 = nil }
        } catch {
            // 冷启动不在家时保留同一配对的点击，重连后再解析。
        }
    }
}
