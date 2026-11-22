import Foundation

extension V2 {
    struct WorkSource: Codable, Equatable {
        let conversationID: String
        let messageID: String
        let revision: Int

        var proof: [String: Any] { ["source_message_id": messageID, "source_revision": revision] }
    }

    enum TicketAction: Codable, Equatable {
        case schedule(source: WorkSource, about: String, when: String)
        case start(source: WorkSource, goal: String)
        case reschedule(ticketID: String, when: String)
        case append(ticketID: String, text: String)
        case cancel(ticketID: String)

        var createsTicket: Bool {
            switch self {
            case .schedule, .start: return true
            default: return false
            }
        }

        var label: String {
            switch self {
            case .schedule: return "创建约定"
            case .start: return "创建托付"
            case .reschedule: return "改时间"
            case .append: return "补充托付"
            case .cancel: return "取消事项"
            }
        }
    }

    struct Ticket: Codable, Identifiable, Equatable {
        let id: String
        let revision: Int?
        let conversationID: String
        let forMemberID: String
        let publisherHostID: String
        let kind: String
        let mandateKind: String
        let sourceMessageID: String
        let sourceRevision: Int
        let goal: String
        let status: String
        let stage: String
        let dueAt: Int64?
        let timeZone: String
        let endedReason: String?

        enum CodingKeys: String, CodingKey {
            case id, revision, kind, goal, status, stage
            case conversationID = "conversation_id", forMemberID = "for_member_id", publisherHostID = "publisher_host_id"
            case mandateKind = "mandate_kind", sourceMessageID = "source_message_id", sourceRevision = "source_revision"
            case dueAt = "due_at", timeZone = "time_zone", endedReason = "ended_reason"
        }

        var date: Date? { dueAt.map { Date(timeIntervalSince1970: Double($0) / 1000) } }
        var isOpen: Bool { status == "open" }
        var canResume: Bool {
            kind == "errand" && mandateKind == "explicit" && status == "ended" && ["failed", "blocked"].contains(stage)
        }
        var label: String {
            switch stage {
            case "scheduled": return "约好了"
            case "queued": return "在等前面的事"
            case "thinking": return "团子在想"
            case "waiting", "quiet_waiting": return "在等你"
            case "completed": return kind == "followup" ? "已到约定时间" : "好了"
            case "failed": return "没办成"
            case "blocked": return "遇到阻碍"
            case "cancelled": return "已取消"
            case "discarded": return "先放下了"
            default: return isOpen ? "进行中" : "已结束"
            }
        }
    }

    struct TicketReceipt: Decodable {
        let ticketID: String
        enum CodingKeys: String, CodingKey { case ticketID = "ticket_id" }
    }

    struct MailboxLetter: Codable, Identifiable, Equatable {
        let id: String
        let revision: Int?
        let conversationID: String
        let forMemberID: String
        let publisherHostID: String
        let ticketID: String
        let text: String
        let createdAt: Int64
        let readAt: Int64?

        enum CodingKeys: String, CodingKey {
            case id, revision, text
            case conversationID = "conversation_id", forMemberID = "for_member_id", publisherHostID = "publisher_host_id"
            case ticketID = "ticket_id", createdAt = "created_at", readAt = "read_at"
        }

        var date: Date { Date(timeIntervalSince1970: Double(createdAt) / 1000) }
    }

    struct MailboxPage: Decodable {
        let letters: [MailboxLetter]
        let nextCursor: String?
        let hasMore: Bool
        enum CodingKeys: String, CodingKey { case letters, nextCursor = "next_cursor", hasMore = "has_more" }
    }

    struct RelayReceipt: Codable, Equatable {
        enum State: String, Codable {
            case pending, published, dropped, queued, accepted, rejected

            var isPending: Bool { self == .pending || self == .queued }
            var label: String {
                switch self {
                case .pending, .queued: return "待送"
                case .accepted: return "对方电脑已接受"
                case .published: return "已转告"
                case .dropped: return "未转告"
                case .rejected: return "对方电脑拒绝接收"
                }
            }
        }

        let id: String
        let state: State
        let urgent: Bool
        let reason: String?
    }
}

extension V2.Message {
    func workSource(memberID: String, conversationID: String) -> V2.WorkSource? {
        guard author.kind == .member, author.memberId == memberID, self.conversationId == conversationID,
              status == "complete", modality == "text",
              id.range(of: #"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"#, options: .regularExpression) != nil else { return nil }
        // R6.10/R6.11 omit the revision in chat DTOs. Native member sends
        // are inserted at revision 1 and their original text is immutable.
        guard let sourceRevision = revision ?? (clientMessageId == nil ? nil : 1), sourceRevision > 0 else { return nil }
        return .init(conversationID: conversationID, messageID: id, revision: sourceRevision)
    }

    func canOfferRelay(memberID: String, conversationID: String, kind: V2.Conversation.Kind) -> Bool {
        guard kind == .direct, workSource(memberID: memberID, conversationID: conversationID) != nil else { return false }
        let command = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let explicit = command.range(of: #"\A帮我(?:紧急)?转告[：:][^\S\r\n]*[^\s\r\n][^\r\n]*\z"#, options: .regularExpression) != nil
        let veto = #"(?:(?:别|不要|勿|不能|不许|不准|禁止)\s*(?:(?:把.{0,30}?)?(?:转告|告诉|透露|转达|转发|公开)|(?:跟|和|对|让|给).{1,32}?(?:说|讲|知道|看))|(?:don't|do not|never)\s+(?:tell|share|forward))"#
        return explicit && command.precomposedStringWithCompatibilityMapping.range(of: veto, options: [.regularExpression, .caseInsensitive]) == nil
    }
}
