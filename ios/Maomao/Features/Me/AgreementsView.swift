import SwiftUI

/// 约定沿用“我的”的分组与纸面，不增加清单打勾或进度。
struct AgreementsView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var tickets: [APITicket] = []
    @State private var loading = true
    @State private var error: String?
    @State private var editing: APITicket?
    @State private var selectedDate = Date()
    @State private var saving = false
    @State private var inputText = ""

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("约好的，到时聊。托给我的，我慢慢想。")
                        .font(Typo.sans(13)).foregroundStyle(Palette.ink3)
                    if loading { ProgressView().frame(maxWidth: .infinity) }
                    else if let error { Button(error) { Task { await load() } }.font(Typo.sans(14)).foregroundStyle(Palette.ink2) }
                    else if tickets.isEmpty { Text("还没有约定或托付").font(Typo.serif(18)).foregroundStyle(Palette.ink3).padding(.vertical, 24) }
                    ForEach(tickets) { ticket in
                        ListContainer {
                            VStack(alignment: .leading, spacing: 14) {
                                Text(ticket.kind == "errand" ? "托团子的事 · \(ticket.stageText)" : "约好的事")
                                    .font(Typo.sans(12)).foregroundStyle(Palette.ink3)
                                Text(ticket.goal).font(Typo.serif(18)).foregroundStyle(Palette.ink)
                                if let date = ticket.date {
                                    Text(date.formatted(date: .abbreviated, time: .shortened))
                                        .font(Typo.sans(13)).foregroundStyle(Palette.ink3)
                                }
                                if ticket.status == "open" {
                                    HStack(spacing: 24) {
                                        Button(ticket.kind == "errand" ? "补一句话" : "改时间") {
                                            selectedDate = ticket.date ?? Date(); inputText = ""; editing = ticket
                                        }
                                        Button("取消") { Task { await cancel(ticket) } }
                                    }
                                    .font(Typo.sans(14)).foregroundStyle(Palette.accent)
                                    .frame(minHeight: Metrics.minTap).disabled(saving)
                                }
                            }.padding(18)
                        }
                    }
                }.padding(24)
            }
            .background { PageBackground().ignoresSafeArea() }
            .navigationTitle("约定与托付")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("完成") { dismiss() }.foregroundStyle(Palette.ink) } }
            .task { await load() }
            .refreshable { await load() }
            .sheet(item: $editing) { ticket in
                NavigationStack {
                    VStack(alignment: .leading, spacing: 24) {
                        Text(ticket.goal).font(Typo.serif(20)).foregroundStyle(Palette.ink)
                        if ticket.kind == "errand" {
                            TextField("想补充的话", text: $inputText, axis: .vertical)
                                .font(Typo.sans(15)).lineLimit(3...6)
                            Text("这句话会直接交给正在想这件事的团子。")
                                .font(Typo.sans(12)).foregroundStyle(Palette.ink3)
                        } else {
                            DatePicker("再聊的时间", selection: $selectedDate, in: Date()..., displayedComponents: [.date, .hourAndMinute])
                                .datePickerStyle(.compact).font(Typo.sans(15))
                            Text("按你现在所在的时区显示；安静时段会顺延到早上九点。")
                                .font(Typo.sans(12)).foregroundStyle(Palette.ink3)
                        }
                        Spacer()
                    }.padding(24)
                    .background { PageBackground().ignoresSafeArea() }
                    .navigationTitle(ticket.kind == "errand" ? "补一句话" : "改时间").navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) { Button("返回") { editing = nil } }
                        ToolbarItem(placement: .topBarTrailing) { Button("保存") { Task { await change(ticket) } }.disabled(saving || (ticket.kind == "errand" && (inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || inputText.count > 2000))) }
                    }
                }.presentationDetents([.medium]).presentationDragIndicator(.visible)
            }
        }.preferredColorScheme(.light)
    }
    private func load() async {
        guard store.backend.isRemote else { tickets = []; loading = false; return }
        let client = store.api
        do {
            let loaded = try await client.tickets()
            guard store.backend == client.config else { return }
            tickets = loaded; error = nil
            await store.reconcileFollowupNotifications(loaded, config: client.config)
        } catch { self.error = "没能读取，点此重试" }
        loading = false
    }
    private func change(_ ticket: APITicket) async {
        saving = true
        defer { saving = false }
        do {
            if ticket.kind == "errand" { try await store.api.addTicketInput(ticket.id, text: inputText) }
            else { try await store.api.changeTicket(ticket.id, to: selectedDate) }
            FollowupNotifications.remove(ticket.id)
            editing = nil; await load(); store.flash(ticket.kind == "errand" ? "这句话交给团子了" : "时间改好了")
        }
        catch { store.flash("没能改好，请稍后再试") }
    }
    private func cancel(_ ticket: APITicket) async {
        saving = true
        defer { saving = false }
        do { try await store.api.cancelTicket(ticket.id); FollowupNotifications.remove(ticket.id); await load(); store.flash("这件事取消了") }
        catch { store.flash("没能取消，请稍后再试") }
    }
}
