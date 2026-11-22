import SwiftUI

struct PairingView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var code = ""
    @State private var manualInvitation: PairInvitation?
    @State private var probing = false
    @State private var error: String?
    @State private var displayName = ""
    @State private var confirmsSwitch = false
    @State private var switchInvitation: PairInvitation?

    private var invitation: PairInvitation? { store.pairInvitation ?? manualInvitation }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    Text(invitation?.kind == .family ? "加入团子的家" : "连接家里的电脑")
                        .font(Typo.serif(24, bold: true)).foregroundStyle(Palette.ink)
                    if let invitation {
                        Text(invitation.hosts.joined(separator: "、")).font(Typo.sans(14)).foregroundStyle(Palette.ink2)
                        Text("电脑指纹").font(Typo.sans(14, weight: .medium))
                        Text(PairFingerprint.short(invitation.fingerprint))
                            .font(.system(.title3, design: .monospaced)).textSelection(.enabled)
                        Text(invitation.kind == .family
                             ? "请向邀请人核对电脑指纹。确认一致后，才会发送邀请凭证。"
                             : "请核对电脑上显示的指纹。确认一致后，才会发送配对码。")
                            .font(Typo.sans(14)).foregroundStyle(Palette.ink2)
                        Text("设备名称：\(UIDevice.current.name)").font(Typo.sans(13)).foregroundStyle(Palette.ink3)
                        if invitation.kind == .family {
                            familyConfirmation(invitation)
                        } else {
                            PrimaryButton(enabled: !store.pairingBusy) {
                                Task { await store.pairWithHost(invitation) }
                            } label: { Text(store.pairingBusy ? "正在连接…" : "指纹一致，连接") }
                        }
                        if store.pairInvitation == nil {
                            TextLink(text: "重新输入") { manualInvitation = nil; error = nil; store.pairingError = nil }
                        }
                    } else {
                        Text("与电脑连接同一个局域网。可用相机扫描电脑上的二维码，或在这里填写地址与配对码。").font(Typo.sans(14)).foregroundStyle(Palette.ink2)
                        VStack(alignment: .leading, spacing: 12) {
                            TextField("电脑地址，如 192.168.1.8:8788", text: $address)
                                .textContentType(.URL).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                                .accessibilityIdentifier("pairingAddress")
                            Divider()
                            TextField("八位配对码", text: $code)
                                .textInputAutocapitalization(.characters).autocorrectionDisabled()
                                .accessibilityIdentifier("pairingCode")
                        }.padding(16).background(Palette.card, in: RoundedRectangle(cornerRadius: Metrics.radiusControl))
                        PrimaryButton(enabled: !probing) { probe() } label: { Text(probing ? "正在读取电脑指纹…" : "查看电脑指纹") }
                        Text("收到家庭邀请后，可以复制链接并在这里粘贴。").font(Typo.sans(14)).foregroundStyle(Palette.ink2)
                        PasteButton(payloadType: String.self) { values in
                            manualInvitation = nil
                            error = nil
                            let url = values.first.flatMap { URL(string: $0.trimmingCharacters(in: .whitespacesAndNewlines)) }
                            if let url {
                                store.openPairing(url)
                            } else {
                                store.pairingError = PairingError.invalidLink.localizedDescription
                            }
                        }
                        .disabled(probing || store.pairingBusy)
                        .accessibilityLabel("粘贴配对或邀请链接")
                    }
                    if let message = error ?? store.pairingError {
                        Text(message).font(Typo.sans(14)).foregroundStyle(Palette.ink2).accessibilityIdentifier("pairingError")
                    }
                }.padding(24)
            }
            .background(Palette.bg)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(store.pairingBusy) } }
            .interactiveDismissDisabled(store.pairingBusy)
            .onChange(of: store.pairInvitation) {
                displayName = ""
                confirmsSwitch = false
                manualInvitation = nil
                error = nil
            }
            .alert("切换这部手机的配对？", isPresented: $confirmsSwitch, presenting: switchInvitation) { invitation in
                Button("取消", role: .cancel) {}
                Button("切换并加入") {
                    Task { await store.joinFamily(invitation, displayName: displayName, confirmedSwitch: true) }
                }
            } message: { _ in
                Text("加入成功后，这部手机会切换到新成员。原有本机记录和待提交草稿仍保留在原成员下。")
            }
        }
    }
    private func familyConfirmation(_ invitation: PairInvitation) -> some View {
        let redeemed = store.pendingFamilyJoin?.invitation == invitation
        return VStack(alignment: .leading, spacing: 12) {
            if !redeemed {
                TextField("家人看到的名称", text: $displayName)
                    .textContentType(.nickname)
                    .padding(16).background(Palette.card, in: RoundedRectangle(cornerRadius: Metrics.radiusControl))
                    .disabled(store.pairingBusy)
                    .accessibilityIdentifier("familyInviteDisplayName")
            }
            if let member = store.v2Chat?.connection.identity.member {
                Text("这部手机当前以「\(member.displayName)」连接。")
                    .font(Typo.sans(14)).foregroundStyle(Palette.ink2)
            }
            PrimaryButton(enabled: !store.pairingBusy && (redeemed || V2FamilyJoin.name(displayName) != nil)) {
                if store.hasActivePairing {
                    switchInvitation = invitation
                    confirmsSwitch = true
                } else {
                    Task { await store.joinFamily(invitation, displayName: displayName, confirmedSwitch: false) }
                }
            } label: {
                Text(store.pairingBusy ? "正在加入…" : (redeemed ? "重试加入" : "指纹一致，加入"))
            }
            .accessibilityIdentifier("familyInviteJoin")
        }
    }

    private func probe() {
        guard let target = PairInvitation.address(address), let normalized = PairInvitation.normalizedCode(code) else {
            error = PairingError.invalidAddress.localizedDescription; return
        }
        error = nil; store.pairingError = nil; probing = true
        Task { @MainActor in
            defer { probing = false }
            do {
                let fingerprint = try await PairTransport.probe(host: target.host, port: target.port)
                manualInvitation = PairInvitation(hosts: [target.host], port: target.port, code: normalized, fingerprint: fingerprint)
            } catch { self.error = error.localizedDescription }
        }
    }
}
