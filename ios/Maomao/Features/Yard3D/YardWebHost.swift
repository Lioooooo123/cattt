import Combine
import SwiftUI
import WebKit

struct YardBackdrop {
    let top: UIColor
    let horizon: UIColor

    static func forSlot(_ slot: String?) -> YardBackdrop {
        switch slot {
        case "dawn": return YardBackdrop(top: UIColor(red: 0.52, green: 0.72, blue: 0.84, alpha: 1), horizon: UIColor(red: 0.91, green: 0.78, blue: 0.66, alpha: 1))
        case "dusk": return YardBackdrop(top: UIColor(red: 0.38, green: 0.49, blue: 0.67, alpha: 1), horizon: UIColor(red: 0.92, green: 0.62, blue: 0.47, alpha: 1))
        case "evening": return YardBackdrop(top: UIColor(red: 0.18, green: 0.27, blue: 0.44, alpha: 1), horizon: UIColor(red: 0.54, green: 0.45, blue: 0.55, alpha: 1))
        case "night": return YardBackdrop(top: UIColor(red: 0.06, green: 0.12, blue: 0.23, alpha: 1), horizon: UIColor(red: 0.20, green: 0.31, blue: 0.43, alpha: 1))
        default: return YardBackdrop(top: UIColor(red: 0.54, green: 0.76, blue: 0.89, alpha: 1), horizon: UIColor(red: 0.81, green: 0.89, blue: 0.92, alpha: 1))
        }
    }
}

/// 弱引用脚本入口，避免 WKUserContentController -> host -> WKWebView 循环持有。
@MainActor
private final class YardMessageProxy: NSObject, WKScriptMessageHandler {
    weak var owner: YardWebController?
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        owner?.userContentController(controller, didReceive: message)
    }
}

@MainActor
final class YardWebController: NSObject, ObservableObject, WKNavigationDelegate {
    static let scheme = "maomao"
    let webView: WKWebView
    let messages = PassthroughSubject<[String: Any], Never>()
    @Published private(set) var ready = false
    @Published private(set) var surfaceReady = false
    @Published private(set) var coverImage: UIImage?
    @Published private(set) var failure: String?
    @Published private(set) var backdrop = YardBackdrop.forSlot("day")
    private(set) var identity = YardProbeIdentity(runID: "", pageID: "")
    private(set) var snapshot: [String: Any]?
    var homeIntent: [String: Any]?
    var homeConfiguration: [String: [String: Any]] = [:]
    var initialSnapshot: [String: Any]?
    private var query: [String: String] = [:]
    private var active = true
    private var lifecycleRevision = 0
    private var stopped = true
    private var restoring = false
    private var visualGate = YardVisualGate()
    var canSendCommands: Bool { !stopped && visualGate.allowsCommands(ready: ready) }
    func needsWatchdogFailure(active: Bool) -> Bool { !stopped && visualGate.needsWatchdogFailure(active: active) }
    private let proxy = YardMessageProxy()
    private static var coverDirectory: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("YardCovers", isDirectory: true)
    }
    private var coverKey = "day-clear-house"
    func updateCoverContext(slot: String, weather: String, place: String) {
        coverKey = "\(slot)-\(weather)-\(place)"
    }
    func captureCover(exportName: String? = nil) {
        guard surfaceReady, !stopped else { return }
        let page = identity.pageID, key = coverKey
        let configuration = WKSnapshotConfiguration()
        configuration.snapshotWidth = 240
        webView.takeSnapshot(with: configuration) { [weak self] image, error in
            guard let self, let image, error == nil, page == identity.pageID, surfaceReady else { return }
            let format = UIGraphicsImageRendererFormat(); format.scale = 1
            let size = CGSize(width: 600, height: image.size.height / image.size.width * 600)
            let scaled = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
            coverImage = scaled
            guard let data = scaled.jpegData(compressionQuality: 0.84) else { return }
            try? FileManager.default.createDirectory(at: Self.coverDirectory, withIntermediateDirectories: true)
            try? data.write(to: Self.coverDirectory.appendingPathComponent(key + ".jpg"), options: .atomic)
            #if DEBUG
            if let exportName, let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
                try? data.write(to: dir.appendingPathComponent(exportName + ".jpg"), options: .atomic)
            }
            #endif
        }
    }

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(YardSchemeHandler(), forURLScheme: Self.scheme)
        configuration.allowsInlineMediaPlayback = true
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        proxy.owner = self
        configuration.userContentController.add(proxy, name: "maomao")
        webView.navigationDelegate = self
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isOpaque = false
        webView.backgroundColor = backdrop.horizon
        webView.scrollView.backgroundColor = backdrop.horizon
        webView.underPageBackgroundColor = backdrop.horizon
        #if DEBUG
        webView.isInspectable = true
        #endif
    }

    func load(runID: String, query: [String: String], active: Bool) {
        self.query = query; self.active = active; snapshot = initialSnapshot; restoring = initialSnapshot != nil
        let camera = snapshot?["camera"] as? [String: Any]
        updateCoverContext(slot: query["time"] ?? "day", weather: query["weather"] ?? "clear",
                           place: camera?["place"] as? String ?? snapshot?["goal"] as? String ?? "house")
        coverImage = UIImage(contentsOfFile: Self.coverDirectory.appendingPathComponent(coverKey + ".jpg").path)
            ?? UIImage(named: "yard-start-" + coverKey)
        backdrop = YardBackdrop.forSlot(query["time"])
        applyBackdrop()
        stopped = false
        identity.runID = runID
        loadPage()
    }

    private func loadPage() {
        ready = false; surfaceReady = false; failure = nil
        identity.pageID = UUID().uuidString
        visualGate.begin(pageID: identity.pageID)
        var items = query
        items["runId"] = identity.runID; items["pageId"] = identity.pageID
        var components = URLComponents()
        components.scheme = Self.scheme; components.host = "yard"; components.path = "/app.html"
        components.queryItems = items.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        webView.load(URLRequest(url: components.url!))
    }

    /// WebKit 不回调也必须在 3 秒结束；迟到回调由 deadline gate 忽略。
    @discardableResult
    func send(_ command: [String: Any]) async throws -> String {
        guard !stopped else { throw YardProbeError.stopped }
        let sent = identity
        var envelope = command
        envelope["runId"] = sent.runID; envelope["pageId"] = sent.pageID
        let data = try JSONSerialization.data(withJSONObject: envelope)
        let json = String(decoding: data, as: UTF8.self)
        // JSON 字符串再编码一次作为 JS 字面量，避免引号、换行与反斜线破坏脚本。
        let literal = String(decoding: try JSONSerialization.data(withJSONObject: json, options: .fragmentsAllowed), as: UTF8.self)
        let value: String = try await YardDeadline.perform(seconds: 3) { complete in
            #if DEBUG
            // 故障注入：模拟报告回调永远不返回，验证部分数据仍会保存。
            if command["type"] as? String == "report", self.query["fault"] == "report-timeout" { return }
            #endif
            self.webView.evaluateJavaScript("window.__app?.command(\(literal))") { value, error in
                if let error { complete(.failure(error)) }
                else if let text = value as? String { complete(.success(text)) }
                else { complete(.failure(YardProbeError.invalidResponse)) }
            }
        }
        guard !stopped, sent.runID == identity.runID, sent.pageID == identity.pageID else { throw YardProbeError.stopped }
        return value
    }

    func setActive(_ value: Bool) async {
        active = value
        lifecycleRevision += 1
        let revision = lifecycleRevision
        let page = identity.pageID
        guard !stopped, visualGate.allowsLifecycle(ready: ready, active: value) else { return }
        visualGate.sentActive(value)
        do { try await send(["type": "active", "on": value]) }
        catch {
            guard !stopped, page == identity.pageID, revision == lifecycleRevision else { return }
            // iOS 可以先冻结内容进程，再送达 native 的暂停命令。后台超时只记事实，
            // 前台重发 active 后若仍无响应才算失败；不能把正常系统挂起误报成损坏。
            if value { emit("error", ["message": "恢复前台同步失败：\(error)"]) }
            else { emit("lifecycleDeferred", ["message": "后台内容进程暂不可响应；前台重发"]) }
        }
    }

    func markUnavailable(_ reason: String, detail: String = "") {
        visualGate.fail(reason, recoverable: true)
        failure = visualGate.failure
        // 原生超时也进入同一条证据链，不能只留下屏幕上的提示。
        emit("unavailable", ["message": reason, "detail": detail, "ready": ready, "surfaceReady": surfaceReady, "loading": webView.isLoading])
    }

    func retry() {
        guard !stopped else { return }
        restoring = snapshot != nil; loadPage()
    }

    func stop() {
        stopped = true; ready = false; surfaceReady = false
        // 不等待失去响应的 JS。页面卸载会释放 GL；正常结束另行发送 dispose。
        identity.pageID = UUID().uuidString
        webView.stopLoading()
        webView.loadHTMLString("<html><body style='background:#cfe3ea'></body></html>", baseURL: nil)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard !stopped, message.frameInfo.isMainFrame,
              let text = message.body as? String, let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              identity.accepts(object) else { return }
        if let state = object["snapshot"] as? [String: Any] { snapshot = state }
        let type = object["type"] as? String
        if type == "error", let reason = object["message"] as? String {
            visualGate.fail(reason, recoverable: false)
            failure = visualGate.failure
        }
        if type == "contextLost" {
            visualGate.cover(pageID: identity.pageID)
            surfaceReady = false
        } else if type == "visualReady", visualGate.reveal(pageID: identity.pageID) {
            surfaceReady = true
            failure = visualGate.failure
            if !active { Task { await setActive(active) } }
        }
        messages.send(object)
        if type == "ready" {
            ready = true
            let expected = identity.pageID
            Task { [weak self] in
                guard let self, !stopped, expected == identity.pageID else { return }
                var command: [String: Any] = ["type": "initialize", "active": active]
                visualGate.sentActive(active)
                command["configuration"] = ["viewport", "controls", "previewMotion", "facts"].compactMap { homeConfiguration[$0] }
                if restoring, let snapshot { command["snapshot"] = snapshot }
                if let homeIntent { command["intent"] = homeIntent }
                do { try await send(command) }
                catch { if !stopped && expected == identity.pageID { emit("error", ["message": "网页初始化失败：\(error)"]) } }
            }
        }
    }

    private func emit(_ type: String, _ fields: [String: Any] = [:]) {
        var message = fields
        message["type"] = type; message["runId"] = identity.runID; message["pageId"] = identity.pageID
        messages.send(message)
    }

    private func applyBackdrop() {
        webView.backgroundColor = backdrop.horizon
        webView.scrollView.backgroundColor = backdrop.horizon
        webView.underPageBackgroundColor = backdrop.horizon
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { navigationFailed(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { navigationFailed(error) }
    private func navigationFailed(_ error: Error) {
        guard !stopped, (error as NSError).code != NSURLErrorCancelled else { return }
        visualGate.fail(error.localizedDescription, recoverable: false)
        failure = visualGate.failure
        emit("error", ["message": error.localizedDescription])
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard !stopped else { return }
        emit("processTerminated", ["snapshotAvailable": snapshot != nil, "snapshot": snapshot as Any? ?? NSNull()])
        restoring = true
        loadPage()
    }

    #if DEBUG
    /// 走与系统内容进程终止完全相同的原生恢复路径；用于可重复的模拟器回归。
    func simulateContentProcessTermination() {
        webViewWebContentProcessDidTerminate(webView)
    }
    #endif
}

/// 把 `maomao://yard/<路径>` 对到包里 `YardWeb/<路径>`。
final class YardSchemeHandler: NSObject, WKURLSchemeHandler {
    private static let root = Bundle.main.url(forResource: "YardWeb", withExtension: nil)
    private static let types: [String: String] = [
        "html": "text/html", "js": "text/javascript", "mjs": "text/javascript", "css": "text/css", "json": "application/json",
        "glb": "model/gltf-binary", "gltf": "model/gltf+json", "png": "image/png", "jpg": "image/jpeg", "webp": "image/webp",
        "svg": "image/svg+xml", "woff2": "font/woff2", "woff": "font/woff", "wasm": "application/wasm", "ktx2": "image/ktx2",
    ]

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        let relative = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let root = Self.root, !relative.isEmpty, !relative.contains(".."),
              let data = try? Data(contentsOf: root.appendingPathComponent(relative)) else {
            task.didReceive(HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: nil)!)
            task.didFinish()
            return
        }
        let type = Self.types[url.pathExtension.lowercased()] ?? "application/octet-stream"
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": type, "Content-Length": String(data.count), "Cache-Control": "no-cache"])!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

/// SwiftUI 里放那个 WKWebView
struct YardWebView: UIViewRepresentable {
    @ObservedObject var controller: YardWebController

    func makeUIView(context: Context) -> WKWebView { controller.webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

/// WebKit 导航、内容进程重载和 WebGL 上下文恢复期间始终有原生天空兜底。
struct YardWebSurface: View {
    @ObservedObject var controller: YardWebController

    var body: some View {
        ZStack {
            sky
            YardWebView(controller: controller)
            sky
                .opacity(controller.surfaceReady ? 0 : 1)
                .allowsHitTesting(false)
        }
        // 内容进程消失后必须立即盖住；淡入会先露出 WebKit 的纯色底。
        // 只有新画面准备好后的揭开保留过渡。
        .animation(controller.surfaceReady ? .easeOut(duration: 0.16) : nil, value: controller.surfaceReady)
    }

    @ViewBuilder private var sky: some View {
        if let image = controller.coverImage {
            GeometryReader { proxy in
                Image(uiImage: image).resizable().scaledToFill().frame(width: proxy.size.width, height: proxy.size.height).clipped()
            }
        } else { LinearGradient(colors: [Color(uiColor: controller.backdrop.top), Color(uiColor: controller.backdrop.horizon)],
                       startPoint: .top, endPoint: .bottom)
        }
    }
}
