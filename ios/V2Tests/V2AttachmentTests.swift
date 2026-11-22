import XCTest
@testable import Maomao

final class V2AttachmentTests: XCTestCase {
    private let scope = V2AttachmentOutbox.Scope(householdID: "home", memberID: "member", deviceID: "device", conversationID: "chat")
    private let fixture = #"{"file":{"id":"file","owner_member_id":"member","conversation_id":"chat","source_message_id":null,"source_message_rev":null,"sha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","byte_size":3,"file_name":"sample.txt","media_type":"text/plain","description":null,"rev":1,"created_at":1,"updated_at":1,"available":true}}"#

    func testStagingPersistsBytesAndKeyWithinScope() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let input = root.appending(path: "sample.txt")
        try Data("abc".utf8).write(to: input)
        let outbox = V2AttachmentOutbox(root: root, scope: scope)
        let entry = try await outbox.stage(input, mediaType: "text/plain")
        try FileManager.default.removeItem(at: input)
        let restarted = V2AttachmentOutbox(root: root, scope: scope)
        let recovered = try await restarted.entries()
        XCTAssertEqual(recovered, [entry])
        XCTAssertNotNil(UUID(uuidString: entry.id))
        XCTAssertEqual(entry.sha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        XCTAssertEqual(entry.byteSize, 3)
        let otherScopes = [
            V2AttachmentOutbox.Scope(householdID: "other", memberID: "member", deviceID: "device", conversationID: "chat"),
            .init(householdID: "home", memberID: "other", deviceID: "device", conversationID: "chat"),
            .init(householdID: "home", memberID: "member", deviceID: "other", conversationID: "chat"),
            .init(householdID: "home", memberID: "member", deviceID: "device", conversationID: "direct")
        ]
        for other in otherScopes {
            let hidden = try await V2AttachmentOutbox(root: root, scope: other).entries()
            XCTAssertTrue(hidden.isEmpty)
        }
    }

    func testLostChunkResponseResumesAndRequiresCompletionReceipt() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let input = root.appending(path: "sample.txt")
        try Data("abc".utf8).write(to: input)
        let entry = try await V2AttachmentOutbox(root: root, scope: scope).stage(input, mediaType: "text/plain")
        let outbox = V2AttachmentOutbox(root: root, scope: scope)
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AttachmentURLProtocol.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let client = V2Client(baseURL: URL(string: "https://cattt.test")!, token: "device-token", session: session)
        let fixture = fixture
        let state = AttachmentWireState()
        AttachmentURLProtocol.respond = { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer device-token")
            let call = state.record(request)
            switch (call, request.httpMethod, request.url?.path) {
            case (1, "POST", "/v2/files/uploads"):
                let body = try JSONSerialization.jsonObject(with: AttachmentURLProtocol.body(request)) as? [String: Any]
                XCTAssertEqual(body?["client_upload_id"] as? String, entry.id)
                XCTAssertEqual(body?["conversation_id"] as? String, "chat")
                XCTAssertNil(body?["source_message_id"])
                return (201, #"{"id":"upload","offset":0,"byte_size":3,"file_id":null}"#)
            case (2, "PATCH", "/v2/files/uploads/upload"):
                XCTAssertEqual(request.value(forHTTPHeaderField: "Upload-Offset"), "0")
                XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/octet-stream")
                XCTAssertEqual(AttachmentURLProtocol.body(request), Data("abc".utf8))
                throw URLError(.networkConnectionLost)
            case (3, "GET", "/v2/files/uploads/upload"):
                return (200, #"{"id":"upload","offset":3,"byte_size":3,"file_id":null}"#)
            case (4, "POST", "/v2/files/uploads/upload/complete"):
                throw URLError(.networkConnectionLost)
            case (5, "GET", "/v2/files/uploads/upload"):
                return (200, #"{"id":"upload","offset":3,"byte_size":3,"file_id":"file"}"#)
            case (6, "POST", "/v2/files/uploads/upload/complete"):
                return (200, fixture)
            default:
                XCTFail("Unexpected request \(call): \(request)")
                throw URLError(.badServerResponse)
            }
        }
        defer { AttachmentURLProtocol.respond = nil }
        do {
            _ = try await outbox.upload(entry.id, client: client)
            XCTFail("Byte offset alone must not acknowledge the upload")
        } catch {
            XCTAssertEqual((error as? URLError)?.code, .networkConnectionLost)
        }
        let restarted = V2AttachmentOutbox(root: root, scope: scope)
        let pending = try await restarted.entries()
        XCTAssertEqual(pending.first?.id, entry.id)
        XCTAssertEqual(pending.first?.uploadID, "upload")
        XCTAssertEqual(pending.first?.offset, 3)
        let done = try await restarted.upload(entry.id, client: client)
        XCTAssertEqual(done.id, "file")
        let remaining = try await restarted.entries()
        XCTAssertTrue(remaining.isEmpty)
    }

    func testFileDescriptionDistinguishesMissingOriginalFromMissingModel() throws {
        for (raw, expected): (String, V2.FileDescription.Status) in [
            ("not_generated", .notGenerated), ("blob_unavailable", .blobUnavailable), ("model_unavailable", .modelUnavailable)
        ] {
            let result = try V2.decoder.decode(V2.FileDescription.self, from: Data("{\"status\":\"\(raw)\"}".utf8))
            XCTAssertEqual(result.status, expected)
            XCTAssertNil(result.description)
        }
        XCTAssertThrowsError(try V2.decoder.decode(V2.FileDescription.self, from: Data(#"{"status":"ready"}"#.utf8)))
        let ready = #"{"status":"ready","description":{"id":"desc","file_id":"file","file_rev":1,"sha256":"hash","source_message_id":null,"source_message_rev":null,"text":"一张图","model_id":"local","created_at":1}}"#
        let result = try V2.decoder.decode(V2.FileDescription.self, from: Data(ready.utf8))
        XCTAssertEqual(result.description?.text, "一张图")
    }
}

private final class AttachmentWireState: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    func record(_ request: URLRequest) -> Int {
        lock.lock()
        defer { lock.unlock() }
        count += 1
        return count
    }
}

private final class AttachmentURLProtocol: URLProtocol {
    static var respond: ((URLRequest) throws -> (Int, String))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    static func body(_ request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var result = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            result.append(contentsOf: buffer.prefix(count))
        }
        return result
    }

    override func startLoading() {
        do {
            guard let respond = Self.respond else { throw URLError(.badServerResponse) }
            let (status, text) = try respond(request)
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(text.utf8))
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
