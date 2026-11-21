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

    init(connection: V2Connection) {
        self.connection = connection
        outbox = V2Outbox(identity: connection.identity.deviceId)
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
                    var more = true
                    while more && !Task.isCancelled {
                        let page = try await client.messages(id, after: messages[id]?.last?.cursor)
                        merge(page.messages, into: id)
                        more = page.hasMoreAfter && !page.messages.isEmpty
                    }
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
            if let turn = result.turn { await follow(turn, client: client) }
        } catch { failures[entry.id] = error.localizedDescription }
    }
    private func merge(_ incoming: [V2.Message], into id: String) {
        var current = messages[id] ?? []
        for message in incoming {
            if let index = current.firstIndex(where: { $0.id == message.id }) { current[index] = message }
            else { current.append(message) }
        }
        messages[id] = current
        if let last = current.last, let index = conversations.firstIndex(where: { $0.id == id }) { conversations[index].lastMessage = last }
    }
    @Published var streams: [String: V2TurnStream] = [:]
    private(set) var streamConversations: [String: String] = [:]
    private func follow(_ turn: V2.Turn, client: V2Client) async {
        streamConversations[turn.id] = turn.conversationId
        do {
            try await client.stream(conversation: turn.conversationId, turn: turn.id, lastEventID: streams[turn.id]?.lastEventID) { [weak self] event in
                guard let self else { return }
                var state = self.streams[turn.id] ?? V2TurnStream()
                try state.apply(event)
                self.streams[turn.id] = state
            }
        } catch { self.error = error.localizedDescription }
    }
}
