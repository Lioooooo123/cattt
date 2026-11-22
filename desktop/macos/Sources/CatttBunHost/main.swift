import AppKit
import Darwin
import Foundation
import HostCore
import SwiftUI

private struct Options {
    var headless = false
    var data = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support/Cattt Bun Development")
    var port: UInt16 = 18788
    var lanPort: UInt16 = 18789
    var peerPort: UInt16 = 18790
    var backup = false
    var restore: URL?

    init(_ arguments: [String]) throws {
        var remaining = arguments.makeIterator()
        while let arg = remaining.next() {
            switch arg {
            case "--headless": headless = true
            case "--data-dir":
                guard let path = remaining.next(), !path.isEmpty, !path.hasPrefix("--") else {
                    throw HostError("--data-dir 需要一个目录路径")
                }
                data = URL(fileURLWithPath: path, isDirectory: true)
            case "--port", "--lan-port", "--peer-port":
                guard let value = remaining.next().flatMap(UInt16.init), value > 0 else {
                    throw HostError("\(arg) 需要 1 至 65535 的端口")
                }
                if arg == "--port" { port = value }
                else if arg == "--lan-port" { lanPort = value }
                else { peerPort = value }
            case "--backup": backup = true
            case "--restore":
                guard let path = remaining.next(), !path.isEmpty, !path.hasPrefix("--") else {
                    throw HostError("--restore 需要备份目录路径")
                }
                restore = URL(fileURLWithPath: path, isDirectory: true)
            default: throw HostError("未知参数 \(arg)")
            }
        }
        if backup && restore != nil { throw HostError("备份和恢复请分开执行") }
        if (headless || backup || restore != nil) && !arguments.contains("--data-dir") {
            throw HostError("无界面运行需要 --data-dir 指定独立的开发数据目录")
        }
    }
}

private func observeTermination(on queue: DispatchQueue, action: @escaping () -> Void) -> [DispatchSourceSignal] {
    [SIGTERM, SIGINT].map { number in
        signal(number, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: number, queue: queue)
        source.setEventHandler(handler: action)
        source.resume()
        return source
    }
}

private func writeLine(_ text: String, to stream: FileHandle = .standardOutput) {
    try? stream.write(contentsOf: Data((text + "\n").utf8))
}

private func runHeadless(_ host: BunHost) throws {
    let interrupt = DispatchSemaphore(value: 0)
    let signals = observeTermination(on: .global(qos: .utility)) { interrupt.signal() }
    defer { signals.forEach { $0.cancel() }; host.stop() }
    try host.start()
    var previous: BunHost.State = .stopped
    repeat {
        host.tick()
        if host.state != previous {
            if !host.isSupervising { throw HostError(host.state.message) }
            writeLine(host.state.message)
            previous = host.state
        }
    } while interrupt.wait(timeout: .now() + 0.25) == .timedOut
}

final class MenuHost: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let host: BunHost
    private let queue = DispatchQueue(label: "app.cattt.host.bun", qos: .utility)
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let stateItem = NSMenuItem(title: BunHost.State.starting.message, action: nil, keyEquivalent: "")
    private var startItem: NSMenuItem!
    private var stopItem: NSMenuItem!
    private var backupItem: NSMenuItem!
    private var restoreItem: NSMenuItem!
    private var timer: DispatchSourceTimer?
    private var signals: [DispatchSourceSignal] = []
    let windowState = BunHostWindowState()
    @MainActor private lazy var settings = BunSettingsModel(client: host.admin, directory: host.data)
    private var settingsWindow: NSWindow?
    private var window: NSWindow?
    private var currentSupervision = false

    init(host: BunHost) { self.host = host }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let button = item.button {
            button.title = "团子开发宿主"
        }
        let menu = NSMenu()
        menu.autoenablesItems = false
        stateItem.isEnabled = false
        menu.addItem(stateItem)
        menu.addItem(.separator())
        let companion = menu.addItem(withTitle: "打开小院", action: #selector(showCompanion), keyEquivalent: "")
        companion.target = self
        let preferences = menu.addItem(withTitle: "共享设置…", action: #selector(openSettings), keyEquivalent: ",")
        preferences.target = self
        menu.addItem(.separator())
        startItem = menu.addItem(withTitle: "启动服务", action: #selector(start), keyEquivalent: "")
        stopItem = menu.addItem(withTitle: "停止服务", action: #selector(stop), keyEquivalent: "")
        backupItem = menu.addItem(withTitle: "立即备份", action: #selector(backup), keyEquivalent: "")
        restoreItem = menu.addItem(withTitle: "从备份恢复…", action: #selector(restore), keyEquivalent: "")
        let folder = menu.addItem(withTitle: "打开开发数据目录", action: #selector(openData), keyEquivalent: "")
        let quit = menu.addItem(withTitle: "退出开发宿主", action: #selector(quit), keyEquivalent: "q")
        for menuItem in [startItem, stopItem, backupItem, restoreItem, folder, quit] { menuItem?.target = self }
        item.menu = menu
        startItem.isEnabled = false
        stopItem.isEnabled = false
        backupItem.isEnabled = false
        restoreItem.isEnabled = true
        signals = observeTermination(on: .main) { NSApp.terminate(nil) }
        start()
        openCompanion()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: .seconds(1))
        timer.setEventHandler { [weak self] in
            guard let self, self.host.isSupervising else { return }
            self.host.tick()
            self.publish(self.host.state, supervising: self.host.isSupervising)
        }
        self.timer = timer
        timer.resume()
    }

    @MainActor @objc private func openSettings() {
        if settingsWindow == nil {
            let controller = NSHostingController(rootView: BunSettingsView(model: settings))
            let window = NSWindow(contentViewController: controller)
            window.title = "团子 · 共享设置"
            window.setContentSize(NSSize(width: 700, height: 650))
            window.contentMinSize = NSSize(width: 620, height: 480)
            window.isReleasedWhenClosed = false
            window.delegate = self
            window.center()
            settingsWindow = window
        }
        settingsWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func windowWillClose(_ notification: Notification) {
        settingsWindow = nil
    }

    private func publish(_ state: BunHost.State, supervising: Bool) {
        DispatchQueue.main.async {
            guard state != self.windowState.hostState || supervising != self.currentSupervision else { return }
            self.windowState.hostState = state
            self.settings.updateHostState(state)
            self.currentSupervision = supervising
            self.stateItem.title = state.message
            self.item.button?.toolTip = state.message
            self.startItem.isEnabled = !supervising
            self.stopItem.isEnabled = supervising && state != .restoring
            self.backupItem.isEnabled = state == .ready
            self.restoreItem.isEnabled = state != .starting && state != .restoring
        }
    }

    @objc private func start() {
        queue.async {
            do { try self.host.start(); self.publish(self.host.state, supervising: true) }
            catch { self.publish(.failed(String(describing: error)), supervising: false) }
        }
    }

    @objc private func stop() {
        queue.async { self.host.stop(); self.publish(self.host.state, supervising: false) }
    }

    @objc private func backup() {
        queue.async {
            do {
                let path = try self.host.backup()
                self.present("备份完成", path.lastPathComponent)
            } catch { self.present("备份失败", String(describing: error)) }
        }
    }

    @objc private func restore() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.directoryURL = host.backupFolder
        panel.prompt = "选择备份"
        guard panel.runModal() == .OK, let source = panel.url else { return }
        let alert = NSAlert()
        alert.messageText = "从这份备份恢复？"
        alert.informativeText = "恢复期间会暂停手机和另一台 Mac 的连接，并先保存操作前备份。"
        alert.addButton(withTitle: "恢复")
        alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        queue.async {
            self.publish(.restoring, supervising: self.host.isSupervising)
            do { self.present("备份恢复", try self.host.restore(source)) }
            catch { self.present("恢复遇到问题", String(describing: error)) }
            self.publish(self.host.state, supervising: self.host.isSupervising)
        }
    }

    private func present(_ title: String, _ detail: String) {
        DispatchQueue.main.async {
            let alert = NSAlert()
            alert.messageText = title
            alert.informativeText = detail
            alert.runModal()
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openCompanion()
        return true
    }

    @objc private func showCompanion() {
        NSApp.activate()
        openCompanion()
    }

    private func openCompanion() {
        if window == nil {
            let controller = NSHostingController(rootView: CompanionWindow(host: host, state: windowState))
            let companion = NSWindow(contentViewController: controller)
            companion.title = "团子 · 小院"
            companion.styleMask.insert(.resizable)
            companion.setContentSize(NSSize(width: 1040, height: 680))
            companion.center()
            companion.isReleasedWhenClosed = false
            window = companion
        }
        window?.makeKeyAndOrderFront(nil)
    }

    @objc private func openData() { NSWorkspace.shared.open(host.data) }
    @objc private func quit() { NSApp.terminate(nil) }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        timer?.cancel()
        queue.async {
            self.host.stop()
            // A pending AppKit termination waits in the modal run loop.
            RunLoop.main.perform(inModes: [.modalPanel]) {
                sender.reply(toApplicationShouldTerminate: true)
            }
        }
        return .terminateLater
    }
}

do {
    let options = try Options(Array(CommandLine.arguments.dropFirst()))
    let binary = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/cattt-host")
    let host = BunHost(data: options.data, executable: binary, port: options.port, lanPort: options.lanPort, peerPort: options.peerPort)
    if options.backup {
        writeLine(try host.backupFromCommand().path)
    } else if let source = options.restore {
        defer { host.stop() }
        writeLine(try host.restore(source))
    } else if options.headless {
        try runHeadless(host)
    } else {
        let app = NSApplication.shared
        let menu = MenuHost(host: host)
        app.setActivationPolicy(.regular)
        let mainMenu = NSMenu()
        let application = NSMenuItem()
        application.submenu = NSMenu(title: "团子")
        application.submenu?.addItem(withTitle: "退出团子", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        mainMenu.addItem(application)
        let edit = NSMenuItem()
        edit.submenu = NSMenu(title: "编辑")
        edit.submenu?.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.submenu?.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.submenu?.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.submenu?.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        mainMenu.addItem(edit)
        app.mainMenu = mainMenu
        app.delegate = menu
        withExtendedLifetime(menu) { app.run() }
    }
} catch {
    writeLine("宿主错误：\(error)", to: .standardError)
    exit(1)
}
