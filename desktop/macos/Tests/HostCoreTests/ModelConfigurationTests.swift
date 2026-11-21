import XCTest
@testable import HostCore

final class ModelConfigurationTests: XCTestCase {
    private let local = ["OPENAI_COMPAT_MODEL": "qwen2.5:7b"]
    private var both: [String: String] { local.merging(["MAOMAO_DEEPSEEK_API_KEY": "placeholder"]) { _, new in new } }

    func testBothAndPreservedOverrides() {
        let overrides = ["MODEL_PROVIDER": "deepseek", "OPENAI_COMPAT_BASE_URL": "http://localhost:1234/v1", "CHAT_MODEL": "custom-chat", "ROUTER_MODEL": "custom-router", "WORKER_MODEL": "custom-worker", "EXTRACT_MODEL": "custom-extract", "EXTRACT_PROVIDER": "openai-compatible", "MODEL_LOCAL_CONCURRENCY": "2", "MODEL_CLOUD_CONCURRENCY": "3", "OTHER": "keep"]
        let result = Host.combinedModelConfiguration(both.merging(overrides) { _, new in new })
        XCTAssertEqual(result["MODEL_PROVIDER"], "openai-compatible")
        XCTAssertEqual(result["OPENAI_COMPAT_MODEL"], "qwen2.5:7b")
        XCTAssertEqual(result["MAOMAO_DEEPSEEK_API_KEY"], "placeholder")
        for slot in ["CHAT", "ROUTER", "WORKER"] { XCTAssertEqual(result["\(slot)_PROVIDER"], "deepseek") }
        for (key, value) in overrides where key != "MODEL_PROVIDER" { XCTAssertEqual(result[key], value) }
        XCTAssertNil(result["EXTRACT_THINKING"])
        XCTAssertEqual(Host.combinedModelConfiguration(both)["OPENAI_COMPAT_BASE_URL"], "http://127.0.0.1:11434/v1")
    }
    func testSingleSourcesAndTransitions() {
        let mixed = Host.combinedModelConfiguration(both)
        var withoutKey = mixed; withoutKey.removeValue(forKey: "MAOMAO_DEEPSEEK_API_KEY")
        let onlyLocal = Host.combinedModelConfiguration(withoutKey)
        XCTAssertEqual(onlyLocal["MODEL_PROVIDER"], "openai-compatible")
        var withoutLocal = mixed; withoutLocal.removeValue(forKey: "OPENAI_COMPAT_MODEL")
        let onlyDeepSeek = Host.combinedModelConfiguration(withoutLocal)
        XCTAssertEqual(onlyDeepSeek["MODEL_PROVIDER"], "deepseek")
        for slot in ["CHAT", "ROUTER", "WORKER"] {
            XCTAssertNil(onlyLocal["\(slot)_PROVIDER"])
            XCTAssertNil(onlyDeepSeek["\(slot)_PROVIDER"])
        }
        XCTAssertEqual(Host.combinedModelConfiguration(onlyLocal.merging(["MAOMAO_DEEPSEEK_API_KEY": "placeholder"]) { _, new in new }), mixed)
        XCTAssertEqual(Host.combinedModelConfiguration(onlyDeepSeek.merging(local) { _, new in new }), mixed)
        XCTAssertEqual(Host.combinedModelConfiguration([:]), [:])
        XCTAssertEqual(Host.combinedModelConfiguration(["MODEL_PROVIDER": "mock"]), ["MODEL_PROVIDER": "mock"])
    }
    func testWritingKeyAndLocalSuccessPreserveEachOther() throws {
        let fm = FileManager.default, dir = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: dir) }
        let url = dir.appendingPathComponent("env")
        try Data("# 保留注释\nOPENAI_COMPAT_MODEL=qwen2.5:7b\nCHAT_PROVIDER=openai-compatible\nCHAT_MODEL=custom\nMODEL_LOCAL_CONCURRENCY=2\nOTHER=' a b '\n".utf8).write(to: url)
        try Host.writeDeepSeekConfiguration(" placeholder ", in: dir)
        let mixed = try Host.parseEnv(String(contentsOf: url))
        XCTAssertEqual(mixed["OPENAI_COMPAT_MODEL"], "qwen2.5:7b")
        XCTAssertEqual(mixed["MAOMAO_DEEPSEEK_API_KEY"], "placeholder")
        XCTAssertEqual(mixed["CHAT_PROVIDER"], "deepseek")
        XCTAssertEqual(mixed["CHAT_MODEL"], "custom"); XCTAssertEqual(mixed["MODEL_LOCAL_CONCURRENCY"], "2")
        XCTAssertEqual(mixed["OTHER"], " a b ")
        try Host.writeCombinedModelConfiguration(in: dir)
        XCTAssertEqual(try Host.parseEnv(String(contentsOf: url)), mixed)
        XCTAssertTrue(try String(contentsOf: url).contains("# 保留注释"))
        XCTAssertEqual((try fm.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        let before = try Data(contentsOf: url)
        XCTAssertThrowsError(try Host.writeDeepSeekConfiguration("\n", in: dir))
        XCTAssertThrowsError(try Host.writeDeepSeekConfiguration("x\ny", in: dir))
        XCTAssertEqual(try Data(contentsOf: url), before)
        try Data("not-env".utf8).write(to: url)
        XCTAssertThrowsError(try Host.writeCombinedModelConfiguration(in: dir))
        XCTAssertEqual(try String(contentsOf: url), "not-env")
    }
    func testSourceStatusAndHealth() {
        let mixed = Host.combinedModelConfiguration(both)
        XCTAssertEqual(Host.modelSourceStatus(mixed, httpStatus: 200), ["本地模型": "qwen2.5:7b（在线）·记忆 · 默认来源", "DeepSeek": "已配置·聊天/路由/后台处理"])
        XCTAssertTrue(Host.modelSourceStatus(mixed, httpStatus: 0)["本地模型"]!.contains("未启动"))
        XCTAssertTrue(Host.modelSourceStatus(mixed, httpStatus: 401)["本地模型"]!.contains("服务错误（401）"))
        XCTAssertTrue(Host.modelSourceStatus(mixed)["本地模型"]!.contains("检测中"))
        XCTAssertEqual(Host.modelSourceStatus([:])["DeepSeek"], "未配置")
        XCTAssertEqual(Host.modelSourceStatus([:])["本地模型"], "未配置 · 默认来源")
        XCTAssertEqual(Host.modelSourceStatus(["MODEL_PROVIDER": "deepseek", "MAOMAO_DEEPSEEK_API_KEY": "placeholder"])["DeepSeek"], "已配置·聊天/路由/后台处理/记忆 · 默认来源")
        let manual = mixed.merging(["MODEL_PROVIDER": "deepseek", "EXTRACT_MODEL": "different", "EXTRACT_PROVIDER": "openai-compatible"]) { _, new in new }
        XCTAssertNotNil(Host.modelHealthRequest(manual))
        XCTAssertTrue(Host.modelSourceStatus(manual, httpStatus: 200)["本地模型"]!.contains("记忆（different）"))
        let cloudMemory = mixed.merging(["EXTRACT_PROVIDER": "deepseek"]) { _, new in new }
        XCTAssertFalse(Host.modelSourceStatus(cloudMemory)["本地模型"]!.contains("记忆"))
        XCTAssertTrue(Host.modelSourceStatus(cloudMemory)["DeepSeek"]!.hasSuffix("/记忆"))
        let invalid = mixed.merging(["OPENAI_COMPAT_BASE_URL": "invalid"]) { _, new in new }
        XCTAssertTrue(Host.modelSourceStatus(invalid)["本地模型"]!.contains("服务地址无效"))
    }

    func testBundledMixedConfiguration() throws {
        let env = ProcessInfo.processInfo.environment
        guard let resources = env["CATTT_HYBRID_CHECK_RESOURCES"], let probePath = env["CATTT_HYBRID_MODEL_PROBE"], let root = env["CATTT_HYBRID_CHECK_DATA_ROOT"] else { throw XCTSkip("设置 CATTT_HYBRID_CHECK_RESOURCES、CATTT_HYBRID_MODEL_PROBE、CATTT_HYBRID_CHECK_DATA_ROOT 可运行实际混合配置启动检查") }
        let dir = URL(fileURLWithPath: root).appendingPathComponent("hybrid-\(UUID().uuidString.prefix(8))")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let url = dir.appendingPathComponent("env")
        try Data("OPENAI_COMPAT_MODEL=qwen2.5:7b\n".utf8).write(to: url)
        let host = Host(data: dir, resources: URL(fileURLWithPath: resources), version: "hybrid-check")
        defer { host.shutdown() }
        try host.start()
        try host.configureDeepSeek("placeholder")
        try host.completeLocalModelSetup()
        let configuration = try Host.parseEnv(String(contentsOf: url))
        XCTAssertEqual(configuration, Host.combinedModelConfiguration(both))
        let probe = Process(), output = Pipe()
        probe.executableURL = URL(fileURLWithPath: resources).appendingPathComponent("node/bin/node")
        probe.arguments = [probePath]; probe.environment = configuration
        probe.standardOutput = output; probe.standardError = output
        try probe.run()
        let text = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        probe.waitUntilExit()
        XCTAssertEqual(probe.terminationStatus, 0, text)
        XCTAssertTrue(text.contains("\"modelConfigProblems\":[]"), text)
        print(text.trimmingCharacters(in: .whitespacesAndNewlines))
        let deadline = Date().addingTimeInterval(30)
        repeat {
            host.tick()
            if host.status["API"] == "正常", host.status["worker"] == "队列正常" {
                print("混合配置：/healthz 200，API 与 worker 已启动；保存 key 与本地设置成功路径均已重启服务。数据：\(dir.path)")
                return
            }
            Thread.sleep(forTimeInterval: 0.25)
        } while Date() < deadline
        XCTFail("混合配置服务未就绪：\(host.status)，日志目录：\(dir.path)")
    }
}
