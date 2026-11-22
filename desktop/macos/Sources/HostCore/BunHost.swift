import Darwin
import Foundation

/// The caller serializes lifecycle operations, including tick().
public final class BunHost {
    public enum State: Equatable {
        case stopped, starting, ready, restoring, waiting(String), failed(String)

        public var message: String {
            switch self {
            case .stopped: return "已停止"
            case .starting: return "正在启动 Bun 宿主…"
            case .ready: return "回环和 HTTPS 已就绪"
            case .restoring: return "正在恢复备份，服务已暂停…"
            case .waiting(let message), .failed(let message): return message
            }
        }
    }

    public let data: URL
    public let admin: BunAdminClient
    private let executable: URL
    let port: UInt16
    let lanPort: UInt16
    private let peerPort: UInt16
    private let fm = FileManager.default
    private var child: Process?
    private var parentPipe: Pipe?
    private var lockFD: Int32 = -1
    private var attempts = 0
    private var retryAt: TimeInterval = 0
    private var nextProbe: TimeInterval = 0
    private var startupDeadline: TimeInterval?
    public private(set) var state: State = .stopped
    public var isSupervising: Bool { lockFD >= 0 }

    private var uptime: TimeInterval { ProcessInfo.processInfo.systemUptime }
    private var logFile: URL { data.appendingPathComponent("logs/bun.log") }
    private var pendingRestore: Bool { fm.fileExists(atPath: data.appendingPathComponent("restore-pending").path) }

    public init(data: URL, executable: URL, port: UInt16, lanPort: UInt16, peerPort: UInt16 = 18790) {
        self.data = data.standardizedFileURL.resolvingSymlinksInPath()
        self.admin = BunAdminClient(dataDirectory: self.data, port: port)
        self.executable = executable
        self.port = port
        self.lanPort = lanPort
        self.peerPort = peerPort
    }

    public func start() throws {
        guard lockFD < 0 else { return }
        try acquireLock()
        do {
            if pendingRestore {
                _ = try recoverInterruptedRestore()
            } else {
                try launch()
            }
        } catch {
            stop()
            throw error
        }
    }

    private func acquireLock() throws {
        let legacy = URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Library/Application Support/Cattt").resolvingSymlinksInPath().path
        let pgFiles = ["pg", "pg.initializing", "pg-password"]
        guard data.path != legacy, !data.path.hasPrefix(legacy + "/"),
              !pgFiles.contains(where: { fm.fileExists(atPath: data.appendingPathComponent($0).path) }) else {
            throw HostError("检测到旧 PostgreSQL 宿主目录，请指定独立的 Bun 开发数据目录")
        }
        guard ![port, lanPort, peerPort].contains(0), Set([port, lanPort, peerPort]).count == 3 else {
            throw HostError("回环、局域网 HTTPS 和 Peer HTTPS 需要三个不同的非零端口")
        }
        try fm.createDirectory(at: data, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        lockFD = open(data.appendingPathComponent("host.lock").path, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard lockFD >= 0 else { throw HostError("无法打开开发数据目录的宿主锁") }
        guard flock(lockFD, LOCK_EX | LOCK_NB) == 0 else {
            close(lockFD)
            lockFD = -1
            throw HostError("宿主已经运行")
        }
    }

    private func launch(restoreCheck: Bool = false) throws {
        guard fm.isExecutableFile(atPath: executable.path) else { throw HostError("应用中缺少可执行的 Bun 宿主") }
        try Host.requireAvailablePort(port)
        try Host.requireAvailablePort(lanPort)
        try Host.requireAvailablePort(peerPort)
        let config = data.appendingPathComponent("env")
        var environment = fm.fileExists(atPath: config.path) ? try Host.parseEnv(String(contentsOf: config, encoding: .utf8)) : [:]
        environment.merge([
            "CATTT_DATA_DIR": data.path, "CATTT_PORT": String(port), "CATTT_LAN_HTTPS_PORT": String(lanPort),
            "CATTT_PEER_HTTPS_PORT": String(peerPort),
            "PATH": "/usr/bin:/bin", "HOME": data.path,
        ]) { _, hostValue in hostValue }

        try fm.createDirectory(at: logFile.deletingLastPathComponent(), withIntermediateDirectories: true,
                               attributes: [.posixPermissions: 0o700])
        try Host.rotate(logFile)
        if !fm.fileExists(atPath: logFile.path) {
            fm.createFile(atPath: logFile.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        let log = try FileHandle(forWritingTo: logFile)
        defer { try? log.close() }
        try log.seekToEnd()

        let pipe = Pipe()
        let process = Process()
        process.executableURL = executable
        process.arguments = restoreCheck ? ["--supervised", "--restore-check"] : ["--supervised"]
        process.currentDirectoryURL = data
        process.environment = environment
        process.standardInput = pipe
        process.standardOutput = log
        process.standardError = log
        try process.run()
        child = process
        parentPipe = pipe
        startupDeadline = uptime + 15
        nextProbe = uptime
        state = restoreCheck ? .restoring : .starting
    }

    public func tick() {
        guard lockFD >= 0 else { return }
        guard let child else {
            if uptime >= retryAt {
                do { try launch() }
                catch { scheduleRetry("重启失败：\(error)") }
            }
            return
        }
        guard child.isRunning else {
            let message = "Bun 宿主已退出（\(child.terminationStatus)）"
            stopChild()
            if attempts == 0, startupDeadline != nil {
                failStartup(message)
            } else {
                scheduleRetry(message)
            }
            return
        }
        guard uptime >= nextProbe else { return }
        nextProbe = uptime + 1
        let problem = healthProblem()
        if let problem {
            if let deadline = startupDeadline {
                if uptime >= deadline {
                    if attempts == 0 { failStartup(problem) }
                    else { stopChild(); scheduleRetry(problem) }
                }
            } else {
                state = .failed("\(problem)，请查看 logs/bun.log")
            }
        } else {
            startupDeadline = nil
            attempts = 0
            state = .ready
        }
    }

    private func failStartup(_ message: String) {
        stop()
        state = .failed("\(message)，请查看 logs/bun.log")
    }

    private func scheduleRetry(_ message: String) {
        attempts += 1
        retryAt = uptime + Host.backoff(attempts)
        state = .waiting("\(message)，等待重启。请查看 logs/bun.log")
    }

    public func stop() {
        stopChild()
        if lockFD >= 0 {
            close(lockFD)
            lockFD = -1
        }
        attempts = 0
        startupDeadline = nil
        state = .stopped
    }

    private func stopChild() {
        try? parentPipe?.fileHandleForWriting.close()
        parentPipe = nil
        guard let child else { return }
        if child.isRunning {
            child.terminate()
            let deadline = uptime + 8
            while child.isRunning && uptime < deadline { Thread.sleep(forTimeInterval: 0.05) }
            if child.isRunning { kill(child.processIdentifier, SIGKILL) }
        }
        child.waitUntilExit()
        self.child = nil
    }

    deinit { stop() }

    private struct BackupReply: Decodable { let id: String }
    private struct RecoveryReply: Decodable {
        let recovery_id: String?
        let generation: String?
        let database: String?
        let error: String?
    }

    public var backupFolder: URL { data.appendingPathComponent("backups", isDirectory: true) }

    public func backup() throws -> URL {
        guard let token = adminToken, !token.isEmpty else { throw HostError("在线备份需要已就绪的宿主") }
        let local = URLSession(configuration: .ephemeral, delegate: BunLoopbackDelegate(), delegateQueue: nil)
        defer { local.finishTasksAndInvalidate() }
        guard let result: BackupReply = probe("\(loopback)/host/backups", token: token, session: local,
                                              method: "POST", status: 201, timeout: 120),
              Self.validBackupID(result.id) else { throw HostError("在线备份失败，请检查宿主状态和数据目录") }
        return backupFolder.appendingPathComponent(result.id, isDirectory: true)
    }

    public func backupFromCommand() throws -> URL {
        if healthProblem() == nil { return try backup() }
        guard fm.fileExists(atPath: data.appendingPathComponent("cattt.db").path) else {
            throw HostError("没有可备份的 SQLite 数据库")
        }
        try start()
        defer { stop() }
        try waitForHealth()
        return try backup()
    }

    private static func validBackupID(_ name: String) -> Bool {
        name.range(of: #"^cattt-[0-9]{8}T[0-9]{9}Z-[a-f0-9-]{36}$"#, options: .regularExpression) != nil
    }

    public func restore(_ source: URL) throws -> String {
        let id = source.lastPathComponent
        guard source.deletingLastPathComponent().standardizedFileURL.resolvingSymlinksInPath().path == backupFolder.path,
              Self.validBackupID(id) else { throw HostError("请选择本机备份文件夹中的 Cattt SQLite 备份") }
        if !isSupervising { try acquireLock() }

        stopChild()
        state = .restoring
        var committed = false
        var checkpoint: String?
        do {
            if pendingRestore { _ = try recoverInterruptedRestore(); stopChild() }
            let prepared = try recoveryCommand("prepare", id)
            checkpoint = prepared.recovery_id
            guard let generation = prepared.generation, let mode = prepared.database else {
                throw HostError("宿主未返回恢复世代")
            }
            try launch(restoreCheck: true)
            try waitForHealth(maintenance: true, generation: generation)
            _ = try recoveryCommand("finish")
            committed = true
            try activate(generation: generation)
            let message = mode == "retained_current" ? "恢复完成，保留操作前数据库中的较新记录" : "恢复完成，已从 SQLite 备份启动"
            return "\(message)。操作前备份 \(checkpoint ?? "")"
        } catch {
            let cause = String(describing: error)
            stopChild()
            if committed {
                stop()
                state = .failed("备份已安装并通过校验，恢复运行失败，服务已暂停。\(cause)")
                throw HostError(state.message)
            }
            var rolledBack = false
            do {
                if pendingRestore {
                    checkpoint = try recoverInterruptedRestore()
                    rolledBack = true
                } else {
                    try launch()
                    try waitForHealth()
                    state = .ready
                }
            } catch {
                stop()
                state = .failed("恢复失败，服务已暂停。操作前备份 \(checkpoint ?? "见备份文件夹")。\(cause)；\(error)")
                throw HostError(state.message)
            }
            let outcome = rolledBack ? "恢复失败，已回退并验证操作前服务。操作前备份 \(checkpoint ?? "")" : "已拒绝恢复，操作前服务已重新就绪"
            throw HostError("\(outcome)。\(cause)")
        }
    }

    private func recoverInterruptedRestore() throws -> String? {
        let rolledBack = try recoveryCommand("rollback")
        try launch(restoreCheck: true)
        try waitForHealth(maintenance: true)
        _ = try recoveryCommand("finish")
        try activate()
        return rolledBack.recovery_id
    }

    private func activate(generation: String? = nil) throws {
        guard let parentPipe else { throw HostError("恢复宿主控制通道未就绪") }
        try parentPipe.fileHandleForWriting.write(contentsOf: Data("activate\n".utf8))
        try waitForHealth(generation: generation)
        startupDeadline = nil
        attempts = 0
        state = .ready
    }

    private func waitForHealth(maintenance: Bool = false, generation: String? = nil) throws {
        let deadline = uptime + 15
        var problem = "宿主未就绪"
        while child?.isRunning == true && uptime < deadline {
            guard let failure = healthProblem(maintenance: maintenance, generation: generation) else { return }
            problem = failure
            Thread.sleep(forTimeInterval: 0.1)
        }
        throw HostError("\(problem)，请查看 logs/bun.log")
    }

    private func recoveryCommand(_ args: String...) throws -> RecoveryReply {
        let process = Process()
        let output = Pipe()
        process.executableURL = executable
        process.arguments = ["--restore-command"] + args
        process.currentDirectoryURL = data
        process.environment = ["CATTT_DATA_DIR": data.path, "PATH": "/usr/bin:/bin"]
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        try process.run()
        let response = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard let decoded = try? JSONDecoder().decode(RecoveryReply.self, from: response) else {
            throw HostError("Bun 未返回备份恢复状态")
        }
        guard process.terminationStatus == 0 else { throw HostError(decoded.error ?? "Bun 拒绝恢复") }
        return decoded
    }

    private struct Health: Decodable, Equatable {
        let ok: Bool
        let host_id: String
        let protocol_version: Int
    }

    private struct AdminStatus: Decodable {
        struct LAN: Decodable { let enabled: Bool; let port: UInt16 }
        let lan: LAN
        let host_id: String
        let ca_fingerprint: String
        let maintenance: Bool
        let sync_generation: String
        let peer_https_port: UInt16
    }

    private var loopback: String { "http://127.0.0.1:\(port)" }
    private var adminToken: String? { try? BunAdminClient.adminToken(in: data) }

    private func healthProblem(maintenance: Bool = false, generation: String? = nil) -> String? {
        let local = URLSession(configuration: .ephemeral, delegate: BunLoopbackDelegate(), delegateQueue: nil)
        defer { local.finishTasksAndInvalidate() }
        guard let health: Health = probe("\(loopback)/v2/healthz", session: local),
              health.ok, !health.host_id.isEmpty, health.protocol_version == 1 else { return "回环 API 未就绪" }
        guard let token = adminToken, !token.isEmpty,
              let admin: AdminStatus = probe("\(loopback)/host/status", token: token, session: local),
              admin.host_id == health.host_id, admin.lan.enabled, admin.lan.port == lanPort, admin.peer_https_port == peerPort,
              admin.maintenance == maintenance, !admin.sync_generation.isEmpty,
              generation == nil || admin.sync_generation == generation else { return "回环管理状态未通过检查" }
        guard let ca = try? String(contentsOf: data.appendingPathComponent("tls/ca.crt"), encoding: .utf8),
              let trust = HostTrustDelegate(ca), trust.fingerprint == admin.ca_fingerprint else { return "无法读取本机 HTTPS 证书" }
        let tls = URLSession(configuration: .ephemeral, delegate: trust, delegateQueue: nil)
        defer { tls.finishTasksAndInvalidate() }
        let secure: Health? = probe("https://127.0.0.1:\(lanPort)/v2/healthz", session: tls)
        return secure == health ? nil : "HTTPS 证书验证或健康检查失败"
    }

    private func probe<Value: Decodable>(_ url: String, token: String? = nil, session: URLSession,
                                         method: String = "GET", status: Int = 200, timeout: TimeInterval = 1) -> Value? {
        var request = URLRequest(url: URL(string: url)!, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = method
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let semaphore = DispatchSemaphore(value: 0)
        let result = ProbeResult<Value>()
        let task = session.dataTask(with: request) { data, response, _ in
            if (response as? HTTPURLResponse)?.statusCode == status, let data {
                result.value = try? JSONDecoder().decode(Value.self, from: data)
            }
            semaphore.signal()
        }
        task.resume()
        guard semaphore.wait(timeout: .now() + timeout + 1) == .success else { task.cancel(); return nil }
        return result.value
    }
}

private final class ProbeResult<Value>: @unchecked Sendable {
    // One producer writes before signaling. A timed-out reader never accesses the value.
    var value: Value?
}

final class BunLoopbackDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
