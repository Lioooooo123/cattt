import SwiftUI

extension AppStore {
    var diarySyncLabel: String {
        if !backend.isRemote { return "仅存本机" }
        if diarySyncFailed { return "同步未完成 · 重试" }
        if diarySyncTask != nil { return "正在同步" }
        if !diarySyncFinished || !diaryReadIndex.pendingUploads.isEmpty { return "等待同步" }
        return "已同步"
    }

    func syncDiary() {
        guard backend.isRemote, !backend.token.isEmpty, !diaryLoadFailed else { return }
        guard diarySyncTask == nil else { diarySyncAgain = true; return }
        let generation = diaryGeneration
        let client = api
        diarySyncFailed = false
        diarySyncTask = Task { @MainActor [weak self] in
            guard let self else { return }
            defer { if diaryGeneration == generation { diarySyncTask = nil } }
            do {
                repeat {
                    diarySyncAgain = false
                    try await performDiarySync(client: client, generation: generation)
                } while diarySyncAgain && !Task.isCancelled
                diarySyncFinished = true
                diarySyncFailed = false
            } catch {
                if diaryGeneration == generation && !Task.isCancelled { diarySyncFailed = true }
            }
        }
    }

    private func checkDiarySync(_ generation: UUID, _ client: APIClient) throws {
        try Task.checkCancellation()
        guard diaryGeneration == generation, backend == client.config else { throw CancellationError() }
    }

    private func performDiarySync(client: APIClient, generation: UUID) async throws {
        try checkDiarySync(generation, client)
        var firstPage: APIClient.DiaryChanges?
        do {
            firstPage = try await client.diaryChanges(after: diaryChangeCursor ?? 0, epoch: diarySyncEpoch)
            try checkDiarySync(generation, client)
        } catch APIError.http(status: 404, code: _) {
            // 旧版服务端只支持创建序号分页。
        }
        let supportsChanges = firstPage != nil
        if let page = firstPage, page.reset == true, let epoch = page.epoch {
            try await reloadRestoredDiary(epoch: epoch, client: client, generation: generation)
            firstPage = nil
        }
        let writeEpoch = firstPage?.epoch ?? diarySyncEpoch
        var prepared = diaryArchive
        let pending = diaryReadIndex.pendingUploads
        let missingKeys = pending.filter { prepared.entries[$0].pendingMutationID == nil }
        for i in missingKeys { prepared.entries[i].pendingMutationID = UUID().uuidString }
        if !missingKeys.isEmpty, !persistDiary(prepared) { throw APIError.badResponse }
        let pendingIDs = pending.map { prepared.entries[$0].id }
        for id in pendingIDs {
            for _ in 0..<3 {
                guard let sent = entries.first(where: { $0.id == id }), let mutation = sent.pendingMutationID else { break }
                let result = try await client.saveDiary(sent, epoch: writeEpoch)
                try checkDiarySync(generation, client)
                var archive = diaryArchive
                switch result {
                case .saved(let value): archive.merge(try value.local(), sentMutation: mutation)
                case .conflict(let value):
                    var remote = try value.local()
                    // 撤回优先重试；过期的分享不能自动重新授权。
                    if let local = entries.first(where: { $0.id == id }), local.isPrivate, value.catAllowed, local.kind == .text {
                        remote.isPrivate = true
                        remote.pendingMutationID = UUID().uuidString
                    } else { flash("记录已在其他设备更新，已刷新") }
                    if let i = archive.entries.firstIndex(where: { $0.id == id }) { archive.entries[i] = remote }
                }
                guard persistDiary(archive) else { throw APIError.badResponse }
            }
        }
        if supportsChanges {
            var prefetched = pendingIDs.isEmpty ? firstPage : nil
            repeat {
                let page: APIClient.DiaryChanges
                if let first = prefetched { page = first; prefetched = nil }
                else { page = try await client.diaryChanges(after: diaryChangeCursor ?? 0, epoch: diarySyncEpoch) }
                try checkDiarySync(generation, client)
                if page.reset == true { diarySyncAgain = true; return }
                try applyDiaryPage(page.entries, cursor: page.cursor, epoch: page.epoch)
                if !page.hasMore { return }
            } while !Task.isCancelled
        } else {
            var after = 0
            repeat {
                let page = try await client.diaryPage(after: after)
                try checkDiarySync(generation, client)
                try applyDiaryPage(page.entries, cursor: nil, epoch: nil)
                guard let next = page.nextSeq else { return }
                guard next > after else { throw APIError.badResponse }
                after = next
            } while !Task.isCancelled
        }
    }

    private func reloadRestoredDiary(epoch: String, client: APIClient, generation: UUID) async throws {
        var restored: [String: DiaryEntry] = [:]
        var cursor = 0
        while true {
            let page = try await client.diaryChanges(after: cursor, epoch: epoch)
            try checkDiarySync(generation, client)
            guard page.epoch == epoch, page.reset != true else { throw APIError.badResponse }
            for row in page.entries {
                let entry = try row.local()
                restored[entry.id] = entry
            }
            cursor = page.cursor
            if !page.hasMore { break }
        }
        var archive = diaryArchive
        let reviewSharing = archive.applyRestoredSnapshot(Array(restored.values), cursor: cursor, epoch: epoch)
        guard persistDiary(archive) else { throw APIError.badResponse }
        chatSource = nil
        if mailboxOpen { markCatDiariesRead(on: diaryDay) }
        if entries.contains(where: \.hasUnreadCatDiary) { hasMail = true }
        if reviewSharing { flash("已同步恢复后的日记，请重新选择分享权限") }
    }

    private func applyDiaryPage(_ rows: [APIDiaryEntry], cursor: Int?, epoch: String?) throws {
        var archive = diaryArchive
        archive.changeCursor = cursor
        archive.syncEpoch = epoch
        var mail = false
        for row in rows {
            let remote = try row.local()
            let old = entries.first(where: { $0.id == remote.id })
            if remote.visit > (old?.visit ?? .unread), !remote.isPrivate { mail = true }
            if remote.hasUnreadCatDiary && old == nil { mail = true }
            if archive.merge(remote) { flash("记录已在其他设备更新，请重新选择权限") }
        }
        // 磁盘成功后才推进游标，失败或进程中断后可安全重读同一页。
        if archive != diaryArchive, !persistDiary(archive) { throw APIError.badResponse }
        if mailboxOpen { markCatDiariesRead(on: diaryDay) }
        if (mail && !mailboxOpen) || entries.contains(where: \.hasUnreadCatDiary) { hasMail = true }
    }

    func setDiaryVisibility(_ entry: DiaryEntry, forCat: Bool) {
        guard backend.isRemote, let i = entries.firstIndex(where: { $0.id == entry.id }), entry.kind == .text else { return }
        var archive = diaryArchive
        archive.entries[i].isPrivate = !forCat
        archive.entries[i].pendingMutationID = UUID().uuidString
        if persistDiary(archive) {
            if !forCat {
                chatSource = nil
                if isStreaming || isWaiting { stopStreaming() }
            }
            syncDiary()
        }
    }
}
