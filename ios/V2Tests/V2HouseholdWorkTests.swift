import Foundation
import XCTest
@testable import Maomao

final class V2HouseholdWorkTests: XCTestCase {
    private let sourceID = "019b9f0f-8d1a-7db4-b59a-3659261090b3"
    private let conversationID = "019b9f0f-8d1a-7db4-b59a-3659261090b4"

    private func message(_ text: String, revision: Int? = nil, author: String = "me",
                         status: String = "complete", id: String? = nil) throws -> V2.Message {
        var data: [String: Any] = [
            "id": id ?? sourceID, "conversation_id": conversationID, "cursor": "host-cursor",
            "author": ["kind": "member", "member_id": author], "text": text,
            "modality": "text", "status": status, "client_message_id": "phone-local-key", "created_at": 1
        ]
        if let revision { data["revision"] = revision }
        return try V2.decoder.decode(V2.Message.self, from: JSONSerialization.data(withJSONObject: data))
    }

    func testOriginalSourceUsesPersistedIdentityAndRevision() throws {
        let original = try message("明天聊考试结果", revision: 4)
        let proof = try XCTUnwrap(original.workSource(memberID: "me", conversationID: conversationID))
        XCTAssertEqual(proof.messageID, sourceID)
        XCTAssertEqual(proof.revision, 4)
        XCTAssertNil(original.workSource(memberID: "partner", conversationID: conversationID))
        XCTAssertNil(original.workSource(memberID: "me", conversationID: "another"))
        XCTAssertNil(try message("草稿", id: "phone-local-key").workSource(memberID: "me", conversationID: conversationID))
        XCTAssertNil(try message("没发完", status: "stopped").workSource(memberID: "me", conversationID: conversationID))
        XCTAssertNil(try message("无效修订", revision: 0).workSource(memberID: "me", conversationID: conversationID))
        XCTAssertEqual(try message("R6.10 的不可编辑原话").workSource(memberID: "me", conversationID: conversationID)?.revision, 1)
    }

    func testRelayMenuRequiresExplicitOwnDirectOriginal() throws {
        let regular = try message("帮我转告：一起吃饭")
        let urgent = try message(" 帮我紧急转告: 改走北门 ")
        XCTAssertTrue(regular.canOfferRelay(memberID: "me", conversationID: conversationID, kind: .direct))
        XCTAssertTrue(urgent.canOfferRelay(memberID: "me", conversationID: conversationID, kind: .direct))
        XCTAssertFalse(urgent.canOfferRelay(memberID: "me", conversationID: conversationID, kind: .group))
        XCTAssertFalse(urgent.canOfferRelay(memberID: "partner", conversationID: conversationID, kind: .direct))
        for text in ["要不要转告：吃饭", "帮我转告： ", "帮我转告：第一句\n第二句", "帮我转告：请别告诉她"] {
            XCTAssertFalse(try message(text).canOfferRelay(memberID: "me", conversationID: conversationID, kind: .direct), text)
        }
    }

    @MainActor func testTicketJournalKeepsExactBodyAndKeyAcrossRestart() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let scope = V2SyncScope(householdID: "h", homeHostID: "mac", memberID: "me")
        let action = V2.TicketAction.append(ticketID: sourceID, text: "补上原来的地址")
        let first = try V2WorkJournal(scope: scope, directory: root).prepare(action)
        let reopened = V2WorkJournal(scope: scope, directory: root)
        XCTAssertEqual(try reopened.prepare(action).id, first.id)
        XCTAssertEqual(reopened.pendingTickets, [first])
        let client = V2Client(baseURL: URL(string: "https://localhost")!, token: "demo", session: .shared)
        let request = try client.ticketRequest(first)
        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Idempotency-Key"), first.id)
        let body = try XCTUnwrap(request.httpBody)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: body) as? [String: String], ["text": "补上原来的地址"])
        try reopened.acknowledge(first)
        let restored = V2WorkJournal(scope: scope, directory: root)
        XCTAssertTrue(restored.pendingTickets.isEmpty)
        XCTAssertNotEqual(try restored.prepare(action).id, first.id)
        let other = V2WorkJournal(scope: .init(householdID: "h", homeHostID: "mac", memberID: "partner"), directory: root)
        XCTAssertTrue(other.pendingTickets.isEmpty)
    }

    @MainActor func testExplicitCreationReusesKeyEvenAfterAcknowledgement() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let scope = V2SyncScope(householdID: "h", homeHostID: "mac", memberID: "me")
        let proof = V2.WorkSource(conversationID: conversationID, messageID: sourceID, revision: 4)
        let action = V2.TicketAction.schedule(source: proof, about: "考试", when: "2026-11-24T12:00:00Z")
        let journal = V2WorkJournal(scope: scope, directory: root)
        let entry = try journal.prepare(action)
        let client = V2Client(baseURL: URL(string: "https://localhost")!, token: "demo", session: .shared)
        let request = try client.ticketRequest(entry)
        XCTAssertEqual(request.url?.path, "/v2/tickets")
        let data = try XCTUnwrap(request.httpBody)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(body["source_message_id"] as? String, sourceID)
        XCTAssertEqual(body["source_revision"] as? Int, 4)
        XCTAssertEqual(body["conversation_id"] as? String, conversationID)
        try journal.acknowledge(entry)
        let reopened = V2WorkJournal(scope: scope, directory: root)
        XCTAssertTrue(reopened.pendingTickets.isEmpty)
        XCTAssertEqual(try reopened.prepare(action).id, entry.id)
    }

    func testOfficialProjectionAndRelayStatus() throws {
        let ticket = #"{"id":"t","revision":3,"conversation_id":"c","for_member_id":"m","publisher_host_id":"h","kind":"errand","mandate_kind":"explicit","source_message_id":"s","source_revision":4,"goal":"一起想想","status":"ended","stage":"blocked","due_at":null,"time_zone":"Asia/Shanghai","ended_reason":"blocked"}"#
        let letter = #"{"id":"l","revision":2,"conversation_id":"c","for_member_id":"m","publisher_host_id":"h","ticket_id":"t","text":"写好了","created_at":1000,"read_at":2000}"#
        let page = #"{"generation":"g","reset":false,"next":"n","has_more":false,"changes":[{"kind":"ticket","id":"t","sequence":1,"op":"upsert","value":\#(ticket)},{"kind":"mailbox_letter","id":"l","sequence":2,"op":"upsert","value":\#(letter)},{"kind":"mailbox_letter","id":"l","sequence":3,"op":"delete"}]}"#
        let changes = try V2.decoder.decode(V2.ChangesPage.self, from: Data(page.utf8)).changes
        guard case .ticket(let projectedTicket) = changes.first?.value,
              case .mailboxLetter(let projectedLetter) = changes.dropFirst().first?.value else { return XCTFail("缺少正式投影") }
        XCTAssertTrue(projectedTicket.canResume)
        XCTAssertEqual(projectedLetter.readAt, 2000)
        XCTAssertEqual(changes.last?.isDeleted, true)
        XCTAssertNotEqual(V2.RelayReceipt.State.accepted.label, V2.RelayReceipt.State.published.label)
        XCTAssertTrue(V2.RelayReceipt.State.queued.isPending)
        XCTAssertFalse(V2.RelayReceipt.State.rejected.isPending)
    }
}
