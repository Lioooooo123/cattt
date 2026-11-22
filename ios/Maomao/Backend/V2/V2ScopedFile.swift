import CryptoKit
import Foundation

struct V2ScopedFile {
    let url: URL

    init(identity: V2.PairResult, folder: String, directory: URL?) {
        let root = directory ?? URL.applicationSupportDirectory.appending(path: folder, directoryHint: .isDirectory)
        let owner = [identity.household.id, identity.member.id, identity.deviceId]
        let scope = SHA256.hash(data: Data(owner.joined(separator: "\u{0}").utf8))
            .map { String(format: "%02x", $0) }.joined()
        url = root.appending(path: scope + ".json")
    }

    func load<Value: Decodable>(_ type: Value.Type) throws -> Value? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try V2.decoder.decode(type, from: Data(contentsOf: url))
    }

    func save<Value: Encodable>(_ value: Value) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try V2.encoder.encode(value).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
