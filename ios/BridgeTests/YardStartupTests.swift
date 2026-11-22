import Foundation

@main
struct YardStartupTests {
    static func main() {
        var page = YardVisualGate()
        page.begin(pageID: "current")
        var queued = ["viewport", "facts"]
        var sent: [String] = []
        func flush() {
            while page.allowsCommands(ready: true), !queued.isEmpty {
                sent.append(queued.removeFirst())
            }
        }
        assert(!page.allowsCommands(ready: false))
        flush()
        assert(sent.isEmpty && queued.count == 2)
        page.sentActive(true)
        assert(!page.allowsLifecycle(ready: true, active: true))
        assert(page.allowsLifecycle(ready: true, active: false))
        page.sentActive(false)
        assert(page.allowsLifecycle(ready: true, active: true))
        assert(!page.allowsLifecycle(ready: false, active: true))
        page.fail("同步超时", recoverable: true)
        assert(!page.reveal(pageID: "stale"))
        flush()
        assert(sent.isEmpty && page.failure == "同步超时")
        assert(page.reveal(pageID: "current"))
        assert(page.failure == nil)
        flush()
        assert(sent == ["viewport", "facts"] && queued.isEmpty)
        assert(page.allowsLifecycle(ready: true, active: false))
        assert(!page.needsWatchdogFailure(active: true))

        page.begin(pageID: "never-ready")
        assert(page.failure == nil && !page.allowsCommands(ready: true))
        assert(!page.needsWatchdogFailure(active: false))
        if page.needsWatchdogFailure(active: true) { page.fail("启动超时", recoverable: true) }
        assert(page.failure == "启动超时" && page.isVisible)
        assert(!page.reveal(pageID: "current") && page.failure == "启动超时")
        assert(page.reveal(pageID: "never-ready") && page.failure == nil)

        page.begin(pageID: "navigation")
        page.fail("导航失败", recoverable: false)
        page.fail("同步超时", recoverable: true)
        assert(page.reveal(pageID: "navigation") && page.failure == "导航失败")
        page.begin(pageID: "retry")
        assert(page.failure == nil && page.isVisible)
        assert(page.reveal(pageID: "retry"))
        page.cover(pageID: "retry")
        assert(!page.allowsCommands(ready: true))
        assert(page.reveal(pageID: "retry") && page.allowsCommands(ready: true))
        print("PASS: startup queue, lifecycle wake, current/stale recovery, watchdog, navigation failure, retry/context recovery (7 scenarios)")
    }
}
