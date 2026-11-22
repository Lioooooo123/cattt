import Combine
import Foundation

struct V2ResourcePending: Codable, Identifiable, Equatable {
    enum Problem: String, Codable {
        case uncertain, conflict, waitingForHome, waitingForPeer, rejected

        var message: String {
            switch self {
            case .uncertain: return "电脑尚未确认结果，原请求已保留。"
            case .conflict: return "内容已更新，请查看最新版本后重新确认。"
            case .waitingForHome: return "等待这位成员的家用电脑。"
            case .waitingForPeer: return "等待原记录所在电脑确认处理结果。"
            case .rejected: return "电脑未接受这次操作。"
            }
        }

        var canReplay: Bool { self == .uncertain || self == .waitingForHome || self == .waitingForPeer }
    }

    let id: UUID
    let action: V2ResourceAction
    var problem: Problem?
    var errorCode: String?
    var memoryReceipt: V2.MemoryActionReceipt?
    var legacyGrantReview: Bool?

    var explanation: String {
        if errorCode == "source_unavailable" { return "这条原话的用途已停用，电脑未应用这次操作。" }
        if errorCode == "unauthorized" { return "配对已失效，暂时无法确认电脑上的处理结果。" }
        if errorCode == "legacy_grant_review" { return "请打开接续后的日记，重新选择是否允许团子阅读。" }
        if errorCode == "not_found", case .continueLegacyDiary = action {
            return "电脑无法确认这条旧日记的来源，手机上的旧档案已保留。"
        }
        if errorCode == "not_found" { return "这条记录已撤回或当前成员已无法修改。" }
        if problem == .waitingForPeer {
            switch memoryReceipt?.status {
            case .queued: return "家用电脑已保存此操作，等待原记录所在电脑处理。"
            case .waitingForReplication: return "正在同步原记录所在电脑的处理结果。"
            default: break
            }
        }
        return problem?.message ?? "已保存在手机，尚未收到电脑确认。"
    }
}

struct V2ResourceArchive: Codable {
    var sources: [String: V2.SourceUsage] = [:]
    var names: [String: String] = [:]
    var pending: [V2ResourcePending] = []
    var stagedLegacyDiaryFile: String?
}

@MainActor
final class V2ResourceStore: ObservableObject {
    let memberID: String
    let changes: V2ChangesStore
    private let scope: V2SyncScope?
    private let ownName: String
    private let file: V2ScopedFile
    private let selectClient: () async throws -> V2Client
    private let send: (V2ResourcePending) async throws -> V2ResourceChange
    private let catDiary: V2CatDiaryStore?
    private var active = true
    private var cannotLoad = false
    private var resumingLegacyDiary = false

    @Published private var archive = V2ResourceArchive()
    @Published private(set) var busy = false
    @Published private(set) var transmitting: UUID?
    @Published private(set) var nameError: String?
    @Published private(set) var sourceErrors: [String: String] = [:]
    @Published private(set) var storageError: String?
    @Published private(set) var inputError: String?

    init(identity: V2.PairResult, changes: V2ChangesStore, directory: URL? = nil, selectClient: @escaping () async throws -> V2Client,
         catDiary: V2CatDiaryStore? = nil, send: ((V2ResourcePending) async throws -> V2ResourceChange)? = nil) {
        self.changes = changes
        self.catDiary = catDiary
        scope = V2SyncScope(identity: identity)
        memberID = identity.member.id
        ownName = identity.member.displayName
        self.selectClient = selectClient
        self.send = send ?? { try await selectClient().mutateResource($0) }
        file = V2ScopedFile(identity: identity, folder: "v2-member-resources", directory: directory)
        do { archive = try file.load(V2ResourceArchive.self) ?? V2ResourceArchive() }
        catch {
            cannotLoad = true
            storageError = "无法读取手机上的待提交记录，原文件已保留。"
        }
    }

    func deactivate() { active = false }

    func resumeLegacyDiary(from paired: PairedHost?, root: URL = .applicationSupportDirectory,
                           readBinding: (() async throws -> String?)? = nil) async {
        guard active, !cannotLoad, !resumingLegacyDiary else { return }
        resumingLegacyDiary = true
        defer { resumingLegacyDiary = false }

        if let paired, UUID(uuidString: paired.accountID) != nil {
            let old = DiaryStorage.legacy(identity: paired.storageIdentity, root: root)
            if archive.stagedLegacyDiaryFile != old.url.lastPathComponent,
               FileManager.default.fileExists(atPath: old.url.path) {
                let accountID: String?
                if let readBinding { accountID = try? await readBinding() }
                else { accountID = try? await selectClient().legacyDiaryAccount() }
                if active, !Task.isCancelled, accountID == paired.accountID {
                    do {
                        if let legacy = try old.load() {
                            var next = archive
                            let requests = legacy.entries.compactMap { V2LegacyDiaryMutation.pending($0, accountID: paired.accountID) }
                            let queued = Set(next.pending.map(\.id))
                            next.pending += requests.filter { !queued.contains($0.id) }
                            next.stagedLegacyDiaryFile = old.url.lastPathComponent
                            try persist(next)
                        }
                    } catch {
                        storageError = "无法接续手机上的旧日记，原档案已保留。"
                    }
                }
            }
        }

        for item in archive.pending where active && !busy && !Task.isCancelled && item.problem?.canReplay != false {
            guard case .continueLegacyDiary = item.action else { continue }
            await transmit(item.id)
            // A network failure leaves the remaining requests available for the next pass.
            if archive.pending.first(where: { $0.id == item.id })?.problem?.canReplay == true { break }
        }
    }

    func name(_ id: String) -> String {
        archive.names[id] ?? (id == memberID ? ownName : "家人")
    }

    var pendingRequests: [V2ResourcePending] { archive.pending }
    var sources: [String: V2.SourceUsage] { archive.sources }
    var diary: [V2.SharedDiary] { projection?.diaries ?? [] }
    var memories: [V2.Memory] { projection?.memories ?? [] }
    var boundaries: [V2.Boundary] { projection?.boundaries ?? [] }
    var isSyncing: Bool { changes.isSyncing }
    var readError: String? { changes.lastError.map(errorMessage) ?? nameError }

    private var projection: V2ChangesSnapshot? {
        guard let scope, changes.scope == scope else { return nil }
        return changes.snapshot
    }

    func canEdit(_ diary: V2.SharedDiary) -> Bool { diary.ownerMemberID == memberID && diary.canEdit }

    func pending(in area: V2ResourceAction.Area) -> [V2ResourcePending] {
        archive.pending.filter { $0.action.area == area }.map(displayed)
    }

    func pending(for location: V2.MessageLocation) -> [V2ResourcePending] {
        archive.pending.filter { $0.action.sourceLocation == location }
    }

    @discardableResult
    func enqueue(_ action: V2ResourceAction, replacing id: UUID? = nil) -> V2ResourcePending? {
        guard active, !busy else { return nil }
        inputError = nil
        let previous = archive.pending.first { $0.id == id }.map(displayed)
        if let id {
            guard let previous, previous.id == id, previous.problem?.canReplay == false,
                  previous.action.target == action.target, previous.action.area == action.area else { return nil }
            if previous.problem == .conflict && previous.action.baseRevision == action.baseRevision {
                inputError = "请先读取电脑上的最新版本。"
                return nil
            }
        }
        guard eligible(action) else {
            inputError = "当前版本无法应用，请先刷新并核对记录。"
            return nil
        }
        if let target = action.target, archive.pending.contains(where: { $0.id != id && $0.action.target == target }) {
            inputError = "这条记录还有待处理的操作。"
            return nil
        }
        let item = V2ResourcePending(id: UUID(), action: action)
        var next = archive
        next.pending.removeAll { $0.id == id }
        next.pending.append(item)
        do { try persist(next); return item }
        catch { return nil }
    }

    func submit(_ action: V2ResourceAction, replacing id: UUID? = nil) -> Bool {
        guard let item = enqueue(action, replacing: id) else { return false }
        Task { await transmit(item.id) }
        return true
    }

    func dismissFailed(_ item: V2ResourcePending) {
        guard active, !busy, item.problem?.canReplay == false, archive.pending.contains(where: { $0.id == item.id }) else { return }
        var next = archive
        next.pending.removeAll { $0.id == item.id }
        try? persist(next)
    }

    func transmit(_ id: UUID) async {
        guard active, !busy, let item = archive.pending.first(where: { $0.id == id }),
              displayed(item).problem?.canReplay != false else { return }
        busy = true
        transmitting = id
        defer { busy = false; transmitting = nil }
        do {
            let change = try await send(item)
            guard active else { return }
            var next = archive
            if case .memoryAction(let receipt) = change, receipt.status != .applied,
               let index = next.pending.firstIndex(where: { $0.id == id }) {
                next.pending[index].memoryReceipt = receipt
                next.pending[index].problem = receipt.status.isPending ? .waitingForPeer
                    : (receipt.errorCode == "revision_conflict" ? .conflict : .rejected)
                next.pending[index].errorCode = receipt.errorCode
                try persist(next)
                if !receipt.status.isPending, let scope { changes.resourceWriteDidCommit(in: scope) }
                return
            }
            if case .source(let usage) = change {
                next.sources[usage.location.id] = usage
            }
            invalidateCatDiary(after: item.action)
            if let scope { changes.resourceWriteDidCommit(in: scope) }
            if item.legacyGrantReview == true, case .diary(.value(let diary)) = change, !diary.catAllowed,
               let index = next.pending.firstIndex(where: { $0.id == id }) {
                next.pending[index].problem = .conflict
                next.pending[index].errorCode = "legacy_grant_review"
            } else {
                next.pending.removeAll { $0.id == id }
            }
            try persist(next)
        } catch {
            guard active else { return }
            var next = archive
            guard let index = next.pending.firstIndex(where: { $0.id == id }) else { return }
            let code = (error as? V2.APIError)?.code
            invalidateCatDiary(after: item.action)
            next.pending[index].problem = Self.problem(for: code)
            next.pending[index].errorCode = code
            if let scope, ["unauthorized", "revision_conflict", "not_found", "source_unavailable"].contains(code ?? "") {
                changes.resourceWriteDidCommit(in: scope)
            }
            try? persist(next)
        }
    }

    private func invalidateCatDiary(after action: V2ResourceAction) {
        switch action {
        case .editDiary, .allowDiary, .withdrawDiary, .continueLegacyDiary,
             .withdrawSource, .addBoundary, .editBoundary, .removeBoundary:
            catDiary?.invalidateEntries()
        default: break
        }
    }

    func refresh() async {
        guard active else { return }
        async let sync: Void = awaitProjection()
        if archive.names.count < 2 {
            do {
                let members = try await selectClient().members()
                try Task.checkCancellation()
                guard active else { return }
                var next = archive
                next.names = Dictionary(uniqueKeysWithValues: members.map { ($0.id, $0.displayName) })
                try persist(next)
                nameError = nil
            } catch where active && !Task.isCancelled {
                nameError = errorMessage(error)
            } catch {}
        }
        await sync
        if !Task.isCancelled {
            inputError = nil
            let accepted = archive.pending.filter { $0.memoryReceipt?.status.isPending == true }
            for item in accepted where !Task.isCancelled { await transmit(item.id) }
        }
    }

    private func awaitProjection() async {
        await changes.refresh()?.value
    }

    func refreshSource(_ location: V2.MessageLocation) async -> V2.SourceUsage? {
        guard active, !busy else { return nil }
        busy = true
        defer { busy = false }
        do {
            let usage = try await selectClient().sourceUsage(location)
            try Task.checkCancellation()
            guard active else { return nil }
            guard usage.location == location else { throw V2.APIError.invalidRequest }
            var next = archive
            next.sources[location.id] = usage
            try persist(next)
            sourceErrors[location.id] = nil
            inputError = nil
            return usage
        } catch {
            if active, !Task.isCancelled { sourceErrors[location.id] = errorMessage(error) }
            return nil
        }
    }

    private func displayed(_ request: V2ResourcePending) -> V2ResourcePending {
        if request.action.memoryID != nil && (request.memoryReceipt != nil || request.problem == .uncertain) {
            return request
        }
        let key: V2.ChangeKey
        switch request.action {
        case .reviseMemory(let id, _, _): key = .init(kind: .memory, id: id)
        case .editBoundary(let id, _, _): key = .init(kind: .boundary, id: id)
        case .editDiary(let id, _, _), .allowDiary(let id, _, _): key = .init(kind: .diary, id: id)
        default: return request
        }
        guard projection?.change(kind: key.kind, id: key.id)?.isDeleted == true else { return request }
        var conflict = request
        conflict.problem = .conflict
        conflict.errorCode = "not_found"
        return conflict
    }

    private func eligible(_ action: V2ResourceAction) -> Bool {
        switch action {
        case .reviseMemory(let id, let revision, _), .forgetMemory(let id, let revision):
            return memories.contains { $0.id == id && $0.canEdit && $0.revision == revision }
        case .editBoundary(let id, let revision, _), .removeBoundary(let id, let revision):
            return boundaries.contains { $0.id == id && $0.subjectMemberID == memberID && $0.revision == revision }
        case .editDiary(let id, let revision, _), .allowDiary(let id, let revision, _), .withdrawDiary(let id, let revision):
            return diary.contains { $0.id == id && canEdit($0) && $0.revision == revision }
        case .addBoundary(let usage, _), .withdrawSource(let usage):
            return sourceErrors[usage.location.id] == nil && usage.allowed && archive.sources[usage.location.id] == usage
        case .addDiary: return true
        case .continueLegacyDiary: return false
        }
    }

    private func errorMessage(_ error: Error) -> String {
        switch (error as? V2.APIError)?.code {
        case "unauthorized": return "配对已失效，请重新连接电脑。"
        case "not_found": return "这条原话现已无法查看用途。"
        default:
            if let problem = error as? V2.ChangesError { return problem.localizedDescription }
            return "暂时无法读取电脑上的最新记录。"
        }
    }

    private func persist(_ next: V2ResourceArchive) throws {
        guard !cannotLoad else { throw CocoaError(.fileReadCorruptFile) }
        do {
            try file.save(next)
            archive = next
            storageError = nil
        } catch {
            storageError = "手机暂时无法保存记录，请重试。"
            throw error
        }
    }

    private static func problem(for code: String?) -> V2ResourcePending.Problem {
        switch code {
        case "revision_conflict": return .conflict
        case "wrong_home_host": return .waitingForHome
        case "peer_action_required", "peer_write_unavailable": return .waitingForPeer
        case "invalid_request", "idempotency_conflict", "source_unavailable", "not_found", "unauthorized": return .rejected
        default: return .uncertain
        }
    }
}
