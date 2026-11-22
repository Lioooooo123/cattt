import SwiftUI

/// 陪伴主页。层次自下而上：世界（长图 + 猫层 + 信箱）→ 状态条 → 右上角头像钮 → 地点轨 → 话题卡 → 找团子 → 聊会儿。
/// 猫的点按热区在 `WorldView` 里跟着猫走；信箱也在那里命中。2026-09-10 起没有 Tab 栏，场景铺到屏幕最底。
struct CompanionHomeView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.screenInsets) private var insets

    /// 底部控件离屏幕底边的距离：安全区（平底机型算 16）再加 24。
    private var bottomClearance: CGFloat { max(insets.bottom, 16) + 24 }
    /// 状态条胶囊的顶：设计值 58，但不钻进状态栏。右上角头像钮跟它对中线。
    private var pillTop: CGFloat { max(58, insets.top + 5) }

    var body: some View {
        worldSurface
            .overlay(alignment: .top) { statusBar }
            .overlay(alignment: .topTrailing) { profileButton }
            .overlay(alignment: .topLeading) { LocationRail() }
            .overlay(alignment: .bottom) { topicCard }
            .overlay(alignment: .bottomLeading) { findCatLink }
            .overlay(alignment: .bottomTrailing) { chatButton }
            .coordinateSpace(name: "yard-home")
            .onPreferenceChange(YardControlFrames.self) { frames in
                let rects = frames.values.map { ["x": $0.minX, "y": $0.minY, "width": $0.width, "height": $0.height] }
                store.world.yard3D?.send(["type": "controls", "rects": rects])
            }
            .ignoresSafeArea()
    }

    @ViewBuilder private var worldSurface: some View {
        if store.world.uses3D { Color.clear }
        else { WorldView() }
    }

    // MARK: - 顶部状态条

    private var statusBar: some View {
        Group {
            if let bridge = store.v2World, bridge.needsRetry {
                Button("重新连接小院") { bridge.retry() }
                    .accessibilityHint(store.statusText)
            } else {
                Text(store.statusText)
            }
        }
            .font(Typo.sans(12.5))
            .tracking(track(0.06, 12.5))
            .foregroundStyle((store.v2World?.world?.snapshot?.value.dayPhase == "night" || (store.v2World == nil && store.dayPhase.isNight)) && store.world.uses3D ? Color.white.opacity(0.92) : Palette.ink2)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 14)
            .padding(.vertical, 6)
            // 和 Tab 栏同一层玻璃，只是收成一颗胶囊。
            .liquidGlass(in: Capsule(style: .continuous))
            .yardControl("status")
            // 右上角头像钮占掉 16 + 44，留 64 两边对称，最长那句也不碰它。
            .padding(.horizontal, 64)
            .padding(.top, pillTop)
            .animation(.easeOut(duration: Metrics.fadeFast), value: store.statusText)
    }

    // MARK: - 右上角：我的

    /// App Store 账户钮的位置和做法：右上角一颗头像，点开是 sheet。
    /// 和状态条胶囊中线对齐：胶囊顶 58、高约 28，钮 44 → 顶 50。
    private var profileButton: some View {
        Button {
            store.showsMe = true
        } label: {
            IconTile(size: Metrics.iconSlotLg, circular: true, glass: true) {
                AnimatedCatPortrait(animated: !store.showsMe && !store.mailboxOpen && store.onboarding == nil && store.screen == .home)
                    .padding(5)
            }
            .contentShape(Circle())
        }
        .buttonStyle(PressScaleStyle())
        .yardControl("profile")
        .padding(.trailing, 16)
        // 胶囊高约 28、钮 44：钮顶比胶囊顶高 8，中线齐。
        .padding(.top, pillTop - 8)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("我的")
        .accessibilityAddTraits(.isButton)
    }

    // MARK: - 话题卡

    @ViewBuilder
    private var topicCard: some View {
        // 同一时刻最多一条轻提示 —— 猫不在眼前时不弹。
        if store.showTopicCard && !store.isLost {
            HStack(spacing: 11) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("昨天没说完的")
                        .font(Typo.sans(10.5))
                        .tracking(track(0.06, 10.5))
                        .foregroundStyle(Palette.paperInk)
                    Text(SeedData.topicText)
                        .font(Typo.sans(13.5))
                        .foregroundStyle(Palette.ink)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                TextLink(text: "接着聊") { store.openTopicCard() }

                Button {
                    withAnimation(.easeOut(duration: Metrics.fadeFast)) {
                        store.showTopicCard = false
                    }
                } label: {
                    Icons.close(color: Palette.paperInk)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("关闭话题卡")
            }
            .padding(.horizontal, 13)
            .padding(.vertical, 12)
            .background(Palette.onSceneTopic, in: RoundedRectangle(cornerRadius: Metrics.radiusCard))
            .overlay(
                RoundedRectangle(cornerRadius: Metrics.radiusCard)
                    .stroke(Palette.onSceneTopicRule, lineWidth: 1)
            )
            .yardControl("topic")
            .padding(.horizontal, 16)
            // 压在「聊会儿」上方：底边距 + 胶囊热区 46 + 16。
            .padding(.bottom, bottomClearance + Metrics.minTap + 16)
            .transition(.opacity)
        }
    }

    // MARK: - 找团子

    /// 猫不在这屏时才出现。原来是一行 12px 文字链，压在插画的碎绿上基本看不见 ——
    /// 换成一枚纸底圆钮，和右边的「聊会儿」同一条水平线。
    @ViewBuilder
    private var findCatLink: some View {
        if store.isLost {
            Button {
                store.findCat()
            } label: {
                Icons.findCat(color: Palette.accent)
                    .frame(width: 42, height: 42)
                    .liquidGlass(in: Circle(), interactive: true, fallback: Palette.onSceneRailOn)
                    .contentShape(Circle())
            }
            .buttonStyle(PressScaleStyle())
            .yardControl("findCat")
            .padding(.leading, 18)
            // 和右边「聊会儿」同一条水平线：它 42 高，胶囊热区 46，差 2。
            .padding(.bottom, bottomClearance + 2)
            .transition(.opacity)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("找团子")
            .accessibilityAddTraits(.isButton)
        }
    }

    // MARK: - 聊会儿

    /// 场景上唯一的实心按钮：做成胶囊，只留字。
    /// 图标去掉了 —— 「聊会儿」三个字已经说清楚，气泡图标只是在重复一遍。
    /// 胶囊只有 38pt 高（比 minTap 矮），少压掉一条草地；热区靠 tapSlop 补到 46。
    private var chatButton: some View {
        PrimaryButton(
            height: Metrics.chatPill,
            horizontalPadding: 24,
            cornerRadius: Metrics.chatPill / 2,
            shadow: false,
            tapSlop: (Metrics.minTap - Metrics.chatPill) / 2,
            glass: true
        ) {
            store.screen = .chat
        } label: {
            Text("聊会儿")
                .font(Typo.sans(15))
                .tracking(track(0.08, 15))
        }
        .yardControl("chat")
        .padding(.trailing, 18)
        .padding(.bottom, bottomClearance)
    }
}
