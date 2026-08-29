import AppKit
import Foundation

enum MenuBarAction: Sendable {
    case toggleAutomaticCollection
    case collectOnce
    case showDetailedStatus
    case quitMenuBar
}

protocol MenuBarActionHandling: Sendable {
    func pause() async throws
    func resume() async throws
    func collectOnce() async throws
    @MainActor func showDetailedStatus()
    @MainActor func quitMenuBar()
}

extension MenuBarActionHandling {
    @MainActor func showDetailedStatus() {}

    @MainActor func quitMenuBar() {
        NSApplication.shared.terminate(nil)
    }
}

@MainActor
final class MenuBarController: NSObject, NSMenuDelegate {
    typealias Now = @Sendable () -> Date

    private let actions: any MenuBarActionHandling
    private let schedule: any CollectionScheduleControlling
    private let statusReader: any MenuBarStatusReading
    private let statusWindowController: StatusWindowController
    private let now: Now
    private let viewModel = MenuBarViewModel()
    private let menu = NSMenu()
    private let statusItem: NSStatusItem?
    private var refreshTimer: Timer?
    private var currentAction: Task<Void, Never>?
    private var scheduleStatus: AutomaticCollectionStatus = .enabledNotLoaded
    private var statusSnapshot = MenuBarStatusSnapshot.unavailable
    private var busy: MenuBarBusyState?
    private(set) var lastActionErrorCode: String?
    private(set) var currentStatusErrorCode: String?

    private let headerItem = NSMenuItem(title: "Slate 额度监控", action: nil, keyEquivalent: "")
    private let automaticItem = NSMenuItem(title: "每 5 分钟自动采集", action: nil, keyEquivalent: "")
    private let collectItem = NSMenuItem(title: "立即采集一次", action: nil, keyEquivalent: "")
    private let codexItem = NSMenuItem(title: "Codex", action: nil, keyEquivalent: "")
    private let resetRadarItem = NSMenuItem(title: "重置雷达", action: nil, keyEquivalent: "")
    private let lastPushItem = NSMenuItem(title: "最后推送", action: nil, keyEquivalent: "")
    private let detailItem = NSMenuItem(title: "查看详细状态", action: nil, keyEquivalent: "")
    private let quitItem = NSMenuItem(title: "退出菜单栏", action: nil, keyEquivalent: "q")

    init(
        actions: any MenuBarActionHandling,
        schedule: any CollectionScheduleControlling,
        statusReader: any MenuBarStatusReading,
        statusWindowController: StatusWindowController = StatusWindowController(),
        installSystemStatusItem: Bool = true,
        now: @escaping Now = Date.init
    ) {
        self.actions = actions
        self.schedule = schedule
        self.statusReader = statusReader
        self.statusWindowController = statusWindowController
        self.now = now
        statusItem = installSystemStatusItem
            ? NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
            : nil
        super.init()
        configureMenu()
        applyPresentation()
    }

    var busyLine: String? { busy?.displayText }
    var menuItemsForTesting: [NSMenuItem] { menu.items }

    func run() {
        NSApplication.shared.setActivationPolicy(.accessory)
        Task { [weak self] in await self?.refresh() }
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in await self?.refresh() }
        }
        NSApplication.shared.run()
    }

    func refresh() async {
        let reader = statusReader
        do {
            statusSnapshot = try await Task.detached(priority: .utility) {
                try reader.readStatus()
            }.value
        } catch {
            statusSnapshot = .unavailable
        }

        do {
            scheduleStatus = try await schedule.status()
            currentStatusErrorCode = nil
        } catch {
            currentStatusErrorCode = Self.publicErrorCode(error)
        }
        applyPresentation()
    }

    func perform(_ action: MenuBarAction) {
        switch action {
        case .showDetailedStatus:
            statusWindowController.show(snapshot: snapshotForPresentation, schedule: scheduleStatus)
            actions.showDetailedStatus()
        case .quitMenuBar:
            actions.quitMenuBar()
        case .toggleAutomaticCollection:
            guard busy == nil else { return }
            beginToggle()
        case .collectOnce:
            guard busy == nil else { return }
            beginCollection()
        }
    }

    func waitForCurrentActionForTesting() async {
        let task = currentAction
        await task?.value
    }

    func menuWillOpen(_: NSMenu) {
        Task { [weak self] in await self?.refresh() }
    }

    @objc private func toggleAutomaticCollection() { perform(.toggleAutomaticCollection) }
    @objc private func collectOnce() { perform(.collectOnce) }
    @objc private func showDetailedStatus() { perform(.showDetailedStatus) }
    @objc private func quitMenuBar() { perform(.quitMenuBar) }

    private func configureMenu() {
        menu.autoenablesItems = false
        menu.delegate = self
        headerItem.isEnabled = false
        codexItem.isEnabled = false
        resetRadarItem.isEnabled = false
        lastPushItem.isEnabled = false

        automaticItem.target = self
        automaticItem.action = #selector(toggleAutomaticCollection)
        collectItem.target = self
        collectItem.action = #selector(collectOnce)
        detailItem.target = self
        detailItem.action = #selector(showDetailedStatus)
        quitItem.target = self
        quitItem.action = #selector(quitMenuBar)

        menu.items = [
            headerItem,
            .separator(),
            automaticItem,
            collectItem,
            .separator(),
            codexItem,
            resetRadarItem,
            lastPushItem,
            .separator(),
            detailItem,
            quitItem,
        ]
        statusItem?.menu = menu
    }

    private func beginToggle() {
        busy = .switching
        lastActionErrorCode = nil
        applyPresentation()
        let schedule = self.schedule
        let actions = self.actions
        currentAction = Task { [weak self] in
            guard let self else { return }
            do {
                let current = try await schedule.status()
                switch current {
                case .enabledLoaded, .enabledNotLoaded:
                    busy = .closing
                    applyPresentation()
                    try await actions.pause()
                case .disabled:
                    busy = .opening
                    applyPresentation()
                    try await actions.resume()
                case .transitioning:
                    throw CollectionScheduleError.transitionBusy
                }
            } catch {
                lastActionErrorCode = Self.publicErrorCode(error)
            }
            busy = nil
            applyPresentation()
            await refresh()
            currentAction = nil
        }
    }

    private func beginCollection() {
        busy = .collecting
        lastActionErrorCode = nil
        applyPresentation()
        let actions = self.actions
        currentAction = Task { [weak self] in
            guard let self else { return }
            do {
                try await actions.collectOnce()
            } catch {
                lastActionErrorCode = Self.publicErrorCode(error)
            }
            busy = nil
            applyPresentation()
            await refresh()
            currentAction = nil
        }
    }

    private func applyPresentation() {
        let value = viewModel.presentation(
            snapshot: snapshotForPresentation,
            schedule: scheduleStatus,
            busy: busy,
            now: now()
        )
        if let button = statusItem?.button {
            let image = NSImage(systemSymbolName: value.iconSystemName, accessibilityDescription: "Slate 额度监控")
            image?.isTemplate = true
            button.image = image
        }
        automaticItem.state = value.automaticCollectionChecked ? .on : .off
        automaticItem.title = value.busyLine ?? value.automaticCollectionTitle
        automaticItem.isEnabled = busy == nil
        collectItem.isEnabled = busy == nil
        codexItem.title = "Codex          \(value.codexLine)"
        resetRadarItem.title = "重置雷达       \(value.resetRadarLine)"
        lastPushItem.title = "最后推送       \(value.lastPushLine)"
    }

    private var snapshotForPresentation: MenuBarStatusSnapshot {
        var codes = statusSnapshot.publicErrorCodes
        if let lastActionErrorCode {
            codes["collector"] = MenuBarViewModel.safePublicCode(lastActionErrorCode)
        }
        if let currentStatusErrorCode {
            codes["schedule"] = MenuBarViewModel.safePublicCode(currentStatusErrorCode)
        }
        return MenuBarStatusSnapshot(
            codexSummary: statusSnapshot.codexSummary,
            openCodeGoSummary: statusSnapshot.openCodeGoSummary,
            resetRadarSummary: statusSnapshot.resetRadarSummary,
            lastSuccessAt: statusSnapshot.lastSuccessAt,
            lastPushAt: statusSnapshot.lastPushAt,
            publicErrorCodes: codes
        )
    }

    private static func publicErrorCode(_ error: any Error) -> String {
        switch error {
        case let value as CollectionScheduleError: value.publicCode
        case let value as SettingsStoreError: value.publicCode
        case let value as SnapshotCacheError: value.publicCode
        default: "internal_failure"
        }
    }
}
