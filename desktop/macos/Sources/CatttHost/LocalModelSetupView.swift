import SwiftUI
import HostCore

@MainActor final class LocalModelSetupModel: ObservableObject {
    @Published var hardware: SetupHardware?
    @Published var recommendation: SetupRecommendation?
    @Published var selectedModel: String?
    @Published var progress: Double?
    @Published var step = "正在检测硬件…"
    @Published var smoke: SetupSmoke?
    @Published var error = ""
    @Published var ollamaAvailable: Bool?
    @Published var success = false
    @Published var running = false
    @Published var committing = false
    private var generation = UUID()

    func inspect(_ host: HostModel) {
        guard !running else { return }
        ollamaAvailable = nil; error = ""; success = false; smoke = nil; progress = nil
        start(host, consent: false)
    }
    func start(_ host: HostModel, consent: Bool) {
        guard !running else { return }
        running = true; committing = false; error = ""; success = false; smoke = nil; progress = nil
        step = consent ? "正在连接 Ollama…" : "正在检测硬件…"
        let id = UUID(); generation = id
        host.runModelSetup(consent: consent, model: consent ? selectedModel : nil, onEvent: { [weak self] event in
            guard let self, self.generation == id else { return }
            switch event {
            case .recommendation(let hardware, let recommendation, let selected):
                self.hardware = hardware; self.recommendation = recommendation; self.selectedModel = selected
            case .progress(let value):
                self.progress = value.fraction
                self.step = value.status == "success" ? "正在测试中文陪伴回复与工具调用…" : "正在下载模型：\(value.status ?? "接收数据")"
            case .smoke(let value):
                self.smoke = value
                self.step = value.passed ? "烟测通过，正在保存配置…" : "烟测未通过"
            case .failure(let reason, let needsOllama):
                self.error = reason
                if needsOllama { self.ollamaAvailable = false }
            case .saved: self.committing = true; self.step = "配置已保存，正在重启服务…"
            case .stopped, .unknown: break
            }
        }, completion: { [weak self] result in
            guard let self, self.generation == id else { return }
            self.running = false
            switch result {
            case .success(.saved):
                self.success = true
                self.step = host.status["DeepSeek"]?.hasPrefix("已配置") == true ? "本地模型 \(self.selectedModel ?? "") 已配置；已保留 DeepSeek，分工见菜单。" : "已切换到本地模型 \(self.selectedModel ?? "")"
            case .success(.cancelled): self.step = "已取消，原配置保持不变"
            case .success(.stopped) where !consent && self.hardware != nil:
                self.step = "请选择是否下载并测试推荐模型"
                host.checkOllama { [weak self] available in
                    guard let self, self.generation == id else { return }; self.ollamaAvailable = available
                }
            case .success:
                if self.error.isEmpty { self.error = "设置未完成，没有收到配置保存确认。请重试或改用 DeepSeek。" }
            case .failure: self.error = "设置或服务重启失败，请检查日志与文件权限后重试。"
            }
        })
    }
}

struct LocalModelSetupView: View {
    @ObservedObject var hostModel: HostModel
    @StateObject private var model = LocalModelSetupModel()
    @Environment(\.openWindow) private var openWindow
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("设置本地模型").font(.title2)
            if let hardware = model.hardware {
                Text("\(hardware.cpuModel) · \(hardware.totalMemGB.formatted(.number.precision(.fractionLength(0)))) GB 内存")
            }
            if let recommendation = model.recommendation {
                Text(recommendation.kind == "local" ? "推荐：\(model.selectedModel ?? "")" : "建议使用 DeepSeek").font(.headline)
                Text(recommendation.reason).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if model.ollamaAvailable == false {
                Text("需要安装并启动 Ollama。团子不会自动安装；已有服务请确认地址和访问密钥。")
                    .fixedSize(horizontal: false, vertical: true)
                HStack {
                    Link("下载 Ollama", destination: URL(string: "https://ollama.com/download")!)
                    Button("重新检测") { model.inspect(hostModel) }.disabled(model.running)
                }
            }
            if model.running { ProgressView(value: model.progress) }
            Text(model.step).foregroundStyle(model.success ? .primary : .secondary).fixedSize(horizontal: false, vertical: true)
            if let smoke = model.smoke {
                Text("中文陪伴回复：\(smoke.chinese == true ? "通过" : "未通过")\n工具调用：\(smoke.correctTool == true ? "通过" : "未通过")").font(.callout)
                Text("记忆提取的准确性需要单独验证，例如能否正确记住「我不喝咖啡」。")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if !model.error.isEmpty { Text(model.error).foregroundStyle(.red).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
            HStack {
                if model.running {
                    Button("取消") { hostModel.cancelModelSetup() }.disabled(model.committing)
                } else {
                    if !model.success, model.recommendation?.kind == "local", let size = model.recommendation?.sizeGB {
                        Button("下载并测试（约 \(size.formatted()) GB）") { model.start(hostModel, consent: true) }
                            .disabled(model.ollamaAvailable != true || hostModel.setupRunning || hostModel.busy)
                    }
                    if model.ollamaAvailable != false {
                        Button("重新检测") { model.inspect(hostModel) }.disabled(hostModel.setupRunning || hostModel.busy)
                    }
                    Button("改用 DeepSeek key…") { openWindow(id: "model"); dismiss() }
                }
            }
        }.padding(24).frame(width: 500, alignment: .leading).frame(minHeight: 380, alignment: .topLeading)
            .task { model.inspect(hostModel) }
            .onDisappear { if model.running && !model.committing { hostModel.cancelModelSetup() } }
    }
}
