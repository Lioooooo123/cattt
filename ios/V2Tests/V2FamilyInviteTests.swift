import XCTest
@testable import Maomao

final class V2FamilyInviteTests: XCTestCase {
    private let pin = String(repeating: "a", count: 64)
    private var query: String { "v=2&h=127.0.0.1,test.local&p=8789&c=ABCD-EFGH&fp=\(pin)" }

    func testDeviceLinksKeepTheirVersionAndFamilyLinksAreV2Only() throws {
        let invitation = try XCTUnwrap(PairInvitation.parse(URL(string: "maomao://invite?\(query)")!, versions: [1, 2]))
        XCTAssertEqual(invitation.kind, .family)
        XCTAssertEqual(invitation.hosts, ["127.0.0.1", "test.local"])
        XCTAssertEqual(invitation.code, "ABCDEFGH")
        XCTAssertEqual(invitation.fingerprint, pin)
        for version in [1, 2] {
            let device = URL(string: "maomao://pair?\(query.replacingOccurrences(of: "v=2", with: "v=\(version)"))")!
            XCTAssertEqual(PairInvitation.parse(device, versions: [1, 2])?.kind, .device)
        }
        for link in [
            "maomao://invite?\(query.replacingOccurrences(of: "v=2", with: "v=1"))",
            "maomao://invite?\(query)&h=other.local",
            "maomao://invite?\(query)&redirect=https://other.local",
            "maomao://from@invite?\(query)",
            "maomao://invite:443?\(query)",
            "maomao://invite/accept?\(query)",
            "maomao://invite?\(query)#other",
            "maomao://invite?\(query.replacingOccurrences(of: "test.local", with: "test.local%2Fother"))",
        ] {
            XCTAssertNil(PairInvitation.parse(URL(string: link)!, versions: [1, 2]), link)
        }
    }

    @MainActor
    func testJoinOnlySavesConfirmedIdentityAndRetryUsesIssuedCredential() async throws {
        let invitation = try XCTUnwrap(PairInvitation.parse(URL(string: "maomao://invite?\(query)")!, versions: [1, 2]))
        let member = #"{"id":"second","household_id":"family","display_name":"乙","home_host_id":"host"}"#
        let household = #"{"id":"family","name":"团子的家"}"#
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FamilyInviteProtocol.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let base = URL(string: "https://test.local:8789")!
        let oldClient = V2Client(baseURL: base, token: "existing-device", session: session)
        let token = "mm_dvc_" + String(repeating: "b", count: 43)
        FamilyInviteProtocol.responses = [
            ("/v2/invites/accept", nil, 200, #"{"member":\#(member),"household":\#(household),"device_id":"new","device_token":"\#(token)"}"#),
            ("/v2/me", "Bearer \(token)", 200, #"{"member":\#(member),"household":\#(household),"actor":{"household_id":"family","member_id":"second","device_id":"wrong","host_id":"host"}}"#),
            ("/v2/me", "Bearer \(token)", 200, #"{"member":\#(member),"household":\#(household),"actor":{"household_id":"family","member_id":"second","device_id":"new","host_id":"host"}}"#),
            ("/v2/me", "Bearer \(token)", 200, #"{"member":\#(member),"household":\#(household),"actor":{"household_id":"family","member_id":"second","device_id":"new","host_id":"host"}}"#),
        ]
        var activeDevice = "existing-device"
        let accepted = try await V2FamilyJoin.redeem(invitation, displayName: " 乙 ", deviceName: "测试 iPhone") { target in
            XCTAssertEqual(target, invitation)
            return oldClient
        }
        XCTAssertEqual(activeDevice, "existing-device")
        do {
            _ = try await accepted.confirmAndSave { activeDevice = $0.identity.deviceId }
            XCTFail("身份不符时不应保存")
        } catch let error as V2.ChangesError {
            XCTAssertEqual(error, .identityMismatch)
        }
        XCTAssertEqual(activeDevice, "existing-device")
        do {
            _ = try await accepted.confirmAndSave { _ in throw PairingError.storage }
            XCTFail("保存失败时不应切换")
        } catch PairingError.storage {}
        XCTAssertEqual(activeDevice, "existing-device")
        let joined = try await accepted.confirmAndSave { activeDevice = $0.identity.deviceId }
        XCTAssertEqual(activeDevice, "new")
        XCTAssertEqual(joined.identity.member.id, "second")
        XCTAssertEqual(joined.hosts, invitation.hosts)
        XCTAssertEqual(joined.fingerprint, pin)
        XCTAssertTrue(FamilyInviteProtocol.responses.isEmpty)
    }

    func testOfferErrorsAreActionable() {
        let errors = ["invite_code_invalid", "member_limit", "peer_sync_pending", "not_found", "http_503"]
        let messages = errors.map { V2FamilyJoin.errorMessage(V2.APIError(code: $0)) }
        XCTAssertTrue(messages[0].contains("过期"))
        XCTAssertTrue(messages[0].contains("用过"))
        XCTAssertTrue(messages[1].contains("成员"))
        XCTAssertTrue(messages[2].contains("同步"))
        XCTAssertTrue(messages[3].contains("更新"))
        XCTAssertTrue(messages[4].contains("稍后"))
    }
}

private final class FamilyInviteProtocol: URLProtocol {
    nonisolated(unsafe) static var responses: [(String, String?, Int, String)] = []
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard !Self.responses.isEmpty else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        let (path, authorization, status, body) = Self.responses.removeFirst()
        XCTAssertEqual(request.url?.host, "test.local")
        XCTAssertEqual(request.url?.path, path)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), authorization)
        if path == "/v2/invites/accept" {
            XCTAssertEqual(request.httpMethod, "POST")
            if let data = request.httpBody ?? request.httpBodyStream.flatMap({ stream -> Data? in
                stream.open()
                defer { stream.close() }
                var bytes = [UInt8](repeating: 0, count: 4096)
                let count = stream.read(&bytes, maxLength: bytes.count)
                return count >= 0 ? Data(bytes.prefix(count)) : nil
            }) {
                XCTAssertEqual(try? JSONSerialization.jsonObject(with: data) as? [String: String],
                               ["code": "ABCDEFGH", "display_name": "乙", "device_name": "测试 iPhone"])
            } else { XCTFail("邀请请求缺少正文") }
        } else { XCTAssertEqual(request.httpMethod, "GET") }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
