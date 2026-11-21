import Foundation
import Combine

@MainActor
final class V2ChatStore: ObservableObject {
    let connection: V2Connection
    let outbox: V2Outbox
    @Published var conversations: [V2.Conversation] = []
    @Published var messages: [String: [V2.Message]] = [:]
    @Published var hasEarlier: [String: Bool] = [:]
    @Published var members: [String: String] = [:]
    @Published var pending: [V2Outbox.Entry] = []
    @Published var failures: [String: String] = [:]
    @Published var error: String?
    @Published var loading = false
    private var client: V2Client?
    private var sending = Set<String>()
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

    init(connection: V2Connection) {
        self.connection = connection
        outbox = V2Outbox(identity: connection.identity.deviceId)
        replyRequests = V2ReplyRequests(deviceID: connection.identity.deviceId)
        pending = outbox.entries
        members[connection.identity.member.id] = connection.identity.member.displayName
    }
    func sender(_ author: V2.Author) -> String {
        if author.kind == .cat { return "团子" }
        if author.memberId == connection.identity.member.id { return "我" }
        return author.memberId.flatMap { members[$0] } ?? "家人"
    }
    func load() async {
        guard !loading else { return }
        loading = true; error = nil
        defer { loading = false }
        do {
            let selected = try await connection.select(); client = selected
            let people = try await selected.members()
            members = Dictionary(uniqueKeysWithValues: people.map { ($0.id, $0.displayName) })
            conversations = try await selected.conversations()
            for conversation in conversations { try await latest(conversation.id, client: selected) }
            for entry in pending { await transmit(entry) }
        } catch { self.error = error.localizedDescription }
    }
    private func latest(_ id: String, client: V2Client) async throws {
        let page = try await client.messages(id)
        messages[id] = page.messages
        hasEarlier[id] = page.hasMoreBefore
    }
    func earlier(_ id: String) async {
        guard let client, let cursor = messages[id]?.first?.cursor else { return }
        do {
            let page = try await client.messages(id, before: cursor)
            let existing = Set((messages[id] ?? []).map(\.id))
            messages[id] = page.messages.filter { !existing.contains($0.id) } + (messages[id] ?? [])
            hasEarlier[id] = page.hasMoreBefore; error = nil
        } catch { self.error = error.localizedDescription }
    }
    func poll(_ id: String) async {
        while !Task.isCancelled {
            do {
                if client == nil { client = try await connection.select() }
                if let client {
                    try await refresh(id, client: client)
                    error = nil
                }
                for entry in pending where entry.conversationID == id && failures[entry.id] == nil { await transmit(entry) }
                try await Task.sleep(for: .seconds(3))
            } catch is CancellationError { return }
            catch {
                self.error = error.localizedDescription
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
            }
        }
    }
    func send(_ text: String, conversation: String) async {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.count <= 4000 else { return }
        let entry = outbox.enqueue(conversation: conversation, text: text)
        pending = outbox.entries
        await transmit(entry)
    }
    func transmit(_ entry: V2Outbox.Entry) async {
        guard !sending.contains(entry.id) else { return }
        sending.insert(entry.id); failures[entry.id] = nil
        defer { sending.remove(entry.id) }
        do {
            if client == nil { client = try await connection.select() }
            guard let client else { throw PairingError.unavailable }
            let result = try await client.send(conversation: entry.conversationID, key: entry.id, text: entry.text)
            outbox.acknowledge(entry.id); pending = outbox.entries
            if let page = try? await client.messages(entry.conversationID, after: messages[entry.conversationID]?.last?.cursor) {
                merge(page.messages, into: entry.conversationID)
            }
            if let turn = result.turn { follow(turn, client: client) }
        } catch { failures[entry.id] = error.localizedDescription }
    }
    private func merge(_ incoming: [V2.Message], into id: String) {
        var current = messages[id] ?? []
        for message in incoming {
            if let index = current.firstIndex(where: { $0.id == message.id }) { current[index] = message }
            else { current.append(message) }
        }
        messages[id] = current
        reconcile(id)
        if let last = current.last, let index = conversations.firstIndex(where: { $0.id == id }) { conversations[index].lastMessage = last }
    }
    private func refresh(_ id: String, client: V2Client) async throws {
        var more = true
        while more && !Task.isCancelled {
            let page = try await client.messages(id, after: messages[id]?.last?.cursor)
            merge(page.messages, into: id)
            more = page.hasMoreAfter && !page.messages.isEmpty
        }
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
            if client == nil { client = try await connection.select() }
            guard let client else { throw PairingError.unavailable }
            let turn = try await client.reply(conversation: id, message: message.id, requestID: requestID)
            replyRequests.acknowledge(message: message.id)
            follow(turn, client: client)
        } catch { replyErrors[id] = error.localizedDescription }
    }
    func failedReplyTarget(_ conversation: String) -> V2.Message? {
        messages[conversation]?.first { $0.id == replyTargets[conversation] }
    }
    func stop(_ conversation: String) async {
        guard var active = activeTurns[conversation], active.stream.terminal == nil, !active.stopping, let client else { return }
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
        if activeTurns[id]?.turn.id == turn.id, streamTasks[id] != nil { return }
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
                    if active.stream.terminal == "superseded" { activeTurns[id] = nil }
                    try? await refresh(id, client: client)
                    reconcile(id)
                    return
                }
            } catch is CancellationError { return }
            catch let failure as V2.APIError {
                guard activeTurns[id]?.turn.id == turn.id else { return }
                try? activeTurns[id]?.stream.apply(.init(id: nil, name: "error", data: #"{"code":"stream_unavailable","retryable":false}"#))
                replyErrors[id] = failure.localizedDescription
                return
            } catch { }
            guard !Task.isCancelled, activeTurns[id]?.turn.id == turn.id else { return }
            activeTurns[id]?.reconnecting = true
            do { try await Task.sleep(for: .seconds(delay)) } catch { return }
            delay = min(delay + 1, 5)
        }
    }
}
