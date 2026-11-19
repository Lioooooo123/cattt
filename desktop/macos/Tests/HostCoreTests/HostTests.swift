import XCTest
@testable import HostCore

final class HostTests: XCTestCase {
    func testModelConfigurationWarning() {
        XCTAssertEqual(Host.modelStatus([:]), "本地 · 127.0.0.1:11434/未配置模型名")
        XCTAssertEqual(Host.modelStatus(["MAOMAO_DEEPSEEK_API_KEY": "test"]), Host.modelStatus([:]))
        XCTAssertEqual(Host.modelStatus(["MODEL_PROVIDER": "deepseek"]), "DeepSeek · 未配置密钥")
        XCTAssertEqual(Host.modelStatus(["MODEL_PROVIDER": "deepseek", "MAOMAO_DEEPSEEK_API_KEY": "test"]), "DeepSeek · 已配置")
        XCTAssertEqual(Host.modelStatus(["MODEL_PROVIDER": "mock"]), "测试模式")
        let env = ["MODEL_PROVIDER": "openai-compatible", "OPENAI_COMPAT_BASE_URL": "http://localhost:1234/v1/", "OPENAI_COMPAT_MODEL": "local-model", "MAOMAO_OPENAI_COMPAT_API_KEY": "test"]
        XCTAssertEqual(Host.modelStatus(env, httpStatus: 200), "本地 · localhost:1234/local-model")
        XCTAssertEqual(Host.modelStatus(env, httpStatus: 0), "本地服务未启动 · localhost:1234/local-model")
        XCTAssertEqual(Host.modelStatus(env, httpStatus: 401), "本地服务返回错误（401） · localhost:1234/local-model")
        XCTAssertEqual(Host.modelStatus(env.merging(["CHAT_MODEL": "chat-model"]) { _, new in new }), "本地 · localhost:1234/chat-model")
        XCTAssertEqual(Host.modelStatus(["OPENAI_COMPAT_BASE_URL": "bad"]), "本地 · 服务地址无效")
        XCTAssertEqual(Host.modelStatus(["MODEL_PROVIDER": "invalid"]), "来源无效")
        let request = Host.modelHealthRequest(env)
        XCTAssertEqual(request?.url?.absoluteString, "http://localhost:1234/v1/models")
        XCTAssertEqual(request?.value(forHTTPHeaderField: "Authorization"), "Bearer test")
        XCTAssertEqual(request?.timeoutInterval, 2)
        XCTAssertNil(Host.modelHealthRequest(["MODEL_PROVIDER": "deepseek"]))
        XCTAssertNil(Host.modelHealthRequest(["MODEL_PROVIDER": "mock"]))
        XCTAssertNil(Host.modelHealthRequest([:])?.value(forHTTPHeaderField: "Authorization"))
    }
    func testBackupFreshnessAndKeyFile() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let fm = FileManager.default
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: dir) }
        XCTAssertNil(try Host.newestRegularBackup(in: dir))
        let old = Date(timeIntervalSinceNow: -90000)
        for (name, date) in [("cattt-old", old), ("cattt-new-pre-upgrade", Date()), ("cattt-new.incomplete", Date())] {
            let backup = dir.appendingPathComponent(name)
            try fm.createDirectory(at: backup, withIntermediateDirectories: true)
            try Data().write(to: backup.appendingPathComponent("db.dump"))
            try fm.setAttributes([.modificationDate: date], ofItemAtPath: backup.path)
        }
        XCTAssertEqual(try XCTUnwrap(Host.newestRegularBackup(in: dir)).timeIntervalSince1970, old.timeIntervalSince1970, accuracy: 1)
        let env = dir.appendingPathComponent("env")
        try Data("# 保留\nMODEL_PROVIDER=mock\nPORT=8787\nOTHER=' a b '\n".utf8).write(to: env)
        XCTAssertThrowsError(try Host.writeDeepSeekConfiguration("", in: dir))
        XCTAssertThrowsError(try Host.writeDeepSeekConfiguration("x\ny", in: dir))
        try Host.writeDeepSeekConfiguration("sk-test", in: dir)
        let values = try Host.parseEnv(String(contentsOf: env))
        XCTAssertEqual(values["MODEL_PROVIDER"], "deepseek")
        XCTAssertEqual(values["MAOMAO_DEEPSEEK_API_KEY"], "sk-test")
        XCTAssertEqual(values["OTHER"], " a b ")
        XCTAssertEqual(values["PORT"], "8787")
        XCTAssertEqual((try fm.attributesOfItem(atPath: env.path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)
    }
    func testEnv() throws {
        XCTAssertEqual(try Host.parseEnv("# 注释\nMODEL_PROVIDER=mock\nKEY='hello=world'\nEMPTY=\n"), ["MODEL_PROVIDER": "mock", "KEY": "hello=world", "EMPTY": ""])
        XCTAssertEqual(try Host.parseEnv(""), [:])
        XCTAssertThrowsError(try Host.parseEnv("bad"))
        XCTAssertThrowsError(try Host.parseEnv("bad key=x"))
    }
    func testBackoff() {
        XCTAssertEqual((1...7).map(Host.backoff), [1, 2, 4, 8, 16, 30, 30])
    }
    func testRotation() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let log = dir.appendingPathComponent("api.log")
        try Host.rotate(log, limit: 4)
        try Data("abcd".utf8).write(to: log)
        try Host.rotate(log, limit: 4)
        XCTAssertEqual(try String(contentsOf: log.appendingPathExtension("1")), "abcd")
        XCTAssertFalse(FileManager.default.fileExists(atPath: log.path))
    }
    func testInvalidRestore() {
        let host = Host(data: URL(fileURLWithPath: "/nonexistent"), resources: URL(fileURLWithPath: "/nonexistent"), version: "test")
        XCTAssertThrowsError(try host.restore(URL(fileURLWithPath: "/nonexistent")))
    }
}
