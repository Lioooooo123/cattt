import Foundation

/// 3D 的行为规则：只选意图，不积分位置，也不依赖逐帧动作时长。
struct YardIntent {
    static let places = ["house", "tree", "bed", "grass", "pond", "fence"]
    static let destinationIDs = ["house", "tree", "bed", "grass", "pond", "fence"]
    struct Request: Equatable {
        let id: String
        let place: String
        let activity: String
        var json: [String: Any] { ["type": "intent", "id": id, "place": place, "activity": activity] }
    }
    private(set) var request = Request(id: "initial", place: "house", activity: "rest")
    private(set) var current = 0
    private(set) var moving = false
    private(set) var action = "idle"
    private(set) var drinkCount = 0
    private(set) var activityFallback = true
    private var completedDrinkID: String?
    private(set) var offscreen = false
    private(set) var cameraMode = "following"
    private(set) var ready = false
    private(set) var failure: String?
    private(set) var behavior = BehaviorParams.default
    private(set) var mood = Mood.calm
    private(set) var night = false
    private(set) var allowed: Set<Int> = Set(0..<6)
    private var remaining = 150.0
    private var activityRemaining = 12.0
    private var drinkWait = Double.infinity
    private var bowlFull = false
    private var rng = WorldRandom(state: 71)
    var autonomous = true
    var target: Int { Self.places.firstIndex(of: request.place) ?? 0 }
    var phase: String { moving ? "moving" : "idle" }

    mutating func conditions(mood: Mood, night: Bool, allowed: Set<Int>, bowlFull: Bool, behavior: BehaviorParams) {
        remaining *= behavior.idleScale / self.behavior.idleScale
        if mood != self.mood || night != self.night { activityRemaining = 0 }
        self.behavior = behavior; self.mood = mood; self.night = night; self.allowed = allowed
        if bowlFull && !self.bowlFull { drinkWait = rng.seconds(behavior.drinkDelay.lowerBound, behavior.drinkDelay.upperBound) }
        if !bowlFull { drinkWait = .infinity }
        self.bowlFull = bowlFull
        if !allowed.contains(target) { remaining = min(remaining, 4) }
    }
    mutating func choose(_ index: Int, activity: String? = nil) {
        guard Self.places.indices.contains(index) else { return }
        let desire = activity ?? (index == 2 || night ? "rest" : idleActivity(index))
        request = Request(id: UUID().uuidString, place: Self.places[index], activity: desire)
        moving = index != current; failure = nil; activityFallback = true
        activityRemaining = desire == "rest" ? rng.seconds(35, 65) : rng.seconds(12, 25)
        remaining = dwell(index)
        if desire == "sit" { remaining = rng.seconds(35, 55) * behavior.idleScale }
    }
    private mutating func idleActivity(_ index: Int) -> String {
        if index == 3 { let pick = rng.unit(); return pick < 0.3 ? "chase" : pick < 0.55 ? "stretch" : pick < 0.7 ? "run" : "watch" }
        if index == 1 { return rng.unit() < 0.4 ? "scratch" : "watch" }
        if index == 5 { return rng.unit() < 0.45 ? "flower" : "watch" }
        guard index == 0 else { return "watch" }
        let pool = MoodRules.housePool(mood: mood, night: night, behavior: behavior)
        var pick = rng.unit()
        let names = ["sleepyNod": "rest", "sitLook": "watch", "headTilt": "tilt", "groom": "groom",
                     "moodHappy": "happy", "moodSulk": "sulk", "moodSad": "sad"]
        for item in pool {
            pick -= item.weight
            if pick <= 0 { return names[item.action] ?? "watch" }
        }
        return "watch"
    }
    private mutating func dwell(_ index: Int) -> Double {
        ((index == 0 || index == 2) ? rng.seconds(120, 180) : rng.seconds(45, 90)) * behavior.idleScale * (index == 0 ? behavior.homeIdleScale : 1)
    }
    /// 作伴时用已有的迎门倾向。夜里、情绪低落或想安静时优先留在当前地点。
    func companionSeat(quiet: Bool) -> String? {
        guard ready, !(request.activity == "drink" && completedDrinkID != request.id) else { return nil }
        let approaches = behavior.comesToDoor && !quiet && !night && mood != .sad && mood != .sulk
        if approaches && allowed.contains(0) { return Self.places[0] }
        if allowed.contains(current) { return Self.places[current] }
        return Self.places.indices.first(where: allowed.contains).map { Self.places[$0] }
    }

    mutating func greet() {
        guard autonomous, behavior.comesToDoor, allowed.contains(0) else { return }
        choose(0, activity: "watch")
    }
    @discardableResult mutating func drink() -> Bool {
        guard bowlFull, current == 0, !moving else { return false }
        choose(0, activity: "drink"); drinkWait = 3600
        return true
    }
    /// 只消耗前台世界时间；没收到网页事实或正在走时不抢下一项。
    mutating func tick(_ dt: Double) -> Bool {
        guard ready, autonomous, !moving else { return false }
        remaining -= dt; drinkWait -= dt; activityRemaining -= dt
        if request.activity == "sit", remaining > 0 { return false }
        if !night, current == 0, drinkWait <= 0, drink() { return true }
        if remaining > 0 {
            if current == 0, activityRemaining <= 0, request.activity != "drink" {
                let dwellRemaining = remaining
                choose(0); remaining = dwellRemaining
                return true
            }
            return false
        }
        let others = Self.places.indices.filter { $0 != current && allowed.contains($0) }
        guard let fallback = others.last else { remaining = 60; return false }
        var pick = rng.unit() * others.reduce(0) { $0 + behavior.weight(forPlace: $1) }
        var index = fallback
        for candidate in others { pick -= behavior.weight(forPlace: candidate); if pick <= 0 { index = candidate; break } }
        choose(index); return true
    }
    /// 网页事实才算到达。旧请求与旧页面的消息均不能结束当前请求。
    @discardableResult mutating func observe(id: String, nearest: String, moving: Bool, action: String, offscreen: Bool, cameraMode: String, fallback: Bool = true, drinkDone: Bool = false) -> Bool {
        guard id == request.id, let index = Self.places.firstIndex(of: nearest) else { return false }
        if !moving { current = index }; self.moving = moving; self.action = action; self.offscreen = offscreen; self.cameraMode = cameraMode
        activityFallback = fallback
        if drinkDone, request.activity == "drink", !fallback, action == "idle", !moving, index == 0, completedDrinkID != id {
            completedDrinkID = id; drinkCount += 1
        }
        ready = true; failure = nil
        return true
    }
    mutating func projectShared(at place: String, activity: String) {
        guard let index = Self.places.firstIndex(of: place) else { return }
        self = YardIntent()
        current = index
        autonomous = false
        choose(index, activity: activity)
    }

    mutating func unavailable(_ reason: String) { ready = false; failure = reason }
    mutating func seed(_ value: UInt64) { rng = WorldRandom(state: value) }
}
