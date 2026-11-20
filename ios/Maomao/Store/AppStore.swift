import SwiftUI

/// 全部界面状态与状态转换。
///
/// 本版所有数据都是本地 mock —— 真实实现要接的四个口子（世界状态、聊天流式、
/// 日记碎片与访问状态、记忆条目 CRUD）都标了 `TODO: 后端`，逻辑形状按真接口的
/// 时序写好了（发送落地 / 等待 / 流式 / 可停止 / 可重试），换成网络层不用动界面。
@MainActor
final class AppStore: ObservableObject {

    // MARK: - 路由

    /// 日记进了院子里的信箱、「我的」上了右上角，整屏只剩院子和聊天。
    enum Screen { case home, chat }

    typealias OnboardingStep = CreationDraft.Step

    @Published var yardProbeVisible: Bool = {
        #if DEBUG
        return ProcessInfo.processInfo.arguments.contains("-yardProbe") || ProcessInfo.processInfo.arguments.contains("-yardComposition")
        #else
        return false
        #endif
    }()
    @Published var screen: Screen = .home
    /// nil = 已经有猫了，走正常四屏。
    @Published var onboarding: OnboardingStep?

    // MARK: - 世界

    /// Debug comparison only; not persisted as a new product setting.
    @Published var worldDepthEnabled = true
    let world = WorldEngine()
    var worldBridge: WorldBridge?
    @Published var viewedIndex = 0
    @Published private(set) var reaction: String?
    @Published private(set) var camera = WorldCamera()
    let worldTextures: WorldTextureCache
    var cameraX: CGFloat { camera.x }
    var cameraFollowsCat: Bool { camera.followsCat }
    @Published var worldGeometry = WorldGeometry.placeholder

    // MARK: - 时段、天气、情绪、水碗（AppStore+Conditions.swift）

    @Published var dayPhase: DayPhase = .day
    @Published var weather: Weather = .clear
    @Published var atmosphere = AtmosphereParams.day
    @Published var mood = MoodEvaluation.calm
    @Published var bowlFilledAt: Date? { didSet { syncHomeFacts() } }
    @Published var lastDrinkAt: Date?
    /// 倒水动画进度：1 刚开始，0 结束；0.5 是"碗已经满了，水晃一下"。
    @Published var pouring = 0.0
    @Published var allowProactive = false
    @Published var proactiveBusy = false
    @Published var proactiveError: String?
    @Published var rainSoundEnabled = true { didSet { UserDefaults.standard.set(rainSoundEnabled, forKey: Self.rainSoundKey) } }
    /// 院子的天气怎么来（我的 → 设置）。手动切换时雨三秒起落，不等一分钟。
    @Published var weatherMode: WeatherMode = .real {
        didSet { UserDefaults.standard.set(weatherMode.rawValue, forKey: Self.weatherModeKey); rainQuick = true; conditionsClock = 1 }
    }
    /// 跟着真实天气但拿不到位置时，设置里那一行下面的说明。
    @Published var weatherNote: String?
    let realWeather = RealWeather()
    var rainQuick = false
    var createdAt = Date()
    /// 领养到今天几天（第一天 0）。慢热的猫靠它判断熟没熟。
    var adoptionDays: Int { MoodRules.daysBetween(createdAt, currentDate(), calendar: .current) }
    var familiar: Bool { temperament != .slow || adoptionDays >= BehaviorParams.slowWarmupDays }
    /// 性格编译出来的行为参数：院子每秒取一次，聊天和日记也用它。
    @Published var behavior = BehaviorParams.compile(temperament: .slow)
    /// 这次打开 App 已经按性格打过招呼了。
    var greetedThisSession = false
    var previousVisitAt: Date?
    let sessionStartedAt = Date()
    var pokeTimes: [Date] = []
    var interactedThisSession = false
    var rainAmount = 0.0
    var conditionsClock = 1.0
    var lastDrinkCount = 0
    var visitedPlacesToday: [String] = []
    var lastPlaceIndex = -1
    var catDiaryDate: Date?
    let rainSound = RainSound()
    #if DEBUG
    var debugHour: Double?
    var debugWeather: Weather?
    var debugMood: Mood?
    #endif
    var catIndex: Int { world.currentIndex }
    var viewedLocation: Location { Location.all[viewedIndex] }
    var catLocation: Location { Location.all[world.currentIndex] }
    var isLost: Bool { if world.uses3D { return world.intent3D.offscreen || world.intent3D.cameraMode != "following" }; return !worldGeometry.isVisible(CGFloat(world.simulation.renderPoint.x), cameraX: effectiveCameraX()) }
    var catAction: CatAction { CatAction(rawValue:world.simulation.action) ?? .blinkLook }
    func catPose(at date: Date = Date()) -> (point: CGPoint, facing: Facing) {
        (world.simulation.point.cgPoint,world.simulation.facingRight ? .right:.left)
    }
    func effectiveCameraX(at date: Date = Date()) -> CGFloat {
        cameraX
    }
    var statusText: String {
        if let reaction {return reaction}
        if world.uses3D {
            if let failure = world.intent3D.failure { return failure }
            if world.moving { return "团子正往" + Location.all[world.targetIndex].name + "走" }
            switch world.intent3D.action {
            case "sleep_idle": return "团子在小窝里睡着了"
            case "sleep_down": return "团子正在小窝里趴下"
            case "doze_idle": return "团子在门口打瞌睡"
            case "drink_down": return "团子低头凑近水面"
            case "drink_lap": return "团子在慢慢喝水"
            case "drink_up": return "团子抬起了头"
            case "run_ready": return "团子准备跑两步"
            case "run_stride": return "团子在小跑"
            case "run_settle": return "团子慢下来站稳了"
            case "stretch_reach": return "团子把前爪伸了出去"
            case "stretch_down", "stretch_hold": return "团子在伸懒腰"
            case "stretch_up", "stretch_settle": return "团子慢慢收回爪子"
            case "chase_look": return "团子回头盯着尾巴"
            case "chase_turn": return "团子在追自己的尾巴"
            case "chase_settle": return "团子停下来站稳了"
            case "scratch_reach", "scratch_grip": return "团子把前爪搭在树干上"
            case "scratch_rake": return "团子在树上磨爪子"
            case "scratch_release", "scratch_settle": return "团子收爪站稳了"
            case "flower_watch", "flower_crouch": return "团子盯住了小花"
            case "flower_pounce", "flower_touch": return "团子伸爪扑向小花"
            case "flower_recoil", "flower_recover": return "团子收回爪子站稳了"
            case "fence_reach", "fence_jump", "fence_grip": return "团子伸爪够着栅栏"
            case "fence_climb", "fence_turn", "fence_down": return "团子正爬上横木"
            case "fence_rest": return "团子趴在栅栏上看院子"
            case "fence_wake", "fence_turn_out", "fence_out", "fence_drop", "fence_land": return "团子正从栅栏下来"
            case "pond_down", "pond_probe": return "团子伸爪试了试水"
            case "pond_pat": return "团子轻轻拍着水面"
            case "pond_shake", "pond_up": return "团子收回爪子甩甩水"
            case "nest_watch": return "团子在树窝里看着院子"
            case "nest_sleep": return "团子在树窝里睡着了"
            case "nest_grab", "nest_climb": return "团子正爬进树窝"
            case "nest_out", "nest_drop", "nest_land": return "团子正从树窝下来"
            case "tilt_idle": return "团子歪着头看你"
            case "groom_idle": return "团子在慢慢理毛"
            case "happy_idle": return "团子翘着尾巴，看起来很高兴"
            case "sulk_idle": return "团子把脸转到一边"
            case "sad_idle": return "团子垂着耳朵，安静地坐着"
            case "bed_hop": return "团子轻轻跳过窝沿"
            default: break
            }
            if world.intent3D.request.activity == "drink" { return world.intent3D.activityFallback ? "团子在水盆边看着水" : "团子在水盆边歇着" }
            if mood.mood != .calm { return yardMoodReason }
            return "\(catName) · \(catLocation.name) · \(dayPhaseName) · \(weather == .rain ? "雨" : "晴")"
        }
        if world.simulation.isDrinking {
            switch world.simulation.drink {
            case .going: return "团子去喝水了"
            case .down, .lap: return "团子在喝水"
            case .up: return "团子喝完水，舔了舔嘴"
            default: return "团子喝完水回来了"
            }
        }
        if let sequence=world.simulation.interaction {
            if weather == .rain, sequence.inNest {return "下雨了，团子躲在树窝里"}
            switch sequence.stage {
            case .pondLook,.pondWatch,.pondRest:return "团子在池边看水纹"
            case .pondReach,.pondTap:return "团子伸爪轻轻拍了拍水"
            case .pondShake,.pondRecover:return "团子甩了甩爪上的水珠"
            case .nestSleep:return "团子在树上的小窝里睡着了"
            case .nestLook:return "团子从窝口望着你"
            case .flower,.flowerWatch:return "团子在轻轻拨弄花朵"
            case .railLook,.railBalance:return "团子趴在栅栏上看风景"
            case .railSleep:return "团子趴在栅栏上睡着了"
            default:return sequence.isTree ? "团子在树上的小窝边活动":"团子在栅栏边活动"
            }
        }
        if world.simulation.isMoving {return "团子正往" + world.scene.destinations[world.simulation.target].name + "走"}
        if isLost {return viewedLocation.name + "这边没有猫"}
        switch world.simulation.action {
        case "scratchEnter", "treeScratch": return "团子在树上磨爪子"
        case "tailChase": return "团子在追自己的尾巴"
        default:
            if world.simulation.hiddenInGrass {return "团子藏在草丛里，轻点草丛叫叫它"}
            if world.simulation.current == 0 {
                // 情绪有原因就说原因；否则按时段和天气说一句。
                if mood.mood != .calm {return mood.reason}
                if let line=MoodCopy.phaseLine(dayPhase,weather:weather,atHome:true) {return line}
                return MoodCopy.temperamentLine(temperament,familiar:familiar)
            }
            if world.simulation.current == 2, dayPhase.isNight, let line=MoodCopy.phaseLine(dayPhase,weather:weather,atHome:false) {return line}
            if world.simulation.current == 1 {return "团子在树荫下歇着"}
            return catLocation.lines[0]
        }
    }

    var yardMoodReason: String {
        guard world.uses3D else { return mood.reason }
        return mood.reason
            .replacingOccurrences(of: "团子把自己缩成一团，好几天没见到你了", with: "好几天没见到你，团子有点难过")
            .replacingOccurrences(of: "团子缩成一团，碗已经空了两天", with: "碗已经空了两天，团子有点难过")
            .replacingOccurrences(of: "下雨了，团子缩在屋檐下", with: "下雨了，团子想安静歇会儿")
            .replacingOccurrences(of: "团子背对着门口，碗空了一整天", with: "碗空了一整天，团子有点闷闷的")
            .replacingOccurrences(of: "团子背过身去，不想再被戳了", with: "团子不想再被戳了")
            .replacingOccurrences(of: "团子尾巴翘得老高，刚喝过水", with: "团子刚喝过水，心情不错")
            .replacingOccurrences(of: "团子尾巴翘着，今天的水是满的", with: "今天的水是满的，团子心情不错")
    }
    var dayPhaseName: String { ["dawn": "清晨", "day": "白天", "dusk": "黄昏", "evening": "傍晚", "night": "夜晚"][dayPhase.rawValue] ?? "白天" }

    // MARK: - 聊天

    /// 来源卡：从日记留言或话题卡跳进来时出现。
    struct ChatSource: Equatable {
        let kicker: String
        let text: String
        var diaryEntryID: String? = nil
    }

    /// 长按气泡弹出的底部菜单。
    struct MessagePanel: Equatable {
        let id: String
        let isCat: Bool
    }

    @Published var messages = SeedData.messages
    @Published var hasEarlierMessages = false
    @Published var isLoadingEarlierMessages = false
    @Published var historyLoadError: String?
    var historyGeneration = UUID()
    var earliestMessageSequence: Int?
    @Published var draft = ""
    @Published var isWaiting = false
    @Published var isStreaming = false
    @Published var chatSource: ChatSource?
    @Published var messagePanel: MessagePanel?

    // MARK: - 日记

    @Published var entries: [DiaryEntry] = [] {
        didSet { diaryReadIndex = DiaryReadIndex(entries: entries) }
    }
    private(set) var diaryReadIndex = DiaryReadIndex(entries: [])
    @Published var selectedDiaryDay: String?
    @Published var diaryLoadFailed = false
    var diaryGeneration = UUID()
    var diaryRetryAfter = Date.distantPast
    @Published var isCapturing = false
    @Published var captureText = ""
    @Published var captureSaveFailed = false
    @Published var captureForCat = false
    @Published var diarySyncFailed = false
    @Published var diarySyncFinished = false
    @Published var diarySyncTask: Task<Void, Never>?
    var diarySyncAgain = false
    var diaryChangeCursor: Int?
    var diarySyncEpoch: String?
    @Published var diaryFilter: DiaryFilter = .all
    var shownEntries: [DiaryEntry] { diaryEntries(on: diaryDay).filter(diaryFilter.matches) }
    /// 信箱里有新东西（团子来看过 / 留了一句）：旗子立起来。打开信箱就放下。
    @Published var hasMail = false { didSet { syncHomeFacts() } }
    /// 日记纸是否从信箱里抽出来了。
    @Published var mailboxLetters: [APIMailboxLetter] = []
    @Published var inboxError: String?
    var inboxTask: Task<Void, Never>?
    var inboxRefreshPending = false
    @Published var mailboxOpen = false
    /// 抽纸的起点：信箱投信口的屏幕坐标，点信箱时由 `WorldView` 量好带进来。
    @Published var mailboxAnchor = CGPoint(x: 60, y: 520)
    /// 旗子当前角度：0 立起，-90 平放在箱顶。逐帧朝目标插值，画布不走隐式动画。
    @Published private(set) var flagAngle: Double = -90

    // MARK: - 我的

    /// 右上角头像钮打开的系统 sheet。
    @Published var showsMe = false
    @Published var showsMemoryControls = false
    @Published var memoryShowsBoundaries = false
    @Published var withdrawnSource: MemoryImpactAction?
    @Published var memoryCount = 37
    @Published var boundaryCount = 2

    // MARK: - 后端

    /// 聊天走本地模拟还是本机后端。切换走 `setBackendMode(_:)`。
    @Published var backend = BackendConfig.load() {
        didSet {
            backend.save()
            if backend.storageIdentity != oldValue.storageIdentity {
                mailboxLetters = []; inboxError = nil
                loadCreation(); loadDiary()
            }
        }
    }
    /// 调试面板上显示的连接状态。
    @Published var backendStatus: String?
    @Published var showsPairing = false
    @Published var pairInvitation: PairInvitation?
    @Published var pairingError: String?
    @Published var pairingBusy = false
    var pairedProbeTask: Task<Void, Never>?
    var lastPairProbe = Date.distantPast
    @Published var identityError: String?
    var registeredNotificationDeviceID: String?
    var resolvingNotification = false
    @Published var notificationMessageID: String?
    @Published var notificationLetterID: String?
    /// 同一次 App 启动中，每个本机后端配置只上报一次，重连不重复发送。
    var timeZoneReportedBackends: [BackendConfig] = []
    var remoteChatGeneration = UUID()
    /// 当前这一轮回复在服务端的 id，停止时要用。
    var remoteTurnID: String?
    /// 用户按了停止：之后到的字不再显示。
    var remoteStopped = false
    /// 收到 accepted 后 50 秒没有第一个字就判超时。
    var watchdogTask: Task<Void, Never>?

    // MARK: - 创建流程

    @Published var pickedAppearance = "orange" { didSet { persistCreationDraft() } }
    @Published var temperament: Temperament = .slow { didSet { compileBehavior(); persistCreationDraft() } }
    @Published var traitsOpen = false { didSet { persistCreationDraft() } }
    @Published var traitLevels: [Trait: Int] = Trait.defaults { didSet { compileBehavior(); persistCreationDraft() } }
    @Published var nameDraft = "" { didSet { persistCreationDraft() } }
    @Published var nameError: String?
    @Published var namePoolIndex = 0

    typealias MeetLine = CreationLine

    @Published var meetDone = false
    @Published var meetDraft = "" { didSet { persistCreationDraft() } }
    @Published var meetLines: [MeetLine] = []
    @Published var creationLoadFailed = false
    @Published var creationSaveFailed = false
    var creationArchive = CreationArchive()
    var restoringCreation = true
    var meetReplyPending: Bool { creationArchive.draft?.meeting == .replyPending }
    var firstMeetingReply: String? {
        if let draft = creationArchive.draft { return draft.firstReply }
        return creationArchive.profile?.firstReply
    }

    var catName: String { nameDraft.trimmed.isEmpty ? SeedData.defaultCatName : nameDraft.trimmed }
    var isNameValid: Bool { CreationDraft.validName(nameDraft) }
    var nameSuggestions: [String] { SeedData.namePool[namePoolIndex % SeedData.namePool.count] }

    // MARK: - 全局

    @Published private(set) var toast: String?

    // MARK: - 调试开关（仅 DEBUG 构建可见）

    @Published var forceFail = false
    @Published var forceTimeout = false
    @Published var showTopicCard = false

    // MARK: - 任务管理

    /// 一次只有一条消息在途，所以聊天用单个句柄 —— 「停止」直接取消它。
    var chatTask: Task<Void, Never>?
    var onboardingTask: Task<Void, Never>?
    private var toastTask: Task<Void, Never>?
    private var reactionTask: Task<Void, Never>?

    init() {
        worldTextures=WorldTextureCache(scene:world.scene, enabled: !world.uses3D)
        world.stateChanged = { [weak self] in self?.objectWillChange.send() }
        world.frameChanged = { [weak self] dt in self?.advanceCamera(dt) }
        world.yard3D?.onTap = { [weak self] target, point in
            guard let self, screen == .home, !mailboxOpen, !showsMe else { return }
            switch target {
            case "cat": poke()
            case "mailbox": openMailbox(anchor: point)
            case "bowl": fillBowl()
            default: break
            }
        }
        NotificationBridge.store = self
        loadPersisted()
        loadCreation()
        connectBackend()
        loadDiary()
    }

    private func run(_ body: @escaping () async throws -> Void) -> Task<Void, Never> {
        Task { @MainActor in
            do { try await body() } catch { /* 取消即结束 */ }
        }
    }

    func cancelEverything() {
        chatTask?.cancel()
        onboardingTask?.cancel()
        toastTask?.cancel()
        reactionTask?.cancel()
    }

    static func sleep(_ milliseconds: Int) async throws {
        try await Task.sleep(nanoseconds: UInt64(milliseconds) * 1_000_000)
    }

    // MARK: - 轻提示

    /// 同一时刻最多一条轻提示 —— 这是硬规则，新的顶掉旧的。
    func flash(_ text: String) {
        toastTask?.cancel()
        withAnimation(.easeOut(duration: Metrics.fadeFast)) { toast = text }
        toastTask = Task { @MainActor in
            try? await Self.sleep(1400)
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: Metrics.fadeFast)) { toast = nil }
        }
    }

    // MARK: - 世界

    func moveCat(to index: Int) { world.request(index) }
    func interact(with index: Int) {
        world.request(index)
        if let failure=world.simulation.failure {flash(failure)}
    }
    func look(at index: Int) {
        guard world.scene.destinations.indices.contains(index) else {return}
        reaction=nil;viewedIndex=index
        if world.uses3D { world.yard3D?.send(["type": "look", "place": YardIntent.places[index]]); return }
        camera.look(at:world.scene.destinations[index].cameraX,half:worldGeometry.halfScreen)
        prepareWorldTextures()
    }
    func findCat() { reaction=nil; if world.uses3D { world.yard3D?.send(["type": "findCat"]); return }; camera.find();prepareWorldTextures() }
    func dragCamera(translation: CGFloat) {
        camera.drag(translation,width:worldGeometry.bgSize.width,half:worldGeometry.halfScreen)
        prepareWorldTextures()
    }
    func endDrag(velocity: CGFloat) {
        camera.endDrag(velocity:velocity,width:worldGeometry.bgSize.width,half:worldGeometry.halfScreen)
        viewedIndex=world.scene.destinations.indices.min(by:{abs(world.scene.destinations[$0].cameraX-camera.target) < abs(world.scene.destinations[$1].cameraX-camera.target)}) ?? 0
    }
    private func tileNames(at x:Double, margin:Double = 0) -> Set<String> {
        Set(world.scene.tiles.filter {
            $0.rect.x+$0.rect.width >= x-worldGeometry.halfScreen-margin && $0.rect.x <= x+worldGeometry.halfScreen+margin
        }.map(\.image))
    }
    /// 常驻的贴图：所有独立物件、底板、毛毡收尾层、天上的东西（日月星雨云）。
    private var pinnedTextures: Set<String> {
        Set(world.scene.objects.map(\.image)).union(["world-v3-ground-preview","world-v5-felt-grain"]).union(WorldTextureCache.skyLimits.keys)
    }
    func prepareWorldTextures() {
        guard !world.uses3D else { return }
        let lookAhead=camera.x+camera.velocity*0.24
        let tiles=tileNames(at:camera.x,margin:0.14).union(tileNames(at:lookAhead,margin:0.08))
        worldTextures.update(tiles,pinned:pinnedTextures)
    }
    #if DEBUG
    private var cameraFrames=0
    private var maxCameraStep=0.0
    private var maxTextureBytes=0
    private var cameraMissingHDFrames=0
    private var lastCameraForMetrics:Double?
    func writeYardBusinessSnapshot(label: String) {
        guard world.uses3D, let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
        let values: [String: Any] = ["screen": screen == .home ? "home" : "chat", "hasMail": hasMail, "mailboxOpen": mailboxOpen, "mailboxAnchor": [mailboxAnchor.x, mailboxAnchor.y], "bowlFilledToday": filledToday, "lastDrinkAt": lastDrinkAt.map { ISO8601DateFormatter().string(from: $0) } ?? "", "pouring": pouring, "legacyTextureCount": worldTextures.images.count, "showsMe": showsMe]
        if let json = try? JSONSerialization.data(withJSONObject: values, options: .prettyPrinted) {
            try? json.write(to: dir.appendingPathComponent("business-" + label + ".json"), options: .atomic)
        }
    }
    func writeCameraSnapshot(label:String) {
        let object:[String:Any] = ["frames":cameraFrames,"cameraX":camera.x,"cameraMode":String(describing:camera.mode),"maxStepNormalized":maxCameraStep,"maxTextureBytes":maxTextureBytes,"missingHDFrames":cameraMissingHDFrames,"textureCount":worldTextures.images.count]
        if let data=try? JSONSerialization.data(withJSONObject:object,options:.prettyPrinted),let dir=FileManager.default.urls(for:.documentDirectory,in:.userDomainMask).first {
            let safe=label.filter{$0.isLetter || $0.isNumber || $0 == "-"}
            try? data.write(to:dir.appendingPathComponent("camera-"+safe+".json"),options:.atomic)
        }
    }
    #endif
    private func advanceCamera(_ dt:Double) {
        advanceFlag(dt)
        advanceConditions(dt)
        if world.uses3D {
            // @Published 对相同值也发通知；跟随镜头不应每帧刷新整个原生界面。
            if world.intent3D.cameraMode == "following", viewedIndex != world.currentIndex {
                viewedIndex = world.currentIndex
            }
            return
        }
        #if DEBUG
        cameraFrames += 1
        if let previous=lastCameraForMetrics {maxCameraStep=max(maxCameraStep,abs(camera.x-previous))}
        lastCameraForMetrics=camera.x
        if !worldTextures.ready(tileNames(at:camera.x)) {cameraMissingHDFrames += 1}
        maxTextureBytes=max(maxTextureBytes,worldTextures.images.values.reduce(0){$0+($1.cgImage.map{$0.bytesPerRow*$0.height} ?? 0)})
        #endif
        var next=camera
        let sim=world.simulation
        let focus=sim.interaction.map { $0.isTree ? ($0.launch.x+$0.nest.x)/2:($0.ground.x+$0.rail.x)/2 } ?? sim.renderPoint.x
        next.tick(dt,cat:(sim.interaction?.isTree == true || sim.interaction?.isElevated == true) ? focus:sim.renderPoint.x,half:worldGeometry.halfScreen,reduceMotion:UIAccessibility.isReduceMotionEnabled)
        let needed=tileNames(at:next.x)
        prepareWorldTextures()
        if worldTextures.ready(needed) {
            camera=next
            if camera.mode == .following {viewedIndex=world.simulation.current}
        } else {
            worldTextures.update(tileNames(at:camera.x,margin:0.14).union(needed),pinned:pinnedTextures)
        }
    }
    func poke() {
        guard !isLost,!world.moving else {return}
        let now=Date()
        pokeTimes.append(now)
        pokeTimes.removeAll { now.timeIntervalSince($0) > MoodRules.pokeBurstWindow+MoodRules.pokeSulkSeconds }
        interactedThisSession=true
        world.poke()
        if world.uses3D { announce("团子耳朵动了一下"); return }
        let lines=world.simulation.current == 0 ? MoodCopy.reactions(mood.mood,temperament:temperament,familiar:familiar):catLocation.reactions
        announce(world.simulation.hiddenInGrass ? "草叶动了动，团子看着你":lines[pokeTimes.count % lines.count])
    }

    /// 状态条上说一句，2s 后回到常态句。同一时刻只有一句。
    func announce(_ text: String) {
        reactionTask?.cancel()
        reaction=text
        reactionTask=Task { @MainActor in
            try? await Self.sleep(2000)
            guard !Task.isCancelled else {return}
            reaction=nil
        }
    }

    // MARK: - 信箱

    /// 旗子 0.3s 转到位：立起 0°，放下 -90°（平放在箱顶）。
    private func advanceFlag(_ dt: Double) {
        let target: Double = hasMail ? 0 : -90
        guard flagAngle != target else {return}
        let step=90/0.3*dt
        flagAngle = abs(target-flagAngle) <= step ? target : flagAngle+(target>flagAngle ? step:-step)
    }

    /// 点信箱：纸从投信口抽出来。旗子放下。
    func openMailbox(anchor: CGPoint) {
        guard !mailboxOpen else {return}
        mailboxAnchor=anchor
        if let unread = entries.filter(\.hasUnreadCatDiary).max(by: { $0.dayKey < $1.dayKey }) { selectDiaryDay(unread.dayKey) }
        markCatDiariesRead(on: diaryDay)
        refreshInbox()
        mailboxOpen=true
    }

    func closeMailbox() { mailboxOpen=false }

    func openTopicCard() {
        chatSource = ChatSource(kicker: "接着昨天的", text: SeedData.topicText)
        showTopicCard = false
        screen = .chat
    }

    // MARK: - 聊天

    /// 发送：520ms 落地 → 等待 900ms → 流式每字 58ms。
    /// 接了后端时走 `remoteSend`，状态对应见 AppStore+Remote.swift。
    func send() {
        let text = draft.trimmed
        guard !text.isEmpty, !isStreaming else { return }
        interactedThisSession = true

        let id = "u" + UUID().uuidString
        let willFail = forceFail
        var outgoing = ChatMessage(id: id, role: .user, text: text, state: .sending)
        outgoing.diaryEntryID = chatSource?.diaryEntryID
        messages.append(outgoing)
        chatSource = nil
        draft = ""
        forceFail = false

        if backend.isRemote {
            remoteSend(localID: id, text: text)
            return
        }

        chatTask?.cancel()
        chatTask = run { [weak self] in
            try await Self.sleep(520)
            guard let self else { return }
            if willFail {
                self.setState(.failed, for: id)
                return
            }
            self.setState(.sent, for: id)
            self.isWaiting = true
            try await self.catReply(to: text)
        }
    }

    /// 发送失败后点注文重试。
    func retry(messageID: String) {
        guard let text = messages.first(where: { $0.id == messageID })?.text else { return }
        setState(.sending, for: messageID)
        if backend.isRemote {
            remoteSend(localID: messageID, text: text)
            return
        }
        chatTask?.cancel()
        chatTask = run { [weak self] in
            try await Self.sleep(600)
            guard let self else { return }
            self.setState(.sent, for: messageID)
            self.isWaiting = true
            try await self.catReply(to: text)
        }
    }

    /// 回复超时后点「再试一次」：撤掉那条「……」，重发它前面那句。
    ///
    /// 原型把超时气泡留在原地又追加一条新回复，看起来像猫说了两次。这里改成先撤再重试。
    func retryAfterTimeout(messageID: String) {
        guard let index = messages.firstIndex(where: { $0.id == messageID }) else { return }
        let previousUserMessage = messages[..<index].last { $0.role == .user }
        withAnimation(.easeOut(duration: Metrics.fadeFast)) {
            messages.remove(at: index)
        }
        guard let previousUserMessage else { return }
        if backend.isRemote, let serverID = previousUserMessage.serverID {
            // 用户那句服务端已经收了，只让猫重新回，不再发一遍
            remoteReply(to: serverID)
            return
        }
        retry(messageID: previousUserMessage.id)
    }

    private func catReply(to userText: String) async throws {
        let willTimeout = forceTimeout
        try await Self.sleep(900)

        if willTimeout {
            forceTimeout = false
            isWaiting = false
            messages.append(ChatMessage(
                id: "c" + UUID().uuidString, role: .cat, text: "", state: .timeout
            ))
            return
        }

        // 用户消息里出现「记住」「别忘」时计入长期记忆。
        // TODO: 后端 —— 记忆抽取在服务端做，前端只消费「这条被记住了」的结果。
        let remembered = userText.contains("记住") || userText.contains("别忘")
        let demoInvitation = userText.trimmingCharacters(in: .punctuationCharacters)
        let full: String
        if ["陪我坐一会儿", "今天有点累，陪我坐一会儿"].contains(demoInvitation) {
            world.sitTogetherInDemo()
            full = "嗯，我陪你。"
        } else {
            full = remembered ? "好，我记下了。" : (temperament.replies.randomElement() ?? "嗯。")
        }

        let id = "c" + UUID().uuidString
        isWaiting = false
        isStreaming = true
        messages.append(ChatMessage(
            id: id, role: .cat, text: "", state: .streaming, remembered: remembered
        ))

        let characters = Array(full)
        for index in characters.indices {
            try await Self.sleep(58)
            guard !Task.isCancelled else { return }
            updateText(String(characters[0...index]), for: id)
        }

        isStreaming = false
        setState(.done, for: id)
        if remembered {
            memoryCount += 1
            flash("记下了")
        }
    }

    /// 流式中按停止：保留已生成文字。
    func stopStreaming() {
        if backend.isRemote {
            remoteStop()
            return
        }
        chatTask?.cancel()
        isStreaming = false
        isWaiting = false
        if let index = messages.firstIndex(where: { $0.state == .streaming }) {
            messages[index].state = .stopped
        }
    }

    func sendOrStop() {
        if isStreaming { stopStreaming() } else { send() }
    }

    /// 长按菜单里的「不要再提」：该气泡标记边界，「我的」页边界计数 +1。
    /// 接了后端时写进服务端的边界列表，之后模型不再主动提。
    func markBoundary() {
        guard let panel = messagePanel else { return }
        if let index = messages.firstIndex(where: { $0.id == panel.id }) {
            if backend.isRemote, let serverID = messages[index].serverID {
                remoteMarkBoundary(messageID: serverID)
            } else {
                messages[index].boundary = true
                boundaryCount += 1
            }
        }
        messagePanel = nil
    }

    func setState(_ state: ChatMessage.State, for id: String) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
        messages[index].state = state
    }

    func updateText(_ text: String, for id: String) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
        messages[index].text = text
    }

    // MARK: - 日记

    /// 留言纸上的「聊聊」：跳聊天并带来源卡。
    func openChat(from entry: DiaryEntry) {
        guard backend.isRemote, let cloudID = entry.cloudID, !entry.needsSync,
              entry.kind == .cat || !entry.isPrivate else { flash("请先同步并开放这条日记"); return }
        chatSource = ChatSource(kicker: "从这条日记继续", text: entry.text, diaryEntryID: cloudID)
        hasMail = false
        mailboxOpen = false
        screen = .chat
    }

    /// 「记一下」抽屉保存：按当前时间插入新碎片。
    func saveCapture() {
        let text = captureText.trimmed
        guard !text.isEmpty else {
            isCapturing = false
            return
        }
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        let now = currentDate()
        var archive = diaryArchive
        archive.entries.append(DiaryEntry(
                id: "n" + UUID().uuidString,
                time: formatter.string(from: now),
                kind: .text,
                visit: .unread,
                text: text,
                isPrivate: !backend.isRemote || !captureForCat,
                createdAt: now
            ))
        guard persistDiary(archive) else { captureSaveFailed = true; return }
        captureSaveFailed = false
        selectDiaryDay(nil)
        isCapturing = false
        captureText = ""
        flash("记下了")
        syncDiary()
    }

    /// 调试：把第一条够不上目标状态的非私密碎片推到该状态。
    func advanceVisit(to target: DiaryEntry.Visit) {
        guard let index = entries.firstIndex(where: { $0.visit < target && !$0.isPrivate }) else {
            flash("没有可以推进的碎片了")
            return
        }
        var archive = diaryArchive
        archive.entries[index].visit = target
        guard persistDiary(archive) else { return }
        hasMail = true
        announce(target == .commented ? "团子在你的日记上留了一句" : "团子去信箱看过你的日记了")
    }

    // MARK: - 重置

    /// 调试：回到种子数据。
    func reseed() {
        cancelEverything()
        onboarding = nil
        screen = .home
        viewedIndex = 0
        reaction = nil
        world.reset()
        camera = WorldCamera()
        messages = SeedData.messages
        chatSource = nil
        messagePanel = nil
        isStreaming = false
        isWaiting = false
        draft = ""
        showTopicCard = false
        hasMail = false
        mailboxOpen = false
        showsMe = false
        memoryCount = 37
        boundaryCount = 2
        toast = nil
        forceFail = false
        forceTimeout = false
        bowlFilledAt = nil
        lastDrinkAt = nil
        pokeTimes = []
        catDiaryDate = nil
        visitedPlacesToday = []
        greetedThisSession = false
        savePersisted()
        conditionsClock = 1
        connectBackend()
        loadDiary()
    }
}

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
