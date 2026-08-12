import Darwin
import Foundation
import Testing
@testable import SlateQuotaCollector

@Suite("Collection schedule controller", .serialized)
struct CollectionScheduleControllerTests {
    @Test("settings default enabled and persist exact owner-only schema")
    func settingsDefaultToEnabledAndWriteOwnerOnly() throws {
        let root = try TemporaryDirectory()
        let store = SettingsStore(applicationSupportURL: root.url)

        #expect(try store.load() == .init(schemaVersion: 1, automaticCollectionEnabled: true))

        try store.save(.init(schemaVersion: 1, automaticCollectionEnabled: false))

        #expect(try store.load().automaticCollectionEnabled == false)
        #expect(try fileMode(store.settingsURL) & 0o777 == 0o600)
        let object = try #require(
            JSONSerialization.jsonObject(with: Data(contentsOf: store.settingsURL)) as? [String: Any]
        )
        #expect(Set(object.keys) == ["schema_version", "automatic_collection_enabled"])
        #expect(object["schema_version"] as? Int == 1)
        #expect(object["automatic_collection_enabled"] as? Bool == false)
    }

    @Test("settings reject extra, missing, wrong schema, and non-boolean fields", arguments: [
        #"{"schema_version":1,"automatic_collection_enabled":true,"api_key":"must-not-load"}"#,
        #"{"schema_version":1}"#,
        #"{"schema_version":2,"automatic_collection_enabled":true}"#,
        #"{"schema_version":1,"automatic_collection_enabled":1}"#,
        #"[]"#,
    ])
    func settingsRejectMalformedSchemas(_ json: String) throws {
        let root = try TemporaryDirectory()
        let store = SettingsStore(applicationSupportURL: root.url)
        try FileManager.default.createDirectory(
            at: store.settingsURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data(json.utf8).write(to: store.settingsURL)

        #expect(throws: SettingsStoreError.self) {
            try store.load()
        }
    }

    @Test("invalid value cannot be saved")
    func invalidSchemaCannotBeSaved() throws {
        let store = SettingsStore(applicationSupportURL: try TemporaryDirectory().url)

        #expect(throws: SettingsStoreError.self) {
            try store.save(.init(schemaVersion: 2, automaticCollectionEnabled: true))
        }
    }

    @Test("failed atomic rename preserves complete previous settings and cleans temporary file")
    func failedAtomicRenamePreservesPreviousSettings() throws {
        let root = try TemporaryDirectory()
        let initial = SettingsStore(applicationSupportURL: root.url)
        try initial.save(.init(schemaVersion: 1, automaticCollectionEnabled: false))
        let failing = SettingsStore(applicationSupportURL: root.url, rename: { _, _ in
            errno = EIO
            return -1
        })

        #expect(throws: SettingsStoreError.self) {
            try failing.save(.init(schemaVersion: 1, automaticCollectionEnabled: true))
        }

        #expect(try initial.load().automaticCollectionEnabled == false)
        let names = try FileManager.default.contentsOfDirectory(
            atPath: initial.settingsURL.deletingLastPathComponent().path
        )
        #expect(names == ["settings.json"])
    }

    @Test("temporary settings file is owner-only before atomic publish")
    func temporarySettingsFileIsOwnerOnly() throws {
        let root = try TemporaryDirectory()
        let observedMode = LockedInteger()
        let store = SettingsStore(applicationSupportURL: root.url, rename: { source, destination in
            let attributes = try! FileManager.default.attributesOfItem(atPath: source)
            observedMode.value = (attributes[.posixPermissions] as! NSNumber).intValue
            return Darwin.rename(source, destination)
        })

        try store.save(.init(schemaVersion: 1, automaticCollectionEnabled: true))

        #expect(observedMode.value & 0o777 == 0o600)
        #expect(try fileMode(store.directoryURL) & 0o777 == 0o700)
    }

    @Test("pause persists false, disables, waits for lock, then boots out")
    func pausePersistsFalseBeforeWaitingAndBootout() async throws {
        let events = LockedScheduleEvents()
        let settings = StubSettingsStore(enabled: true, events: events)
        let launchctl = StubLaunchctl(events: events)
        let lock = SequencedLockProbe(states: [true, false])
        let controller = makeController(
            settings: settings,
            launchctl: launchctl,
            events: events,
            lock: lock
        )

        try await controller.pause()

        #expect(events.values == [
            "settings.false", "launchctl.disable", "lock.wait", "launchctl.bootout",
        ])
        let services = await launchctl.recordedServices()
        #expect(services == [
            "gui/501/com.yym8224961.slate-quota-collector",
            "gui/501/com.yym8224961.slate-quota-collector",
        ])
        #expect(lock.urls == [RunLock.url(in: controller.applicationSupportURL), RunLock.url(in: controller.applicationSupportURL)])
    }

    @Test("pause without a held lock takes the fast path")
    func pauseWithoutLockDoesNotSleep() async throws {
        let events = LockedScheduleEvents()
        let controller = makeController(
            settings: StubSettingsStore(enabled: true, events: events),
            launchctl: StubLaunchctl(events: events),
            events: events,
            lock: SequencedLockProbe(states: [false])
        )

        try await controller.pause()

        #expect(events.values == ["settings.false", "launchctl.disable", "launchctl.bootout"])
    }

    @Test("pause waits no longer than forty-five seconds in quarter-second polls")
    func pauseWaitIsBoundedToFortyFiveSeconds() async throws {
        let events = LockedScheduleEvents()
        let lock = SequencedLockProbe(states: Array(repeating: true, count: 200))
        let controller = makeController(
            settings: StubSettingsStore(enabled: true, events: events),
            launchctl: StubLaunchctl(events: events),
            events: events,
            lock: lock
        )

        try await controller.pause()

        #expect(events.values.filter { $0 == "lock.wait" }.count == 180)
        #expect(lock.readCount == 180)
        #expect(events.values.last == "launchctl.bootout")
    }

    @Test("resume persists true, enables, then bootstraps collector plist")
    func resumePersistsTrueThenEnablesAndBootstraps() async throws {
        let events = LockedScheduleEvents()
        let launchctl = StubLaunchctl(events: events)
        let controller = makeController(
            settings: StubSettingsStore(enabled: false, events: events),
            launchctl: launchctl,
            events: events,
            lock: SequencedLockProbe(states: [])
        )

        try await controller.resume()

        #expect(events.values == ["settings.true", "launchctl.enable", "launchctl.bootstrap"])
        let plistURLs = await launchctl.recordedPlistURLs()
        #expect(plistURLs == [controller.collectorPlistURL])
    }

    @Test("repeated pause and resume calls remain successful and ordered")
    func repeatedPauseAndResumeAreIdempotent() async throws {
        let events = LockedScheduleEvents()
        let settings = StubSettingsStore(enabled: true, events: events)
        let launchctl = StubLaunchctl(events: events)
        let controller = makeController(
            settings: settings,
            launchctl: launchctl,
            events: events,
            lock: SequencedLockProbe(states: [false, false])
        )

        try await controller.pause()
        try await controller.pause()
        try await controller.resume()
        try await controller.resume()

        #expect(events.values == [
            "settings.false", "launchctl.disable", "launchctl.bootout",
            "settings.false", "launchctl.disable", "launchctl.bootout",
            "settings.true", "launchctl.enable", "launchctl.bootstrap",
            "settings.true", "launchctl.enable", "launchctl.bootstrap",
        ])
        #expect(try settings.load().automaticCollectionEnabled)
    }

    @Test("status combines the persisted switch with launchd loaded state")
    func statusReflectsSettingsAndLoadedState() async throws {
        let events = LockedScheduleEvents()
        let settings = StubSettingsStore(enabled: true, events: events)
        let launchctl = StubLaunchctl(events: events, loaded: true)
        let controller = makeController(
            settings: settings,
            launchctl: launchctl,
            events: events,
            lock: SequencedLockProbe(states: [])
        )

        #expect(try await controller.status() == .enabledLoaded)
        await launchctl.setLoaded(false)
        #expect(try await controller.status() == .enabledNotLoaded)
        try settings.save(.init(schemaVersion: 1, automaticCollectionEnabled: false))
        #expect(try await controller.status() == .disabled)
    }

    @Test("status exposes an in-progress pause without blocking the menu bar")
    func statusShowsPauseTransition() async throws {
        let events = LockedScheduleEvents()
        let launchctl = SuspendingLaunchctl(events: events)
        let controller = CollectionScheduleController(
            settings: StubSettingsStore(enabled: true, events: events),
            launchctl: launchctl,
            applicationSupportURL: URL(fileURLWithPath: "/tmp/slate-schedule-transition", isDirectory: true),
            collectorPlistURL: URL(fileURLWithPath: "/tmp/collector.plist"),
            uid: 501,
            lockIsHeld: { _ in false },
            sleepNanoseconds: { _ in }
        )
        let operation = Task { try await controller.pause() }
        await launchctl.waitUntilDisableEntered()

        #expect(try await controller.status() == .transitioning("正在关闭"))

        await launchctl.releaseDisable()
        try await operation.value
        #expect(try await controller.status() == .disabled)
    }

    @Test("disabled scheduled gate returns using settings only")
    func disabledScheduledGateReturnsBeforeCollectorConstruction() throws {
        let settings = StubSettingsStore(enabled: false)

        #expect(try CollectionScheduleController.shouldRunScheduledCollection(settings: settings) == false)
        #expect(settings.loadCount == 1)
    }

    @Test("enabled scheduled gate returns true")
    func enabledScheduledGateReturnsTrue() throws {
        let settings = StubSettingsStore(enabled: true)

        #expect(try CollectionScheduleController.shouldRunScheduledCollection(settings: settings))
        #expect(settings.loadCount == 1)
    }

    private func makeController(
        settings: StubSettingsStore,
        launchctl: StubLaunchctl,
        events: LockedScheduleEvents,
        lock: SequencedLockProbe
    ) -> CollectionScheduleController {
        CollectionScheduleController(
            settings: settings,
            launchctl: launchctl,
            applicationSupportURL: URL(fileURLWithPath: "/tmp/slate-schedule-tests", isDirectory: true),
            collectorPlistURL: URL(fileURLWithPath: "/tmp/com.yym8224961.slate-quota-collector.plist"),
            uid: 501,
            lockIsHeld: { lock.isHeld(at: $0) },
            sleepNanoseconds: { nanoseconds in
                #expect(nanoseconds == 250_000_000)
                events.append("lock.wait")
            }
        )
    }

    private func fileMode(_ url: URL) throws -> Int {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        return try #require((attributes[.posixPermissions] as? NSNumber)?.intValue)
    }
}

private final class LockedScheduleEvents: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String] = []

    var values: [String] { lock.withLock { storage } }

    func append(_ value: String) {
        lock.withLock { storage.append(value) }
    }
}

private final class LockedInteger: @unchecked Sendable {
    private let lock = NSLock()
    private var storage = 0

    var value: Int {
        get { lock.withLock { storage } }
        set { lock.withLock { storage = newValue } }
    }
}

private final class StubSettingsStore: SettingsPersisting, @unchecked Sendable {
    private let lock = NSLock()
    private var value: CollectorSettings
    private var reads = 0
    private let events: LockedScheduleEvents?

    init(enabled: Bool, events: LockedScheduleEvents? = nil) {
        value = .init(schemaVersion: 1, automaticCollectionEnabled: enabled)
        self.events = events
    }

    var loadCount: Int { lock.withLock { reads } }

    func load() throws -> CollectorSettings {
        lock.withLock {
            reads += 1
            return value
        }
    }

    func save(_ value: CollectorSettings) throws {
        lock.withLock { self.value = value }
        events?.append(value.automaticCollectionEnabled ? "settings.true" : "settings.false")
    }
}

private actor StubLaunchctl: LaunchctlControlling {
    private let events: LockedScheduleEvents
    private var loaded: Bool
    private(set) var services: [String] = []
    private(set) var plistURLs: [URL] = []

    init(events: LockedScheduleEvents, loaded: Bool = true) {
        self.events = events
        self.loaded = loaded
    }

    func disable(service: String) async throws {
        services.append(service)
        events.append("launchctl.disable")
    }

    func enable(service: String) async throws {
        services.append(service)
        events.append("launchctl.enable")
    }

    func bootstrap(plistURL: URL) async throws {
        plistURLs.append(plistURL)
        loaded = true
        events.append("launchctl.bootstrap")
    }

    func bootout(service: String) async throws {
        services.append(service)
        loaded = false
        events.append("launchctl.bootout")
    }

    func isLoaded(service: String) async -> Bool {
        loaded
    }

    func setLoaded(_ value: Bool) {
        loaded = value
    }

    func recordedServices() -> [String] {
        services
    }

    func recordedPlistURLs() -> [URL] {
        plistURLs
    }
}

private actor SuspendingLaunchctl: LaunchctlControlling {
    private let events: LockedScheduleEvents
    private var disableEntered = false
    private var disableWaiters: [CheckedContinuation<Void, Never>] = []
    private var disableRelease: CheckedContinuation<Void, Never>?

    init(events: LockedScheduleEvents) {
        self.events = events
    }

    func disable(service: String) async throws {
        events.append("launchctl.disable")
        disableEntered = true
        disableWaiters.forEach { $0.resume() }
        disableWaiters.removeAll()
        await withCheckedContinuation { disableRelease = $0 }
    }

    func enable(service: String) async throws {}
    func bootstrap(plistURL: URL) async throws {}

    func bootout(service: String) async throws {
        events.append("launchctl.bootout")
    }

    func isLoaded(service: String) async -> Bool {
        false
    }

    func waitUntilDisableEntered() async {
        if disableEntered { return }
        await withCheckedContinuation { disableWaiters.append($0) }
    }

    func releaseDisable() {
        disableRelease?.resume()
        disableRelease = nil
    }
}

private final class SequencedLockProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var states: [Bool]
    private var seenURLs: [URL] = []
    private var reads = 0

    init(states: [Bool]) {
        self.states = states
    }

    var urls: [URL] { lock.withLock { seenURLs } }
    var readCount: Int { lock.withLock { reads } }

    func isHeld(at url: URL) -> Bool {
        lock.withLock {
            seenURLs.append(url)
            reads += 1
            return states.isEmpty ? false : states.removeFirst()
        }
    }
}
