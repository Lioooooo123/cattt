import Foundation

extension V2 {
    struct FileDescriptionProjection: Codable, Identifiable {
        let revision: Int
        let value: FileDescription.Value
        var id: String { value.id }

        private enum CodingKeys: String, CodingKey { case revision }

        init(from decoder: Decoder) throws {
            revision = try decoder.container(keyedBy: CodingKeys.self).decode(Int.self, forKey: .revision)
            value = try FileDescription.Value(from: decoder)
        }

        func encode(to encoder: Encoder) throws {
            var fields = encoder.container(keyedBy: CodingKeys.self)
            try fields.encode(revision, forKey: .revision)
            try value.encode(to: encoder)
        }
    }

    enum ChangeKind: String, Codable {
        case memory, boundary, diary, file
        case ticket, world
        case mailboxLetter = "mailbox_letter"
        case fileDescription = "file_description"
    }

    struct ChangeKey: Codable, Hashable {
        let kind: ChangeKind
        let id: String
    }

    struct MemberChange: Codable {
        enum Value {
            case memory(Memory)
            case boundary(Boundary)
            case diary(SharedDiary)
            case file(Attachment)
            case fileDescription(FileDescriptionProjection)
            case ticket(Ticket)
            case world(WorldRecord)
            case mailboxLetter(MailboxLetter)

            var id: String {
                switch self {
                case .memory(let value): return value.id
                case .boundary(let value): return value.id
                case .diary(let value): return value.id
                case .file(let value): return value.id
                case .fileDescription(let value): return value.id
                case .ticket(let value): return value.id
                case .world(let value): return value.id
                case .mailboxLetter(let value): return value.id
                }
            }

        }

        let key: ChangeKey
        let sequence: Int64
        let value: Value?
        var id: String { key.id }
        var isDeleted: Bool { value == nil }

        fileprivate enum CodingKeys: String, CodingKey { case kind, id, sequence, op, value }
        private enum Operation: String, Codable { case upsert, delete }

        private struct ResourceState: Decodable {
            let deletedAt: Int64?
            enum CodingKeys: String, CodingKey { case deletedAt = "deleted_at" }
        }

        init(from decoder: Decoder) throws {
            let fields = try decoder.container(keyedBy: CodingKeys.self)
            key = .init(kind: try fields.decode(ChangeKind.self, forKey: .kind), id: try fields.decode(String.self, forKey: .id))
            sequence = try fields.decode(Int64.self, forKey: .sequence)
            guard sequence > 0, !key.id.isEmpty else { throw ChangesError.invalidResponse }
            switch try fields.decode(Operation.self, forKey: .op) {
            case .delete:
                guard !fields.contains(.value) else { throw ChangesError.invalidResponse }
                value = nil
            case .upsert:
                if key.kind == .memory || key.kind == .boundary || key.kind == .diary {
                    guard try fields.decode(ResourceState.self, forKey: .value).deletedAt == nil else {
                        throw ChangesError.invalidResponse
                    }
                }
                let payload: Value
                switch key.kind {
                case .memory: payload = .memory(try fields.decode(Memory.self, forKey: .value))
                case .boundary: payload = .boundary(try fields.decode(Boundary.self, forKey: .value))
                case .diary: payload = .diary(try fields.decode(SharedDiary.self, forKey: .value))
                case .file: payload = .file(try fields.decode(Attachment.self, forKey: .value))
                case .ticket: payload = .ticket(try fields.decode(Ticket.self, forKey: .value))
                case .world: payload = .world(try fields.decode(WorldRecord.self, forKey: .value))
                case .mailboxLetter: payload = .mailboxLetter(try fields.decode(MailboxLetter.self, forKey: .value))
                case .fileDescription: payload = .fileDescription(try fields.decode(FileDescriptionProjection.self, forKey: .value))
                }
                guard payload.id == key.id else { throw ChangesError.invalidResponse }
                value = payload
            }
        }

        func encode(to encoder: Encoder) throws {
            var fields = encoder.container(keyedBy: CodingKeys.self)
            try fields.encode(key.kind, forKey: .kind)
            try fields.encode(key.id, forKey: .id)
            try fields.encode(sequence, forKey: .sequence)
            try fields.encode(isDeleted ? Operation.delete : .upsert, forKey: .op)
            switch value {
            case .memory(let value): try fields.encode(value, forKey: .value)
            case .boundary(let value): try fields.encode(value, forKey: .value)
            case .diary(let value): try fields.encode(value, forKey: .value)
            case .file(let value): try fields.encode(value, forKey: .value)
            case .fileDescription(let value): try fields.encode(value, forKey: .value)
            case .ticket(let value): try fields.encode(value, forKey: .value)
            case .world(let value): try fields.encode(value, forKey: .value)
            case .mailboxLetter(let value): try fields.encode(value, forKey: .value)
            case nil: break
            }
        }
    }

    struct ChangesPage: Decodable {
        let generation: String
        let changes: [MemberChange]
        let next: String
        let hasMore: Bool

        private enum CodingKeys: String, CodingKey { case generation, reset, changes, next; case hasMore = "has_more" }
        private struct Entry: Decodable {
            let change: MemberChange?

            init(from decoder: Decoder) throws {
                let fields = try decoder.container(keyedBy: MemberChange.CodingKeys.self)
                let kind = try fields.decode(String.self, forKey: .kind)
                change = ChangeKind(rawValue: kind) == nil ? nil : try MemberChange(from: decoder)
            }
        }

        init(from decoder: Decoder) throws {
            let fields = try decoder.container(keyedBy: CodingKeys.self)
            generation = try fields.decode(String.self, forKey: .generation)
            next = try fields.decode(String.self, forKey: .next)
            hasMore = try fields.decode(Bool.self, forKey: .hasMore)
            guard try !fields.decode(Bool.self, forKey: .reset), !generation.isEmpty, !next.isEmpty else {
                throw ChangesError.invalidResponse
            }
            changes = try fields.decode([Entry].self, forKey: .changes).compactMap(\.change)
        }
    }

    enum ChangesError: LocalizedError, Equatable {
        case invalidResponse, identityMismatch
        case wrongHomeHost(writerHostID: String)
        case resetRequired(generation: String)

        var errorDescription: String? {
            switch self {
            case .invalidResponse: return "电脑返回的同步信息有误，请稍后重试"
            case .identityMismatch: return "当前连接与配对成员不一致，请重新配对"
            case .wrongHomeHost: return "请连接这位成员配对的家庭电脑"
            case .resetRequired: return "电脑要求重新同步"
            }
        }
    }
}
