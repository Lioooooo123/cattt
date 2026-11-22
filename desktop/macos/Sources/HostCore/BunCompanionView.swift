import SwiftUI

@MainActor
private final class BunCompanionModel: ObservableObject {
    let yard: HostYardController
    let shared: DesktopSharedYard
    let chat: DesktopV2Chat

    init(host: BunHost) {
        yard = HostYardController()
        shared = DesktopSharedYard { [weak yard] command in yard?.sendShared(command) }
        chat = DesktopV2Chat(host: host)
        yard.onCatFrame = { [weak shared] frame in shared?.observe(frame) }
    }
}

@MainActor
public struct BunCompanionView: View {
    @StateObject private var model: BunCompanionModel
    let ready: Bool
    let status: String

    public init(host: BunHost, ready: Bool, status: String) {
        _model = StateObject(wrappedValue: BunCompanionModel(host: host))
        self.ready = ready
        self.status = status
    }

    public var body: some View {
        BunCompanionContent(yard: model.yard, shared: model.shared, chat: model.chat, ready: ready, status: status)
    }
}

@MainActor
private struct BunCompanionContent: View {
    @ObservedObject var yard: HostYardController
    @ObservedObject var shared: DesktopSharedYard
    @ObservedObject var chat: DesktopV2Chat
    @State private var chatVisible = true
    let ready: Bool
    let status: String

    var body: some View {
        let connection = ready ? chat.yardConnection : nil
        let active = yard.isActive && yard.surfaceReady
        VStack(spacing: 0) {
            toolbar
            Divider()
            HSplitView {
                HostYardView(controller: yard)
                    .frame(minWidth: 480, maxWidth: .infinity, maxHeight: .infinity)
                if chatVisible {
                    BunDesktopChatPanel(chat: chat, ready: ready, status: status)
                        .frame(minWidth: 320, idealWidth: 380, maxWidth: 520, maxHeight: .infinity)
                }
            }
        }
        .frame(minWidth: 900, minHeight: 600)
        .background(CompanionPalette.page)
        .task(id: ready) { if ready { await chat.run() } }
        .task(id: YardTask(connection: connection?.key, active: active, retry: shared.retry)) {
            if active, let connection { await shared.run(connection) }
            else { shared.suspend(for: connection) }
        }
        .onDisappear { yard.setActive(false) }
    }

    private var toolbar: some View {
        HStack(spacing: 14) {
            Text(shared.status).font(.caption).foregroundStyle(CompanionPalette.secondary)
                .accessibilityIdentifier("desktop-yard-status")
            if !shared.otherMembers.isEmpty {
                Label("TA 也在小院", systemImage: "person.fill").font(.caption)
                    .accessibilityIdentifier("desktop-yard-presence")
            }
            if let actionStatus {
                Text(actionStatus).font(.caption).foregroundStyle(CompanionPalette.secondary)
                    .accessibilityIdentifier("desktop-yard-action")
            }
            Spacer()
            if shared.replaced { Button("重新连接", action: shared.reconnect) }
            Menu("叫团子去…") {
                ForEach(shared.availablePlaces, id: \.self) { place in
                    Button(Self.placeNames[place] ?? place) { shared.request(place) }
                }
            }
            .fixedSize()
            .disabled(shared.availablePlaces.isEmpty)
            Button("陪坐") {
                if let seat = shared.seat { shared.request(seat, activity: "sit") }
            }
            .disabled(shared.seat == nil)
            Button { yard.findCat() } label: { Label("找团子", systemImage: "scope") }
                .help("把镜头移到团子身边")
            Button { chatVisible.toggle() } label: {
                Label("聊天", systemImage: chatVisible ? "bubble.right.fill" : "bubble.right")
            }
            .help(chatVisible ? "隐藏聊天" : "显示聊天")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }

    private var actionStatus: String? {
        guard let receipt = shared.action else { return nil }
        switch receipt.status {
        case .requested, .accepted: return "已收到邀请"
        case .running: return "团子正在过去"
        case .arrived: return receipt.activity == "sit" ? "团子坐下了" : "团子到了"
        case .rejected, .interrupted, .expired: return "团子没能完成这个动作"
        }
    }

    private struct YardTask: Equatable {
        let connection: String?
        let active: Bool
        let retry: Int
    }

    private static let placeNames = [
        "house": "蘑菇屋门口", "tree": "树窝", "bed": "小床", "grass": "草地", "pond": "池塘", "fence": "栅栏",
    ]
}
