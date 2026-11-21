import Foundation

enum V2 {
    struct Member: Codable, Equatable, Identifiable {
        let id: String
        let householdId: String
        let displayName: String
        let homeHostId: String
    }
    struct Household: Codable, Equatable { let id: String; let name: String }
    struct Actor: Codable { let memberId: String; let deviceId: String; let hostId: String; let householdId: String }
    struct Me: Decodable { let actor: Actor; let member: Member; let household: Household }
    struct PairResult: Codable { let deviceId: String; let deviceToken: String; let member: Member; let household: Household }
    struct Author: Codable, Equatable {
        enum Kind: String, Codable { case member, cat }
        let kind: Kind
        let memberId: String?
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
        var title: String { kind == .group ? "我们仨" : "我和团子" }
    }
    struct Turn: Codable {
        let id: String
        let conversationId: String
        let status: String
        let triggerMessageId: String
        let replyMessageId: String?
        let errorCode: String?
        let streamUrl: String
    }
    struct MessagesPage: Decodable {
        let messages: [Message]
        let hasMoreBefore: Bool
        let hasMoreAfter: Bool
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
    static var decoder: JSONDecoder { let d = JSONDecoder(); d.keyDecodingStrategy = .convertFromSnakeCase; return d }
    static var encoder: JSONEncoder { let e = JSONEncoder(); e.keyEncodingStrategy = .convertToSnakeCase; return e }
}
