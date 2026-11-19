#if DEBUG
import Combine
import SwiftUI

/// 第 0 轮实测页（方案「iOS-3D世界层与界面同步」第 5、7 节）：
/// 全屏放 WKWebView 里的 3D 院子，上面盖一行数字；结束时把网页报的帧率、本机的热状态和内存写成一份 JSON。
/// 只进 DEBUG 构建，可从调试面板或 -yardProbe 启动参数进入。
struct YardProbeView: View {
    @StateObject private var probe = YardProbe()
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack(alignment: .top) {
            YardWebSurface(controller: probe.web)
                .ignoresSafeArea()

            VStack(alignment: .leading, spacing: 6) {
                Text(probe.hud)
                    .font(Typo.mono(11))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(Color.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 6))
                if let failure = probe.web.failure {
                    Text(failure)
                        .font(Typo.sans(11))
                        .foregroundStyle(.white)
                        .padding(6)
                        .background(Color.red.opacity(0.7), in: RoundedRectangle(cornerRadius: 6))
                }
            }
            .padding(.top, 52)
            .padding(.leading, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .allowsHitTesting(false)

            VStack {
                Spacer()
                controls
            }
        }
        .preferredColorScheme(.light)
        .onAppear {
            if ProcessInfo.processInfo.arguments.contains("-yardProbe") || UserDefaults.standard.bool(forKey: "yardProbeAutoStart") { probe.start() }
        }
        .onChange(of: scenePhase) { probe.setActive(scenePhase == .active) }
        .onDisappear { probe.close() }
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: 8) {
            if probe.running {
                HStack {
                    Button(probe.finishing ? "正在保存…" : "结束并保存") { Task { await probe.finish() } }.disabled(probe.finishing)
                    Button("找团子") { probe.findCat() }.disabled(probe.finishing)
                    Spacer()
                    Button("关闭") { probe.close(); dismiss() }
                }
                if let summary = probe.summary {
                    Text(summary).font(Typo.mono(10)).foregroundStyle(Palette.ink2)
                }
            } else {
                HStack {
                    Toggle("后处理", isOn: $probe.post)
                    Toggle("绒毛", isOn: $probe.fuzz)
                }
                HStack {
                    Toggle("锁 30", isOn: $probe.lock30)
                    Toggle("走圈", isOn: $probe.walk)
                }
                // 模拟器里多重采样 + 绒毛壳会让 WebKit 一帧都画不完（2026-09-18 实测），真机上两种都要量
                Toggle("离屏多重采样（模拟器要关）", isOn: $probe.msaa)
                Picker("逐级降级", selection: $probe.fallback) {
                    Text("基准").tag(0); Text("关辉光").tag(1); Text("再降阴影").tag(2)
                    Text("再减草").tag(3); Text("再减绒毛层").tag(4); Text("再锁30帧").tag(5)
                }
                Picker("像素比", selection: $probe.dpr) {
                    Text("×1.25").tag(1.25); Text("×1.5").tag(1.5); Text("×2").tag(2.0); Text("×3").tag(3.0)
                }
                .pickerStyle(.segmented)
                Picker("阴影", selection: $probe.shadow) {
                    Text("阴影 2048").tag(2048); Text("1024").tag(1024); Text("512").tag(512)
                }
                .pickerStyle(.segmented)
                Picker("时段", selection: $probe.slot) {
                    ForEach(["auto", "dawn", "day", "dusk", "evening", "night"], id: \.self) { Text(["auto":"跟随时间", "dawn":"清晨", "day":"白天", "dusk":"黄昏", "evening":"傍晚", "night":"夜晚"][$0]!).tag($0) }
                }
                .pickerStyle(.segmented)
                Picker("天气", selection: $probe.weather) {
                    Text("晴").tag("clear"); Text("雨").tag("rain")
                }
                .pickerStyle(.segmented)
                HStack {
                    Button("开始") { probe.start() }.disabled(probe.finishing || probe.saveFailed)
                    if probe.saveFailed { Button("重试保存") { probe.retrySave() } }
                    Spacer()
                    if let summary = probe.summary {
                        Text(summary).font(Typo.mono(10)).foregroundStyle(Palette.ink2)
                    }
                    Spacer()
                    Button("关闭") { probe.close(); dismiss() }
                }
            }
        }
        .font(Typo.sans(12))
        .padding(12)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: Metrics.radiusCard))
        .padding(.horizontal, 12)
        .padding(.bottom, 36)
    }
}

@MainActor
final class YardProbe: ObservableObject {
    let web = YardWebController()
    @Published var post = true
    @Published var fuzz = true
    @Published var lock30 = false
    @Published var walk = true
    #if targetEnvironment(simulator)
    @Published var msaa = false
    #else
    @Published var msaa = true
    #endif
    @Published var dpr = 1.25
    @Published var shadow = 2048
    @Published var fallback = 0
    @Published var slot = "day"
    @Published var weather = "clear"
    @Published private(set) var running = false
    @Published private(set) var finishing = false
    @Published private(set) var saveFailed = false
    @Published private(set) var hud = "未开始"
    @Published private(set) var summary: String?
    private var runID = ""
    private var firstFrameMs: Double?
    private var loadMs: Double?
    private var pages: [String: [String: Any]] = [:]
    private var failures: [String] = []
    private var thermalSamples: [[String: Any]] = []
    private var footprintSamples: [[String: Any]] = []
    private var environmentSamples: [[String: Any]] = []
    private var previousIdleTimerDisabled: Bool?
    private var previousBatteryMonitoring: Bool?
    private var events: [[String: Any]] = []
    private var options: [String: String] = [:]
    private var started = Date()
    private var uptime = 0.0
    private var active = true
    private var deadline: Task<Void, Never>?
    private var timer: AnyCancellable?
    private var subscription: AnyCancellable?
    private var pendingRecord: [String: Any]?
    private var closed = false
    private var processFaultInjected = false

    init() {
        let ud = UserDefaults.standard
        if let value = ud.string(forKey: "yardProbeDPR"), let number = Double(value), [1.25, 1.5, 2, 3].contains(number) { dpr = number }
        if let value = ud.string(forKey: "yardProbeTime"), ["auto", "dawn", "day", "dusk", "evening", "night"].contains(value) { slot = value }
        if let value = ud.string(forKey: "yardProbeWeather"), ["clear", "rain"].contains(value) { weather = value }
        if ud.object(forKey: "yardProbeMSAA") != nil { msaa = ud.bool(forKey: "yardProbeMSAA") }
        lock30 = ud.bool(forKey: "yardProbe30")
        if ud.object(forKey: "yardProbeWalk") != nil { walk = ud.bool(forKey: "yardProbeWalk") }
        fallback = min(5, max(0, ud.integer(forKey: "yardProbeFallback")))
    }

    func start() {
        guard !running, !finishing, !saveFailed else { return }
        cleanup()
        previousIdleTimerDisabled = UIApplication.shared.isIdleTimerDisabled
        previousBatteryMonitoring = UIDevice.current.isBatteryMonitoringEnabled
        UIApplication.shared.isIdleTimerDisabled = true
        UIDevice.current.isBatteryMonitoringEnabled = true
        closed = false; running = true; summary = nil; pendingRecord = nil
        runID = UUID().uuidString; started = Date(); uptime = ProcessInfo.processInfo.systemUptime
        firstFrameMs = nil; loadMs = nil; pages = [:]; failures = []; events = []; thermalSamples = []; footprintSamples = []; environmentSamples = []
        processFaultInjected = false
        options = ["walk": walk ? "1" : "0", "dpr": String(dpr), "shadow": String(shadow), "weather": weather,
                   "post": post ? "1" : "0", "fuzz": fuzz ? "1" : "0", "msaa": msaa ? "2" : "0", "fps": lock30 ? "30" : "60"]
        options["fallback"] = String(fallback)
        options["bloom"] = fallback >= 1 ? "0" : "1"
        options["grass"] = fallback >= 3 ? "0.5" : "1"
        options["shells"] = fallback >= 4 ? "2" : "4"
        if fallback >= 2 { options["shadow"] = "1024" }
        if fallback >= 5 { options["fps"] = "30" }
        if slot != "auto" { options["time"] = slot }
        if let fault = UserDefaults.standard.string(forKey: "yardProbeFault"), ["model-missing", "no-first-frame", "save-failed", "report-timeout", "context-loss", "scale-cycle", "process-termination"].contains(fault) { options["fault"] = fault }
        subscription = web.messages.sink { [weak self] in self?.receive($0) }
        web.load(runID: runID, query: options, active: active)
        timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect().sink { [weak self] _ in self?.sample() }
        sample(); armDeadline(reason: "启动后 10 秒没有首帧")
        hud = "加载中…"
    }

    func setActive(_ value: Bool) {
        active = value
        guard running, !finishing else { return }
        events.append(["at": elapsed, "type": value ? "nativeActive" : "nativeInactive"])
        if !value { deadline?.cancel() }
        else { armDeadline(reason: firstFrameMs == nil ? "启动后 10 秒没有首帧" : "回到前台后 10 秒没有渲染心跳") }
        Task { await web.setActive(value) }
    }

    func findCat() {
        guard running, !finishing, web.canSendCommands else { return }
        Task { _ = try? await web.send(["type": "findCat"]) }
    }

    func close() {
        closed = true
        if running && !finishing { Task { await finish(reason: "用户提前关闭") } }
        else if !finishing { cleanup(); web.stop() }
    }

    func finish(reason: String? = nil) async {
        guard running, !finishing else { return }
        finishing = true
        if let reason { fail(reason) }
        deadline?.cancel(); timer?.cancel()
        let expected = runID
        do {
            let json = try await web.send(["type": "report"])
            guard let report = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any],
                  report["frames"] is NSNumber else { throw YardProbeError.invalidResponse }
            pages[web.identity.pageID] = report
        } catch { fail("报告获取失败：\(error)") }
        guard runID == expected else { return }
        // 先落盘，避免停止网页的失败阻止保存部分数据。
        pendingRecord = makeRecord()
        retrySave()
        // stop 不依赖 JS；即使 WebKit 忙死仍然能结束本轮。
        cleanup(); web.stop()
        running = false; finishing = false
    }

    func retrySave() {
        guard let record = pendingRecord else { return }
        do {
            var directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("yard-probe")
            if UserDefaults.standard.string(forKey: "yardProbeFault") == "save-failed" { directory = URL(fileURLWithPath: "/dev/null/yard-probe") }
            let file = try YardProbeArchive.save(record, directory: directory, name: runID)
            saveFailed = false
            summary = "\(record["status"] ?? "缺测") · 已存 Documents/yard-probe/\(file.lastPathComponent)"
            hud = failures.isEmpty ? "实测记录已保存；真机闸门仍需补齐外部验收" : "本轮未通过：\(failures.joined(separator: "；"))"
        } catch {
            saveFailed = true
            summary = "保存失败，可重试：\(error.localizedDescription)"
            hud = "保存失败；结果尚未落盘"
        }
    }

    private func receive(_ message: [String: Any]) {
        guard running, message["runId"] as? String == runID, web.identity.accepts(message) else { return }
        let type = message["type"] as? String ?? ""
        if let report = message["report"] as? [String: Any] { pages[web.identity.pageID] = report }
        switch type {
        case "ready": loadMs = message["loadMs"] as? Double
        case "firstFrame":
            if firstFrameMs == nil { firstFrameMs = elapsed * 1000 }
            armDeadline(reason: "前台 10 秒没有渲染心跳")
        case "visualReady":
            armDeadline(reason: "前台 10 秒没有渲染心跳")
            #if DEBUG
            if options["fault"] == "process-termination", !processFaultInjected {
                processFaultInjected = true
                Task { [weak self] in
                    try? await Task.sleep(nanoseconds: 500_000_000)
                    self?.web.simulateContentProcessTermination()
                }
            }
            #endif
        case "perf":
            armDeadline(reason: "前台 10 秒没有渲染心跳")
            let fps = message["fps"] as? Double ?? 0
            let scale = message["scale"] as? Double ?? 0
            let memory = Self.footprintMB().map { String(format: "%.0f MB", $0) } ?? "缺测"
            hud = String(format: "%.0f fps · ×%.2f · %.0f 秒\n热 %@ · App %@", fps, scale, elapsed, Self.thermalName(ProcessInfo.processInfo.thermalState), memory)
            if let report = message["report"] as? [String: Any] {
                let target = UserDefaults.standard.double(forKey: "yardProbeDuration")
                if target > 0, (report["seconds"] as? Double ?? 0) >= target, !finishing { Task { await finish() } }
            }
            return
        case "error":
            fail(message["message"] as? String ?? "网页错误")
            if !finishing { Task { await finish() } }
        case "processTerminated":
            fail("网页内容进程被系统结束")
            armDeadline(reason: "内容进程重载后 10 秒没有首帧")
        case "contextLost": armDeadline(reason: "上下文丢失后 10 秒未恢复渲染")
        default: break
        }
        var event = message
        event["at"] = elapsed
        events.append(event)
    }

    private var elapsed: Double { ProcessInfo.processInfo.systemUptime - uptime }
    private func fail(_ reason: String) { if !failures.contains(reason) { failures.append(reason) } }
    private func armDeadline(reason: String) {
        deadline?.cancel()
        guard active, running, !finishing else { return }
        let expected = runID
        deadline = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 10_000_000_000) } catch { return }
            guard let self, runID == expected, running, !finishing else { return }
            await finish(reason: reason)
        }
    }
    private func cleanup() {
        deadline?.cancel(); deadline = nil
        timer?.cancel(); timer = nil; subscription?.cancel(); subscription = nil
        if let previousIdleTimerDisabled { UIApplication.shared.isIdleTimerDisabled = previousIdleTimerDisabled }
        if let previousBatteryMonitoring { UIDevice.current.isBatteryMonitoringEnabled = previousBatteryMonitoring }
        previousIdleTimerDisabled = nil; previousBatteryMonitoring = nil
    }
    private func sample() {
        let thermal = Self.thermalName(ProcessInfo.processInfo.thermalState)
        if thermalSamples.last?["state"] as? String != thermal { thermalSamples.append(["at": elapsed, "state": thermal, "active": active]) }
        footprintSamples.append(["at": elapsed, "mb": Self.footprintMB() as Any? ?? NSNull(), "active": active])
        let battery: String
        switch UIDevice.current.batteryState {
        case .unplugged: battery = "unplugged"
        case .charging: battery = "charging"
        case .full: battery = "full"
        default: battery = "unknown"
        }
        environmentSamples.append(["at": elapsed, "brightness": UIScreen.main.brightness,
                                   "batteryState": battery, "lowPowerMode": ProcessInfo.processInfo.isLowPowerModeEnabled,
                                   "active": active])
    }
    private func makeRecord() -> [String: Any] {
        let buildURL = Bundle.main.url(forResource: "YardWeb", withExtension: nil)?.appendingPathComponent("probe-build.json")
        let build = buildURL.flatMap { try? Data(contentsOf: $0) }.flatMap { try? JSONSerialization.jsonObject(with: $0) } ?? NSNull()
        if firstFrameMs == nil { fail("没有首帧") }
        if thermalSamples.contains(where: { ["serious", "critical"].contains($0["state"] as? String ?? "") }) { fail("热状态超过 fair") }
        if footprintSamples.contains(where: { ($0["mb"] as? Double ?? 0) > 450 }) { fail("App 单进程内存已超过 450 MB") }
        let report = pages[web.identity.pageID] ?? [:]
        let seconds = report["seconds"] as? Double ?? 0
        if seconds >= 300 {
            if (report["medianFps"] as? Double ?? 0) < 55 { fail("中位帧率低于 55") }
            if (report["low1Fps"] as? Double ?? 0) < 40 { fail("1% 低帧率低于 40") }
            if (report["minScale"] as? Double ?? 0) <= 0.75 { fail("自适应倍率触底") }
        }
        if let touch = report["touch"] as? [String: Any], (touch["maxFrameDelay"] as? Int ?? 0) > 1 { fail("触摸到镜头更新超过 1 帧") }
        if let trajectory = report["trajectoryClearance"] as? [String: Any], (trajectory["violations"] as? Int ?? 0) > 0 { fail("3D 实际行走轨迹发生实体穿透") }
        let missing = ["真机五分钟白天晴/夜晚雨矩阵", "连续十分钟热状态", "网页内容进程内存及两进程合计", "能耗", "图标到首帧录屏", "前后台十次/锁屏人工复核", "清晰度三档人工选择"]
        return ["schemaVersion": 2, "runId": runID, "status": failures.isEmpty ? "缺测" : "未通过", "failures": failures,
                "device": Self.deviceModel, "system": UIDevice.current.systemVersion, "isSimulator": Self.isSimulator,
                "screen": ["width": UIScreen.main.bounds.width, "height": UIScreen.main.bounds.height, "scale": UIScreen.main.scale],
                "build": build, "options": options, "startedAt": ISO8601DateFormatter().string(from: started), "wallSeconds": elapsed,
                "resourceReadyMs": loadMs as Any? ?? NSNull(), "hostToFirstRenderMs": firstFrameMs as Any? ?? NSNull(),
                "firstFrameDefinition": "render返回并由Swift收到消息，非合成器显示时间；图标到首帧需录屏",
                "pageReports": pages, "thermal": thermalSamples, "appFootprintMB": footprintSamples,
                "environment": environmentSamples,
                "webContentFootprintMB": NSNull(), "missing": missing, "events": events,
                "lastSnapshot": web.snapshot as Any? ?? NSNull(), "closedEarly": closed]
    }
    private static var isSimulator: Bool {
        #if targetEnvironment(simulator)
        true
        #else
        false
        #endif
    }
    static func footprintMB() -> Double? {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        return result == KERN_SUCCESS ? Double(info.phys_footprint) / 1_048_576 : nil
    }
    static func thermalName(_ state: ProcessInfo.ThermalState) -> String {
        switch state {
        case .nominal: return "nominal"
        case .fair: return "fair"
        case .serious: return "serious"
        case .critical: return "critical"
        @unknown default: return "unknown"
        }
    }
    static var deviceModel: String {
        var system = utsname(); uname(&system)
        let machine = withUnsafePointer(to: &system.machine) { $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) } }
        return isSimulator ? "simulator(\(ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] ?? machine))" : machine
    }
}
#endif
