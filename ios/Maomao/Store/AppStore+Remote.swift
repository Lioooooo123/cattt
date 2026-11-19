import SwiftUI
import CryptoKit

/// 聊天接真后端（server/）。事件和气泡状态的对应见 docs/方案/后端-开发者版-方案-2026-09-11.md 第 8 节：
///
/// | 气泡状态 | 什么时候 |
/// |---|---|
/// | sending | 请求发出，还没收到 accepted |
/// | sent | 收到 accepted |
/// | failed | accepted 之前连不上；重试用同一个 client_message_id，服务端不会存两条 |
/// | streaming | 收到第一个 delta |
/// | stopped | 用户按停止 |
/// | timeout | accepted 后 50 秒没有字，或收到 error；「再试一次」只让猫重新回 |
/// | done | 收到 done |
///
/// 流在结束之前断了（切后台、网络抖）就带着最后一个事件 id 续传，最多三次。
extension AppStore {
    enum TurnRequest: Codable {
        case send(clientMessageID: String, text: String)
        case reply(userMessageID: String, requestID: String)
        case resume(turnID: String)
    }

    /// 只保存尚未对账的一轮；账号和服务器隔离，键中不包含明文 token。
    struct PendingChat: Codable {
        var request: TurnRequest
        var userLocalID: String?
        var turnID: String?
        var diaryEntryID: String? = nil
    }

    private var pendingChatKey: String {
        let identity = backend.storageIdentity
        let digest = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
        return "chat.pending.v1." + digest
    }

    private func savePendingChat(_ pending: PendingChat?) {
        if let pending, let data = try? JSONEncoder().encode(pending) {
            UserDefaults.standard.set(data, forKey: pendingChatKey)
        } else {
            UserDefaults.standard.removeObject(forKey: pendingChatKey)
        }
    }

    private func recoverPendingChat(generation: UUID, client: APIClient) async throws {
        guard let data = UserDefaults.standard.data(forKey: pendingChatKey),
              let pending = try? JSONDecoder().decode(PendingChat.self, from: data) else { return }
        let remoteGeneration = remoteChatGeneration
        if let turnID = pending.turnID {
            let turn = try await client.turn(turnID)
            guard historyGeneration == generation, remoteChatGeneration == remoteGeneration, backend == client.config else { return }
            if let id = turn.catMessageId, messages.contains(where: { $0.serverID == id }) {
                savePendingChat(nil)
                return
            }
            if turn.status == "superseded" {
                savePendingChat(nil)
                return
            }
            if turn.status == "failed" {
                savePendingChat(nil)
                showRemoteFailure(code: "failed", catLocalID: nil)
                return
            }
            // 重启没有保留半截气泡，从头回放同一轮；Redis 过期时服务端给 DB snapshot。
            startRemoteTurn(.resume(turnID: turnID), userLocalID: nil)
        } else if case let .send(clientMessageID, text) = pending.request {
            let id = pending.userLocalID ?? "u" + clientMessageID
            // accepted 丢失时，历史可能已有用户那句，复用它的本地 ID。
            let existing = messages.first { $0.clientMessageID == clientMessageID }?.id
            if existing == nil {
                messages.append(ChatMessage(id: id, role: .user, text: text, state: .sending))
            }
            startRemoteTurn(pending.request, userLocalID: existing ?? id, diaryEntryID: pending.diaryEntryID)
        } else if case .reply = pending.request {
            startRemoteTurn(pending.request, userLocalID: nil)
        }
    }

    var api: APIClient { APIClient(config: backend) }

    // MARK: - 连接

    func setBackendMode(_ mode: BackendConfig.Mode) {
        guard backend.mode != mode else { return }
        inboxTask?.cancel(); inboxTask = nil; inboxRefreshPending = false
        mailboxLetters = []; inboxError = nil
        showsMemoryControls = false
        withdrawnSource = nil
        cancelEverything()
        resetHistoryPaging()
        watchdogTask?.cancel()
        isWaiting = false
        isStreaming = false
        backend.mode = mode
        if mode == .mock {
            worldBridge?.stop(); worldBridge = nil
            messages = SeedData.messages
            memoryCount = 37
            boundaryCount = 2
            backendStatus = nil
        } else {
            connectBackend()
        }
    }

    /// 接后端时拉最近 50 条聊天记录和「我的」页的两个数。
    func connectBackend() {
        allowProactive = false; proactiveBusy = false; proactiveError = nil
        inboxTask?.cancel(); inboxTask = nil; inboxRefreshPending = false
        mailboxLetters = []; inboxError = nil
        showsMemoryControls = false
        withdrawnSource = nil
        chatTask?.cancel()
        watchdogTask?.cancel()
        remoteTurnID = nil
        isWaiting = false
        isStreaming = false
        resetHistoryPaging()
        let generation = historyGeneration
        let remoteGeneration = remoteChatGeneration
        let client = api
        worldBridge?.stop(); worldBridge = nil
        guard backend.isRemote else { return }
        guard !backend.token.isEmpty else {
            backendStatus = "还没填 token"
            return
        }
        if !timeZoneReportedBackends.contains(client.config) {
            timeZoneReportedBackends.append(client.config)
            Task { try? await client.reportTimeZone() }
        }
        worldBridge = WorldBridge(engine: world, api: api, onInbox: { [weak self] in self?.refreshInbox() })
        worldBridge?.start()
        backendStatus = "连接中…"
        // 连不上时别留着本地模拟的示例对话，看着像真的
        if messages == SeedData.messages { messages = [] }
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                if client.config.mode == .paired {
                    let account = try await client.account()
                    guard backend == client.config else { return }
                    applyServerProfile(account.cat)
                }
                let history = try await client.messages(limit: 50)
                guard historyGeneration == generation, remoteChatGeneration == remoteGeneration, backend == client.config else { return }
                messages = history.map(ChatMessage.init(api:))
                earliestMessageSequence = history.map(\.seq).min()
                hasEarlierMessages = history.count == 50
                try await recoverPendingChat(generation: generation, client: client)
                await refreshCounts()
                await refreshProactivePermission()
                refreshInbox()
                guard historyGeneration == generation, backend == client.config else { return }
                backendStatus = "已连接 · \(history.count) 条记录"
                registerNotificationDevice()
                resolveNotificationIntent()
            } catch {
                guard historyGeneration == generation, backend == client.config else { return }
                backendStatus = backend.mode == .paired ? "团子在家里的电脑上" : "连不上：\(error.localizedDescription)"
            }
        }
    }

    private func resetHistoryPaging() {
        historyGeneration = UUID()
        earliestMessageSequence = nil
        hasEarlierMessages = false
        isLoadingEarlierMessages = false
        historyLoadError = nil
    }

    /// 返回是否插入了旧页；失败保留游标，下一次从同一位置重试。
    @discardableResult
    func loadEarlierMessages() async -> Bool {
        guard backend.isRemote, hasEarlierMessages, !isLoadingEarlierMessages,
              let before = earliestMessageSequence else { return false }
        let generation = historyGeneration
        let client = api
        isLoadingEarlierMessages = true
        historyLoadError = nil
        defer {
            if historyGeneration == generation { isLoadingEarlierMessages = false }
        }
        do {
            let page = try await client.messages(limit: 50, before: before)
            guard historyGeneration == generation, backend == client.config else { return false }
            let older = page.filter { $0.seq < before }.sorted { $0.seq < $1.seq }
            var known = Set(messages.map { $0.serverID ?? $0.id })
            let additions = older.filter { known.insert($0.id).inserted }.map(ChatMessage.init(api:))
            if let next = older.first?.seq { earliestMessageSequence = next }
            hasEarlierMessages = page.count == 50 && !older.isEmpty
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) { messages.insert(contentsOf: additions, at: 0) }
            return !additions.isEmpty
        } catch {
            guard historyGeneration == generation, backend == client.config else { return false }
            historyLoadError = "没能加载，点此重试"
            return false
        }
    }

    func refreshCounts() async {
        let client = api
        guard let counts = try? await client.counts(), backend == client.config else { return }
        memoryCount = counts.memories
        boundaryCount = counts.boundaries
    }

    // MARK: - 一轮回复

    func remoteSend(localID: String, text: String) {
        // 本地 id 是 "u" + client_message_id，重试时拆回来用同一个
        startRemoteTurn(.send(clientMessageID: String(localID.dropFirst()), text: text), userLocalID: localID,
                        diaryEntryID: messages.first(where: { $0.id == localID })?.diaryEntryID)
    }

    func remoteReply(to userMessageID: String) {
        isWaiting = true
        startRemoteTurn(.reply(userMessageID: userMessageID, requestID: UUID().uuidString), userLocalID: nil)
    }

    private func startRemoteTurn(_ request: TurnRequest, userLocalID: String?, diaryEntryID: String? = nil) {
        // 等回复时又发了一句：旧的流直接断开，服务端会把还没开口的旧一轮作废
        chatTask?.cancel()
        watchdogTask?.cancel()
        remoteChatGeneration = UUID()
        remoteStopped = false
        remoteTurnID = nil
        isWaiting = true
        isStreaming = false
        var pending = PendingChat(request: request, userLocalID: userLocalID, diaryEntryID: diaryEntryID)
        if case let .resume(turnID) = request { pending.turnID = turnID }
        savePendingChat(pending)
        chatTask = Task { @MainActor [weak self] in
            await self?.runRemoteTurn(request, userLocalID: userLocalID, diaryEntryID: diaryEntryID)
        }
    }

    private func runRemoteTurn(_ request: TurnRequest, userLocalID: String?, diaryEntryID: String?) async {
        let generation = historyGeneration
        let client = api
        var turnID: String?
        if case let .resume(id) = request { turnID = id; remoteTurnID = id; armWatchdog(turnID: id) }
        var lastEventID: String?
        var catLocalID: String?
        var acceptedUserMessageID: String?
        var resumes = 0

        while !Task.isCancelled {
            let stream: AsyncThrowingStream<SSEEvent, Error>
            if let turnID {
                stream = client.resume(turnID: turnID, after: lastEventID)
            } else {
                switch request {
                case let .send(clientMessageID, text): stream = client.send(clientMessageID: clientMessageID, text: text, diaryEntryID: diaryEntryID)
                case let .reply(userMessageID, requestID): stream = client.reply(to: userMessageID, requestID: requestID)
                case let .resume(id): stream = client.resume(turnID: id, after: nil)
                }
            }

            do {
                for try await event in stream {
                    guard !Task.isCancelled, historyGeneration == generation, backend == client.config else { return }
                    if let id = event.id { lastEventID = id }
                    switch event.event {
                    case "accepted":
                        guard turnID == nil else { continue }
                        let data = try APIClient.decode(TurnEventData.Accepted.self, from: event.data)
                        acceptedUserMessageID = data.userMessageId
                        turnID = data.turnId
                        remoteTurnID = data.turnId
                        savePendingChat(PendingChat(request: request, userLocalID: userLocalID, turnID: data.turnId))
                        if let userLocalID {
                            setState(.sent, for: userLocalID)
                            setServerID(data.userMessageId, for: userLocalID)
                        }
                        isWaiting = true
                        armWatchdog(turnID: data.turnId)

                    case "delta", "snapshot":
                        guard !remoteStopped else { continue }
                        watchdogTask?.cancel()
                        let data = try APIClient.decode(TurnEventData.Delta.self, from: event.data)
                        let id = catLocalID ?? {
                            let id = "c" + UUID().uuidString
                            catLocalID = id
                            isWaiting = false
                            isStreaming = true
                            messages.append(ChatMessage(id: id, role: .cat, text: "", state: .streaming))
                            return id
                        }()
                        if let index = messages.firstIndex(where: { $0.id == id }) {
                            if event.event == "snapshot" { messages[index].text = data.text }
                            else { messages[index].text += data.text }
                        }

                    case "done":
                        watchdogTask?.cancel()
                        let data = try APIClient.decode(TurnEventData.Done.self, from: event.data)
                        isWaiting = false
                        isStreaming = false
                        if let messageId = data.messageId,
                           let existing = messages.first(where: { $0.serverID == messageId }), existing.id != catLocalID {
                            if let catLocalID { messages.removeAll { $0.id == catLocalID } }
                            catLocalID = existing.id
                        }
                        savePendingChat(nil)
                        remoteTurnID = nil
                        refreshInbox()
                        if let catLocalID {
                            if let messageId = data.messageId { setServerID(messageId, for: catLocalID) }
                            if !remoteStopped { setState(data.status == "stopped" ? .stopped : .done, for: catLocalID) }
                        }
                        requestNotificationPermissionAfterAgreement(sourceMessageID: acceptedUserMessageID)
                        if let turnID { pollRemembered(turnID: turnID, catLocalID: catLocalID) }
                        return

                    case "superseded":
                        watchdogTask?.cancel()
                        savePendingChat(nil)
                        remoteTurnID = nil
                        isWaiting = false
                        isStreaming = false
                        // 用户补了一句，新的一轮会把两句一起回。
                        return

                    case "error":
                        watchdogTask?.cancel()
                        let data = try APIClient.decode(TurnEventData.Failure.self, from: event.data)
                        savePendingChat(nil)
                        remoteTurnID = nil
                        showRemoteFailure(code: data.code, catLocalID: catLocalID)
                        return

                    default:
                        break
                    }
                }
            } catch {
                if Task.isCancelled || historyGeneration != generation || backend != client.config { return }
                if turnID == nil {
                    // 服务端还没收下：用户那句标失败，点注文重发
                    failBeforeAccepted(userLocalID: userLocalID, error: error)
                    return
                }
            }

            // 流在结束事件之前断了
            if Task.isCancelled { return }
            guard turnID != nil else {
                failBeforeAccepted(userLocalID: userLocalID, error: nil)
                return
            }
            resumes += 1
            if resumes > 3 {
                showRemoteFailure(code: "network", catLocalID: catLocalID)
                return
            }
            try? await Self.sleep(500 * resumes)
        }
    }

    private func failBeforeAccepted(userLocalID: String?, error: Error?) {
        watchdogTask?.cancel()
        if let userLocalID {
            isWaiting = false
            setState(.failed, for: userLocalID)
        } else {
            showRemoteFailure(code: "network", catLocalID: nil)
        }
        if let error { backendStatus = backend.mode == .paired ? "团子在家里的电脑上" : "发送失败：\(error.localizedDescription)" }
    }

    /// 回复没成：撤掉说到一半的气泡，换成「它走神了 · 再试一次」。
    /// 重试也没用的错误（余额不足、key 不对）另外弹一句说明，开发者版直接说原因。
    private func showRemoteFailure(code: String, catLocalID: String?) {
        watchdogTask?.cancel()
        isWaiting = false
        isStreaming = false
        if let catLocalID { messages.removeAll { $0.id == catLocalID } }
        messages.append(ChatMessage(id: "c" + UUID().uuidString, role: .cat, text: "", state: .timeout))
        switch code {
        case "model_daily_budget": flash("今天先歇一会儿，明天再聊")
        case "model_quota": flash("模型余额不足")
        case "model_auth": flash("模型 key 不对")
        case "model_bad_request": flash("请求被模型拒绝了")
        case "network": flash("连不上后端")
        default: break
        }
    }

    /// 工具循环允许 45 秒；客户端留 5 秒传输余量，不在工具阶段提前停止。
    private func armWatchdog(turnID: String) {
        watchdogTask?.cancel()
        watchdogTask = Task { @MainActor [weak self] in
            try? await Self.sleep(50_000)
            guard !Task.isCancelled, let self else { return }
            chatTask?.cancel()
            let api = api
            Task { try? await api.cancel(turnID: turnID) }
            showRemoteFailure(code: "timeout", catLocalID: nil)
        }
    }

    /// 停止：界面立刻停住；服务端那边按已生成的字存成 stopped。
    /// 流不断开，等 done 回来拿到服务端的消息 id（「不要再提」要用）。
    func remoteStop() {
        remoteStopped = true
        isStreaming = false
        isWaiting = false
        var visibleLength: Int?
        if let index = messages.firstIndex(where: { $0.state == .streaming }) {
            messages[index].state = .stopped
            visibleLength = messages[index].text.utf16.count
        }
        guard let turnID = remoteTurnID else { return }
        let api = api
        Task { try? await api.cancel(turnID: turnID, visibleLength: visibleLength) }
    }

    /// 记忆是回复之后在后台提取的，done 的时候还不知道记没记下。每 2 秒问一次，最多 10 秒。
    private func pollRemembered(turnID: String, catLocalID: String?) {
        let client = api
        let generation = historyGeneration
        Task { @MainActor [weak self] in
            for _ in 0..<5 {
                try? await Self.sleep(2000)
                guard let self, historyGeneration == generation, backend == client.config else { return }
                guard let turn = try? await client.turn(turnID) else { continue }
                guard historyGeneration == generation, backend == client.config else { return }
                guard turn.extracted else { continue }
                if turn.remembered, let catLocalID,
                   let index = messages.firstIndex(where: { $0.id == catLocalID }) {
                    messages[index].remembered = true
                    flash("记下了")
                }
                await refreshCounts()
                return
            }
        }
    }

    // MARK: - 其他

    func remoteMarkBoundary(messageID: String) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let client = api
                try await client.markBoundary(messageID: messageID)
                guard backend == client.config else { return }
                if let index = messages.firstIndex(where: { $0.serverID == messageID }) { messages[index].boundary = true }
                await refreshCounts()
            } catch {
                flash("没记上，稍后再试")
            }
        }
    }

    /// 创建流程走完：名字、外观、气质、四条特征写到服务端。
    func remoteUpdateCat() {
        // 配对后档案以电脑为准；不能把演示/创建草稿自动覆盖上去。
        guard backend.mode != .paired else { return }
        let traits = Dictionary(uniqueKeysWithValues: traitLevels.map { ($0.key.rawValue, $0.value) })
        let (name, appearance, temperament) = (catName, pickedAppearance, temperament.rawValue)
        let client = api
        let profileID = creationArchive.profile?.id
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                guard backend == client.config, creationArchive.profile?.id == profileID else { return }
                try await client.updateCat(name: name, appearance: appearance, temperament: temperament, traits: traits)
            } catch {
                guard backend == client.config, creationArchive.profile?.id == profileID else { return }
                backendStatus = "猫的设定没存上：\(error.localizedDescription)"
            }
        }
    }

    private func setServerID(_ serverID: String, for localID: String) {
        guard let index = messages.firstIndex(where: { $0.id == localID }) else { return }
        messages[index].serverID = serverID
    }
}

extension ChatMessage {
    /// 历史记录：用户的都算已发送，猫的按服务端状态。
    init(api message: APIMessage) {
        self.init(
            id: message.id,
            role: message.role == "cat" ? .cat : .user,
            text: message.text,
            state: message.role == "cat" ? (message.status == "stopped" ? .stopped : .done) : .sent,
            remembered: message.remembered,
            boundary: message.boundary,
            sourceWithdrawn: message.contextAllowed == false,
            serverID: message.id,
            serverSequence: message.seq,
            clientMessageID: message.clientMessageId,
            diaryEntryID: message.diaryEntryId
        )
    }
}
