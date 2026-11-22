import Foundation
import XCTest
@testable import HostCore

final class BunDesktopChatTests: XCTestCase {
    func testScopeIncludesCanonicalPathHostHouseholdAndCA() {
        let data = URL(fileURLWithPath: "/tmp/cattt-a")
        func scope(_ data: URL = data, host: String = "host", household: String = "home",
                   fingerprint: String = "ca") -> String {
            DesktopV2Scope(data: data, hostID: host, householdID: household, fingerprint: fingerprint).key
        }
        XCTAssertEqual(scope(), scope(URL(fileURLWithPath: "/tmp/./cattt-a")))
        XCTAssertNotEqual(scope(), scope(URL(fileURLWithPath: "/tmp/cattt-b")))
        XCTAssertNotEqual(scope(), scope(host: "other"))
        XCTAssertNotEqual(scope(), scope(household: "other"))
        XCTAssertNotEqual(scope(), scope(fingerprint: "other"))
    }

    func testConversationFilterExposesOnlyOwnDirectAndGroup() throws {
        let input = Data("""
        [
          {"id":"a","kind":"direct","owner_member_id":"me","participant_member_ids":["me"],"publisher_host_id":"host","created_at":0},
          {"id":"b","kind":"direct","owner_member_id":"other","participant_member_ids":["me","other"],"publisher_host_id":"host","created_at":0},
          {"id":"g","kind":"group","participant_member_ids":["me","other"],"publisher_host_id":"host","created_at":0},
          {"id":"another","kind":"group","participant_member_ids":["other"],"publisher_host_id":"host","created_at":0}
        ]
        """.utf8)
        let conversations = try V2.decoder.decode([V2.Conversation].self, from: input)
        XCTAssertEqual(DesktopV2Chat.visible(conversations, memberID: "me").map(\.id), ["g", "a"])
    }

    func testPendingAndTerminalReceiptKeepSameSendKeyAcrossReopen() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let scope = DesktopV2Scope(data: folder, hostID: "host", householdID: "home", fingerprint: "ca")
        let state = try DesktopV2Journal(scope: scope, memberID: "me")
        let pending = try state.enqueue(conversationID: "chat", text: "你好")
        let id = pending.id
        let receipt = "019a0000-0000-7000-8000-000000000001"
        let body = Data("""
        {"status":"pending","request_id":"\(receipt)","client_message_id":"\(id)","reason":"peer_pending",
         "receipt_url":"/v2/conversations/chat/message-requests/\(receipt)"}
        """.utf8)
        let outcome = try DesktopV2Send.decode(body, httpStatus: 202, entry: pending)
        guard case .pending(let requestID) = outcome else { return XCTFail("Expected a pending receipt") }
        try state.recordReceipt(requestID, entryID: id)
        let reopened = try DesktopV2Journal(scope: scope, memberID: "me")
        XCTAssertEqual(reopened.pending.first?.id, id)
        XCTAssertEqual(reopened.pending.first?.receiptID, receipt)
        XCTAssertTrue(try DesktopV2Journal(scope: scope, memberID: "other").pending.isEmpty)
        XCTAssertThrowsError(try DesktopV2Send.decode(body, httpStatus: 200, entry: pending))
        XCTAssertThrowsError(try DesktopV2Send.decode(Data(String(decoding: body, as: UTF8.self)
            .replacingOccurrences(of: "/v2/conversations/chat", with: "https://elsewhere").utf8), httpStatus: 202, entry: pending))
        try reopened.settle(entryID: id, turn: nil)
        XCTAssertTrue(try DesktopV2Journal(scope: scope, memberID: "me").pending.isEmpty)
    }
}
