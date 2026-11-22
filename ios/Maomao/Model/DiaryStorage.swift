import CryptoKit
import Foundation

enum DiaryDay {
    static func key(for date: Date, timeZone: TimeZone = .current) -> String {
        // FormatStyle 是值类型，Foundation 复用内部格式化器；不在每秒检查和视图读取时重建。
        date.formatted(Date.ISO8601FormatStyle(timeZone: timeZone).year().month().day())
    }

    static func label(_ key: String) -> String {
        let calendar = Calendar(identifier: .gregorian)
        let locale = Locale(identifier: "zh_CN")
        let zone = TimeZone.current
        let parser = Date.ParseStrategy(format: "\(year: .defaultDigits)-\(month: .twoDigits)-\(day: .twoDigits)",
                                        locale: locale, timeZone: zone, calendar: calendar, isLenient: false)
        let date: Date
        if let parsed = try? parser.parse(key) {
            date = parsed
        } else {
            // 保留旧版非标准日期处理，例如二月三十日规范到三月二日。
            let legacy = DateFormatter()
            legacy.calendar = calendar; legacy.locale = locale; legacy.timeZone = zone
            legacy.dateFormat = "yyyy-MM-dd"
            guard let parsed = legacy.date(from: key) else { return key }
            date = parsed
        }
        return date.formatted(Date.VerbatimFormatStyle(
            format: "\(year: .defaultDigits)年\(month: .defaultDigits)月\(day: .defaultDigits)日 · \(weekday: .wide)",
            locale: locale, timeZone: zone, calendar: calendar))
    }
}

/// 原生列表的派生读取索引；仅随 entries 更新，不参与落盘和同步。
struct DiaryReadIndex {
    let days: [String]
    let pendingUploads: [Int]
    private let byDay: [String: [DiaryEntry]]

    init(entries: [DiaryEntry]) {
        pendingUploads = entries.indices.filter { entries[$0].kind != .cat && entries[$0].needsSync }
        byDay = Dictionary(grouping: entries, by: \.dayKey).mapValues {
            let authoritative = $0.contains(where: \.isServerCatDiary)
            return $0.filter { !authoritative || $0.kind != .cat || $0.isServerCatDiary }
                .sorted { $0.createdAt < $1.createdAt }
        }
        days = byDay.keys.sorted(by: >)
    }

    func entries(on day: String) -> [DiaryEntry] { byDay[day] ?? [] }
}

struct DiaryArchive: Codable, Equatable {
    var version = 1
    var changeCursor: Int?
    var syncEpoch: String?
    var entries: [DiaryEntry] = []

    var days: [String] { Array(Set(entries.map(\.dayKey))).sorted(by: >) }

    func entries(on day: String) -> [DiaryEntry] {
        entries.filter { $0.dayKey == day }.sorted { $0.createdAt < $1.createdAt }
    }

    /// 恢复后的服务器版本可变小。本机未传的内容和撤回保留，旧分享不能自动重新授权。
    mutating func applyRestoredSnapshot(_ restored: [DiaryEntry], cursor: Int, epoch: String) -> Bool {
        var localEntries = Dictionary(uniqueKeysWithValues: entries.map { ($0.id, $0) })
        var reviewSharing = false
        entries = restored.map { remote in
            guard let local = localEntries.removeValue(forKey: remote.id) else { return remote }
            var next = remote
            if remote.isServerCatDiary { next.catDiaryRead = local.catDiaryRead }
            if local.kind != .cat && local.needsSync {
                next.text = local.text
                next.isPrivate = local.isPrivate || remote.isPrivate
                if !local.isPrivate && next.isPrivate { reviewSharing = true }
                next.pendingMutationID = UUID().uuidString
            }
            return next
        }
        for var local in localEntries.values where local.kind != .cat && local.needsSync {
            if local.cloudID != nil {
                if !local.isPrivate { reviewSharing = true }
                local.isPrivate = true
                local.cloudID = nil
                local.cloudRevision = nil
                local.cloudIsPrivate = nil
                local.pendingMutationID = UUID().uuidString
            }
            entries.append(local)
        }
        changeCursor = cursor
        syncEpoch = epoch
        return reviewSharing
    }

    /// 同一天的模板与模型改写复用一条猫日记，历史日期保留。
    mutating func upsertCatDiary(text: String, time: String, now: Date, timeZone: TimeZone = .current) {
        let day = DiaryDay.key(for: now, timeZone: timeZone)
        if let index = entries.firstIndex(where: { $0.kind == .cat && $0.dayKey == day }) {
            guard entries[index].text != text else { return }
            entries[index].text = text
            entries[index].pendingMutationID = UUID().uuidString
            return
        }
        entries.removeAll { $0.kind == .cat && $0.dayKey == day }
        entries.append(DiaryEntry(id: "cat-" + day, time: time, kind: .cat, visit: .unread,
                                  text: text, createdAt: now, timeZone: timeZone))
    }

    /// 回执到达期间又有本地操作，保留新操作，只推进已知云端版本。
    @discardableResult
    mutating func merge(_ remote: DiaryEntry, sentMutation: String? = nil) -> Bool {
        guard let i = entries.firstIndex(where: { $0.id == remote.id }) else { entries.append(remote); return false }
        let local = entries[i]
        if remote.isServerCatDiary {
            var next = remote
            next.catDiaryRead = local.catDiaryRead
            entries[i] = next
            return false
        }
        if (remote.cloudRevision ?? 0) < (local.cloudRevision ?? 0) { return false }
        // 拉取时撞上另一设备的新版本，未发送的旧分享不得借刷新版本重新授权。
        if sentMutation == nil, local.pendingMutationID != nil, local.kind == .text, !local.isPrivate,
           (remote.cloudRevision ?? 0) > (local.cloudRevision ?? 0) {
            entries[i] = remote
            return true
        }
        if let pending = local.pendingMutationID, pending != sentMutation, pending != remote.pendingMutationID {
            var next = remote
            next.text = local.text
            next.isPrivate = local.isPrivate
            next.pendingMutationID = pending
            entries[i] = next
        } else { entries[i] = remote }
        return false
    }
}

/// 一份账号一份文件。写入先完成原子替换，界面才显示保存成功。
/// 读取失败向上传递，调用方不能拿空列表覆盖原件。
struct DiaryStorage {
    let url: URL

    static func legacy(identity: String, root: URL = .applicationSupportDirectory) -> DiaryStorage {
        let digest = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
        return DiaryStorage(url: root.appendingPathComponent("DiaryRecords/" + digest + ".json"))
    }

    enum Failure: Error { case unsupportedVersion, duplicateIDs }

    func load() throws -> DiaryArchive? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let archive = try JSONDecoder().decode(DiaryArchive.self, from: Data(contentsOf: url))
        try validate(archive)
        return archive
    }

    func save(_ archive: DiaryArchive) throws {
        try validate(archive)
        let data = try JSONEncoder().encode(archive)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
    }

    private func validate(_ archive: DiaryArchive) throws {
        guard archive.version == 1 else { throw Failure.unsupportedVersion }
        guard Set(archive.entries.map(\.id)).count == archive.entries.count else { throw Failure.duplicateIDs }
    }
}
