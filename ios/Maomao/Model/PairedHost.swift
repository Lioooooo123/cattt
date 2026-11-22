import Foundation
import CryptoKit

struct PairedHost: Codable, Equatable {
    let hosts: [String]
    let port: Int
    let fingerprint: String
    let deviceID: String
    let deviceToken: String
    let accountID: String

    var storageIdentity: String { "paired:\(fingerprint)\n\(deviceID)" }
    func url(host: String) -> URL {
        var parts = URLComponents()
        parts.scheme = "https"; parts.host = host; parts.port = port
        return parts.url!
    }
}

enum PairFingerprint {
    static func valid(_ value: String) -> Bool {
        value.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
    static func digest(_ der: Data) -> String { SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined() }
    static func matches(_ der: Data, pin: String) -> Bool { valid(pin) && digest(der) == pin }
    static func short(_ value: String) -> String {
        guard valid(value) else { return "" }
        let chars = Array(value.prefix(16))
        return stride(from: 0, to: 16, by: 4).map { String(chars[$0..<$0 + 4]) }.joined(separator: " ")
    }
}

struct PairInvitation: Equatable {
    enum Kind: String { case device = "pair", family = "invite" }
    var version: Int = 1
    var kind: Kind = .device
    let hosts: [String]
    let port: Int
    let code: String
    let fingerprint: String

    static func normalizedCode(_ raw: String) -> String? {
        let code = raw.replacingOccurrences(of: "-", with: "").uppercased()
        let alphabet = Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
        return code.count == 8 && code.allSatisfy { alphabet.contains($0) } ? code : nil
    }
    static func validHost(_ host: String) -> Bool {
        !host.isEmpty && host.count <= 253 && host.utf8.allSatisfy {
            (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 46
        } && !host.hasPrefix(".") && !host.hasSuffix(".")
    }
    static func parse(_ url: URL, versions: [Int] = [1]) -> PairInvitation? {
        guard url.scheme == "maomao", let kind = url.host.flatMap(Kind.init(rawValue:)), url.path.isEmpty,
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false), let items = parts.queryItems,
              parts.user == nil, parts.password == nil, parts.port == nil, parts.fragment == nil,
              Set(items.map(\.name)).count == items.count else { return nil }
        let query = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
        guard let version = query["v"].flatMap(Int.init), versions.contains(version), let rawHosts = query["h"], let rawPort = query["p"],
              let port = Int(rawPort), (1...65535).contains(port),
              let rawCode = query["c"], let code = normalizedCode(rawCode),
              let fingerprint = query["fp"], PairFingerprint.valid(fingerprint) else { return nil }
        if kind == .family, version != 2 || query.count != 5 { return nil }
        let hosts = rawHosts.components(separatedBy: ",")
        guard !hosts.isEmpty, hosts.count <= 32, hosts.allSatisfy(validHost) else { return nil }
        return PairInvitation(version: version, kind: kind, hosts: hosts, port: port, code: code, fingerprint: fingerprint)
    }
    static func address(_ raw: String) -> (host: String, port: Int)? {
        let parts = raw.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: ":")
        guard (1...2).contains(parts.count), validHost(parts[0]) else { return nil }
        let port = parts.count == 2 ? Int(parts[1]) : 8788
        guard let port, (1...65535).contains(port) else { return nil }
        return (parts[0], port)
    }
}
