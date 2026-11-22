import Foundation
import Observation

@MainActor
@Observable
final class V2WorkStore {
    private let connection: V2Connection
    private let changes: V2ChangesStore
    private let journal: V2WorkJournal
    private let scope: V2SyncScope
    private var isActive = true
    @ObservationIgnored var onAgreementSaved: (() -> Void)?

    private(set) var pendingTickets: [V2WorkJournal.TicketEntry]
    private(set) var relays: [String: V2WorkJournal.RelayEntry]
    private(set) var relayBusy: Set<String> = []
    private(set) var reading: Set<String> = []
    private(set) var savingTicket = false
    var loadingTickets: Bool { changes.isSyncing }
    var loadingMailbox: Bool { changes.isSyncing }
    var ticketError: String? { changes.lastError.map(Self.errorText) }
    var mailboxError: String? { changes.lastError.map(Self.errorText) }

    var tickets: [V2.Ticket] {
        guard isActive, changes.scope == scope else { return [] }
        return changes.snapshot.tickets.filter { $0.forMemberID == scope.memberID }
    }

    var letters: [V2.MailboxLetter] {
        guard isActive, changes.scope == scope else { return [] }
        return changes.snapshot.mailboxLetters.filter { $0.forMemberID == scope.memberID }
            .sorted { ($0.createdAt, $0.id) > ($1.createdAt, $1.id) }
    }

    init(connection: V2Connection, changes: V2ChangesStore) {
        self.connection = connection
        self.changes = changes
        let member = connection.identity.member
        scope = V2SyncScope(householdID: member.householdId, homeHostID: member.homeHostId, memberID: member.id)
        journal = V2WorkJournal(scope: scope)
        pendingTickets = journal.pendingTickets
        relays = journal.relays
    }

    var hasUnreadMail: Bool { letters.contains { $0.readAt == nil } }

    func deactivate() { isActive = false }

    func refresh() async {
        guard isActive else { return }
        await changes.refresh()?.value
    }

    func read(_ letter: V2.MailboxLetter) async throws {
        guard isActive, let current = letters.first(where: { $0.id == letter.id }), current.readAt == nil,
              reading.insert(letter.id).inserted else { return }
        defer { reading.remove(letter.id) }
        let client = try await connectedClient()
        let confirmed = try await client.readLetter(letter.id)
        try checkActive()
        guard confirmed.id == letter.id, confirmed.forMemberID == connection.identity.member.id, confirmed.readAt != nil else {
            throw URLError(.badServerResponse)
        }
        changes.resourceWriteDidCommit(in: scope)
        await refresh()
    }

    func submit(_ action: V2.TicketAction) async throws {
        try checkActive()
        guard !savingTicket else { throw CancellationError() }
        savingTicket = true
        defer { savingTicket = false }
        let reminder: (id: String, sequence: Int64)?
        switch action {
        case .reschedule(let id, _), .cancel(let id):
            reminder = (id, changes.snapshot.change(kind: .ticket, id: id)?.sequence ?? 0)
        default:
            reminder = nil
        }
        let entry = try journal.prepare(action)
        pendingTickets = journal.pendingTickets
        do {
            let client = try await connectedClient()
            let receipt = try await client.json(V2.TicketReceipt.self, client.ticketRequest(entry))
            guard UUID(uuidString: receipt.ticketID) != nil else { throw URLError(.badServerResponse) }
            if let reminder {
                guard receipt.ticketID == reminder.id else { throw URLError(.badServerResponse) }
                if isActive { changes.invalidateReminder(reminder.id, in: scope, through: reminder.sequence) }
            }
            try journal.acknowledge(entry)
            pendingTickets = journal.pendingTickets
            try checkActive()
            changes.resourceWriteDidCommit(in: scope)
            await refresh()
            try checkActive()
            if case .schedule = action { onAgreementSaved?() }
        } catch let error as V2.APIError {
            // Explicit admission failures cannot have committed this request.
            if ["invalid_request", "not_found", "not_actionable", "source_unavailable",
                "permission_denied", "idempotency_conflict"].contains(error.code), !entry.acknowledged {
                try journal.remove(entry)
                pendingTickets = journal.pendingTickets
            }
            throw error
        }
    }

    func requestRelay(_ source: V2.WorkSource) async throws {
        try checkActive()
        let entry = relays[source.messageID] ?? .init(source: source)
        guard entry.source == source, entry.intent == .send, relayBusy.insert(entry.id).inserted else { return }
        defer { relayBusy.remove(entry.id) }
        try save(entry)
        let client = try await connectedClient()
        do {
            let receipt = try await client.relay(entry.source)
            var updated = entry
            updated.receipt = receipt
            updated.rejection = nil
            try save(updated)
            changes.resourceWriteDidCommit(in: scope)
        } catch let error as V2.APIError where error.code.hasPrefix("relay_") {
            var updated = entry
            updated.rejection = error.code
            try save(updated)
        }
    }

    func refreshPendingRelays(in conversationID: String) async {
        for entry in relays.values where entry.source.conversationID == conversationID
            && entry.intent == .send && entry.receipt?.state.isPending == true {
            try? await requestRelay(entry.source)
        }
    }

    func withdrawRelay(_ source: V2.WorkSource) async throws {
        try checkActive()
        guard var entry = relays[source.messageID], entry.source == source, entry.intent != .withdrawn,
              relayBusy.insert(entry.id).inserted else { return }
        defer { relayBusy.remove(entry.id) }
        entry.intent = .withdraw
        try save(entry)
        let client = try await connectedClient()
        try await client.withdrawRelay(source)
        entry.intent = .withdrawn
        try save(entry)
        changes.resourceWriteDidCommit(in: scope)
    }

    private func connectedClient() async throws -> V2Client {
        try checkActive()
        let client = try await connection.select()
        try checkActive()
        return client
    }

    private func checkActive() throws {
        guard isActive else { throw CancellationError() }
        try Task.checkCancellation()
    }

    private func save(_ entry: V2WorkJournal.RelayEntry) throws {
        try journal.save(entry)
        relays = journal.relays
    }

    nonisolated static func errorText(_ error: Error) -> String {
        guard let code = (error as? V2.APIError)?.code else {
            if error is URLError || error is PairingError { return "暂时没连上家里的电脑" }
            return "操作还没确认，请稍后重试"
        }
        switch code {
        case "not_publisher": return "这件事的发布宿主暂不可用"
        case "source_unavailable", "relay_source_not_found": return "原话或使用授权已失效"
        case "permission_denied": return "团子现在无权处理这件事"
        case "invalid_request": return "请检查填写的内容和时间"
        case "not_found": return "这条内容已不可用"
        case "not_actionable": return "这件事的状态已变化，请刷新"
        case "idempotency_conflict": return "这次请求与已保存的操作不一致，请刷新"
        case "relay_not_allowed": return "转告被拒绝，原话或相关许可不符"
        case "relay_daily_limit": return "今天的普通转告已用完"
        case "relay_target_unavailable": return "暂时找不到可接收转告的伴侣"
        case "relay_peer_unavailable": return "伴侣的电脑暂不能接收转告"
        default: return error.localizedDescription
        }
    }
}
