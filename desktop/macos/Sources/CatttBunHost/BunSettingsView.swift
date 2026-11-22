import AppKit
import HostCore
import SwiftUI
import UniformTypeIdentifiers

struct BunSettingsView: View {
    let model: BunSettingsModel
    @State private var tab: Tab = .mac
    @State private var importing = false
    @State private var exporting = false
    @State private var document: DescriptorDocument?
    @State private var review: ImportedIdentity?
    @State private var revoking: Revocation?
    @State private var actionError: String?
    @State private var copied: String?

    private enum Tab { case mac, household }

    var body: some View {
        VStack(spacing: 0) {
            statusBar
            Divider()
            if let snapshot = model.snapshot {
                TabView(selection: $tab) {
                    Form { macSettings(snapshot) }
                        .formStyle(.grouped)
                        .tabItem { Label("Mac 同步", systemImage: "desktopcomputer") }
                        .tag(Tab.mac)
                    HouseholdSettingsView(model: model, snapshot: snapshot)
                        .tabItem { Label("家庭与手机", systemImage: "iphone") }
                        .tag(Tab.household)
                }
                .padding(.horizontal, 12)
                .padding(.top, 10)
            } else if model.ready && model.loadError == nil {
                ProgressView("正在读取共享设置…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ContentUnavailableView("共享设置暂时不可用", systemImage: "desktopcomputer",
                    description: Text(model.loadError ?? "请从菜单栏启动服务，等待宿主就绪。故障详情在开发数据目录的 logs/bun.log。"))
            }
        }
        .frame(minWidth: 620, minHeight: 480)
        .task(id: model.hostState) { await model.poll() }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { result in
            do {
                let url = try result.get()
                let access = url.startAccessingSecurityScopedResource()
                defer { if access { url.stopAccessingSecurityScopedResource() } }
                let file = try FileHandle(forReadingFrom: url)
                defer { try? file.close() }
                try importDescriptor(file.read(upToCount: PeerDescriptor.maxImportBytes + 1) ?? Data())
            } catch { actionError = error.localizedDescription }
        }
        .fileExporter(isPresented: $exporting, document: document, contentType: .json,
                      defaultFilename: "团子-Mac-结对描述符.json") { result in
            if case .failure(let error) = result { actionError = error.localizedDescription }
        }
        .sheet(item: $review) { imported in
            PeerApprovalView(remote: imported.descriptor, model: model)
        }
        .confirmationDialog("撤销这台 Mac 的信任？", isPresented: Binding(
            get: { revoking != nil }, set: { if !$0 { revoking = nil } }
        ), presenting: revoking) { revocation in
            Button("撤销信任", role: .destructive) {
                run { try await model.client.revokePeer(hostID: revocation.id) }
            }
        } message: { revocation in
            Text("这台 Mac 将停止与 \(revocation.address) 同步，已收到的数据和水位会保留。恢复同步需要双方重新批准并连接。")
        }
    }

    private var statusBar: some View {
        HStack(spacing: 10) {
            Image(systemName: model.ready ? "checkmark.circle.fill" : "circle.dotted")
                .foregroundStyle(model.ready ? Color.green : Color.secondary)
                .accessibilityHidden(true)
            Text(model.hostState.message).font(.callout)
            if model.busy { ProgressView().controlSize(.small).accessibilityLabel("正在更新设置") }
            Spacer()
            Button("打开开发数据目录") { NSWorkspace.shared.open(model.directory) }
                .controlSize(.small)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 11)
    }

    @ViewBuilder
    private func macSettings(_ snapshot: BunSettingsModel.Snapshot) -> some View {
        let local = snapshot.identity.descriptor
        Section("这台 Mac") {
            LabeledContent("家庭", value: snapshot.family.household.name)
            LabeledContent("同步地址", value: "\(local.address.host):\(local.address.port)")
                .textSelection(.enabled)
            FingerprintLine(label: "本机指纹", value: local.fingerprint)
            if let expiry = snapshot.identity.expiresAt {
                LabeledContent("证书有效期", value: expiry.formatted(date: .abbreviated, time: .shortened))
            }
            Text("交换描述符后，通过当面或电话等可信途径核对双方的完整指纹。")
                .foregroundStyle(.secondary)
            HStack {
                Button("导出描述符…") {
                    do {
                        document = DescriptorDocument(data: try local.exportJSON())
                        exporting = true
                    } catch { actionError = error.localizedDescription }
                }
                Button("复制描述符") {
                    do {
                        copyText(String(decoding: try local.exportJSON(), as: UTF8.self))
                        copied = "已复制描述符"
                    } catch { actionError = error.localizedDescription }
                }
                Button("复制本机指纹") {
                    copyText(local.fingerprint)
                    copied = "已复制本机指纹"
                }
                if let copied { Text(copied).font(.caption).foregroundStyle(.secondary) }
            }
            .disabled(model.loadError != nil || model.busy)
        }
        Section("其他 Mac") {
            HStack {
                Button("导入文件…") { importing = true }
                Button("从剪贴板导入…") {
                    do {
                        let value = NSPasteboard.general.string(forType: .string) ?? ""
                        try importDescriptor(Data(value.utf8))
                    } catch { actionError = error.localizedDescription }
                }
            }
            .disabled(model.loadError != nil || model.busy)
            if let message = actionError ?? model.loadError {
                Label(message, systemImage: "exclamationmark.circle")
                    .foregroundStyle(.red).textSelection(.enabled)
            }
            if snapshot.peers.isEmpty {
                Text("首次结对时，在已有家庭的 Mac 上批准，再到空白 Mac 上连接并加入。")
                    .foregroundStyle(.secondary)
            }
            ForEach(snapshot.peers) { peer in
                peerRow(peer)
            }
        }
    }

    private func peerRow(_ peer: BunPeer) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .firstTextBaseline) {
                Text("\(peer.address.host):\(peer.address.port)").font(.headline)
                Spacer()
                Text(peer.sync.status.title).foregroundStyle(.secondary)
            }
            if let advice = peer.sync.status.recovery {
                Text(advice).font(.callout).foregroundStyle(.secondary)
            }
            if let cursor = peer.sync.cursor {
                LabeledContent("已提交水位", value: "序号 \(cursor.sequence)")
                Text("世代 \(cursor.generation)")
                    .font(.system(.caption, design: .monospaced)).textSelection(.enabled)
            } else {
                Text("尚无已提交水位").font(.callout).foregroundStyle(.secondary)
            }
            if let latest = peer.sync.lastSuccessAt {
                Text("本次运行最后同步 \(displayTime(latest))").font(.caption).foregroundStyle(.secondary)
            } else if let attempted = peer.sync.lastAttemptAt {
                Text("最近尝试 \(displayTime(attempted))").font(.caption).foregroundStyle(.secondary)
            }
            DisclosureGroup("结对详情") {
                VStack(alignment: .leading, spacing: 8) {
                    Text(peer.id).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    FingerprintLine(label: "对端指纹", value: peer.fingerprint)
                    if peer.access == "read_only" { Text("协议兼容模式 · 只读") }
                }
                .padding(.vertical, 6)
            }
            if peer.status != .revoked {
                HStack {
                    if peer.status == .paired {
                        Button(peer.sync.paused ? "恢复本机拉取" : "暂停本机拉取") {
                            run { _ = try await model.client.setPaused(!peer.sync.paused, hostID: peer.id) }
                        }
                        if peer.sync.paused {
                            Text("对方仍可从这台 Mac 拉取。").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    Button("撤销信任…", role: .destructive) {
                        revoking = Revocation(id: peer.id, address: peer.address.host)
                    }
                }
                .disabled(model.loadError != nil || model.busy)
            }
        }
        .padding(.vertical, 4)
    }

    private func importDescriptor(_ data: Data) throws {
        let descriptor = try PeerDescriptor.importJSON(data)
        guard let local = model.snapshot?.identity.descriptor else { throw BunAdminError.unavailable }
        guard descriptor.hostID != local.hostID, descriptor.fingerprint != local.fingerprint else {
            throw HostError("这是本机的描述符，请导入另一台 Mac 导出的文件。")
        }
        actionError = nil
        review = ImportedIdentity(descriptor: descriptor)
    }

    private func run(_ work: @escaping () async throws -> Void) {
        actionError = nil
        Task {
            do { try await model.perform(work) }
            catch { actionError = error.localizedDescription }
        }
    }

    private struct ImportedIdentity: Identifiable {
        let descriptor: PeerDescriptor
        var id: String { descriptor.hostID }
    }

    private struct Revocation {
        let id: String
        let address: String
    }
}

private struct DescriptorDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    let data: Data

    init(data: Data) { self.data = data }

    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents else { throw BunAdminError.invalidDescriptor }
        self.data = data
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}

struct FingerprintLine: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.callout)
            Text(value).font(.system(.callout, design: .monospaced))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

func copyText(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
}

func displayTime(_ milliseconds: Int64) -> String {
    Date(timeIntervalSince1970: Double(milliseconds) / 1_000)
        .formatted(date: .abbreviated, time: .shortened)
}
