import CryptoKit
import Foundation

@MainActor
final class V2Outbox {
    struct Entry: Codable, Identifiable, Equatable {
        let id: String
        let conversationID: String
        let text: String
        // Absent on queues from the previous version, which may have posted already.
        var submissionStarted: Bool?
        var receipt: V2.PendingSend?
        var accepted: V2.Sent?
        var rejection: String?

        var displayID: String { accepted?.message.id ?? id }
        var wasRejected: Bool { rejection == "group_send_rejected" }
    }

    private let file: URL
    private(set) var entries: [Entry] = []
    private(set) var storageError: Error?

    init(identity: V2.PairResult, directory: URL? = nil, defaults: UserDefaults = .standard) {
        let root = directory ?? URL.applicationSupportDirectory.appending(path: "v2-chat-outbox", directoryHint: .isDirectory)
        let owner = [identity.household.id, identity.member.id, identity.deviceId]
        let scope = SHA256.hash(data: Data(owner.joined(separator: "\u{0}").utf8)).map { String(format: "%02x", $0) }.joined()
        file = root.appending(path: scope + ".json")
        let legacyKey = "v2.outbox." + identity.deviceId
        do {
            if FileManager.default.fileExists(atPath: file.path) {
                entries = try V2.decoder.decode([Entry].self, from: Data(contentsOf: file))
                defaults.removeObject(forKey: legacyKey)
            } else if let legacy = defaults.data(forKey: legacyKey) {
                try persist(V2.decoder.decode([Entry].self, from: legacy))
                defaults.removeObject(forKey: legacyKey)
            }
        } catch {
            storageError = error
        }
    }

    @discardableResult func enqueue(conversation: String, text: String, replacing id: String? = nil) throws -> Entry {
        let entry = Entry(id: UUID().uuidString, conversationID: conversation, text: text, submissionStarted: false)
        var next = entries
        if let id, let index = next.firstIndex(where: { $0.id == id }) { next[index] = entry }
        else { next.append(entry) }
        try persist(next)
        return entry
    }

    func update(_ entry: Entry) throws {
        guard let index = entries.firstIndex(where: { $0.id == entry.id }), entries[index] != entry else { return }
        var next = entries
        next[index] = entry
        try persist(next)
    }

    func acknowledge(_ id: String) throws {
        try persist(entries.filter { $0.id != id })
    }

    private func persist(_ next: [Entry]) throws {
        if let storageError { throw storageError }
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try V2.encoder.encode(next)
        try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        entries = next
    }
}
