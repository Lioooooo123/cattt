import Foundation

@main
struct DiaryStorageTests {
    static func check(_ value: Bool, _ message: String = "") { precondition(value, message) }

    static func main() throws {
        // 读取索引保留完整记录，按归档日分组、日内按创建时间排序；重建不能留旧账号内容。
        let readZone = TimeZone(secondsFromGMT: 0)!
        let readDate = ISO8601DateFormatter().date(from: "2026-11-07T12:00:00Z")!
        let readLate = DiaryEntry(id: "late", time: "12:00", kind: .text, visit: .unread, text: "私密正文",
                                  isPrivate: true, createdAt: readDate, timeZone: readZone)
        let readEarly = DiaryEntry(id: "early", time: "11:00", kind: .voice, visit: .commented, text: "语音",
                                   note: "留言", createdAt: readDate.addingTimeInterval(-3600), timeZone: readZone)
        let readOld = DiaryEntry(id: "old", time: "12:00", kind: .cat, visit: .unread, text: "昨天",
                                 createdAt: readDate.addingTimeInterval(-86400), timeZone: readZone)
        let readIndex = DiaryReadIndex(entries: [readLate, readOld, readEarly])
        check(readIndex.days == ["2026-11-07", "2026-11-06"])
        check(readIndex.entries(on: "2026-11-07") == [readEarly, readLate])
        check(readIndex.entries(on: "2026-11-06") == [readOld])
        check(readIndex.entries(on: "2026-11-05").isEmpty)
        check(DiaryReadIndex(entries: []).days.isEmpty)
        var stale = readLate
        stale.cloudID = "cloud-late"
        stale.cloudRevision = 8
        var pending = readEarly
        pending.pendingMutationID = "offline"
        var pendingShare = stale
        pendingShare.isPrivate = false
        pendingShare.pendingMutationID = "old-share"
        var recovered = stale
        recovered.cloudRevision = 3
        var oldServerOnly = readOld
        oldServerOnly.cloudID = "cloud-old"
        var resetArchive = DiaryArchive(changeCursor: 120, syncEpoch: "initial", entries: [pendingShare, pending, oldServerOnly])
        check(resetArchive.applyRestoredSnapshot([recovered], cursor: 80, epoch: "restored"), "过期的分享需要重新授权")
        check(resetArchive.changeCursor == 80 && resetArchive.syncEpoch == "restored")
        let kept = resetArchive.entries.first { $0.id == stale.id }
        check(kept?.cloudRevision == 3 && kept?.isPrivate == true && kept?.needsSync == true)
        check(resetArchive.entries.contains(pending) && !resetArchive.entries.contains(oldServerOnly))
        var readChanged = readLate
        readChanged.text = "已修改"; readChanged.isPrivate = false; readChanged.visit = .readNoComment
        let readReplaced = DiaryReadIndex(entries: [readChanged])
        check(readReplaced.entries(on: "2026-11-07") == [readChanged])
        check(readReplaced.entries(on: "2026-11-06").isEmpty)
        check(readIndex.entries(on: "2026-11-07") == [readEarly, readLate])
        // 日期键是落盘契约，不能随系统显示语言或跨日时区变化而改格式。
        let dateCases = [
            ("2026-10-18T15:59:00Z", "Asia/Shanghai", "2026-10-18"),
            ("2026-10-18T16:01:00Z", "Asia/Shanghai", "2026-10-19"),
            ("2026-12-31T10:30:00Z", "Pacific/Kiritimati", "2027-01-01"),
            ("2024-03-01T00:30:00Z", "America/Los_Angeles", "2024-02-29"),
            ("2026-03-08T10:01:00Z", "America/Los_Angeles", "2026-03-08"),
            ("2026-01-01T00:00:00Z", "Pacific/Honolulu", "2025-12-31"),
            ("2026-11-07T18:20:00Z", "Asia/Kathmandu", "2026-11-08"),
        ]
        for (instant, zone, expected) in dateCases {
            let date = ISO8601DateFormatter().date(from: instant)!
            check(DiaryDay.key(for: date, timeZone: TimeZone(identifier: zone)!) == expected, "时区归档：\(zone)")
        }
        check(DiaryDay.label("2026-11-07") == "2026年11月7日 · 星期六")
        check(DiaryDay.label("2024-02-29") == "2024年2月29日 · 星期四")
        check(DiaryDay.label("2027-01-01") == "2027年1月1日 · 星期五")
        // 沿用既有 Foundation 解析行为：二月三十日被规范到三月二日。
        check(DiaryDay.label("2026-02-30") == "2026年3月2日 · 星期一")
        for invalid in ["not-a-date", "2026-13-50"] {
            check(DiaryDay.label(invalid) == invalid, "无效日期原样保留")
        }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let a = DiaryStorage(url: root.appendingPathComponent("a/records.json"))
        let b = DiaryStorage(url: root.appendingPathComponent("b/records.json"))
        let tz = TimeZone(identifier: "Asia/Shanghai")!
        let day1 = ISO8601DateFormatter().date(from: "2026-10-18T15:59:00Z")!
        let day2 = day1.addingTimeInterval(120)
        check(try a.load() == nil)
        let legacyArchive = try JSONDecoder().decode(DiaryArchive.self, from: Data(#"{"version":1,"entries":[]}"#.utf8))
        check(legacyArchive.changeCursor == nil, "旧档案从头同步")
        var archive = DiaryArchive()
        archive.changeCursor = 47
        archive.entries.append(DiaryEntry(id: "user-1", time: "23:59", kind: .text, visit: .unread,
                                         text: "测试记录，保留换行\n和中文。", isPrivate: true, createdAt: day1, timeZone: tz))
        archive.upsertCatDiary(text: "第一天", time: "23:59", now: day1, timeZone: tz)
        archive.upsertCatDiary(text: "第二天模板", time: "00:01", now: day2, timeZone: tz)
        archive.upsertCatDiary(text: "第二天改写", time: "00:01", now: day2, timeZone: tz)
        try a.save(archive)
        let restored = try a.load()!
        check(restored == archive, "重开后完整恢复正文与私密标记")
        check(restored.entries.count == 3, "同日改写只保留一条，前一天不丢")
        check(restored.days == ["2026-10-19", "2026-10-18"])
        check(restored.entries(on: "2026-10-18").count == 2)
        check(restored.entries(on: "2026-10-19").map(\.text) == ["第二天改写"])
        check(restored.entries[0].timeZoneID == "Asia/Shanghai")
        check(restored.entries[0].dayKey == "2026-10-18", "归档日不随查看时区改变")
        check(try b.load() == nil, "另一账号不能读到记录")
        try b.save(DiaryArchive())
        check(try b.load()?.entries.isEmpty == true)
        check(try a.load() == archive, "空账号保存不能改动另一账号")

        let valid = try Data(contentsOf: a.url)
        var duplicate = archive
        duplicate.entries.append(archive.entries[0])
        do { try a.save(duplicate); fatalError("重复ID应拒绝") } catch DiaryStorage.Failure.duplicateIDs {}
        check(try Data(contentsOf: a.url) == valid, "失败不得覆盖旧文件")
        var future = archive
        future.version = 99
        try JSONEncoder().encode(future).write(to: a.url)
        do { _ = try a.load(); fatalError("未知版本应拒绝") } catch DiaryStorage.Failure.unsupportedVersion {}
        let corrupt = Data("损坏文件".utf8)
        try corrupt.write(to: a.url)
        do { _ = try a.load(); fatalError("损坏文件应报错") } catch is DecodingError {}
        check(try Data(contentsOf: a.url) == corrupt, "读取失败不得清空原文件")
        // 父路径是文件，模拟落盘失败；先前完整档案不受影响。
        let blocked = root.appendingPathComponent("blocked")
        try Data().write(to: blocked)
        do {
            try DiaryStorage(url: blocked.appendingPathComponent("records.json")).save(archive)
            fatalError("写入失败必须上抛")
        } catch {}
        try a.save(archive)
        check(try a.load() == archive, "故障修复后可以重试")
        // 旧文件没有云端字段也能读；离线操作必须和正文一起持久化。
        var queued = archive.entries[0]
        queued.pendingMutationID = "offline-grant"
        queued.isPrivate = false
        try a.save(DiaryArchive(entries: [queued]))
        check(try a.load()?.entries[0].pendingMutationID == "offline-grant")
        var reply = queued
        reply.cloudID = "server-1"; reply.cloudRevision = 1; reply.cloudIsPrivate = false; reply.pendingMutationID = nil
        var merged = DiaryArchive(entries: [queued])
        // 旧分享回执到来之前，用户已选择撤回；不得吞掉撤回。
        merged.entries[0].isPrivate = true
        merged.entries[0].pendingMutationID = "new-revoke"
        merged.merge(reply, sentMutation: "offline-grant")
        check(merged.entries[0].isPrivate && merged.entries[0].pendingMutationID == "new-revoke")
        check(merged.entries[0].cloudRevision == 1)
        check(merged.entries[0].permissionLabel == "撤回待同步")
        reply.isPrivate = true; reply.cloudIsPrivate = true; reply.cloudRevision = 2
        merged.merge(reply, sentMutation: "new-revoke")
        check(!merged.entries[0].needsSync && merged.entries[0].isPrivate)
        merged.merge(reply)
        check(merged.entries.count == 1, "拉取和回执不能制造重复")
        var staleGrant = reply
        staleGrant.isPrivate = false; staleGrant.pendingMutationID = "offline-old-grant"
        var crossDevice = DiaryArchive(entries: [staleGrant])
        var newerPrivate = reply; newerPrivate.cloudRevision = 3
        check(crossDevice.merge(newerPrivate), "拉取时的新版本不得替旧分享偷换版本")
        check(crossDevice.entries[0].isPrivate && crossDevice.entries[0].pendingMutationID == nil)
        var currentRevoke = newerPrivate
        currentRevoke.pendingMutationID = "private-wins"
        var conservative = DiaryArchive(entries: [currentRevoke])
        var newerShared = newerPrivate
        newerShared.cloudRevision = 4; newerShared.cloudIsPrivate = false; newerShared.isPrivate = false
        conservative.merge(newerShared)
        check(conservative.entries[0].isPrivate && conservative.entries[0].pendingMutationID == "private-wins")
        check(conservative.entries[0].cloudRevision == 4)
        // 猫日记改写只改正文，稳定保留来源日期、首次时间和云端版本。
        var cats = DiaryArchive()
        cats.upsertCatDiary(text: "模板", time: "23:59", now: day1, timeZone: tz)
        cats.entries[0].cloudID = "cat-server"
        cats.entries[0].cloudRevision = 1
        cats.upsertCatDiary(text: "模型改写", time: "23:59", now: day1.addingTimeInterval(20), timeZone: tz)
        check(cats.entries[0].createdAt == day1 && cats.entries[0].cloudRevision == 1)
        check(cats.entries[0].pendingMutationID != nil)
        // 服务端猫日记按日展示一篇，旧本地正文仍保留在档案里；未读按来源ID持久化。
        var legacy = DiaryEntry(id: "cat-old", time: "12:00", kind: .cat, visit: .unread, text: "旧本地正文", createdAt: day1, timeZone: tz)
        legacy.pendingMutationID = "old-pending"
        var authority = DiaryEntry(id: "daily-cat:2026-10-18", time: "12:00", kind: .cat, visit: .unread, text: "服务端正文", createdAt: day1, timeZone: tz)
        authority.cloudID = "daily-server"; authority.cloudRevision = 1
        var daily = DiaryArchive(entries: [legacy])
        daily.merge(authority); daily.merge(authority)
        check(daily.entries.count == 2, "历史不删除、重复同步不增条")
        check(DiaryReadIndex(entries: daily.entries).entries(on: "2026-10-18").map(\.text) == ["服务端正文"], "同日以服务端为准")
        check(authority.hasUnreadCatDiary && !legacy.hasUnreadCatDiary)
        daily.entries[1].catDiaryRead = true
        daily.merge(authority)
        check(!daily.entries[1].hasUnreadCatDiary, "重新拉取不重置已读")
        try a.save(daily)
        check(try a.load() == daily, "已读和原始旧记录完整恢复")
        print("日记存储：正文/换行/私密、日期边界、同日改写、历史保留、分区、损坏与写入失败检查通过")
    }
}
