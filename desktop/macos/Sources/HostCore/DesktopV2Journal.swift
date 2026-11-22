import CryptoKit
import Foundation

struct DesktopV2Scope {
    let data: URL
    let hostID: String
    let householdID: String
    let fingerprint: String

    var key: String { Self.hash([data.standardizedFileURL.resolvingSymlinksInPath().path, hostID, householdID, fingerprint]) }
    func memberKey(_ id: String) -> String { Self.hash([key, id]) }

    private static func hash(_ values: [String]) -> String {
        let data = Data(values.joined(separator: "\0").utf8)
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

final class DesktopV2Journal {
    struct Pending: Codable, Identifiable {
        let id: String
        let conversationID: String
        let text: String
        var receiptID: String?
    }

    private struct State: Codable {
        var pending: [Pending] = []
        var turns: [String: V2.Turn] = [:]
        var replies: [String: String] = [:]
    }

    private let file: URL
    private var state: State
    var pending: [Pending] { state.pending }
    var turns: [String: V2.Turn] { state.turns }

    init(scope: DesktopV2Scope, memberID: String) throws {
        let folder = scope.data.appendingPathComponent("desktop-chat", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        file = folder.appendingPathComponent(scope.memberKey(memberID) + ".json")
        if FileManager.default.fileExists(atPath: file.path) {
            state = try JSONDecoder().decode(State.self, from: Data(contentsOf: file))
        } else {
            state = State()
        }
    }

    private func update(_ change: (inout State) -> Void) throws {
        var next = state
        change(&next)
        // The enclosing directory is private. Each atomic replacement is complete before sending.
        try JSONEncoder().encode(next).write(to: file, options: .atomic)
        state = next
    }

    func enqueue(conversationID: String, text: String) throws -> Pending {
        let entry = Pending(id: UUID().uuidString, conversationID: conversationID, text: text, receiptID: nil)
        try update { $0.pending.append(entry) }
        return entry
    }

    func recordReceipt(_ receiptID: String, entryID: String) throws {
        guard let index = state.pending.firstIndex(where: { $0.id == entryID }),
              state.pending[index].receiptID != receiptID else { return }
        try update { $0.pending[index].receiptID = receiptID }
    }

    func settle(entryID: String, turn: V2.Turn?) throws {
        try update { next in
            next.pending.removeAll { $0.id == entryID }
            if let turn { next.turns[turn.conversationId] = turn }
        }
    }

    func replyKey(for messageID: String) throws -> String {
        if let existing = state.replies[messageID] { return existing }
        let key = UUID().uuidString
        try update { $0.replies[messageID] = key }
        return key
    }

    func rememberReply(_ turn: V2.Turn, messageID: String) throws {
        try update {
            $0.replies[messageID] = nil
            $0.turns[turn.conversationId] = turn
        }
    }

    func finish(_ turn: V2.Turn) throws {
        guard state.turns[turn.conversationId]?.id == turn.id else { return }
        try update { $0.turns[turn.conversationId] = nil }
    }
}

enum DesktopV2Send {
    case pending(String)
    case accepted(V2.Message, V2.Turn?)
    case rejected

    private struct Response: Decodable {
        let status: String?
        let request_id: String?
        let client_message_id: String?
        let receipt_url: String?
        let message: V2.Message?
        let turn: V2.Turn?
    }

    static func decode(_ data: Data, httpStatus: Int, entry: DesktopV2Journal.Pending) throws -> Self {
        let value = try V2.decoder.decode(Response.self, from: data)
        if value.status != nil {
            guard let id = value.request_id, UUID(uuidString: id) != nil,
                  value.client_message_id == entry.id, entry.receiptID == nil || entry.receiptID == id else {
                throw V2.APIError.invalidRequest
            }
            if httpStatus == 202, value.status == "pending",
               value.receipt_url == "/v2/conversations/\(entry.conversationID)/message-requests/\(id)" {
                return .pending(id)
            }
            if httpStatus == 200, value.status == "rejected" { return .rejected }
        }
        guard httpStatus == 200 || httpStatus == 201, value.status == nil || value.status == "accepted",
              let message = value.message, message.conversationId == entry.conversationID,
              message.clientMessageId == entry.id,
              value.turn == nil || (value.turn?.conversationId == entry.conversationID && value.turn?.triggerMessageId == message.id) else {
            throw V2.APIError.invalidRequest
        }
        return .accepted(message, value.turn)
    }
}

extension V2Client {
    func deliver(_ entry: DesktopV2Journal.Pending) async throws -> DesktopV2Send {
        let target = "conversations/\(entry.conversationID)"
        let request = if let id = entry.receiptID {
            try request("GET", "\(target)/message-requests/\(id)")
        } else {
            try request("POST", "\(target)/messages", body: ["client_message_id": entry.id, "text": entry.text])
        }
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return try DesktopV2Send.decode(data, httpStatus: http.statusCode, entry: entry)
    }
}
