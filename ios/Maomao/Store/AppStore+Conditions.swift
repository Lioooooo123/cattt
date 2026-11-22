import SwiftUI

/// 时段、天气、情绪、水碗、团子的日记：每秒重算一次，喂给世界层。
/// 规则在 Model/WorldMood.swift、Model/Atmosphere.swift、Model/CatDiary.swift；这里只做时钟、持久化和拼装。
extension AppStore {
    static let rainSoundKey = "maomao.rainSound"
    static let weatherModeKey = "maomao.weatherMode"
    private enum Keys {
        static let bowl = "maomao.bowlFilledAt", drink = "maomao.lastDrinkAt", visit = "maomao.lastVisitAt", created = "maomao.createdAt"
        static let temperament = "maomao.temperament", traits = "maomao.traits"
    }

    // MARK: - 持久化

    func loadPersisted() {
        let ud = UserDefaults.standard
        if let d = ud.object(forKey: Keys.created) as? Date { createdAt = d }
        previousVisitAt = ud.object(forKey: Keys.visit) as? Date
        ud.set(sessionStartedAt, forKey: Keys.visit)
        bowlFilledAt = ud.object(forKey: Keys.bowl) as? Date
        lastDrinkAt = ud.object(forKey: Keys.drink) as? Date
        if ud.object(forKey: Self.rainSoundKey) != nil { rainSoundEnabled = ud.bool(forKey: Self.rainSoundKey) }
        if let raw = ud.string(forKey: Self.weatherModeKey), let m = WeatherMode(rawValue: raw) { weatherMode = m }
        // 性格：创建流程选完就存着，下次打开院子里还是同一只猫。
        if let raw = ud.string(forKey: Keys.temperament), let t = Temperament(rawValue: raw) { temperament = t }
        if let saved = ud.dictionary(forKey: Keys.traits) as? [String: Int] {
            traitLevels = Trait.allCases.reduce(into: [:]) { $0[$1] = saved[$1.rawValue] ?? 1 }
        }
        compileBehavior()
    }

    func savePersisted() {
        let ud = UserDefaults.standard
        ud.set(bowlFilledAt, forKey: Keys.bowl)
        ud.set(lastDrinkAt, forKey: Keys.drink)
    }

    func savePersonality() {
        let ud = UserDefaults.standard
        ud.set(temperament.rawValue, forKey: Keys.temperament)
        ud.set(Dictionary(uniqueKeysWithValues: traitLevels.map { ($0.key.rawValue, $0.value) }), forKey: Keys.traits)
    }

    // MARK: - 性格

    /// 气质、特征、领养天数任何一样变了就重编译一份行为参数（Model/Personality.swift）。
    func compileBehavior() {
        let next = BehaviorParams.compile(temperament: temperament, traits: traitLevels, daysSinceAdoption: adoptionDays)
        if next != behavior { behavior = next }
    }

    /// 打开 App（回到前台）：黏人、好奇的猫来门口坐下看你，安静的不来。一次打开只来一次。
    func greetOnOpen() {
        guard onboarding == nil, !greetedThisSession else { return }
        greetedThisSession = true
        compileBehavior()
        world.greet()
    }

    // MARK: - 时钟

    /// 现在几点。调试可以把钟拨到某个小时（`-script "…:time:19.6"`）。
    func currentDate() -> Date {
        #if DEBUG
        if let h = debugHour {
            let minute = Int((h - Double(Int(h))) * 60)
            return Calendar.current.date(bySettingHour: Int(h) % 24, minute: minute, second: 0, of: Date()) ?? Date()
        }
        #endif
        return Date()
    }

    var filledToday: Bool { bowlFilledAt.map { Calendar.current.isDate($0, inSameDayAs: currentDate()) } ?? false }
    var bowlFull: Bool { filledToday }

    /// 碗在屏幕上的位置（水壶按钮和倒水动画用）。
    var bowlScreenPoint: CGPoint? {
        world.scene.bowlHit.map { worldGeometry.screenPoint($0.center.cgPoint, cameraX: cameraX) }
    }

    /// 每帧调用；真正的重算每秒一次。
    func advanceConditions(_ dt: Double) {
        if v2World != nil {
            conditionsClock += dt
            if conditionsClock >= 1 {
                conditionsClock = 0
                syncHomeFacts()
            }
            return
        }
        if pouring > 0 { pouring = max(0, pouring - dt / 1.4) }
        // 雨慢慢下起来、慢慢停：天气自己变是一分钟，用户手动切是三秒。逐帧推，三秒也不跳格。
        let targetRain = weather == .rain ? 1.0 : 0.0
        if rainAmount != targetRain {
            let step = dt / (rainQuick ? 3 : 60)
            rainAmount += max(-step, min(step, targetRain - rainAmount))
            if rainAmount == targetRain { rainQuick = false }
            let params = AtmosphereParams.at(hour: DayPhase.hour(of: currentDate()), weather: .rain, rainAmount: rainAmount)
            if params != atmosphere { atmosphere = params }
        }
        conditionsClock += dt
        guard conditionsClock >= 1 else { return }
        conditionsClock = 0
        syncHomeFacts()
        let now = currentDate(), real = Date()
        if weatherMode == .real, onboarding == nil { realWeather.refreshIfNeeded() }
        var w = weatherMode.resolve(real: realWeather.latest)
        let note: String? = weatherMode == .real && realWeather.locationDenied
            ? (realWeather.latest == nil ? "没有位置，院子先按晴天" : "没有位置，院子用上次的天气") : nil
        if note != weatherNote { weatherNote = note }
        #if DEBUG
        if let dw = debugWeather { w = dw }
        #endif
        if w != weather { weather = w }
        let hour = DayPhase.hour(of: now)
        let phase = DayPhase.at(hour: hour)
        if phase != dayPhase { dayPhase = phase }
        let params = AtmosphereParams.at(hour: hour, weather: .rain, rainAmount: rainAmount)
        if params != atmosphere { atmosphere = params }
        // 情绪：时间都换算到"现在"这把钟上，调试拨钟时也成立。
        let shift = now.timeIntervalSince(real)
        let input = MoodInput(now: now, createdAt: createdAt, sessionStartedAt: sessionStartedAt.addingTimeInterval(shift),
                              previousVisitAt: previousVisitAt, bowlFilledAt: bowlFilledAt, lastDrinkAt: lastDrinkAt,
                              pokeTimes: pokeTimes.map { $0.addingTimeInterval(shift) }, weather: w, interactedThisSession: interactedThisSession,
                              moodScale: behavior.moodScale)
        var evaluation = MoodRules.evaluate(input)
        #if DEBUG
        if let dm = debugMood { evaluation = MoodEvaluation(mood: dm, reason: MoodRules.debugReason(dm)) }
        #endif
        if evaluation != mood { mood = evaluation }
        compileBehavior()
        world.yard3D?.atmosphere(hour: hour, weather: w.rawValue)
        world.setConditions(mood: mood.mood, night: phase.isNight, allowed: MoodRules.allowedDestinations(phase: phase, weather: w),
                            bowlFull: bowlFull, behavior: behavior)
        // 喝过水
        if world.drinkCount != lastDrinkCount {
            lastDrinkCount = world.drinkCount
            lastDrinkAt = now; savePersisted()
        }
        // 今天去过哪（团子的日记用）
        if (!world.uses3D || world.intent3D.ready), !world.moving, world.currentIndex != lastPlaceIndex {
            lastPlaceIndex = world.currentIndex
            visitedPlacesToday.append(world.scene.destinations[world.currentIndex].name)
            if visitedPlacesToday.count > 40 { visitedPlacesToday.removeFirst() }
        }
        // 院子里的事实送进聊天（只读，不写记忆、不改 Soul）。
        world.setYardFacts(WorldYardFacts(mood: mood.mood.rawValue, moodReason: yardMoodReason,
                                          dayPhase: phase.rawValue, weather: w.rawValue,
                                          bowlFilledToday: bowlFull,
                                          lastDrinkAt: lastDrinkAt.map { ISO8601DateFormatter().string(from: $0) },
                                          placesToday: visitedPlacesToday))
        // 雨声：只在院子里、下雨时响
        rainSound.set(on: w == .rain && rainSoundEnabled && !yardProbeVisible && screen == .home && !mailboxOpen && !showsMe)
        // 团子的日记：夜晚开始时写，一天一条
        let diaryDayKey = DiaryDay.key(for: now)
        let hasTodayDiary = entries.contains { $0.kind == .cat && $0.dayKey == diaryDayKey }
        if !backend.isRemote, !diaryLoadFailed, now >= diaryRetryAfter, hour >= CatDiary.writeHour, !hasTodayDiary {
            writeCatDiary(now: now)
        }
    }

    // MARK: - 倒水

    /// 状态变化立即同步；每秒再核对跨日与恢复，不随渲染帧重复计算日期和去重键。
    func syncHomeFacts() {
        world.yard3D?.facts(full: bowlFull, mail: v2Work?.hasUnreadMail ?? hasMail)
    }

    /// 点碗（或碗旁的水壶）：一天倒一次就满，再点只是水面晃一下。
    func fillBowl() {
        if let v2World {
            if v2World.canSubmit { _ = world.fillSharedBowl() }
            return
        }
        guard pouring == 0 else { return }
        interactedThisSession = true
        if filledToday {
            pouring = 0.5
            announce("碗是满的，水晃了晃")
            return
        }
        bowlFilledAt = currentDate(); savePersisted()
        pouring = 1
        announce("你给团子倒了水")
        conditionsClock = 1
    }

    #if DEBUG
    func emptyBowl() { bowlFilledAt = nil; savePersisted(); conditionsClock = 1 }
    #endif

    // MARK: - 团子的日记

    func writeCatDiary(now: Date) {
        guard !backend.isRemote else { syncDiary(); return }
        let cal = Calendar.current
        var facts = CatDiary.Facts(day: now)
        facts.isFirstDay = MoodRules.daysBetween(createdAt, now, calendar: cal) == 0
        facts.mood = mood.mood
        facts.weather = weather
        facts.filledToday = filledToday
        facts.drankToday = lastDrinkAt.map { cal.isDate($0, inSameDayAs: now) } ?? false
        facts.visitedToday = cal.isDate(sessionStartedAt, inSameDayAs: now)
        facts.absenceDays = facts.visitedToday ? 0 : (previousVisitAt.map { MoodRules.daysBetween($0, now, calendar: cal) } ?? 0)
        facts.emptyDays = bowlFilledAt.map { MoodRules.daysBetween($0, now, calendar: cal) } ?? MoodRules.daysBetween(createdAt, now, calendar: cal)
        facts.chatSnippet = backend.isRemote ? nil : messages.last(where: { $0.role == .user }).flatMap { CatDiary.snippet($0.text) }
        facts.fragmentSnippet = backend.isRemote ? nil : entries.first(where: { !$0.isPrivate && $0.visit != .unread && $0.kind != .cat }).flatMap { CatDiary.snippet($0.text) }
        facts.places = visitedPlacesToday
        facts.sentences = behavior.diarySentences
        let text = CatDiary.compose(facts)
        let f = DateFormatter(); f.dateFormat = "HH:mm"
        let time = f.string(from: now)
        guard saveCatDiary(text: text, time: time, now: now) else { return }
    }

    @discardableResult
    private func saveCatDiary(text: String, time: String, now: Date, timeZone: TimeZone = .current, announces: Bool = true) -> Bool {
        var archive = diaryArchive
        archive.upsertCatDiary(text: text, time: time, now: now, timeZone: timeZone)
        guard persistDiary(archive) else { diaryRetryAfter = now.addingTimeInterval(60); return false }
        diaryRetryAfter = .distantPast
        catDiaryDate = now
        hasMail = true
        if announces { announce("团子把今天记下来了") }
        syncDiary()
        return true
    }

}
