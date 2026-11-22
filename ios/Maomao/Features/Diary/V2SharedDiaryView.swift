import SwiftUI

struct V2SharedDiaryHeader: View {
    @ObservedObject var resources: V2ResourceStore
    @ObservedObject var catDiary: V2CatDiaryStore
    @EnvironmentObject private var store: AppStore

    var body: some View {
        let today = catDiary.today(at: store.currentDate())
        let day = store.selectedDiaryDay ?? today
        DiaryPaperHeader(sharedCount: resources.diary.filter { $0.localDay == day }.count,
                         displayedDay: day, currentDay: today)
    }
}

struct V2SharedDiaryView: View {
    @ObservedObject var resources: V2ResourceStore
    @ObservedObject var catDiary: V2CatDiaryStore
    @EnvironmentObject private var store: AppStore
    @Environment(\.screenInsets) private var insets
    @Environment(\.scenePhase) private var scenePhase
    @State private var editor: V2ResourceEdit?
    @State private var confirmation: V2ResourceConfirmation?
    @State private var diarySourceConfirmation: V2.CatDiarySource?

    private var grouped: [String: [V2.SharedDiary]] { Dictionary(grouping: resources.diary, by: \.localDay) }

    private struct CatDiaryRefresh: Equatable {
        let visible: Bool
        let version: Int
    }

    private var catDiaryRefresh: CatDiaryRefresh {
        .init(visible: store.mailboxOpen && scenePhase == .active, version: catDiary.refreshVersion)
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    status
                    ForEach(resources.pending(in: .diary)) { item in
                        V2PendingResourceRow(resources: resources, item: item,
                            review: { await resources.refresh() }, edit: retryEdit(item))
                    }
                    let entries = grouped[store.diaryDay] ?? []
                    if entries.isEmpty {
                        V2ResourceNotice(message: resources.isSyncing ? "正在读取日记…" : "这一天还没有共享日记。")
                    }
                    ForEach(entries.sorted { ($0.recordedAt, $0.id) < ($1.recordedAt, $1.id) }) { entry in
                        card(entry)
                    }
                    catDiaryEntries
                    earlierDays
                    MailboxLettersView()
                }
                .padding(.horizontal, Metrics.gutterDiary)
                .padding(.vertical, 10)
            }
            .refreshable { await refresh() }
            HStack {
                Spacer()
                PrimaryButton(height: Metrics.minTap, horizontalPadding: 19) { editor = newEntry() } label: {
                    HStack(spacing: 7) {
                        Icons.plus(color: Palette.accentInk)
                        Text("记一下").font(Typo.sans(14.5))
                    }
                }.disabled(resources.busy)
            }
            .padding(.horizontal, Metrics.gutterDiary)
            .padding(.vertical, 8)
            .padding(.bottom, max(insets.bottom, 16))
        }
        .task { await resources.refresh() }
        .task(id: catDiaryRefresh) {
            guard catDiaryRefresh.visible else { return }
            while !Task.isCancelled {
                await catDiary.refresh()
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { catDiary.invalidateEntries() }
        }
        .catDiarySourceConfirmation($diarySourceConfirmation, store: catDiary)
        .sheet(item: $editor) { edit in V2ResourceEditor(resources: resources, edit: edit) }
        .v2ResourceConfirmation($confirmation, resources: resources)
    }

    private var status: some View {
        VStack(alignment: .leading, spacing: 3) {
            if let error = resources.storageError ?? resources.inputError ?? resources.readError {
                V2ResourceNotice(message: error)
            }
            TextLink(text: "刷新日记", size: 13) { Task { await refresh() } }
                .disabled(resources.busy)
        }
    }

    private func refresh() async {
        async let shared: Void = resources.refresh()
        await catDiary.refresh()
        await shared
    }

    @ViewBuilder
    private var catDiaryEntries: some View {
        if let error = catDiary.readError {
            V2ResourceNotice(message: error)
        } else if let snapshot = catDiary.snapshot {
            ForEach(snapshot.entries(on: store.diaryDay)) { entry in
                CatDiaryPaperCard(title: entry.origin == .daily ? "团子的一天" : "团子的旧日记", text: entry.text) {
                    EmptyView()
                }
            }
        } else {
            V2ResourceNotice(message: "正在读取团子的日记…")
        }
    }

    private func card(_ entry: V2.SharedDiary) -> some View {
        let source = V2.CatDiarySource(kind: .diary, id: entry.id, revision: entry.revision)
        let sourceState = catDiary.authorization[source]
        let canOfferSource = resources.canEdit(entry) && entry.catAllowed && entry.catReadable
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(resources.name(entry.ownerMemberID))
                    .font(Typo.sans(13, weight: .medium))
                Spacer()
                let time = Date(timeIntervalSince1970: Double(entry.recordedAt) / 1000)
                Text(time.formatted(Date.VerbatimFormatStyle(
                    format: "\(hour: .twoDigits(clock: .twentyFourHour, hourCycle: .zeroBased)):\(minute: .twoDigits)",
                    locale: Locale(identifier: "zh_CN"), timeZone: TimeZone(identifier: entry.timeZone) ?? .current,
                    calendar: Calendar(identifier: .gregorian))))
                    .font(Typo.mono(11))
                    .foregroundStyle(Palette.ink3)
            }
            Text(entry.text).font(Typo.sans(14.5)).lineHeight(1.75, size: 14.5).textSelection(.enabled)
            HStack {
                Text(permission(entry)).font(Typo.sans(12)).foregroundStyle(Palette.ink2)
                Spacer(minLength: 8)
                if resources.canEdit(entry) {
                    Menu {
                        Button("修改正文") { editor = editEntry(entry) }
                        Button(entry.catAllowed ? "停止团子阅读" : "允许团子阅读") {
                            _ = resources.submit(.allowDiary(id: entry.id, revision: entry.revision, allowed: !entry.catAllowed))
                        }
                        if canOfferSource, sourceState?.canSubmit != false {
                            Button(sourceState == nil ? "允许用于团子的日记" : "重试猫日记授权") {
                                diarySourceConfirmation = source
                            }
                        }
                        Button("撤回日记", role: .destructive) {
                            confirmation = .init(action: .withdrawDiary(id: entry.id, revision: entry.revision),
                                explanation: "电脑确认后，你和伴侣都将看不到这条日记。")
                        }
                    } label: {
                        Text("管理").font(Typo.sans(13))
                            .frame(minWidth: Metrics.minTap, minHeight: Metrics.minTap)
                    }
                    .accessibilityLabel("管理日记")
                    .disabled(resources.busy || resources.pendingRequests.contains { $0.action.target == "diary/" + entry.id })
                } else {
                    Text("只读").font(Typo.sans(12)).foregroundStyle(Palette.ink3)
                }
            }
            if canOfferSource, let sourceState {
                Text(sourceState.message).font(Typo.sans(12)).foregroundStyle(Palette.ink2)
            }
        }
        .foregroundStyle(Palette.ink)
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.card, in: RoundedRectangle(cornerRadius: Metrics.radiusLg))
        .softShadow()
    }

    private func permission(_ entry: V2.SharedDiary) -> String {
        if entry.catReadable { return "团子可以阅读" }
        return entry.catAllowed ? "团子暂不可读 · 来源不可用" : "团子不可读"
    }

    @ViewBuilder private var earlierDays: some View {
        let catDays = Dictionary(grouping: catDiary.snapshot?.entries ?? [], by: \.localDay)
        let days = Set(grouped.keys).union(catDays.keys).subtracting([store.diaryDay]).sorted(by: >)
        if !days.isEmpty {
            SectionTitle(text: "其他日期")
            ListContainer {
                ForEach(days, id: \.self) { day in
                    Button { store.selectDiaryDay(day) } label: {
                        HStack {
                            Text(DiaryDay.label(day)).font(Typo.sans(13))
                            Spacer()
                            let sharedCount = grouped[day]?.count ?? 0
                            let catCount = catDays[day]?.count ?? 0
                            if sharedCount > 0 {
                                Text("\(sharedCount) 条共享日记").font(Typo.sans(12)).foregroundStyle(Palette.ink3)
                            }
                            if catCount > 0 {
                                Text("\(catCount) 篇团子日记").font(Typo.sans(12)).foregroundStyle(Palette.ink3)
                            }
                        }
                        .padding(.horizontal, 14)
                        .frame(minHeight: Metrics.minTap)
                        .contentShape(Rectangle())
                    }.buttonStyle(.plain)
                    if day != days.last { ListDivider(leading: 14) }
                }
            }
        }
    }

    private func newEntry() -> V2ResourceEdit {
        let date = Date()
        let zone = TimeZone.current
        return .init(title: "记一下", text: "", catAllowed: false) { text, allowed in
            .addDiary(text: text, recordedAt: Int64(date.timeIntervalSince1970 * 1000),
                      day: DiaryDay.key(for: date, timeZone: zone), timeZone: zone.identifier, catAllowed: allowed)
        }
    }

    private func editEntry(_ entry: V2.SharedDiary, draft: String? = nil, replacing: UUID? = nil) -> V2ResourceEdit {
        .init(title: "修改日记", text: draft ?? entry.text, replacing: replacing,
              currentText: replacing == nil ? nil : entry.text) { text, _ in
            .editDiary(id: entry.id, revision: entry.revision, text: text)
        }
    }

    private func retryEdit(_ item: V2ResourcePending) -> (() -> Void)? {
        guard item.problem?.canReplay == false else { return nil }
        switch item.action {
        case .addDiary(let text, let date, let day, let zone, let allowed):
            return {
                editor = .init(title: "修改待提交日记", text: text, catAllowed: allowed, replacing: item.id) { draft, permission in
                    .addDiary(text: draft, recordedAt: date, day: day, timeZone: zone, catAllowed: permission)
                }
            }
        case .editDiary(let id, let revision, let text):
            guard let entry = resources.diary.first(where: { $0.id == id }), resources.canEdit(entry),
                  item.problem != .conflict || entry.revision != revision else { return nil }
            return { editor = editEntry(entry, draft: text, replacing: item.id) }
        default: return nil
        }
    }
}
