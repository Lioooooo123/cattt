import Foundation
import CryptoKit

struct APIMailboxLetter: Decodable, Identifiable {
    let id: String
    let seq: Int
    let ticketId: String?
    let text: String
    let createdAt: String
    var readAt: String?
}

extension APIClient {
    func tickets(includeEndedFollowups: Bool = false) async throws -> [APITicket] {
        struct Page: Decodable { let tickets: [APITicket] }
        var req = request("GET", "v1/tickets")
        req.url?.append(queryItems: [URLQueryItem(name: "status", value: "all")])
        return try await json(Page.self, req).tickets.filter { includeEndedFollowups || $0.kind == "errand" || $0.status == "open" }
    }
    func changeTicket(_ id: String, to date: Date) async throws {
        try await mutateTicket(id, field: "when", value: ISO8601DateFormatter().string(from: date))
    }
    func addTicketInput(_ id: String, text: String) async throws {
        try await mutateTicket(id, field: "text", value: text)
    }
    func cancelTicket(_ id: String) async throws {
        try await mutateTicket(id, field: "cancel", value: "")
    }

    @MainActor
    private func mutateTicket(_ id: String, field: String, value: String) async throws {
        struct OK: Decodable {}
        func digest(_ text: String) -> String {
            SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
        }
        // 只保存操作摘要和随机键，同一账号重开页面或进程仍可重试。
        let slot = "maomao.ticket.pending." + digest(config.storageIdentity + "\n" + id + "\n" + field)
        let fingerprint = digest(value)
        let defaults = UserDefaults.standard
        let pending = defaults.dictionary(forKey: slot) as? [String: String]
        let key: String
        if pending?["fingerprint"] == fingerprint, let previous = pending?["key"] {
            key = previous
        } else {
            key = UUID().uuidString
            defaults.set(["fingerprint": fingerprint, "key": key], forKey: slot)
        }
        let path = "v1/tickets/\(id)"
        var req = field == "cancel" ? request("POST", path + "/cancel") : request("PATCH", path, body: [field: value])
        req.setValue(key, forHTTPHeaderField: "Idempotency-Key")
        _ = try await json(OK.self, req)
        if defaults.dictionary(forKey: slot)?["key"] as? String == key {
            defaults.removeObject(forKey: slot)
        }
    }
    struct MailboxPage: Decodable { let letters: [APIMailboxLetter]; let hasMore: Bool }
    func mailbox(after: Int) async throws -> MailboxPage {
        var req = request("GET", "v1/mailbox")
        req.url?.append(queryItems: [URLQueryItem(name: "after", value: String(after))])
        return try await json(MailboxPage.self, req)
    }
    func readLetter(_ id: String) async throws {
        struct OK: Decodable {}
        _ = try await json(OK.self, request("POST", "v1/mailbox/\(id)/read"))
    }
}
