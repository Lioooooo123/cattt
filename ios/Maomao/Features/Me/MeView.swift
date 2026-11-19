import SwiftUI
import AuthenticationServices

/// 我的。2026-09-10 起由院子右上角的头像钮打开，是一张系统 sheet（App Store 账户页那种做法），
/// 右上角一个「完成」，也能下拉关。
struct MeView: View {
    @EnvironmentObject private var store: AppStore

    @State private var showsAgreements = false

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                headerBlock

                VStack(alignment: .leading, spacing: 28) {
                    accountSection
                    howWeGetAlong
                    whatItRemembers
                    if store.backend.isRemote { agreements }
                    if store.backend.isRemote { proactiveSettings }
                    settings
                }
                .padding(.horizontal, 24)
                .padding(.top, 22)
                .padding(.bottom, 30)
            }
        }
        .background { PageBackground().ignoresSafeArea() }
        .overlay(alignment: .topTrailing) { doneButton }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .presentationBackground(Palette.bg)
        .preferredColorScheme(.light)
        .task { await store.refreshProactivePermission() }
        .sheet(isPresented: $showsAgreements) { AgreementsView().environmentObject(store) }
        .sheet(isPresented: $store.showsMemoryControls) {
            MemoryCenterView(startWithBoundaries: store.memoryShowsBoundaries)
        }
    }

    private var accountSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionTitle(text: "和团子的账号")
            if store.backend.mode == .paired {
                Text("已连接家里的电脑").font(Typo.sans(14)).foregroundStyle(Palette.ink2)
                if let status = store.backendStatus { Text(status).font(Typo.sans(13)).foregroundStyle(Palette.ink3) }
                TextLink(text: "解除配对", size: 13) { store.unpairHost() }
            } else if store.backend.mode == .service, !store.backend.token.isEmpty {
                Text("已登录").font(Typo.sans(14)).foregroundStyle(Palette.ink2)
                TextLink(text: "退出登录", size: 13) { store.signOut() }
            } else if store.appleLoginNonce != nil {
                SignInWithAppleButton(.continue) { request in
                    request.nonce = store.appleNonceDigest
                } onCompletion: { store.finishAppleLogin($0) }
                .signInWithAppleButtonStyle(.black)
                .frame(height: Metrics.minTap)
            } else {
                TextLink(text: store.identityBusy ? "正在连接…" : "用 Apple 登录", size: 14) { store.prepareAppleLogin() }
                    .disabled(store.identityBusy)
            }
            if store.backend.mode != .paired { TextLink(text: "连接家里的电脑", size: 14) { store.openPairing() } }
            if let error = store.identityError { Text(error).font(Typo.sans(13)).foregroundStyle(Palette.ink3) }
        }
    }

    private var doneButton: some View {
        Button {
            store.showsMe = false
        } label: {
            Text("完成")
                .font(Typo.sans(15, weight: .medium))
                .foregroundStyle(Palette.ink)
                .padding(.horizontal, 14)
                .frame(minHeight: Metrics.minTap)
                .background(Palette.card.opacity(0.86), in: Capsule())
                .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleStyle())
        .padding(.trailing, 20)
        .padding(.top, 10)
        .accessibilityLabel("完成")
    }

    // MARK: - 头区

    private var headerBlock: some View {
        HStack(spacing: 18) {
            // 耳朵探出小窗、爪子搭在窗沿，沿用正式团子的同一份3D肖像。
            ZStack {
                UnevenRoundedRectangle(
                    topLeadingRadius: 54, bottomLeadingRadius: Metrics.radiusLg,
                    bottomTrailingRadius: Metrics.radiusLg, topTrailingRadius: 54
                )
                .fill(Palette.inset)
                .frame(width: 108, height: 104)
                .overlay(alignment: .bottom) {
                    Capsule()
                        .fill(Palette.card)
                        .frame(width: 120, height: 14)
                        .shadow(color: Palette.shadow, radius: 6, y: 3)
                }
                .offset(y: 12)

                AnimatedCatPortrait()
                    .frame(width: 140, height: 140)
                    .frame(height: 122, alignment: .top)
                    .clipped()
                    .offset(y: -8)
            }
            .frame(width: 128, height: 128)
            .rotationEffect(.degrees(-4))
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 10) {
                Text(store.catName)
                    .font(Typo.serif(25, bold: true))
                    .tracking(track(0.06, 25))
                    .foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)

                Text(store.temperament.name)
                    .font(Typo.sans(12.5))
                    .foregroundStyle(Palette.ink3)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 24)
        .padding(.top, 64)
        .padding(.bottom, 12)
    }

    // MARK: - 我们怎么相处

    private var howWeGetAlong: some View {
        VStack(alignment: .leading, spacing: 11) {
            SectionTitle(text: "我们怎么相处")

            Text(store.temperament.behavior)
                .font(Typo.sans(13))
                .lineHeight(1.8, size: 13)
                .foregroundStyle(Palette.ink3)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 2)
        }
    }

    // MARK: - 它记得的事

    private var whatItRemembers: some View {
        VStack(alignment: .leading, spacing: 11) {
            SectionTitle(text: "它记得的事")

            ListContainer {
                Button {
                    store.memoryShowsBoundaries = false; store.showsMemoryControls = true
                } label: {
                    memoryRow(icon: { Icons.document(color: Palette.ink3) },
                              title: "长期记忆", count: store.backend.isRemote ? "\(store.memoryCount) 条 ›" : "演示模式 ›")
                }.buttonStyle(.plain)
            }
        }
    }

    private func memoryRow<Icon: View>(
        @ViewBuilder icon: @escaping () -> Icon,
        title: String,
        count: String
    ) -> some View {
        HStack(spacing: 12) {
            // 层级靠容器，不靠把图标画大 —— 36 是列表行那一档。
            IconTile(size: Metrics.iconSlotMd, fill: Palette.inset, circular: true) { icon() }

            Text(title)
                .font(Typo.sans(14.5))
                .foregroundStyle(Palette.ink)
                .frame(maxWidth: .infinity, alignment: .leading)

            Text(count)
                .font(Typo.sans(13))
                .tabularNumbers()
                .foregroundStyle(Palette.ink4)

        }
        .padding(.horizontal, 15)
        .padding(.vertical, 14)
        .frame(minHeight: Metrics.minTap)
        .contentShape(Rectangle())
    }

    private var agreements: some View {
        VStack(alignment: .leading, spacing: 11) {
            SectionTitle(text: "说好的")
            ListContainer {
                Button { showsAgreements = true } label: {
                    memoryRow(icon: { Icons.clock(color: Palette.ink3) }, title: "约定与托付", count: "查看 ›")
                }.buttonStyle(.plain)
            }
        }
    }

    private var proactiveSettings: some View {
        VStack(alignment: .leading, spacing: 11) {
            SectionTitle(text: "它来找你")
            ListContainer {
                Button { store.changeProactivePermission() } label: {
                    HStack(spacing: 12) {
                        Text("允许团子主动找我")
                            .font(Typo.sans(14.5))
                            .foregroundStyle(Palette.ink)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        ShareToggle(isOn: store.allowProactive)
                    }
                    .padding(.horizontal, 15)
                    .padding(.vertical, 14)
                    .frame(minHeight: Metrics.minTap)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(store.proactiveBusy || store.backend.token.isEmpty)
                .accessibilityValue(store.allowProactive ? "已允许" : "未允许")
            }
            Text(store.proactiveError ?? "关闭时，说好的约定、托付和团子的日记仍会保留。")
                .font(Typo.sans(12))
                .foregroundStyle(Palette.ink4)
        }
    }

    // MARK: - 设置

    private var settings: some View {
        VStack(alignment: .leading, spacing: 11) {
            SectionTitle(text: "设置")

            ListContainer {
                // 院子的天气：跟着真实天气，或者一直晴 / 一直下雨（docs/方案/院子天气-真实与手动切换-方案-2026-09-16.md）。
                Menu {
                    Picker("院子的天气", selection: $store.weatherMode) {
                        ForEach(WeatherMode.allCases, id: \.self) { Text($0.title).tag($0) }
                    }
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 12) {
                            Text("院子的天气")
                                .font(Typo.sans(14.5))
                                .foregroundStyle(Palette.ink)
                                .frame(maxWidth: .infinity, alignment: .leading)

                            Text(store.weatherMode.title)
                                .font(Typo.sans(12))
                                .foregroundStyle(Palette.ink4)

                            Icons.chevronRight(color: Palette.ink4)
                        }
                        if let note = store.weatherNote {
                            Text(note)
                                .font(Typo.sans(12))
                                .foregroundStyle(Palette.ink4)
                        }
                    }
                    .padding(.horizontal, 15)
                    .padding(.vertical, 14)
                    .frame(minHeight: Metrics.minTap)
                    .contentShape(Rectangle())
                }
                .accessibilityLabel("院子的天气，\(store.weatherMode.title)")

                ListDivider()
                HStack(spacing: 12) {
                    Text("下雨时有雨声")
                        .font(Typo.sans(14.5))
                        .foregroundStyle(Palette.ink)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    ShareToggle(isOn: store.rainSoundEnabled)
                }
                .padding(.horizontal, 15)
                .padding(.vertical, 14)
                .frame(minHeight: Metrics.minTap)
                .contentShape(Rectangle())
                .onTapGesture {
                    withAnimation(.easeOut(duration: 0.2)) { store.rainSoundEnabled.toggle() }
                }
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isButton)

                ListDivider()
                HStack(spacing: 12) {
                    Text("版本")
                        .font(Typo.sans(14.5))
                        .foregroundStyle(Palette.ink)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    Text("0.1")
                        .font(Typo.sans(12))
                        .foregroundStyle(Palette.ink4)
                }
                .padding(.horizontal, 15)
                .padding(.vertical, 14)
                .frame(minHeight: Metrics.minTap)
                .contentShape(Rectangle())
                .onLongPressGesture { store.startOnboarding() }
            }
        }
    }

    private func settingRow(_ title: String) -> some View {
        HStack(spacing: 12) {
            Text(title)
                .font(Typo.sans(14.5))
                .foregroundStyle(Palette.ink)
                .frame(maxWidth: .infinity, alignment: .leading)

            Icons.chevronRight(color: Palette.ink4)
        }
        .padding(.horizontal, 15)
        .padding(.vertical, 14)
        .frame(minHeight: Metrics.minTap)
    }
}

/// 44 × 26 轨道，20pt 旋钮。
struct ShareToggle: View {
    let isOn: Bool

    var body: some View {
        Capsule()
            .fill(isOn ? Palette.switchOn : Palette.rule)
            .frame(width: 44, height: 26)
            .overlay(alignment: isOn ? .trailing : .leading) {
                Circle()
                    .fill(Palette.card)
                    .frame(width: 20, height: 20)
                    .padding(.horizontal, 3)
            }
    }
}

/// 会换行的标签行。
struct WrappingChips: View {
    let items: [String]
    var spacing: CGFloat = 8
    var chipSize: CGFloat = 13
    var chipColor: Color = Palette.ink2
    var verticalPadding: CGFloat = 7
    var horizontalPadding: CGFloat = 13

    var body: some View {
        FlowLayout(spacing: spacing) {
            ForEach(items, id: \.self) { item in
                Chip(
                    text: item,
                    size: chipSize,
                    color: chipColor,
                    verticalPadding: verticalPadding,
                    horizontalPadding: horizontalPadding
                )
            }
        }
    }
}

/// 简单的流式布局：一行放不下就换行。
/// 量尺寸和摆位置走同一个分行函数，而且量出来的宽度就是给到的宽度 ——
/// 两边算出不同的行数时，第二行会压在下面的段落上。
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    private struct Row {
        var items: [(index: Int, size: CGSize)] = []
        var height: CGFloat = 0
    }

    private func rows(for width: CGFloat, subviews: Subviews) -> [Row] {
        var rows: [Row] = [Row()]
        var x: CGFloat = 0
        for (index, subview) in subviews.enumerated() {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0 && x + spacing + size.width > width {
                rows.append(Row())
                x = 0
            }
            rows[rows.count - 1].items.append((index, size))
            rows[rows.count - 1].height = max(rows[rows.count - 1].height, size.height)
            x += (x > 0 ? spacing : 0) + size.width
        }
        return rows
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        let rows = rows(for: width, subviews: subviews)
        let height = rows.reduce(0) { $0 + $1.height } + spacing * CGFloat(max(0, rows.count - 1))
        if width.isFinite { return CGSize(width: width, height: height) }
        let rowWidth = rows[0].items.reduce(0) { $0 + $1.size.width } + spacing * CGFloat(max(0, rows[0].items.count - 1))
        return CGSize(width: rowWidth, height: height)
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        var y = bounds.minY
        for row in rows(for: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for item in row.items {
                subviews[item.index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(item.size))
                x += item.size.width + spacing
            }
            y += row.height + spacing
        }
    }
}
