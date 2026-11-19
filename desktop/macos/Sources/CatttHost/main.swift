import Foundation
import SwiftUI
import HostCore
import Darwin

var stopping = false
signal(SIGTERM) { _ in stopping = true }
signal(SIGINT) { _ in stopping = true }
let args = CommandLine.arguments
func option(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}
let host = Host(data: URL(fileURLWithPath: option("--data-dir") ?? ProcessInfo.processInfo.environment["CATTT_DATA_DIR"] ?? NSHomeDirectory() + "/Library/Application Support/Cattt"),
                resources: Bundle.main.bundleURL.appendingPathComponent("Contents/Resources"),
                version: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "development")

if args.contains("--headless") {
    do {
        try host.start()
        if args.contains("--backup") { _ = try host.backup() }
        else if let source = option("--restore") { try host.restore(URL(fileURLWithPath: source)) }
        else { while !stopping { host.tick(); Thread.sleep(forTimeInterval: 0.25) } }
        host.shutdown()
    } catch { fputs("宿主错误：\(error)\n", stderr); host.shutdown(); exit(1) }
} else {
    HostMenu.main()
}
