import Combine
import Foundation

extension V2 {
    struct CatDiarySnapshot: Decodable {
        struct Calendar: Decodable {
            let timeZone: String

            enum CodingKeys: String, CodingKey { case timeZone = "time_zone" }
        }

        struct Entry: Decodable, Identifiable {
            enum Origin: String, Decodable { case daily, legacy }

            let id: String
            let origin: Origin
            let localDay: String
            let recordedAt: Int64
            let text: String

            enum CodingKeys: String, CodingKey {
                case id, origin, text, localDay = "local_day", recordedAt = "recorded_at"
            }
        }

        let entries: [Entry]
        let calendar: Calendar?

        func entries(on day: String) -> [Entry] {
            entries.filter { $0.localDay == day }.sorted { ($0.recordedAt, $0.id) < ($1.recordedAt, $1.id) }
        }
    }

    struct CatDiarySource: Hashable {
        enum Kind: String { case message, diary }
        let kind: Kind
        let id: String
        let revision: Int
    }
}

extension V2Client {
    func catDiaries() async throws -> V2.CatDiarySnapshot {
        try await json(V2.CatDiarySnapshot.self, request("GET", "cat-diary"))
    }

    func catDiarySourceRequest(_ source: V2.CatDiarySource) throws -> URLRequest {
        try request("POST", "cat-diary/sources", body: [
            "kind": source.kind.rawValue, "id": source.id, "revision": source.revision,
        ])
    }

    func confirmCatDiarySource(_ source: V2.CatDiarySource) async throws {
        struct Receipt: Decodable { let confirmed: Bool; let id: String }
        let receipt = try await json(Receipt.self, catDiarySourceRequest(source))
        guard receipt.confirmed, !receipt.id.isEmpty else { throw URLError(.badServerResponse) }
    }
}

/// 每个 V2ChatStore 持有一个实例。正文每次从当前副本读取，撤回可以在同一 ID 上替换整段正文。
@MainActor
final class V2CatDiaryStore: ObservableObject {
    enum Authorization: Equatable {
        case submitting, confirmed, waitingForPublisher, unavailable, rePair, retry

        var message: String {
            switch self {
            case .submitting: return "正在请电脑确认…"
            case .confirmed: return "已确认可供团子的日记选用。"
            case .waitingForPublisher: return "发布日记的电脑暂时无法确认，请稍后重试。"
            case .unavailable: return "这条内容的当前版本已无法供团子使用。"
            case .rePair: return "配对已失效，请重新连接电脑。"
            case .retry: return "未收到电脑确认，可以重试。"
            }
        }

        var canSubmit: Bool { self == .waitingForPublisher || self == .retry }
    }

    @Published private(set) var snapshot: V2.CatDiarySnapshot?
    @Published private(set) var readError: String?
    @Published private(set) var calendarTimeZone: TimeZone?
    @Published private(set) var refreshVersion = 0
    @Published private(set) var authorization: [V2.CatDiarySource: Authorization] = [:]

    private let read: () async throws -> V2.CatDiarySnapshot
    private let authorize: (V2.CatDiarySource) async throws -> Void
    private var active = true
    private var readID: UUID?

    init(read: @escaping () async throws -> V2.CatDiarySnapshot,
         authorize: @escaping (V2.CatDiarySource) async throws -> Void) {
        self.read = read
        self.authorize = authorize
    }

    convenience init(selectClient: @escaping () async throws -> V2Client) {
        self.init(read: { try await selectClient().catDiaries() },
                  authorize: { try await selectClient().confirmCatDiarySource($0) })
    }

    func today(at date: Date, fallback: TimeZone = .current) -> String {
        DiaryDay.key(for: date, timeZone: calendarTimeZone ?? fallback)
    }

    func refresh() async {
        guard active, !Task.isCancelled else { return }
        let id = UUID()
        readID = id
        do {
            let projection = try await read()
            guard active, readID == id, !Task.isCancelled else { return }
            calendarTimeZone = projection.calendar.flatMap { TimeZone(identifier: $0.timeZone) }
            snapshot = projection
            readError = nil
        } catch {
            guard active, readID == id, !Task.isCancelled else { return }
            snapshot = nil
            readError = (error as? V2.APIError)?.code == "unauthorized"
                ? "配对已失效，请重新连接电脑。"
                : "暂时无法读取团子的日记。"
        }
    }

    func invalidateEntries() {
        readID = nil
        snapshot = nil
        readError = nil
        refreshVersion += 1
    }

    func deactivate() {
        active = false
        calendarTimeZone = nil
        invalidateEntries()
        authorization = [:]
    }

    func confirm(_ source: V2.CatDiarySource) async {
        guard active, !Task.isCancelled, authorization[source]?.canSubmit != false else { return }
        authorization[source] = .submitting
        do {
            try await authorize(source)
            guard active else { return }
            authorization[source] = .confirmed
        } catch {
            guard active else { return }
            switch (error as? V2.APIError)?.code {
            case "source_unavailable", "version_conflict":
                authorization[source] = .unavailable
                invalidateEntries()
            case "not_publisher", "publication_lease_pending", "publication_history_pending",
                 "publication_epoch_conflict", "publication_peer_ineligible":
                authorization[source] = .waitingForPublisher
            case "unauthorized":
                authorization[source] = .rePair
                invalidateEntries()
            default:
                authorization[source] = .retry
            }
        }
    }
}
