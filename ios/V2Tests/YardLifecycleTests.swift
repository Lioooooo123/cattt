import XCTest
@testable import Maomao

final class YardLifecycleTests: XCTestCase {
    @MainActor
    func testRuntimeRequiresBothHomeAndMountedSurface() {
        let runtime = YardRuntime()
        runtime.setActive(true)
        XCTAssertFalse(runtime.active)
        runtime.web.onPresentation?(true)
        XCTAssertTrue(runtime.active)
        runtime.setActive(false)
        XCTAssertFalse(runtime.active)
        runtime.setActive(true)
        XCTAssertTrue(runtime.active)
        runtime.web.onPresentation?(false)
        XCTAssertFalse(runtime.active)
        runtime.setActive(false)
        runtime.web.onPresentation?(true)
        XCTAssertFalse(runtime.active)
    }

    func testHiddenBeforeFirstFrameCanPauseAndWakeWithoutReload() {
        var gate = YardVisualGate()
        gate.begin(pageID: "paired")
        gate.sentActive(true)
        XCTAssertTrue(gate.allowsLifecycle(ready: true, active: false))
        gate.sentActive(false)
        XCTAssertFalse(gate.needsWatchdogFailure(active: false))
        XCTAssertTrue(gate.allowsLifecycle(ready: true, active: true))
        gate.sentActive(true)
        XCTAssertTrue(gate.needsWatchdogFailure(active: true))
        XCTAssertTrue(gate.reveal(pageID: "paired"))
        XCTAssertNil(gate.failure)
        XCTAssertFalse(gate.needsWatchdogFailure(active: true))
    }

    func testUnreadyPageDefersLifecycleAndVisibleFailureStillRecovers() {
        var gate = YardVisualGate()
        gate.begin(pageID: "family")
        XCTAssertFalse(gate.allowsLifecycle(ready: false, active: true))
        XCTAssertFalse(gate.allowsLifecycle(ready: false, active: false))
        XCTAssertFalse(gate.allowsLifecycle(ready: true, active: false))
        gate.sentActive(true)
        gate.fail("启动超时", recoverable: true)
        XCTAssertFalse(gate.reveal(pageID: "old"))
        XCTAssertEqual(gate.failure, "启动超时")
        XCTAssertTrue(gate.reveal(pageID: "family"))
        XCTAssertNil(gate.failure)
        gate.fail("导航失败", recoverable: false)
        XCTAssertTrue(gate.reveal(pageID: "family"))
        XCTAssertEqual(gate.failure, "导航失败")
    }
}
