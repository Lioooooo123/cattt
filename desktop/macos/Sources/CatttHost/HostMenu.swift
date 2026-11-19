import SwiftUI

struct HostMenu: App {
    @NSApplicationDelegateAdaptor(HostDelegate.self) var delegate
    @StateObject private var model = HostModel.shared
    var body: some Scene {
        MenuBarExtra {
            HostMenuContent(model: model)
        } label: {
            Label("团子", systemImage: model.icon).onAppear { model.start() }
        }
        Window("配对手机", id: "pairing") { PairingView(dataDirectory: host.data) }
            .defaultSize(width: 460, height: 520).windowResizability(.contentSize)
        Window("填写 DeepSeek key", id: "model") { ModelKeyView(model: model) }
            .defaultSize(width: 420, height: 200).windowResizability(.contentSize)
    }
}

private struct HostMenuContent: View {
    @ObservedObject var model: HostModel
    @Environment(\.openWindow) private var openWindow
    var body: some View {
        Text(model.summary)
        ForEach(["数据库", "API", "worker", "局域网 HTTPS", "模型"], id: \.self) { name in
            Text("\(name)：\(model.status[name] ?? "启动中")")
        }
        if !model.error.isEmpty { Text(model.error) }
        if !model.notice.isEmpty { Text(model.notice) }
        Divider()
        Button("配对手机…") { openWindow(id: "pairing"); NSApp.activate(ignoringOtherApps: true) }
        Button("填写 DeepSeek key…") { openWindow(id: "model"); NSApp.activate(ignoringOtherApps: true) }
        Divider()
        Button("立即备份") { model.backup() }.disabled(model.busy || model.status["数据库"] != "正常")
        Button("从备份恢复…") { model.restorePicker() }.disabled(model.busy || model.status["数据库"] != "正常")
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
            Text("密钥仅保存在这台电脑上，保存后将重新启动 API 和 worker。").foregroundStyle(.secondary)
            SecureField("DeepSeek API key", text: $key).textFieldStyle(.roundedBorder)
            HStack {
                Spacer()
                Button("取消") { key = ""; dismiss() }
                Button("保存并启动") { model.saveKey(key); key = ""; dismiss() }
                    .disabled(key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.busy).keyboardShortcut(.defaultAction)
            }
        }.padding(24).frame(width: 420)
    }
}
