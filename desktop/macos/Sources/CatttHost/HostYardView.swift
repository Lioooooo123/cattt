import AppKit
import Combine
import SwiftUI
import WebKit

@MainActor
final class HostYardController: NSObject, ObservableObject, WKNavigationDelegate, WKScriptMessageHandler {
    private static let scheme = "cattt-yard"
    private let runID = UUID().uuidString
    private var pageID = UUID().uuidString
    private var started = false
    private var active = false
    private var readinessTask: Task<Void, Never>?
    private let messageProxy = HostYardMessageProxy()
    let webView: WKWebView
    @Published private(set) var ready = false
    @Published private(set) var surfaceReady = false
    @Published private(set) var failure: String?

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(HostYardSchemeHandler(), forURLScheme: Self.scheme)
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        messageProxy.owner = self
        configuration.userContentController.add(messageProxy, name: "maomao")
        webView.navigationDelegate = self
        webView.underPageBackgroundColor = NSColor(calibratedRed: 0.96, green: 0.96, blue: 0.95, alpha: 1)
        webView.allowsBackForwardNavigationGestures = false
        #if DEBUG
        webView.isInspectable = true
        #endif
    }

    func start() {
        guard !started else { return }
        started = true
        load()
    }

    func reload() {
        started = true
        load()
    }

    private func load() {
        readinessTask?.cancel()
        ready = false
        surfaceReady = false
        failure = nil
        pageID = UUID().uuidString
        var components = URLComponents()
        components.scheme = Self.scheme
        components.host = "yard"
        components.path = "/app.html"
        components.queryItems = [
            URLQueryItem(name: "home", value: "1"),
            URLQueryItem(name: "composition", value: "1"),
            URLQueryItem(name: "dpr", value: "1.5"),
            URLQueryItem(name: "msaa", value: "0"),
            URLQueryItem(name: "fps", value: "60"),
            URLQueryItem(name: "time", value: "day"),
            URLQueryItem(name: "weather", value: "clear"),
            URLQueryItem(name: "runId", value: runID),
            URLQueryItem(name: "pageId", value: pageID),
        ]
        guard let url = components.url else {
            failure = "小院页面地址无效"
            return
        }
        let loadingPageID = pageID
        readinessTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(20))
            guard let self, self.pageID == loadingPageID, !self.surfaceReady else { return }
            self.failure = self.ready ? "小院画面尚未准备好，请重新加载" : "小院启动超时，请重新加载"
        }
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
    }

    func findCat() {
        send(["type": "findCat"])
    }

    func setActive(_ value: Bool) {
        active = value
        guard ready else { return }
        send(["type": "active", "on": value])
    }

    private func send(_ command: [String: Any]) {
        var envelope = command
        envelope["runId"] = runID
        envelope["pageId"] = pageID
        guard let data = try? JSONSerialization.data(withJSONObject: envelope),
              let json = String(data: data, encoding: .utf8),
              let literalData = try? JSONSerialization.data(withJSONObject: json, options: .fragmentsAllowed),
              let literal = String(data: literalData, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.__app?.command(\(literal))") { _, error in
            if let error {
                Task { @MainActor [weak self] in
                    self?.failure = "小院暂时没有响应：\(error.localizedDescription)"
                    self?.surfaceReady = false
                }
            }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        send(["type": "initialize", "active": active])
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        navigationFailed(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        navigationFailed(error)
    }

    private func navigationFailed(_ error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled else { return }
        readinessTask?.cancel()
        ready = false
        surfaceReady = false
        failure = "小院加载失败：\(error.localizedDescription)"
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        failure = "小院内容意外中断，请重新加载"
        reload()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "maomao", message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.protocol == Self.scheme,
              message.frameInfo.securityOrigin.host == "yard",
              let source = message.body as? String,
              let data = source.data(using: .utf8),
              let envelope = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              envelope["runId"] as? String == runID,
              envelope["pageId"] as? String == pageID else { return }

        switch envelope["type"] as? String {
        case "ready":
            ready = true
            send(["type": "initialize", "active": active])
        case "visualReady":
            ready = true
            surfaceReady = true
            failure = nil
            readinessTask?.cancel()
        case "tap":
            if active, surfaceReady, envelope["target"] as? String == "cat" {
                send(["type": "poke"])
            }
        case "error":
            failure = envelope["message"] as? String ?? "小院暂时没有响应"
            surfaceReady = false
        case "contextLost":
            surfaceReady = false
            failure = "小院画面中断，请重新加载"
        case "contextRestored", "resumed":
            break
        default:
            break
        }
    }
}

@MainActor
private final class HostYardMessageProxy: NSObject, WKScriptMessageHandler {
    weak var owner: HostYardController?
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        owner?.userContentController(userContentController, didReceive: message)
    }
}

private final class HostYardSchemeHandler: NSObject, WKURLSchemeHandler {
    private let root = Bundle.main.resourceURL?.appendingPathComponent("YardWeb", isDirectory: true).standardizedFileURL
    private static let contentTypes: [String: String] = [
        "html": "text/html", "js": "text/javascript", "mjs": "text/javascript", "css": "text/css",
        "json": "application/json", "glb": "model/gltf-binary", "gltf": "model/gltf+json",
        "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp",
        "svg": "image/svg+xml", "woff2": "font/woff2", "woff": "font/woff", "wasm": "application/wasm",
        "ktx2": "image/ktx2",
    ]

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url,
              url.scheme == "cattt-yard", url.host == "yard",
              let root, !url.path.isEmpty else {
            fail(urlSchemeTask, url: urlSchemeTask.request.url)
            return
        }
        let relative = String(url.path.drop(while: { $0 == "/" }))
        let file = root.appendingPathComponent(relative).standardizedFileURL
        guard file.path.hasPrefix(root.path + "/"),
              let data = try? Data(contentsOf: file) else {
            fail(urlSchemeTask, url: url)
            return
        }
        let type = Self.contentTypes[file.pathExtension.lowercased()] ?? "application/octet-stream"
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": type,
            "Content-Length": String(data.count),
            "Cache-Control": "no-cache",
        ])!
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    private func fail(_ task: WKURLSchemeTask, url: URL?) {
        guard let url else { task.didFinish(); return }
        task.didReceive(HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: nil)!)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}

struct HostYardView: View {
    @ObservedObject var controller: HostYardController

    var body: some View {
        ZStack {
            CompanionPalette.page
            HostYardWebView(controller: controller)
            if !controller.surfaceReady {
                VStack(spacing: 12) {
                    if let failure = controller.failure {
                        Image(systemName: "leaf")
                            .font(.system(size: 28))
                            .foregroundStyle(CompanionPalette.accent)
                        Text(failure)
                            .font(.body)
                            .foregroundStyle(CompanionPalette.ink)
                            .multilineTextAlignment(.center)
                        Button("重新加载小院") { controller.reload() }
                            .buttonStyle(.borderedProminent)
                            .tint(CompanionPalette.accent)
                    } else {
                        ProgressView()
                        Text("正在打开小院…")
                            .foregroundStyle(CompanionPalette.secondary)
                    }
                }
                .padding(24)
                .frame(maxWidth: 380)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18))
            }
            HostYardVisibilityProbe { controller.setActive($0) }
                .frame(width: 0, height: 0)
        }
        .background(CompanionPalette.page)
        .onAppear { controller.start() }
    }
}

private struct HostYardWebView: NSViewRepresentable {
    @ObservedObject var controller: HostYardController
    func makeNSView(context: Context) -> WKWebView { controller.webView }
    func updateNSView(_ view: WKWebView, context: Context) {}
}

private struct HostYardVisibilityProbe: NSViewRepresentable {
    let onChange: (Bool) -> Void
    func makeNSView(context: Context) -> VisibilityView {
        let view = VisibilityView()
        view.onChange = onChange
        return view
    }
    func updateNSView(_ view: VisibilityView, context: Context) { view.onChange = onChange; view.updateVisibility() }
    static func dismantleNSView(_ view: VisibilityView, coordinator: ()) { view.onChange?(false); view.removeObservers() }

    final class VisibilityView: NSView {
        var onChange: ((Bool) -> Void)?
        private var observers: [NSObjectProtocol] = []

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            removeObservers()
            guard let window else { onChange?(false); return }
            let center = NotificationCenter.default
            for name in [NSWindow.didMiniaturizeNotification, NSWindow.didDeminiaturizeNotification,
                         NSWindow.didChangeOcclusionStateNotification, NSApplication.didHideNotification,
                         NSApplication.didUnhideNotification, NSApplication.didBecomeActiveNotification,
                         NSApplication.didResignActiveNotification] {
                observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                    self?.updateVisibility()
                })
            }
            observers.append(center.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { [weak self] _ in
                self?.onChange?(false)
            })
            updateVisibility()
        }

        func updateVisibility() {
            guard let window else { onChange?(false); return }
            let visible = window.isVisible && !window.isMiniaturized && !NSApp.isHidden && NSApp.isActive && window.occlusionState.contains(.visible)
            onChange?(visible)
        }

        func removeObservers() {
            observers.forEach { NotificationCenter.default.removeObserver($0) }
            observers.removeAll()
        }

        deinit { removeObservers() }
    }
}
