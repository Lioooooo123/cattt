import SwiftUI

extension AppStore {
    /// 不重连聊天、不改 pending turn；生成中先记下刷新请求，done 后再拉。
    func refreshInbox() {
        if let work = v2Work {
            Task { await work.refresh() }
            return
        }
        guard backend.isRemote, !backend.token.isEmpty else { return }
        syncDiary()
        guard !isWaiting, !isStreaming else { inboxRefreshPending = true; return }
        guard inboxTask == nil else { inboxRefreshPending = true; return }
        let client = api
        let generation = historyGeneration
        inboxRefreshPending = false
        inboxTask = Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                inboxTask = nil
                if inboxRefreshPending, !Task.isCancelled, backend == client.config { refreshInbox() }
            }
            do {
                var after = messages.compactMap(\.serverSequence).max() ?? 0
                if after > 0 {
                    while true {
                        let page = try await client.messages(limit: 100, after: after)
                        guard !Task.isCancelled, historyGeneration == generation, backend == client.config else { return }
                        if isWaiting || isStreaming { inboxRefreshPending = true; return }
                        for item in page {
                            if let index = messages.firstIndex(where: { $0.serverID == item.id }) {
                                messages[index].serverSequence = item.seq
                            } else { messages.append(ChatMessage(api: item)) }
                        }
                        guard page.count == 100, let seq = page.last?.seq else { break }
                        after = seq
                    }
                } else {
                    let page = try await client.messages(limit: 100)
                    guard !Task.isCancelled, historyGeneration == generation, backend == client.config, !isWaiting, !isStreaming else { inboxRefreshPending = true; return }
                    let known = Set(messages.compactMap(\.serverID))
                    messages.append(contentsOf: page.filter { !known.contains($0.id) }.map(ChatMessage.init(api:)))
                    earliestMessageSequence = messages.compactMap(\.serverSequence).min()
                }
                var letters: [APIMailboxLetter] = []
                var cursor = 0
                while true {
                    let page = try await client.mailbox(after: cursor)
                    guard !Task.isCancelled, historyGeneration == generation, backend == client.config else { return }
                    letters.append(contentsOf: page.letters)
                    guard page.hasMore, let last = page.letters.last else { break }
                    cursor = last.seq
                }
                mailboxLetters = letters.reversed()
                if mailboxLetters.contains(where: { $0.readAt == nil }) { hasMail = true }
                inboxError = nil
            } catch {
                guard backend == client.config, !Task.isCancelled else { return }
                inboxError = backend.mode == .paired ? "团子在家里的电脑上" : "信箱暂时没连上，点此重试"
            }
        }
    }

    func readLetter(_ letter: APIMailboxLetter) {
        guard v2Chat == nil, letter.readAt == nil else { return }
        let client = api
        Task { @MainActor [weak self] in
            do {
                try await client.readLetter(letter.id)
                guard let self, backend == client.config else { return }
                if let index = mailboxLetters.firstIndex(where: { $0.id == letter.id }) {
                    mailboxLetters[index].readAt = ISO8601DateFormatter().string(from: Date())
                }
                hasMail = mailboxLetters.contains(where: { $0.readAt == nil }) || entries.contains(where: \.hasUnreadCatDiary)
            } catch { self?.flash("没能记下已读，稍后再试") }
        }
    }
}
