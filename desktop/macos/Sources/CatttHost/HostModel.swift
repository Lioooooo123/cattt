import AppKit
import Combine
import Foundation
import ServiceManagement
import HostCore

final class HostModel: ObservableObject {
    static let shared = HostModel()
    @Published var status: [String: String] = [:]
    @Published var error = ""
    @Published var notice = ""
    @Published var busy = true
    @Published var loginEnabled = false
    private let queue = DispatchQueue(label: "app.cattt.host.supervisor", qos: .utility)
    private var timer: DispatchSourceTimer?
    private var started = false
    private var quitting = false
    var icon: String {
        if !error.isEmpty { return "exclamationmark.triangle.fill" }
        if status.values.contains("需要配置模型") { return "key.fill" }
        if status.values.contains(where: { $0.contains("退出") || $0 == "未就绪" }) { return "exclamationmark.triangle.fill" }
        if busy || status["API"] != "正常" { return "clock" }
        return "cat.fill"
    }
    var summary: String {
        if !error.isEmpty { return "团子需要帮助" }
        if status.values.contains("需要配置模型") { return "需要配置模型" }
        return status["API"] == "正常" ? "团子在这台电脑上" : "团子正在启动…"
    }
    func start() {
        guard !started else { return }; started = true
        loginEnabled = SMAppService.mainApp.status == .enabled
        if !UserDefaults.standard.bool(forKey: "attemptedLoginRegistration") {
            UserDefaults.standard.set(true, forKey: "attemptedLoginRegistration"); setLogin(true)
        }
        queue.async {
            do { try host.start(); self.publish() }
            catch { host.shutdown(); self.publish(error: String(describing: error)) }
            let timer = DispatchSource.makeTimerSource(queue: self.queue)
            timer.schedule(deadline: .now(), repeating: 1)
            timer.setEventHandler { [weak self] in
                guard let self else { return }
                if stopping { DispatchQueue.main.async { self.quit() }; return }
                host.tick(); self.publish()
            }
            self.timer = timer; timer.resume()
        }
    }
    private func publish(error: String? = nil, notice: String? = nil) {
        let snapshot = host.status
        DispatchQueue.main.async {
            self.status = snapshot; self.busy = false
            if let error { self.error = error }
            if let notice { self.notice = notice }
        }
    }
    func perform(_ action: @escaping () throws -> String) {
        guard !busy else { return }; busy = true; error = ""; notice = ""
        queue.async {
            do { self.publish(notice: try action()) }
            catch { self.publish(error: String(describing: error)) }
        }
    }
    func saveKey(_ key: String) { perform { try host.configureDeepSeek(key); return "模型配置已保存，服务正在启动" } }
    func backup() { perform { let url = try host.backup(); return "备份完成：\(url.lastPathComponent)" } }
    func restorePicker() {
        let panel = NSOpenPanel(); panel.canChooseFiles = false; panel.canChooseDirectories = true
        panel.directoryURL = host.data.appendingPathComponent("backups"); panel.prompt = "选择备份"
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let source = panel.url else { return }
        let alert = NSAlert(); alert.messageText = "从这个备份恢复？"
        alert.informativeText = "将替换当前数据、证书、管理令牌和模型配置。恢复前会自动备份当前状态。\n\(source.lastPathComponent)"
        alert.alertStyle = .warning; alert.addButton(withTitle: "恢复"); alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        perform { try host.restore(source); return "恢复完成" }
    }
    func openFolder(_ name: String) { NSWorkspace.shared.open(host.data.appendingPathComponent(name)) }
    func setLogin(_ enabled: Bool) {
        do {
            if enabled { try SMAppService.mainApp.register() }
            else { try SMAppService.mainApp.unregister() }
            loginEnabled = SMAppService.mainApp.status == .enabled
            if SMAppService.mainApp.status == .requiresApproval {
                notice = "请在系统设置中允许团子登录时启动"; SMAppService.openSystemSettingsLoginItems()
            }
        } catch { self.error = "登录自启动设置失败：\(error.localizedDescription)" }
    }
    func quit() { NSApp.terminate(nil) }
    func prepareTermination() {
        guard !quitting else { return }; quitting = true
        queue.async {
            self.timer?.cancel(); host.shutdown()
            DispatchQueue.main.async { NSApp.reply(toApplicationShouldTerminate: true) }
        }
    }
}

final class HostDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        HostModel.shared.prepareTermination(); return .terminateLater
    }
}
