import SwiftUI

struct V2AgreementsView: View {
    @Environment(\.dismiss) private var dismiss
    let work: V2WorkStore
    @State private var editing: V2TicketEditor.Selection?
    @State private var cancelling: V2.Ticket?
    @State private var actionError: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("在聊天中长按自己发出的原话，可以创建约定或托付。")
                        .font(Typo.sans(13)).foregroundStyle(Palette.ink3)
                    if let actionError { Text(actionError).font(Typo.sans(14)).foregroundStyle(Palette.ink2) }
                    if let error = work.ticketError {
                        Text(error).font(Typo.sans(14)).foregroundStyle(Palette.ink2)
                        TextLink(text: "重新读取") { Task { await work.refresh() } }
                    } else if work.loadingTickets && work.tickets.isEmpty {
                        ProgressView().frame(maxWidth: .infinity)
                    } else if work.tickets.isEmpty {
                        Text("还没有约定或托付").font(Typo.serif(18)).foregroundStyle(Palette.ink3).padding(.vertical, 24)
                    }
                    ForEach(work.pendingTickets) { entry in
                        ListContainer {
                            HStack {
                                Text("\(entry.action.label)还没确认").font(Typo.sans(14))
                                Spacer()
                                TextLink(text: "重试") { submit(entry.action) }.disabled(work.savingTicket)
                            }.padding(18)
                        }
                    }
                    ForEach(work.tickets) { ticket in ticketCard(ticket) }
                }
                .padding(24)
            }
            .background { PageBackground().ignoresSafeArea() }
            .navigationTitle("约定与托付")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("完成") { dismiss() }.foregroundStyle(Palette.ink) } }
            .task { await work.refresh() }
            .refreshable { await work.refresh() }
            .sheet(item: $editing) { V2TicketEditor(selection: $0, work: work) }
            .confirmationDialog("取消这件事？", isPresented: Binding(
                get: { cancelling != nil }, set: { if !$0 { cancelling = nil } }
            ), titleVisibility: .visible, presenting: cancelling) { ticket in
                Button("确认取消", role: .destructive) { submit(.cancel(ticketID: ticket.id)) }
            } message: { ticket in Text(ticket.goal) }
        }.preferredColorScheme(.light)
    }

    private func ticketCard(_ ticket: V2.Ticket) -> some View {
        ListContainer {
            VStack(alignment: .leading, spacing: 14) {
                Text("\(ticket.kind == "errand" ? "托团子的事" : "约好的事") · \(ticket.label)")
                    .font(Typo.sans(12)).foregroundStyle(Palette.ink3)
                Text(ticket.goal).font(Typo.serif(18)).foregroundStyle(Palette.ink)
                if let date = ticket.date {
                    Text(date.formatted(date: .abbreviated, time: .shortened))
                        .font(Typo.sans(13)).foregroundStyle(Palette.ink3)
                }
                if ticket.canResume || (ticket.isOpen && ["errand", "followup"].contains(ticket.kind)) {
                    HStack(spacing: 24) {
                        if ticket.kind == "errand" {
                            Button(ticket.canResume ? "补充并继续" : "补一句话") { editing = .append(ticket) }
                        } else if ticket.mandateKind == "explicit" {
                            Button("改时间") { editing = .reschedule(ticket) }
                        }
                        Button("取消") { cancelling = ticket }
                    }
                    .font(Typo.sans(14)).foregroundStyle(Palette.accent)
                    .frame(minHeight: Metrics.minTap).disabled(work.savingTicket)
                }
            }.padding(18).frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func submit(_ action: V2.TicketAction) {
        Task {
            actionError = nil
            do { try await work.submit(action) }
            catch { actionError = V2WorkStore.errorText(error) }
        }
    }
}

struct V2TicketEditor: View {
    enum Selection: Identifiable {
        case schedule(V2.WorkSource, original: String)
        case start(V2.WorkSource, original: String)
        case reschedule(V2.Ticket)
        case append(V2.Ticket)

        var id: String {
            switch self {
            case .schedule(let source, _): return "schedule-" + source.messageID
            case .start(let source, _): return "start-" + source.messageID
            case .reschedule(let ticket): return "reschedule-" + ticket.id
            case .append(let ticket): return "append-" + ticket.id
            }
        }
        var title: String {
            switch self {
            case .schedule: return "创建约定"
            case .start: return "创建托付"
            case .reschedule: return "改时间"
            case .append(let ticket): return ticket.canResume ? "补充并继续" : "补一句话"
            }
        }
    }

    @Environment(\.dismiss) private var dismiss
    let selection: Selection
    let work: V2WorkStore
    @State private var draft = ""
    @State private var date = Date().addingTimeInterval(3600)
    @State private var error: String?

    private var text: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    switch selection {
                    case .schedule(_, let original):
                        originalText(original)
                        input("到时聊什么", limit: 60)
                        timePicker
                    case .start(_, let original):
                        originalText(original)
                        input("想托团子做什么", limit: 60)
                    case .reschedule(let ticket):
                        Text(ticket.goal).font(Typo.serif(20)).foregroundStyle(Palette.ink)
                        timePicker
                        Text("时间按手机时区显示。安静时段会顺延。")
                            .font(Typo.sans(12)).foregroundStyle(Palette.ink3)
                    case .append(let ticket):
                        Text(ticket.goal).font(Typo.serif(20)).foregroundStyle(Palette.ink)
                        input("想补充的话", limit: 2000)
                    }
                    if let error { Text(error).font(Typo.sans(14)).foregroundStyle(Palette.ink2) }
                }
                .padding(24)
                .disabled(work.savingTicket)
            }
            .background { PageBackground().ignoresSafeArea() }
            .navigationTitle(selection.title).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("返回") { dismiss() }.disabled(work.savingTicket)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(work.savingTicket ? "正在保存…" : "保存") {
                        if let action { Task { await save(action) } }
                    }
                    .disabled(work.savingTicket || action == nil)
                }
            }
        }
        .tint(Palette.ink)
        .preferredColorScheme(.light)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(work.savingTicket)
        .onAppear {
            switch selection {
            case .schedule(_, let original), .start(_, let original):
                if original.unicodeScalars.count <= 60 { draft = original }
            case .reschedule(let ticket):
                if let due = ticket.date, due > Date() { date = due }
            case .append: break
            }
        }
    }

    private var action: V2.TicketAction? {
        let when = ISO8601DateFormatter().string(from: date)
        switch selection {
        case .schedule(let source, _):
            guard !text.isEmpty, text.unicodeScalars.count <= 60, date > Date() else { return nil }
            return .schedule(source: source, about: text, when: when)
        case .start(let source, _):
            guard !text.isEmpty, text.unicodeScalars.count <= 60 else { return nil }
            return .start(source: source, goal: text)
        case .reschedule(let ticket):
            guard date > Date() else { return nil }
            return .reschedule(ticketID: ticket.id, when: when)
        case .append(let ticket):
            guard !text.isEmpty, text.unicodeScalars.count <= 2000 else { return nil }
            return .append(ticketID: ticket.id, text: text)
        }
    }

    private func originalText(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle(text: "聊天原话")
            Text(text).font(Typo.serif(16)).foregroundStyle(Palette.ink)
        }
    }

    private func input(_ prompt: String, limit: Int) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField(prompt, text: $draft, axis: .vertical)
                .font(Typo.sans(15)).lineLimit(2...5).padding(12)
                .background(Palette.card, in: RoundedRectangle(cornerRadius: Metrics.radiusControl))
            if text.unicodeScalars.count > limit {
                Text("最多填写 \(limit) 字").font(Typo.sans(12)).foregroundStyle(Palette.ink2)
            }
        }
    }

    private var timePicker: some View {
        DatePicker("再聊的时间", selection: $date, in: Date()..., displayedComponents: [.date, .hourAndMinute])
            .datePickerStyle(.compact).font(Typo.sans(15))
    }

    private func save(_ action: V2.TicketAction) async {
        error = nil
        do {
            try await work.submit(action)
            dismiss()
        } catch { self.error = V2WorkStore.errorText(error) }
    }
}
