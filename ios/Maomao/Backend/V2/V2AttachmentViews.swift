import QuickLook
import SwiftUI
import UniformTypeIdentifiers

@MainActor
struct V2ConversationAttachments: View {
    let conversation: V2.Conversation
    let connection: V2Connection
    let changes: V2ChangesStore
    let scope: V2SyncScope?
    let memberNames: [String: String]

    private enum Work: Equatable {
        case refresh, stage(URL), upload(String)
    }

    @Environment(\.dismiss) private var dismiss
    @State private var outbox: V2AttachmentOutbox
    @State private var work: Work? = .refresh
    @State private var pending: [V2AttachmentOutbox.Entry] = []
    private var files: [V2.Attachment] {
        guard let scope, changes.scope == scope else { return [] }
        return changes.snapshot.attachments.filter { $0.conversationID == conversation.id }
    }
    @State private var loaded = false
    @State private var importing = false
    @State private var activeUploadID: String?
    @State private var error: String?

    init(conversation: V2.Conversation, connection: V2Connection, changes: V2ChangesStore, memberNames: [String: String]) {
        self.conversation = conversation
        self.connection = connection
        self.changes = changes
        scope = V2SyncScope(identity: connection.identity)
        self.memberNames = memberNames
        let identity = connection.identity
        let scope = V2AttachmentOutbox.Scope(householdID: identity.household.id, memberID: identity.member.id,
                                             deviceID: identity.deviceId, conversationID: conversation.id)
        _outbox = State(initialValue: V2AttachmentOutbox(root: .applicationSupportDirectory, scope: scope))
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    PrimaryButton(enabled: work == nil, shadow: false) {
                        importing = true
                    } label: {
                        Label("发送文件", systemImage: "plus").font(Typo.sans(15))
                    }.disabled(work != nil)
                    if let error { note(error) }
                    if work == .refresh { ProgressView("正在读取附件…") }
                    if isStaging && activeUploadID == nil { ProgressView("正在准备附件…") }
                    if !pending.isEmpty { pendingSection }
                    if !files.isEmpty { filesSection }
                    if loaded && files.isEmpty && pending.isEmpty { note("这段聊天还没有附件") }

                }.padding(20)
            }
            .background(PageBackground().ignoresSafeArea())
            .navigationTitle("附件 · \(conversation.title)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Palette.bg, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbarColorScheme(.light, for: .navigationBar)
            .navigationDestination(for: String.self) { id in
                V2AttachmentDetail(fileID: id, conversationID: conversation.id,
                                   connection: connection, changes: changes, scope: scope)
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("完成") { dismiss() } }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("刷新", systemImage: "arrow.clockwise") { work = .refresh }
                        .labelStyle(.iconOnly).disabled(work != nil)
                }
            }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.item]) { result in
                switch result {
                case .success(let url): work = .stage(url)
                case .failure(let error): show(error)
                }
            }
            .task(id: work) {
                guard let work else { return }
                await perform(work)
                if !Task.isCancelled { self.work = nil }
            }
        }
        .preferredColorScheme(.light)
    }

    private var isStaging: Bool {
        if case .stage = work { return true }
        return false
    }

    private var pendingSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionTitle(text: "待上传")
            ListContainer {
                ForEach(pending) { entry in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(entry.fileName).font(Typo.sans(16)).foregroundStyle(Palette.ink)
                        if activeUploadID == entry.id {
                            if entry.offset == entry.byteSize {
                                ProgressView("等待电脑确认…")
                            } else {
                                ProgressView(value: Double(entry.offset), total: Double(entry.byteSize)) {
                                    Text("正在上传")
                                }.tint(Palette.accent)
                            }
                        } else {
                            Text(entry.offset == entry.byteSize ? "等待电脑确认" : "尚未上传完成")
                                .font(Typo.sans(13)).foregroundStyle(Palette.ink2)
                            Button("继续上传") { work = .upload(entry.id) }
                                .buttonStyle(.borderless).disabled(work != nil)
                        }
                    }.padding(15).frame(maxWidth: .infinity, alignment: .leading)
                    if entry.id != pending.last?.id { ListDivider() }
                }
            }
        }
    }

    private var filesSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionTitle(text: "会话附件")
            ListContainer {
                ForEach(files) { file in
                    NavigationLink(value: file.id) {
                        HStack(spacing: 12) {
                            Image(systemName: file.mediaType.hasPrefix("image/") ? "photo" : "doc")
                                .foregroundStyle(Palette.ink2)
                            VStack(alignment: .leading, spacing: 6) {
                                Text(file.fileName).font(Typo.sans(16)).foregroundStyle(Palette.ink).lineLimit(2)
                                Text(fileSubtitle(file)).font(Typo.sans(13)).foregroundStyle(Palette.ink2)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                            Icons.chevronRight(color: Palette.ink2).frame(width: 20, height: 20)
                        }.padding(15).contentShape(Rectangle())
                    }.buttonStyle(.plain)
                    if file.id != files.last?.id { ListDivider() }
                }
            }
        }
    }

    private func fileSubtitle(_ file: V2.Attachment) -> String {
        let uploader = file.ownerMemberID == connection.identity.member.id ? "我" : memberNames[file.ownerMemberID] ?? "家人"
        return file.available ? uploader : "\(uploader) · 电脑缺少原件"
    }

    private func note(_ text: String) -> some View {
        Text(text).font(Typo.sans(14)).foregroundStyle(Palette.ink2)
    }

    private func perform(_ work: Work) async {
        error = nil
        do {
            try Task.checkCancellation()
            switch work {
            case .refresh:
                pending = try await outbox.entries()
                try await changes.synchronize()
                loaded = true
            case .stage(let url):
                let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                let entry = try await outbox.stage(url, mediaType: type)
                pending.append(entry)
                try await upload(entry.id)
            case .upload(let id):
                try await upload(id)
            }
        } catch {
            if !Task.isCancelled { show(error) }
        }
    }

    private func upload(_ id: String) async throws {
        activeUploadID = id
        defer { activeUploadID = nil }
        let client = try await connection.select()
        _ = try await outbox.upload(id, client: client) { entry in
            await MainActor.run {
                if let index = pending.firstIndex(where: { $0.id == entry.id }) { pending[index] = entry }
            }
        }
        pending.removeAll { $0.id == id }
        if let scope { changes.resourceWriteDidCommit(in: scope) }
        try await changes.synchronize()
        loaded = true
    }

    private func show(_ error: Error) {
        self.error = error.localizedDescription
    }
}

@MainActor
private struct V2AttachmentDetail: View {
    let fileID: String
    let conversationID: String
    let connection: V2Connection
    let changes: V2ChangesStore
    let scope: V2SyncScope?

    private enum Work { case load, preview, original, generate, withdraw }

    @Environment(\.dismiss) private var dismiss
    @State private var work: Work? = .load
    private var file: V2.Attachment? {
        guard let scope, changes.scope == scope else { return nil }
        return changes.snapshot.attachment(id: fileID, conversationID: conversationID)
    }
    private var description: V2.FileDescriptionProjection? {
        file.flatMap { changes.snapshot.fileDescription(fileID: $0.id, fileRev: $0.rev) }
    }
    @State private var generationStatus: V2.FileDescription.Status?
    @State private var thumbnail: UIImage?
    @State private var original: URL?
    @State private var error: String?
    @State private var confirmingWithdrawal = false
    @State private var unavailable = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if let file, !unavailable {
                    metadata(file)
                    if let thumbnail {
                        Image(uiImage: thumbnail).resizable().scaledToFit()
                            .frame(maxWidth: .infinity, maxHeight: 240)
                            .clipShape(RoundedRectangle(cornerRadius: Metrics.radiusCard))
                            .accessibilityLabel("附件缩略图")
                    }
                    if file.available { contentActions(file) }
                    if file.supportsDescription { descriptionSection(file) }
                    if canModify(file) {
                        Button("撤回附件", role: .destructive) { confirmingWithdrawal = true }
                            .font(Typo.sans(15)).disabled(work != nil)
                    }
                } else if work == nil {
                    Text("附件已撤回或暂不可用").foregroundStyle(Palette.ink2)
                    Button("重新读取") { work = .load }
                }
                if let error { Text(error).font(Typo.sans(14)).foregroundStyle(Palette.ink2) }
                if let work { ProgressView(progressLabel(work)) }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(20)
        }
        .background(PageBackground().ignoresSafeArea())
        .navigationTitle("附件详情").navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Palette.bg, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbarColorScheme(.light, for: .navigationBar)
        .confirmationDialog("撤回这份附件？", isPresented: $confirmingWithdrawal, titleVisibility: .visible) {
            Button("撤回附件", role: .destructive) { work = .withdraw }
        } message: {
            Text("撤回后，会话里将无法再查看这份附件。")
        }
        .quickLookPreview($original)
        .onChange(of: file?.rev) {
            thumbnail = nil
            original = nil
            generationStatus = nil
            unavailable = false
        }
        .onChange(of: file?.available) {
            if file?.available != true {
                thumbnail = nil
                original = nil
            }
        }
        .onChange(of: original) { previous, current in
            if current == nil, let previous { removeOriginal(previous) }
        }
        .task(id: work) {
            guard let work else { return }
            await perform(work)
            if !Task.isCancelled { self.work = nil }
        }
    }

    private func metadata(_ file: V2.Attachment) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(file.fileName).font(Typo.serif(22, bold: true)).foregroundStyle(Palette.ink)
            Text(ByteCountFormatter.string(fromByteCount: Int64(file.byteSize), countStyle: .file))
                .font(Typo.sans(14)).foregroundStyle(Palette.ink2)
            if let description = file.description { Text(description).font(Typo.sans(15)) }
            if !file.available {
                Text("连接的电脑缺少原件").font(Typo.sans(14)).foregroundStyle(Palette.ink2)
            }
        }
    }

    private func contentActions(_ file: V2.Attachment) -> some View {
        HStack(spacing: 16) {
            if file.supportsThumbnail && thumbnail == nil {
                Button("查看缩略图") { work = .preview }
            }
            Button("打开原件") { work = .original }
        }.font(Typo.sans(15)).disabled(work != nil)
    }

    private func descriptionSection(_ file: V2.Attachment) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle(text: "图片描述")
            if let description {
                Text(description.value.text).font(Typo.sans(15)).textSelection(.enabled)
            } else if !file.available {
                Text("缺少原件，暂时无法生成描述")
            } else if generationStatus == .modelUnavailable {
                Text("电脑上的视觉模型暂不可用")
            } else {
                Text("还未生成描述")
            }
            if canModify(file), file.available, description == nil {
                Button("生成图片描述") { work = .generate }.disabled(work != nil)
            }
        }.font(Typo.sans(14)).foregroundStyle(Palette.ink2)
    }

    private func canModify(_ file: V2.Attachment) -> Bool { file.ownerMemberID == connection.identity.member.id }

    private func progressLabel(_ work: Work) -> String {
        switch work {
        case .load: return "正在读取附件…"
        case .preview: return "正在读取缩略图…"
        case .original: return "正在下载原件…"
        case .generate: return "正在生成描述…"
        case .withdraw: return "正在撤回…"
        }
    }

    private func perform(_ work: Work) async {
        error = nil
        do {
            if work == .load {
                try await changes.synchronize()
                unavailable = false
                return
            }
            guard let current = file, !unavailable else { return }
            let client = try await connection.select()
            try Task.checkCancellation()
            switch work {
            case .load: break
            case .preview:
                guard current.available else { throw V2AttachmentError.server("blob_unavailable") }
                let data = try await client.thumbnail(current.id)
                guard let image = UIImage(data: data) else { throw V2AttachmentError.invalidResponse }
                if file?.rev == current.rev && file?.available == true { thumbnail = image }
            case .original:
                guard current.available else { throw V2AttachmentError.server("blob_unavailable") }
                let url = try await client.original(current)
                if Task.isCancelled || file?.rev != current.rev || file?.available != true {
                    removeOriginal(url)
                    return
                }
                original = url
            case .generate:
                guard canModify(current), current.supportsDescription, current.available else { return }
                generationStatus = try await client.fileDescription(current, generate: true).status
                if let scope { changes.resourceWriteDidCommit(in: scope) }
                try await changes.synchronize()
            case .withdraw:
                guard canModify(current) else { return }
                try await client.withdrawAttachment(current.id)
                if let scope { changes.resourceWriteDidCommit(in: scope) }
                try await changes.synchronize()
                dismiss()
            }
        } catch {
            guard !Task.isCancelled else { return }
            if let failure = error as? V2AttachmentError, failure.sourceUnavailable {
                thumbnail = nil
                original = nil
                generationStatus = nil
                if case .server("not_found") = failure {
                    unavailable = true
                    if let scope { changes.resourceWriteDidCommit(in: scope) }
                }
            }
            self.error = error.localizedDescription
        }
    }

    private func removeOriginal(_ url: URL) {
        try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
    }
}
