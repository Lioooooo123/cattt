import XCTest
@testable import HostCore

final class ModelSetupTests: XCTestCase {
    private func parse(_ text: String) throws -> ModelSetupEvent { try ModelSetupEvent.parse(Data(text.utf8)) }
    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
    private func runner(_ source: String, in data: URL) throws -> ModelSetupRunner {
        let script = data.appendingPathComponent("setup.sh")
        try Data(source.utf8).write(to: script)
        return ModelSetupRunner(executable: URL(fileURLWithPath: "/bin/sh"), script: script, data: data)
    }
    func testRecommendationAndProgress() throws {
        let sample = #"{"event":"硬件与推荐","hardware":{"platform":"darwin","arch":"arm64","appleSilicon":true,"totalMemGB":16,"cpuModel":"Apple M4 Pro","cpuCores":8},"recommendation":{"kind":"local","model":"qwen2.5:7b","sizeGB":4.7,"reason":"按统一内存推荐"},"selectedModel":"qwen2.5:7b"}"#
        guard case .recommendation(let hardware, let recommendation, let selected) = try parse(sample) else { return XCTFail("应解析推荐") }
        XCTAssertTrue(hardware.appleSilicon); XCTAssertEqual(hardware.totalMemGB, 16)
        XCTAssertEqual(recommendation.sizeGB, 4.7); XCTAssertEqual(selected, "qwen2.5:7b")
        guard case .progress(let progress) = try parse(#"{"event":"下载进度","progress":{"status":"pulling digest","digest":"sha256:abc","total":100,"completed":25}}"#) else { return XCTFail("应解析进度") }
        XCTAssertEqual(progress.fraction, 0.25)
        guard case .progress(let initial) = try parse(#"{"event":"下载进度","progress":{"status":"pulling manifest"}}"#) else { return XCTFail("应解析无大小进度") }
        XCTAssertNil(initial.fraction)
        guard case .recommendation(_, let fallback, let model) = try parse(#"{"event":"硬件与推荐","hardware":{"appleSilicon":false,"totalMemGB":4,"cpuModel":"CPU"},"recommendation":{"kind":"deepseek","reason":"硬件不够"}}"#) else { return XCTFail("应解析云模型建议") }
        XCTAssertEqual(fallback.kind, "deepseek"); XCTAssertNil(model)
    }
    func testSmokeSavedAndErrors() throws {
        guard case .smoke(let smoke) = try parse(#"{"event":"烟测","model":"qwen2.5:7b","passed":true,"chinese":true,"correctTool":true,"latencyMs":100,"chatLatencyMs":40,"toolLatencyMs":60}"#) else { return XCTFail("应解析烟测") }
        XCTAssertTrue(smoke.passed); XCTAssertEqual(smoke.correctTool, true)
        guard case .smoke(let failed) = try parse(#"{"event":"烟测","model":"qwen2.5:7b","passed":false,"latencyMs":180000,"error":"模型请求失败或超时，烟测未通过。"}"#) else { return XCTFail("应解析超时") }
        XCTAssertFalse(failed.passed); XCTAssertNil(failed.chinese)
        guard case .saved(let path) = try parse(#"{"event":"配置已保存","path":"/data/env","mode":"0600"}"#) else { return XCTFail("应解析保存") }
        XCTAssertEqual(path, "/data/env")
        guard case .failure(let reason, let needsOllama) = try parse(#"{"event":"连接失败","reason":"请安装并启动 Ollama"}"#) else { return XCTFail("应解析连接失败") }
        XCTAssertTrue(needsOllama); XCTAssertEqual(reason, "请安装并启动 Ollama")
        for event in ["未通过", "设置失败"] {
            let line = try JSONSerialization.data(withJSONObject: ["event": event, "reason": "失败原因", "suggestion": "可用 DeepSeek"])
            guard case .failure(let message, let needs) = try ModelSetupEvent.parse(line) else { return XCTFail("应解析失败") }
            XCTAssertFalse(needs); XCTAssertTrue(message.contains("可用 DeepSeek"))
        }
        guard case .stopped = try parse(#"{"event":"已停止","reason":"未获同意，没有下载或修改配置。"}"#) else { return XCTFail("应解析停止") }
        guard case .unknown("未来事件") = try parse(#"{"event":"未来事件","extra":true}"#) else { return XCTFail("应容忍未知事件") }
        XCTAssertThrowsError(try parse("")); XCTAssertThrowsError(try parse("not json"))
        XCTAssertThrowsError(try parse(#"{"event":"硬件与推荐"}"#))
    }
    func testSavedEventNotExitCodeAndFinalLine() throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let saved = try runner("printf '{\"event\":\"配置已保存\",\"path\":\"%s\"}' \"$3\"\nexit 4\n", in: dir)
        XCTAssertEqual(try saved.run(environment: [:], consent: true) { _ in }, .saved)
        let stopped = try runner("exit 0\n", in: dir)
        XCTAssertEqual(try stopped.run(environment: [:], consent: false) { _ in }, .stopped)
        let failed = try runner("exit 1\n", in: dir)
        XCTAssertEqual(try failed.run(environment: [:], consent: true) { _ in }, .failed)
    }
    func testCancelRestoresEnvAndPermissions() throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let env = dir.appendingPathComponent("env"), original = Data("MODEL_PROVIDER=deepseek\nMAOMAO_DEEPSEEK_API_KEY=test\n".utf8)
        try original.write(to: env)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: env.path)
        let process = try runner("printf 'changed' > \"$3\"\nprintf '{\"event\":\"下载进度\",\"progress\":{\"status\":\"pulling\"}}\\n'\nexec /bin/sleep 30\n", in: dir)
        let result = try process.run(environment: [:], consent: true) { _ in process.cancel() }
        XCTAssertEqual(result, .cancelled); XCTAssertEqual(try Data(contentsOf: env), original)
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: env.path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)
    }
    func testCancelBeforeLaunch() throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let process = try runner("exit 9\n", in: dir); process.cancel()
        XCTAssertEqual(try process.run(environment: [:], consent: true) { _ in XCTFail("取消后不应启动") }, .cancelled)
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("env").path))
    }
    func testFirstPromptAndOllamaRequest() throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let state = dir.appendingPathComponent("host-state.json")
        try Data(#"{"lastVersion":"1.2.3"}"#.utf8).write(to: state)
        XCTAssertFalse(Host.needsLocalModelSetup(["MODEL_PROVIDER": "mock"]))
        XCTAssertFalse(Host.needsLocalModelSetup(["OPENAI_COMPAT_MODEL": "local"]))
        XCTAssertFalse(Host.needsLocalModelSetup(["MAOMAO_DEEPSEEK_API_KEY": "test"]))
        XCTAssertTrue(try Host.claimModelSetupPrompt(in: dir, environment: [:]))
        XCTAssertFalse(try Host.claimModelSetupPrompt(in: dir, environment: [:]))
        let values = try JSONDecoder().decode([String: String].self, from: Data(contentsOf: state))
        XCTAssertEqual(values["lastVersion"], "1.2.3"); XCTAssertEqual(values["modelSetupPrompted"], "true")
        let request = ModelSetupRunner.ollamaRequest(["OPENAI_COMPAT_BASE_URL": "http://localhost:1234/v1/", "MAOMAO_OPENAI_COMPAT_API_KEY": "test"])
        XCTAssertEqual(request?.url?.absoluteString, "http://localhost:1234/api/tags")
        XCTAssertEqual(request?.value(forHTTPHeaderField: "Authorization"), "Bearer test")
        XCTAssertEqual(request?.timeoutInterval, 3)
        XCTAssertNil(ModelSetupRunner.ollamaRequest(["OPENAI_COMPAT_BASE_URL": "invalid"]))
    }
    func testBundledConnectionFailure() throws {
        guard let resources = ProcessInfo.processInfo.environment["CATTT_MODEL_SETUP_RESOURCES"] else { throw XCTSkip("设置 CATTT_MODEL_SETUP_RESOURCES 可验证实际 bundle") }
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let env = dir.appendingPathComponent("env"), original = Data("# 不修改\n".utf8)
        try original.write(to: env)
        let runner = ModelSetupRunner(resources: URL(fileURLWithPath: resources), data: dir)
        var connectedFailure = false, detectedAppleSilicon = false
        let outcome = try runner.run(environment: ["PATH": "/usr/bin:/bin", "HOME": NSHomeDirectory(), "OPENAI_COMPAT_BASE_URL": "http://127.0.0.1:1/v1"], consent: true, model: "qwen2.5:7b") { event in
            if case .failure(let reason, let needsOllama) = event {
                connectedFailure = needsOllama
                print("Bundled setup: 连接失败，needsOllama=\(needsOllama)，\(reason)")
            }
            if case .recommendation(let hardware, _, _) = event { detectedAppleSilicon = hardware.appleSilicon }
        }
        XCTAssertEqual(outcome, .failed); XCTAssertTrue(connectedFailure); XCTAssertTrue(detectedAppleSilicon)
        XCTAssertEqual(try Data(contentsOf: env), original)
    }
}
