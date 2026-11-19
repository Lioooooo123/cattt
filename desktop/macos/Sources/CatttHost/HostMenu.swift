import SwiftUI

struct HostMenu: App {
    @NSApplicationDelegateAdaptor(HostDelegate.self) var delegate
    @StateObject private var model = HostModel.shared
    var body: some Scene {
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
        Label("团子", systemImage: model.icon).onAppear { model.start() }
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
            Text("密钥仅保存在这台电脑上，不会删除本地模型配置。已有本地模型时，记忆默认用本地；聊天、路由和后台处理用 DeepSeek。保存后重启 API 和 worker。").foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            SecureField("DeepSeek API key", text: $key).textFieldStyle(.roundedBorder)
            HStack {
                Spacer()
                Button("取消") { key = ""; dismiss() }
                Button("保存并启动") { model.saveKey(key); key = ""; dismiss() }
                    .disabled(key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.busy || model.setupRunning).keyboardShortcut(.defaultAction)
            }
        }.padding(24).frame(width: 420)
    }
}
