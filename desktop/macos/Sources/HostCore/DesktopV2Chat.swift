import Combine
import Foundation

@MainActor
final class DesktopV2Chat: ObservableObject {
    struct Active {
        let turn: V2.Turn
        var stream = V2TurnStream()
        var reconnecting = false
        var stopping = false
    }

    @Published private(set) var conversations: [V2.Conversation] = []
    @Published private(set) var history: [String: [V2.Message]] = [:]
    @Published private(set) var earlier: [String: Bool] = [:]
    @Published private(set) var pending: [DesktopV2Journal.Pending] = []
    @Published private(set) var active: [String: Active] = [:]
    @Published private(set) var issues: [String: String] = [:]
    @Published private(set) var enrollment: DesktopV2Enrollment.Status?
    @Published private(set) var identity: V2.Me?
    @Published private(set) var yardConnection: DesktopYardConnection?
    @Published private(set) var replying: Set<String> = []
    @Published private(set) var busy = false
    @Published private(set) var error: String?
    @Published private var names: [String: String] = [:]
    @Published var selected = ""
    @Published var drafts: [String: String] = [:]

    private let enrollmentClient: DesktopV2Enrollment
    private var endpoint: DesktopV2Enrollment.Endpoint?
    private var client: V2Client?
    private var journal: DesktopV2Journal?
    private var streamTasks: [String: Task<Void, Never>] = [:]
    private var generation: String?

    init(host: BunHost) { enrollmentClient = DesktopV2Enrollment(host: host) }

    nonisolated static func visible(_ conversations: [V2.Conversation], memberID: String) -> [V2.Conversation] {
        let allowed = conversations.filter {
            $0.participantMemberIds.contains(memberID) && ($0.kind == .group || $0.ownerMemberId == memberID)
        }
        return allowed.filter { $0.kind == .group } + allowed.filter { $0.kind == .direct }
    }

    func authorName(_ author: V2.Author) -> String {
        if author.kind == .cat { return "团子" }
        return author.memberId.flatMap { names[$0] } ?? "成员"
    }

    func isMine(_ message: V2.Message) -> Bool {
        message.author.kind == .member && message.author.memberId == identity?.member.id
    }

    func run() async {
        defer { disconnect() }
        while !Task.isCancelled {
            do {
                if client == nil, !busy {
                    if let enrollment {
                        let latest = try await enrollmentClient.status()
                        try Task.checkCancellation()
                        if !busy && self.enrollment != nil &&
                            (latest.local_members.map(\.id) != enrollment.local_members.map(\.id)
                                || latest.sync_generation != enrollment.sync_generation
                                || latest.household_id != enrollment.household_id) {
                            try await discover()
                        }
                    } else {
                        try await discover()
                    }
                }
                if !busy, let client { try await poll(using: client) }
            } catch is CancellationError {
                return
            } catch V2.APIError.unauthorized {
                disconnect()
                error = DesktopV2Error.unauthorized.localizedDescription
            } catch {
                if !Task.isCancelled { self.error = error.localizedDescription }
            }
            do { try await Task.sleep(for: .seconds(2)) } catch { return }
        }
    }

    private func disconnect() {
        streamTasks.values.forEach { $0.cancel() }
        streamTasks.removeAll()
        active.removeAll()
        client = nil
        endpoint = nil
        enrollment = nil
        identity = nil
        yardConnection = nil
        journal = nil
        conversations.removeAll()
        history.removeAll()
        earlier.removeAll()
        pending.removeAll()
        issues.removeAll()
        replying.removeAll()
        drafts.removeAll()
        names.removeAll()
        generation = nil
    }

    private func discover() async throws {
        let endpoint = try await enrollmentClient.discover()
        try Task.checkCancellation()
        self.endpoint = endpoint
        do {
            if let saved = try await enrollmentClient.saved(endpoint) {
                try await connect(saved, on: endpoint)
            } else {
                enrollment = endpoint.status
                error = endpoint.status.has_members && endpoint.status.local_members.isEmpty
                    ? DesktopV2Error.noLocalMember.localizedDescription : nil
            }
        } catch DesktopV2Error.unauthorized {
            enrollment = endpoint.status
            error = DesktopV2Error.unauthorized.localizedDescription
        }
    }

    func refreshEnrollment() {
        if client == nil && !busy { enrollment = nil }
    }

    func approve(memberID: String? = nil, newName: String? = nil) async {
        guard !busy, var endpoint else { return }
        busy = true
        defer { busy = false }
        do {
            let id: String
            if let memberID {
                id = memberID
            } else if let newName, !endpoint.status.has_members {
                id = try await enrollmentClient.bootstrap(name: newName).id
                endpoint = try await enrollmentClient.discover()
                enrollment = endpoint.status
                self.endpoint = endpoint
            } else { return }
            let connection = try await enrollmentClient.approve(memberID: id, on: endpoint)
            try await connect(connection, on: endpoint)
        } catch {
            self.error = error.localizedDescription
            if let latest = try? await enrollmentClient.discover() {
                self.endpoint = latest
                enrollment = latest.status
            }
        }
    }

    private func connect(_ connection: DesktopV2Enrollment.Connection, on endpoint: DesktopV2Enrollment.Endpoint) async throws {
        let local = try DesktopV2Journal(scope: endpoint.scope, memberID: connection.me.member.id)
        let people = try await connection.client.members()
        let visible = Self.visible(try await connection.client.conversations(), memberID: connection.me.member.id)
        try Task.checkCancellation()
        guard self.endpoint?.scope.key == endpoint.scope.key else { throw CancellationError() }
        names = Dictionary(uniqueKeysWithValues: people.map { ($0.id, $0.displayName) })
        names[connection.me.member.id] = connection.me.member.displayName
        conversations = visible
        if !visible.contains(where: { $0.id == selected }) { selected = visible.first?.id ?? "" }
        journal = local
        pending = local.pending
        identity = connection.me
        client = connection.client
        generation = endpoint.status.sync_generation
        yardConnection = DesktopYardConnection(
            key: "\(endpoint.scope.key).\(connection.me.actor.deviceId).\(endpoint.status.sync_generation)",
            memberID: connection.me.member.id, client: connection.client)
        enrollment = nil
        error = nil
        for conversation in visible where mayControl(conversation) {
            if let turn = local.turns[conversation.id] { follow(turn, client: connection.client) }
        }
    }

    func send(_ conversationID: String) {
        let text = drafts[conversationID, default: ""].trimmingCharacters(in: .whitespacesAndNewlines)
        guard allows(conversationID), !text.isEmpty, text.utf16.count <= 4000, let journal else { return }
        do {
            _ = try journal.enqueue(conversationID: conversationID, text: text)
            pending = journal.pending
            drafts[conversationID] = ""
        } catch { issues[conversationID] = error.localizedDescription }
    }

    func loadEarlier(_ id: String) async {
        guard allows(id), let client, let cursor = history[id]?.first?.cursor else { return }
        do {
            let page = try await client.messages(id, before: cursor)
            guard allows(id), !Task.isCancelled else { return }
            let existing = Set((history[id] ?? []).map(\.id))
            history[id] = page.messages.filter { !existing.contains($0.id) } + (history[id] ?? [])
            earlier[id] = page.hasMoreBefore
        } catch { issues[id] = error.localizedDescription }
    }

    func mayControl(_ conversation: V2.Conversation) -> Bool {
        conversation.publisherHostId == identity?.actor.hostId
    }

    func reply(_ message: V2.Message) async {
        let id = message.conversationId
        guard let client, let journal, allows(id), active[id] == nil, replying.insert(id).inserted else { return }
        defer { replying.remove(id) }
        do {
            let key = try journal.replyKey(for: message.id)
            let turn = try await client.reply(conversation: id, message: message.id, requestID: key)
            guard self.journal === journal, allows(id) else { return }
            try journal.rememberReply(turn, messageID: message.id)
            follow(turn, client: client)
        } catch { issues[id] = error.localizedDescription }
    }

    func stop(_ id: String) async {
        guard allows(id), let client, var current = active[id], !current.stopping,
              current.stream.terminal == nil else { return }
        current.stopping = true
        active[id] = current
        do {
            _ = try await client.cancel(conversation: id, turn: current.turn.id, visibleLength: current.stream.text.utf16.count)
        } catch {
            if active[id]?.turn.id == current.turn.id {
                active[id]?.stopping = false
                issues[id] = error.localizedDescription
            }
        }
    }

    private func allows(_ id: String) -> Bool { conversations.contains(where: { $0.id == id }) }

    private func poll(using client: V2Client) async throws {
        struct Generation: Decodable { let generation: String }
        let current = try await client.json(Generation.self, client.request("GET", "sync-generation")).generation
        if current != generation {
            disconnect()
            return
        }
        guard let identity, let journal else { return }
        let visible = Self.visible(try await client.conversations(), memberID: identity.member.id)
        try Task.checkCancellation()
        conversations = visible
        if !visible.contains(where: { $0.id == selected }) { selected = visible.first?.id ?? "" }
        for conversation in visible {
            let id = conversation.id
            if let entry = journal.pending.first(where: { $0.conversationID == id }) {
                await deliver(entry, using: client, conversation: conversation, journal: journal)
            }
            try await refresh(id, using: client)
            try reconcile(id, journal: journal)
        }
        error = nil
    }

    private func deliver(_ entry: DesktopV2Journal.Pending, using client: V2Client, conversation: V2.Conversation,
                         journal: DesktopV2Journal) async {
        let id = conversation.id
        do {
            let outcome = try await client.deliver(entry)
            try Task.checkCancellation()
            guard self.journal === journal, allows(id) else { return }
            switch outcome {
            case .pending(let receipt):
                try journal.recordReceipt(receipt, entryID: entry.id)
                issues[id] = nil
            case .accepted(let message, let turn):
                guard isMine(message) else { throw DesktopV2Error.wrongIdentity }
                let localTurn = mayControl(conversation) ? turn : nil
                try journal.settle(entryID: entry.id, turn: localTurn)
                issues[id] = nil
                if let localTurn { follow(localTurn, client: client) }
            case .rejected:
                try journal.settle(entryID: entry.id, turn: nil)
                if drafts[id, default: ""].isEmpty { drafts[id] = entry.text }
                issues[id] = DesktopV2Error.receiptRejected.localizedDescription
            }
            pending = journal.pending
        } catch {
            if !Task.isCancelled { issues[id] = error.localizedDescription }
        }
    }

    private func refresh(_ id: String, using client: V2Client) async throws {
        var more = true
        while more {
            let initial = history[id] == nil
            let page = try await client.messages(id, after: history[id]?.last?.cursor)
            try Task.checkCancellation()
            guard allows(id) else { return }
            let existing = Set((history[id] ?? []).map(\.id))
            let additions = page.messages.filter { !existing.contains($0.id) }
            if initial || !additions.isEmpty { history[id, default: []].append(contentsOf: additions) }
            if initial { earlier[id] = page.hasMoreBefore }
            more = page.hasMoreAfter && !additions.isEmpty
        }
    }

    private func reconcile(_ id: String, journal: DesktopV2Journal) throws {
        guard let state = active[id], state.stream.terminal != nil else { return }
        if let code = state.stream.errorCode {
            issues[id] = "团子这次没有接上话（\(code)）"
        } else if state.stream.status == .stopped && state.stream.replyMessageID == nil {
            issues[id] = "已停止回复"
        } else if let replyID = state.stream.replyMessageID, history[id]?.contains(where: { $0.id == replyID }) != true {
            return
        } else {
            issues[id] = nil
        }
        try journal.finish(state.turn)
        active[id] = nil
    }

    private func follow(_ turn: V2.Turn, client: V2Client) {
        let id = turn.conversationId
        if active[id]?.turn.id == turn.id { return }
        streamTasks[id]?.cancel()
        active[id] = Active(turn: turn)
        streamTasks[id] = Task { [weak self] in await self?.consume(turn, client: client) }
    }

    private func consume(_ turn: V2.Turn, client: V2Client) async {
        let id = turn.conversationId
        while !Task.isCancelled, active[id]?.turn.id == turn.id {
            do {
                try await client.stream(path: turn.streamUrl, lastEventID: active[id]?.stream.lastEventID) { [weak self] event in
                    guard !Task.isCancelled, let self, var state = self.active[id], state.turn.id == turn.id else { return true }
                    try state.stream.apply(event)
                    state.reconnecting = false
                    self.active[id] = state
                    return state.stream.terminal != nil
                }
                try Task.checkCancellation()
                if active[id]?.turn.id == turn.id, active[id]?.stream.terminal != nil {
                    streamTasks[id] = nil
                    return
                }
            } catch is CancellationError { return }
            catch V2.APIError.notFound {
                if active[id]?.turn.id == turn.id {
                    do { try journal?.finish(turn) } catch { issues[id] = error.localizedDescription }
                    active[id] = nil
                    streamTasks[id] = nil
                    issues[id] = "本机轮次暂不可用，请查看聊天记录"
                }
                return
            } catch {
                if !Task.isCancelled { issues[id] = error.localizedDescription }
            }
            guard !Task.isCancelled, active[id]?.turn.id == turn.id else { return }
            active[id]?.reconnecting = true
            do { try await Task.sleep(for: .seconds(1)) } catch { return }
        }
    }
}
