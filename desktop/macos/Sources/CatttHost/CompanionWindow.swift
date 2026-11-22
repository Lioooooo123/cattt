import SwiftUI
import HostCore

struct CompanionWindow: View {
    @ObservedObject var hostModel: HostModel
    @Environment(\.openWindow) private var openWindow
    @StateObject private var yard = HostYardController()
    @StateObject private var chat = DesktopChatViewModel()
    @State private var chatVisible = true
    private var hostReady: Bool { hostModel.status["API"] == "正常" && hostModel.error.isEmpty }

    var body: some View {
        HSplitView {
            HostYardView(controller: yard)
                .frame(minWidth: 480, maxWidth: .infinity, maxHeight: .infinity)
            if chatVisible {
                DesktopChatPanel(model: chat, hostReady: hostReady, hostError: hostModel.error)
                    .frame(minWidth: 320, idealWidth: 380, maxWidth: 520, maxHeight: .infinity)
            }
        }
        .frame(minWidth: 900, minHeight: 600)
        .background(CompanionPalette.page)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button {
                    yard.findCat()
                } label: {
                    Label("找团子", systemImage: "scope")
                }
                .help("把镜头移到团子身边")

                Button {
                    chatVisible.toggle()
                } label: {
                    Label("聊天", systemImage: chatVisible ? "bubble.right.fill" : "bubble.right")
                }
                .help(chatVisible ? "隐藏聊天" : "显示聊天")

                Button("配对手机", systemImage: "iphone.gen3") {
                    openWindow(id: "pairing")
                }
                Menu("设置") {
                    Button("设置本地模型…") { openWindow(id: "local-model") }
                    Button("填写 DeepSeek key…") { openWindow(id: "model") }
                }
                .accessibilityLabel("设置")
                .help("设置")
            }
        }
        .task(id: hostReady) {
            if hostReady { await chat.reload(automatically: true) }
        }
        .onDisappear { yard.setActive(false) }
    }
}
