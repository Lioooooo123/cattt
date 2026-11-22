import XCTest
@testable import Maomao

final class V2WorldTests: XCTestCase {
    private let snapshotJSON = """
    {"state_version":17,"scene_version":4,"destination_ids":["house","pond"],
     "current_destination_id":"pond","target_destination_id":"house","phase":"moving",
     "action":"walk","paused":false,"runnable":true,"mood":"calm","mood_reason":"",
     "day_phase":"dusk","weather":"rain","bowl_filled_today":true,"places_today":["池塘"]}
    """

    func testConfirmedProjectionUsesObservedLocationAndDoesNotReplayTravel() throws {
        let observation = try V2.decoder.decode(V2.WorldObservation.self, from: Data(snapshotJSON.utf8))
        let projection = V2.WorldProjection(observation.value)
        XCTAssertEqual(projection.place, "pond")
        XCTAssertEqual(projection.activity, "watch")
        XCTAssertEqual(projection.slot, "dusk")
        XCTAssertEqual(projection.weather, "rain")
        XCTAssertTrue(projection.full)
        let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(observation)) as? [String: Any])
        XCTAssertEqual(encoded["state_version"] as? Int, 17)
        XCTAssertEqual(encoded["current_destination_id"] as? String, "pond")
        XCTAssertNil(encoded["stateVersion"])
    }

    func testSeatingRequiresConfirmedPoseAndNoFallback() throws {
        var observation = try V2.decoder.decode(V2.WorldObservation.self, from: Data(snapshotJSON.utf8)).value
        observation = WorldSnapshot(stateVersion: 18, sceneVersion: 4, destinationIds: ["house"], currentDestinationId: "house",
            targetDestinationId: "house", phase: "idle", action: "sit_idle", paused: false, runnable: true,
            activity: "sit", activityFallback: true)
        XCTAssertEqual(V2.WorldProjection(observation).activity, "watch")
        observation.activityFallback = false
        XCTAssertEqual(V2.WorldProjection(observation).activity, "sit")
    }

    func testWorldChangeUsesSameProjectionAsWorldView() throws {
        let world = """
        {"id":"cat","revision":"opaque","updated_at":100,"observed_at":90,"adopted_at":80,
         "profile":{"name":"团子","appearance":"orange","temperament":"slow","traits":{"energy":1,"initiative":1,"directness":1,"closeness":1}},
         "snapshot":\(snapshotJSON)}
        """
        let change = """
        {"kind":"world","id":"cat","sequence":1,"op":"upsert","value":\(world)}
        """
        let row = try V2.decoder.decode(V2.MemberChange.self, from: Data(change.utf8))
        guard case .world(let shared) = row.value else { return XCTFail("expected world projection") }
        XCTAssertEqual(shared.revision, "opaque")
        XCTAssertEqual(shared.snapshot?.value.stateVersion, 17)
        let view = """
        {"world":\(world),"behavior":null,"server_time":"2026-11-22T00:00:00Z",
         "publication":{"status":"remote","publisher_host_id":"host"},"execution_available":false}
        """
        let state = try V2.decoder.decode(V2.WorldView.self, from: Data(view.utf8))
        XCTAssertEqual(state.world, shared)
        XCTAssertNil(state.presence, "world_state SSE carries presence separately")
        XCTAssertFalse(state.canReport)
    }

    func testOnlyMatchingSessionAndVersionCanAcceptAction() throws {
        let observation = try V2.decoder.decode(V2.WorldObservation.self, from: Data(snapshotJSON.utf8)).value
        let session = V2.WorldIdentity(sessionId: "s", generation: "g")
        let command = WorldCommand(id: "a", sessionId: "s", generation: "g", destinationId: "pond",
                                   stateVersion: 17, activity: nil, acceptBefore: "", finishBefore: "")
        XCTAssertTrue(V2.WorldPolicy.canAccept(command, session: session, committed: observation, live: observation))
        XCTAssertFalse(V2.WorldPolicy.canAccept(command, session: .init(sessionId: "s", generation: "new"), committed: observation, live: observation))
        var newer = observation
        newer.stateVersion += 1
        XCTAssertFalse(V2.WorldPolicy.canAccept(command, session: session, committed: observation, live: newer))
    }

    @MainActor
    func testClosingOldMemberWorldDiscardsLateActionUIInSameHousehold() {
        let engine = WorldEngine()
        let household = V2.Household(id: "shared-household", name: "小院")
        func connection(for member: String) -> V2Connection {
            let identity = V2.PairResult(deviceId: "device-" + member, deviceToken: "test-token",
                member: V2.Member(id: member, householdId: household.id, displayName: member, homeHostId: "host"),
                household: household)
            return .init(hosts: ["localhost"], port: 9900, fingerprint: "", identity: identity)
        }
        var announcements: [String] = []
        var updates = 0
        let old = V2WorldBridge(connection: connection(for: "first"), engine: engine, changes: V2ChangesStore(),
            changed: { updates += 1 }, announce: { announcements.append($0) })
        old.close()
        let current = V2WorldBridge(connection: connection(for: "second"), engine: engine, changes: V2ChangesStore(),
            changed: {}, announce: { announcements.append($0) })

        old.setForeground(false)
        old.request(destination: "pond", activity: "sit")
        old.close()
        XCTAssertTrue(engine.sharedMode)
        XCTAssertTrue(announcements.isEmpty)
        XCTAssertEqual(updates, 0)
        current.close()
    }
}
