import XCTest
@testable import HostCore

private final class PairingProtocol: URLProtocol {
    static var responder: (URLRequest) throws -> (Int, String) = { _ in (404, "") }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (code, body) = try Self.responder(request)
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8)); client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

final class PairingTests: XCTestCase {
    func testContractAndErrors() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        try Data("secret-test\n".utf8).write(to: dir.appendingPathComponent("host-admin.token"))
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [PairingProtocol.self]
        let session = URLSession(configuration: config); defer { session.invalidateAndCancel() }
        let client = PairingClient(dataDirectory: dir, session: session)
        PairingProtocol.responder = { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer secret-test")
            if request.httpMethod == "POST" {
                XCTAssertEqual(request.url?.path, "/host/pairing-codes")
                return (200, #"{"code":"ABCDEFGH","expires_at":"2026-11-19T23:00:00Z","pair_url":"https://example.local/pair","ca_fingerprint_short":"AB:CD"}"#)
            }
            return (200, #"{"devices":[]}"#)
        }
        let code = try await client.createCode()
        XCTAssertEqual(code.displayCode, "ABCD-EFGH")
        let empty = try await client.devices(); XCTAssertTrue(empty.isEmpty)
        PairingProtocol.responder = { request in
            if request.httpMethod == "DELETE" { XCTAssertEqual(request.url?.path, "/host/devices/device-1"); return (204, "") }
            return (200, #"{"devices":[{"id":"device-1","name":"手机"}]}"#)
        }
        let devices = try await client.devices(); XCTAssertEqual(devices.first?.displayName, "手机")
        try await client.removeDevice("device-1")
        PairingProtocol.responder = { _ in (404, "") }
        do { _ = try await client.createCode(); XCTFail("应返回不支持配对") }
        catch { XCTAssertEqual(error.localizedDescription, "这个版本的服务端还不支持配对") }
        PairingProtocol.responder = { _ in (401, "") }
        do { _ = try await client.devices(); XCTFail("应拒绝未授权请求") }
        catch { XCTAssertTrue(error.localizedDescription.contains("401")) }
        PairingProtocol.responder = { _ in (200, "bad json") }
        do { _ = try await client.createCode(); XCTFail("应拒绝错误响应") } catch { XCTAssertTrue(error is DecodingError) }
    }
}
