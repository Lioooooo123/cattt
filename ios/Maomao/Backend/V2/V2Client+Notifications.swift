import Foundation

extension V2 {
    struct NotificationTarget: Decodable {
        let route: String
        let conversationID: String?
        let messageID: String?
        let letterID: String?

        enum CodingKeys: String, CodingKey {
            case route
            case conversationID = "conversation_id", messageID = "message_id", letterID = "letter_id"
        }
    }
}

struct V2PushIntent: Codable, Equatable {
    let id: String
    let householdID: String
    let memberID: String
    let hostID: String
    let deviceID: String

    init?(_ info: [AnyHashable: Any]) {
        guard let id = info["notification_id"] as? String, UUID(uuidString: id) != nil,
              let household = info["household_id"] as? String, let member = info["member_id"] as? String,
              let host = info["host_id"] as? String, let device = info["device_id"] as? String else { return nil }
        self.id = id
        householdID = household
        memberID = member
        hostID = host
        deviceID = device
    }

    func matches(_ pairing: V2.PairResult) -> Bool {
        guard let scope = V2SyncScope(identity: pairing) else { return false }
        return householdID == scope.householdID && memberID == scope.memberID && hostID == scope.homeHostID
            && deviceID == pairing.deviceId
    }
}

extension V2Client {
    func updatePushRegistration(token: String?, topic: String) async throws {
        #if DEBUG
        let environment = "sandbox"
        #else
        let environment = "production"
        #endif
        let request = try token.map {
            try self.request("PUT", "device/push", body: ["token": $0, "environment": environment, "topic": topic])
        } ?? self.request("DELETE", "device/push")
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
    }

    func notificationTarget(_ id: String) async throws -> V2.NotificationTarget {
        try await json(V2.NotificationTarget.self, request("GET", "notifications/" + id))
    }
}
