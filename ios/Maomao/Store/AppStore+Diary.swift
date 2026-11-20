import SwiftUI
import CryptoKit

extension AppStore {
    private var diaryStorage: DiaryStorage {
        // 开发 token 暂代账号身份；只用摘要做文件名，不写明文凭据。
        let identity = backend.storageIdentity
        let digest = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return DiaryStorage(url: root.appendingPathComponent("DiaryRecords/" + digest + ".json"))
    }

    var diaryArchive: DiaryArchive { DiaryArchive(changeCursor: diaryChangeCursor, syncEpoch: diarySyncEpoch, entries: entries) }
    var diaryToday: String { DiaryDay.key(for: currentDate()) }
    var diaryDay: String { selectedDiaryDay ?? diaryToday }
    var diaryEarlierDays: [String] {
        let selected = diaryDay
        return diaryReadIndex.days.filter { $0 != selected }
    }

    func diaryEntries(on day: String) -> [DiaryEntry] { diaryReadIndex.entries(on: day) }

    func loadDiary() {
        // 先清空前一账号的界面；文件损坏时不覆盖，也不显示演示内容。
        diaryChangeCursor = nil
        diarySyncEpoch = nil
        entries = []
        diarySyncTask?.cancel()
        diarySyncTask = nil
        diarySyncAgain = false
        diarySyncFailed = false
        diarySyncFinished = false
        diaryGeneration = UUID()
        diaryRetryAfter = .distantPast
        chatSource = nil
        hasMail = false
        diaryFilter = .all
        selectedDiaryDay = nil
        captureText = ""
        captureSaveFailed = false
        captureForCat = false
        isCapturing = false
        catDiaryDate = nil
        diaryLoadFailed = false
        do {
            if let saved = try diaryStorage.load() {
                diaryChangeCursor = saved.changeCursor
                diarySyncEpoch = saved.syncEpoch
                entries = saved.entries
            } else if !backend.isRemote {
                // 旧版仅保存过一条猫日记，归入原本地空间，不导入到远端账号。
                let ud = UserDefaults.standard
                if let day = ud.object(forKey: "maomao.catDiaryDate") as? Date,
                   let text = ud.string(forKey: "maomao.catDiaryText"), !text.isEmpty {
                    var archive = DiaryArchive()
                    archive.upsertCatDiary(text: text, time: ud.string(forKey: "maomao.catDiaryTime") ?? "19:30", now: day)
                    try diaryStorage.save(archive)
                    entries = archive.entries
                }
            }
            hasMail = entries.contains(where: \.hasUnreadCatDiary)
            catDiaryDate = entries.filter { $0.kind == .cat }.map(\.createdAt).max()
        } catch {
            diaryLoadFailed = true
        }
    }

    @discardableResult
    func persistDiary(_ archive: DiaryArchive) -> Bool {
        guard !diaryLoadFailed else { flash("请先重新读取日记"); return false }
        do {
            try diaryStorage.save(archive)
            diaryChangeCursor = archive.changeCursor
            diarySyncEpoch = archive.syncEpoch
            entries = archive.entries
            return true
        } catch {
            flash("没有保存成功，请重试")
            return false
        }
    }

    func selectDiaryDay(_ day: String?) {
        selectedDiaryDay = day == diaryToday ? nil : day
        diaryFilter = .all
        if mailboxOpen { markCatDiariesRead(on: diaryDay) }
    }

    func markCatDiariesRead(on day: String) {
        var archive = diaryArchive
        var changed = false
        for i in archive.entries.indices where archive.entries[i].dayKey == day && archive.entries[i].hasUnreadCatDiary {
            archive.entries[i].catDiaryRead = true
            changed = true
        }
        if changed { _ = persistDiary(archive) }
        hasMail = entries.contains(where: \.hasUnreadCatDiary) || mailboxLetters.contains { $0.readAt == nil }
    }
}
