import Foundation

/// 性格：气质、四条特征，和它们编译出来的一份行为参数表。
/// 纯 Foundation，没有 SwiftUI —— 世界层测试直接编译它。
/// 依据 docs/方案/性格系统优化-方案-2026-09-12.md 第 2.1 节。院子和聊天都从这张表取值，不互相传参数。

/// 猫的气质预设。决定它主不主动、话多不多、多久才跟你熟。
enum Temperament: String, Codable, CaseIterable, Identifiable {
    case slow, close, quiet, curious

    var id: String { rawValue }

    var name: String {
        switch self {
        case .slow: return "慢热"
        case .close: return "黏人"
        case .quiet: return "安静"
        case .curious: return "好奇"
        }
    }

    /// 写的是可观察行为，不是形容词堆砌 —— 用户要能预判猫会怎么表现。
    var behavior: String {
        switch self {
        case .slow: return "头几天话很少，也不怎么问你。熟了之后会主动提起你说过的事。"
        case .close: return "每天会来找你一两次。你不回也不会追问，第二天照常来。"
        case .quiet: return "几乎不主动。你说话它就在，你不说它也不打扰。"
        case .curious: return "爱追问细节。你提一句，它可能隔天还会想起来接着问。"
        }
    }

    /// 回复语料池
    var replies: [String] {
        switch self {
        case .slow: return ["嗯，我在。", "你说过这个的，我记着。", "慢慢说，不着急。"]
        case .close: return ["我一直在等你说话。", "这个我想问细一点。", "那你现在还好吗？"]
        case .quiet: return ["嗯。", "我听着。", "好。"]
        case .curious: return ["然后呢？", "这个我昨天还在想。", "你为什么会这么觉得？"]
        }
    }
}

/// 四条三档细调特征。默认全中档。
enum Trait: String, CaseIterable, Identifiable {
    case energy, initiative, directness, closeness

    var id: String { rawValue }

    var name: String {
        switch self {
        case .energy: return "活力节奏"
        case .initiative: return "主动性"
        case .directness: return "表达直接度"
        case .closeness: return "亲近表达"
        }
    }

    /// 每档配一句行为解释，档位随选变化。
    var explanations: [String] {
        switch self {
        case .energy:
            return ["多半在睡，偶尔醒着说两句", "白天活动，晚上安静下来", "一天里随时都可能来找你"]
        case .initiative:
            return ["你不说它就不开口", "每天会来一次", "会主动接着昨天的话题"]
        case .directness:
            return ["话说一半，留给你猜", "想说什么就说什么", "有话直说，不绕"]
        case .closeness:
            return ["不太表现出在意", "偶尔会说想你", "会直接说喜欢你"]
        }
    }

    static let levelNames = ["低", "中", "高"]
    static let defaults: [Trait: Int] = [.energy: 1, .initiative: 1, .directness: 1, .closeness: 1]
}

/// 院子和聊天共用的行为参数。气质给默认值，四条特征在默认值上各挪一档。
struct BehaviorParams: Equatable {
    /// 每个地点停留时长的倍数。
    var idleScale = 1.0
    /// 蘑菇屋门口再多留一会儿的倍数：黏人的猫离你近，赖着不走。
    var homeIdleScale = 1.0
    /// 蘑菇屋门口待机池里「打盹」的权重。
    var sleepWeight = 0.45
    /// 待机池里「坐着看你 + 歪头」的权重合计。
    var lookWeight = 0.30
    /// 看你里歪头占的比例（好奇的猫歪头多）。
    var tiltShare = 0.35
    /// 待机池里「舔毛」的权重。
    var groomWeight = 0.25
    /// 六个地点被自发选中的权重，序号同 Location.all：0 蘑菇屋、1 树屋、2 猫窝、3 草丛、4 池塘、5 栅栏边。
    var placeWeights: [Double] = [1, 1, 1, 1, 1, 1]
    /// 打开 App 时来门口坐下看你。
    var comesToDoor = false
    /// 情绪时长倍数（委屈、开心）。
    var moodScale = 1.0
    /// 倒水之后过多久去喝（秒）。
    var drinkDelay: ClosedRange<Double> = 10...40
    /// 团子日记写几句。
    var diarySentences = 2

    static let `default` = BehaviorParams()

    func weight(forPlace index: Int) -> Double {
        placeWeights.indices.contains(index) ? placeWeights[index] : 1
    }

    /// 慢热的「头几天」：按领养日算，前三天像安静的猫。
    static let slowWarmupDays = 3

    /// 气质 + 特征 + 领养了几天 → 一份参数。App 和后端各自从这张表算，算出来必须一样。
    static func compile(temperament: Temperament, traits: [Trait: Int] = Trait.defaults, daysSinceAdoption: Int = 0) -> BehaviorParams {
        let warm = temperament != .slow || daysSinceAdoption >= slowWarmupDays
        var p = BehaviorParams()
        switch temperament {
        case .quiet:
            p.idleScale = 1.5; p.sleepWeight = 0.85; p.lookWeight = 0.10; p.tiltShare = 0.35; p.groomWeight = 0.15
            p.placeWeights = [4.0, 0.3, 3.0, 0.15, 0.1, 0.1]
            p.comesToDoor = false; p.moodScale = 0.6; p.drinkDelay = 20...60; p.diarySentences = 2
        case .slow:
            p.idleScale = 1.2; p.sleepWeight = 0.50; p.lookWeight = warm ? 0.25 : 0.10; p.tiltShare = 0.35
            p.placeWeights = [2.5, 1.5, 1.0, 0.6, 0.5, 0.5]
            p.comesToDoor = warm; p.moodScale = 0.8; p.drinkDelay = 10...40; p.diarySentences = 2
        case .close:
            p.idleScale = 1.0; p.homeIdleScale = 1.8; p.sleepWeight = 0.30; p.lookWeight = 0.45; p.tiltShare = 0.30
            p.placeWeights = [10.0, 0.5, 0.8, 0.3, 0.2, 0.2]
            p.comesToDoor = true; p.moodScale = 1.5; p.drinkDelay = 3...15; p.diarySentences = 3
        case .curious:
            p.idleScale = 0.6; p.sleepWeight = 0.20; p.lookWeight = 0.30; p.tiltShare = 0.60
            p.placeWeights = [0.8, 1.2, 0.2, 2.0, 1.8, 1.8]
            p.comesToDoor = true; p.moodScale = 1.0; p.drinkDelay = 3...15; p.diarySentences = 3
        }
        let energy = level(traits, .energy), initiative = level(traits, .initiative)
        let directness = level(traits, .directness), closeness = level(traits, .closeness)

        // 活力节奏：调停留与睡眠。
        p.idleScale *= [1.35, 1.0, 0.75][energy]
        p.sleepWeight = clamp(p.sleepWeight + [0.15, 0, -0.15][energy], 0.05, 0.85)

        // 主动性：调去处与来门口。低档更愿意待在家和窝里，高档更愿意往外走。
        let indoor = [1.3, 1.0, 0.8][initiative], outdoor = [0.7, 1.0, 1.3][initiative]
        p.placeWeights = p.placeWeights.enumerated().map { $0.offset == 0 || $0.offset == 2 ? $0.element * indoor : $0.element * outdoor }
        if initiative == 0 { p.comesToDoor = false }
        if initiative == 2, warm { p.comesToDoor = true }

        // 亲近表达：调看你的频率与情绪时长。
        p.lookWeight = clamp(p.lookWeight * [0.5, 1.0, 1.6][closeness], 0.05, 0.8)
        p.moodScale = clamp(p.moodScale * [0.7, 1.0, 1.4][closeness], 0.4, 2.0)

        // 倒水后多久去喝：活力 + 主动性一起决定快慢。
        let quickness = Double(energy + initiative) / 4
        let factor = 1.4 - 0.8 * quickness
        p.drinkDelay = max(2, p.drinkDelay.lowerBound * factor)...max(3, p.drinkDelay.upperBound * factor)

        // 表达直接度：调日记的句数（说得越直接写得越少绕）。
        p.diarySentences = min(3, max(2, p.diarySentences + [-1, 0, 1][directness]))
        return p
    }

    private static func level(_ traits: [Trait: Int], _ trait: Trait) -> Int {
        min(2, max(0, traits[trait] ?? 1))
    }
    private static func clamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double { min(hi, max(lo, v)) }
}
