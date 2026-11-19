import Foundation

extension Host {
    public static func combinedModelConfiguration(_ values: [String: String]) -> [String: String] {
        var result = values
        let local = !(values["OPENAI_COMPAT_MODEL"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let cloud = !(values["MAOMAO_DEEPSEEK_API_KEY"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        for slot in ["CHAT", "ROUTER", "WORKER"] { result.removeValue(forKey: "\(slot)_PROVIDER") }
        if local {
            result["MODEL_PROVIDER"] = "openai-compatible"
            if (result["OPENAI_COMPAT_BASE_URL"] ?? "").isEmpty { result["OPENAI_COMPAT_BASE_URL"] = "http://127.0.0.1:11434/v1" }
            if cloud { for slot in ["CHAT", "ROUTER", "WORKER"] { result["\(slot)_PROVIDER"] = "deepseek" } }
        } else if cloud { result["MODEL_PROVIDER"] = "deepseek" }
        return result
    }

    public static func writeCombinedModelConfiguration(in data: URL, deepSeekKey: String? = nil) throws {
        let url = data.appendingPathComponent("env")
        let original = try String(contentsOf: url)
        var values = try parseEnv(original)
        if let deepSeekKey {
            let key = deepSeekKey.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !key.isEmpty, !key.contains("\n"), !key.contains("\r") else { throw HostError("请输入有效的 DeepSeek key") }
            values["MAOMAO_DEEPSEEK_API_KEY"] = key
        }
        let result = combinedModelConfiguration(values)
        let managed = ["MODEL_PROVIDER", "OPENAI_COMPAT_BASE_URL", "OPENAI_COMPAT_MODEL", "MAOMAO_DEEPSEEK_API_KEY", "CHAT_PROVIDER", "ROUTER_PROVIDER", "WORKER_PROVIDER"]
        let kept = original.components(separatedBy: .newlines).filter {
            let name = $0.components(separatedBy: "=").first?.trimmingCharacters(in: .whitespaces)
            return !managed.contains(name ?? "")
        }
        let assignments = managed.compactMap { name in result[name].map { "\(name)=\($0)" } }
        let text = kept.joined(separator: "\n") + "\n" + assignments.joined(separator: "\n") + "\n"
        try Data(text.utf8).write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    public static func modelSourceStatus(_ env: [String: String], httpStatus: Int? = nil) -> [String: String] {
        let global = env["MODEL_PROVIDER"] ?? "openai-compatible"
        func provider(_ slot: String) -> String { global == "mock" ? "mock" : env["\(slot)_PROVIDER"] ?? global }
        let model = env["OPENAI_COMPAT_MODEL"] ?? ""
        var local = "未配置"
        if !model.isEmpty {
            let health: String
            if modelHealthRequest(env) == nil { health = "服务地址无效" }
            else if httpStatus == 0 { health = "未启动" }
            else if let code = httpStatus { health = (200..<300).contains(code) ? "在线" : "服务错误（\(code)）" }
            else { health = "检测中" }
            local = "\(model)（\(health)）"
            if provider("EXTRACT") == "openai-compatible" {
                local += "·记忆"
                if let memory = env["EXTRACT_MODEL"], memory != model { local += "（\(memory)）" }
            }
        }
        if global == "openai-compatible" { local += " · 默认来源" }
        else if global == "mock" { local += " · 默认：测试模式" }
        else if global != "deepseek" { local += " · 默认来源无效" }
        var deepSeek = "未配置"
        if !(env["MAOMAO_DEEPSEEK_API_KEY"] ?? "").isEmpty {
            deepSeek = "已配置"
            let roles = [("CHAT", "聊天"), ("ROUTER", "路由"), ("WORKER", "后台处理"), ("EXTRACT", "记忆")].filter { provider($0.0) == "deepseek" }.map { $0.1 }
            if !roles.isEmpty { deepSeek += "·" + roles.joined(separator: "/") }
        }
        if global == "deepseek" { deepSeek += " · 默认来源" }
        return ["本地模型": local, "DeepSeek": deepSeek]
    }
}
