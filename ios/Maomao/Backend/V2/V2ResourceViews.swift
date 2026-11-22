import SwiftUI

struct V2ResourceEdit: Identifiable {
    let id = UUID()
    let title: String
    let text: String
    var catAllowed: Bool?
    var replacing: UUID?
    var currentText: String?
    let makeAction: (String, Bool) -> V2ResourceAction
}

struct V2ResourceEditor: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var resources: V2ResourceStore
    let edit: V2ResourceEdit
    @State private var text: String
    @State private var catAllowed: Bool
    @State private var failed = false

    init(resources: V2ResourceStore, edit: V2ResourceEdit) {
        self.resources = resources
        self.edit = edit
        _text = State(initialValue: edit.text)
        _catAllowed = State(initialValue: edit.catAllowed ?? false)
    }

    private var isDiary: Bool { edit.makeAction("", false).area == .diary }
    private var limit: Int { isDiary ? 20_000 : 2_000 }
    private var normalized: String { isDiary ? text : text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var length: Int { normalized.utf16.count }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    TextEditor(text: $text)
                        .font(Typo.sans(15))
                        .foregroundStyle(Palette.ink)
                        .scrollContentBackground(.hidden)
                        .frame(height: 160)
                        .padding(8)
                        .background(Palette.card, in: RoundedRectangle(cornerRadius: Metrics.radiusCard))
                        .accessibilityLabel(isDiary ? "日记正文" : edit.title)
                        .accessibilityIdentifier("v2ResourceDraft")
                    if edit.catAllowed != nil {
                        Toggle("允许团子阅读", isOn: $catAllowed).tint(Palette.accent)
                        Text("你和伴侣都可以阅读这条日记。").font(Typo.sans(13)).foregroundStyle(Palette.ink2)
                    }
                    if let current = edit.currentText {
                        SectionTitle(text: "电脑上的当前版本")
                        Text(current).font(Typo.sans(14)).textSelection(.enabled)
                    }
                    if length > limit { Text("内容过长，请缩短后再保存。").font(Typo.sans(13)) }
                    if failed, let error = resources.storageError ?? resources.inputError {
                        Text(error).font(Typo.sans(13)).foregroundStyle(Palette.ink2)
                    }
                }.padding(20)
            }
            .background { PageBackground().ignoresSafeArea() }
            .navigationTitle(edit.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        if resources.submit(edit.makeAction(normalized, catAllowed), replacing: edit.replacing) { dismiss() }
                        else { failed = true }
                    }
                    .disabled(resources.busy || normalized.trimmed.isEmpty || length > limit)
                }
            }
        }
        .tint(Palette.ink)
        .preferredColorScheme(.light)
    }
}

struct V2ResourceNotice: View {
    let message: String
    var body: some View {
        Text(message)
            .font(Typo.sans(13))
            .foregroundStyle(Palette.ink2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 5)
    }
}

struct V2PendingResourceRow: View {
    @ObservedObject var resources: V2ResourceStore
    let item: V2ResourcePending
    var review: (() async -> Void)?
    var edit: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(item.action.title).font(Typo.sans(14, weight: .medium))
            if let draft = item.action.draftText {
                Text(draft).font(Typo.sans(14)).lineLimit(3).textSelection(.enabled)
            }
            V2ResourceNotice(message: resources.transmitting == item.id ? "正在提交…" : item.explanation)
            if item.problem?.canReplay != false {
                TextLink(text: item.memoryReceipt == nil ? "重试原请求" : "查询处理结果", size: 13) {
                    Task { await resources.transmit(item.id) }
                }
                    .disabled(resources.busy)
            } else {
                HStack(spacing: 16) {
                    if let review, item.problem == .conflict {
                        TextLink(text: "读取当前版本", size: 13) { Task { await review() } }
                    }
                    if let edit { TextLink(text: "核对草稿", size: 13, action: edit) }
                    TextLink(text: item.action.draftText == nil ? "清除此提示" : "丢弃草稿", size: 13) {
                        resources.dismissFailed(item)
                    }
                }.disabled(resources.busy)
            }
        }
        .foregroundStyle(Palette.ink)
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.inset, in: RoundedRectangle(cornerRadius: Metrics.radiusCard))
    }
}

struct V2ResourceConfirmation: Identifiable {
    let id = UUID()
    let action: V2ResourceAction
    let explanation: String
}

extension View {
    func v2ResourceConfirmation(_ selection: Binding<V2ResourceConfirmation?>, resources: V2ResourceStore) -> some View {
        alert(selection.wrappedValue?.action.title ?? "", isPresented: Binding(
            get: { selection.wrappedValue != nil }, set: { if !$0 { selection.wrappedValue = nil } }
        ), presenting: selection.wrappedValue) { item in
            Button("确认", role: .destructive) { _ = resources.submit(item.action) }
            Button("取消", role: .cancel) {}
        } message: { item in Text(item.explanation) }
    }
}
