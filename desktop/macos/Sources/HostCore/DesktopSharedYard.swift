import Combine
import Foundation

struct DesktopYardConnection {
    let key: String
    let memberID: String
    let client: V2Client
}

@MainActor
final class DesktopSharedYard: ObservableObject {
    @Published private(set) var status = "等待连接共享小院"
    @Published private(set) var otherMembers = Set<String>()
    @Published private(set) var availablePlaces: [String] = []
    @Published private(set) var seat: String?
    @Published private(set) var replaced = false
    @Published private(set) var retry = 0
    @Published private(set) var action: YardAction?

    private let render: ([String: Any]) -> Void
    private var scope: String?
    private var session: YardIdentity?
    private var state: YardState?
    private var connected = false
    private var driving = false
    private var projection: YardMotion?
    private var frame: YardFrame?
    private var sequence = YardObservationSequence()
    private var committed: YardSnapshot?
    private var lastReport = -Double.infinity
    private var clock: (server: Date, uptime: TimeInterval)?
    private var move: YardMoveRequest?
    private var watchedRequest: String?
    private var executing: (action: YardAction, motion: YardMotion, finish: Date, accepted: Date?)?
    private var acks: [YardAcknowledgement] = []

    init(render: @escaping ([String: Any]) -> Void) { self.render = render }

    func reconnect() {
        replaced = false
        retry += 1
    }

    func suspend(for connection: DesktopYardConnection?) {
        resetSession()
        if connection?.key != scope {
            scope = connection?.key
            state = nil
            replaced = false
        }
        project()
        updateStatus()
    }

    func run(_ connection: DesktopYardConnection) async {
        suspend(for: connection)
        guard !replaced, !Task.isCancelled else { return }
        var retriedReplacement = false
        while !Task.isCancelled {
            do {
                if session == nil {
                    let registered = try await connection.client.registerYard()
                    try Task.checkCancellation()
                    session = registered.identity
                    apply(registered.state)
                }
                guard let session else { return }
                try await connection.client.yardEvents(session) { [weak self] event in
                    try Task.checkCancellation()
                    guard let self else { return true }
                    try await self.receive(event, from: connection, session: session)
                    return false
                }
            } catch is CancellationError { return }
            catch let error as V2.APIError where error.code == "session_replaced" {
                guard !Task.isCancelled else { return }
                resetSession()
                project()
                if retriedReplacement {
                    replaced = true
                    updateStatus()
                    return
                }
                retriedReplacement = true
            } catch V2.APIError.unauthorized {
                guard !Task.isCancelled else { return }
                suspend(for: nil)
                return
            } catch {
                guard !Task.isCancelled else { return }
            }
            guard !Task.isCancelled else { return }
            connected = false
            otherMembers = []
            updateStatus()
            do { try await Task.sleep(for: .seconds(1)) } catch { return }
        }
    }

    func request(_ destination: String, activity: String? = nil) {
        guard move == nil, action?.status.terminal != false, availablePlaces.contains(destination),
              activity == nil || (activity == "sit" && seat == destination), let committed else { return }
        let request = YardMoveRequest(destination: destination, activity: activity, stateVersion: committed.stateVersion)
        watchedRequest = request.id
        move = request
        action = nil
        updateStatus()
    }

    func observe(_ frame: YardFrame) {
        guard YardSnapshot.places.contains(frame.nearest),
              frame.id == projection?.id || frame.id == executing?.motion.id else { return }
        self.frame = frame
        guard let executing, frame.id == executing.motion.id, action?.status.terminal != true,
              !acks.contains(where: { $0.status.terminal }),
              let observed = snapshot() else { return }
        if let receipt = executing.motion.receipt(for: frame), serverNow <= executing.finish {
            let when = max(executing.accepted ?? .distantPast, serverNow.addingTimeInterval(-0.05))
            acks.append(.init(action: executing.action, status: receipt, snapshot: observed,
                              reason: receipt == .interrupted ? "activity_fallback" : nil,
                              occurredAt: Self.iso.string(from: when)))
        } else if frame.moving, !acks.contains(where: { $0.status == .running }), action?.status != .running {
            acks.append(.init(action: executing.action, status: .running, snapshot: observed))
        }
    }

    private func receive(_ event: V2SSE.Event, from connection: DesktopYardConnection, session: YardIdentity) async throws {
        let data = Data(event.data.utf8)
        let client = connection.client
        switch event.name {
        case "world_state":
            // The stream can still contain a view produced before our latest write.
            // Re-read it over the pinned connection before applying a changed revision.
            let value = try JSONDecoder().decode(YardState.self, from: data)
            if !connected || value.world?.revision != state?.world?.revision ||
                value.executionAvailable != state?.executionAvailable || value.publication != state?.publication {
                let refreshed = try await client.yardState()
                try Task.checkCancellation()
                connected = true
                apply(refreshed)
            }
        case "presence":
            let members = try JSONDecoder().decode(YardPresence.self, from: data).presence
            setPresence(members, current: connection.memberID)
        case "heartbeat":
            struct Heartbeat: Decodable { let server_time: String }
            syncClock(try JSONDecoder().decode(Heartbeat.self, from: data).server_time)
            if !connected {
                let refreshed = try await client.yardState()
                try Task.checkCancellation()
                connected = true
                apply(refreshed)
            }
            try await synchronize(client, session: session)
        case "action", "action_status":
            let receipt = try JSONDecoder().decode(YardAction.self, from: data)
            guard receipt.memberID == connection.memberID else { return }
            confirm(receipt)
            if event.name == "action", receipt.belongs(to: session) {
                enqueue(receipt, hostCommand: true)
            }
        case "world_error":
            struct Failure: Decodable { let code: String }
            throw V2.APIError(code: try JSONDecoder().decode(Failure.self, from: data).code)
        default: break
        }
    }

    private func setPresence(_ members: [YardPresence.Member], current: String) {
        let others = Set(members.map(\.memberID)).subtracting([current])
        if others != otherMembers { otherMembers = others }
    }

    private func apply(_ value: YardState, reproject: Bool = false) {
        let revised = value.world?.revision != state?.world?.revision
        state = value
        syncClock(value.serverTime)
        let demoted = driving && (value.publication.status != .ready || !value.executionAvailable || reproject)
        if demoted {
            driving = false
            committed = nil
            executing = nil
            acks.removeAll()
        }
        if !driving && (revised || reproject || demoted || projection == nil) { project() }
        updateStatus()
    }

    private func project() {
        let saved = state?.world?.snapshot
        let place = saved?.currentDestinationID ?? "house"
        // A projection has its own ID and cannot settle an active action receipt.
        let motion = YardMotion(id: UUID().uuidString, destination: place, activity: saved?.hasConfirmedSeat == true ? "sit" : "watch")
        projection = motion
        frame = nil
        render(["type": "sharedWorld", "intent": motion.projection, "slot": saved?.dayPhase ?? "day",
                "weather": saved?.weather ?? "clear", "full": saved?.bowlFilledToday ?? false])
    }

    private func snapshot() -> YardSnapshot? {
        guard let frame, let motion = executing?.motion ?? projection, frame.id == motion.id else { return nil }
        let seat: String? = executing == nil && !frame.moving
            ? (state?.behavior?.comesToDoor == true ? "house" : frame.nearest) : nil
        return sequence.observe(.init(frame: frame, target: motion.destination, facts: state?.world?.snapshot, seat: seat))
    }

    private func synchronize(_ client: V2Client, session: YardIdentity) async throws {
        try await flush(client, session: session)
        guard state?.publication.status == .ready, let revision = state?.world?.revision else { return }
        if let executing, serverNow > executing.finish {
            self.executing = nil
            project()
        }
        if let observation = snapshot(), ProcessInfo.processInfo.systemUptime - lastReport >= 2 {
            do {
                let confirmed = try await client.reportYard(observation, base: revision, identity: session)
                try Task.checkCancellation()
                lastReport = ProcessInfo.processInfo.systemUptime
                committed = observation
                driving = confirmed.executionAvailable
                apply(confirmed)
            } catch let error as V2.APIError where [
                "world_driver_active", "world_revision_conflict", "not_publisher", "publication_lease_pending",
                "world_history_pending", "stale_state", "state_version_conflict",
            ].contains(error.code) {
                lastReport = ProcessInfo.processInfo.systemUptime
                let latest = try await client.yardState()
                try Task.checkCancellation()
                apply(latest, reproject: driving || error.code == "world_revision_conflict")
                return
            }
        }
        guard driving, connected, state?.executionAvailable == true, let pending = move else { return }
        do {
            let receipt = try await client.yardAction(pending, identity: session)
            try Task.checkCancellation()
            move = nil
            confirm(receipt)
            enqueue(receipt)
        } catch let error as V2.APIError where error.code != "session_replaced" && error != .unauthorized {
            move = nil
            watchedRequest = nil
            updateStatus()
            status = "小院暂时无法执行这个动作"
        }
    }

    private func enqueue(_ receipt: YardAction, hostCommand: Bool = false) {
        guard receipt.status == .requested, hostCommand || receipt.requestID == watchedRequest,
              action?.id != receipt.id || action?.status == .requested, executing == nil,
              !acks.contains(where: { $0.action.id == receipt.id }), let committed else { return }
        if receipt.requestID != watchedRequest {
            // A host command already owns the shared action slot for this session.
            move = nil
            watchedRequest = receipt.requestID
            action = nil
            confirm(receipt)
        }
        let valid = driving && connected && (Self.date(receipt.acceptBefore) ?? .distantPast) > serverNow
            && receipt.stateVersion == committed.stateVersion && snapshot() == committed
            && committed.destinationIDs.contains(receipt.destinationID)
            && (receipt.activity == nil || (receipt.activity == "sit" && committed.companionSeat == receipt.destinationID))
        acks.append(.init(action: receipt, status: valid ? .accepted : .rejected, snapshot: committed,
                          reason: valid ? nil : "world_changed"))
    }

    private func flush(_ client: V2Client, session: YardIdentity) async throws {
        while let ack = acks.first {
            let receipt: YardAction
            do {
                receipt = try await client.acknowledgeYard(ack, identity: session)
                try Task.checkCancellation()
            } catch let error as V2.APIError where [
                "not_found", "invalid_transition", "world_changed", "stale_state", "state_version_conflict",
                "arrival_not_observed", "invalid_event_time", "not_publisher", "publication_lease_pending",
            ].contains(error.code) {
                acks.removeFirst()
                if ack.status == .accepted && error.code == "world_changed" {
                    acks.append(.init(action: ack.action, status: .rejected, snapshot: ack.snapshot, reason: "world_changed"))
                }
                continue
            }
            acks.removeFirst()
            confirm(receipt)
            if ack.status == .accepted, receipt.status == .accepted {
                let finish = Self.date(ack.action.finishBefore) ?? .distantPast
                if driving, connected, finish > serverNow, snapshot() == ack.snapshot {
                    let motion = YardMotion(id: ack.action.id, destination: ack.action.destinationID, activity: ack.action.activity ?? "watch")
                    executing = (ack.action, motion, finish, receipt.occurredAt.flatMap(Self.date))
                    frame = nil
                    render(motion.command)
                } else {
                    acks.append(.init(action: ack.action, status: .interrupted, snapshot: ack.snapshot, reason: "world_changed"))
                }
            } else {
                let refreshed = try await client.yardState()
                try Task.checkCancellation()
                if ack.status.terminal {
                    executing = nil
                    committed = nil
                    lastReport = -.infinity
                    apply(refreshed)
                    project()
                } else {
                    apply(refreshed)
                }
            }
        }
    }

    private func confirm(_ receipt: YardAction) {
        guard receipt.requestID == watchedRequest else { return }
        if let action {
            let presentingInterruption = receipt.revision == action.revision && !action.status.terminal
                && receipt.status == .interrupted && ["publication_changed", "session_replaced"].contains(receipt.reason ?? "")
            guard receipt.revision > action.revision || presentingInterruption else { return }
        }
        action = receipt
        updateStatus()
    }

    private func resetSession() {
        session = nil
        connected = false
        driving = false
        otherMembers = []
        sequence = YardObservationSequence()
        committed = nil
        lastReport = -Double.infinity
        clock = nil
        move = nil
        watchedRequest = nil
        action = nil
        executing = nil
        acks.removeAll()
    }

    private func updateStatus() {
        let next: String
        if replaced { next = "小院已在这位成员的另一台设备打开" }
        else if !connected { next = state?.world == nil ? "等待连接共享小院" : "显示上次同步的小院" }
        else if state?.publication.status == .waiting { next = "等待确认小院发布权" }
        else if state?.world == nil { next = "等待共享小院同步" }
        else if !driving { next = "正在看已同步的小院" }
        else { next = "\(state?.world?.profile.name ?? "团子") · 共享小院" }
        if next != status { status = next }
        let canAct = driving && connected && state?.executionAvailable == true && move == nil
            && executing == nil && action?.status.terminal != false
        let places = canAct ? committed?.destinationIDs ?? [] : []
        if places != availablePlaces { availablePlaces = places }
        let nextSeat = canAct ? committed?.companionSeat : nil
        if nextSeat != seat { seat = nextSeat }
    }

    private var serverNow: Date {
        guard let clock else { return Date() }
        return clock.server.addingTimeInterval(ProcessInfo.processInfo.systemUptime - clock.uptime)
    }

    private func syncClock(_ value: String) {
        guard let date = Self.date(value), clock.map({ date >= $0.server }) ?? true else { return }
        clock = (date, ProcessInfo.processInfo.systemUptime)
    }

    private static let iso: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static func date(_ value: String) -> Date? {
        iso.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}
