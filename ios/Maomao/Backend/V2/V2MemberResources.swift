import Foundation

extension V2 {
    struct MessageLocation: Codable, Equatable, Hashable, Identifiable {
        let conversationID: String
        let messageID: String
        var id: String { conversationID + "/" + messageID }
        var path: String { "conversations/\(conversationID)/messages/\(messageID)" }
    }

    struct ResourceSource: Codable, Equatable {
        let memberID: String
        let conversationID: String
        let messageID: String
        let revision: Int
        var location: MessageLocation { .init(conversationID: conversationID, messageID: messageID) }
        enum CodingKeys: String, CodingKey {
            case memberID = "member_id", conversationID = "conversation_id", messageID = "message_id", revision
        }
    }

    struct SourceUsage: Codable, Equatable {
        let conversationID: String
        let messageID: String
        let revision: Int
        let allowed: Bool
        var location: MessageLocation { .init(conversationID: conversationID, messageID: messageID) }
        enum CodingKeys: String, CodingKey {
            case conversationID = "conversation_id", messageID = "message_id", revision, allowed
        }
    }

    protocol MemberResource: Codable, Equatable, Identifiable where ID == String {
        var revision: Int { get }
    }

    struct Memory: MemberResource {
        let id: String
        let revision: Int
        let updatedAt: Int64
        let subjectMemberID: String?
        let predicate: String
        let value: String
        let source: ResourceSource?
        let canEdit: Bool
        enum CodingKeys: String, CodingKey {
            case id, revision, updatedAt = "updated_at", subjectMemberID = "subject_member_id"
            case predicate, value, source, canEdit = "can_edit"
        }
    }

    struct Boundary: MemberResource {
        let id: String
        let revision: Int
        let updatedAt: Int64
        let subjectMemberID: String
        let description: String
        let source: ResourceSource?
        enum CodingKeys: String, CodingKey {
            case id, revision, updatedAt = "updated_at", subjectMemberID = "subject_member_id", description, source
        }
    }

    struct SharedDiary: MemberResource {
        let id: String
        let revision: Int
        let updatedAt: Int64
        let ownerMemberID: String
        let text: String
        let recordedAt: Int64
        let localDay: String
        let timeZone: String
        let catAllowed: Bool
        var catReadable: Bool
        var source: ResourceSource?
        let canEdit: Bool
        enum CodingKeys: String, CodingKey {
            case id, revision, updatedAt = "updated_at", ownerMemberID = "owner_member_id", text
            case recordedAt = "recorded_at", localDay = "local_day", timeZone = "time_zone"
            case catAllowed = "cat_allowed", catReadable = "cat_readable", source, canEdit = "can_edit"
        }
    }

    struct ResourceTombstone: Decodable {
        let id: String
        let revision: Int
        let deletedAt: Int64
        enum CodingKeys: String, CodingKey { case id, revision, deletedAt = "deleted_at" }
    }

    struct MemoryActionReceipt: Codable, Equatable {
        enum Status: String, Codable {
            case queued, applied, rejected
            case waitingForPeer = "waiting_for_peer"
            case waitingForReplication = "waiting_for_replication"

            var isPending: Bool { self != .applied && self != .rejected }
        }

        let requestID: String
        let memoryID: String
        let writerHostID: String
        let receiptURL: String
        let status: Status
        let resultingRevision: Int?
        let errorCode: String?

        enum CodingKeys: String, CodingKey {
            case requestID = "request_id", memoryID = "memory_id", writerHostID = "writer_host_id"
            case receiptURL = "receipt_url", status, resultingRevision = "resulting_revision", errorCode = "error_code"
        }
    }

    enum ResourceRecord<Value: MemberResource>: Decodable {
        case value(Value)
        case deleted(ResourceTombstone)

        init(from decoder: Decoder) throws {
            let keys = try decoder.container(keyedBy: ResourceTombstone.CodingKeys.self)
            if try keys.decodeIfPresent(Int64.self, forKey: .deletedAt) != nil {
                self = .deleted(try ResourceTombstone(from: decoder))
            } else {
                self = .value(try Value(from: decoder))
            }
        }
    }
}

enum V2ResourceChange {
    case memory(V2.ResourceRecord<V2.Memory>)
    case memoryAction(V2.MemoryActionReceipt)
    case boundary(V2.ResourceRecord<V2.Boundary>)
    case diary(V2.ResourceRecord<V2.SharedDiary>)
    case source(V2.SourceUsage)
}

enum V2ResourceAction: Codable, Equatable {
    enum Area: String, Codable { case diary, knowledge }
    case reviseMemory(id: String, revision: Int, value: String)
    case forgetMemory(id: String, revision: Int)
    case addBoundary(source: V2.SourceUsage, description: String)
    case editBoundary(id: String, revision: Int, description: String)
    case removeBoundary(id: String, revision: Int)
    case withdrawSource(V2.SourceUsage)
    case continueLegacyDiary(V2LegacyDiaryMutation)
    case addDiary(text: String, recordedAt: Int64, day: String, timeZone: String, catAllowed: Bool)
    case editDiary(id: String, revision: Int, text: String)
    case allowDiary(id: String, revision: Int, allowed: Bool)
    case withdrawDiary(id: String, revision: Int)

    var area: Area {
        switch self {
        case .addDiary, .editDiary, .allowDiary, .withdrawDiary, .continueLegacyDiary: return .diary
        default: return .knowledge
        }
    }

    var target: String? {
        switch self {
        case .reviseMemory(let id, _, _), .forgetMemory(let id, _): return "memories/" + id
        case .editBoundary(let id, _, _), .removeBoundary(let id, _): return "boundaries/" + id
        case .addBoundary(let source, _), .withdrawSource(let source): return source.location.path
        case .editDiary(let id, _, _), .allowDiary(let id, _, _), .withdrawDiary(let id, _): return "diary/" + id
        case .continueLegacyDiary(let entry): return "diary/legacy/" + entry.clientID
        case .addDiary: return nil
        }
    }

    var baseRevision: Int? {
        switch self {
        case .reviseMemory(_, let rev, _), .forgetMemory(_, let rev), .editBoundary(_, let rev, _),
             .removeBoundary(_, let rev), .editDiary(_, let rev, _), .allowDiary(_, let rev, _),
             .withdrawDiary(_, let rev): return rev
        case .addBoundary(let usage, _), .withdrawSource(let usage): return usage.revision
        case .addDiary, .continueLegacyDiary: return nil
        }
    }

    var memoryID: String? {
        switch self {
        case .reviseMemory(let id, _, _), .forgetMemory(let id, _): return id
        default: return nil
        }
    }

    var sourceLocation: V2.MessageLocation? {
        switch self {
        case .addBoundary(let usage, _), .withdrawSource(let usage): return usage.location
        default: return nil
        }
    }

    var title: String {
        switch self {
        case .reviseMemory: return "更正记忆"
        case .forgetMemory: return "撤回记忆"
        case .addBoundary: return "添加回避"
        case .editBoundary: return "修改回避"
        case .removeBoundary: return "取消回避"
        case .withdrawSource: return "撤回原话用途"
        case .continueLegacyDiary(let entry): return entry.revokeCatAccess ? "接续旧日记的阅读撤回" : "接续旧日记"
        case .addDiary: return "保存日记"
        case .editDiary: return "修改日记"
        case .allowDiary(_, _, let allowed): return allowed ? "允许团子阅读" : "停止团子阅读"
        case .withdrawDiary: return "撤回日记"
        }
    }

    var draftText: String? {
        switch self {
        case .reviseMemory(_, _, let text), .addBoundary(_, let text), .editBoundary(_, _, let text),
             .addDiary(let text, _, _, _, _), .editDiary(_, _, let text): return text
        case .continueLegacyDiary(let entry): return entry.draft?.text
        default: return nil
        }
    }
}

extension V2Client {
    func resourceRequest(_ action: V2ResourceAction, id: UUID) throws -> URLRequest {
        let method: String
        let path: String
        let revision: Int?
        var fields: [String: Any]
        switch action {
        case .reviseMemory(let id, let rev, let value):
            (method, path, revision, fields) = ("PATCH", "memories/\(id)", rev, ["value": value])
        case .forgetMemory(let id, let rev):
            (method, path, revision, fields) = ("DELETE", "memories/\(id)", rev, [:])
        case .addBoundary(let usage, let description):
            let source: [String: Any] = ["conversation_id": usage.conversationID, "message_id": usage.messageID, "revision": usage.revision]
            (method, path, revision, fields) = ("POST", "boundaries", nil, ["description": description, "source": source])
        case .editBoundary(let id, let rev, let description):
            (method, path, revision, fields) = ("PATCH", "boundaries/\(id)", rev, ["description": description])
        case .removeBoundary(let id, let rev):
            (method, path, revision, fields) = ("DELETE", "boundaries/\(id)", rev, [:])
        case .withdrawSource(let usage):
            (method, path, revision, fields) = ("POST", usage.location.path + "/withdraw", usage.revision, [:])
        case .continueLegacyDiary(let entry):
            let encoded = try V2.encoder.encode(entry)
            guard let payload = try JSONSerialization.jsonObject(with: encoded) as? [String: Any] else {
                throw V2.APIError.invalidRequest
            }
            (method, path, revision, fields) = ("PUT", "diary/legacy", nil, payload)
        case .addDiary(let text, let ms, let day, let zone, let allowed):
            (method, path, revision, fields) = ("POST", "diary", nil, [
                "text": text, "recorded_at": ms, "local_day": day, "time_zone": zone, "cat_allowed": allowed
            ])
        case .editDiary(let id, let rev, let text):
            (method, path, revision, fields) = ("PATCH", "diary/\(id)", rev, ["text": text])
        case .allowDiary(let id, let rev, let allowed):
            (method, path, revision, fields) = ("PATCH", "diary/\(id)/cat-allowed", rev, ["cat_allowed": allowed])
        case .withdrawDiary(let id, let rev):
            (method, path, revision, fields) = ("DELETE", "diary/\(id)", rev, [:])
        }
        let key = id.uuidString.lowercased()
        fields["request_id"] = key
        fields["expected_revision"] = revision
        var request = try request(method, path, body: fields)
        request.setValue(key, forHTTPHeaderField: "Idempotency-Key")
        return request
    }

    func mutateResource(_ pending: V2ResourcePending) async throws -> V2ResourceChange {
        if let memoryID = pending.action.memoryID {
            return try await mutateMemory(pending, memoryID: memoryID)
        }
        let request = try resourceRequest(pending.action, id: pending.id)
        switch pending.action {
        case .reviseMemory, .forgetMemory: throw V2.APIError.invalidRequest
        case .addBoundary, .editBoundary, .removeBoundary: return .boundary(try await json(BoundaryEnvelope.self, request).boundary)
        case .withdrawSource: return .source(try await json(SourceEnvelope.self, request).source)
        case .addDiary, .editDiary, .allowDiary, .withdrawDiary, .continueLegacyDiary: return .diary(try await json(DiaryEnvelope.self, request).entry)
        }
    }

    private func mutateMemory(_ pending: V2ResourcePending, memoryID: String) async throws -> V2ResourceChange {
        guard UUID(uuidString: memoryID) != nil else { throw V2.APIError.invalidRequest }
        let key = pending.id.uuidString.lowercased()
        let path = "memories/\(memoryID)/requests/\(key)"
        let request: URLRequest
        if let receipt = pending.memoryReceipt {
            guard receipt.requestID == key, receipt.memoryID == memoryID, receipt.receiptURL == "/v2/" + path,
                  receipt.status.isPending else { throw V2.APIError.invalidRequest }
            request = try self.request("GET", path)
        } else {
            request = try resourceRequest(pending.action, id: pending.id)
        }
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
        let status = (response as? HTTPURLResponse)?.statusCode
        let receipt = try? V2.decoder.decode(MemoryActionEnvelope.self, from: data).action
        if status == 200, receipt == nil, pending.memoryReceipt == nil {
            return .memory(try V2.decoder.decode(MemoryEnvelope.self, from: data).memory)
        }
        guard let receipt, receipt.requestID == key, receipt.memoryID == memoryID,
              receipt.receiptURL == "/v2/" + path, !receipt.writerHostID.isEmpty,
              pending.memoryReceipt.map({ $0.writerHostID == receipt.writerHostID }) ?? true,
              status == (receipt.status.isPending ? 202 : 200) else {
            throw URLError(.badServerResponse)
        }
        switch receipt.status {
        case .applied:
            guard let base = pending.action.baseRevision, base < Int.max, receipt.resultingRevision == base + 1,
                  receipt.errorCode == nil else { throw URLError(.badServerResponse) }
        case .rejected:
            guard let code = receipt.errorCode, !code.isEmpty, receipt.resultingRevision == nil else {
                throw URLError(.badServerResponse)
            }
        default:
            guard receipt.resultingRevision == nil, receipt.errorCode == nil else { throw URLError(.badServerResponse) }
        }
        return .memoryAction(receipt)
    }

    func memoryResources() async throws -> [V2.Memory] {
        struct Envelope: Decodable { let memories: [V2.Memory] }
        return try await json(Envelope.self, request("GET", "memories")).memories
    }

    func boundaryResources() async throws -> [V2.Boundary] {
        struct Envelope: Decodable { let boundaries: [V2.Boundary] }
        return try await json(Envelope.self, request("GET", "boundaries")).boundaries
    }

    func diaryResources() async throws -> [V2.SharedDiary] {
        struct Envelope: Decodable { let entries: [V2.SharedDiary] }
        return try await json(Envelope.self, request("GET", "diary")).entries
    }

    func sourceUsage(_ location: V2.MessageLocation) async throws -> V2.SourceUsage {
        try await json(SourceEnvelope.self, request("GET", location.path + "/usage")).source
    }

    private struct MemoryEnvelope: Decodable { let memory: V2.ResourceRecord<V2.Memory> }
    private struct MemoryActionEnvelope: Decodable { let action: V2.MemoryActionReceipt }
    private struct BoundaryEnvelope: Decodable { let boundary: V2.ResourceRecord<V2.Boundary> }
    private struct DiaryEnvelope: Decodable { let entry: V2.ResourceRecord<V2.SharedDiary> }
    private struct SourceEnvelope: Decodable { let source: V2.SourceUsage }
}
