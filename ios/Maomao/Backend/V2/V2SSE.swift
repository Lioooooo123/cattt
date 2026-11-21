import Foundation

struct V2SSE {
    struct Lines {
        private var bytes: [UInt8] = []
        private var afterCR = false
        mutating func append(_ byte: UInt8) -> String? {
            if byte == 10 && afterCR { afterCR = false; return nil }
            afterCR = byte == 13
            if byte == 10 || byte == 13 {
                defer { bytes.removeAll(keepingCapacity: true) }
                return String(decoding: bytes, as: UTF8.self)
            }
            bytes.append(byte)
            return nil
        }
    }
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
    private(set) var retryable: Bool?
    private(set) var replyMessageID: String?
    private(set) var status: V2.Turn.Status?
    private(set) var byTurnID: String?
    mutating func apply(_ event: V2SSE.Event) throws {
        guard terminal == nil else { return }
        struct Accepted: Decodable {
            let turnId: String; let triggerMessageId: String
            enum CodingKeys: String, CodingKey { case turnId = "turn_id", triggerMessageId = "trigger_message_id" }
        }
        struct TextPayload: Decodable { let text: String }
        struct Superseded: Decodable {
            let turnId: String; let byTurnId: String
            enum CodingKeys: String, CodingKey { case turnId = "turn_id", byTurnId = "by_turn_id" }
        }
        struct Done: Decodable {
            let messageId: String?; let status: V2.Turn.Status
            enum CodingKeys: String, CodingKey { case messageId = "message_id", status }
        }
        struct Failure: Decodable { let code: String; let retryable: Bool }
        let data = Data(event.data.utf8)
        switch event.name {
        case "accepted":
            let payload = try V2.decoder.decode(Accepted.self, from: data)
            turnID = payload.turnId; triggerMessageID = payload.triggerMessageId; status = .generating
        case "delta": text += try V2.decoder.decode(TextPayload.self, from: data).text
        case "snapshot": text = try V2.decoder.decode(TextPayload.self, from: data).text
        case "superseded":
            let payload = try V2.decoder.decode(Superseded.self, from: data)
            turnID = payload.turnId; byTurnID = payload.byTurnId; status = .superseded; terminal = event.name
        case "done":
            let payload = try V2.decoder.decode(Done.self, from: data)
            replyMessageID = payload.messageId; status = payload.status; terminal = event.name
        case "error":
            let payload = try V2.decoder.decode(Failure.self, from: data)
            errorCode = payload.code; retryable = payload.retryable; status = .failed; terminal = event.name
        default: return
        }
        if let id = event.id { lastEventID = id.isEmpty ? nil : id }
    }
}
