import HostCore
import SwiftUI

struct PeerApprovalView: View {
    let remote: PeerDescriptor
    let model: BunSettingsModel
    @Environment(\.dismiss) private var dismiss
    @State private var host: String
    @State private var port: String
    @State private var verifiedFingerprint = ""
    @State private var error: String?

    init(remote: PeerDescriptor, model: BunSettingsModel) {
        self.remote = remote
        self.model = model
        _host = State(initialValue: remote.address.host)
        _port = State(initialValue: String(remote.address.port))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("核对对方的 Mac").font(.title2.weight(.semibold))
            if let local = model.snapshot {
                fingerprintForm(local)
                Divider()
                actions(local)
            } else {
                Text("本机宿主暂未就绪，请关闭后重试。").foregroundStyle(.secondary)
                Button("关闭") { dismiss() }.keyboardShortcut(.cancelAction)
            }
        }
        .padding(24)
        .frame(width: 570)
        .interactiveDismissDisabled(model.busy)
    }

    private func fingerprintForm(_ local: BunSettingsModel.Snapshot) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            FingerprintLine(label: "对端指纹 · SHA-256", value: remote.fingerprint)
            Text("请让对方在自己的 Mac 上读取指纹，或通过可信渠道发给你，再在这里输入完整指纹。")
                .foregroundStyle(.secondary)
            TextField("已核对的 64 位指纹", text: $verifiedFingerprint, axis: .vertical)
                .textFieldStyle(.roundedBorder).lineLimit(1...2)
                .font(.system(.callout, design: .monospaced))
            if !verifiedFingerprint.isEmpty && !remote.matchesVerifiedFingerprint(verifiedFingerprint) {
                Text("输入的完整指纹与描述符不符。").font(.callout).foregroundStyle(.red)
            }
            HStack {
                TextField("同步地址", text: $host).textFieldStyle(.roundedBorder)
                TextField("端口", text: $port).textFieldStyle(.roundedBorder)
                    .frame(width: 90)
            }
            DisclosureGroup("本机指纹与家庭归属") {
                VStack(alignment: .leading, spacing: 7) {
                    FingerprintLine(label: "本机指纹 · SHA-256", value: local.identity.descriptor.fingerprint)
                    Text("本机家庭 \(local.family.household.id)")
                    Text("对端家庭 \(remote.householdID)")
                    Button("复制本机指纹") { copyText(local.identity.descriptor.fingerprint) }
                }
                .font(.caption)
                .padding(.vertical, 6)
            }
            if let message = error {
                Label(message, systemImage: "exclamationmark.circle").foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .disabled(model.busy)
    }

    @ViewBuilder
    private func actions(_ local: BunSettingsModel.Snapshot) -> some View {
        let sameFamily = remote.householdID == local.family.household.id
        let canJoin = local.family.members.isEmpty && local.family.isCreator
        if sameFamily {
            Text("请让对方先批准本机指纹，再连接。也可先批准对方的指纹，等待对方连接。")
                .foregroundStyle(.secondary)
        } else {
            Text("已有家庭的 Mac 先批准。空白 Mac 随后连接并加入对方家庭，保留自己的宿主身份。")
                .foregroundStyle(.secondary)
            if !local.family.isCreator {
                Text("本机已加入家庭。请向对方索取当前家庭的描述符。")
                    .foregroundStyle(.secondary)
            }
        }
        HStack {
            Button("取消") { dismiss() }.keyboardShortcut(.cancelAction).disabled(model.busy)
            Spacer()
            if model.busy { ProgressView().controlSize(.small) }
            Group {
                if sameFamily || local.family.isCreator {
                    Button(sameFamily ? "批准指纹" : "批准对方加入") { submit(sameFamily ? .approve : .allowJoin) }
                }
                if sameFamily || canJoin {
                    Button(sameFamily ? "连接" : "连接并加入对方家庭") { submit(sameFamily ? .connect : .join) }
                        .buttonStyle(.borderedProminent)
                }
            }
            .disabled(!model.ready || model.busy || !remote.matchesVerifiedFingerprint(verifiedFingerprint))
        }
    }

    private func submit(_ action: PeerPairingAction) {
        error = nil
        Task {
            do {
                guard let port = UInt16(port) else { throw BunAdminError.invalidAddress }
                let target = try remote.atAddress(host: host, port: port)
                _ = try await model.perform {
                    try await model.client.pair(target, verifiedFingerprint: verifiedFingerprint, action: action)
                }
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
