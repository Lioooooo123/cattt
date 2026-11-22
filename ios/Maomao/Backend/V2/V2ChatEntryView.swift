import SwiftUI

struct V2ChatEntryView: View {
    @ObservedObject var chat: V2ChatStore
    @EnvironmentObject private var store: AppStore
    @State private var selected: V2.Conversation?
    var body: some View {
        NavigationStack {
            ZStack {
                PageBackground().ignoresSafeArea()
                VStack(spacing: 20) {
                    if let error = chat.error { Text(error).font(Typo.sans(14)).foregroundStyle(Palette.ink2) }
                    if chat.loading { ProgressView("正在连接家里的电脑…") }
                    ListContainer {
                        ForEach(chat.conversations) { conversation in
                            Button { selected = conversation } label: {
                                HStack(spacing: 16) {
                                    VStack(alignment: .leading, spacing: 8) {
                                        Text(conversation.title).font(Typo.serif(19)).foregroundStyle(Palette.ink)
                                        Text(subtitle(conversation)).font(Typo.sans(14)).foregroundStyle(Palette.ink2).lineLimit(2)
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    Icons.chevronRight(color: Palette.ink2).frame(width: 20, height: 20)
                                }
                                .padding(20).frame(minHeight: 88)
                                .contentShape(Rectangle())
                            }.buttonStyle(.plain)
                            if conversation.kind == .group { Divider().padding(.horizontal, 20) }
                        }
                    }
                    if chat.conversations.isEmpty && !chat.loading {
                        TextLink(text: "重新连接") { Task { await chat.load() } }
                    }
                    Spacer()
                }.padding(20)
            }
            .navigationTitle("聊会儿").navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Palette.bg, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbarColorScheme(.light, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("回院子") { store.screen = .home } }
            }
            .navigationDestination(isPresented: Binding(get: { selected != nil }, set: { if !$0 { selected = nil } })) {
                if let selected { V2ConversationView(chat: chat, conversation: selected) }
            }
            .task { await chat.load() }
            .onChange(of: chat.notificationConversationID, initial: true) { selectNotificationConversation() }
            .onChange(of: chat.conversations.map(\.id)) { selectNotificationConversation() }
        }
        .tint(Palette.ink)
        .preferredColorScheme(.light)
    }
    private func selectNotificationConversation() {
        guard let id = chat.notificationConversationID,
              let conversation = chat.conversations.first(where: { $0.id == id }) else { return }
        selected = conversation
        chat.notificationConversationID = nil
    }

    private func subtitle(_ conversation: V2.Conversation) -> String {
        guard let message = conversation.lastMessage else { return "还没说过话，来坐一会儿吧" }
        return "\(chat.sender(message.author))：\(message.text)"
    }
}

private struct V2ConversationView: View {
    @ObservedObject var chat: V2ChatStore
    let conversation: V2.Conversation
    @State private var ticketSelection: V2TicketEditor.Selection?
    @State private var relayError: String?
    @State private var relayConfirmation: RelayConfirmation?
    @State private var draft = ""
    @State private var usageMessage: V2.Message?
    @State private var attachmentConversation: V2.Conversation?
    private var outboxRows: [V2Outbox.Entry] { chat.visibleOutbox(conversation.id) }
    private var notificationMessage: String? {
        chat.messages[conversation.id]?.first(where: { $0.id == chat.notificationMessageID })?.id
    }
    var body: some View {
        ZStack {
            PageBackground().ignoresSafeArea()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 16) {
                        if chat.hasEarlier[conversation.id] == true {
                            Button("看看更早的聊天") { Task {
                                let anchor = chat.messages[conversation.id]?.first?.id
                                await chat.earlier(conversation.id)
                                if let anchor { proxy.scrollTo(anchor, anchor: .top) }
                            } }.font(Typo.sans(14)).frame(maxWidth: .infinity).padding(8)
                        }
                        if (chat.messages[conversation.id] ?? []).isEmpty && outboxRows.isEmpty {
                            Text("这里还安安静静的。想说什么都可以。")
                                .font(Typo.sans(15)).foregroundStyle(Palette.ink2)
                                .frame(maxWidth: .infinity).padding(.vertical, 40)
                        }
                        ForEach(chat.messages[conversation.id] ?? []) { message in
                            VStack(alignment: .leading, spacing: 6) {
                                bubble(message.text, sender: chat.sender(message.author), mine: message.author.memberId == chat.connection.identity.member.id)
                                    .contextMenu {
                                        if chat.canReply(message) {
                                            Button("请团子重答") { Task { await chat.reply(to: message) } }
                                        }
                                        if let source = source(for: message) {
                                            Button("原话的使用") { usageMessage = message }
                                            ticketActions(for: message, source: source)
                                        }
                                    }
                                if let proof = source(for: message),
                                   message.canOfferRelay(memberID: chat.connection.identity.member.id,
                                                         conversationID: conversation.id, kind: conversation.kind) {
                                    relayControls(message: message, source: proof, work: chat.work)
                                }
                                if message.status == "stopped" {
                                    Text("已停止").font(Typo.sans(12)).foregroundStyle(Palette.ink2)
                                }
                                if message.author.kind == .cat,
                                   let trigger = chat.latestMember(conversation.id), message.replyToMessageId == trigger.id,
                                   message.id == chat.messages[conversation.id]?.last(where: { $0.replyToMessageId == trigger.id })?.id,
                                   chat.canReply(trigger) {
                                    Button("重答") { Task { await chat.reply(to: trigger) } }.font(Typo.sans(13))
                                }
                            }.id(message.id)
                        }
                        ForEach(outboxRows, id: \.displayID) { entry in
                            VStack(alignment: .trailing, spacing: 6) {
                                bubble(entry.text, sender: "我", mine: true)
                                deliveryStatus(entry)
                            }.frame(maxWidth: .infinity, alignment: .trailing).id(entry.displayID)
                        }
                        if let active = chat.activeTurns[conversation.id] {
                            VStack(alignment: .leading, spacing: 8) {
                                if !chat.hasPersistedReply(active, conversation: conversation.id) {
                                    bubble(active.stream.text.isEmpty ? (active.stream.terminal == nil ? "团子正在想…" : "这次还没有留下回复") : active.stream.text, sender: "团子", mine: false)
                                }
                                if active.stream.terminal == nil {
                                    HStack(spacing: 12) {
                                        Text(active.reconnecting ? "正在重新连接…" : "团子正在回复…").foregroundStyle(Palette.ink2)
                                        Button(active.stopping ? "正在停止…" : "停止") { Task { await chat.stop(conversation.id) } }
                                            .disabled(active.stopping)
                                    }.font(Typo.sans(13))
                                } else if active.stream.terminal == "error" {
                                    Text("这次回复没能完成").font(Typo.sans(13)).foregroundStyle(Palette.ink2)
                                    retryButton(active)
                                } else if active.phase == .stopped {
                                    Text("已停止").font(Typo.sans(12)).foregroundStyle(Palette.ink2)
                                    retryButton(active)
                                }
                            }
                        }
                        if let failure = chat.replyErrors[conversation.id] {
                            Text(failure).font(Typo.sans(13)).foregroundStyle(Palette.ink2)
                            if let trigger = chat.failedReplyTarget(conversation.id), chat.canReply(trigger) {
                                Button("重答") { Task { await chat.reply(to: trigger) } }.font(Typo.sans(13))
                            }
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }.padding(20)
                }
                .defaultScrollAnchor(.bottom)
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: chat.messages[conversation.id]?.last?.id) { withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
                .onChange(of: notificationMessage, initial: true) {
                    guard let id = notificationMessage else { return }
                    proxy.scrollTo(id, anchor: .center)
                    chat.notificationMessageID = nil
                }
                .onChange(of: outboxRows.last?.displayID) { withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
                .onChange(of: chat.activeTurns[conversation.id]?.stream.text) { proxy.scrollTo("bottom", anchor: .bottom) }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 8) {
                if let error = relayError ?? chat.error { Text(error).font(Typo.sans(12)).foregroundStyle(Palette.ink2) }
                HStack(alignment: .bottom, spacing: 12) {
                    TextField("说点什么…", text: $draft, axis: .vertical)
                        .font(Typo.sans(16)).foregroundStyle(Palette.ink).lineLimit(1...5).padding(12)
                        .background(Palette.card, in: RoundedRectangle(cornerRadius: Metrics.radiusControl))
                        .accessibilityIdentifier("v2Composer")
                    PrimaryButton(height: 44, horizontalPadding: 16, enabled: canSend, shadow: false) {
                        let text = draft; draft = ""
                        Task {
                            if !(await chat.send(text, conversation: conversation.id)), draft.isEmpty { draft = text }
                        }
                    } label: { Text("发送").font(Typo.sans(14)) }
                }
            }.padding(.horizontal, 16).padding(.vertical, 10).background(Palette.bg)
        }
        .navigationTitle(conversation.title).navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Palette.bg, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbarColorScheme(.light, for: .navigationBar)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if let message = chat.messages[conversation.id]?.last(where: { source(for: $0) != nil }),
                   let proof = source(for: message) {
                    Menu("用最近的原话创建", systemImage: "clock") {
                        ticketActions(for: message, source: proof)
                    }
                    .labelStyle(.iconOnly)
                }
                Button("附件", systemImage: "paperclip") { attachmentConversation = conversation }
                    .labelStyle(.iconOnly)
            }
        }
        .sheet(item: $attachmentConversation) { conversation in
            V2ConversationAttachments(conversation: conversation, connection: chat.connection, changes: chat.changes, memberNames: chat.members)
        }
        .sheet(item: $ticketSelection) { selection in
            V2TicketEditor(selection: selection, work: chat.work)
        }
        .sheet(item: $usageMessage) { message in
            V2MessageUsageView(resources: chat.resources, catDiary: chat.catDiary, message: message)
        }
        .confirmationDialog(relayConfirmation?.title ?? "转告", isPresented: Binding(
            get: { relayConfirmation != nil }, set: { if !$0 { relayConfirmation = nil } }
        ), titleVisibility: .visible, presenting: relayConfirmation) { intent in
            Button(intent.withdrawing ? "确认撤回" : "确认转告", role: intent.withdrawing ? .destructive : nil) {
                performRelay(intent, work: chat.work)
            }
        } message: { intent in
            Text(intent.withdrawing
                 ? "团子会停止使用这句原话。已送达的消息仍留在对方聊天里。"
                 : "团子会用你的名字，在伴侣和团子的单聊里转告。\n\n" + intent.text)
        }
        .task { await chat.poll(conversation.id) }
        .task { await chat.work.refreshPendingRelays(in: conversation.id) }
    }

    private struct RelayConfirmation {
        let source: V2.WorkSource
        let text: String
        var withdrawing = false
        var title: String { withdrawing ? "撤回这句原话的转告授权？" : "请团子署名转告？" }
    }

    @ViewBuilder
    private func ticketActions(for message: V2.Message, source: V2.WorkSource) -> some View {
        Button("创建约定") { ticketSelection = .schedule(source, original: message.text) }
        Button("创建托付") { ticketSelection = .start(source, original: message.text) }
    }

    private func source(for message: V2.Message) -> V2.WorkSource? {
        message.workSource(memberID: chat.connection.identity.member.id, conversationID: conversation.id)
    }

    @ViewBuilder
    private func relayControls(message: V2.Message, source: V2.WorkSource, work: V2WorkStore) -> some View {
        HStack(spacing: 12) {
            Spacer(minLength: 0)
            if let entry = work.relays[source.messageID] {
                let receipt = entry.receipt
                let showUrgent = entry.intent == .send && receipt?.urgent == true
                Text((showUrgent ? "紧急转告 · " : "") + entry.label).foregroundStyle(Palette.ink2)
                if entry.intent == .send {
                    if receipt?.state.isPending == true {
                        Button("查看状态") { performRelay(.init(source: entry.source, text: message.text), work: work) }
                    } else if receipt == nil {
                        Button("重试转告") { relayConfirmation = .init(source: entry.source, text: message.text) }
                    }
                    if entry.rejection == nil || receipt != nil {
                        Button("撤回授权") { relayConfirmation = .init(source: entry.source, text: message.text, withdrawing: true) }
                    }
                } else if entry.intent == .withdraw {
                    Button("重试撤回") { relayConfirmation = .init(source: entry.source, text: message.text, withdrawing: true) }
                }
            } else {
                Button("请团子转告") { relayConfirmation = .init(source: source, text: message.text) }
            }
        }
        .font(Typo.sans(13)).tint(Palette.accent)
        .disabled(work.relayBusy.contains(source.messageID))
    }

    private func performRelay(_ intent: RelayConfirmation, work: V2WorkStore) {
        Task {
            relayError = nil
            do {
                if intent.withdrawing { try await work.withdrawRelay(intent.source) }
                else { try await work.requestRelay(intent.source) }
            } catch { relayError = V2WorkStore.errorText(error) }
        }
    }

    private var canSend: Bool {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        return !text.isEmpty && text.utf16.count <= 4000
    }
    @ViewBuilder private func deliveryStatus(_ entry: V2Outbox.Entry) -> some View {
        if entry.accepted == nil {
            Text(deliveryTitle(entry)).font(Typo.sans(12)).foregroundStyle(Palette.ink2)
            if let failure = chat.failures[entry.id] {
                Text(failure).font(Typo.sans(12)).foregroundStyle(Palette.ink2)
            }
            if entry.wasRejected || (entry.rejection == nil && chat.failures[entry.id] != nil) {
                Button(entry.wasRejected ? "重新发送" : "重试") { Task { await chat.retry(entry) } }
                    .font(Typo.sans(13)).disabled(chat.sending.contains(entry.id))
            }
        }
    }
    private func deliveryTitle(_ entry: V2Outbox.Entry) -> String {
        if entry.wasRejected { return "这条消息未获接收" }
        if let code = entry.rejection { return V2.APIError(code: code).localizedDescription }
        if let receipt = entry.receipt { return receipt.reason.title }
        if chat.sending.contains(entry.id) { return "正在发送…" }
        return entry.submissionStarted == false ? "尚未发送" : "暂时未能确认发送"
    }
    @ViewBuilder private func retryButton(_ active: V2ChatStore.ActiveTurn) -> some View {
        if let message = chat.messages[conversation.id]?.first(where: { $0.id == active.turn.triggerMessageId }) {
            Button("重答") { Task { await chat.reply(to: message) } }.font(Typo.sans(13)).disabled(chat.replying.contains(conversation.id))
        }
    }
    private func bubble(_ text: String, sender: String, mine: Bool) -> some View {
        HStack {
            if mine { Spacer(minLength: 44) }
            VStack(alignment: mine ? .trailing : .leading, spacing: 6) {
                Text(sender).font(Typo.sans(12)).foregroundStyle(Palette.ink2)
                Text(text).font(Typo.sans(16)).foregroundStyle(Palette.ink)
                    .textSelection(.enabled).padding(14)
                    .background(mine ? Palette.accent.opacity(0.18) : Palette.card, in: RoundedRectangle(cornerRadius: Metrics.radiusCard))
            }
            if !mine { Spacer(minLength: 44) }
        }
    }
}
