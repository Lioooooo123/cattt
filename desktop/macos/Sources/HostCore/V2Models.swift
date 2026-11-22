import Foundation

enum V2 {
    struct Member: Codable, Equatable, Identifiable {
        let id: String
        let householdId: String
        let displayName: String
        let homeHostId: String
        enum CodingKeys: String, CodingKey {
            case id
            case householdId = "household_id"
            case displayName = "display_name"
            case homeHostId = "home_host_id"
        }
    }
    struct Household: Codable, Equatable { let id: String; let name: String }
    struct Actor: Codable {
        let memberId: String; let deviceId: String; let hostId: String; let householdId: String
        enum CodingKeys: String, CodingKey {
            case memberId = "member_id", deviceId = "device_id", hostId = "host_id", householdId = "household_id"
        }
    }
    struct Me: Decodable { let actor: Actor; let member: Member; let household: Household }
    struct PairResult: Codable {
        let deviceId: String; let deviceToken: String; let member: Member; let household: Household
        enum CodingKeys: String, CodingKey {
            case deviceId = "device_id", deviceToken = "device_token", member, household
        }
    }
    struct Author: Codable, Equatable {
        enum Kind: String, Codable { case member, cat }
        let kind: Kind
        let memberId: String?
        enum CodingKeys: String, CodingKey { case kind; case memberId = "member_id" }
    }
    struct Message: Codable, Equatable, Identifiable {
        let id: String
        let conversationId: String
        let cursor: String
        let author: Author
        let text: String
        let modality: String
        let status: String
        let clientMessageId: String?
        let replyToMessageId: String?
        let turnId: String?
        let createdAt: Int64
        enum CodingKeys: String, CodingKey {
            case id, cursor, author, text, modality, status
            case conversationId = "conversation_id", clientMessageId = "client_message_id"
            case replyToMessageId = "reply_to_message_id", turnId = "turn_id", createdAt = "created_at"
        }
    }
    struct Conversation: Codable, Identifiable {
        enum Kind: String, Codable { case group, direct }
        let id: String
        let kind: Kind
        let ownerMemberId: String?
        let participantMemberIds: [String]
        let publisherHostId: String
        let createdAt: Int64
        var lastMessage: Message?
        enum CodingKeys: String, CodingKey {
            case id, kind
            case ownerMemberId = "owner_member_id", participantMemberIds = "participant_member_ids"
            case publisherHostId = "publisher_host_id", createdAt = "created_at", lastMessage = "last_message"
        }
        var title: String { kind == .group ? "我们仨" : "我和团子" }
    }
    struct Turn: Codable {
        enum Status: String, Codable {
            case queued, generating, completed, stopped, superseded, failed
        }
        let id: String
        let conversationId: String
        let status: Status
        let triggerMessageId: String
        let replyMessageId: String?
        let errorCode: String?
        let streamUrl: String
        enum CodingKeys: String, CodingKey {
            case id, status
            case conversationId = "conversation_id", triggerMessageId = "trigger_message_id"
            case replyMessageId = "reply_message_id", errorCode = "error_code", streamUrl = "stream_url"
        }
    }
    struct MessagesPage: Decodable {
        let messages: [Message]
        let hasMoreBefore: Bool
        let hasMoreAfter: Bool
        enum CodingKeys: String, CodingKey {
            case messages, hasMoreBefore = "has_more_before", hasMoreAfter = "has_more_after"
        }
    }
    struct Sent: Decodable { let message: Message; let turn: Turn? }
    enum APIError: Error, Equatable, LocalizedError {
        case unauthorized, notFound, idempotencyConflict, notPublisher, invalidRequest, pairingCodeInvalid
        case other(String)
        init(code: String) {
            switch code {
            case "unauthorized": self = .unauthorized
            case "not_found": self = .notFound
            case "idempotency_conflict": self = .idempotencyConflict
            case "not_publisher": self = .notPublisher
            case "invalid_request": self = .invalidRequest
            case "pairing_code_invalid": self = .pairingCodeInvalid
            default: self = .other(code)
            }
        }
        var code: String {
            switch self {
            case .unauthorized: return "unauthorized"
            case .notFound: return "not_found"
            case .idempotencyConflict: return "idempotency_conflict"
            case .notPublisher: return "not_publisher"
            case .invalidRequest: return "invalid_request"
            case .pairingCodeInvalid: return "pairing_code_invalid"
            case .other(let code): return code
            }
        }
        var errorDescription: String? {
            switch self {
            case .unauthorized: return "连接凭证已失效，请重新配对"
            case .notFound: return "这段聊天暂时不可用"
            case .idempotencyConflict: return "发送内容与原请求不一致"
            case .notPublisher: return "请连接这段聊天所在的电脑"
            case .invalidRequest: return "请求内容有误，请检查后重试"
            case .pairingCodeInvalid: return "配对码已失效，请在电脑上重新生成"
            case .other: return "电脑暂时没能完成请求，请稍后重试"
            }
        }
    }
    struct ErrorEnvelope: Decodable { struct Detail: Decodable { let code: String }; let error: Detail }
    static var decoder: JSONDecoder { JSONDecoder() }
    static var encoder: JSONEncoder { JSONEncoder() }
}
