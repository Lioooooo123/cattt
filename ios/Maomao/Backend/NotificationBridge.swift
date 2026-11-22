import UIKit
import UserNotifications

/// 本机约定直接打开聊天，远程通知仍从已鉴权接口解析。
@MainActor final class NotificationBridge: NSObject, UIApplicationDelegate, @preconcurrency UNUserNotificationCenterDelegate {
    static weak var store: AppStore?
    static var token: String?
    static var pendingLocal: Bool {
        get { UserDefaults.standard.bool(forKey: "notification.followup.pending") }
        set { UserDefaults.standard.set(newValue, forKey: "notification.followup.pending") }
    }
    static var pending: NotificationIntent? {
        get { UserDefaults.standard.data(forKey: "notification.pending.v1").flatMap { try? JSONDecoder().decode(NotificationIntent.self, from: $0) } }
        set { UserDefaults.standard.set(newValue.flatMap { try? JSONEncoder().encode($0) }, forKey: "notification.pending.v1") }
    }
    struct LocalReminder: Codable {
        let identifier: String
        let conversationID: String?
    }

    static var pendingV2Local: LocalReminder? {
        get { UserDefaults.standard.data(forKey: "notification.local.v2").flatMap { try? JSONDecoder().decode(LocalReminder.self, from: $0) } }
        set { UserDefaults.standard.set(newValue.flatMap { try? JSONEncoder().encode($0) }, forKey: "notification.local.v2") }
    }

    static var pendingV2: V2PushIntent? {
        get { UserDefaults.standard.data(forKey: "notification.pending.v2").flatMap { try? JSONDecoder().decode(V2PushIntent.self, from: $0) } }
        set { UserDefaults.standard.set(newValue.flatMap { try? JSONEncoder().encode($0) }, forKey: "notification.pending.v2") }
    }

    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Self.token = deviceToken.map { String(format: "%02x", $0) }.joined()
        if let store = Self.store, let chat = store.v2Chat {
            Task { await store.syncV2PushRegistration(chat) }
        }
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let request = response.notification.request
        if request.identifier.hasPrefix(FollowupNotificationPlan.v2Prefix) {
            Self.pendingV2Local = .init(identifier: request.identifier,
                                        conversationID: request.content.userInfo["conversation_id"] as? String)
            Self.store?.resolveV2LocalReminder()
        } else if request.identifier.hasPrefix("followup-") {
            Self.pendingLocal = true
            Self.store?.resolveNotificationIntent()
        } else if let intent = V2PushIntent(request.content.userInfo) {
            Self.pendingV2 = intent
            if let store = Self.store, let chat = store.v2Chat {
                Task { await store.resolveV2PushIntent(chat) }
            }
        } else if let intent = NotificationIntent.parse(request.content.userInfo) {
            Self.pending = intent
            Self.store?.resolveNotificationIntent()
        }
        completionHandler()
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        if let chat = Self.store?.v2Chat {
            chat.changes.refresh()
            completionHandler([])
        } else {
            Self.store?.refreshInbox()
            let identifier = notification.request.identifier
            let legacyLocal = identifier.hasPrefix("followup-") && !identifier.hasPrefix(FollowupNotificationPlan.v2Prefix)
            completionHandler(legacyLocal ? [.banner, .sound] : [])
        }
    }
}
