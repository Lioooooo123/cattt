import CryptoKit
import Foundation

struct V2LegacyDiaryMutation: Codable, Equatable {
    struct Draft: Codable, Equatable {
        let text: String
        let recordedAt: Int64
        let localDay: String
        let timeZone: String
        let catAllowed: Bool

        enum CodingKeys: String, CodingKey {
            case text, recordedAt = "recorded_at", localDay = "local_day", timeZone = "time_zone", catAllowed = "cat_allowed"
        }
    }

    let accountID: String
    let clientID: String
    let cloudID: String?
    let revokeCatAccess: Bool
    let draft: Draft?

    enum CodingKeys: String, CodingKey {
        case accountID = "source_account_id", clientID = "client_id", cloudID = "cloud_id"
        case revokeCatAccess = "revoke_cat_access", draft
    }

    static func pending(_ entry: DiaryEntry, accountID: String) -> V2ResourcePending? {
        guard entry.kind == .text, entry.needsSync else { return nil }
        let revoke = entry.pendingMutationID != nil && entry.isPrivate &&
            (entry.cloudIsPrivate == false || (entry.cloudIsPrivate == nil && entry.cloudID != nil))
        var draft: Draft?
        if entry.cloudID == nil, let ms = Int64(exactly: (entry.createdAt.timeIntervalSince1970 * 1000).rounded(.down)) {
            draft = Draft(text: entry.text, recordedAt: ms, localDay: entry.dayKey,
                          timeZone: entry.timeZoneID, catAllowed: !entry.isPrivate)
        }
        let action = V2LegacyDiaryMutation(accountID: accountID, clientID: entry.id, cloudID: entry.cloudID,
                                           revokeCatAccess: revoke, draft: draft)
        // A restored or re-paired phone must replay the same intent under the same UUID.
        let parts = ["legacy-ios-diary", accountID, entry.id, entry.pendingMutationID ?? "",
                     revoke ? "revoke" : (draft == nil ? "align" : "draft")]
        var digest = Array(SHA256.hash(data: Data(parts.joined(separator: "\u{0}").utf8)).prefix(16))
        digest[6] = (digest[6] & 0x0f) | 0x40
        digest[8] = (digest[8] & 0x3f) | 0x80
        let id = UUID(uuid: (digest[0], digest[1], digest[2], digest[3], digest[4], digest[5], digest[6], digest[7],
                             digest[8], digest[9], digest[10], digest[11], digest[12], digest[13], digest[14], digest[15]))
        let reviewGrant = entry.cloudID != nil && !entry.isPrivate && entry.pendingMutationID != nil
        return V2ResourcePending(id: id, action: .continueLegacyDiary(action), legacyGrantReview: reviewGrant ? true : nil)
    }
}

extension V2Client {
    func legacyDiaryAccount() async throws -> String? {
        struct Binding: Decodable {
            let accountID: String?
            enum CodingKeys: String, CodingKey { case accountID = "source_account_id" }
        }
        return try await json(Binding.self, request("GET", "diary/legacy")).accountID
    }
}
