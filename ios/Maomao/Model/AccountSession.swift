import Foundation

struct NotificationIntent: Codable, Equatable {
    let accountID: String
    let notificationID: String
    func canResolve(accountID: String?, connected: Bool) -> Bool { connected && self.accountID == accountID }
    static func parse(_ value: [AnyHashable: Any]) -> NotificationIntent? {
        guard let account = value["account_id"] as? String, !account.isEmpty,
              let id = value["notification_id"] as? String, UUID(uuidString: id) != nil else { return nil }
        return NotificationIntent(accountID: account, notificationID: id)
    }
}

enum AgreementNotificationGate {
    static func accepted(sourceID: String?, savedSources: [String]) -> Bool {
        guard let sourceID else { return false }
        return savedSources.contains(sourceID)
    }
}

enum CredentialPersistencePolicy {
    static func maySaveDeveloperToken(mode: String, accountID: String?) -> Bool {
        mode == "local" && accountID == nil
    }
}
