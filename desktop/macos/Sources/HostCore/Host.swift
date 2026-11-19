import Foundation
import Darwin

public struct HostError: Error, CustomStringConvertible {
    public let description: String
    public init(_ message: String) { description = message }
}

public final class Host {
    public let data: URL
    public let resources: URL
    public let version: String
    public private(set) var status: [String: String] = [:]
    private let fm = FileManager.default
    private var children: [String: Process] = [:]
    private var failures: [String: Int] = [:]
    private var retryAt: [String: Date] = [:]
    private var lockFD: Int32 = -1
    private var environment: [String: String] = [:]
    private var lastHealth = Date.distantPast
    private var lastBackup = Date.distantPast
    private var backupRetry = Date.distantPast
    private var ready = false

    public init(data: URL, resources: URL, version: String) {
        self.data = data; self.resources = resources; self.version = version
    }
    private func path(_ name: String) -> URL { data.appendingPathComponent(name) }
    private func pg(_ name: String) -> URL { resources.appendingPathComponent("postgres/bin/\(name)") }
    public static func parseEnv(_ text: String) throws -> [String: String] {
        var result: [String: String] = [:]
        for line in text.components(separatedBy: .newlines) {
            let line = line.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") { continue }
            guard let split = line.firstIndex(of: "="), split != line.startIndex else { throw HostError("env 格式错误") }
            let key = String(line[..<split]).trimmingCharacters(in: .whitespaces)
            guard key.range(of: "^[A-Za-z_][A-Za-z0-9_]*$", options: .regularExpression) != nil else { throw HostError("env 变量名错误") }
            var value = String(line[line.index(after: split)...]).trimmingCharacters(in: .whitespaces)
            if value.count >= 2 && ((value.hasPrefix("\"") && value.hasSuffix("\"")) || (value.hasPrefix("'") && value.hasSuffix("'"))) { value = String(value.dropFirst().dropLast()) }
            result[key] = value
        }
        return result
    }
    public static func backoff(_ failures: Int) -> TimeInterval { min(30, pow(2, Double(min(5, max(0, failures - 1))))) }
    public static func needsModelConfiguration(_ env: [String: String]) -> Bool {
        (env["MODEL_PROVIDER"] == nil || env["MODEL_PROVIDER"] == "deepseek") && (env["MAOMAO_DEEPSEEK_API_KEY"] ?? "").isEmpty
    }
    public static func newestRegularBackup(in directory: URL) throws -> Date? {
        let fm = FileManager.default
        return try fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey]).filter {
            $0.lastPathComponent.hasPrefix("cattt-") && !$0.lastPathComponent.hasSuffix("-pre-upgrade") && !$0.lastPathComponent.hasSuffix(".incomplete") && fm.fileExists(atPath: $0.appendingPathComponent("db.dump").path)
        }.compactMap { try $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate }.max()
    }
    public static func writeDeepSeekConfiguration(_ key: String, in data: URL) throws {
        let key = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty, !key.contains("\n"), !key.contains("\r") else { throw HostError("请输入有效的 DeepSeek key") }
        let url = data.appendingPathComponent("env")
        let original = try String(contentsOf: url)
        _ = try parseEnv(original)
        let kept = original.components(separatedBy: .newlines).filter {
            let name = $0.components(separatedBy: "=").first?.trimmingCharacters(in: .whitespaces)
            return name != "MODEL_PROVIDER" && name != "MAOMAO_DEEPSEEK_API_KEY"
        }
        let text = kept.joined(separator: "\n") + "\nMODEL_PROVIDER=deepseek\nMAOMAO_DEEPSEEK_API_KEY=\(key)\n"
        try Data(text.utf8).write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
    public func configureDeepSeek(_ key: String) throws {
        guard ready else { throw HostError("宿主未能启动，请先解决菜单中的启动错误") }
        try Self.writeDeepSeekConfiguration(key, in: data)
        let key = key.trimmingCharacters(in: .whitespacesAndNewlines)
        environment["MODEL_PROVIDER"] = "deepseek"; environment["MAOMAO_DEEPSEEK_API_KEY"] = key
        stopServices(); try startServices()
    }
    public static func requireAvailablePort(_ port: UInt16) throws {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw HostError("无法检查端口 \(port)") }
        defer { close(fd) }
        var reuse: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))
        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET); address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_port = port.bigEndian; address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let result = withUnsafePointer(to: &address) { ptr in ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        guard result == 0 else { throw HostError("端口 \(port) 已被占用，请退出其他服务后重试") }
    }
    public static func rotate(_ url: URL, limit: UInt64 = 10 * 1024 * 1024) throws {
        let fm = FileManager.default
        guard let size = try? fm.attributesOfItem(atPath: url.path)[.size] as? UInt64, size >= limit else { return }
        let old = url.appendingPathExtension("1")
        if fm.fileExists(atPath: old.path) { try fm.removeItem(at: old) }
        try fm.moveItem(at: url, to: old)
    }
    private func log(_ text: String) {
        let url = path("logs/host.log")
        try? Self.rotate(url)
        if !fm.fileExists(atPath: url.path) { fm.createFile(atPath: url.path, contents: nil) }
        if let handle = try? FileHandle(forWritingTo: url) {
            _ = try? handle.seekToEnd(); try? handle.write(contentsOf: Data("\(Date()) \(text)\n".utf8)); try? handle.close()
        }
        print(text)
    }
    private func launch(_ executable: URL, _ args: [String], name: String) throws -> Process {
        let process = Process()
        process.executableURL = executable; process.arguments = args
        process.environment = environment; process.currentDirectoryURL = data
        let url = path("logs/\(name).log")
        try Self.rotate(url)
        if !fm.fileExists(atPath: url.path) { fm.createFile(atPath: url.path, contents: nil) }
        let handle = try FileHandle(forWritingTo: url); try handle.seekToEnd()
        process.standardOutput = handle; process.standardError = handle
        try process.run(); try handle.close()
        return process
    }
    @discardableResult private func run(_ executable: URL, _ args: [String], name: String = "host") throws -> Int32 {
        let process = try launch(executable, args, name: name)
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw HostError("\(executable.lastPathComponent) 失败（\(process.terminationStatus)），请查看 logs/\(name).log") }
        return process.terminationStatus
    }
    private func secret(_ name: String) throws -> String {
        let url = path(name)
        if !fm.fileExists(atPath: url.path) {
            try Data(UUID().uuidString.replacingOccurrences(of: "-", with: "").utf8).write(to: url, options: .atomic)
        }
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        return try String(contentsOf: url).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private func sql(_ statement: String) throws {
        try run(pg("psql"), ["-h", "127.0.0.1", "-p", "54329", "-U", "cattt", "-d", "cattt", "-v", "ON_ERROR_STOP=1", "-c", statement])
    }
    public func start() throws {
        try fm.createDirectory(at: data, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        lockFD = open(path("host.lock").path, O_CREAT | O_RDWR, 0o600)
        guard lockFD >= 0, flock(lockFD, LOCK_EX | LOCK_NB) == 0 else { throw HostError("宿主已经运行") }
        try Self.requireAvailablePort(8787)
        for folder in ["logs", "backups", "run", "tls"] { try fm.createDirectory(at: path(folder), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]) }
        lastBackup = try Self.newestRegularBackup(in: path("backups")) ?? .distantPast
        if !fm.fileExists(atPath: path("env").path) { try Data().write(to: path("env")) }
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path("env").path)
        environment = ["PATH": "/usr/bin:/bin", "HOME": NSHomeDirectory()]
        environment.merge(try Self.parseEnv(String(contentsOf: path("env")))) { _, new in new }
        let password = try secret("pg-password")
        environment.merge(["DATABASE_URL": "postgres://cattt:\(password)@127.0.0.1:54329/cattt", "PGPASSWORD": password,
                           "CATTT_DATA_DIR": data.path, "HOST": "127.0.0.1", "PORT": "8787", "LAN_HTTPS_HOST": "0.0.0.0", "LAN_HTTPS_PORT": "8788", "NODE_ENV": "production"]) { _, new in new }
        if fm.fileExists(atPath: path("pg/PG_VERSION").path) {
            guard try String(contentsOf: path("pg/PG_VERSION")).trimmingCharacters(in: .whitespacesAndNewlines) == "17" else { throw HostError("数据库版本不匹配") }
        } else {
            guard !fm.fileExists(atPath: path("pg").path) else { throw HostError("数据库目录不完整") }
            if fm.fileExists(atPath: path("pg.initializing").path) { try fm.removeItem(at: path("pg.initializing")) }
            try run(pg("initdb"), ["-D", path("pg.initializing").path, "-U", "cattt", "--auth=scram-sha-256", "--pwfile", path("pg-password").path, "-E", "UTF8", "--locale=C"])
            try fm.moveItem(at: path("pg.initializing"), to: path("pg"))
        }
        try startPostgres()
        let dbCheck = try launch(pg("psql"), ["-h", "127.0.0.1", "-p", "54329", "-U", "cattt", "-d", "cattt", "-c", "SELECT 1"], name: "host")
        dbCheck.waitUntilExit()
        if dbCheck.terminationStatus != 0 { try run(pg("createdb"), ["-h", "127.0.0.1", "-p", "54329", "-U", "cattt", "cattt"]) }
        let previous = (try? String(contentsOf: path("host-state.json"))).flatMap { $0.data(using: .utf8) }.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: String] }
        if previous?["lastVersion"] != version {
            let probe = try launch(pg("psql"), ["-h", "127.0.0.1", "-p", "54329", "-U", "cattt", "-d", "cattt", "-tAc", "SELECT 1 / CASE WHEN EXISTS(SELECT FROM pg_tables WHERE schemaname='public') THEN 1 ELSE 0 END"], name: "host")
            probe.waitUntilExit()
            if probe.terminationStatus == 0 { _ = try backup(preUpgrade: true) }
        }
        try run(resources.appendingPathComponent("node/bin/node"), [resources.appendingPathComponent("server/migrate.mjs").path])
        try JSONSerialization.data(withJSONObject: ["lastVersion": version]).write(to: path("host-state.json"), options: .atomic)
        ready = true
        try startServices()
        log("宿主已启动 \(version)")
    }
    private func startPostgres() throws {
        children["postgres"] = try launch(pg("postgres"), ["-D", path("pg").path, "-c", "listen_addresses=127.0.0.1", "-p", "54329", "-c", "unix_socket_directories=\(path("run").path)"], name: "postgres")
        for _ in 0..<120 {
            guard children["postgres"]?.isRunning == true else { throw HostError("数据库启动失败") }
            let probe = try launch(pg("pg_isready"), ["-h", "127.0.0.1", "-p", "54329"], name: "host")
            probe.waitUntilExit()
            if probe.terminationStatus == 0 { status["数据库"] = "正常"; return }
            Thread.sleep(forTimeInterval: 0.25)
        }
        throw HostError("数据库启动超时")
    }
    private func startServices() throws {
        guard !Self.needsModelConfiguration(environment) else {
            status["API"] = "需要配置模型"; status["worker"] = "需要配置模型"; return
        }
        for name in ["api", "worker"] where children[name]?.isRunning != true {
            children[name] = try launch(resources.appendingPathComponent("node/bin/node"), [resources.appendingPathComponent("server/\(name).mjs").path], name: name)
            status[name == "api" ? "API" : name] = "启动中"
        }
    }
    public func tick() {
        guard ready else { return }
        for name in ["postgres", "api", "worker"] {
            guard let child = children[name], !child.isRunning else { continue }
            status[name == "postgres" ? "数据库" : name == "api" ? "API" : name] = "已退出，等待重启"
            if retryAt[name] == nil {
                failures[name, default: 0] += 1
                retryAt[name] = Date().addingTimeInterval(Self.backoff(failures[name]!))
                log("\(name) 已退出，准备重启")
            }
            guard Date() >= retryAt[name]! else { continue }
            do {
                if name == "postgres" { stopServices(); try startPostgres(); try startServices() }
                else if children["postgres"]?.isRunning == true { try startServices() }
                retryAt[name] = nil
            } catch { log(String(describing: error)); retryAt[name] = Date().addingTimeInterval(30) }
        }
        for name in ["postgres", "api", "worker"] {
            let url = path("logs/\(name).log")
            if let size = try? fm.attributesOfItem(atPath: url.path)[.size] as? UInt64, size >= 10 * 1024 * 1024 {
                if let child = children[name], child.isRunning { stop(child, signal: name == "postgres" ? SIGINT : SIGTERM) }
                try? Self.rotate(url)
            }
        }
        if Date().timeIntervalSince(lastBackup) >= 86400 && Date() >= backupRetry {
            do { _ = try backup() } catch { log("备份失败：\(error)"); backupRetry = Date().addingTimeInterval(300) }
        }
        if Date().timeIntervalSince(lastHealth) >= 5 { lastHealth = Date(); pollHealth() }
    }
    private func pollHealth() {
        if status["API"] == "需要配置模型" {
            status["局域网 HTTPS"] = "需要配置模型"
            return
        }
        for endpoint in ["healthz", "host/status"] {
            var request = URLRequest(url: URL(string: "http://127.0.0.1:8787/\(endpoint)")!); request.timeoutInterval = 2
            if endpoint == "host/status", let token = try? String(contentsOf: path("host-admin.token")) {
                request.setValue("Bearer \(token.trimmingCharacters(in: .whitespacesAndNewlines))", forHTTPHeaderField: "Authorization")
            }
            let semaphore = DispatchSemaphore(value: 0)
            var code = 0
            let task = URLSession.shared.dataTask(with: request) { _, response, _ in code = (response as? HTTPURLResponse)?.statusCode ?? 0; semaphore.signal() }
            task.resume(); semaphore.wait()
            status[endpoint == "healthz" ? "API" : "局域网 HTTPS"] = code == 200 ? "正常" : code == 404 ? "此版本不支持" : "未就绪"
        }
        status["worker"] = children["worker"]?.isRunning == true ? "运行中" : status["worker"]
    }
    @discardableResult public func backup(preUpgrade: Bool = false) throws -> URL {
        let formatter = DateFormatter(); formatter.dateFormat = "yyyyMMdd-HHmmss-SSS"
        let dest = path("backups/cattt-\(formatter.string(from: Date()))\(preUpgrade ? "-pre-upgrade" : "")")
        let staging = dest.appendingPathExtension("incomplete")
        try fm.createDirectory(at: staging, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        do {
            try run(pg("pg_dump"), ["-h", "127.0.0.1", "-p", "54329", "-U", "cattt", "-d", "cattt", "-Fc", "-f", staging.appendingPathComponent("db.dump").path])
            for name in ["tls", "host-admin.token", "env"] where fm.fileExists(atPath: path(name).path) { try fm.copyItem(at: path(name), to: staging.appendingPathComponent(name)) }
            try fm.moveItem(at: staging, to: dest)
        } catch { try? fm.removeItem(at: staging); throw error }
        for kind in [false, true] {
            let entries = try fm.contentsOfDirectory(at: path("backups"), includingPropertiesForKeys: nil).filter { $0.lastPathComponent.hasPrefix("cattt-") && !$0.lastPathComponent.hasSuffix(".incomplete") && $0.lastPathComponent.hasSuffix("-pre-upgrade") == kind }.sorted { $0.lastPathComponent > $1.lastPathComponent }
            for old in entries.dropFirst(kind ? 3 : 7) { try fm.removeItem(at: old) }
        }
        if !preUpgrade { lastBackup = Date() }
        log("备份完成：\(dest.path)"); return dest
    }
    public func restore(_ source: URL) throws {
        guard fm.fileExists(atPath: source.appendingPathComponent("db.dump").path), source.standardizedFileURL != data.standardizedFileURL else { throw HostError("备份无效") }
        _ = try backup(preUpgrade: true)
        stopServices()
        try sql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='cattt' AND pid<>pg_backend_pid()")
        try run(pg("pg_restore"), ["-h", "127.0.0.1", "-p", "54329", "-U", "cattt", "-d", "postgres", "--clean", "--if-exists", "--create", "--exit-on-error", source.appendingPathComponent("db.dump").path])
        for name in ["tls", "host-admin.token", "env"] {
            let from = source.appendingPathComponent(name)
            if fm.fileExists(atPath: path(name).path) { try fm.removeItem(at: path(name)) }
            if fm.fileExists(atPath: from.path) { try fm.copyItem(at: from, to: path(name)) }
        }
        log("恢复完成；重新启动以加载配置")
        shutdown()
        try start()
    }
    private func stop(_ process: Process, signal: Int32 = SIGTERM) {
        guard process.isRunning else { return }
        kill(process.processIdentifier, signal)
        let deadline = Date().addingTimeInterval(25)
        while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        process.waitUntilExit()
    }
    private func stopServices() { for name in ["api", "worker"] { if let child = children.removeValue(forKey: name) { stop(child) } } }
    public func shutdown() {
        ready = false; stopServices()
        if let child = children.removeValue(forKey: "postgres") { stop(child, signal: SIGINT) }
        if lockFD >= 0 { flock(lockFD, LOCK_UN); close(lockFD); lockFD = -1 }
    }
    deinit { shutdown() }
}
