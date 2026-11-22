import Foundation

extension V2 {
    struct WorldIdentity: Codable, Equatable {
        let sessionId: String
        let generation: String
        enum CodingKeys: String, CodingKey { case generation; case sessionId = "session_id" }
    }

    struct WorldObservation: Codable, Equatable {
        let value: WorldSnapshot
        init(_ value: WorldSnapshot) { self.value = value }

        private enum CodingKeys: String, CodingKey {
            case phase, action, paused, runnable, mood, weather, activity
            case stateVersion = "state_version", sceneVersion = "scene_version", destinationIds = "destination_ids"
            case currentDestinationId = "current_destination_id", targetDestinationId = "target_destination_id"
            case moodReason = "mood_reason", dayPhase = "day_phase", bowlFilledToday = "bowl_filled_today"
            case lastDrinkAt = "last_drink_at", placesToday = "places_today"
            case activityFallback = "activity_fallback", companionSeat = "companion_seat"
        }

        init(from decoder: Decoder) throws {
            let f = try decoder.container(keyedBy: CodingKeys.self)
            value = try WorldSnapshot(
                stateVersion: f.decode(Int.self, forKey: .stateVersion), sceneVersion: f.decode(Int.self, forKey: .sceneVersion),
                destinationIds: f.decode([String].self, forKey: .destinationIds),
                currentDestinationId: f.decode(String.self, forKey: .currentDestinationId),
                targetDestinationId: f.decode(String.self, forKey: .targetDestinationId),
                phase: f.decode(String.self, forKey: .phase), action: f.decode(String.self, forKey: .action),
                paused: f.decode(Bool.self, forKey: .paused), runnable: f.decode(Bool.self, forKey: .runnable),
                mood: f.decodeIfPresent(String.self, forKey: .mood) ?? "calm",
                moodReason: f.decodeIfPresent(String.self, forKey: .moodReason) ?? "",
                dayPhase: f.decodeIfPresent(String.self, forKey: .dayPhase) ?? "day",
                weather: f.decodeIfPresent(String.self, forKey: .weather) ?? "clear",
                bowlFilledToday: f.decodeIfPresent(Bool.self, forKey: .bowlFilledToday) ?? false,
                lastDrinkAt: f.decodeIfPresent(String.self, forKey: .lastDrinkAt),
                placesToday: f.decodeIfPresent([String].self, forKey: .placesToday) ?? [],
                activity: f.decodeIfPresent(String.self, forKey: .activity),
                activityFallback: f.decodeIfPresent(Bool.self, forKey: .activityFallback),
                companionSeat: f.decodeIfPresent(String.self, forKey: .companionSeat))
            guard value.sceneVersion == 4, value.stateVersion >= 0,
                  value.destinationIds.allSatisfy(YardIntent.places.contains),
                  value.destinationIds.contains(value.currentDestinationId),
                  value.destinationIds.contains(value.targetDestinationId) else {
                throw DecodingError.dataCorruptedError(forKey: .destinationIds, in: f, debugDescription: "Unsupported yard observation")
            }
        }

        func encode(to encoder: Encoder) throws {
            var f = encoder.container(keyedBy: CodingKeys.self)
            try f.encode(value.stateVersion, forKey: .stateVersion)
            try f.encode(value.sceneVersion, forKey: .sceneVersion)
            try f.encode(value.destinationIds, forKey: .destinationIds)
            try f.encode(value.currentDestinationId, forKey: .currentDestinationId)
            try f.encode(value.targetDestinationId, forKey: .targetDestinationId)
            try f.encode(value.phase, forKey: .phase)
            try f.encode(value.action, forKey: .action)
            try f.encode(value.paused, forKey: .paused)
            try f.encode(value.runnable, forKey: .runnable)
            try f.encode(value.mood, forKey: .mood)
            try f.encode(value.moodReason, forKey: .moodReason)
            try f.encode(value.dayPhase, forKey: .dayPhase)
            try f.encode(value.weather, forKey: .weather)
            try f.encode(value.bowlFilledToday, forKey: .bowlFilledToday)
            try f.encodeIfPresent(value.lastDrinkAt, forKey: .lastDrinkAt)
            try f.encode(value.placesToday, forKey: .placesToday)
            try f.encodeIfPresent(value.activity, forKey: .activity)
            try f.encodeIfPresent(value.activityFallback, forKey: .activityFallback)
            try f.encodeIfPresent(value.companionSeat, forKey: .companionSeat)
        }
    }

    struct WorldRecord: Codable, Equatable, Identifiable {
        struct Profile: Codable, Equatable {
            struct Traits: Codable, Equatable { let energy, initiative, directness, closeness: Int }
            let name: String
            let appearance: String
            let temperament: Temperament
            let traits: Traits
        }

        let id: String
        let revision: String
        let updatedAt: Int64
        let observedAt: Int64?
        let adoptedAt: Int64
        let profile: Profile
        let snapshot: WorldObservation?
        enum CodingKeys: String, CodingKey {
            case id, revision, profile, snapshot
            case updatedAt = "updated_at", observedAt = "observed_at", adoptedAt = "adopted_at"
        }

        var localBehavior: BehaviorParams {
            let calendar = Calendar.current
            let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: Date(timeIntervalSince1970: Double(adoptedAt) / 1000)),
                                               to: calendar.startOfDay(for: Date())).day ?? 0
            return BehaviorParams.compile(temperament: profile.temperament, traits: [
                .energy: profile.traits.energy, .initiative: profile.traits.initiative,
                .directness: profile.traits.directness, .closeness: profile.traits.closeness,
            ], daysSinceAdoption: max(0, days))
        }
    }

    struct WorldBehavior: Decodable {
        let idleScale, homeIdleScale, sleepWeight, lookWeight, tiltShare, groomWeight, moodScale: Double
        let placeWeights, drinkDelay: [Double]
        let comesToDoor: Bool
        let diarySentences: Int
        enum CodingKeys: String, CodingKey {
            case idleScale = "idle_scale", homeIdleScale = "home_idle_scale", sleepWeight = "sleep_weight"
            case lookWeight = "look_weight", tiltShare = "tilt_share", groomWeight = "groom_weight"
            case moodScale = "mood_scale", placeWeights = "place_weights", drinkDelay = "drink_delay"
            case comesToDoor = "comes_to_door", diarySentences = "diary_sentences"
        }
        var params: BehaviorParams? {
            guard idleScale > 0, drinkDelay.count == 2, drinkDelay[0] <= drinkDelay[1] else { return nil }
            return BehaviorParams(idleScale: idleScale, homeIdleScale: homeIdleScale, sleepWeight: sleepWeight,
                lookWeight: lookWeight, tiltShare: tiltShare, groomWeight: groomWeight, placeWeights: placeWeights,
                comesToDoor: comesToDoor, moodScale: moodScale, drinkDelay: drinkDelay[0]...drinkDelay[1],
                diarySentences: diarySentences)
        }
    }

    struct WorldView: Decodable {
        struct Publication: Decodable {
            enum Status: String, Decodable { case ready, remote, waiting }
            let status: Status
            let publisherHostId: String?
            enum CodingKeys: String, CodingKey { case status; case publisherHostId = "publisher_host_id" }
        }
        let world: WorldRecord?
        let behavior: WorldBehavior?
        let serverTime: String
        let publication: Publication
        let executionAvailable: Bool
        let presence: [WorldPresence.Member]?
        enum CodingKeys: String, CodingKey {
            case world, behavior, publication, presence
            case serverTime = "server_time", executionAvailable = "execution_available"
        }
        var canReport: Bool { publication.status == .ready && world != nil }
    }

    struct WorldRegistration: Decodable {
        let identity: WorldIdentity
        let view: WorldView
        init(from decoder: Decoder) throws {
            identity = try WorldIdentity(from: decoder)
            view = try WorldView(from: decoder)
        }
    }
    struct WorldPresence: Decodable {
        struct Member: Decodable {
            let memberId: String
            enum CodingKeys: String, CodingKey { case memberId = "member_id" }
        }
        let presence: [Member]
    }
    struct WorldHeartbeat: Decodable {
        let serverTime: String
        enum CodingKeys: String, CodingKey { case serverTime = "server_time" }
    }
    struct WorldFailure: Decodable {
        let code: String
    }
    struct WorldAction: Decodable, Equatable {
        enum Status: String, Codable {
            case requested, accepted, running, arrived, rejected, interrupted, expired
            var terminal: Bool { [.arrived, .rejected, .interrupted, .expired].contains(self) }
        }
        let id: String
        let requestId: String
        let memberId: String
        let sessionId: String?
        let generation: String?
        let destinationId: String
        let activity: String?
        let stateVersion: Int
        let status: Status
        let reason: String?
        let acceptBefore: String
        let finishBefore: String
        let occurredAt: String?
        let snapshot: WorldObservation?
        let revision: Int
        enum CodingKeys: String, CodingKey {
            case id, generation, activity, status, reason, snapshot, revision
            case requestId = "request_id", memberId = "member_id", sessionId = "session_id"
            case destinationId = "destination_id", stateVersion = "state_version"
            case acceptBefore = "accept_before", finishBefore = "finish_before", occurredAt = "occurred_at"
        }
        var command: WorldCommand? {
            guard let sessionId, let generation, status == .requested else { return nil }
            return WorldCommand(id: id, sessionId: sessionId, generation: generation, destinationId: destinationId,
                stateVersion: stateVersion, activity: activity, acceptBefore: acceptBefore, finishBefore: finishBefore)
        }
    }

    // 复制视图只能证明当前位置，不重演其旧行程。陪坐保留已确认的坐姿。
    struct WorldProjection: Equatable {
        let place: String
        let activity: String
        let slot: String
        let weather: String
        let full: Bool
        init(_ snapshot: WorldSnapshot?) {
            place = snapshot?.currentDestinationId ?? "house"
            activity = snapshot?.phase == "idle" && snapshot?.activity == "sit"
                && snapshot?.action == "sit_idle" && snapshot?.activityFallback == false ? "sit" : "watch"
            slot = snapshot?.dayPhase ?? "day"
            weather = snapshot?.weather ?? "clear"
            full = snapshot?.bowlFilledToday ?? false
        }
        func command(intent: YardIntent.Request) -> [String: Any] {
            ["type": "sharedWorld", "intent": intent.json, "slot": slot, "weather": weather, "full": full]
        }
    }

    enum WorldPolicy {
        static func canAccept(_ command: WorldCommand, session: WorldIdentity,
                              committed: WorldSnapshot?, live: WorldSnapshot) -> Bool {
            command.sessionId == session.sessionId && command.generation == session.generation
                && committed == live && live.stateVersion == command.stateVersion
                && live.runnable && !live.paused && live.destinationIds.contains(command.destinationId)
                && (command.activity == nil || (command.activity == "sit" && live.companionSeat == command.destinationId))
        }
    }
}
