import Foundation

public struct PairingCode: Decodable {
    public let code: String
    public let expires_at: String
    public let pair_url: String
    public let ca_fingerprint_short: String
    public var displayCode: String {
        let raw = code.replacingOccurrences(of: "-", with: "")
        guard raw.count == 8 else { return code }
        return "\(raw.prefix(4))-\(raw.suffix(4))"
    }
}
public struct PairedDevice: Decodable, Identifiable {
    public let id: String
    public let name: String?
    public let device_name: String?
    public var displayName: String { name ?? device_name ?? id }
}
public enum PairingError: Error, LocalizedError {
    case unsupported, http(Int)
    public var errorDescription: String? {
        switch self {
        case .unsupported: return "这个版本的服务端还不支持配对"
        case .http(let code): return "配对服务返回错误（\(code)）"
        }
    }
}
public struct PairingClient {
    public let dataDirectory: URL
    public let baseURL: URL
    private let session: URLSession
    public init(dataDirectory: URL, baseURL: URL = URL(string: "http://127.0.0.1:8787")!, session: URLSession = .shared) {
        self.dataDirectory = dataDirectory; self.baseURL = baseURL; self.session = session
    }
    private func request(_ path: String, method: String) async throws -> Data {
        var request = URLRequest(url: baseURL.appendingPathComponent(path)); request.httpMethod = method; request.timeoutInterval = 10
        if let token = try? String(contentsOf: dataDirectory.appendingPathComponent("host-admin.token")) {
            request.setValue("Bearer \(token.trimmingCharacters(in: .whitespacesAndNewlines))", forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await session.data(for: request)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        if code == 404 { throw PairingError.unsupported }
        guard (200..<300).contains(code) else { throw PairingError.http(code) }
        return data
    }
    public func createCode() async throws -> PairingCode {
        try JSONDecoder().decode(PairingCode.self, from: await request("host/pairing-codes", method: "POST"))
    }
    public func devices() async throws -> [PairedDevice] {
        let data = try await request("host/devices", method: "GET")
        struct Envelope: Decodable { let devices: [PairedDevice] }
        if let envelope = try? JSONDecoder().decode(Envelope.self, from: data) { return envelope.devices }
        return try JSONDecoder().decode([PairedDevice].self, from: data)
    }
    public func removeDevice(_ id: String) async throws {
        guard !id.isEmpty, !id.contains("/"), !id.contains("..") else { throw HostError("设备标识无效") }
        _ = try await request("host/devices/\(id)", method: "DELETE")
    }
}
