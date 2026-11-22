import Combine
import SwiftUI

/// 一个正式世界连接在院子与聊天间复用，只有网页执行位移。
@MainActor
final class YardRuntime {
    let web = YardWebController()
    private(set) var events: [[String: Any]] = []
    private(set) var recovery: [[String: Any]] = []
    private var beforeRecovery: [String: Any]?
    var onState: (([String: Any]) -> Void)?
    var onTap: ((String, CGPoint) -> Void)?
    var onUnavailable: ((String) -> Void)?
    private var subscription: AnyCancellable?
    private var queue: [[String: Any]] = []
    private var sending = false
    private var started = false
    private var shared = false
    private var sharedWater: Bool?
    private var mailboxHasMail = false
    private var pageReuseID = UUID()
    private var active = false
    private var lastFacts = ""
    #if DEBUG
    private(set) var factsChecks = 0
    #endif
    private var lastAtmosphere = ""
    private var coverTask: Task<Void, Never>?
    private var coverContext = ""
    private var watchdog: Task<Void, Never>?
    private static let snapshotKey = "maomao.yard3d.snapshot.v1"

    static var savedGoal: String? {
        guard let data = UserDefaults.standard.data(forKey: snapshotKey),
              let state = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return state["goal"] as? String
    }
    init() {
        subscription = web.messages.sink { [weak self] in self?.receive($0) }
    }
    func start(intent: YardIntent.Request, slot: String, weather: String) {
        guard !started, !shared || web.sharedWorld != nil else { return }
        started = true
        if !shared { web.homeIntent = intent.json }
        // 跨进程保留位置/镜头，行为意图由新会话重新选，不重放上次聊天命令。
        if !shared, let data = UserDefaults.standard.data(forKey: Self.snapshotKey),
           var state = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            state["shownSlot"] = slot; state["weather"] = weather
            state["slot"] = NSNull(); state["hour"] = NSNull()
            web.initialSnapshot = state
        }
        var query: [String: String] = ["home": "1", "composition": "1", "dpr": "1.5", "msaa": "0", "fps": "60", "time": slot, "weather": weather]
        #if DEBUG
        query["review"] = "1"
        #endif
        web.load(runID: UUID().uuidString, query: query, active: active)
        armWatchdog()
    }
    func setSharedMode(_ value: Bool, reset: Bool = false) {
        guard shared != value || reset else { return }
        shared = value; started = false; sharedWater = nil; pageReuseID = UUID()
        web.stop(); web.sharedWorld = nil; web.initialSnapshot = nil; web.homeIntent = nil
        coverTask?.cancel(); watchdog?.cancel()
        lastFacts = ""; lastAtmosphere = ""; coverContext = ""
        queue = ["viewport", "controls", "previewMotion"].compactMap { web.homeConfiguration[$0] }
        web.homeConfiguration.removeValue(forKey: "facts")
    }

    func projectShared(_ projection: V2.WorldProjection, intent: YardIntent.Request, updatePage: Bool) {
        let command = projection.command(intent: intent)
        web.sharedWorld = command
        sharedWater = projection.full
        facts(full: projection.full, mail: mailboxHasMail)
        if started {
            if updatePage {
                queue.removeAll { ["intent", "sharedWorld"].contains($0["type"] as? String ?? "") }
                send(command)
            }
        } else { start(intent: intent, slot: projection.slot, weather: projection.weather) }
    }

    func setSharedWater(_ full: Bool) {
        sharedWater = full
        facts(full: full, mail: mailboxHasMail)
    }

    func setActive(_ value: Bool) {
        active = value
        Task { await web.setActive(value); if value { flush(); if !web.surfaceReady { armWatchdog() } } }
    }
    func intent(_ value: YardIntent.Request) {
        if !shared { web.homeIntent = value.json }
        send(value.json)
    }
    func facts(full: Bool, mail: Bool) {
        #if DEBUG
        factsChecks += 1
        #endif
        mailboxHasMail = mail
        let full = shared ? (sharedWater ?? false) : full
        let key = "\(full):\(mail)"
        guard key != lastFacts else { return }; lastFacts = key
        send(["type": "facts", "full": full, "mail": mail])
    }
    func atmosphere(hour: Double, weather: String) {
        guard !shared else { return }
        let key = "\(Int(hour * 60)):\(weather)"
        guard key != lastAtmosphere else { return }; lastAtmosphere = key
        send(["type": "atmosphere", "hour": hour, "weather": weather])
    }
    func send(_ value: [String: Any]) {
        if let type = value["type"] as? String, ["viewport", "controls", "previewMotion", "facts"].contains(type) {
            web.homeConfiguration[type] = value
        }
        // 状态更新只保留最新一条，镜头操作/行为保持顺序。
        if let type = value["type"] as? String, ["facts", "atmosphere", "viewport", "controls", "intent"].contains(type) {
            queue.removeAll { $0["type"] as? String == type }
        }
        queue.append(value); flush()
    }
    private func flush() {
        guard active, web.canSendCommands, !sending, !queue.isEmpty else { return }
        let page = pageReuseID
        sending = true
        Task { [weak self] in
            guard let self else { return }
            while pageReuseID == page, active, web.canSendCommands, !queue.isEmpty {
                let command = queue.removeFirst()
                do {
                    let result = try await web.send(command)
                    if let data = result.data(using: .utf8), let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let error = object["error"] as? String {
                        throw NSError(domain: "YardRuntime", code: 1, userInfo: [NSLocalizedDescriptionKey: error])
                    }
                } catch {
                    if active, pageReuseID == page, !(error is YardProbeError && !web.canSendCommands) {
                        onUnavailable?("小院同步中断，可以重试")
                        web.markUnavailable("小院同步中断，可以重试", detail: error.localizedDescription)
                    }
                    break
                }
            }
            sending = false
            if pageReuseID != page { flush() }
        }
    }
    private func receive(_ message: [String: Any]) {
        let type = message["type"] as? String
        if let type, ["cat", "tap", "firstFrame", "visualReady", "restored", "processTerminated", "contextLost", "error", "unavailable", "paused", "resumed"].contains(type) {
            var event = message.filter { !["report", "snapshot", "runId"].contains($0.key) }
            event["uptime"] = ProcessInfo.processInfo.systemUptime
            events.append(event); if events.count > 200 { events.removeFirst() }
        }
        #if DEBUG
        if type == "error" || type == "unavailable",
           let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
            // 重开后仍能复盘最近一次失败；只保存技术事件，不包含聊天或用户内容。
            let record: [String: Any] = ["events": events, "ready": web.ready, "surfaceReady": web.surfaceReady, "active": active]
            if let data = try? JSONSerialization.data(withJSONObject: record, options: .prettyPrinted) {
                try? data.write(to: directory.appendingPathComponent("yard-last-failure.json"), options: .atomic)
            }
        }
        #endif
        if type == "processTerminated" || type == "contextLost" { beforeRecovery = message["snapshot"] as? [String: Any] }
        if type == "restored", let before = beforeRecovery, let after = message["snapshot"] as? [String: Any] {
            recovery.append(["before": before, "after": after]); beforeRecovery = nil
        }
        if !shared, let state = message["snapshot"] as? [String: Any], let data = try? JSONSerialization.data(withJSONObject: state) {
            UserDefaults.standard.set(data, forKey: Self.snapshotKey)
        }
        switch type {
        case "cat":
            onState?(message)
            if let state = message["snapshot"] as? [String: Any], let slot = state["shownSlot"] as? String,
               let weather = state["weather"] as? String, let place = state["goal"] as? String {
                let camera = state["camera"] as? [String: Any]
                web.updateCoverContext(slot: slot, weather: weather, place: camera?["place"] as? String ?? place)
                let context = "\(slot):\(weather):\(place):\(message["cameraMode"] ?? "")"
                if context != coverContext { coverContext = context; scheduleCover() }
            }
        case "tap":
            if let target = message["target"] as? String, let x = message["x"] as? Double, let y = message["y"] as? Double {
                onTap?(target, CGPoint(x: x, y: y))
            }
        case "firstFrame", "restored":
            lastFacts = ""; lastAtmosphere = ""; flush()
        case "visualReady": watchdog?.cancel(); flush(); scheduleCover()
        case "processTerminated", "contextLost":
            if shared { queue.removeAll { ["intent", "sharedWorld"].contains($0["type"] as? String ?? "") } }
            onUnavailable?("小院正在恢复"); armWatchdog()
        case "error": onUnavailable?(message["message"] as? String ?? "小院暂时无法打开")
        default: break
        }
    }
    private func scheduleCover() {
        coverTask?.cancel()
        coverTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard !Task.isCancelled, let self else { return }; web.captureCover()
        }
    }
    private func armWatchdog() {
        watchdog?.cancel()
        watchdog = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 10_000_000_000)
            guard !Task.isCancelled, let self, web.needsWatchdogFailure(active: active) else { return }
            onUnavailable?("小院暂时无法打开，可以重试"); web.markUnavailable("小院暂时无法打开，可以重试")
        }
    }
    func retry() { web.retry(); armWatchdog() }
}
