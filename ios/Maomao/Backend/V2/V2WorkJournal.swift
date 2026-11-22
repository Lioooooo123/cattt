import Foundation

@MainActor
final class V2WorkJournal {
    struct TicketEntry: Codable, Identifiable, Equatable {
        let id: String
        let action: V2.TicketAction
        var acknowledged = false
    }

    struct RelayEntry: Codable, Identifiable, Equatable {
        enum Intent: String, Codable { case send, withdraw, withdrawn }

        let source: V2.WorkSource
        var intent = Intent.send
        var receipt: V2.RelayReceipt?
        var rejection: String?

        var id: String { source.messageID }
        var label: String {
            switch intent {
            case .withdrawn: return "已撤回转告授权"
            case .withdraw: return "撤回未确认"
            case .send:
                if let rejection { return V2WorkStore.errorText(V2.APIError(code: rejection)) }
                return receipt?.state.label ?? "转告未确认"
            }
        }
    }

    private struct Contents: Codable {
        var tickets: [TicketEntry] = []
        var relays: [String: RelayEntry] = [:]
    }

    private let file: URL
    private var contents = Contents()
    private(set) var storageError: Error?

    init(scope: V2SyncScope, directory: URL = URL.applicationSupportDirectory.appending(path: "V2HouseholdWork")) {
        let key = [scope.householdID, scope.homeHostID, scope.memberID].joined(separator: "\u{0}")
        file = directory.appending(path: PairFingerprint.digest(Data(key.utf8)) + ".json")
        do {
            if FileManager.default.fileExists(atPath: file.path) {
                contents = try V2.decoder.decode(Contents.self, from: Data(contentsOf: file))
            }
        } catch { storageError = error }
    }

    var pendingTickets: [TicketEntry] { contents.tickets.filter { !$0.acknowledged } }
    var relays: [String: RelayEntry] { contents.relays }

    func prepare(_ action: V2.TicketAction) throws -> TicketEntry {
        if let existing = contents.tickets.first(where: { $0.action == action }) { return existing }
        let entry = TicketEntry(id: UUID().uuidString, action: action)
        var next = contents
        next.tickets.append(entry)
        try persist(next)
        return entry
    }

    func acknowledge(_ entry: TicketEntry) throws {
        var next = contents
        guard let index = next.tickets.firstIndex(where: { $0.id == entry.id }) else { return }
        if entry.action.createsTicket { next.tickets[index].acknowledged = true }
        else { next.tickets.remove(at: index) }
        try persist(next)
    }

    func remove(_ entry: TicketEntry) throws {
        var next = contents
        next.tickets.removeAll { $0.id == entry.id }
        try persist(next)
    }

    func save(_ entry: RelayEntry) throws {
        var next = contents
        next.relays[entry.id] = entry
        try persist(next)
    }

    private func persist(_ next: Contents) throws {
        if let storageError { throw storageError }
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try V2.encoder.encode(next).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        contents = next
    }
}
