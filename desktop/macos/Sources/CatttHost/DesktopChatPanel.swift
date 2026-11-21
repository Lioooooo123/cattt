import Combine
import HostCore
import SwiftUI

@MainActor
final class DesktopChatViewModel: ObservableObject {
    @Published private(set) var transcript = DesktopChatTranscript()
    @Published private(set) var connectionMessage = "正在连接本机服务…"
    @Published private(set) var connectionError = ""
    @Published private(set) var loading = false
    @Published private(set) var sending = false
    @Published private(set) var cancelling = false
    @Published private(set) var connected = false
    @Published var draft = ""

    private let client: DesktopChatClient
    private var task: Task<Void, Never>?

    var canCancel: Bool { sending && !cancelling }
    var stopLabel: String { transcript.turnID == nil ? "停止等待" : "停止回复" }

    init(dataDirectory: URL = host.data) {
        client = DesktopChatClient(dataDirectory: dataDirectory)
    }

    func reload(automatically: Bool = false) async {
        guard !loading, !sending else { return }
        if automatically && connected && transcript.clientMessageID != nil { return }
        loading = true
        connected = false
        connectionMessage = "正在连接本机服务…"
        connectionError = ""
        defer { loading = false }
        do {
            let connection = try await client.connect()
            connectionMessage = connection.repairedCredential ? "连接凭证已更新，已重新连接" : "已连接到这台电脑上的团子"
            let history = try await client.history()
            try Task.checkCancellation()
            transcript.loadHistory(history)
            connected = true
        } catch is CancellationError {
            return
        } catch {
            connectionMessage = "暂时无法连接团子"
            connectionError = DesktopChatError.userMessage(for: error)
        }
    }

    func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard connected, connectionError.isEmpty, !text.isEmpty, !sending, !loading else { return }
        let clientMessageID = UUID().uuidString
        transcript.beginSend(clientMessageID: clientMessageID, text: text)
        draft = ""
        sending = true
        task = Task { await run(.send(clientMessageID: clientMessageID, text: text)) }
    }

    func retry() {
        guard !sending, let request = transcript.retryRequest() else { return }
        transcript.markRetrying()
        connectionError = ""
        sending = true
        task = Task { await run(request) }
    }

    func cancel() {
        guard canCancel else { return }
        guard let details = transcript.cancellationDetails() else {
            task?.cancel()
            transcript.stopWaiting()
            return
        }
        cancelling = true
        Task {
            do {
                try await client.cancel(turnID: details.turnID, visibleLength: details.visibleLength)
            } catch {
                guard sending, transcript.turnID == details.turnID else { return }
                connectionError = "停止回复失败：\(DesktopChatError.userMessage(for: error))"
                cancelling = false
            }
        }
    }

    private func run(_ initialRequest: DesktopChatRequest) async {
        var request = initialRequest
        var resumeCount = 0
        var credentialRefreshAttempted = false
        defer { sending = false; cancelling = false }

        while !Task.isCancelled {
            do {
                let stream: AsyncThrowingStream<SSEFrame, Error>
                switch request {
                case .send(let clientMessageID, let text):
                    stream = try await client.send(clientMessageID: clientMessageID, text: text)
                case .reply(let userMessageID, let requestID):
                    stream = try await client.reply(to: userMessageID, requestID: requestID)
                case .resume(let turnID, let eventID):
                    stream = try await client.resume(turnID: turnID, after: eventID)
                }

                var completed = false
                var stoppedWithoutReply = false
                var terminalError: (String, Bool)?
                for try await frame in stream {
                    guard !Task.isCancelled else { return }
                    transcript.recordEventID(frame.id)
                    guard let data = frame.data.data(using: .utf8) else { continue }
                    switch frame.event {
                    case "accepted":
                        let event = try Self.decoder.decode(AcceptedEvent.self, from: data)
                        transcript.accept(turnID: event.turnId, userMessageID: event.userMessageId, eventID: frame.id)
                    case "delta", "snapshot":
                        let event = try Self.decoder.decode(TextEvent.self, from: data)
                        transcript.applyText(event.text, snapshot: frame.event == "snapshot")
                    case "done":
                        let event = try Self.decoder.decode(DoneEvent.self, from: data)
                        transcript.complete(messageID: event.messageId, stopped: event.status == "stopped")
                        stoppedWithoutReply = event.status == "stopped" && event.messageId == nil
                        completed = true
                    case "error":
                        let event = try Self.decoder.decode(ErrorEvent.self, from: data)
                        terminalError = (Self.message(for: event.code), event.retryable)
                    case "superseded":
                        completed = true
                        terminalError = ("这条消息已由后续对话接续", false)
                    default:
                        break
                    }
                    if completed || terminalError != nil { break }
                }

                guard !Task.isCancelled else { return }
                if completed {
                    if let error = terminalError {
                        transcript.fail(message: error.0, retryable: error.1)
                    } else {
                        connectionError = ""
                        if !stoppedWithoutReply {
                            do { transcript.loadHistory(try await client.history()) }
                            catch { connectionError = DesktopChatError.userMessage(for: error) }
                        }
                    }
                    return
                }
                if terminalError == nil, let resume = transcript.resumeRequest(), resumeCount < 3 {
                    resumeCount += 1
                    request = resume
                    try? await Task.sleep(for: .milliseconds(400 * resumeCount))
                    continue
                }
                if let terminalError {
                    transcript.fail(message: terminalError.0, retryable: terminalError.1)
                } else {
                    transcript.fail(message: "回复连接中断，请重试", retryable: true)
                }
                return
            } catch {
                if Task.isCancelled { return }
                if Self.isUnauthorized(error), !credentialRefreshAttempted {
                    credentialRefreshAttempted = true
                    do {
                        let connection = try await client.connect()
                        if connection.repairedCredential {
                            connectionMessage = "连接凭证已更新，正在恢复对话…"
                        }
                        continue
                    } catch {
                        connectionError = DesktopChatError.userMessage(for: error)
                    }
                }
                let message = DesktopChatError.userMessage(for: error)
                let resumeLimit = (error as? URLError)?.code == .timedOut ? 1 : 3
                if let resume = transcript.resumeRequest(), resumeCount < resumeLimit {
                    resumeCount += 1
                    request = resume
                    try? await Task.sleep(for: .milliseconds(400 * resumeCount))
                    continue
                }
                connectionError = message
                transcript.fail(message: message, retryable: true)
                return
            }
        }
    }

    private static func isUnauthorized(_ error: Error) -> Bool {
        if case DesktopChatError.http(status: 401, code: _) = error { return true }
        return false
    }

    private static func message(for code: String) -> String {
        switch code {
        case "model_auth": return "团子的模型密钥无效，请检查宿主设置"
        case "model_quota": return "模型额度不足，请检查模型服务设置"
        case "model_daily_budget": return "今天的对话额度已用完，请稍后再来"
        case "model_bad_request": return "模型暂时无法处理这条消息"
        case "lost": return "回复暂时无法恢复，请再试一次"
        case "network": return "本机服务连接中断，请再试一次"
        default: return "团子这次没有接上话（\(code)）"
        }
    }

    private struct AcceptedEvent: Decodable { let turnId: String; let userMessageId: String }
    private struct TextEvent: Decodable { let text: String }
    private struct DoneEvent: Decodable { let messageId: String?; let status: String }
    private struct ErrorEvent: Decodable { let code: String; let retryable: Bool }
    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }()
}

struct DesktopChatPanel: View {
    @ObservedObject var model: DesktopChatViewModel
    let hostReady: Bool
    let hostError: String
    @FocusState private var inputFocused: Bool
    private var status: String {
        if !hostReady { return hostError.isEmpty ? "团子正在启动…" : hostError }
        return model.connectionError.isEmpty ? model.connectionMessage : model.connectionError
    }
    private var canType: Bool { hostReady && model.connected && !model.sending && model.connectionError.isEmpty }

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .center, spacing: 10) {
                Image(systemName: "bubble.left.and.bubble.right.fill")
                    .foregroundStyle(CompanionPalette.accent)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text("和团子说会儿话")
                        .font(.headline)
                        .foregroundStyle(CompanionPalette.ink)
                    Text(status)
                        .font(.caption)
                        .foregroundStyle(model.connectionError.isEmpty && hostError.isEmpty ? CompanionPalette.secondary : CompanionPalette.accent)
                        .lineLimit(2)
                }
                Spacer(minLength: 4)
                Button {
                    Task { await model.reload() }
                } label: {
                    Label("刷新聊天", systemImage: "arrow.clockwise")
                        .labelStyle(.iconOnly)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("刷新聊天")
                .help("重新连接并刷新聊天记录")
                .disabled(!hostReady || model.loading || model.sending)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 16)

            Rectangle().fill(CompanionPalette.rule).frame(height: 1)

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        if model.loading && model.transcript.messages.isEmpty {
                            ProgressView("正在读取聊天记录…")
                                .frame(maxWidth: .infinity, minHeight: 160)
                                .foregroundStyle(CompanionPalette.secondary)
                        } else if model.transcript.messages.isEmpty {
                            Text("院子里的团子在等你。")
                                .font(.callout)
                                .foregroundStyle(CompanionPalette.secondary)
                                .frame(maxWidth: .infinity, minHeight: 180)
                        }
                        ForEach(model.transcript.messages) { entry in
                            DesktopChatBubble(entry: entry, retry: model.retry)
                                .disabled(!hostReady || model.sending)
                                .id(entry.id)
                        }
                        Color.clear.frame(height: 1).id("chat-bottom")
                    }
                    .padding(18)
                }
                .onChange(of: model.transcript.messages.count) { _, _ in
                    withAnimation(.easeOut(duration: 0.18)) { proxy.scrollTo("chat-bottom", anchor: .bottom) }
                }
                .onChange(of: model.transcript.messages.last?.text) { _, _ in
                    withAnimation(.easeOut(duration: 0.18)) { proxy.scrollTo("chat-bottom", anchor: .bottom) }
                }
            }

            Rectangle().fill(CompanionPalette.rule).frame(height: 1)

            HStack(alignment: .bottom, spacing: 10) {
                TextField("说点什么…", text: $model.draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...5)
                    .focused($inputFocused)
                    .onSubmit { if canType { model.send() } }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(CompanionPalette.page, in: RoundedRectangle(cornerRadius: 12))
                    .disabled(!canType)
                Button {
                    if model.sending { model.cancel() } else { model.send() }
                } label: {
                    Label(model.sending ? model.stopLabel : "发送给团子",
                          systemImage: model.sending ? "stop.fill" : "arrow.up")
                        .labelStyle(.iconOnly)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 34, height: 34)
                        .background(CompanionPalette.accent, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(model.sending ? model.stopLabel : "发送给团子")
                .help(model.sending ? model.stopLabel : "发送给团子")
                .disabled(model.sending ? !model.canCancel :
                    !canType || model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(16)
        }
        .background(CompanionPalette.panel)
    }
}

private struct DesktopChatBubble: View {
    let entry: DesktopChatEntry
    let retry: () -> Void

    var body: some View {
        HStack {
            if entry.role == .user { Spacer(minLength: 22) }
            VStack(alignment: .leading, spacing: 6) {
                if entry.text.isEmpty && entry.state == .streaming {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("团子正在想…")
                    }
                    .font(.callout)
                    .foregroundStyle(CompanionPalette.secondary)
                } else if !entry.text.isEmpty {
                    Text(entry.text)
                        .font(.body)
                        .foregroundStyle(CompanionPalette.ink)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let error = entry.error {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(CompanionPalette.accent)
                    if entry.retryable {
                        Button("再试一次", action: retry)
                            .font(.caption.weight(.medium))
                            .foregroundStyle(CompanionPalette.accent)
                            .buttonStyle(.plain)
                    }
                } else if entry.state == .sending {
                    Text("发送中…").font(.caption).foregroundStyle(CompanionPalette.secondary)
                } else if entry.state == .stopped {
                    Text("已停止").font(.caption).foregroundStyle(CompanionPalette.secondary)
                }
            }
            .padding(.horizontal, 13)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(entry.role == .user ? CompanionPalette.userBubble : CompanionPalette.page,
                        in: RoundedRectangle(cornerRadius: 14))
            if entry.role == .cat { Spacer(minLength: 22) }
        }
        .frame(maxWidth: .infinity)
    }
}
