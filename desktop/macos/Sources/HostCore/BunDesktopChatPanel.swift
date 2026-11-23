import SwiftUI

@MainActor
struct BunDesktopChatPanel: View {
    @ObservedObject var chat: DesktopV2Chat
    @State private var name = ""
    let ready: Bool
    let status: String

    init(chat: DesktopV2Chat, ready: Bool, status: String) {
        self.chat = chat
        self.ready = ready
        self.status = status
    }

    var body: some View {
        VStack(spacing: 0) {
            if ready, let me = chat.identity {
                HStack {
                    Text(me.member.displayName)
                        .font(.headline)
                        .foregroundStyle(CompanionPalette.ink)
                        .accessibilityIdentifier("desktop-chat-member")
                    Spacer()
                    if let error = chat.error {
                        Text(error).font(.caption).foregroundStyle(CompanionPalette.accent)
                    }
                }
                .padding(.horizontal, 18)
                .padding(.top, 15)
                Picker("会话", selection: $chat.selected) {
                    ForEach(chat.conversations) { Text($0.title).tag($0.id) }
                }
                .labelsHidden()
                .pickerStyle(.segmented)
                .padding(12)
                if let conversation = chat.conversations.first(where: { $0.id == chat.selected }) {
                    DesktopV2ConversationView(chat: chat, conversation: conversation)
                        .id(conversation.id)
                } else {
                    Text("正在等候聊天同步…")
                        .foregroundStyle(CompanionPalette.secondary)
                        .frame(maxHeight: .infinity)
                }
            } else if ready, let enrollment = chat.enrollment {
                enrollmentForm(enrollment)
            } else {
                VStack(spacing: 10) {
                    if chat.error == nil && (ready || status.hasPrefix("正在")) { ProgressView() }
                    Text(ready ? chat.error ?? "正在连接本机服务…" : status)
                        .foregroundStyle(CompanionPalette.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(24)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(CompanionPalette.panel)
    }

    private func enrollmentForm(_ enrollment: DesktopV2Enrollment.Status) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("连接这台 Mac 的聊天")
                .font(.headline)
                .foregroundStyle(CompanionPalette.ink)
            if let error = chat.error {
                Text(error).foregroundStyle(CompanionPalette.accent)
            }
            if !enrollment.has_members {
                Text("填写你的名字，创建第一位成员。")
                    .foregroundStyle(CompanionPalette.secondary)
                TextField("你的名字", text: $name)
                    .accessibilityIdentifier("desktop-chat-enrollment-name")
                let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
                Button("创建成员并连接") { Task { await chat.approve(newName: trimmed) } }
                    .buttonStyle(.borderedProminent)
                    .tint(CompanionPalette.accent)
                    .disabled(trimmed.isEmpty || trimmed.utf16.count > 100)
                    .accessibilityIdentifier("desktop-chat-enrollment-submit")
            } else if enrollment.local_members.isEmpty {
                Button("刷新成员") { chat.refreshEnrollment() }
            } else {
                Text("请选择你在这台 Mac 上的成员身份。")
                    .foregroundStyle(CompanionPalette.secondary)
                ForEach(enrollment.local_members) { member in
                    Button("以\(member.displayName)的身份连接") {
                        Task { await chat.approve(memberID: member.id) }
                    }
                }
            }
            if chat.busy { ProgressView().controlSize(.small) }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .disabled(chat.busy)
    }
}

private struct DesktopV2ConversationView: View {
    @ObservedObject var chat: DesktopV2Chat
    let conversation: V2.Conversation
    @State private var loadingEarlier = false

    private var id: String { conversation.id }
    private var messages: [V2.Message] { chat.history[id] ?? [] }
    private var queued: [DesktopV2Journal.Pending] { chat.pending.filter { $0.conversationID == id } }
    private var active: DesktopV2Chat.Active? { chat.active[id] }
    private var latestMine: V2.Message? { messages.last(where: chat.isMine) }

    var body: some View {
        VStack(spacing: 0) {
            Divider()
            transcript
            Divider()
            if let issue = chat.issues[id] {
                Text(issue).font(.caption)
                    .foregroundStyle(CompanionPalette.accent)
                    .padding([.horizontal, .top], 10)
            }
            composer
        }
    }

    private var transcript: some View {
        ScrollViewReader { scroll in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if chat.earlier[id] == true {
                        Button("加载更早的对话") {
                            let anchor = messages.first?.id
                            Task {
                                loadingEarlier = true
                                await chat.loadEarlier(id)
                                if let anchor { scroll.scrollTo(anchor, anchor: .top) }
                                loadingEarlier = false
                            }
                        }
                        .disabled(loadingEarlier)
                        .frame(maxWidth: .infinity)
                    }
                    if chat.history[id] == nil {
                        ProgressView("正在读取聊天记录…").frame(maxWidth: .infinity, minHeight: 120)
                    } else if messages.isEmpty, queued.isEmpty, active == nil {
                        VStack(spacing: 8) {
                            Text(conversation.kind == .group ? "我们仨的聊天，从这里开始" : "有些话，想单独和团子说")
                                .font(.headline).foregroundStyle(CompanionPalette.ink)
                            Text(conversation.kind == .group ? "你、TA 和团子，都在这里。" : "说说今天的小事，也可以只是打个招呼。")
                                .font(.callout).foregroundStyle(CompanionPalette.secondary)
                        }
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity, minHeight: 120)
                    }
                    ForEach(messages) { message in
                        DesktopV2Bubble(author: chat.authorName(message.author), text: message.text,
                                        mine: chat.isMine(message), note: message.status == "stopped" ? "已停止" : nil)
                            .id(message.id)
                    }
                    ForEach(queued) { entry in
                        if !messages.contains(where: { chat.isMine($0) && $0.clientMessageId == entry.id }) {
                            DesktopV2Bubble(author: chat.identity?.member.displayName ?? "我", text: entry.text, mine: true,
                                            note: entry.receiptID == nil ? "等待发送" : "已收到转交请求，等待送达")
                        }
                    }
                    if let active, !messages.contains(where: {
                        $0.author.kind == .cat && $0.turnId == active.turn.id
                    }) {
                        DesktopV2Bubble(author: "团子", text: active.stream.text, mine: false,
                                        note: active.reconnecting ? "正在恢复回复…" : (active.stream.text.isEmpty ? "团子正在想…" : nil))
                    }
                    Color.clear.frame(height: 1).id("desktop-chat-bottom")
                }
                .padding(16)
            }
            .defaultScrollAnchor(.bottom)
            .onChange(of: messages.last?.id) { _, _ in scroll.scrollTo("desktop-chat-bottom", anchor: .bottom) }
            .onChange(of: queued.last?.id) { _, _ in scroll.scrollTo("desktop-chat-bottom", anchor: .bottom) }
            .onChange(of: active?.stream.text) { _, _ in scroll.scrollTo("desktop-chat-bottom", anchor: .bottom) }
        }
    }

    private var composer: some View {
        let draft = Binding<String>(get: { chat.drafts[id, default: ""] }, set: { chat.drafts[id] = $0 })
        let text = draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return VStack(alignment: .leading, spacing: 7) {
            if let latestMine, active == nil, chat.mayControl(conversation) {
                Button("让团子再回答一次") { Task { await chat.reply(latestMine) } }
                    .buttonStyle(.plain)
                    .foregroundStyle(CompanionPalette.accent)
                    .font(.caption)
                    .disabled(chat.replying.contains(id))
                    .accessibilityIdentifier("desktop-chat-reply")
            }
            if text.utf16.count >= 3600 {
                HStack(alignment: .firstTextBaseline) {
                    Text(text.utf16.count > 4000 ? "内容较长，请分成几条发送" : "快到单条消息的长度上限了")
                    Spacer(minLength: 8)
                    Text("\(text.utf16.count) / 4000").monospacedDigit()
                }
                .font(.caption)
                .foregroundStyle(text.utf16.count > 4000 ? CompanionPalette.accent : CompanionPalette.secondary)
                .accessibilityElement(children: .combine)
            }
            HStack(alignment: .bottom, spacing: 10) {
                TextField(conversation.kind == .group ? "和大家说点什么…" : "和团子说点什么…", text: draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...5)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(CompanionPalette.page, in: RoundedRectangle(cornerRadius: 12))
                    .accessibilityIdentifier("desktop-chat-input")
                if let active, active.stream.terminal == nil, chat.mayControl(conversation) {
                    composerButton("停止回复", symbol: "stop.fill") { Task { await chat.stop(id) } }
                        .disabled(active.stopping)
                        .accessibilityIdentifier("desktop-chat-stop")
                }
                composerButton(conversation.kind == .group ? "发送到我们仨" : "发送给团子", symbol: "arrow.up") { chat.send(id) }
                    .disabled(text.isEmpty || text.utf16.count > 4000)
                    .keyboardShortcut(.return, modifiers: .command)
                    .accessibilityIdentifier("desktop-chat-send")
            }
        }
        .padding(12)
    }

    private func composerButton(_ title: String, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
                .labelStyle(.iconOnly)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 34, height: 34)
                .background(CompanionPalette.accent, in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .help(title)
    }
}

private struct DesktopV2Bubble: View {
    let author: String
    let text: String
    let mine: Bool
    let note: String?

    var body: some View {
        HStack {
            if mine { Spacer(minLength: 20) }
            VStack(alignment: .leading, spacing: 5) {
                Text(author).font(.caption.weight(.semibold)).foregroundStyle(CompanionPalette.secondary)
                if !text.isEmpty {
                    Text(text).textSelection(.enabled)
                        .foregroundStyle(CompanionPalette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let note { Text(note).font(.caption).foregroundStyle(CompanionPalette.secondary) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 13)
            .padding(.vertical, 10)
            .background(mine ? CompanionPalette.userBubble : CompanionPalette.page, in: RoundedRectangle(cornerRadius: 14))
            if !mine { Spacer(minLength: 20) }
        }
    }
}
