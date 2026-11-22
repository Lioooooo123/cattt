import Foundation

/// The pinned member connection owns one world session. Only its heartbeat loop mutates the host.
@MainActor
final class V2WorldBridge {
    private struct Move {
        let id = UUID()
        let destination: String
        let activity: String?
        var stateVersion: Int?
    }

    private let connection: V2Connection
    private weak var engine: WorldEngine?
    private let changes: V2ChangesStore
    private let changed: () -> Void
    private let announce: (String) -> Void
    private var task: Task<Void, Never>?
    private var identity: V2.WorldIdentity?
    private var view: V2.WorldView?
    private var connected = false
    private var replaced = false
    private var replacementRetried = false
    private var closed = false
    private var lastReport = -Double.infinity
    private var reported: WorldSnapshot?
    private var unconfirmedReport: WorldSnapshot?
    private var clock: (date: Date, uptime: Double)?
    private var move: Move?
    private var watchedRequest: String?
    private var action: V2.WorldAction?
    private var seenCommands: [String] = []
    private var acknowledgements: [WorldAcknowledgement] = []
    private(set) var world: V2.WorldRecord?
    private(set) var otherMembers = Set<String>()

    init(connection: V2Connection, engine: WorldEngine, changes: V2ChangesStore,
         changed: @escaping () -> Void, announce: @escaping (String) -> Void) {
        self.connection = connection
        self.engine = engine
        self.changes = changes
        self.changed = changed
        self.announce = announce
        engine.setSharedMode(true, reset: true)
        engine.sharedActionRequested = { [weak self] in self?.request(destination: $0, activity: $1) }
        engine.sharedRendererLost = { [weak self] in self?.rendererLost() }
        engine.agentActionChanged = { [weak self] in self?.record($0, status: $1, reason: $2) }
    }

    var status: String {
        if replaced { return "小院已在这位成员的另一台设备打开" }
        guard connected else { return world == nil ? "正在连接共享小院" : "连接中断，显示上次同步的小院" }
        switch view?.publication.status {
        case .waiting: return "等电脑确认小院发布权"
        case .remote: return "正在看已同步的小院"
        case .ready:
            if world == nil { return "等电脑同步小院" }
            if engine?.sharedDriver != true { return "正在旁观小院" }
            return "\(world?.profile.name ?? "团子") · 共享小院"
        case nil: return "正在连接共享小院"
        }
    }

    var needsRetry: Bool { replaced }

    var canSubmit: Bool {
        connected && view?.executionAvailable == true && view?.canReport == true
            && engine?.sharedDriver == true && engine?.canRunWorld == true
    }
    var companionSeat: String? { canSubmit ? reported?.companionSeat : nil }

    func setForeground(_ value: Bool) {
        guard !closed else { return }
        if value {
            if world == nil, let cached = changes.snapshot.world {
                world = cached
                engine?.applySharedWorld(cached, behavior: nil, reproject: true)
            }
            start()
        } else {
            task?.cancel(); task = nil
            disconnect()
        }
    }

    func retry() {
        replaced = false
        replacementRetried = false
        start()
    }

    func close() {
        guard !closed else { return }
        closed = true
        task?.cancel(); task = nil
        engine?.agentActionChanged = nil
        engine?.sharedActionRequested = nil
        engine?.sharedRendererLost = nil
        engine?.setSharedMode(false)
        engine = nil
    }

    func request(destination: String, activity: String?) {
        guard !closed else { return }
        guard canSubmit else { announce(status); return }
        guard move == nil, action?.status.terminal != false else { announce("团子正在回应上一个邀请"); return }
        let next = Move(destination: destination, activity: activity)
        move = next
        watchedRequest = next.id.uuidString.lowercased()
        action = nil
    }

    private func start() {
        guard task == nil, !closed, !replaced, engine?.uses3D == true else { return }
        task = Task { [weak self] in await self?.run() }
    }

    private func run() async {
        var client: V2Client?
        while !Task.isCancelled {
            do {
                if client == nil {
                    let candidate = try await connection.select()
                    guard let scope = V2SyncScope(identity: connection.identity) else { throw V2.ChangesError.identityMismatch }
                    try scope.validate(await candidate.me(), deviceID: connection.identity.deviceId)
                    try Task.checkCancellation()
                    client = candidate
                }
                guard let client else { continue }
                if identity == nil {
                    let registration = try await client.registerSharedWorld()
                    try Task.checkCancellation()
                    identity = registration.identity
                    apply(registration.view)
                }
                guard let identity else { continue }
                try await client.sharedWorldEvents(identity) { [weak self] event in
                    guard let self else { return true }
                    try Task.checkCancellation()
                    try await receive(event, client: client, identity: identity)
                    return false
                }
            } catch {
                if Task.isCancelled { return }
                if let error = error as? V2.APIError, error.code == "session_replaced" {
                    resetSession()
                    // A restarted host also reports session_replaced. Re-register once per live run;
                    // a second replacement yields to the other device until the member taps retry.
                    if replacementRetried { replaced = true; disconnect(); task = nil; return }
                    replacementRetried = true
                } else if let error = error as? V2.APIError, error.code == "unauthorized" {
                    resetSession()
                } else {
                    client = nil
                }
            }
            if Task.isCancelled { return }
            disconnect()
            do { try await Task.sleep(for: .seconds(1)) } catch { return }
        }
    }

    private func disconnect() {
        connected = false
        otherMembers = []
        engine?.setSharedDriver(engine?.sharedDriver == true, connected: false)
        changed()
    }

    private func resetSession() {
        engine?.setSharedDriver(false, connected: false)
        engine?.interruptAgentMove(reason: "session_replaced")
        identity = nil; view = nil; reported = nil; unconfirmedReport = nil; clock = nil
        acknowledgements = []; seenCommands = []; move = nil; watchedRequest = nil; action = nil
        lastReport = -.infinity
        if let world { engine?.applySharedWorld(world, behavior: nil, reproject: true) }
    }

    private func rendererLost() {
        guard let engine else { return }
        engine.interruptAgentMove(reason: "world_unavailable")
        engine.setSharedDriver(false, connected: false)
        reported = nil; unconfirmedReport = nil
        if let world { engine.applySharedWorld(world, behavior: view?.behavior?.params, reproject: true) }
    }

    private func receive(_ event: V2SSE.Event, client: V2Client, identity: V2.WorldIdentity) async throws {
        let data = Data(event.data.utf8)
        switch event.name {
        case "world_state":
            let state = try V2.decoder.decode(V2.WorldView.self, from: data)
            // A frame queued before a successful PUT/ack can describe an older opaque revision.
            // Re-read the current view before acting on such an event.
            if !connected {
                try await connect(client)
            } else if state.world?.revision != view?.world?.revision || state.executionAvailable != view?.executionAvailable
                || state.publication.status != view?.publication.status || state.publication.publisherHostId != view?.publication.publisherHostId {
                try await refresh(client)
            }
        case "presence":
            presence(try V2.decoder.decode(V2.WorldPresence.self, from: data).presence)
        case "heartbeat":
            let heartbeat = try V2.decoder.decode(V2.WorldHeartbeat.self, from: data)
            syncClock(heartbeat.serverTime)
            if !connected { try await connect(client) }
            try await synchronize(client, identity: identity)
        case "action":
            let receipt = try V2.decoder.decode(V2.WorldAction.self, from: data)
            if let command = receipt.command { enqueue(command, identity: identity) }
        case "action_status":
            apply(try V2.decoder.decode(V2.WorldAction.self, from: data))
        case "world_error":
            throw V2.APIError(code: try V2.decoder.decode(V2.WorldFailure.self, from: data).code)
        default: break
        }
    }

    private func connect(_ client: V2Client) async throws {
        let state = try await client.sharedWorld()
        try Task.checkCancellation()
        connected = true
        apply(state)
    }

    private func refresh(_ client: V2Client, reproject: Bool = false) async throws {
        let state = try await client.sharedWorld()
        try Task.checkCancellation()
        apply(state, reproject: reproject)
    }

    private func apply(_ state: V2.WorldView, reproject: Bool = false) {
        let oldRevision = view?.world?.revision
        view = state
        syncClock(state.serverTime)
        if let members = state.presence { presence(members) }
        let driving = engine?.sharedDriver == true
        let stillDriving = driving && state.canReport && state.executionAvailable && !reproject
        let demote = driving && !stillDriving
        if demote {
            engine?.interruptAgentMove(reason: "world_changed")
            reported = nil; unconfirmedReport = nil
        } else if stillDriving, let unconfirmedReport, state.world?.snapshot?.value == unconfirmedReport {
            reported = unconfirmedReport
            self.unconfirmedReport = nil
        }
        engine?.setSharedDriver(stillDriving, connected: connected)
        if let new = state.world, oldRevision != new.revision || world == nil || reproject || demote {
            world = new
            engine?.applySharedWorld(new, behavior: state.behavior?.params, reproject: reproject || demote)
        }
        changed()
    }

    private func presence(_ members: [V2.WorldPresence.Member]) {
        let others = Set(members.map(\.memberId)).subtracting([connection.identity.member.id])
        guard others != otherMembers else { return }
        otherMembers = others
        changed()
    }

    private func synchronize(_ client: V2Client, identity: V2.WorldIdentity) async throws {
        guard let engine else { return }
        try await flushAcknowledgements(client, identity: identity)
        try Task.checkCancellation()
        guard connected, let view, view.canReport, let revision = view.world?.revision, engine.canRunWorld else { return }
        let now = ProcessInfo.processInfo.systemUptime
        if (move != nil && engine.sharedDriver) || now - lastReport >= 1.5 {
            lastReport = now
            let snapshot = engine.worldSnapshot()
            unconfirmedReport = snapshot
            do {
                let next = try await client.reportSharedWorld(snapshot, revision: revision, identity: identity)
                try Task.checkCancellation()
                reported = snapshot
                unconfirmedReport = nil
                engine.setSharedDriver(true, connected: connected)
                apply(next)
            } catch let error as V2.APIError where [
                "world_driver_active", "world_revision_conflict", "not_publisher", "publication_lease_pending",
                "world_history_pending", "stale_state", "state_version_conflict",
            ].contains(error.code) {
                try Task.checkCancellation()
                unconfirmedReport = nil
                try await refresh(client, reproject: engine.sharedDriver || error.code == "world_revision_conflict")
                return
            }
        }
        guard canSubmit, let reported, var pending = move else { return }
        // Freeze the business request before posting, so transport retry can recover the same receipt.
        let version = pending.stateVersion ?? reported.stateVersion
        pending.stateVersion = version
        move = pending
        do {
            let receipt = try await client.requestSharedWorldAction(pending.id, destination: pending.destination,
                activity: pending.activity, stateVersion: version, identity: identity)
            try Task.checkCancellation()
            move = nil
            apply(receipt)
        } catch let error as V2.APIError where error.code != "session_replaced" {
            try Task.checkCancellation()
            move = nil; watchedRequest = nil
            announce("小院暂时无法执行这个动作")
        }
    }

    private func enqueue(_ command: WorldCommand, identity: V2.WorldIdentity) {
        guard let engine, canSubmit, let reported,
              command.sessionId == identity.sessionId, command.generation == identity.generation,
              !seenCommands.contains(command.id) else { return }
        if seenCommands.count >= 50 { seenCommands.removeFirst() }
        seenCommands.append(command.id)
        let snapshot = engine.worldSnapshot()
        if V2.WorldPolicy.canAccept(command, session: identity, committed: reported, live: snapshot) {
            record(command, status: "accepted", reason: nil)
        } else {
            record(command, status: "rejected", reason: "world_changed")
        }
    }

    private func record(_ command: WorldCommand, status: String, reason: String?) {
        guard let engine, let identity, command.sessionId == identity.sessionId, command.generation == identity.generation else { return }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let occurred = formatter.string(from: serverNow().addingTimeInterval(-0.05))
        guard let snapshot = status == "rejected" ? reported : engine.worldSnapshot() else { return }
        acknowledgements.append(WorldAcknowledgement(command: command, status: status, reason: reason,
            snapshot: snapshot, occurredAt: occurred))
    }

    private func flushAcknowledgements(_ client: V2Client, identity: V2.WorldIdentity) async throws {
        while let ack = acknowledgements.first {
            let receipt: V2.WorldAction
            do {
                receipt = try await client.acknowledgeSharedWorld(ack)
                try Task.checkCancellation()
            } catch let error as V2.APIError where [
                "not_found", "invalid_transition", "world_changed", "stale_state", "state_version_conflict",
                "arrival_not_observed", "invalid_event_time", "not_publisher", "publication_lease_pending",
            ].contains(error.code) {
                try Task.checkCancellation()
                acknowledgements.removeFirst()
                if engine?.hasRunningSharedAction != true, ack.status == "accepted", error.code == "world_changed" {
                    record(ack.command, status: "rejected", reason: "world_changed")
                }
                continue
            }
            acknowledgements.removeFirst()
            apply(receipt)
            if ack.status == "accepted", receipt.status == .accepted, let engine {
                let finishAfter = parseDate(ack.command.finishBefore)?.timeIntervalSince(serverNow()) ?? 0
                if !canSubmit || finishAfter <= 0 || !engine.beginAgentMove(ack.command, finishAfter: finishAfter) {
                    record(ack.command, status: "interrupted", reason: "world_changed")
                }
            }
            // running/arrival may advance world revision in the same transaction as the receipt.
            if ack.status != "accepted" { try await refresh(client) }
        }
    }

    private func apply(_ receipt: V2.WorldAction) {
        guard receipt.memberId == connection.identity.member.id, receipt.requestId == watchedRequest else { return }
        if let previous = action {
            let presentationChanged = receipt.revision == previous.revision && receipt.status == .interrupted
                && !previous.status.terminal && ["publication_changed", "session_replaced"].contains(receipt.reason ?? "")
            guard receipt.revision > previous.revision || presentationChanged else { return }
        }
        action = receipt
        if receipt.status.terminal {
            switch receipt.status {
            case .arrived: announce(receipt.activity == "sit" ? "团子坐下了" : "团子到了")
            case .rejected, .interrupted, .expired: announce("团子没能完成这个动作")
            default: break
            }
        }
    }

    private func parseDate(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }

    private func syncClock(_ value: String) {
        guard let date = parseDate(value), date >= (clock?.date ?? .distantPast) else { return }
        clock = (date, ProcessInfo.processInfo.systemUptime)
    }

    private func serverNow() -> Date {
        guard let clock else { return Date() }
        return clock.date.addingTimeInterval(ProcessInfo.processInfo.systemUptime - clock.uptime)
    }
}
