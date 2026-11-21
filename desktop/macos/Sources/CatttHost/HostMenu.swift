import SwiftUI

struct HostMenu: App {
    @NSApplicationDelegateAdaptor(HostDelegate.self) var delegate
    @StateObject private var model = HostModel.shared
    var body: some Scene {
        Window("小院", id: "yard") { CompanionWindow(hostModel: model) }
            .defaultSize(width: 1200, height: 780)
            .windowResizability(.contentMinSize)
        MenuBarExtra {
            HostMenuContent(model: model)
        } label: {
            HostMenuLabel(model: model)
        }
        Window("配对手机", id: "pairing") { PairingView(dataDirectory: host.data) }
            .defaultSize(width: 460, height: 520).windowResizability(.contentSize)
        Window("填写 DeepSeek key", id: "model") { ModelKeyView(model: model) }
            .defaultSize(width: 420, height: 200).windowResizability(.contentSize)
        Window("设置本地模型", id: "local-model") { LocalModelSetupView(hostModel: model) }
            .defaultSize(width: 500, height: 400).windowResizability(.contentSize)
    }
}

private struct HostMenuLabel: View {
    @ObservedObject var model: HostModel
    @Environment(\.openWindow) private var openWindow
    var body: some View {
        Label {
            Text("团子状态菜单")
        } icon: {
            if let icon = NSImage(systemSymbolName: model.icon, accessibilityDescription: "团子状态菜单") {
                Image(nsImage: icon)
            }
        }
        .accessibilityLabel("团子状态菜单")
        .onAppear {
            model.start()
            CompanionWindowAction.open = {
                openWindow(id: "yard")
                NSApp.activate(ignoringOtherApps: true)
            }
        }
        .onChange(of: model.showLocalModelSetup) { _, show in
            if show { openWindow(id: "local-model"); NSApp.activate(ignoringOtherApps: true); model.showLocalModelSetup = false }
        }
    }
}

private struct HostMenuContent: View {
    @ObservedObject var model: HostModel
    @Environment(\.openWindow) private var openWindow
    var body: some View {
        Text(model.summary)
        ForEach(["数据库", "API", "worker", "局域网 HTTPS", "本地模型", "DeepSeek"], id: \.self) { name in
            Text("\(name)：\(model.status[name] ?? "启动中")")
        }
        if !model.error.isEmpty { Text(model.error) }
        if !model.notice.isEmpty { Text(model.notice) }
        Divider()
        Button("打开小院") { CompanionWindowAction.show() }
        Divider()
        Button("配对手机…") { openWindow(id: "pairing"); NSApp.activate(ignoringOtherApps: true) }
        Button(model.localModelRecommended ? "设置本地模型…（推荐）" : "设置本地模型…") { openWindow(id: "local-model"); NSApp.activate(ignoringOtherApps: true) }
        Button("填写 DeepSeek key…") { openWindow(id: "model"); NSApp.activate(ignoringOtherApps: true) }.disabled(model.setupRunning)
        Divider()
        Button("立即备份") { model.backup() }.disabled(model.busy || model.setupRunning || model.status["数据库"] != "正常")
        Button("从备份恢复…") { model.restorePicker() }.disabled(model.busy || model.setupRunning || model.status["数据库"] != "正常")
        Button("打开备份文件夹") { model.openFolder("backups") }
        Button("打开日志文件夹") { model.openFolder("logs") }
        Divider()
        Toggle("登录时自动启动", isOn: Binding(get: { model.loginEnabled }, set: { model.setLogin($0) }))
        Button("退出团子") { model.quit() }.keyboardShortcut("q")
    }
}

private struct ModelKeyView: View {
    @ObservedObject var model: HostModel
    @State private var key = ""
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("填写 DeepSeek key").font(.headline)
            Text("密钥保存在这台电脑上。已有本地模型时，默认在本机提取记忆。DeepSeek 处理聊天、路由和托付，相关请求可能包含经你允许使用的记忆和日记内容。保存后会重启电脑端服务。").foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            SecureField("DeepSeek API key", text: $key).textFieldStyle(.roundedBorder)
            HStack {
                Spacer()
                Button("取消") { key = ""; dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("保存并启动") { model.saveKey(key); key = ""; dismiss() }
                    .disabled(key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.busy || model.setupRunning).keyboardShortcut(.defaultAction)
            }
        }.padding(24).frame(width: 420)
    }
}
