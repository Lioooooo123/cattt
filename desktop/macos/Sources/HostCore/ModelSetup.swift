import Foundation

public struct SetupHardware: Decodable {
    public let cpuModel: String
    public let totalMemGB: Double
    public let appleSilicon: Bool
}
public struct SetupRecommendation: Decodable {
    public let kind: String
    public let model: String?
    public let sizeGB: Double?
    public let reason: String
}
public struct SetupProgress: Decodable {
    public let status: String?
    public let completed: Double?
    public let total: Double?
    public var fraction: Double? {
        guard let completed, let total, total > 0 else { return nil }
        return min(1, max(0, completed / total))
    }
}
public struct SetupSmoke: Decodable {
    public let model: String
    public let passed: Bool
    public let chinese: Bool?
    public let correctTool: Bool?
    public let error: String?
}
public enum ModelSetupEvent: Decodable {
    case recommendation(SetupHardware, SetupRecommendation, selectedModel: String?)
    case progress(SetupProgress)
    case smoke(SetupSmoke)
    case saved(path: String)
    case failure(reason: String, needsOllama: Bool)
    case stopped(reason: String)
    case unknown(String)

    private enum Key: String, CodingKey { case event, hardware, recommendation, selectedModel, progress, path, reason, suggestion }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        let event = try c.decode(String.self, forKey: .event)
        switch event {
        case "硬件与推荐": self = .recommendation(try c.decode(SetupHardware.self, forKey: .hardware), try c.decode(SetupRecommendation.self, forKey: .recommendation), selectedModel: try c.decodeIfPresent(String.self, forKey: .selectedModel))
        case "下载进度": self = .progress(try c.decode(SetupProgress.self, forKey: .progress))
        case "烟测": self = .smoke(try SetupSmoke(from: decoder))
        case "配置已保存": self = .saved(path: try c.decode(String.self, forKey: .path))
        case "连接失败", "未通过", "设置失败":
            let reason = try c.decode(String.self, forKey: .reason)
            let suggestion = try c.decodeIfPresent(String.self, forKey: .suggestion)
            self = .failure(reason: [reason, suggestion].compactMap { $0 }.joined(separator: "\n"), needsOllama: event == "连接失败")
        case "已停止": self = .stopped(reason: try c.decode(String.self, forKey: .reason))
        default: self = .unknown(event)
        }
    }
    public static func parse(_ line: Data) throws -> ModelSetupEvent { try JSONDecoder().decode(Self.self, from: line) }
}

public enum ModelSetupOutcome: Equatable { case saved, stopped, failed, cancelled }

public final class ModelSetupRunner {
    private let executable: URL
    private let script: URL
    private let data: URL
    private let lock = NSLock()
    private var process: Process?
    private var cancelled = false

    public convenience init(resources: URL, data: URL) {
        self.init(executable: resources.appendingPathComponent("node/bin/node"), script: resources.appendingPathComponent("server/model-setup.mjs"), data: data)
    }
    public init(executable: URL, script: URL, data: URL) {
        self.executable = executable; self.script = script; self.data = data
    }
    public func cancel() {
        lock.lock(); defer { lock.unlock() }
        cancelled = true
        if process?.isRunning == true { process?.terminate() }
    }
    private var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }

    public static func ollamaRequest(_ env: [String: String]) -> URLRequest? {
        var base = env["OPENAI_COMPAT_BASE_URL"] ?? "http://127.0.0.1:11434/v1"
        while base.hasSuffix("/") { base.removeLast() }
        if base.hasSuffix("/v1") { base = String(base.dropLast(3)) }
        guard let url = URL(string: base), ["http", "https"].contains(url.scheme), url.host != nil else { return nil }
        var request = URLRequest(url: url.appendingPathComponent("api/tags")); request.timeoutInterval = 3
        if let key = env["MAOMAO_OPENAI_COMPAT_API_KEY"], !key.isEmpty { request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization") }
        return request
    }

    public func run(environment: [String: String], consent: Bool, model: String? = nil, onEvent: (ModelSetupEvent) -> Void) throws -> ModelSetupOutcome {
        if isCancelled { return .cancelled }
        let envURL = data.appendingPathComponent("env")
        let existed = FileManager.default.fileExists(atPath: envURL.path)
        let original = existed ? try Data(contentsOf: envURL) : nil
        let permissions = existed ? try FileManager.default.attributesOfItem(atPath: envURL.path)[.posixPermissions] : nil
        let child = Process(), output = Pipe()
        child.executableURL = executable
        child.arguments = [script.path, "--json", "--env-file", envURL.path] + (consent ? ["--yes"] : []) + (model.map { ["--model", $0] } ?? [])
        var env = environment
        env["PATH"] = (env["PATH"] ?? "/usr/bin:/bin") + ":/usr/sbin:/sbin"
        child.environment = env; child.currentDirectoryURL = data
        child.standardInput = FileHandle.nullDevice; child.standardOutput = output; child.standardError = FileHandle.nullDevice
        lock.lock()
        if cancelled { lock.unlock(); return .cancelled }
        do { try child.run(); process = child; lock.unlock() }
        catch { lock.unlock(); throw error }
        defer {
            lock.lock(); process = nil; lock.unlock()
            try? output.fileHandleForReading.close()
        }
        var saved = false, buffer = Data()
        func consume(_ line: Data) {
            guard !line.isEmpty else { return }
            guard let event = try? ModelSetupEvent.parse(line) else { return }
            if case .saved(let path) = event, path == envURL.path { saved = true }
            if !isCancelled { onEvent(event) }
        }
        while true {
            let chunk = output.fileHandleForReading.availableData
            if chunk.isEmpty { break }
            buffer.append(chunk)
            while let end = buffer.firstIndex(of: 10) {
                consume(Data(buffer[..<end])); buffer.removeSubrange(...end)
            }
        }
        if !buffer.isEmpty { consume(buffer) }
        child.waitUntilExit()
        if isCancelled {
            if let original {
                try original.write(to: envURL, options: .atomic)
                if let permissions { try FileManager.default.setAttributes([.posixPermissions: permissions], ofItemAtPath: envURL.path) }
            } else if FileManager.default.fileExists(atPath: envURL.path) { try FileManager.default.removeItem(at: envURL) }
            return .cancelled
        }
        if saved { return .saved }
        return child.terminationStatus == 0 ? .stopped : .failed
    }
}
