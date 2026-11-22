import SwiftUI
import Combine

@MainActor
final class WorldEngine: ObservableObject {
    let uses3D: Bool
    let yard3D: YardRuntime?
    private(set) var intent3D = YardIntent()
    let scene: WorldScene
    @Published private(set) var simulation: WorldSimulation
    @Published private(set) var loadError: String?
    var stateChanged: (() -> Void)?
    var bridgeChanged: (() -> Void)?
    var sharedActionRequested: ((String, String?) -> Void)?
    var sharedRendererLost: (() -> Void)?
    private(set) var sharedMode = false
    private(set) var sharedDriver = false
    private var sharedConnected = false
    private var sharedProjection: V2.WorldProjection?
    private var sharedBehavior: BehaviorParams?
    var agentActionChanged: ((WorldCommand, String, String?) -> Void)?
    private var activeAgentCommand: WorldCommand?
    private var agentFinishUptime: Double?
    private var lastBridgeSnapshot: WorldSnapshot?
    private var bridgeVersion = 0
    private var yard = WorldYardFacts()
    private var runtimeQuiet = false
    private var runtimeResting = false
    private var runtimeUnsocial = false
    var frameChanged: ((Double) -> Void)?
    private var displayLink: CADisplayLink?
    private var clockTarget: WorldClockTarget?
    private var lastTick = ProcessInfo.processInfo.systemUptime
    private var foreground = true
    private var onHome = true
    private var worldEnabled = true
    private var manuallyPaused = false
    private var accumulator = 0.0
    private var tickIntervals:[Double]=[]
    private(set) var maxTickMilliseconds = 0.0
    private(set) var tickCount = 0
    private(set) var totalTickMilliseconds = 0.0
    #if DEBUG
    /// 调试慢放：验收录 0.25 倍速用。只缩放世界时间，不影响镜头和界面动画。
    var debugTimeScale = 1.0 { didSet { yard3D?.send(["type": "motionRate", "value": debugTimeScale]) } }
    #endif

    init() {
        // v5 树窝帧不齐就整段退回 v4，时长和动作名一起换，不混用。
        uses3D = V2Vault.load() != nil || UserDefaults.standard.string(forKey: "world") != "2d"
        yard3D = uses3D ? YardRuntime() : nil
        if !uses3D { WorldInteraction.useV5 = CatActionCatalog.shared.hasV5 }
        let loaded = Self.load()
        scene=loaded.0;loadError=loaded.1
        simulation=WorldSimulation(scene:loaded.0)
        if uses3D, let goal = YardRuntime.savedGoal, let index = YardIntent.places.firstIndex(of: goal) { intent3D.choose(index) }
        yard3D?.onState = { [weak self] message in self?.observe3D(message) }
        yard3D?.onUnavailable = { [weak self] reason in
            guard let self else { return }
            sharedRendererLost?()
            intent3D.unavailable(reason); interruptAgentMove(reason: "world_unavailable"); notifyState()
        }
        let target=WorldClockTarget { [weak self] in self?.advance() }
        clockTarget=target
        let link=CADisplayLink(target:target,selector:#selector(WorldClockTarget.fire))
        link.preferredFrameRateRange=CAFrameRateRange(minimum:30,maximum:60,preferred:60)
        link.add(to:.main,forMode:.common);displayLink=link
    }
    deinit {displayLink?.invalidate()}
    private static func load() -> (WorldScene,String?) {
        var errorMessage: String?
        for asset in ["world-scene-v4","world-scene-v3","world-scene-v2","world-scene-fallback"] {
            do {
                guard let data=NSDataAsset(name:asset)?.data else {throw CocoaError(.fileNoSuchFile)}
                let scene=try JSONDecoder().decode(WorldScene.self,from:data)
                let problems=scene.validationErrors()
                guard problems.isEmpty else {throw NSError(domain:"WorldScene",code:1,userInfo:[NSLocalizedDescriptionKey:problems.joined(separator:"; ")])}
                let missing=(scene.tiles.map(\.image)+scene.objects.map(\.image)).filter{Bundle.main.url(forResource:$0,withExtension:"png")==nil}
                guard missing.isEmpty else {throw NSError(domain:"WorldScene",code:2,userInfo:[NSLocalizedDescriptionKey:"Missing images: \(missing)"])}
                return (scene,errorMessage)
            } catch {errorMessage="小院资源校验失败，已恢复备用场景：\(error.localizedDescription)"}
        }
        // Both bundled configurations must pass the build-time validator.
        preconditionFailure(errorMessage ?? "No world scene")
    }
    private func advance() {
        let now=ProcessInfo.processInfo.systemUptime
        let dt=now-lastTick;lastTick=now
        guard foreground,worldEnabled,dt<0.5 else {return}
        if onHome || uses3D { frameChanged?(dt) }
        guard !manuallyPaused else {return}
        let start=ProcessInfo.processInfo.systemUptime
        if uses3D {
            #if DEBUG
            let intentDT = dt * debugTimeScale
            #else
            let intentDT = dt
            #endif
            if canRunWorld, (!sharedMode || sharedDriver), intent3D.tick(intentDT) { dispatch3D() }
            inspectAgentAction()
            return
        }
        let oldRevision=simulation.revision
        let oldPhase=simulation.phase
        let oldTarget=simulation.target
        let oldCurrent=simulation.current
        #if DEBUG
        simulation.tick(dt*debugTimeScale)
        #else
        simulation.tick(dt)
        #endif
        tickIntervals.append(dt)
        if tickIntervals.count>9000 {tickIntervals.removeFirst()}
        accumulator += dt
        if oldRevision != simulation.revision || oldPhase != simulation.phase || oldTarget != simulation.target || oldCurrent != simulation.current || accumulator>0.1 {
            accumulator=0;notifyState()
        }
        let elapsed=(ProcessInfo.processInfo.systemUptime-start)*1000
        tickCount += 1;totalTickMilliseconds += elapsed;maxTickMilliseconds=max(maxTickMilliseconds,elapsed)
        #if DEBUG
        if tickCount % 300 == 0 {writeSnapshot()}
        #endif
    }
    #if DEBUG
    func placeForReview(_ index:Int) {
        guard !sharedMode else { return }
        if uses3D { guard YardIntent.places.indices.contains(index) else { return }; request(index); intent3D.autonomous = false; yard3D?.send(["type": "teleport", "place": YardIntent.places[index]]); return }
        interruptAgentMove(reason: "user_preempted");simulation.placeForReview(index);notifyState()}
    func writeSnapshot(label:String="world-metrics") {
        let intervals=tickIntervals.sorted()
        let p95=intervals.isEmpty ? 0:intervals[min(intervals.count-1,Int(Double(intervals.count)*0.95))]*1000
        if uses3D {
            var values: [String: Any] = ["uses3D": true, "runnable": canRunWorld, "legacyTicks": tickCount, "action": intent3D.action, "target": intent3D.target, "current": intent3D.current, "requestID": intent3D.request.id, "activity": intent3D.request.activity, "moving": intent3D.moving, "ready": intent3D.ready, "failure": intent3D.failure ?? ""]
            values["snapshot"] = yard3D?.web.snapshot
            values["events"] = yard3D?.events
            values["recovery"] = yard3D?.recovery
            values["business"] = worldSnapshot().json
            values["webReady"] = yard3D?.web.ready
            values["webSurfaceReady"] = yard3D?.web.surfaceReady
            values["webURL"] = yard3D?.web.webView.url?.absoluteString
            values["webLoading"] = yard3D?.web.webView.isLoading
            values["webSize"] = yard3D.map { NSCoder.string(for: $0.web.webView.bounds) }
            values["webFailure"] = yard3D?.web.failure
            if let json = try? JSONSerialization.data(withJSONObject: values, options: .prettyPrinted), let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
                try? json.write(to: dir.appendingPathComponent(label + ".json"), options: .atomic)
            }
            return
        }
        let data:[String:Any]=["worldEnabled":worldEnabled,"displayLinkPaused":displayLink?.isPaused ?? true,"manuallyPaused":manuallyPaused,"ticks":tickCount,"worldSeconds":simulation.time,"meanSimulationMilliseconds":totalTickMilliseconds/Double(max(1,tickCount)),"maxSimulationMilliseconds":maxTickMilliseconds,"p95TimerIntervalMilliseconds":p95,"action":simulation.action,"phase":simulation.phase.rawValue,"x":simulation.point.x,"y":simulation.point.y,"target":simulation.target,"current":simulation.current,"paused":simulation.paused,"onHome":onHome,"foreground":foreground,"textureValidationError":loadError ?? ""]
        if let json=try? JSONSerialization.data(withJSONObject:data,options:.prettyPrinted),let dir=FileManager.default.urls(for:.documentDirectory,in:.userDomainMask).first {
            let safe=label.filter{$0.isLetter || $0.isNumber || $0 == "-"}
            try? json.write(to:dir.appendingPathComponent((safe.isEmpty ? "world-metrics":safe)+".json"),options:.atomic)
        }
    }
    #endif
    private func notifyState() {
        inspectAgentAction()
        stateChanged?()
        bridgeChanged?()
    }
    /// 同一份后端临时状态控制自发活动；不把想安静冒充已经睡着。
    func applyRuntimeState(energy: String, willingness: String) {
        runtimeResting = energy == "resting"
        runtimeUnsocial = willingness == "quiet"
        runtimeQuiet = runtimeResting || runtimeUnsocial
        intent3D.autonomous = activeAgentCommand == nil && !runtimeQuiet
        simulation.autonomous = activeAgentCommand == nil && !runtimeQuiet
    }
    /// 后端临时状态压在性格上（性格系统优化方案第 2.2 节）：
    /// 想休息 → 家与窝只打盹；想安静 → 不看你、也不来门口。
    func adjusted(_ behavior: BehaviorParams) -> BehaviorParams {
        var b = behavior
        if runtimeResting { b.sleepWeight = 1; b.lookWeight = 0; b.groomWeight = 0 }
        if runtimeUnsocial { b.lookWeight = 0; b.comesToDoor = false }
        return b
    }
    func setSharedMode(_ enabled: Bool, reset: Bool = false) {
        guard enabled != sharedMode || reset else { return }
        sharedMode = enabled
        sharedDriver = false; sharedConnected = false
        sharedProjection = nil; sharedBehavior = nil
        interruptAgentMove(reason: "connection_closed")
        intent3D = YardIntent()
        intent3D.autonomous = !enabled
        if !enabled, let goal = YardRuntime.savedGoal, let index = YardIntent.places.firstIndex(of: goal) { intent3D.choose(index) }
        yard = WorldYardFacts()
        yard3D?.setSharedMode(enabled, reset: reset)
        notifyState()
    }

    func setSharedDriver(_ driving: Bool, connected: Bool) {
        sharedDriver = driving
        sharedConnected = connected
        if sharedMode { intent3D.autonomous = driving && connected && activeAgentCommand == nil }
    }

    func applySharedWorld(_ world: V2.WorldRecord, behavior: BehaviorParams?, reproject: Bool) {
        let observation = world.snapshot?.value
        let projection = V2.WorldProjection(observation)
        sharedBehavior = behavior ?? world.localBehavior
        if reproject || !sharedDriver {
            let updatePage = reproject || sharedProjection != projection
            if updatePage { intent3D.projectShared(at: projection.place, activity: projection.activity) }
            sharedProjection = projection
            yard = WorldYardFacts(mood: observation?.mood ?? "calm", moodReason: observation?.moodReason ?? "",
                dayPhase: projection.slot, weather: projection.weather, bowlFilledToday: projection.full,
                lastDrinkAt: observation?.lastDrinkAt, placesToday: observation?.placesToday ?? [])
            yard3D?.projectShared(projection, intent: intent3D.request, updatePage: updatePage)
        }
        updateSharedConditions()
        notifyState()
    }

    private func updateSharedConditions() {
        guard let sharedBehavior else { return }
        let phase = DayPhase(rawValue: yard.dayPhase) ?? .day
        let weather = Weather(rawValue: yard.weather) ?? .clear
        intent3D.conditions(mood: Mood(rawValue: yard.mood) ?? .calm, night: phase.isNight,
            allowed: MoodRules.allowedDestinations(phase: phase, weather: weather),
            bowlFull: yard.bowlFilledToday, behavior: sharedBehavior)
    }

    var hasRunningSharedAction: Bool { activeAgentCommand != nil }
    func fillSharedBowl() -> Bool {
        guard sharedDriver, !yard.bowlFilledToday else { return false }
        yard.bowlFilledToday = true
        yard3D?.setSharedWater(true)
        updateSharedConditions()
        return true
    }

    var currentIndex: Int { uses3D ? intent3D.current : simulation.current }
    var targetIndex: Int { uses3D ? intent3D.target : simulation.target }
    var moving: Bool { uses3D ? intent3D.moving : simulation.isMoving }
    var drinkCount: Int { uses3D ? intent3D.drinkCount : simulation.drinkCount }
    var canRunWorld: Bool { foreground && worldEnabled && !manuallyPaused && (!uses3D || (intent3D.ready && yard3D?.web.surfaceReady == true)) }
    func worldSnapshot() -> WorldSnapshot {
        let destinations = scene.destinations
        var snapshot = WorldSnapshot(stateVersion: bridgeVersion, sceneVersion: scene.version,
            destinationIds: destinations.map(\.id), currentDestinationId: destinations[currentIndex].id,
            targetDestinationId: destinations[uses3D ? intent3D.target : (simulation.pendingTarget ?? simulation.target)].id,
            phase: uses3D ? intent3D.phase : simulation.phase.rawValue, action: uses3D ? intent3D.action : simulation.action,
            paused: uses3D ? !canRunWorld : simulation.paused, runnable: canRunWorld,
            mood: yard.mood, moodReason: yard.moodReason, dayPhase: yard.dayPhase, weather: yard.weather,
            bowlFilledToday: yard.bowlFilledToday, lastDrinkAt: yard.lastDrinkAt, placesToday: yard.placesToday)
        if uses3D { snapshot.activity = intent3D.request.activity; snapshot.activityFallback = intent3D.activityFallback }
        if uses3D, canRunWorld, activeAgentCommand == nil {
            snapshot.companionSeat = intent3D.companionSeat(quiet: runtimeQuiet)
        }
        if var previous = lastBridgeSnapshot {
            previous.stateVersion = snapshot.stateVersion
            if previous != snapshot { bridgeVersion += 1; snapshot.stateVersion = bridgeVersion }
        }
        lastBridgeSnapshot = snapshot
        return snapshot
    }
    /// accepted 已经持久化后才执行；等待网络期间任何世界变化都会使命令失效。
    func beginAgentMove(_ command: WorldCommand, finishAfter: Double) -> Bool {
        let snapshot = worldSnapshot()
        guard canRunWorld, snapshot.stateVersion == command.stateVersion,
              let index = scene.destinations.firstIndex(where: { $0.id == command.destinationId }),
              activeAgentCommand == nil else { return false }
        if command.activity == "sit", snapshot.companionSeat != command.destinationId { return false }
        activeAgentCommand = command
        agentFinishUptime = ProcessInfo.processInfo.systemUptime + max(0, finishAfter)
        simulation.autonomous = false
        if uses3D { intent3D.autonomous = false; intent3D.choose(index, activity: command.activity); dispatch3D() }
        else { simulation.request(index) }
        agentActionChanged?(command, "running", nil)
        notifyState()
        return true
    }
    func interruptAgentMove(reason: String) {
        guard let command = activeAgentCommand else { return }
        activeAgentCommand = nil; agentFinishUptime = nil
        intent3D.autonomous = sharedMode ? (sharedDriver && sharedConnected) : !runtimeQuiet
        simulation.autonomous = !runtimeQuiet
        // 不强切出窝/下栏动画。用户请求走正常重定向；暂停保留安全过渡，回前台不重发命令。
        agentActionChanged?(command, "interrupted", reason)
    }
    private func inspectAgentAction() {
        guard let command = activeAgentCommand else { return }
        if !canRunWorld { interruptAgentMove(reason: "world_paused"); return }
        if let deadline = agentFinishUptime, ProcessInfo.processInfo.systemUptime >= deadline {
            interruptAgentMove(reason: "execution_timeout"); return
        }
        if uses3D { return } // 到达只能由 observe3D 的 settled 回执触发。
        guard let index = scene.destinations.firstIndex(where: { $0.id == command.destinationId }),
              simulation.current == index, simulation.target == index,
              simulation.pendingTarget == nil, !simulation.isMoving, !simulation.isTurning,
              simulation.phase != .exiting else { return }
        // treeScratch 在进窝之前，railUp 在上栏途中；这些都不能算进场完成。
        let settled: Bool
        if let interaction = simulation.interaction {
            settled = [.nestLook, .nestSleep, .railLook, .railSleep, .pondLook, .pondReach,
                       .pondTap, .pondWatch, .pondRest, .flower, .flowerWatch].contains(interaction.stage)
        } else {
            settled = simulation.phase == .idle || (simulation.phase == .interacting && index != 1 && index != 5)
        }
        if settled {
            activeAgentCommand = nil; agentFinishUptime = nil; simulation.autonomous = !runtimeQuiet
            agentActionChanged?(command, "arrived", nil)
        }
    }
    func setVisibility(home:Bool,foreground:Bool,enabled:Bool = true) {
        onHome=home;self.foreground=foreground;worldEnabled=enabled
        displayLink?.isPaused = !enabled || !foreground
        simulation.setPaused(!enabled || !foreground || manuallyPaused)
        yard3D?.setActive(enabled && foreground && !manuallyPaused)
        lastTick=ProcessInfo.processInfo.systemUptime
        notifyState()
    }
    #if DEBUG
    func reviewActivity(_ activity: String) {
        guard !sharedMode, uses3D, ["tilt", "groom", "happy", "sulk", "sad", "nestWatch", "nestSleep", "pond", "fence", "flower", "scratch", "chase", "stretch", "run"].contains(activity) else { return }
        intent3D.autonomous = false
        intent3D.choose((activity == "chase" || activity == "stretch" || activity == "run") ? 3 : (activity == "fence" || activity == "flower") ? 5 : activity == "pond" ? 4 : (activity.hasPrefix("nest") || activity == "scratch") ? 1 : 0, activity: activity == "fence" || activity == "pond" || activity == "nestWatch" ? "watch" : activity == "nestSleep" ? "rest" : activity)
        dispatch3D()
    }
    #endif
    func request(_ index:Int) {
        if sharedMode {
            if YardIntent.places.indices.contains(index) { sharedActionRequested?(YardIntent.places[index], nil) }
            return
        }
        interruptAgentMove(reason: "user_preempted"); if uses3D { intent3D.choose(index); dispatch3D() } else { simulation.request(index) };notifyState() }
    func poke() {if sharedMode && (!sharedDriver || hasRunningSharedAction) { return };interruptAgentMove(reason: "user_preempted");if uses3D { yard3D?.send(["type": "poke"]) } else { simulation.poke() };notifyState()}
    /// 情绪、时段、天气、水碗：每秒由 AppStore 喂一次。
    func setConditions(mood:Mood,night:Bool,allowed:Set<Int>,bowlFull:Bool,behavior:BehaviorParams) {
        guard !sharedMode else { return }
        if uses3D { intent3D.conditions(mood: mood, night: night, allowed: allowed, bowlFull: bowlFull, behavior: adjusted(behavior)); return }
        simulation.setConditions(mood:mood,night:night,allowed:allowed,bowlFull:bowlFull,behavior:adjusted(behavior))
    }
    /// 打开 App：按性格决定来不来门口。
    func greet() { if sharedMode { return }; if uses3D { intent3D.greet(); dispatch3D() } else { simulation.greet() };notifyState() }
    /// 院子里的事实（情绪、时段、天气、水、今天去过哪）：每秒由 AppStore 喂一次，只为送进聊天。
    func setYardFacts(_ facts: WorldYardFacts) {
        guard !sharedMode, facts != yard else { return }
        yard = facts
        bridgeChanged?()
    }
    func sitTogetherInDemo() {
        guard !sharedMode, let seat = worldSnapshot().companionSeat, let index = YardIntent.places.firstIndex(of: seat) else { return }
        intent3D.choose(index, activity: "sit")
        dispatch3D()
        notifyState()
    }
    func requestDrink() { if sharedMode && !sharedDriver { return }; if uses3D { if intent3D.drink() { dispatch3D(); notifyState() }; return }; if simulation.requestDrink() {notifyState()} }
    func togglePause() {
        interruptAgentMove(reason: "world_paused")
        manuallyPaused.toggle();yard3D?.setActive(worldEnabled && foreground && !manuallyPaused);simulation.setPaused(manuallyPaused || !foreground || !worldEnabled)
        lastTick=ProcessInfo.processInfo.systemUptime;notifyState()
    }
    func setSeed(_ value:UInt64) {intent3D.seed(value);simulation.seed(value)}
    func stepFrame() {
        guard !uses3D else { return }
        guard let action=CatAction(rawValue:simulation.action) else {return}
        let spec=action.spec,index=spec.frame(at:simulation.actionTime)
        let duration=spec.frameDurations?[index] ?? (1/spec.fps)
        simulation.stepFrame(duration+0.00001);notifyState()
    }
    func preview(_ name:String) {guard !uses3D else { return };interruptAgentMove(reason: "world_paused");manuallyPaused=true;simulation.preview(name);notifyState()}
    private func dispatch3D() { yard3D?.intent(intent3D.request) }
    private func observe3D(_ message: [String: Any]) {
        let previousPlace = intent3D.current
        let previousDrinks = intent3D.drinkCount
        guard let id = message["id"] as? String, let nearest = message["nearest"] as? String,
              let moving = message["moving"] as? Bool, let action = message["action"] as? String,
              intent3D.observe(id: id, nearest: nearest, moving: moving, action: action,
                 offscreen: message["offscreen"] as? Bool ?? false, cameraMode: message["cameraMode"] as? String ?? "following",
                 fallback: message["fallback"] as? Bool ?? true, drinkDone: message["drinkDone"] as? Bool ?? false) else { return }
        if sharedMode, sharedDriver {
            if intent3D.current != previousPlace {
                yard.placesToday = Array((yard.placesToday + [scene.destinations[intent3D.current].name]).suffix(40))
            }
            if intent3D.drinkCount != previousDrinks { yard.lastDrinkAt = ISO8601DateFormatter().string(from: Date()) }
        }
        if message["settled"] as? Bool == true, let command = activeAgentCommand,
           scene.destinations[intent3D.target].id == command.destinationId,
           !sharedMode || (nearest == command.destinationId && !moving
                && (command.activity != "sit" || (action == "sit_idle" && message["fallback"] as? Bool == false))) {
            activeAgentCommand = nil; agentFinishUptime = nil
            intent3D.autonomous = sharedMode ? (sharedDriver && sharedConnected) : !runtimeQuiet
            agentActionChanged?(command, "arrived", nil)
        }
        notifyState()
    }
    func reset() {
        guard !sharedMode else { return }
        interruptAgentMove(reason: "world_reset")
        if uses3D { intent3D = YardIntent(); dispatch3D() }
        simulation=WorldSimulation(scene:scene);manuallyPaused=false
        intent3D.autonomous = !runtimeQuiet
        simulation.autonomous = !runtimeQuiet
        simulation.setPaused(!foreground || !worldEnabled)
        yard3D?.setActive(foreground && worldEnabled)
        notifyState()
    }
}


@MainActor private final class WorldClockTarget: NSObject {
    let callback: () -> Void
    init(_ callback:@escaping () -> Void) { self.callback=callback }
    @objc func fire() { callback() }
}
