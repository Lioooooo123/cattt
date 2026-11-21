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
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("回院子") { store.screen = .home } }
            }
            .navigationDestination(isPresented: Binding(get: { selected != nil }, set: { if !$0 { selected = nil } })) {
                if let selected { V2ConversationView(chat: chat, conversation: selected) }
            }
            .task { await chat.load() }
        }
        .tint(Palette.ink)
        .preferredColorScheme(.light)
    }
    private func subtitle(_ conversation: V2.Conversation) -> String {
        guard let message = conversation.lastMessage else { return "还没说过话，来坐一会儿吧" }
        return "\(chat.sender(message.author))：\(message.text)"
    }
}

private struct V2ConversationView: View {
    @ObservedObject var chat: V2ChatStore
    let conversation: V2.Conversation
    @State private var draft = ""
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
                        if (chat.messages[conversation.id] ?? []).isEmpty {
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
                        ForEach(chat.pending.filter { $0.conversationID == conversation.id }) { entry in
                            VStack(alignment: .trailing, spacing: 6) {
                                bubble(entry.text, sender: "我", mine: true)
                                if let failure = chat.failures[entry.id] {
                                    Text(failure).font(Typo.sans(12)).foregroundStyle(Palette.ink2)
                                    Button("发送失败，点此重试") { Task { await chat.transmit(entry) } }.font(Typo.sans(13))
                                } else { Text("正在发送…").font(Typo.sans(12)).foregroundStyle(Palette.ink2) }
                            }.frame(maxWidth: .infinity, alignment: .trailing).id(entry.id)
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
                .onChange(of: chat.pending.count) { withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
                .onChange(of: chat.activeTurns[conversation.id]?.stream.text) { proxy.scrollTo("bottom", anchor: .bottom) }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 8) {
                if let error = chat.error { Text(error).font(Typo.sans(12)).foregroundStyle(Palette.ink2) }
                HStack(alignment: .bottom, spacing: 12) {
                    TextField("说点什么…", text: $draft, axis: .vertical)
                        .font(Typo.sans(16)).lineLimit(1...5).padding(12)
                        .background(Palette.card, in: RoundedRectangle(cornerRadius: Metrics.radiusControl))
                        .accessibilityIdentifier("v2Composer")
                    PrimaryButton(height: 44, horizontalPadding: 16, enabled: canSend, shadow: false) {
                        let text = draft; draft = ""
                        Task { await chat.send(text, conversation: conversation.id) }
                    } label: { Text("发送").font(Typo.sans(14)) }
                }
            }.padding(.horizontal, 16).padding(.vertical, 10).background(Palette.bg)
        }
        .navigationTitle(conversation.title).navigationBarTitleDisplayMode(.inline)
        .task { await chat.poll(conversation.id) }
    }
    private var canSend: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && draft.count <= 4000 }
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
