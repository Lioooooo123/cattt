import SwiftUI

struct V2MemoryCenterView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var resources: V2ResourceStore
    @State private var editor: V2ResourceEdit?
    @State private var confirmation: V2ResourceConfirmation?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let error = resources.storageError ?? resources.inputError ?? resources.readError {
                        V2ResourceNotice(message: error)
                    }
                    if resources.busy && resources.transmitting == nil { ProgressView("正在读取记录…") }
                    ForEach(resources.pending(in: .knowledge)) { item in
                        V2PendingResourceRow(resources: resources, item: item,
                            review: item.action.sourceLocation == nil ? { await resources.refresh() } : nil,
                            edit: retryEdit(item))
                    }
                    SectionTitle(text: "长期记忆")
                    if resources.memories.isEmpty && !resources.isSyncing {
                        V2ResourceNotice(message: "目前还没有可核对的记忆。")
                    }
                    ForEach(resources.memories) { memory in memoryCard(memory) }
                    SectionTitle(text: "回避的话题")
                    if resources.boundaries.isEmpty {
                        V2ResourceNotice(message: "可以在聊天中长按自己发出的消息，添加回避。")
                    }
                    ForEach(resources.boundaries) { boundary in boundaryCard(boundary) }
                }.padding(20)
            }
            .background { PageBackground().ignoresSafeArea() }
            .refreshable { await resources.refresh() }
            .navigationTitle("记忆与回避")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Button("刷新") { Task { await resources.refresh() } }.disabled(resources.busy)
                }
            }
        }
        .task { await resources.refresh() }
        .sheet(item: $editor) { edit in V2ResourceEditor(resources: resources, edit: edit) }
        .v2ResourceConfirmation($confirmation, resources: resources)
        .tint(Palette.ink)
        .preferredColorScheme(.light)
    }

    private func memoryCard(_ memory: V2.Memory) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(memory.subjectMemberID == nil ? "共同记忆" : "关于我")
                .font(Typo.sans(12)).foregroundStyle(Palette.ink3)
            Text(memory.predicate).font(Typo.sans(13)).foregroundStyle(Palette.ink2)
            Text(memory.value).font(Typo.sans(15)).textSelection(.enabled)
            if let source = memory.source {
                Text("来自\(resources.name(source.memberID))的聊天")
                    .font(Typo.sans(12)).foregroundStyle(Palette.ink2)
            }
            if memory.canEdit {
                HStack(spacing: 18) {
                    TextLink(text: "更正记忆", size: 13) { editor = memoryEdit(memory) }
                    TextLink(text: "撤回记忆", size: 13) {
                        confirmation = .init(action: .forgetMemory(id: memory.id, revision: memory.revision),
                            explanation: "电脑确认后，团子将停止使用这条记忆。")
                    }
                }.disabled(blocked("memories/" + memory.id))
            } else {
                Text("只读").font(Typo.sans(12)).foregroundStyle(Palette.ink3)
            }
        }.v2KnowledgeCard()
    }

    private func boundaryCard(_ boundary: V2.Boundary) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(boundary.description).font(Typo.sans(15)).textSelection(.enabled)
            if boundary.subjectMemberID == resources.memberID {
                HStack(spacing: 18) {
                    TextLink(text: "修改回避", size: 13) { editor = boundaryEdit(boundary) }
                    TextLink(text: "取消回避", size: 13) {
                        confirmation = .init(action: .removeBoundary(id: boundary.id, revision: boundary.revision),
                            explanation: "电脑确认后，这条回避规则将停止生效。")
                    }
                }.disabled(blocked("boundaries/" + boundary.id))
            }
        }.v2KnowledgeCard()
    }

    private func blocked(_ target: String) -> Bool {
        resources.busy || resources.pendingRequests.contains { $0.action.target == target }
    }

    private func memoryEdit(_ item: V2.Memory, draft: String? = nil, replacing: UUID? = nil) -> V2ResourceEdit {
        .init(title: "更正记忆", text: draft ?? item.value, replacing: replacing,
              currentText: replacing == nil ? nil : item.value) { value, _ in
            .reviseMemory(id: item.id, revision: item.revision, value: value)
        }
    }

    private func boundaryEdit(_ item: V2.Boundary, draft: String? = nil, replacing: UUID? = nil) -> V2ResourceEdit {
        .init(title: "修改回避", text: draft ?? item.description, replacing: replacing,
              currentText: replacing == nil ? nil : item.description) { description, _ in
            .editBoundary(id: item.id, revision: item.revision, description: description)
        }
    }

    private func retryEdit(_ request: V2ResourcePending) -> (() -> Void)? {
        guard request.problem?.canReplay == false else { return nil }
        switch request.action {
        case .reviseMemory(let id, let revision, let text):
            guard let item = resources.memories.first(where: { $0.id == id && $0.canEdit }),
                  request.problem != .conflict || item.revision != revision else { return nil }
            return { editor = memoryEdit(item, draft: text, replacing: request.id) }
        case .editBoundary(let id, let revision, let text):
            guard let item = resources.boundaries.first(where: { $0.id == id }),
                  request.problem != .conflict || item.revision != revision else { return nil }
            return { editor = boundaryEdit(item, draft: text, replacing: request.id) }
        default: return nil
        }
    }
}

struct V2MessageUsageView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var resources: V2ResourceStore
    @ObservedObject var catDiary: V2CatDiaryStore
    let message: V2.Message
    @State private var editor: V2ResourceEdit?
    @State private var confirmation: V2ResourceConfirmation?
    @State private var diarySourceConfirmation: V2.CatDiarySource?
    @State private var checked = false
    @State private var currentUsage: V2.SourceUsage?

    private var location: V2.MessageLocation { .init(conversationID: message.conversationId, messageID: message.id) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text(message.text).font(Typo.sans(15)).textSelection(.enabled).v2KnowledgeCard()
                    if let error = resources.storageError ?? resources.inputError { V2ResourceNotice(message: error) }
                    let pending = resources.pending(for: location)
                    ForEach(pending) { item in
                        V2PendingResourceRow(resources: resources, item: item, review: reload)
                    }
                    if !checked {
                        ProgressView("正在核对这条原话…")
                    } else if let error = resources.sourceErrors[location.id] {
                        V2ResourceNotice(message: error)
                    } else if let usage = resources.sources[location.id] {
                        if usage.allowed {
                            V2ResourceNotice(message: "你可以让团子回避相关话题，或撤回这条原话的后续用途。")
                            HStack(spacing: 18) {
                                TextLink(text: "添加回避", size: 14) {
                                    editor = .init(title: "添加回避", text: "") { description, _ in
                                        .addBoundary(source: usage, description: description)
                                    }
                                }
                                TextLink(text: "撤回原话用途", size: 14) {
                                    confirmation = .init(action: .withdrawSource(usage),
                                        explanation: "聊天记录会保留。电脑确认后，团子将停止使用这条原话及依赖它的内容。")
                                }
                            }.disabled(resources.busy || !pending.isEmpty)
                            if currentUsage == usage, message.author.kind == .member,
                               message.author.memberId == resources.memberID {
                                diarySourceControls(usage, hasPending: !pending.isEmpty)
                            }
                        } else {
                            V2ResourceNotice(message: "已撤回这条原话的用途。聊天记录仍然保留。")
                        }
                    }
                }.padding(20)
            }
            .background { PageBackground().ignoresSafeArea() }
            .navigationTitle("原话用途")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Button("刷新") { Task { await reload() } }.disabled(resources.busy)
                }
            }
        }
        .task { await reload() }
        .sheet(item: $editor) { edit in V2ResourceEditor(resources: resources, edit: edit) }
        .v2ResourceConfirmation($confirmation, resources: resources)
        .catDiarySourceConfirmation($diarySourceConfirmation, store: catDiary)
        .tint(Palette.ink)
        .preferredColorScheme(.light)
    }

    @ViewBuilder
    private func diarySourceControls(_ usage: V2.SourceUsage, hasPending: Bool) -> some View {
        let source = V2.CatDiarySource(kind: .message, id: usage.messageID, revision: usage.revision)
        let state = catDiary.authorization[source]
        if let state { V2ResourceNotice(message: state.message) }
        if state?.canSubmit != false {
            TextLink(text: state == nil ? "允许用于团子的日记" : "重试猫日记授权", size: 14) {
                diarySourceConfirmation = source
            }.disabled(resources.busy || hasPending)
        }
    }

    private func reload() async {
        currentUsage = await resources.refreshSource(location)
        checked = true
    }
}

private extension View {
    func v2KnowledgeCard() -> some View {
        self.padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .foregroundStyle(Palette.ink)
            .background(Palette.card, in: RoundedRectangle(cornerRadius: Metrics.radiusLg))
            .softShadow()
    }
}
