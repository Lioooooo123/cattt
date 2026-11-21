import Foundation

struct V2SSE {
    struct Event: Equatable { let id: String?; let name: String; let data: String }
    private var id: String?
    private var name = "message"
    private var data: [String] = []
    mutating func line(_ raw: String) -> Event? {
        let line = raw.hasSuffix("\r") ? String(raw.dropLast()) : raw
        if line.isEmpty {
            defer { name = "message"; data = [] }
            guard !data.isEmpty else { return nil }
            return Event(id: id, name: name, data: data.joined(separator: "\n"))
        }
        guard !line.hasPrefix(":") else { return nil }
        let pair = line.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        var value = pair.count == 2 ? String(pair[1]) : ""
        if value.hasPrefix(" ") { value.removeFirst() }
        switch pair[0] {
        case "id": if !value.contains("\0") { id = value }
        case "event": name = value
        case "data": data.append(value)
        default: break
        }
        return nil
    }
}

struct V2TurnStream {
    private(set) var text = ""
    private(set) var turnID: String?
    private(set) var triggerMessageID: String?
    private(set) var lastEventID: String?
    private(set) var terminal: String?
    private(set) var errorCode: String?
    mutating func apply(_ event: V2SSE.Event) throws {
        guard terminal == nil else { return }
        struct Payload: Decodable { let text: String?; let turnId: String?; let triggerMessageId: String?; let code: String? }
        let payload = try V2.decoder.decode(Payload.self, from: Data(event.data.utf8))
        switch event.name {
        case "accepted": turnID = payload.turnId; triggerMessageID = payload.triggerMessageId
        case "delta": text += payload.text ?? ""
        case "snapshot": text = payload.text ?? ""
        case "superseded", "done", "error": terminal = event.name; errorCode = payload.code
        default: return
        }
        if let id = event.id { lastEventID = id.isEmpty ? nil : id }
    }
}
