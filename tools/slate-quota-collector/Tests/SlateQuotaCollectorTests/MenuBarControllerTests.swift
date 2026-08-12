import AppKit
import Foundation
import Testing
@testable import SlateQuotaCollector

@Suite("Menu bar controller", .serialized)
@MainActor
struct MenuBarControllerTests {
    @Test("menu contains approved items in exact order and quit never pauses")
    func menuContainsApprovedItemsAndQuitDoesNotPause() async throws {
        let actions = RecordingMenuBarActions()
        let schedule = ControllableSchedule(status: .enabledLoaded)
        let controller = makeController(actions: actions, schedule: schedule)
        await controller.refresh()

        let items = controller.menuItemsForTesting
        #expect(items.map(\.isSeparatorItem) == [
            false, true, false, false, true, false, false, false, true, false, false,
        ])
        #expect(items.filter { !$0.isSeparatorItem }.map(\.title) == [
            "Slate 额度监控",
            "每 5 分钟自动采集",
            "立即采集一次",
            "Codex          正常 · 剩余 91%",
            "OpenCode Go    注意 · 剩余 18%",
            "最后推送       今天 17:16",
            "查看详细状态",
            "退出菜单栏",
        ])
        #expect(items[0].isEnabled == false)
        #expect(items[2].state == .on)
        #expect(items[2].isEnabled)
        #expect(items[3].isEnabled)
        #expect(items[5].isEnabled == false)
        #expect(items[6].isEnabled == false)
        #expect(items[7].isEnabled == false)
        #expect(items[9].isEnabled)
        #expect(items[10].isEnabled)
        for index in [0, 5, 6, 7] {
            #expect(items[index].action == nil)
            #expect(items[index].target == nil)
        }
        expectAction(items[2], selector: "toggleAutomaticCollection", target: controller)
        expectAction(items[3], selector: "collectOnce", target: controller)
        expectAction(items[9], selector: "showDetailedStatus", target: controller)
        expectAction(items[10], selector: "quitMenuBar", target: controller)

        invoke(items[10])

        #expect(actions.pauseCount == 0)
        #expect(actions.quitCount == 1)
        #expect(await schedule.pauseCount == 0)
    }

    @Test("toggle asks current schedule and pauses when enabled")
    func toggleUsesCurrentScheduleToPause() async throws {
        let actions = RecordingMenuBarActions()
        let schedule = ControllableSchedule(status: .disabled)
        let controller = makeController(actions: actions, schedule: schedule)
        await controller.refresh()
        await schedule.setStatus(.enabledLoaded)

        controller.perform(.toggleAutomaticCollection)
        await actions.pauseStarted.wait()

        #expect(controller.busyLine == "正在关闭")
        expectRepeatActionsDisabledAndLifecycleAvailable(controller)
        #expect(actions.pauseCount == 1)
        #expect(actions.resumeCount == 0)

        let busyItems = controller.menuItemsForTesting
        invoke(busyItems[9])
        invoke(busyItems[10])
        #expect(actions.showCount == 1)
        #expect(actions.quitCount == 1)

        actions.finishPause.resume()
        await controller.waitForCurrentActionForTesting()
        let items = controller.menuItemsForTesting
        #expect(items[2].isEnabled)
        #expect(items[3].isEnabled)
    }

    @Test("toggle resumes from disabled and immediate collection remains available while paused")
    func toggleResumesAndCollectionWorksWhilePaused() async throws {
        let actions = RecordingMenuBarActions()
        let schedule = ControllableSchedule(status: .disabled)
        let controller = makeController(actions: actions, schedule: schedule)
        await controller.refresh()

        #expect(controller.menuItemsForTesting[3].isEnabled)
        controller.perform(.collectOnce)
        await controller.waitForCurrentActionForTesting()
        #expect(actions.collectCount == 1)

        controller.perform(.toggleAutomaticCollection)
        await controller.waitForCurrentActionForTesting()

        #expect(actions.resumeCount == 1)
        #expect(actions.pauseCount == 0)
    }

    @Test("collect busy disables duplicate actions but menu remains responsive")
    func asynchronousBusyStateDisablesDuplicateActions() async throws {
        let actions = RecordingMenuBarActions(blockCollect: true)
        let schedule = ControllableSchedule(status: .enabledLoaded)
        let controller = makeController(actions: actions, schedule: schedule)
        await controller.refresh()

        controller.perform(.collectOnce)
        await actions.collectStarted.wait()

        #expect(controller.busyLine == "正在采集")
        expectRepeatActionsDisabledAndLifecycleAvailable(controller)
        controller.perform(.collectOnce)
        #expect(actions.collectCount == 1)

        let busyItems = controller.menuItemsForTesting
        invoke(busyItems[9])
        invoke(busyItems[10])
        #expect(actions.showCount == 1)
        #expect(actions.quitCount == 1)

        actions.finishCollect.resume()
        await controller.waitForCurrentActionForTesting()
        let items = controller.menuItemsForTesting
        #expect(items[2].isEnabled)
        #expect(items[3].isEnabled)
    }

    @Test("failed action clears busy state and restores interaction using a public code")
    func failedActionRestoresInteraction() async throws {
        let actions = RecordingMenuBarActions(collectError: CollectionScheduleError.ioFailure)
        let schedule = ControllableSchedule(status: .enabledLoaded)
        let controller = makeController(actions: actions, schedule: schedule)
        await controller.refresh()

        controller.perform(.collectOnce)
        await controller.waitForCurrentActionForTesting()

        #expect(controller.busyLine == nil)
        #expect(controller.menuItemsForTesting[2].isEnabled)
        #expect(controller.menuItemsForTesting[3].isEnabled)
        #expect(controller.lastActionErrorCode == "schedule_io")
    }

    @Test("recovered status read clears only its transient error and preserves action failure")
    func recoveredStatusReadClearsTransientErrorOnly() async throws {
        let actions = RecordingMenuBarActions(collectError: SnapshotCacheError.cacheCorrupt)
        let schedule = RecoveringSchedule(results: [
            .success(.enabledLoaded),
            .failure(.ioFailure),
            .success(.enabledLoaded),
        ])
        let statusWindow = StatusWindowController(createPanel: false)
        let controller = makeController(
            actions: actions,
            schedule: schedule,
            statusWindow: statusWindow
        )
        await controller.refresh()

        controller.perform(.collectOnce)
        await controller.waitForCurrentActionForTesting()

        #expect(controller.lastActionErrorCode == "cache_corrupt")
        #expect(controller.currentStatusErrorCode == "schedule_io")
        controller.perform(.showDetailedStatus)
        #expect(statusWindow.renderedText.contains("collector：cache_corrupt"))
        #expect(statusWindow.renderedText.contains("schedule：schedule_io"))

        await controller.refresh()

        #expect(controller.lastActionErrorCode == "cache_corrupt")
        #expect(controller.currentStatusErrorCode == nil)
        controller.perform(.showDetailedStatus)
        #expect(statusWindow.renderedText.contains("collector：cache_corrupt"))
        #expect(statusWindow.renderedText.contains("schedule_io") == false)
    }

    @Test("details include only approved status fields and public error codes")
    func detailedStatusIsSanitized() async throws {
        let actions = RecordingMenuBarActions()
        let schedule = ControllableSchedule(status: .disabled)
        let forbidden = "https://slate.local/api/v1/contents/private-id/data"
        let snapshot = MenuBarStatusSnapshot(
            codexSummary: "正常 · 剩余 91%",
            openCodeGoSummary: "无可信数据",
            lastSuccessAt: Date(timeIntervalSince1970: 1_754_990_140),
            lastPushAt: Date(timeIntervalSince1970: 1_754_990_200),
            publicErrorCodes: ["codex": forbidden, "opencode_go": "rate_limited"]
        )
        let statusWindow = StatusWindowController(createPanel: false)
        let controller = makeController(
            actions: actions,
            schedule: schedule,
            snapshot: snapshot,
            statusWindow: statusWindow
        )
        await controller.refresh()

        controller.perform(.showDetailedStatus)

        #expect(statusWindow.renderedText.contains("自动采集：已关闭"))
        #expect(statusWindow.renderedText.contains("Codex：正常 · 剩余 91%"))
        #expect(statusWindow.renderedText.contains("OpenCode Go：无可信数据"))
        #expect(statusWindow.renderedText.contains("opencode_go：rate_limited"))
        #expect(statusWindow.renderedText.contains("internal_failure"))
        for forbiddenText in ["https://", "private-id", "contentId", "ETag", "Authorization", "/Users/"] {
            #expect(statusWindow.renderedText.contains(forbiddenText) == false)
        }
    }

    private func makeController(
        actions: RecordingMenuBarActions,
        schedule: any CollectionScheduleControlling,
        snapshot: MenuBarStatusSnapshot = .fixture,
        statusWindow: StatusWindowController = StatusWindowController(createPanel: false)
    ) -> MenuBarController {
        MenuBarController(
            actions: actions,
            schedule: schedule,
            statusReader: FixedMenuBarStatusReader(snapshot: snapshot),
            statusWindowController: statusWindow,
            installSystemStatusItem: false,
            now: { Date(timeIntervalSince1970: 1_754_990_200) }
        )
    }

    private func expectAction(
        _ item: NSMenuItem,
        selector: String,
        target: MenuBarController
    ) {
        #expect(item.action == NSSelectorFromString(selector))
        #expect(item.target === target)
    }

    private func expectRepeatActionsDisabledAndLifecycleAvailable(_ controller: MenuBarController) {
        let items = controller.menuItemsForTesting
        #expect(items[2].isEnabled == false)
        #expect(items[3].isEnabled == false)
        #expect(items[2].title == controller.busyLine)
        #expect(items[9].isEnabled)
        #expect(items[10].isEnabled)
        expectAction(items[9], selector: "showDetailedStatus", target: controller)
        expectAction(items[10], selector: "quitMenuBar", target: controller)
    }

    private func invoke(_ item: NSMenuItem) {
        let target = item.target as? NSObject
        #expect(target != nil)
        #expect(item.action != nil)
        _ = target?.perform(item.action)
    }
}

private extension MenuBarStatusSnapshot {
    static let fixture = Self(
        codexSummary: "正常 · 剩余 91%",
        openCodeGoSummary: "注意 · 剩余 18%",
        lastSuccessAt: Date(timeIntervalSince1970: 1_754_990_140),
        lastPushAt: Date(timeIntervalSince1970: 1_754_990_200),
        publicErrorCodes: [:]
    )
}

private struct FixedMenuBarStatusReader: MenuBarStatusReading {
    let snapshot: MenuBarStatusSnapshot
    func readStatus() throws -> MenuBarStatusSnapshot { snapshot }
}

private actor ControllableSchedule: CollectionScheduleControlling {
    private var currentStatus: AutomaticCollectionStatus
    private(set) var pauseCount = 0
    private(set) var resumeCount = 0

    init(status: AutomaticCollectionStatus) {
        currentStatus = status
    }

    func setStatus(_ value: AutomaticCollectionStatus) {
        currentStatus = value
    }

    func status() async throws -> AutomaticCollectionStatus { currentStatus }
    func pause() async throws { pauseCount += 1; currentStatus = .disabled }
    func resume() async throws { resumeCount += 1; currentStatus = .enabledLoaded }
}

private actor RecoveringSchedule: CollectionScheduleControlling {
    private var results: [Result<AutomaticCollectionStatus, CollectionScheduleError>]

    init(results: [Result<AutomaticCollectionStatus, CollectionScheduleError>]) {
        self.results = results
    }

    func status() async throws -> AutomaticCollectionStatus {
        guard !results.isEmpty else { return .enabledLoaded }
        return try results.removeFirst().get()
    }

    func pause() async throws {}
    func resume() async throws {}
}

@MainActor
private final class RecordingMenuBarActions: MenuBarActionHandling {
    private(set) var pauseCount = 0
    private(set) var resumeCount = 0
    private(set) var collectCount = 0
    private(set) var showCount = 0
    private(set) var quitCount = 0
    let pauseStarted = AsyncSignal()
    let collectStarted = AsyncSignal()
    let finishPause = AsyncGate(initiallyOpen: false)
    let finishCollect: AsyncGate
    private let collectError: (any Error)?

    init(blockCollect: Bool = false, collectError: (any Error)? = nil) {
        finishCollect = AsyncGate(initiallyOpen: !blockCollect)
        self.collectError = collectError
    }

    func pause() async throws {
        pauseCount += 1
        pauseStarted.signal()
        await finishPause.wait()
    }

    func resume() async throws { resumeCount += 1 }

    func collectOnce() async throws {
        collectCount += 1
        collectStarted.signal()
        await finishCollect.wait()
        if let collectError { throw collectError }
    }

    func showDetailedStatus() { showCount += 1 }
    func quitMenuBar() { quitCount += 1 }
}

private actor AsyncSignal {
    private var signalled = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        if signalled { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    nonisolated func signal() {
        Task { await signalIsolated() }
    }

    private func signalIsolated() {
        signalled = true
        let current = waiters
        waiters.removeAll()
        current.forEach { $0.resume() }
    }
}

private actor AsyncGate {
    private var open: Bool
    private var waiters: [CheckedContinuation<Void, Never>] = []

    init(initiallyOpen: Bool) { open = initiallyOpen }

    func wait() async {
        if open { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    nonisolated func resume() {
        Task { await openGate() }
    }

    private func openGate() {
        open = true
        let current = waiters
        waiters.removeAll()
        current.forEach { $0.resume() }
    }
}
