import Foundation

extension V2Client {
    func tickets() async throws -> [V2.Ticket] {
        struct Result: Decodable { let tickets: [V2.Ticket] }
        return try await json(Result.self, request("GET", "tickets", query: [.init(name: "status", value: "all")])).tickets
    }

    func ticketRequest(_ entry: V2WorkJournal.TicketEntry) throws -> URLRequest {
        let action = entry.action
        var request: URLRequest
        switch action {
        case .schedule(let source, let about, let when):
            let fields: [String: Any] = ["conversation_id": source.conversationID, "kind": "schedule", "about": about, "when": when]
            request = try self.request("POST", "tickets", body: source.proof.merging(fields) { _, new in new })
        case .start(let source, let goal):
            let fields: [String: Any] = ["conversation_id": source.conversationID, "kind": "start", "goal": goal]
            request = try self.request("POST", "tickets", body: source.proof.merging(fields) { _, new in new })
        case .reschedule(let id, let when):
            request = try self.request("PATCH", "tickets/\(id)", body: ["when": when])
        case .append(let id, let text):
            request = try self.request("PATCH", "tickets/\(id)", body: ["text": text])
        case .cancel(let id):
            request = try self.request("POST", "tickets/\(id)/cancel")
        }
        request.setValue(entry.id, forHTTPHeaderField: "Idempotency-Key")
        return request
    }

    func mailbox(after: String? = nil) async throws -> V2.MailboxPage {
        var query = [URLQueryItem(name: "limit", value: "100")]
        if let after { query.append(.init(name: "after", value: after)) }
        return try await json(V2.MailboxPage.self, request("GET", "mailbox", query: query))
    }

    func readLetter(_ id: String) async throws -> V2.MailboxLetter {
        struct Result: Decodable { let letter: V2.MailboxLetter }
        return try await json(Result.self, request("POST", "mailbox/\(id)/read")).letter
    }

    // Replaying the same source proof reads its existing grant or delivery receipt.
    func relay(_ source: V2.WorkSource) async throws -> V2.RelayReceipt {
        try await json(V2.RelayReceipt.self, request("POST", "relays", body: source.proof))
    }

    func withdrawRelay(_ source: V2.WorkSource) async throws {
        struct Result: Decodable {
            let source_message_id: String
            let withdrawn: Bool
        }
        let result = try await json(Result.self, request("POST", "relays/sources/\(source.messageID)/withdraw",
                                                         body: ["source_revision": source.revision]))
        guard result.withdrawn, result.source_message_id == source.messageID else { throw URLError(.badServerResponse) }
    }
}
