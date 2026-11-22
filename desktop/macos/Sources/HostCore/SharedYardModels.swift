import Foundation

struct YardFrame: Decodable {
    let id: String
    let nearest: String
    let moving: Bool
    let settled: Bool
    let action: String
    let activity: String
    let fallback: Bool
}

struct YardMotion {
    let id: String
    let destination: String
    let activity: String

    var projection: [String: Any] { ["id": id, "place": destination, "activity": activity] }

    var command: [String: Any] {
        var command = projection
        command["type"] = "intent"
        return command
    }

    func receipt(for frame: YardFrame) -> YardAction.Status? {
        guard frame.id == id, frame.activity == activity, frame.settled, !frame.moving,
              frame.nearest == destination else { return nil }
        if activity == "sit" {
            if frame.fallback { return .interrupted }
            guard frame.action == "sit_idle" else { return nil }
        }
        return .arrived
    }
}

struct YardSnapshot: Codable, Equatable {
    static let places = ["house", "tree", "bed", "grass", "pond", "fence"]

    var stateVersion = 0
    var sceneVersion = 4
    var destinationIDs = places
    var currentDestinationID: String
    var targetDestinationID: String
    var phase: String
    var action: String
    var paused = false
    var runnable = true
    var companionSeat: String?
    var activity: String?
    var activityFallback: Bool?
    var mood: String?
    var moodReason: String?
    var dayPhase: String?
    var weather: String?
    var bowlFilledToday: Bool?
    var lastDrinkAt: String?
    var placesToday: [String]?

    enum CodingKeys: String, CodingKey {
        case phase, action, paused, runnable, activity, mood, weather
        case stateVersion = "state_version", sceneVersion = "scene_version", destinationIDs = "destination_ids"
        case currentDestinationID = "current_destination_id", targetDestinationID = "target_destination_id"
        case companionSeat = "companion_seat", activityFallback = "activity_fallback", moodReason = "mood_reason"
        case dayPhase = "day_phase", bowlFilledToday = "bowl_filled_today", lastDrinkAt = "last_drink_at", placesToday = "places_today"
    }

    init(frame: YardFrame, target: String, facts: Self?, seat: String?) {
        currentDestinationID = frame.nearest
        targetDestinationID = target
        phase = frame.moving ? "moving" : "idle"
        action = frame.action
        activity = frame.activity
        activityFallback = frame.fallback
        companionSeat = seat
        mood = facts?.mood ?? "calm"
        moodReason = facts?.moodReason ?? ""
        dayPhase = facts?.dayPhase ?? "day"
        weather = facts?.weather ?? "clear"
        bowlFilledToday = facts?.bowlFilledToday ?? false
        lastDrinkAt = facts?.lastDrinkAt
        placesToday = facts?.placesToday ?? []
    }

    var hasConfirmedSeat: Bool {
        phase == "idle" && activity == "sit" && action == "sit_idle" && activityFallback == false
    }

    var json: [String: Any] {
        get throws { try JSONSerialization.jsonObject(with: JSONEncoder().encode(self)) as? [String: Any] ?? [:] }
    }
}

struct YardObservationSequence {
    private var last: YardSnapshot?

    mutating func observe(_ snapshot: YardSnapshot) -> YardSnapshot {
        var next = snapshot
        next.stateVersion = last?.stateVersion ?? 0
        if let last, next != last { next.stateVersion += 1 }
        last = next
        return next
    }
}

struct YardIdentity: Codable, Equatable {
    let sessionID: String
    let generation: String

    enum CodingKeys: String, CodingKey { case generation; case sessionID = "session_id" }

    var body: [String: Any] { ["session_id": sessionID, "generation": generation] }
}

struct YardPresence: Decodable {
    struct Member: Decodable {
        let memberID: String
        enum CodingKeys: String, CodingKey { case memberID = "member_id" }
    }

    let presence: [Member]
}

struct YardState: Decodable {
    struct World: Decodable {
        struct Profile: Decodable { let name: String }
        let id: String
        let revision: String
        let profile: Profile
        let snapshot: YardSnapshot?
    }

    struct Publication: Decodable, Equatable {
        enum Status: String, Decodable { case ready, remote, waiting }
        let status: Status
        let publisherHostID: String?
        enum CodingKeys: String, CodingKey { case status; case publisherHostID = "publisher_host_id" }
    }

    struct Behavior: Decodable {
        let comesToDoor: Bool
        enum CodingKeys: String, CodingKey { case comesToDoor = "comes_to_door" }
    }

    let world: World?
    let publication: Publication
    let behavior: Behavior?
    let executionAvailable: Bool
    let presence: [YardPresence.Member]?
    let serverTime: String

    enum CodingKeys: String, CodingKey {
        case world, publication, behavior, presence
        case executionAvailable = "execution_available", serverTime = "server_time"
    }
}

struct YardRegistration: Decodable {
    let identity: YardIdentity
    let state: YardState
    init(from decoder: Decoder) throws {
        identity = try YardIdentity(from: decoder)
        state = try YardState(from: decoder)
    }
}

struct YardAction: Decodable {
    enum Status: String, Decodable {
        case requested, accepted, running, arrived, rejected, interrupted, expired
        var terminal: Bool { [.arrived, .rejected, .interrupted, .expired].contains(self) }
    }

    let id: String
    let requestID: String
    let memberID: String
    let destinationID: String
    let activity: String?
    let stateVersion: Int
    let status: Status
    let reason: String?
    let sessionID: String?
    let generation: String?
    let acceptBefore: String
    let finishBefore: String
    let occurredAt: String?
    let revision: Int

    enum CodingKeys: String, CodingKey {
        case id, activity, status, reason, generation, revision
        case requestID = "request_id", memberID = "member_id", destinationID = "destination_id"
        case stateVersion = "state_version", sessionID = "session_id", acceptBefore = "accept_before"
        case finishBefore = "finish_before", occurredAt = "occurred_at"
    }

    func belongs(to identity: YardIdentity) -> Bool {
        sessionID == identity.sessionID && generation == identity.generation
    }
}

extension V2Client {
    func registerYard() async throws -> YardRegistration {
        try await json(YardRegistration.self, yardRequest("POST", "sessions", body: ["protocol_version": 2]))
    }

    func yardState() async throws -> YardState {
        try await json(YardState.self, yardRequest("GET", "state"))
    }

    func reportYard(_ snapshot: YardSnapshot, base: String, identity: YardIdentity) async throws -> YardState {
        var body = identity.body
        body["base_revision"] = base
        body["snapshot"] = try snapshot.json
        return try await json(YardState.self, yardRequest("PUT", "state", body: body))
    }

    func yardAction(_ request: YardMoveRequest, identity: YardIdentity) async throws -> YardAction {
        var body = identity.body
        body["request_id"] = request.id
        body["destination_id"] = request.destination
        body["state_version"] = request.stateVersion
        body["activity"] = request.activity
        return try await json(YardAction.self, yardRequest("POST", "actions", body: body))
    }

    func acknowledgeYard(_ acknowledgement: YardAcknowledgement, identity: YardIdentity) async throws -> YardAction {
        var body = identity.body
        body["status"] = acknowledgement.status.rawValue
        body["snapshot"] = try acknowledgement.snapshot.json
        body["reason"] = acknowledgement.reason
        body["occurred_at"] = acknowledgement.occurredAt
        return try await json(YardAction.self, yardRequest("POST", "actions/\(acknowledgement.action.id)/ack", body: body))
    }

    func yardEvents(_ identity: YardIdentity, receive: @escaping (V2SSE.Event) async throws -> Bool) async throws {
        let query = [URLQueryItem(name: "session_id", value: identity.sessionID),
                     URLQueryItem(name: "generation", value: identity.generation)]
        var req = try request("GET", "world/events", query: query)
        req.timeoutInterval = 8
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        try await stream(req, receive: receive)
    }

    private func yardRequest(_ method: String, _ path: String, body: [String: Any]? = nil) throws -> URLRequest {
        var req = try request(method, "world/" + path, body: body)
        req.timeoutInterval = 4
        return req
    }
}

struct YardMoveRequest {
    let id = UUID().uuidString.lowercased()
    let destination: String
    let activity: String?
    let stateVersion: Int
}

struct YardAcknowledgement {
    let action: YardAction
    let status: YardAction.Status
    let snapshot: YardSnapshot
    var reason: String?
    var occurredAt: String?
}
