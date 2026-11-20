import Foundation

struct APIDiaryEntry: Decodable {
    let id: String
    let seq: Int
    let clientId: String
    let kind: String
    let text: String
    let recordedAt: String
    let timeZone: String
    let day: String
    let time: String
    let catAllowed: Bool
    let revision: Int
    let mutationId: String
    let visit: Int
    let note: String

    func local() throws -> DiaryEntry {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = f.date(from: recordedAt) ?? ISO8601DateFormatter().date(from: recordedAt)
        guard let date, let zone = TimeZone(identifier: timeZone), let type = DiaryEntry.Kind(rawValue: kind), let seen = DiaryEntry.Visit(rawValue: visit) else { throw APIError.badResponse }
        var entry = DiaryEntry(id: clientId, time: time, kind: type, visit: seen, text: text, note: note,
                               isPrivate: !catAllowed, createdAt: date, timeZone: zone, recordedTimeZoneID: timeZone)
        guard entry.dayKey == day else { throw APIError.badResponse }
        entry.cloudID = id
        entry.cloudRevision = revision
        entry.cloudIsPrivate = !catAllowed
        return entry
    }
}

extension APIClient {
    struct DiaryPage: Decodable { let entries: [APIDiaryEntry]; let nextSeq: Int? }
    enum DiarySave { case saved(APIDiaryEntry), conflict(APIDiaryEntry) }
    struct DiaryChanges: Decodable {
        let entries: [APIDiaryEntry]
        let cursor: Int
        let hasMore: Bool
        let epoch: String?
        let reset: Bool?
    }

    func diaryChanges(after cursor: Int, epoch: String?) async throws -> DiaryChanges {
        var req = request("GET", "v1/diary/changes")
        req.url?.append(queryItems: [URLQueryItem(name: "after", value: String(cursor)),
                                     URLQueryItem(name: "epoch", value: epoch ?? "initial")])
        req.timeoutInterval = 12
        let page = try await json(DiaryChanges.self, req)
        if page.reset == true {
            guard let restoredEpoch = page.epoch, restoredEpoch != (epoch ?? "initial"),
                  page.entries.isEmpty, !page.hasMore, page.cursor == 0 else { throw APIError.badResponse }
            return page
        }
        guard page.entries.isEmpty ? (!page.hasMore && page.cursor == cursor) : page.cursor > cursor else {
            throw APIError.badResponse
        }
        return page
    }

    func diaryPage(after: Int) async throws -> DiaryPage {
        var r = request("GET", "v1/diary")
        r.url = r.url?.appending(queryItems: [URLQueryItem(name: "after_seq", value: String(after))])
        r.timeoutInterval = 12
        return try await json(DiaryPage.self, r)
    }

    func saveDiary(_ entry: DiaryEntry, epoch: String?) async throws -> DiarySave {
        guard let mutation = entry.pendingMutationID else { throw APIError.badResponse }
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var r = request("PUT", "v1/diary", body: [
            "client_id": entry.id, "kind": entry.kind.rawValue, "text": entry.text,
            "recorded_at": f.string(from: entry.createdAt), "time_zone": entry.timeZoneID,
            "day": entry.dayKey, "time": entry.time, "cat_allowed": !entry.isPrivate,
            "revision": entry.cloudRevision ?? 0, "mutation_id": mutation,
        ])
        r.setValue(epoch, forHTTPHeaderField: "X-Cattt-Diary-Epoch")
        r.timeoutInterval = 12
        let (data, response) = try await data(for: r)
        guard let http = response as? HTTPURLResponse else { throw APIError.badResponse }
        struct Envelope: Decodable { let entry: APIDiaryEntry?; let error: Failure?; struct Failure: Decodable { let code: String } }
        let envelope = try? Self.decode(Envelope.self, from: data)
        if http.statusCode == 200, let entry = envelope?.entry { return .saved(entry) }
        if http.statusCode == 409, let entry = envelope?.entry { return .conflict(entry) }
        throw APIError.http(status: http.statusCode, code: envelope?.error?.code)
    }
}
