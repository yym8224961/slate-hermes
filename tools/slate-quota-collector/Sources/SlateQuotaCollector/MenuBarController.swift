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
    private static let approvedMenuTitles = [
        "Slate 额度监控", "每 5 分钟自动采集", "立即采集一次", "Codex",
        "OpenCode Go", "最后推送", "查看详细状态", "退出菜单栏",
    ]

    private let actions: any MenuBarActionHandling
    private let schedule: any CollectionScheduleControlling
    private let statusReader: any MenuBarStatusReading
    private let statusWindowController: StatusWindowController
    private let viewModel = MenuBarViewModel()
    private let menu = NSMenu()
    private let statusItem: NSStatusItem?
    private var refreshTimer: Timer?
    private var currentAction: Task<Void, Never>?
    private var scheduleStatus: AutomaticCollectionStatus = .enabledNotLoaded
    private var statusSnapshot = MenuBarStatusSnapshot.unavailable
    private var busy: MenuBarBusyState?
    private(set) var lastActionErrorCode: String?

    private let headerItem = NSMenuItem(title: "Slate 额度监控", action: nil, keyEquivalent: "")
    private let automaticItem = NSMenuItem(title: "每 5 分钟自动采集", action: nil, keyEquivalent: "")
    private let collectItem = NSMenuItem(title: "立即采集一次", action: nil, keyEquivalent: "")
    private let codexItem = NSMenuItem(title: "Codex", action: nil, keyEquivalent: "")
    private let openCodeItem = NSMenuItem(title: "OpenCode Go", action: nil, keyEquivalent: "")
    private let lastPushItem = NSMenuItem(title: "最后推送", action: nil, keyEquivalent: "")
    private let detailItem = NSMenuItem(title: "查看详细状态", action: nil, keyEquivalent: "")
    private let quitItem = NSMenuItem(title: "退出菜单栏", action: nil, keyEquivalent: "q")

    init(
        actions: any MenuBarActionHandling,
        schedule: any CollectionScheduleControlling,
        statusReader: any MenuBarStatusReading,
        statusWindowController: StatusWindowController = StatusWindowController(),
        installSystemStatusItem: Bool = true
    ) {
        self.actions = actions
        self.schedule = schedule
        self.statusReader = statusReader
        self.statusWindowController = statusWindowController
        statusItem = installSystemStatusItem
            ? NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
            : nil
        super.init()
        configureMenu()
        applyPresentation()
    }

    var menuTitles: [String] { Self.approvedMenuTitles }
    var busyLine: String? { busy?.displayText }
    var repeatedActionsEnabled: Bool { busy == nil }
    var collectOnceEnabled: Bool { collectItem.isEnabled }
    var menuIsEnabled: Bool { true }
    var providerMenuLines: [String] { [codexItem.title, openCodeItem.title] }

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
        } catch {
            lastActionErrorCode = Self.publicErrorCode(error)
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
        openCodeItem.isEnabled = false
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
            openCodeItem,
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
            busy: busy
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
        openCodeItem.title = "OpenCode Go    \(value.openCodeGoLine)"
        lastPushItem.title = "最后推送       \(value.lastPushLine)"
    }

    private var snapshotForPresentation: MenuBarStatusSnapshot {
        guard let lastActionErrorCode else { return statusSnapshot }
        var codes = statusSnapshot.publicErrorCodes
        codes["schedule"] = MenuBarViewModel.safePublicCode(lastActionErrorCode)
        return MenuBarStatusSnapshot(
            codexSummary: statusSnapshot.codexSummary,
            openCodeGoSummary: statusSnapshot.openCodeGoSummary,
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
