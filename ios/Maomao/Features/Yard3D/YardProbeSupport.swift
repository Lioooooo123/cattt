import Foundation

/// 不依赖 WebKit 的单次完成与落盘核心，供命令行回归测试使用。
@MainActor
final class YardDeadline<Value> {
    private var continuation: CheckedContinuation<Value, Error>?
    private var timer: Task<Void, Never>?
    private init(_ continuation: CheckedContinuation<Value, Error>) { self.continuation = continuation }

    static func perform(seconds: Double, operation: (@escaping (Result<Value, Error>) -> Void) -> Void) async throws -> Value {
        try await withCheckedThrowingContinuation { continuation in
            let gate = YardDeadline(continuation)
            // 保持 gate 到超时或真正回调；完成后 continuation 清空，迟到回调无副作用。
            let timeoutGate = gate
            gate.timer = Task {
                do { try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }
                catch { return }
                timeoutGate.resolve(.failure(YardProbeError.timeout))
            }
            operation { result in gate.resolve(result) }
        }
    }

    private func resolve(_ result: Result<Value, Error>) {
        guard let continuation else { return }
        self.continuation = nil
        timer?.cancel(); timer = nil
        continuation.resume(with: result)
    }
}

enum YardProbeError: Error { case timeout, stopped, invalidResponse }

struct YardProbeIdentity {
    var runID: String
    var pageID: String
    func accepts(_ message: [String: Any]) -> Bool {
        message["runId"] as? String == runID && message["pageId"] as? String == pageID
    }
}

struct YardVisualGate {
    private(set) var pageID = ""
    private(set) var isVisible = true
    private(set) var failure: String?
    private var recoverableFailure = false
    private var commandedActive: Bool?

    func allowsCommands(ready: Bool) -> Bool { ready && !isVisible }

    func allowsLifecycle(ready: Bool, active: Bool) -> Bool {
        ready && (!isVisible || (commandedActive != nil && commandedActive != active))
    }

    func needsWatchdogFailure(active: Bool) -> Bool { active && isVisible }

    mutating func sentActive(_ active: Bool) { commandedActive = active }

    mutating func fail(_ reason: String, recoverable: Bool) {
        if failure != nil && !recoverableFailure { return }
        failure = reason
        recoverableFailure = recoverable
    }

    mutating func begin(pageID: String) {
        self.pageID = pageID
        isVisible = true
        failure = nil
        recoverableFailure = false
        commandedActive = nil
    }

    mutating func cover(pageID: String) {
        guard pageID == self.pageID else { return }
        isVisible = true
    }

    @discardableResult
    mutating func reveal(pageID: String) -> Bool {
        guard pageID == self.pageID else { return false }
        isVisible = false
        if recoverableFailure { failure = nil; recoverableFailure = false }
        return true
    }
}

enum YardProbeArchive {
    /// 抛出失败，不允许调用者在失败路径宣称已保存。
    static func save(_ record: [String: Any], directory: URL, name: String,
                     writer: (Data, URL) throws -> Void = { try $0.write(to: $1, options: .atomic) }) throws -> URL {
        let data = try JSONSerialization.data(withJSONObject: record, options: [.prettyPrinted, .sortedKeys])
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent(name).appendingPathExtension("json")
        try writer(data, file)
        return file
    }
}
