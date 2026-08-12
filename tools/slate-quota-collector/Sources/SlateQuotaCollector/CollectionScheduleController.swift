import Darwin
import Foundation

protocol LaunchctlControlling: Sendable {
    /// Implementations normalize launchctl's already-enabled/already-disabled results as success.
    func disable(service: String) async throws
    func enable(service: String) async throws
    func bootstrap(plistURL: URL) async throws
    func bootout(service: String) async throws
    func isLoaded(service: String) async -> Bool
}

enum AutomaticCollectionStatus: Equatable, Sendable {
    case enabledLoaded
    case enabledNotLoaded
    case disabled
    case transitioning(String)
}

protocol CollectionScheduleControlling: Sendable {
    func status() async throws -> AutomaticCollectionStatus
    func pause() async throws
    func resume() async throws
}

actor CollectionScheduleController: CollectionScheduleControlling {
    typealias LockProbe = @Sendable (_ lockURL: URL) -> Bool
    typealias Sleep = @Sendable (_ nanoseconds: UInt64) async throws -> Void

    static let collectorLabel = "com.yym8224961.slate-quota-collector"
    private static let pollIntervalNanoseconds: UInt64 = 250_000_000
    private static let maximumWaitNanoseconds: UInt64 = 45_000_000_000

    private let settings: any SettingsPersisting
    private let launchctl: any LaunchctlControlling
    nonisolated let applicationSupportURL: URL
    nonisolated let collectorPlistURL: URL
    private let service: String
    private let lockIsHeld: LockProbe
    private let sleepNanoseconds: Sleep
    private var transition: String?

    init(
        settings: any SettingsPersisting,
        launchctl: any LaunchctlControlling,
        applicationSupportURL: URL,
        collectorPlistURL: URL,
        uid: uid_t = getuid(),
        lockIsHeld: @escaping LockProbe = { FileManager.default.fileExists(atPath: $0.path) },
        sleepNanoseconds: @escaping Sleep = { try await Task.sleep(nanoseconds: $0) }
    ) {
        self.settings = settings
        self.launchctl = launchctl
        self.applicationSupportURL = applicationSupportURL
        self.collectorPlistURL = collectorPlistURL
        service = "gui/\(uid)/\(Self.collectorLabel)"
        self.lockIsHeld = lockIsHeld
        self.sleepNanoseconds = sleepNanoseconds
    }

    func status() async throws -> AutomaticCollectionStatus {
        if let transition { return .transitioning(transition) }
        guard try settings.load().automaticCollectionEnabled else { return .disabled }
        return await launchctl.isLoaded(service: service) ? .enabledLoaded : .enabledNotLoaded
    }

    func pause() async throws {
        if transition != nil { return }
        transition = "正在关闭"
        defer { transition = nil }

        try settings.save(.init(schemaVersion: 1, automaticCollectionEnabled: false))
        try await launchctl.disable(service: service)
        try await waitForCurrentRun()
        try await launchctl.bootout(service: service)
    }

    func resume() async throws {
        if transition != nil { return }
        transition = "正在开启"
        defer { transition = nil }

        try settings.save(.enabled)
        try await launchctl.enable(service: service)
        try await launchctl.bootstrap(plistURL: collectorPlistURL)
    }

    static func shouldRunScheduledCollection(settings: any SettingsPersisting) throws -> Bool {
        try settings.load().automaticCollectionEnabled
    }

    private func waitForCurrentRun() async throws {
        let lockURL = RunLock.url(in: applicationSupportURL)
        var waited: UInt64 = 0
        while waited < Self.maximumWaitNanoseconds, lockIsHeld(lockURL) {
            try await sleepNanoseconds(Self.pollIntervalNanoseconds)
            waited += Self.pollIntervalNanoseconds
        }
    }
}
