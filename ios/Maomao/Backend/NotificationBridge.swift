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
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Self.token = deviceToken.map { String(format: "%02x", $0) }.joined()
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        if response.notification.request.identifier.hasPrefix("followup-") {
            Self.pendingLocal = true
            Self.store?.resolveNotificationIntent()
        } else if let intent = NotificationIntent.parse(response.notification.request.content.userInfo) {
            Self.pending = intent
            Self.store?.resolveNotificationIntent()
        }
        completionHandler()
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        Self.store?.refreshInbox()
        completionHandler(notification.request.identifier.hasPrefix("followup-") ? [.banner, .sound] : [])
    }
}
