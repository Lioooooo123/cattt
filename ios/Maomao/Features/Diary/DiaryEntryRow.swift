import SwiftUI

/// 一条碎片 + 团子来过的痕迹。
///
/// 三态互斥：未读什么都不加，只留脚印画三枚爪印，有留言另起一行留言纸（**此时不画脚印**）。
struct DiaryEntryRow: View {
    @EnvironmentObject private var store: AppStore

    let entry: DiaryEntry

    private let timeColumn: CGFloat = 50
    private let columnGap: CGFloat = 10

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .top, spacing: columnGap) {
                TimeChip(time: entry.time)
                    .frame(width: timeColumn)
                    .padding(.top, 8)

                if entry.kind == .cat { catCard } else { card }
            }

            if entry.visit == .commented && !entry.isPrivate {
                noteRow
            }
        }
    }

    // MARK: - 团子的一天

    /// 团子自己写的那一条：暖纸色（"团子写的东西"的既定语义），左上一枚小爪印，可以"聊聊"。
    private var catCard: some View {
        CatDiaryPaperCard(title: "团子的一天", text: entry.text) {
            HStack {
                Text("团子")
                    .font(Typo.sans(10.5))
                    .tracking(track(0.04, 10.5))
                    .foregroundStyle(Palette.paperInk)

                Spacer(minLength: 0)

                TextLink(text: "聊聊", size: 12.5) {
                    store.openChat(from: entry)
                }
            }
        }
    }

    // MARK: - 碎片卡

    private var card: some View {
        VStack(alignment: .leading, spacing: 9) {
            if entry.kind == .voice {
                HStack(spacing: 9) {
                    Icons.waveform(color: Palette.ink3)
                    Text(entry.meta ?? "")
                        .font(Typo.sans(11))
                        .tracking(track(0.06, 11))
                        .foregroundStyle(Palette.ink3)
                }
            }

            if entry.kind == .photo {
                photoPlaceholder
            }

            Text(entry.text)
                .font(Typo.sans(14.5))
                .lineHeight(1.75, size: 14.5)
                .foregroundStyle(entry.isPrivate ? Palette.ink2 : Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)

            if entry.isRawTranscript {
                Text("原始转写，未整理")
                    .font(Typo.sans(10.5))
                    .tracking(track(0.04, 10.5))
                    .foregroundStyle(Palette.ink4)
            }

            if entry.kind == .text {
                HStack(spacing: 6) {
                    if entry.isPrivate { Icons.lock(color: Palette.ink3) }
                    Text(entry.permissionLabel)
                        .font(Typo.sans(10.5))
                        .tracking(track(0.04, 10.5))
                        .foregroundStyle(Palette.ink3)
                    Spacer(minLength: 0)
                    if !entry.isPrivate, !entry.needsSync, entry.visit != .commented {
                        TextLink(text: "聊聊", size: 12) { store.openChat(from: entry) }
                    }
                    if store.backend.isRemote {
                        Menu {
                            if entry.isPrivate {
                                Button("给\(store.catName)看") { store.setDiaryVisibility(entry, forCat: true) }
                            } else {
                                Button("停止给\(store.catName)看") { store.setDiaryVisibility(entry, forCat: false) }
                            }
                        } label: {
                            Text("权限").font(Typo.sans(12)).foregroundStyle(Palette.ink3)
                                .frame(minWidth: Metrics.minTap, minHeight: Metrics.minTap)
                        }
                        .accessibilityLabel("日记使用权限")
                    }
                }
            }

            // 团子来过：只留脚印 —— 它看过，但没话说。
            if entry.visit == .readNoComment && !entry.isPrivate {
                PawPrints()
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            entry.isPrivate ? Palette.privateBg : Palette.card,
            in: RoundedRectangle(cornerRadius: Metrics.radiusLg, style: .continuous)
        )
        .overlay {
            // 只有私密碎片保留虚线 —— 那是语义。普通卡靠投影浮起，不描边。
            if entry.isPrivate {
                RoundedRectangle(cornerRadius: Metrics.radiusLg, style: .continuous)
                    .strokeBorder(Palette.privateRule, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
            }
        }
        .softShadow()
    }

    /// 照片占位：135° 斜纹。
    private var photoPlaceholder: some View {
        DiagonalStripes()
            .frame(height: 104)
            .clipShape(RoundedRectangle(cornerRadius: Metrics.radiusCard, style: .continuous))
            .overlay(alignment: .bottomLeading) {
                Text(entry.photoCaption ?? "")
                    .font(Typo.mono(10))
                    .tracking(track(0.05, 10))
                    .foregroundStyle(Color(hex: 0x26301F, alpha: 0.5))
                    .padding(9)
            }
    }

    // MARK: - 团子的留言纸

    private var noteRow: some View {
        HStack(alignment: .top, spacing: columnGap) {
            Text("留言")
                .font(Typo.sans(11))
                .tracking(track(0.04, 11))
                .foregroundStyle(Palette.ink3)
                .frame(width: timeColumn, alignment: .leading)
                .padding(.top, 14)

            VStack(alignment: .leading, spacing: 8) {
                Text(entry.note)
                    .font(Typo.sans(14.5))
                    .lineHeight(1.75, size: 14.5)
                    .foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)

                HStack {
                    Text("团子")
                        .font(Typo.sans(10.5))
                        .tracking(track(0.04, 10.5))
                        .foregroundStyle(Palette.paperInk)

                    Spacer(minLength: 0)

                    TextLink(text: "聊聊", size: 12.5) {
                        store.openChat(from: entry)
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.top, 13)
            .padding(.bottom, 11)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.paper, in: RoundedRectangle(cornerRadius: Metrics.radiusLg, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Metrics.radiusLg, style: .continuous)
                    .stroke(Palette.paperRule, lineWidth: 1)
            )
            .softShadow()
            // 左侧缺口处一枚 accent 色爪印徽标
            .overlay(alignment: .topLeading) {
                Icons.paw(color: Palette.pawMark)
                    .frame(width: 22, height: 22)
                    .background(Circle().fill(Palette.paper))
                    .offset(x: -13, y: 15)
            }
            .padding(.leading, 16)
        }
        .transition(.opacity)
    }
}

/// `repeating-linear-gradient(135deg, #C6D9C4 0 9px, #BCD0BB 9px 18px)`
private struct DiagonalStripes: View {
    var body: some View {
        Canvas { context, size in
            context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(Palette.photoStripeA))

            // 135°：条纹沿左上→右下方向重复，周期 18pt，第二段 9pt 是深色。
            let period: CGFloat = 18
            let band: CGFloat = 9
            let diagonal = size.width + size.height
            var offset: CGFloat = -size.height

            while offset < diagonal {
                var stripe = Path()
                stripe.move(to: CGPoint(x: offset + band, y: 0))
                stripe.addLine(to: CGPoint(x: offset + period, y: 0))
                stripe.addLine(to: CGPoint(x: offset + period - size.height, y: size.height))
                stripe.addLine(to: CGPoint(x: offset + band - size.height, y: size.height))
                stripe.closeSubpath()
                context.fill(stripe, with: .color(Palette.photoStripeB))
                offset += period
            }
        }
    }
}

struct CatDiaryPaperCard<Footer: View>: View {
    let title: String
    let text: String
    @ViewBuilder let footer: () -> Footer

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Icons.paw(size: 13, color: Palette.paperInk)
                Text(title)
                    .font(Typo.sans(10.5))
                    .tracking(track(0.06, 10.5))
                    .foregroundStyle(Palette.paperInk)
            }

            Text(text)
                .font(Typo.sans(14.5))
                .lineHeight(1.75, size: 14.5)
                .foregroundStyle(Palette.ink)
                .fixedSize(horizontal: false, vertical: true)

            footer()
        }
        .padding(.horizontal, 14)
        .padding(.top, 13)
        .padding(.bottom, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.paper, in: RoundedRectangle(cornerRadius: Metrics.radiusLg, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.radiusLg, style: .continuous)
                .stroke(Palette.paperRule, lineWidth: 1)
        )
        .softShadow()
        .accessibilityElement(children: .combine)
        .accessibilityLabel(title + "，" + text)
    }
}
