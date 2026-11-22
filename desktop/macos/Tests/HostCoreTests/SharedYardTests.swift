import AppKit
import Foundation
import XCTest
@testable import HostCore

final class SharedYardTests: XCTestCase {
    func testOnlyCurrentRenderCanConfirmArrival() throws {
        let motion = YardMotion(id: "current", destination: "tree", activity: "sit")
        func frame(_ id: String, moving: Bool = false, settled: Bool = true,
                   fallback: Bool = false, action: String = "sit_idle") throws -> YardFrame {
            let data = try JSONSerialization.data(withJSONObject: [
                "id": id, "nearest": "tree", "moving": moving, "settled": settled,
                "action": action, "activity": "sit", "fallback": fallback
            ])
            return try JSONDecoder().decode(YardFrame.self, from: data)
        }
        XCTAssertNil(motion.receipt(for: try frame("projection")))
        XCTAssertNil(motion.receipt(for: try frame("current", moving: true)))
        XCTAssertNil(motion.receipt(for: try frame("current", settled: false)))
        XCTAssertNil(motion.receipt(for: try frame("current", action: "sit_enter")))
        XCTAssertEqual(motion.receipt(for: try frame("current", fallback: true)), .interrupted)
        XCTAssertEqual(motion.receipt(for: try frame("current")), .arrived)
    }

    func testObservationVersionAdvancesOnlyOnChangeAndNeverCopiesRemoteVersion() throws {
        var sequence = YardObservationSequence()
        let frame = YardFrame(id: "local", nearest: "grass", moving: false, settled: true,
                              action: "idle", activity: "watch", fallback: false)
        var snapshot = YardSnapshot(frame: frame, target: "grass", facts: nil, seat: "grass")
        snapshot.stateVersion = 91
        XCTAssertEqual(sequence.observe(snapshot).stateVersion, 0)
        XCTAssertEqual(sequence.observe(snapshot).stateVersion, 0)
        snapshot.companionSeat = nil
        XCTAssertEqual(sequence.observe(snapshot).stateVersion, 1)
        snapshot.companionSeat = "grass"
        XCTAssertEqual(sequence.observe(snapshot).stateVersion, 2)
    }
}

extension SharedYardTests {
    @MainActor
    func testWebKitInitializesOnceAndSurfacesCommandRejection() async throws {
        let resources = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: resources, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: resources) }
        let html = """
            <!doctype html><meta charset="utf-8"><script>
            const ids = Object.fromEntries(new URLSearchParams(location.search));
            const post = message => webkit.messageHandlers.maomao.postMessage(JSON.stringify({...ids, ...message}));
            let initializations = 0;
            window.__app = { command(json) {
                const command = JSON.parse(json);
                if (command.type === 'initialize') post({
                    type: 'cat', id: String(++initializations), nearest: 'house', moving: false, settled: true,
                    action: 'idle', activity: 'watch', fallback: false
                });
                return JSON.stringify(command.type === 'findCat' ? {error: 'fixture rejection'} : {});
            } };
            post({type: 'ready'});
            </script>
            """
        try html.write(to: resources.appendingPathComponent("app.html"), atomically: true, encoding: .utf8)
        _ = NSApplication.shared
        guard !NSScreen.screens.isEmpty else { throw XCTSkip("WebKit 命令测试需要 macOS 图形会话") }
        let yard = HostYardController(resourceDirectory: resources)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 320, height: 240),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.alphaValue = 0.01
        window.contentView = yard.webView
        window.orderBack(nil)
        defer { yard.setActive(false); window.orderOut(nil) }
        var initializations: [String] = []
        yard.onCatFrame = { initializations.append($0.id) }
        yard.setActive(true)
        yard.start()
        do {
            try await waitFor("网页桥已就绪", timeout: 15) { !initializations.isEmpty && !yard.webView.isLoading }
            yard.findCat()
            try await waitFor("原生层收到网页命令拒绝", timeout: 5) { yard.failure?.contains("fixture rejection") == true }
            XCTAssertEqual(initializations, ["1"])
        } catch {
            XCTFail("\(error) · ready=\(yard.ready) · 初始命令=\(initializations) · failure=\(yard.failure ?? "无")")
        }
    }

    @MainActor
    func testPackagedWorldBridge() async throws {
        struct Configuration: Decodable {
            let data: URL
            let bundle: URL
            let port, lanPort, peerPort: UInt16
            let renderer: String
            let visibleWindow: Bool?
            let chatActions: Bool?
        }
        guard let path = ProcessInfo.processInfo.environment["CATTT_BUN_BRIDGE_CONFIG"] else {
            throw XCTSkip("需要运行 smoke-bun-yard.py 启动签名成品")
        }
        let config = try JSONDecoder().decode(Configuration.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        let host = BunHost(data: config.data, executable: config.bundle.appending(path: "Contents/MacOS/cattt-host"),
                           port: config.port, lanPort: config.lanPort, peerPort: config.peerPort)
        let enrollment = DesktopV2Enrollment(host: host, keychain: LocalTestCredentials())
        let member = try await enrollment.bootstrap(name: "小院验收")
        let endpoint = try await enrollment.discover()
        let device = try await enrollment.approve(memberID: member.id, on: endpoint)
        let saved = try await enrollment.saved(endpoint)
        XCTAssertEqual(saved?.me.actor.deviceId, device.me.actor.deviceId)
        let connection = DesktopYardConnection(key: endpoint.scope.key, memberID: member.id, client: device.client)

        let yard: HostYardController?
        if config.renderer == "webkit" {
            yard = HostYardController(resourceDirectory: config.bundle.appending(path: "Contents/Resources/YardWeb"))
        } else {
            yard = nil
        }
        var receiveFrame: ((YardFrame) -> Void)?
        let bridge = DesktopSharedYard { [weak yard] command in
            if let yard { yard.sendShared(command); return }
            let payload = command["intent"] as? [String: Any] ?? command
            guard let id = payload["id"] as? String, let place = payload["place"] as? String,
                  let activity = payload["activity"] as? String else { return }
            receiveFrame?(YardFrame(id: id, nearest: place, moving: false, settled: true,
                action: activity == "sit" ? "sit_idle" : "idle", activity: activity, fallback: false))
        }
        receiveFrame = { [weak bridge] frame in bridge?.observe(frame) }
        var window: NSWindow?
        defer { yard?.setActive(false); window?.orderOut(nil) }
        if let yard {
            _ = NSApplication.shared
            guard !NSScreen.screens.isEmpty else { throw HostError("当前会话没有可用的 macOS 屏幕") }
            let bounds = NSRect(x: 0, y: 0, width: 960, height: 660)
            let surface = NSWindow(contentRect: bounds, styleMask: [.borderless], backing: .buffered, defer: false)
            surface.contentView = yard.webView
            if config.visibleWindow == true {
                surface.center()
                surface.orderFrontRegardless()
            } else {
                surface.alphaValue = 0.01
                surface.orderBack(nil)
            }
            window = surface
            yard.onCatFrame = { [weak bridge] frame in bridge?.observe(frame) }
            yard.setActive(true)
            yard.start()
            do {
                try await waitFor("包内小院脚本和模型已加载", timeout: 25) {
                    if let failure = yard.failure { throw HostError(failure) }
                    return yard.ready
                }
                guard surface.occlusionState.contains(.visible) else {
                    throw HostError("小院测试窗口被遮挡，无法验证 WebKit 画面")
                }
                try await waitFor("WKWebView 已进入真实渲染循环", timeout: 30) {
                    if let failure = yard.failure { throw HostError(failure) }
                    return yard.surfaceReady
                }
            } catch {
                await logWebKitState(yard, in: surface)
                throw error
            }
            XCTAssertGreaterThan(yard.webView.bounds.width, 0)
            XCTAssertGreaterThan(yard.webView.bounds.height, 0)
        }

        let task = Task { await bridge.run(connection) }
        defer { task.cancel() }
        try await waitFor("共享小院收到首个观察回执") { bridge.availablePlaces.contains("grass") }
        bridge.request("grass")
        try await waitFor("团子真实到达草地") { bridge.action?.status == .arrived }
        let witnessed = try await device.client.yardState()
        XCTAssertEqual(witnessed.world?.snapshot?.currentDestinationID, "grass")
        XCTAssertEqual(witnessed.world?.snapshot?.phase, "idle")
        try await waitFor("共享小院可以接受陪坐") { bridge.seat != nil }
        bridge.request(try XCTUnwrap(bridge.seat), activity: "sit")
        try await waitFor("团子使用 sit_idle 完成陪坐") {
            if let action = bridge.action, action.activity == "sit", action.status.terminal, action.status != .arrived {
                throw HostError("陪坐返回 \(action.status.rawValue) / \(action.reason ?? "")")
            }
            return bridge.action?.activity == "sit" && bridge.action?.status == .arrived
        }
        let seat = try await device.client.yardState()
        XCTAssertEqual(seat.world?.snapshot?.hasConfirmedSeat, true)

        if config.chatActions == true {
            try await waitFor("聊天动作前的院子观察已确认") { bridge.availablePlaces.contains("pond") }
            let conversations = try await device.client.conversations()
            let direct = try XCTUnwrap(conversations.first { $0.kind == .direct })
            let sent = try await device.client.send(conversation: direct.id, key: UUID().uuidString, text: "去池塘")
            try await waitFor("宿主聊天动作完成", timeout: 15) {
                bridge.action?.requestID == sent.message.id && bridge.action?.status == .arrived
            }
            let arrived = try await device.client.yardState()
            XCTAssertEqual(arrived.world?.snapshot?.currentDestinationID, "pond")
        }
    }

    @MainActor
    private func logWebKitState(_ yard: HostYardController, in window: NSWindow) async {
        let view = yard.webView
        print("WKWebView 原生状态 ready=\(yard.ready) active=\(yard.isActive) visual=\(yard.surfaceReady) frame=\(view.frame) mounted=\(view.window === window) visible=\(window.isVisible) unoccluded=\(window.occlusionState.contains(.visible)) appActive=\(NSApp.isActive) alpha=\(window.alphaValue)")
        do {
            let value = try await view.callAsyncJavaScript("""
                const canvas = document.querySelector('canvas');
                const gl = window.__app && canvas?.getContext('webgl2');
                const layout = canvas?.getBoundingClientRect();
                let raf;
                const frame = await Promise.race([
                    new Promise(resolve => { raf = requestAnimationFrame(() => resolve(true)); }),
                    new Promise(resolve => setTimeout(() => resolve(false), 1000))
                ]);
                cancelAnimationFrame(raf);
                return JSON.stringify({
                    visibility: document.visibilityState, scriptReady: !!window.__app,
                    viewport: [innerWidth, innerHeight], canvas: [layout?.width, layout?.height],
                    drawingBuffer: [gl?.drawingBufferWidth, gl?.drawingBufferHeight], contextLost: gl?.isContextLost(), frame,
                    resources: performance.getEntriesByType('resource').map(entry => new URL(entry.name).pathname)
                });
                """, arguments: [:], in: nil, contentWorld: .page)
            print("WKWebView 网页状态 \(value ?? "无返回值")")
        } catch {
            print("WKWebView 诊断失败 \(error)")
        }
    }

    @MainActor
    private func waitFor(_ note: String, timeout: TimeInterval = 28, _ condition: () throws -> Bool) async throws {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if try condition() { return }
            try await Task.sleep(for: .milliseconds(50))
        }
        throw HostError("等待超时：\(note)")
    }
}

private final class LocalTestCredentials: DeviceCredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private var credentials: [String: String] = [:]

    func load(account: String) throws -> String? {
        lock.withLock { credentials[account] }
    }

    func save(_ credential: String, account: String) throws {
        lock.withLock { credentials[account] = credential }
    }

    func delete(account: String) throws {
        lock.withLock { credentials[account] = nil }
    }
}
