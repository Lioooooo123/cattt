import Foundation
import XCTest
@testable import Maomao

@MainActor
final class V2LegacyDiaryTests: XCTestCase {
    private let account = "10000000-0000-4000-8000-000000000001"
    private var paired: PairedHost {
        .init(hosts: ["localhost"], port: 8788, fingerprint: String(repeating: "1", count: 64),
              deviceID: "old-device", deviceToken: "fixture-only", accountID: account)
    }

    func testOnlyBoundPairedArchiveContinuesWithOriginalDateAndPermission() async throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let old = DiaryStorage.legacy(identity: paired.storageIdentity, root: root)
        let mock = DiaryStorage.legacy(identity: "local-only", root: root)
        let draft = entry("draft", allowed: true)
        try old.save(.init(entries: [draft]))
        try mock.save(.init(entries: [entry("mock", allowed: false)]))
        let original = try Data(contentsOf: old.url)
        let simulated = try Data(contentsOf: mock.url)
        var sent: [V2ResourcePending] = []
        let owner = makeStore("owner", root: root) { sent.append($0); return self.acknowledgement }
        let partner = makeStore("partner", root: root) { _ in XCTFail("Partner transmitted the legacy archive"); return self.acknowledgement }

        await partner.resumeLegacyDiary(from: paired, root: root, readBinding: { nil })
        await owner.resumeLegacyDiary(from: nil, root: root, readBinding: { XCTFail("Unpaired space was queried"); return self.account })
        await owner.resumeLegacyDiary(from: paired, root: root, readBinding: { "another-account" })
        XCTAssertTrue(sent.isEmpty)
        await owner.resumeLegacyDiary(from: paired, root: root, readBinding: { self.account })
        XCTAssertEqual(sent.count, 1)
        guard case .continueLegacyDiary(let migration) = try XCTUnwrap(sent.first).action else {
            return XCTFail("Wrong action")
        }
        XCTAssertEqual(migration.clientID, draft.id)
        XCTAssertEqual(migration.draft?.localDay, "2025-01-04")
        XCTAssertEqual(migration.draft?.timeZone, "Asia/Kuala_Lumpur")
        XCTAssertEqual(migration.draft?.catAllowed, true)
        let request = try V2Client(baseURL: URL(string: "https://localhost")!, token: "fixture-only", session: .shared)
            .resourceRequest(.continueLegacyDiary(migration), id: sent[0].id)
        XCTAssertEqual(request.httpMethod, "PUT")
        XCTAssertEqual(request.url?.path, "/v2/diary/legacy")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Idempotency-Key"), sent[0].id.uuidString.lowercased())
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(request.httpBody)) as? [String: Any])
        XCTAssertEqual(json["source_account_id"] as? String, account)
        XCTAssertEqual((json["draft"] as? [String: Any])?["recorded_at"] as? Int64, 1_735_927_200_000)
        XCTAssertEqual(try Data(contentsOf: old.url), original)
        XCTAssertEqual(try Data(contentsOf: mock.url), simulated)
    }

    func testOfflineRestartRetainsDraftAndSameWithdrawalRequest() async throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let old = DiaryStorage.legacy(identity: paired.storageIdentity, root: root)
        var pendingWithdrawal = entry("withdraw", allowed: false)
        pendingWithdrawal.cloudID = "60000000-0000-4000-8000-000000000001"
        pendingWithdrawal.cloudIsPrivate = false
        pendingWithdrawal.pendingMutationID = UUID().uuidString
        var staleGrant = entry("grant", allowed: true)
        staleGrant.cloudID = "60000000-0000-4000-8000-000000000002"
        staleGrant.cloudIsPrivate = true
        staleGrant.pendingMutationID = UUID().uuidString
        try old.save(.init(entries: [entry("draft", allowed: false), pendingWithdrawal, staleGrant]))
        let offline = makeStore("owner", root: root) { _ in throw URLError(.notConnectedToInternet) }
        await offline.resumeLegacyDiary(from: paired, root: root, readBinding: { self.account })
        let staged = offline.pendingRequests
        XCTAssertEqual(staged.count, 3)

        var replayed: [V2ResourcePending] = []
        let restarted = makeStore("owner", root: root) {
            replayed.append($0)
            if case .continueLegacyDiary(let migration) = $0.action, migration.clientID == "grant" {
                return .diary(.value(.init(id: "imported", revision: 3, updatedAt: 1, ownerMemberID: "owner",
                    text: "较新正文", recordedAt: 1_735_927_200_000, localDay: "2025-01-04",
                    timeZone: "Asia/Kuala_Lumpur", catAllowed: false, catReadable: false, source: nil, canEdit: true)))
            }
            return self.acknowledgement
        }
        XCTAssertEqual(restarted.pendingRequests, staged)
        await restarted.resumeLegacyDiary(from: nil, root: root, readBinding: { XCTFail("Should replay saved work"); return nil })
        XCTAssertEqual(replayed.map(\.id), staged.map(\.id))
        XCTAssertEqual(replayed.map(\.action), staged.map(\.action))
        XCTAssertEqual(restarted.pendingRequests.map(\.errorCode), ["legacy_grant_review"])
        let migrations = replayed.compactMap { item -> V2LegacyDiaryMutation? in
            if case .continueLegacyDiary(let mutation) = item.action { return mutation }
            return nil
        }
        XCTAssertEqual(migrations.first { $0.clientID == "withdraw" }?.revokeCatAccess, true)
        XCTAssertEqual(migrations.first { $0.clientID == "grant" }?.revokeCatAccess, false)
        XCTAssertNil(migrations.first { $0.clientID == "grant" }?.draft)
        XCTAssertEqual(migrations.first { $0.clientID == "draft" }?.draft?.text, "本机草稿")
        await restarted.resumeLegacyDiary(from: paired, root: root, readBinding: { XCTFail("Already staged"); return nil })
        XCTAssertEqual(replayed.count, 3)

        let repaired = makeStore("owner", device: "new-device", root: root) { replayed.append($0); return self.acknowledgement }
        await repaired.resumeLegacyDiary(from: paired, root: root, readBinding: { self.account })
        XCTAssertEqual(Array(replayed.suffix(3)).map(\.id), staged.map(\.id))
    }

    private var acknowledgement: V2ResourceChange {
        .diary(.deleted(.init(id: "tombstone", revision: 4, deletedAt: 1)))
    }

    private func entry(_ id: String, allowed: Bool) -> DiaryEntry {
        .init(id: id, time: "02:00", kind: .text, visit: .unread, text: "本机草稿",
              isPrivate: !allowed, createdAt: Date(timeIntervalSince1970: 1_735_927_200),
              timeZone: TimeZone(identifier: "Asia/Kuala_Lumpur")!)
    }

    private func temporaryDirectory() throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func makeStore(_ member: String, device: String = "device", root: URL,
                           send: @escaping (V2ResourcePending) async throws -> V2ResourceChange) -> V2ResourceStore {
        let identity = V2.PairResult(deviceId: device, deviceToken: "fixture-only",
            member: .init(id: member, householdId: "household", displayName: member, homeHostId: "host"),
            household: .init(id: "household", name: "家"))
        return V2ResourceStore(identity: identity, changes: V2ChangesStore(), directory: root,
            selectClient: { throw URLError(.notConnectedToInternet) }, send: send)
    }
}
