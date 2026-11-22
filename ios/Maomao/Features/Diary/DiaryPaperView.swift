import SwiftUI

/// 日记 · 今天。2026-09-10 起不再是整屏，而是从院子里的信箱抽出来的一张纸（`PaperSheet`）。
/// 纸分两段：`DiaryPaperHeader` 是可下拉关闭的页首，`DiaryPaperView` 是筛选片 + 碎片列表 + 「记一下」。
///
/// 页首照参考图一：一行圆角方块按钮（左搜索、右关闭），两行衬线大标题（一轻一重），一颗信息片。
/// 原来左边那颗团子头像去掉了 —— 头像现在住在院子右上角，不重复。
struct DiaryPaperHeader: View {
    var sharedCount: Int?
    var displayedDay: String?
    var currentDay: String?
    @EnvironmentObject private var store: AppStore

    private var day: String { displayedDay ?? store.diaryDay }
    private var today: String { currentDay ?? store.diaryToday }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Spacer(minLength: 0)

                Button {
                    store.closeMailbox()
                } label: {
                    IconTile(size: Metrics.iconSlotLg, glass: true) {
                        Icons.close(size: IconSize.md, color: Palette.ink)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(PressScaleStyle())
                .accessibilityLabel("关闭日记")
            }

            diaryHeading
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Metrics.gutterDiary)
        .padding(.top, 4)
        .padding(.bottom, 14)
    }

    private var diaryHeading: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 0) {
                Text(DiaryDay.label(day))
                    .font(Typo.serif(22))
                    .tracking(track(0.02, 22))
                    .foregroundStyle(Palette.ink)
                Text(sharedCount != nil ? "共享日记" : (day == today ? "今天" : "日记"))
                    .font(Typo.serif(34, bold: true))
                    .tracking(track(0.02, 34))
                    .foregroundStyle(Palette.ink)
            }

            infoPill
            if sharedCount == nil {
                Button(store.diarySyncLabel) { store.syncDiary() }
                    .font(Typo.sans(12))
                    .foregroundStyle(Palette.ink3)
                    .buttonStyle(.plain)
                    .disabled(!store.backend.isRemote)
            }

            if day != today {
                TextLink(text: "回到今天", size: 13) { store.selectDiaryDay(nil) }
            }
        }
    }

    /// 参考图一「27 May」那颗：白底小胶囊，一个小图标一段字。
    private var infoPill: some View {
        HStack(spacing: 7) {
            IconTile(size: 24, fill: Palette.inset, circular: true) {
                Icons.clock(size: IconSize.sm, color: Palette.ink2)
            }
            Text("\((sharedCount ?? store.shownEntries.count)) 条")
                .font(Typo.sans(12.5))
                .tabularNumbers()
                .foregroundStyle(Palette.ink)
        }
        .padding(.leading, 5)
        .padding(.trailing, 13)
        .padding(.vertical, 5)
        .liquidGlass(in: Capsule(style: .continuous), fallback: Palette.card)
    }
}

struct DiaryPaperView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.screenInsets) private var insets

    var body: some View {
        VStack(spacing: 0) {
            filterRow
                .padding(.horizontal, Metrics.gutterDiary)
                .padding(.bottom, 8)
            entryList
            captureButton
        }
    }

    private var filterRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach([DiaryFilter.all, .privateOnly], id: \.self) { item in
                    filterChip(item)
                }
            }
            .padding(.horizontal, Metrics.gutterDiary)
            .padding(.vertical, 8)   // 给投影留地方，不然会被 ScrollView 裁掉
        }
        .padding(.horizontal, -Metrics.gutterDiary)
        .padding(.vertical, -8)
    }

    @ViewBuilder
    private func filterIcon(_ item: DiaryFilter, color: Color) -> some View {
        switch item {
        case .all: Icons.tabDiary(size: IconSize.sm, color: color)
        case .voice: Icons.waveform(size: IconSize.sm, color: color)
        case .photo: Icons.photo(size: IconSize.sm, color: color)
        case .privateOnly: Icons.lock(size: IconSize.sm, color: color)
        }
    }

    private func filterChip(_ item: DiaryFilter) -> some View {
        let selected = store.diaryFilter == item
        return Button {
            withAnimation(.easeOut(duration: Metrics.fadeFast)) { store.diaryFilter = item }
        } label: {
            HStack(spacing: 6) {
                filterIcon(item, color: selected ? Palette.accent : Palette.ink3)
                Text(item.label)
                    .font(Typo.sans(13, weight: selected ? .medium : .regular))
                    .foregroundStyle(selected ? Palette.ink : Palette.ink3)
            }
            .padding(.horizontal, 13)
            .padding(.vertical, 8)
            .background(selected ? Palette.card : Palette.chip, in: Capsule(style: .continuous))
            .modifier(ConditionalSoftShadow(enabled: selected))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }

    // MARK: - 碎片列表

    private var entryList: some View {
        ScrollViewReader { scroller in
        ScrollView {
            VStack(alignment: .leading, spacing: 15) {
                MailboxLettersView()
                if store.diaryLoadFailed {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("暂时无法读取日记，原文件已保留。")
                            .font(Typo.sans(14))
                            .foregroundStyle(Palette.ink2)
                        TextLink(text: "重新读取", size: 13) { store.loadDiary() }
                    }
                    .padding(.vertical, 18)
                } else if store.shownEntries.isEmpty {
                    Text(store.diaryFilter == .privateOnly ? "这一天还没有只留给自己的记录" : "这一天还没有记录")
                        .font(Typo.sans(14))
                        .foregroundStyle(Palette.ink3)
                        .padding(.vertical, 22)
                }
                ForEach(store.shownEntries) { entry in
                    DiaryEntryRow(entry: entry)
                }

                thisMonth
            }
            .padding(.horizontal, Metrics.gutterDiary)
            .padding(.top, 10)
            .padding(.bottom, 12)
        }
        .refreshable { store.syncDiary(); store.refreshInbox() }
        .id(store.diaryDay)
        .task(id: store.notificationLetterID) {
            await Task.yield()
            if let id = store.notificationLetterID { scroller.scrollTo(id, anchor: .top) }
        }
        .onChange(of: store.mailboxLetters.map(\.id)) {
            if let id = store.notificationLetterID { scroller.scrollTo(id, anchor: .top) }
        }
        }
    }

    @ViewBuilder
    private var thisMonth: some View {
        if !store.diaryEarlierDays.isEmpty {
          VStack(alignment: .leading, spacing: 9) {
            SectionTitle(text: "其他日期")

            ListContainer {
                ForEach(Array(store.diaryEarlierDays.enumerated()), id: \.element) { index, day in
                    if index > 0 { ListDivider(leading: 45) }
                    let records = store.diaryEntries(on: day)
                    Button { store.selectDiaryDay(day) } label: {
                    HStack(spacing: 12) {
                        Text(day)
                            .font(Typo.sans(12))
                            .tabularNumbers()
                            .foregroundStyle(Palette.ink3)

                        Text(records.first?.text ?? "")
                            .font(Typo.sans(14))
                            .foregroundStyle(Palette.ink)
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .frame(maxWidth: .infinity, alignment: .leading)

                        Text("\(records.count) 条")
                            .font(Typo.sans(12))
                            .foregroundStyle(Palette.ink4)
                    }
                    .padding(.horizontal, 15)
                    .padding(.vertical, 13)
                    .frame(minHeight: Metrics.minTap)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(DiaryDay.label(day))，\(records.count)条记录")
                }
            }
        }
        .padding(.top, 4)
        }
    }

    // MARK: - 记一下

    private var captureButton: some View {
        HStack {
            Spacer(minLength: 0)
            PrimaryButton(height: Metrics.minTap, horizontalPadding: 19) {
                store.captureText = ""
                store.captureSaveFailed = false
                store.captureForCat = false
                withAnimation(.easeOut(duration: Metrics.fadeFast)) { store.isCapturing = true }
            } label: {
                HStack(spacing: 7) {
                    Icons.plus(color: Palette.accentInk)
                    Text("记一下")
                        .font(Typo.sans(14.5))
                        .tracking(track(0.08, 14.5))
                }
            }
            .disabled(store.diaryLoadFailed)
        }
        .padding(.horizontal, Metrics.gutterDiary)
        .padding(.top, 8)
        // 纸铺到屏幕最底，按钮让出安全区。
        .padding(.bottom, max(insets.bottom, 16) + 4)
    }
}

private struct ConditionalSoftShadow: ViewModifier {
    let enabled: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if enabled { content.softShadow() } else { content }
    }
}
