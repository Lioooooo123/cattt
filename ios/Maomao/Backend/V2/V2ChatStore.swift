import Foundation
import Combine

@MainActor
final class V2ChatStore: ObservableObject {
    let connection: V2Connection
    let outbox: V2Outbox
    let changes: V2ChangesStore
    let resources: V2ResourceStore
    let catDiary: V2CatDiaryStore
    let work: V2WorkStore
    @Published var conversations: [V2.Conversation] = []
    @Published var messages: [String: [V2.Message]] = [:]
    @Published var hasEarlier: [String: Bool] = [:]
    @Published var members: [String: String] = [:]
    @Published var pending: [V2Outbox.Entry] = []
    @Published var failures: [String: String] = [:]
    @Published var error: String?
    @Published var loading = false
    @Published var notificationConversationID: String?
    @Published var notificationMessageID: String?
    private let selectClient: () async throws -> V2Client
    private var client: V2Client?
    private var isActive = true
    @Published private(set) var sending = Set<String>()
    private var finishedTurns = Set<String>()
    let replyRequests: V2ReplyRequests
    struct ActiveTurn {
        let turn: V2.Turn
        var stream = V2TurnStream()
        var reconnecting = false
        var stopping = false
        var phase: V2.Turn.Status { stream.status ?? turn.status }
    }
    @Published var activeTurns: [String: ActiveTurn] = [:]
    @Published var replyErrors: [String: String] = [:]
    @Published var replying = Set<String>()
    private var replyTargets: [String: String] = [:]
    private var streamTasks: [String: Task<Void, Never>] = [:]

    convenience init(connection: V2Connection) {
        self.init(connection: connection, outbox: V2Outbox(identity: connection.identity), selectClient: connection.select)
    }

    init(connection: V2Connection, outbox: V2Outbox, selectClient: @escaping () async throws -> V2Client) {
        self.connection = connection
        self.outbox = outbox
        let changes = V2ChangesStore()
        changes.bind(connection: connection)
        self.changes = changes
        let catDiary = V2CatDiaryStore(selectClient: selectClient)
        self.catDiary = catDiary
        resources = V2ResourceStore(identity: connection.identity, changes: changes, selectClient: selectClient,
                                    catDiary: catDiary)
        work = V2WorkStore(connection: connection, changes: changes)
        self.selectClient = selectClient
        replyRequests = V2ReplyRequests(deviceID: connection.identity.deviceId)
        pending = outbox.entries
        members[connection.identity.member.id] = connection.identity.member.displayName
    }

    func deactivate() {
        isActive = false
        resources.deactivate()
        catDiary.deactivate()
        work.deactivate()
        changes.setForeground(false)
        changes.bind(connection: nil)
        client = nil
        for task in streamTasks.values { task.cancel() }
        streamTasks.removeAll()
    }

    private func connectedClient() async throws -> V2Client {
        try checkActive()
        if let client { return client }
        let selected = try await selectClient()
        try checkActive()
        client = selected
        return selected
    }

    private func checkActive() throws {
        guard isActive else { throw CancellationError() }
        try Task.checkCancellation()
    }

    func sender(_ author: V2.Author) -> String {
        if author.kind == .cat { return "团子" }
        if author.memberId == connection.identity.member.id { return "我" }
        return author.memberId.flatMap { members[$0] } ?? "家人"
    }
    func load() async {
        guard isActive, !loading else { return }
        loading = true
        error = nil
        defer { loading = false }
        do {
            let selected = try await connectedClient()
            let people = try await selected.members()
            let memberID = connection.identity.member.id
            let listed = try await selected.conversations().filter {
                $0.participantMemberIds.contains(memberID) && ($0.kind == .group || $0.ownerMemberId == memberID)
            }
            try checkActive()
            members = Dictionary(uniqueKeysWithValues: people.map { ($0.id, $0.displayName) })
            conversations = listed
            for conversation in listed { await syncConversation(conversation.id) }
        } catch is CancellationError { }
        catch {
            guard isActive, !Task.isCancelled else { return }
            client = nil
            self.error = error.localizedDescription
        }
    }

    func earlier(_ id: String) async {
        guard let cursor = messages[id]?.first?.cursor else { return }
        do {
            let client = try await connectedClient()
            let page = try await client.messages(id, before: cursor)
            try checkActive()
            setHistory(page.messages + (messages[id] ?? []), conversation: id)
            hasEarlier[id] = page.hasMoreBefore
            error = nil
        } catch is CancellationError { }
        catch { if isActive, !Task.isCancelled { self.error = error.localizedDescription } }
    }

    func poll(_ id: String) async {
        while isActive && !Task.isCancelled {
            await syncConversation(id)
            do { try await Task.sleep(for: .seconds(3)) } catch { return }
        }
    }

    func syncConversation(_ id: String) async {
        do {
            let selected = try await connectedClient()
            try await refresh(id, client: selected)
            error = outbox.storageError == nil ? nil : "暂时无法读取本机待发送消息"
        } catch is CancellationError { return }
        catch {
            guard isActive, !Task.isCancelled else { return }
            client = nil
            self.error = error.localizedDescription
        }

        for entry in pending where entry.conversationID == id && entry.rejection == nil {
            await transmit(entry)
        }
    }

    @discardableResult func send(_ text: String, conversation: String) async -> Bool {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isActive, !text.isEmpty, text.utf16.count <= 4000 else { return false }
        do {
            let entry = try outbox.enqueue(conversation: conversation, text: text)
            pending = outbox.entries
            await transmit(entry)
            return true
        } catch {
            self.error = "消息未能保存到这部手机，请重试"
            return false
        }
    }

    func retry(_ entry: V2Outbox.Entry) async {
        guard isActive, let current = pending.first(where: { $0.id == entry.id }) else { return }
        if current.wasRejected {
            // The host records this key as terminal. A new send requires an explicit action.
            do {
                let replacement = try outbox.enqueue(conversation: current.conversationID, text: current.text, replacing: current.id)
                failures[current.id] = nil
                pending = outbox.entries
                await transmit(replacement)
            } catch { failures[current.id] = "消息未能保存到这部手机，请重试" }
        } else {
            await transmit(current)
        }
    }

    func transmit(_ entry: V2Outbox.Entry) async {
        guard isActive, !Task.isCancelled, !sending.contains(entry.id),
              var current = pending.first(where: { $0.id == entry.id }), current.rejection == nil else { return }
        if current.accepted != nil {
            if let client = try? await connectedClient() { followAccepted(current, client: client) }
            return
        }
        sending.insert(entry.id)
        defer { sending.remove(entry.id) }
        do {
            let client = try await connectedClient()
            let result: V2.SendResult
            if let receipt = current.receipt {
                result = try await client.querySend(conversation: current.conversationID, key: current.id,
                                                    receipt: receipt, homeHostID: connection.identity.member.homeHostId)
            } else {
                if current.submissionStarted == false {
                    current.submissionStarted = true
                    try outbox.update(current)
                    pending = outbox.entries
                }
                result = try await client.send(conversation: current.conversationID, key: current.id, text: current.text)
            }
            // A successful response remains valuable even if the conversation view closed.
            guard isActive else { return }
            switch result {
            case .pending(let receipt):
                current.receipt = receipt
            case .accepted(let sent):
                guard matches(sent.message, entry: current),
                      sent.turn == nil || (sent.turn?.conversationId == current.conversationID &&
                                          sent.turn?.triggerMessageId == sent.message.id) else {
                    throw V2.APIError.invalidRequest
                }
                current.accepted = sent
            case .rejected(let code):
                current.rejection = code
            }
            try outbox.update(current)
            pending = outbox.entries
            failures[entry.id] = nil
            if current.accepted != nil { followAccepted(current, client: client) }
        } catch is CancellationError { }
        catch {
            guard isActive, !Task.isCancelled else { return }
            if let apiError = error as? V2.APIError, apiError == .invalidRequest || apiError == .idempotencyConflict {
                current.rejection = apiError == .idempotencyConflict ? "idempotency_conflict" : "invalid_request"
                do {
                    try outbox.update(current)
                    pending = outbox.entries
                } catch { failures[entry.id] = "暂时无法保存发送状态，请重试" }
            } else {
                if error is URLError { client = nil }
                failures[entry.id] = error.localizedDescription
            }
        }
    }

    private func matches(_ message: V2.Message, entry: V2Outbox.Entry) -> Bool {
        message.conversationId == entry.conversationID && message.author.kind == .member &&
        message.author.memberId == connection.identity.member.id && message.clientMessageId == entry.id
    }

    func visibleOutbox(_ id: String) -> [V2Outbox.Entry] {
        let history = messages[id] ?? []
        return pending.filter { entry in
            guard entry.conversationID == id else { return false }
            if let accepted = entry.accepted { return !history.contains { $0.id == accepted.message.id } }
            // Replicated history can reach the phone before its receipt query returns.
            return !history.contains { matches($0, entry: entry) }
        }
    }

    private func followAccepted(_ entry: V2Outbox.Entry, client: V2Client) {
        let id = entry.conversationID
        if let turn = entry.accepted?.turn,
           !localTurnSettled(turn, conversation: id),
           // A later send in the same conversation owns the visible local stream.
           !hasLaterLocalTurn(than: entry) {
            follow(turn, client: client)
        }
        retireAccepted(id)
    }

    private func hasLaterLocalTurn(than entry: V2Outbox.Entry) -> Bool {
        guard let index = pending.firstIndex(where: { $0.id == entry.id }) else { return false }
        return pending.dropFirst(index + 1).contains { $0.conversationID == entry.conversationID && $0.accepted?.turn != nil }
    }

    private func localTurnSettled(_ turn: V2.Turn, conversation: String) -> Bool {
        finishedTurns.contains(turn.id) || hasPersistedReply(ActiveTurn(turn: turn), conversation: conversation)
    }

    private func retireAccepted(_ id: String) {
        let historyIDs = Set((messages[id] ?? []).map(\.id))
        for entry in pending where entry.conversationID == id {
            guard let accepted = entry.accepted, historyIDs.contains(accepted.message.id) else { continue }
            if let turn = accepted.turn, !localTurnSettled(turn, conversation: id), !hasLaterLocalTurn(than: entry) { continue }
            do {
                try outbox.acknowledge(entry.id)
                pending = outbox.entries
                finishedTurns.remove(accepted.turn?.id ?? "")
            } catch {
                // Keep the durable entry. The next history refresh can retire it.
            }
        }
    }

    private func setHistory(_ incoming: [V2.Message], conversation id: String) {
        var seen = Set<String>()
        let history = incoming.filter { seen.insert($0.id).inserted }
        messages[id] = history
        retireAccepted(id)
        reconcile(id)
        if let last = history.last, let index = conversations.firstIndex(where: { $0.id == id }) {
            conversations[index].lastMessage = last
        }
    }

    private func refresh(_ id: String, client: V2Client) async throws {
        // Only history pages advance the cursor. An accepted receipt can arrive
        // before earlier messages and must never skip any of them.
        if var cursor = messages[id]?.last?.cursor {
            while true {
                let page = try await client.messages(id, after: cursor)
                try checkActive()
                setHistory((messages[id] ?? []) + page.messages, conversation: id)
                guard page.hasMoreAfter, let next = page.messages.last?.cursor, next != cursor else { break }
                cursor = next
            }
        }
        // Re-read the tail to pick up replicated messages inserted behind the
        // current cursor, including a remote reply.
        let page = try await client.messages(id)
        try checkActive()
        let current = messages[id] ?? []
        let incomingIDs = Set(page.messages.map(\.id))
        if let anchor = current.firstIndex(where: { incomingIDs.contains($0.id) }) {
            setHistory(Array(current[..<anchor]) + page.messages, conversation: id)
        } else {
            setHistory(current + page.messages, conversation: id)
        }
        if current.isEmpty { hasEarlier[id] = page.hasMoreBefore }
    }

    private func reconcile(_ conversation: String) {
        guard let active = activeTurns[conversation], active.stream.terminal == "done" else { return }
        if hasPersistedReply(active, conversation: conversation) || (active.stream.replyMessageID == nil && active.phase != .stopped) {
            activeTurns[conversation] = nil
        }
    }
    func hasPersistedReply(_ active: ActiveTurn, conversation: String) -> Bool {
        (messages[conversation] ?? []).contains {
            $0.author.kind == .cat && ($0.turnId == active.turn.id || $0.id == active.stream.replyMessageID)
        }
    }
    func latestMember(_ conversation: String) -> V2.Message? {
        messages[conversation]?.last { $0.author.kind == .member }
    }
    func canReply(_ message: V2.Message) -> Bool {
        let id = message.conversationId
        guard message.author.kind == .member, !replying.contains(id) else { return false }
        return activeTurns[id]?.stream.terminal != nil || activeTurns[id] == nil
    }
    func reply(to message: V2.Message) async {
        let id = message.conversationId
        guard !replying.contains(id) else { return }
        replying.insert(id); replyErrors[id] = nil
        replyTargets[id] = message.id
        let requestID = replyRequests.requestID(message: message.id)
        defer { replying.remove(id) }
        do {
            let client = try await connectedClient()
            let turn = try await client.reply(conversation: id, message: message.id, requestID: requestID)
            try checkActive()
            replyRequests.acknowledge(message: message.id)
            follow(turn, client: client)
        } catch is CancellationError { }
        catch { if isActive, !Task.isCancelled { replyErrors[id] = error.localizedDescription } }
    }
    func failedReplyTarget(_ conversation: String) -> V2.Message? {
        messages[conversation]?.first { $0.id == replyTargets[conversation] }
    }
    func stop(_ conversation: String) async {
        guard isActive, var active = activeTurns[conversation], active.stream.terminal == nil, !active.stopping, let client else { return }
        active.stopping = true; activeTurns[conversation] = active
        do {
            _ = try await client.cancel(conversation: conversation, turn: active.turn.id, visibleLength: active.stream.text.utf16.count)
        } catch {
            if activeTurns[conversation]?.turn.id == active.turn.id { activeTurns[conversation]?.stopping = false }
            replyErrors[conversation] = error.localizedDescription
        }
    }
    private func follow(_ turn: V2.Turn, client: V2Client) {
        let id = turn.conversationId
        if activeTurns[id]?.turn.id == turn.id,
           streamTasks[id] != nil || activeTurns[id]?.stream.terminal != nil { return }
        streamTasks[id]?.cancel()
        activeTurns[id] = ActiveTurn(turn: turn)
        replyErrors[id] = nil
        streamTasks[id] = Task { [weak self] in
            await self?.consume(turn, client: client)
        }
    }
    private func consume(_ turn: V2.Turn, client: V2Client) async {
        let id = turn.conversationId
        defer { if activeTurns[id]?.turn.id == turn.id || activeTurns[id] == nil { streamTasks[id] = nil } }
        var delay = 1
        while !Task.isCancelled, activeTurns[id]?.turn.id == turn.id {
            do {
                try await client.stream(path: turn.streamUrl, lastEventID: activeTurns[id]?.stream.lastEventID) { [weak self] event in
                    guard let self, var active = self.activeTurns[id], active.turn.id == turn.id else { return true }
                    try active.stream.apply(event)
                    active.reconnecting = false
                    self.activeTurns[id] = active
                    return active.stream.terminal != nil
                }
                guard !Task.isCancelled, let active = activeTurns[id], active.turn.id == turn.id else { return }
                if active.stream.terminal != nil {
                    if pending.contains(where: { $0.accepted?.turn?.id == turn.id }) { finishedTurns.insert(turn.id) }
                    if active.stream.terminal == "superseded" { activeTurns[id] = nil }
                    try? await refresh(id, client: client)
                    retireAccepted(id)
                    reconcile(id)
                    return
                }
            } catch is CancellationError { return }
            catch let failure as V2.APIError {
                guard activeTurns[id]?.turn.id == turn.id else { return }
                try? activeTurns[id]?.stream.apply(.init(id: nil, name: "error", data: #"{"code":"stream_unavailable","retryable":false}"#))
                replyErrors[id] = failure.localizedDescription
                if pending.contains(where: { $0.accepted?.turn?.id == turn.id }) { finishedTurns.insert(turn.id) }
                retireAccepted(id)
                return
            } catch { }
            guard !Task.isCancelled, activeTurns[id]?.turn.id == turn.id else { return }
            activeTurns[id]?.reconnecting = true
            do { try await Task.sleep(for: .seconds(delay)) } catch { return }
            delay = min(delay + 1, 5)
        }
    }
}
