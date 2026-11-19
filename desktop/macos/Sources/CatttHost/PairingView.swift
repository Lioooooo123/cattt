import SwiftUI
import CoreImage.CIFilterBuiltins
import HostCore

@MainActor final class PairingModel: ObservableObject {
    @Published var pairing: PairingCode?
    @Published var devices: [PairedDevice] = []
    @Published var error = ""
    @Published var loading = false
    private let client: PairingClient
    init(dataDirectory: URL) { client = PairingClient(dataDirectory: dataDirectory) }
    func refresh() async {
        guard !loading else { return }; loading = true; error = ""; pairing = nil
        defer { loading = false }
        do { pairing = try await client.createCode(); devices = try await client.devices() }
        catch { self.error = error.localizedDescription }
    }
    func remove(_ id: String) async {
        guard !loading else { return }; loading = true; error = ""
        defer { loading = false }
        do { try await client.removeDevice(id); devices = try await client.devices() }
        catch { self.error = error.localizedDescription }
    }
}

struct PairingView: View {
    @StateObject private var model: PairingModel
    @State private var removing: PairedDevice?
    init(dataDirectory: URL) { _model = StateObject(wrappedValue: PairingModel(dataDirectory: dataDirectory)) }
    private func qr(_ text: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator(); filter.message = Data(text.utf8)
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
              let cg = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return NSImage(cgImage: cg, size: NSSize(width: 200, height: 200))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("配对手机").font(.title2)
                Spacer()
                Button("刷新配对码") { Task { await model.refresh() } }.disabled(model.loading)
            }
            Text("让手机和这台电脑连接同一个局域网，再用手机扫描配对码。").foregroundStyle(.secondary)
            if model.loading { ProgressView().frame(maxWidth: .infinity) }
            if !model.error.isEmpty {
                Label(model.error, systemImage: "info.circle").textSelection(.enabled)
            }
            if let pairing = model.pairing {
                VStack(spacing: 8) {
                    if let image = qr(pairing.pair_url) {
                        Image(nsImage: image).interpolation(.none).resizable().frame(width: 200, height: 200)
                            .padding(12).background(.white).accessibilityLabel("手机配对二维码")
                    }
                    Text(pairing.displayCode).font(.system(.title, design: .monospaced)).textSelection(.enabled)
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let date = ISO8601DateFormatter().date(from: pairing.expires_at)
                            ?? ISO8601DateFormatter.fractional.date(from: pairing.expires_at)
                        if let date {
                            Text(date <= context.date ? "配对码已过期，请刷新" : "有效期至 \(date.formatted(date: .omitted, time: .standard))")
                        } else { Text("有效期至 \(pairing.expires_at)") }
                    }.font(.caption).foregroundStyle(.secondary)
                    Text("证书指纹：\(pairing.ca_fingerprint_short)").font(.caption).textSelection(.enabled)
                }.frame(maxWidth: .infinity)
            }
            Divider()
            Text("已配对的设备").font(.headline)
            if model.devices.isEmpty { Text("暂无已配对设备").foregroundStyle(.secondary) }
            ScrollView {
                VStack(spacing: 12) {
                    ForEach(model.devices) { device in
                        HStack {
                            Label(device.displayName, systemImage: "iphone"); Spacer()
                            Button("移除", role: .destructive) { removing = device }.disabled(model.loading)
                        }
                    }
                }
            }.frame(maxHeight: 120)
        }.padding(24).frame(width: 460, alignment: .topLeading)
            .task { await model.refresh() }
            .confirmationDialog("移除这个设备？", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })) {
                Button("移除设备", role: .destructive) {
                    if let device = removing { Task { await model.remove(device.id) } }; removing = nil
                }
            } message: { Text("移除后，这台手机需要重新配对。") }
    }
}

private extension ISO8601DateFormatter {
    static var fractional: ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return formatter
    }
}
