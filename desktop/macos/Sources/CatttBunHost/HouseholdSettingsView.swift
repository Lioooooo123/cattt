import AppKit
import CoreImage.CIFilterBuiltins
import HostCore
import SwiftUI

struct HouseholdSettingsView: View {
    let model: BunSettingsModel
    let snapshot: BunSettingsModel.Snapshot
    @State private var name = ""
    @State private var share: PhoneShare?
    @State private var revoking: BunOpenInvite?
    @State private var error: String?

    var body: some View {
        Form {
            if let message = error ?? model.loadError {
                Section {
                    Label(message, systemImage: "exclamationmark.circle")
                        .foregroundStyle(.red).textSelection(.enabled)
                }
            }
            memberSection
            invitationSection
        }
        .formStyle(.grouped)
        .sheet(item: $share) { share in PhoneShareView(payload: share) }
        .confirmationDialog("撤销成员邀请？", isPresented: Binding(
            get: { revoking != nil }, set: { if !$0 { revoking = nil } }
        ), presenting: revoking) { invitation in
            Button("撤销邀请", role: .destructive) {
                run { try await model.client.revokeInvite(id: invitation.id) }
            }
        } message: { _ in
            Text("撤销后，原邀请链接失效，可重新生成邀请。")
        }
    }

    private var memberSection: some View {
        Section(snapshot.family.household.name) {
            ForEach(snapshot.family.members) { member in
                LabeledContent(member.displayName) {
                    if member.homeHostID == snapshot.family.hostID {
                        Button("生成手机配对码…") {
                            run {
                                let code = try await model.client.phoneCode(memberID: member.id)
                                share = PhoneShare(title: "为 \(member.displayName) 配对手机", code: code.code,
                                    link: code.url, expiresAt: code.expiresAt, caFingerprint: code.caFingerprint)
                            }
                        }
                        .disabled(actionsDisabled)
                    } else {
                        Text("在成员所属的 Mac 上配对").foregroundStyle(.secondary)
                    }
                }
            }
            if snapshot.family.isCreator && snapshot.family.members.isEmpty {
                Text("这台 Mac 要加入对方的家庭时，请先完成 Mac 结对。创建新家庭时，在这里建立首位成员。")
                    .foregroundStyle(.secondary)
                nameForm("建立首位成员") { name in
                    _ = try await model.client.createFirstMember(name: name)
                }
            } else if snapshot.waitingForFamily {
                Text("正在等待首位成员和群聊同步到这台 Mac。").foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var invitationSection: some View {
        let family = snapshot.family
        if !family.isCreator || !snapshot.invites.isEmpty {
            Section("成员邀请") {
                ForEach(snapshot.invites) { invite in
                    LabeledContent {
                        Button("撤销…", role: .destructive) { revoking = invite }.disabled(actionsDisabled)
                    } label: {
                        Text(invite.displayName ?? "待接受的邀请")
                        Text("有效期至 \(displayTime(invite.expiresAt))")
                    }
                }
                if !snapshot.waitingForFamily && !family.isCreator && family.localMembers.isEmpty &&
                    family.members.count + snapshot.invites.count < family.maxMembers {
                    Text("在这台 Mac 上邀请成员，接受后可以在这里为该成员生成手机配对码。")
                        .foregroundStyle(.secondary)
                    nameForm("生成邀请链接…") { name in
                        let invite = try await model.client.invite(name: name)
                        share = PhoneShare(title: "邀请 \(name) 加入家庭", code: invite.code, link: invite.url,
                                           expiresAt: invite.expiresAt, caFingerprint: nil)
                    }
                }
                if !snapshot.invites.isEmpty {
                    Text("邀请链接只在生成时显示。若链接已遗失，可撤销未接受的邀请后重新生成。")
                        .font(.callout).foregroundStyle(.secondary)
                }
            }
        }
    }

    private var actionsDisabled: Bool { model.busy || model.loadError != nil }
    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func nameForm(_ label: String, operation: @escaping (String) async throws -> Void) -> some View {
        HStack {
            TextField("成员昵称", text: $name).textFieldStyle(.roundedBorder)
            Button(label) {
                let requestedName = trimmedName
                run { try await operation(requestedName); name = "" }
            }
            .disabled(trimmedName.isEmpty || trimmedName.utf16.count > 100)
        }
        .disabled(actionsDisabled)
    }

    private func run(_ work: @escaping () async throws -> Void) {
        error = nil
        Task {
            do { try await model.perform(work) }
            catch { self.error = error.localizedDescription }
        }
    }
}

private struct PhoneShare: Identifiable {
    let id = UUID()
    let title: String
    let code: String
    let link: URL
    let expiresAt: Int64
    let caFingerprint: String?
}

private struct PhoneShareView: View {
    let payload: PhoneShare
    @Environment(\.dismiss) private var dismiss
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(payload.title).font(.title2.weight(.semibold))
            TimelineView(.periodic(from: .now, by: 1)) { time in
                let expired = time.date.timeIntervalSince1970 * 1_000 >= Double(payload.expiresAt)
                VStack(alignment: .leading, spacing: 12) {
                    if expired {
                        Label("已过期，请关闭后重新生成。", systemImage: "clock")
                            .foregroundStyle(.secondary)
                    } else {
                        shareContent
                    }
                }
            }
            Divider()
            HStack {
                Spacer()
                Button("完成") { dismiss() }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(width: 545)
    }

    @ViewBuilder
    private var shareContent: some View {
        if let fingerprint = payload.caFingerprint {
            Text("让 iPhone 和这台 Mac 连接同一局域网，用相机扫描二维码。配对码只能使用一次。")
                .foregroundStyle(.secondary)
            if let image = qrImage(payload.link) {
                Image(nsImage: image).interpolation(.none).resizable()
                    .frame(width: 192, height: 192).padding(16).background(.white)
                    .accessibilityLabel("手机配对二维码")
                    .frame(maxWidth: .infinity)
            }
            FingerprintLine(label: "手机 HTTPS 证书机构指纹", value: fingerprint)
        } else {
            Text("请将链接发给受邀成员。接受邀请需要支持 v2 成员邀请的客户端。")
                .foregroundStyle(.secondary)
        }
        LabeledContent("一次性短码") {
            Text(payload.code).font(.system(.title3, design: .monospaced))
                .textSelection(.enabled)
        }
        LabeledContent("有效期", value: displayTime(payload.expiresAt))
        Button(copied ? "已复制链接" : "复制链接") {
            copyText(payload.link.absoluteString)
            copied = true
        }
    }

    private static let imageContext = CIContext()

    private func qrImage(_ link: URL) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(link.absoluteString.utf8)
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 6, y: 6)),
              let image = Self.imageContext.createCGImage(output, from: output.extent) else { return nil }
        return NSImage(cgImage: image, size: NSSize(width: 192, height: 192))
    }
}
