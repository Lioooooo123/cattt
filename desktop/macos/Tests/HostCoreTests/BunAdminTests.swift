import Darwin
import Foundation
import XCTest
@testable import HostCore

final class BunAdminTests: XCTestCase {
    func testSyncStateKeepsCommittedPositionWhenPausedOrOffline() throws {
        let json = """
        {"status":"paused","paused":true,"cursor":{"source_host_id":"source","generation":"new","seq":17},
         "last_attempt_at":null,"last_success_at":null,"error_code":null}
        """
        let decoder = JSONDecoder()
        let paused = try decoder.decode(PeerSyncState.self, from: Data(json.utf8))
        let offline = try decoder.decode(PeerSyncState.self, from: Data(json
            .replacingOccurrences(of: "\"paused\",\"paused\":true", with: "\"unavailable\",\"paused\":false").utf8))
        XCTAssertEqual(paused.status, .paused)
        XCTAssertEqual(offline.status, .unavailable)
        XCTAssertEqual(paused.cursor, offline.cursor)
        XCTAssertEqual(offline.cursor?.generation, "new")
        XCTAssertEqual(offline.cursor?.sequence, 17)
    }

    func testErrorsGiveRecoveryWithoutDisplayingServerText() {
        XCTAssertTrue(BunAdminError.response(502, "peer_connection_failed").localizedDescription.contains("批准"))
        XCTAssertTrue(BunAdminError.response(409, "peer_household_conflict").localizedDescription.contains("空白"))
        XCTAssertTrue(BunAdminError.response(409, "peer_sync_pending").localizedDescription.contains("同步"))
        XCTAssertFalse(BunAdminError.response(500, "secret-value").localizedDescription.contains("secret-value"))
    }

    func testPackagedHostsJoinWithMutualApprovalAndRecoverCursor() async throws {
        guard let path = ProcessInfo.processInfo.environment["CATTT_R85_TEST_APP"] else {
            throw XCTSkip("设置 CATTT_R85_TEST_APP 可运行双宿主成品联调")
        }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: root) }
        let app = URL(fileURLWithPath: path).appendingPathComponent("Contents/MacOS/CatttBunHost")
        let ports = try reservePorts(6)
        let a = try Instance(app: app, directory: root.appendingPathComponent("a"), ports: Array(ports[0..<3]))
        let b = try Instance(app: app, directory: root.appendingPathComponent("b"), ports: Array(ports[3..<6]))
        defer { a.stop(); b.stop() }
        try a.start()
        try b.start()
        let aID = try await eventually("读取甲的结对描述符") { try await a.client.identity() }.descriptor
        let bID = try await eventually("读取乙的结对描述符") { try await b.client.identity() }.descriptor
        let exported = try aID.exportJSON()
        XCTAssertFalse(String(decoding: exported, as: UTF8.self).contains("PRIVATE KEY"))
        XCTAssertEqual(try PeerDescriptor.importJSON(exported), aID)
        let tampered = String(decoding: exported, as: UTF8.self).replacingOccurrences(
            of: aID.fingerprint, with: String(repeating: "0", count: 64))
        XCTAssertThrowsError(try PeerDescriptor.importJSON(Data(tampered.utf8)))
        let aRemote = try aID.atAddress(host: "127.0.0.1", port: ports[2])
        let bRemote = try bID.atAddress(host: "127.0.0.1", port: ports[5])
        await expectError(.fingerprintMismatch) {
            _ = try await b.client.pair(aRemote, verifiedFingerprint: String(aID.fingerprint.prefix(16)), action: .join)
        }
        let peersBeforeApproval = try await b.client.peers()
        XCTAssertTrue(peersBeforeApproval.isEmpty)
        await expectError(.response(502, "peer_connection_failed")) {
            _ = try await b.client.pair(aRemote, verifiedFingerprint: aID.fingerprint, action: .join)
        }
        let owner = try await a.client.createFirstMember(name: "甲")
        let firstCode = try await a.client.phoneCode(memberID: owner.id)
        let ownerPhone = try await a.phone("/v2/pair", body: ["code": firstCode.code, "device_name": "甲的手机"])
        XCTAssertEqual(ownerPhone.member.id, owner.id)
        XCTAssertEqual(URLComponents(url: firstCode.url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "v" }?.value, "2")

        let approval = try await a.client.pair(bRemote, verifiedFingerprint: bID.fingerprint, action: .allowJoin)
        XCTAssertEqual(approval.status, .approved)
        let joined = try await b.client.pair(aRemote, verifiedFingerprint: aID.fingerprint, action: .join)
        XCTAssertEqual(joined.status, .paired)
        let joinedIdentity = try await b.client.identity().descriptor
        XCTAssertEqual(joinedIdentity.householdID, aID.householdID)
        XCTAssertEqual(joinedIdentity.hostID, bID.hostID)

        try await eventually("同步已有家庭成员") {
            let state = try await b.client.members()
            return state.members.contains { $0.id == owner.id } ? state : nil
        }
        await expectError(.response(400, "invalid_request")) {
            _ = try await b.client.phoneCode(memberID: owner.id)
        }
        let invite = try await b.client.invite(name: "乙")
        let outstanding = try await b.client.openInvites()
        XCTAssertEqual(outstanding.map(\.id), [invite.id])
        let joinPhone = try await b.phone("/v2/invites/accept", body: [
            "code": invite.code, "display_name": "乙", "device_name": "乙的手机",
        ])
        XCTAssertEqual(joinPhone.member.homeHostID, bID.hostID)
        let companion = try await b.client.phoneCode(memberID: joinPhone.member.id)
        let extra = try await b.phone("/v2/pair", body: ["code": companion.code, "device_name": "乙的备用手机"])
        XCTAssertEqual(extra.member.id, joinPhone.member.id)
        let cursor = try await eventually("取得首个同步水位") {
            let row = try await b.client.peers().first
            return row?.sync.status == .caughtUp ? row?.sync.cursor : nil
        }
        let paused = try await b.client.setPaused(true, hostID: aID.hostID)
        XCTAssertEqual(paused.sync.status, .paused)
        XCTAssertEqual(paused.sync.cursor, cursor)
        b.stop()
        try b.start()
        let persisted = try await eventually("重启后读取暂停的水位") { try await b.client.peers().first }.sync
        XCTAssertEqual(persisted.status, .paused)
        XCTAssertEqual(persisted.cursor, cursor)
        _ = try await b.client.setPaused(false, hostID: aID.hostID)
        _ = try await eventually("恢复拉取") {
            let row = try await b.client.peers().first
            return row?.sync.status == .caughtUp ? row : nil
        }
        try await a.client.revokePeer(hostID: bID.hostID)
        let revoked = try await a.client.peers().first
        XCTAssertEqual(revoked?.status, .revoked)
        _ = try await eventually("同步识别对端撤销") {
            let row = try await b.client.peers().first
            return row?.sync.status == .unavailable || row?.sync.status == .error ? row : nil
        }
        a.stop()
        try a.start()
        let afterRestart = try await eventually("重启后读取撤销状态") { try await a.client.peers().first }
        XCTAssertEqual(afterRestart.status, .revoked)
        await expectError(.response(502, "peer_connection_failed")) {
            _ = try await b.client.pair(aRemote, verifiedFingerprint: aID.fingerprint, action: .connect)
        }
    }

    private func expectError(_ expected: BunAdminError, action: () async throws -> Void,
                             file: StaticString = #filePath, line: UInt = #line) async {
        do {
            try await action()
            XCTFail("预期管理请求失败", file: file, line: line)
        } catch {
            XCTAssertEqual(error as? BunAdminError, expected, file: file, line: line)
        }
    }

    @discardableResult
    private func eventually<T>(_ step: String, _ read: () async throws -> T?) async throws -> T {
        let deadline = ContinuousClock.now + .seconds(22)
        var lastError: Error?
        repeat {
            do { if let value = try await read() { return value } }
            catch { lastError = error }
            try await Task.sleep(for: .milliseconds(150))
        } while ContinuousClock.now < deadline
        let detail = lastError.map { String(describing: $0) } ?? "等待成品状态超时"
        throw HostError("\(step)：\(detail)")
    }

    private func reservePorts(_ count: Int) throws -> [UInt16] {
        var sockets: [Int32] = []
        defer { sockets.forEach { close($0) } }
        return try (0..<count).map { _ in
            let fd = socket(AF_INET, SOCK_STREAM, 0)
            guard fd >= 0 else { throw HostError("无法为集成测试预留端口") }
            sockets.append(fd)
            var address = sockaddr_in()
            address.sin_family = sa_family_t(AF_INET)
            address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            address.sin_addr.s_addr = inet_addr("127.0.0.1")
            var length = socklen_t(MemoryLayout<sockaddr_in>.size)
            try withUnsafeMutablePointer(to: &address) { pointer in
                try pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { socketAddress in
                    guard Darwin.bind(fd, socketAddress, length) == 0, getsockname(fd, socketAddress, &length) == 0 else {
                        throw HostError("无法为集成测试分配端口")
                    }
                }
            }
            return UInt16(bigEndian: address.sin_port)
        }
    }
}

private final class Instance {
    struct Phone: Decodable { let member: BunMember }

    let client: BunAdminClient
    private let app: URL
    private let directory: URL
    private let ports: [UInt16]
    private var process: Process?

    init(app: URL, directory: URL, ports: [UInt16]) throws {
        self.app = app
        self.directory = directory
        self.ports = ports
        client = BunAdminClient(dataDirectory: directory, port: ports[0])
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        try "MODEL_PROVIDER=mock\n".write(to: directory.appendingPathComponent("env"), atomically: true, encoding: .utf8)
    }

    func start() throws {
        let child = Process()
        child.executableURL = app
        child.arguments = ["--headless", "--data-dir", directory.path, "--port", String(ports[0]),
                           "--lan-port", String(ports[1]), "--peer-port", String(ports[2])]
        try child.run()
        process = child
    }

    func stop() {
        guard let process else { return }
        if process.isRunning {
            process.terminate()
            let deadline = ProcessInfo.processInfo.systemUptime + 10
            while process.isRunning && ProcessInfo.processInfo.systemUptime < deadline { Thread.sleep(forTimeInterval: 0.05) }
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }
        process.waitUntilExit()
        self.process = nil
    }

    func phone(_ path: String, body: [String: String]) async throws -> Phone {
        let ca = try String(contentsOf: directory.appendingPathComponent("tls/ca.crt"), encoding: .utf8)
        let trust = try XCTUnwrap(HostTrustDelegate(ca))
        let session = URLSession(configuration: .ephemeral, delegate: trust, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        var request = URLRequest(url: URL(string: "https://127.0.0.1:\(ports[1])\(path)")!, timeoutInterval: 5)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await session.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try JSONDecoder().decode(Phone.self, from: data)
    }
}
