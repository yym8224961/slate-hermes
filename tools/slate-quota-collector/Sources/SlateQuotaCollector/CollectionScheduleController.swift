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

enum CollectionScheduleError: Error, Equatable, Sendable, CustomStringConvertible {
    case transitionBusy
    case unsafeTransitionLease
    case ioFailure

    var publicCode: String {
        switch self {
        case .transitionBusy: "schedule_busy"
        case .unsafeTransitionLease: "schedule_lease"
        case .ioFailure: "schedule_io"
        }
    }

    var description: String {
        "CollectionScheduleError(code: \(publicCode))"
    }
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
    private var transitionGeneration: UInt64 = 0

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
        while true {
            if let transition { return .transitioning(transition) }
            if try CollectionTransitionLease.isHeld(in: applicationSupportURL) {
                return .transitioning("正在切换")
            }
            let generation = transitionGeneration
            let before = try settings.load()
            guard before.automaticCollectionEnabled else {
                if let transition { return .transitioning(transition) }
                if try CollectionTransitionLease.isHeld(in: applicationSupportURL) {
                    return .transitioning("正在切换")
                }
                guard generation == transitionGeneration else { continue }
                return .disabled
            }

            let loaded = await launchctl.isLoaded(service: service)

            if let transition { return .transitioning(transition) }
            if try CollectionTransitionLease.isHeld(in: applicationSupportURL) {
                return .transitioning("正在切换")
            }
            guard generation == transitionGeneration else { continue }
            let after = try settings.load()
            guard after == before else { continue }
            return loaded ? .enabledLoaded : .enabledNotLoaded
        }
    }

    func pause() async throws {
        let lease = try beginTransition(label: "正在关闭")
        defer { finishTransition(lease) }

        try settings.save(.init(schemaVersion: 1, automaticCollectionEnabled: false))
        try await launchctl.disable(service: service)
        try await waitForCurrentRun()
        try await launchctl.bootout(service: service)
    }

    func resume() async throws {
        let lease = try beginTransition(label: "正在开启")
        defer { finishTransition(lease) }

        try settings.save(.enabled)
        try await launchctl.enable(service: service)
        try await launchctl.bootstrap(plistURL: collectorPlistURL)
    }

    static func shouldRunScheduledCollection(settings: any SettingsPersisting) throws -> Bool {
        try settings.load().automaticCollectionEnabled
    }

    private func beginTransition(label: String) throws -> CollectionTransitionLease {
        guard transition == nil else { throw CollectionScheduleError.transitionBusy }
        let lease = try CollectionTransitionLease.acquire(in: applicationSupportURL)
        transition = label
        transitionGeneration &+= 1
        return lease
    }

    private func finishTransition(_ lease: CollectionTransitionLease) {
        transition = nil
        transitionGeneration &+= 1
        lease.release()
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

final class CollectionTransitionLease: @unchecked Sendable {
    private static let lockName = "transition.lock"
    private let descriptor: Int32
    private let stateLock = NSLock()
    private var released = false

    private init(descriptor: Int32) {
        self.descriptor = descriptor
    }

    static func url(in applicationSupportURL: URL) -> URL {
        SecureApplicationSupportDirectory.url(in: applicationSupportURL)
            .appendingPathComponent(lockName)
    }

    static func acquire(in applicationSupportURL: URL) throws -> CollectionTransitionLease {
        let directory: Int32
        do {
            directory = try SecureApplicationSupportDirectory.open(
                applicationSupportURL: applicationSupportURL,
                createIfMissing: true
            )
        } catch SecureApplicationSupportDirectory.Error.unsafePath {
            throw CollectionScheduleError.unsafeTransitionLease
        } catch {
            throw CollectionScheduleError.ioFailure
        }
        defer { _ = close(directory) }

        let descriptor = openat(
            directory,
            lockName,
            O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC,
            S_IRUSR | S_IWUSR
        )
        guard descriptor >= 0 else {
            throw errno == ELOOP ? CollectionScheduleError.unsafeTransitionLease : .ioFailure
        }
        var status = stat()
        guard fstat(descriptor, &status) == 0 else {
            _ = close(descriptor)
            throw CollectionScheduleError.ioFailure
        }
        guard status.st_mode & S_IFMT == S_IFREG,
              status.st_uid == getuid(),
              status.st_mode & 0o777 == 0o600,
              status.st_nlink == 1 else {
            _ = close(descriptor)
            throw CollectionScheduleError.unsafeTransitionLease
        }

        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            let lockError = errno
            _ = close(descriptor)
            if lockError == EWOULDBLOCK || lockError == EAGAIN {
                throw CollectionScheduleError.transitionBusy
            }
            throw CollectionScheduleError.ioFailure
        }
        return CollectionTransitionLease(descriptor: descriptor)
    }

    static func isHeld(in applicationSupportURL: URL) throws -> Bool {
        do {
            let lease = try acquire(in: applicationSupportURL)
            lease.release()
            return false
        } catch CollectionScheduleError.transitionBusy {
            return true
        }
    }

    func release() {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard !released else { return }
        _ = flock(descriptor, LOCK_UN)
        _ = close(descriptor)
        released = true
    }

    deinit {
        release()
    }
}
