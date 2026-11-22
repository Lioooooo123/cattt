import Foundation
import Observation

struct V2SyncScope: Hashable {
    let householdID: String
    let homeHostID: String
    let memberID: String

    init(householdID: String, homeHostID: String, memberID: String) {
        self.householdID = householdID
        self.homeHostID = homeHostID
        self.memberID = memberID
    }

    init?(identity: V2.PairResult) {
        let member = identity.member
        guard !identity.household.id.isEmpty, identity.household.id == member.householdId,
              !member.id.isEmpty, !member.homeHostId.isEmpty,
              !identity.deviceId.isEmpty, !identity.deviceToken.isEmpty else { return nil }
        self.init(householdID: member.householdId, homeHostID: member.homeHostId, memberID: member.id)
    }

    func validate(_ me: V2.Me, deviceID: String) throws {
        guard me.actor.memberId == memberID, me.member.id == memberID, me.actor.deviceId == deviceID,
              me.actor.householdId == householdID, me.member.householdId == householdID, me.household.id == householdID else {
            throw V2.ChangesError.identityMismatch
        }
        guard me.actor.hostId == homeHostID, me.member.homeHostId == homeHostID else {
            throw V2.ChangesError.wrongHomeHost(writerHostID: me.member.homeHostId)
        }
    }

    fileprivate func cacheURL(in directory: URL) throws -> URL {
        let key = try JSONEncoder().encode([householdID, homeHostID, memberID])
        return directory.appending(path: "v2-" + PairFingerprint.digest(key) + ".json")
    }
}

struct V2ChangesSnapshot: Codable {
    fileprivate(set) var generation: String?
    fileprivate(set) var cursor: String?
    private var includesWorld: Bool? = true
    private var rows: [V2.ChangeKey: V2.MemberChange] = [:]
    private var invalidatedReminders: [String: Int64]?

    fileprivate init(generation: String? = nil) {
        self.generation = generation
    }

    fileprivate var cursorIncludingWorld: String? { includesWorld == true ? cursor : nil }

    fileprivate func startingWorldBackfill(generation: String) -> Self {
        guard includesWorld != true else { return self }
        var next = Self(generation: generation)
        if self.generation == generation { next.invalidatedReminders = invalidatedReminders }
        return next
    }

    var world: V2.WorldRecord? {
        values { change in
            guard case .world(let world) = change else { return nil }
            return world
        }.first
    }

    var memories: [V2.Memory] {
        values {
            guard case .memory(let value) = $0 else { return nil }
            return value
        }
    }

    var boundaries: [V2.Boundary] {
        values {
            guard case .boundary(let value) = $0 else { return nil }
            return value
        }
    }

    var diaries: [V2.SharedDiary] {
        values {
            guard case .diary(let value) = $0 else { return nil }
            return value
        }
    }

    var tickets: [V2.Ticket] {
        values {
            guard case .ticket(let value) = $0 else { return nil }
            return value
        }
    }

    var reminderTickets: [V2.Ticket] {
        tickets.filter { invalidatedReminders?[$0.id] == nil }
    }

    fileprivate mutating func invalidateReminder(_ id: String, through sequence: Int64) {
        invalidatedReminders = (invalidatedReminders ?? [:]).merging([id: sequence], uniquingKeysWith: max)
    }

    var mailboxLetters: [V2.MailboxLetter] {
        values {
            guard case .mailboxLetter(let value) = $0 else { return nil }
            return value
        }
    }

    var attachments: [V2.Attachment] {
        values {
            guard case .file(let value) = $0 else { return nil }
            return value
        }
    }

    func attachment(id: String, conversationID: String) -> V2.Attachment? {
        guard case .file(let file) = change(kind: .file, id: id)?.value,
              file.conversationID == conversationID else { return nil }
        return file
    }

    func fileDescription(fileID: String, fileRev: Int) -> V2.FileDescriptionProjection? {
        guard case .file(let file) = change(kind: .file, id: fileID)?.value,
              file.rev == fileRev else { return nil }
        return values { value in
            guard case .fileDescription(let description) = value,
                  description.value.fileID == fileID, description.value.fileRev == fileRev else { return nil }
            return description
        }.first
    }

    // 返回墓碑时 isDeleted 为 true。nil 表示当前空间还没有这个键的投影记录。
    func change(kind: V2.ChangeKind, id: String) -> V2.MemberChange? {
        rows[.init(kind: kind, id: id)]
    }

    private func values<T>(_ extract: (V2.MemberChange.Value) -> T?) -> [T] {
        rows.values.compactMap { change -> (Int64, T)? in
            guard let value = change.value, let result = extract(value) else { return nil }
            return (change.sequence, result)
        }.sorted { $0.0 > $1.0 }.map(\.1)
    }

    fileprivate mutating func apply(_ page: V2.ChangesPage) throws {
        guard cursor == nil || page.generation == generation,
              !page.hasMore || page.next != cursor else { throw V2.ChangesError.invalidResponse }
        for change in page.changes where rows[change.key].map({ change.sequence > $0.sequence }) ?? true {
            rows[change.key] = change
            if change.key.kind == .ticket, let sequence = invalidatedReminders?[change.id], change.sequence > sequence {
                invalidatedReminders?.removeValue(forKey: change.id)
            }
        }
        generation = page.generation
        cursor = page.next
    }
}

/// 只保存远端投影。草稿、写入队列、撤回和这些操作的幂等键各自持久化。
@MainActor
@Observable
final class V2ChangesStore {
    typealias Fetch = @MainActor (String?) async throws -> V2.ChangesPage
    typealias Open = @MainActor () async throws -> Fetch
    private struct Run {
        let id: UUID
        let task: Task<Void, Never>
    }

    private(set) var scope: V2SyncScope?
    private(set) var snapshot = V2ChangesSnapshot()
    private(set) var lastError: Error?
    private(set) var isSyncing = false
    @ObservationIgnored var onReminderSnapshot: (([V2.Ticket]) -> Void)?
    @ObservationIgnored private var foreground = false
    @ObservationIgnored private var refreshAgain = false
    @ObservationIgnored private var run: Run?
    @ObservationIgnored private var open: Open?
    private let directory: URL
    private let write: (Data, URL) throws -> Void

    init(directory: URL = URL.cachesDirectory.appending(path: "V2MemberChanges"),
         write: @escaping (Data, URL) throws -> Void = { try $0.write(to: $1, options: .atomic) }) {
        self.directory = directory
        self.write = write
    }

    func bind(connection: V2Connection?) {
        guard let connection, let scope = V2SyncScope(identity: connection.identity) else {
            bind(scope: nil, open: nil)
            return
        }
        bind(scope: scope) {
            let client = try await connection.select()
            try scope.validate(await client.me(), deviceID: connection.identity.deviceId)
            return { cursor in try await client.changes(cursor: cursor) }
        }
    }

    func bind(scope: V2SyncScope?, open: Open?) {
        cancel()
        self.scope = scope
        self.open = open
        snapshot = V2ChangesSnapshot()
        lastError = nil
        if let scope {
            do {
                let file = try scope.cacheURL(in: directory)
                if FileManager.default.fileExists(atPath: file.path) {
                    snapshot = try JSONDecoder().decode(V2ChangesSnapshot.self, from: Data(contentsOf: file))
                }
            } catch {
                lastError = error
            }
        }
        onReminderSnapshot?(snapshot.reminderTickets)
        refresh()
    }

    /// 已有改期或取消收据时先停止旧时间。下一条更新的事项投影才能再次排入系统。
    func invalidateReminder(_ id: String, in scope: V2SyncScope, through knownSequence: Int64? = nil) {
        let current = snapshot.change(kind: .ticket, id: id)?.sequence ?? 0
        let baseline = knownSequence ?? current
        guard self.scope == scope, current <= baseline else { return }
        var next = snapshot
        next.invalidateReminder(id, through: baseline)
        do {
            try commit(next, in: scope)
        } catch {
            snapshot = next
            onReminderSnapshot?(next.reminderTickets)
            lastError = error
        }
    }

    func setForeground(_ foreground: Bool) {
        self.foreground = foreground
        if foreground { refresh() } else { cancel() }
    }

    /// 写入成功后唤醒同一个空间。调用前捕获发起写入时的 scope。
    func resourceWriteDidCommit(in scope: V2SyncScope) {
        guard self.scope == scope, foreground else { return }
        if run != nil { refreshAgain = true } else { refresh() }
    }

    /// 进入前台、网络重试和主动刷新都以最近一次成功提交的游标起步。
    @discardableResult
    func refresh() -> Task<Void, Never>? {
        if let run { return run.task }
        guard foreground, let scope, let open else { return nil }
        let id = UUID()
        isSyncing = true
        let running = Task { [weak self] in
            guard let self else { return }
            defer {
                if run?.id == id {
                    run = nil
                    isSyncing = false
                }
            }
            guard !Task.isCancelled else { return }
            repeat {
                refreshAgain = false
                do {
                    let fetch = try await open()
                    try Task.checkCancellation()
                    try await pull(scope: scope, fetch: fetch)
                    try Task.checkCancellation()
                    lastError = nil
                } catch {
                    guard !Task.isCancelled else { return }
                    if (error as? V2.APIError)?.code == "unauthorized" ||
                        (error as? V2.ChangesError) == .identityMismatch {
                        snapshot = V2ChangesSnapshot()
                        onReminderSnapshot?([])
                        try? FileManager.default.removeItem(at: scope.cacheURL(in: directory))
                    } else if Self.wrongHomeHost(error) {
                        onReminderSnapshot?([])
                    }
                    lastError = error
                }
            } while refreshAgain
        }
        run = Run(id: id, task: running)
        return running
    }

    func synchronize() async throws {
        await refresh()?.value
        try Task.checkCancellation()
        if let lastError { throw lastError }
    }

    private func pull(scope: V2SyncScope, fetch: Fetch) async throws {
        var didReset = false
        while true {
            let cursor = snapshot.cursorIncludingWorld
            let page: V2.ChangesPage
            do {
                page = try await fetch(cursor)
            } catch V2.ChangesError.resetRequired(let generation) where cursor != nil && !didReset {
                try Task.checkCancellation()
                try commit(V2ChangesSnapshot(generation: generation), in: scope)
                didReset = true
                continue
            }
            try Task.checkCancellation()
            var next = snapshot.startingWorldBackfill(generation: page.generation)
            try next.apply(page)
            try commit(next, in: scope)
            if !page.hasMore { return }
        }
    }

    private func commit(_ next: V2ChangesSnapshot, in scope: V2SyncScope) throws {
        let file = try scope.cacheURL(in: directory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try write(JSONEncoder().encode(next), file)
        snapshot = next
        onReminderSnapshot?(next.reminderTickets)
    }

    private static func wrongHomeHost(_ error: Error) -> Bool {
        if case .wrongHomeHost = error as? V2.ChangesError { return true }
        return false
    }

    private func cancel() {
        run?.task.cancel()
        run = nil
        refreshAgain = false
        isSyncing = false
    }
}
