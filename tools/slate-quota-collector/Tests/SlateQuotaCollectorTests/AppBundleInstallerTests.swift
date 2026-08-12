import Foundation
import Testing
@testable import SlateQuotaCollector

@Suite("App bundle installer", .serialized)
struct AppBundleInstallerTests {
    @Test("CLI exposes the eight approved commands and keeps internal entries hidden")
    func parsesApprovedCommandsAndRejectsSecretArguments() throws {
        #expect(try CLIArguments(["setup"]) == .setup)
        #expect(try CLIArguments(["collect", "--dry-run"]) == .collect(.dryRun))
        #expect(try CLIArguments(["collect", "--once"]) == .collect(.pushOnce))
        #expect(try CLIArguments(["collect", "--scheduled"]) == .collectScheduled)
        #expect(try CLIArguments(["collect", "--worker", "scheduled"]) == .collectWorker(.scheduled))
        #expect(try CLIArguments(["--menu-bar"]) == .menuBar)
        #expect(try CLIArguments(["pause"]) == .pause)
        #expect(try CLIArguments(["resume"]) == .resume)
        #expect(try CLIArguments(["install-launch-agent"]) == .installLaunchAgent)
        #expect(try CLIArguments(["status"]) == .status)
        #expect(try CLIArguments(["uninstall-launch-agent"]) == .uninstallLaunchAgent)

        for arguments in [
            ["collect", "--api-key", "secret"],
            ["setup", "--slate-url", "secret"],
            ["collect", "--worker", "secret"],
            ["--menu-bar", "secret"],
        ] {
            #expect(throws: CLIError.self) { try CLIArguments(arguments) }
        }

        let help = CLIArguments.visibleHelp
        for command in [
            "setup", "collect --dry-run", "collect --once", "pause", "resume",
            "install-launch-agent", "status", "uninstall-launch-agent",
        ] {
            #expect(help.contains(command))
        }
        #expect(help.contains("--worker") == false)
        #expect(help.contains("--scheduled") == false)
        #expect(help.contains("--menu-bar") == false)
        #expect(help.localizedCaseInsensitiveContains("api-key") == false)
        #expect(help.localizedCaseInsensitiveContains("slate-url") == false)
    }

    @Test("app bundle is an agent-only absolute layout with owner-only binaries")
    func installsAgentOnlyBundleAndStableBinary() throws {
        let root = try TemporaryDirectory()
        let paths = InstallationPaths.fixture(root: root.url)
        let source = root.url.appendingPathComponent("release/slate-quota-collector")
        try FileManager.default.createDirectory(at: source.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("fixture-binary".utf8).write(to: source)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: source.path)

        let layout = try AppBundleInstaller(paths: paths).install(executableURL: source)

        #expect(layout.bundleURL.path == paths.appBundleURL.path)
        #expect(layout.bundleExecutableURL.path.hasPrefix("/"))
        #expect(layout.stableExecutableURL.path.hasPrefix("/"))
        #expect(try fileMode(layout.bundleExecutableURL) & 0o777 == 0o700)
        #expect(try fileMode(layout.stableExecutableURL) & 0o777 == 0o700)
        #expect(try fileMode(layout.infoPlistURL) & 0o777 == 0o600)

        let info = try #require(
            PropertyListSerialization.propertyList(
                from: Data(contentsOf: layout.infoPlistURL), options: [], format: nil
            ) as? [String: Any]
        )
        #expect(info["CFBundlePackageType"] as? String == "APPL")
        #expect(info["CFBundleIdentifier"] as? String == "com.yym8224961.slate-quota-menubar")
        #expect(info["CFBundleName"] as? String == "Slate 额度监控")
        #expect(info["CFBundleExecutable"] as? String == "slate-quota-collector")
        #expect(info["LSUIElement"] as? Bool == true)
        #expect(info["LSMinimumSystemVersion"] as? String == "13.0")
    }

    @Test("app installer rejects a substituted bundle without changing its target")
    func appInstallerRejectsBundleSymlink() throws {
        let root = try TemporaryDirectory()
        let paths = InstallationPaths.fixture(root: root.url)
        let applications = paths.appBundleURL.deletingLastPathComponent()
        let target = root.url.appendingPathComponent("unrelated-app-target", isDirectory: true)
        let source = root.url.appendingPathComponent("release-binary")
        try FileManager.default.createDirectory(at: applications, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: target.path)
        try Data("binary".utf8).write(to: source)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: source.path)
        try FileManager.default.createSymbolicLink(at: paths.appBundleURL, withDestinationURL: target)

        #expect(throws: InstallerError.self) {
            try AppBundleInstaller(paths: paths).install(executableURL: source)
        }
        #expect(try fileMode(target) & 0o777 == 0o755)
        #expect(FileManager.default.fileExists(atPath: target.appendingPathComponent("Contents").path) == false)
    }

    @Test("app installer refuses an unrecognized owner app and preserves its sentinel")
    func refusesPreexistingAppWithSentinel() throws {
        let root = try TemporaryDirectory()
        let paths = InstallationPaths.fixture(root: root.url)
        let sentinel = paths.appBundleURL.appendingPathComponent("do-not-delete.txt")
        let source = try executableFixture(root: root.url, contents: "new-binary")
        try FileManager.default.createDirectory(
            at: paths.appBundleURL, withIntermediateDirectories: true
        )
        try Data("keep-me".utf8).write(to: sentinel)

        #expect(throws: InstallerError.self) {
            try AppBundleInstaller(paths: paths).install(executableURL: source)
        }

        #expect(try String(contentsOf: sentinel, encoding: .utf8) == "keep-me")
    }

    @Test("failed upgrade restores the complete prior app and stable binary generation")
    func failedUpgradePreservesRecognizedPriorGeneration() throws {
        let root = try TemporaryDirectory()
        let paths = InstallationPaths.fixture(root: root.url)
        let oldSource = try executableFixture(root: root.url, name: "old", contents: "old-binary")
        let newSource = try executableFixture(root: root.url, name: "new", contents: "new-binary")
        _ = try AppBundleInstaller(paths: paths).install(executableURL: oldSource)
        let previous = try AppBundleInstaller(paths: paths).captureGeneration()
        let failing = AppBundleInstaller(
            paths: paths,
            beforeStablePublish: { throw InjectedInstallFailure.mutation }
        )

        #expect(throws: InjectedInstallFailure.self) {
            try failing.install(executableURL: newSource)
        }

        #expect(try AppBundleInstaller(paths: paths).captureGeneration() == previous)
    }

    @Test("app publish detects an allowed-root directory swap and never touches its target")
    func rejectsValidationUseDirectorySwap() throws {
        let root = try TemporaryDirectory()
        let paths = InstallationPaths.fixture(root: root.url)
        let source = try executableFixture(root: root.url, contents: "new-binary")
        let applications = paths.appBundleURL.deletingLastPathComponent()
        let displaced = root.url.appendingPathComponent("displaced-applications")
        let victim = root.url.appendingPathComponent("victim", isDirectory: true)
        let sentinel = victim.appendingPathComponent("sentinel")
        try FileManager.default.createDirectory(at: victim, withIntermediateDirectories: true)
        try Data("keep".utf8).write(to: sentinel)
        let installer = AppBundleInstaller(
            paths: paths,
            beforeBundlePublish: {
                try FileManager.default.moveItem(at: applications, to: displaced)
                try FileManager.default.createSymbolicLink(
                    at: applications, withDestinationURL: victim
                )
            }
        )

        #expect(throws: InstallerError.self) {
            try installer.install(executableURL: source)
        }

        #expect(try String(contentsOf: sentinel, encoding: .utf8) == "keep")
        #expect(FileManager.default.fileExists(atPath: victim.appendingPathComponent("Slate 额度监控.app").path) == false)
    }

    @Test("bundle quarantine never deletes or overwrites a public-path successor")
    func quarantineSwapPreservesSuccessorSentinel() throws {
        let root = try TemporaryDirectory()
        let paths = InstallationPaths.fixture(root: root.url)
        let source = try executableFixture(root: root.url, contents: "installed-binary")
        _ = try AppBundleInstaller(paths: paths).install(executableURL: source)
        let displaced = root.url.appendingPathComponent("verified-original.app")
        let successorSentinel = paths.appBundleURL.appendingPathComponent("successor-sentinel")
        let removing = AppBundleInstaller(
            paths: paths,
            beforeBundleQuarantine: {
                try FileManager.default.moveItem(at: paths.appBundleURL, to: displaced)
                try FileManager.default.createDirectory(
                    at: paths.appBundleURL, withIntermediateDirectories: false
                )
                try Data("successor".utf8).write(to: successorSentinel)
            }
        )

        #expect(throws: InstallerError.self) {
            try removing.removeInstalledArtifacts()
        }

        #expect(try String(contentsOf: successorSentinel, encoding: .utf8) == "successor")
        #expect(FileManager.default.fileExists(atPath: displaced.path))
        #expect(FileManager.default.fileExists(atPath: paths.stableExecutableURL.path))
    }

    @Test("embedded Info.plist template exactly matches the auditable resource")
    func infoTemplateMatchesResource() throws {
        let resource = packageRoot()
            .appendingPathComponent("Resources/Info.plist.template")
        #expect(try String(contentsOf: resource, encoding: .utf8) == AppBundleInstaller.infoPlistTemplate)
    }

    @Test("disabled scheduled entry exits before spawning any worker")
    func disabledScheduledEntryDoesNotSpawn() async throws {
        let root = try TemporaryDirectory()
        let paths = InstallationPaths.fixture(root: root.url)
        let marker = root.url.appendingPathComponent("spawned")
        let executable = root.url.appendingPathComponent("worker-fixture")
        try "#!/bin/sh\nprintf spawned > '\(marker.path)'\nexit 0\n"
            .write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
        try FileManager.default.createDirectory(
            at: paths.applicationSupportURL, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try SettingsStore(applicationSupportURL: paths.applicationSupportURL).save(
            .init(schemaVersion: 1, automaticCollectionEnabled: false)
        )
        let runtime = CommandRuntime(paths: paths, executableURL: executable)

        try await runtime.run(.collectScheduled)

        #expect(FileManager.default.fileExists(atPath: marker.path) == false)
    }

    @Test("a standalone hidden worker is rejected before RunLock or configuration access")
    func standaloneWorkerIsRejectedBeforeSideEffects() async throws {
        let root = try TemporaryDirectory()
        let paths = InstallationPaths.fixture(root: root.url)
        let runtime = CommandRuntime(paths: paths, executableURL: URL(fileURLWithPath: "/bin/true"))

        await #expect(throws: CLIError.self) {
            try await runtime.run(.collectWorker(.scheduled))
        }

        #expect(FileManager.default.fileExists(atPath: paths.collectorStateDirectoryURL.path) == false)
    }

    @Test("menu actions use the stable installed executable exactly")
    func menuActionsUseStableExecutable() {
        let root = URL(fileURLWithPath: "/private/tmp/slate-menu-path-contract")
        let paths = InstallationPaths.fixture(root: root)
        let runtime = CommandRuntime(
            paths: paths,
            executableURL: root.appendingPathComponent("uninstalled-build-product")
        )

        #expect(runtime.menuBarWorkerExecutableURL == paths.stableExecutableURL)
        #expect(runtime.menuBarWorkerExecutableURL != root.appendingPathComponent("uninstalled-build-product"))
    }

    @Test("quit is refused while a supervised collection is active and allowed after cleanup")
    @MainActor
    func busyMenuActionCannotTerminateSupervisorOwner() async throws {
        let latch = CollectionLatch()
        let recorder = QuitRecorder()
        let actions = RuntimeMenuBarActions(
            schedule: NoopSchedule(),
            collectOperation: { await latch.run() },
            quitOperation: { recorder.quitCount += 1 },
            busyFeedback: { recorder.busyFeedbackCount += 1 }
        )
        let collection = Task { try await actions.collectOnce() }
        await latch.waitUntilStarted()

        actions.quitMenuBar()
        #expect(recorder.quitCount == 0)
        #expect(recorder.busyFeedbackCount == 1)

        await latch.finish()
        try await collection.value
        actions.quitMenuBar()
        #expect(recorder.quitCount == 1)
        #expect(recorder.busyFeedbackCount == 1)
    }

    @Test("setup preflight completes before any persistent mutation")
    func setupPreflightFailureLeavesPriorGenerationUntouched() async throws {
        let prior = SetupGeneration(
            openCodeKey: .value("old-open-code"),
            slateURL: .value("https://old.example.test/push"),
            configuration: Data("old-config".utf8)
        )
        let backend = FailingSetupBackend(initial: prior, failAtMutation: nil)
        let runtime = setupRuntime(backend: backend) { _, _ in
            throw CLIError.setupPreflight("opencode_unauthorized")
        }

        await #expect(throws: CLIError.self) { try await runtime.run(.setup) }
        #expect(backend.generation == prior)
        #expect(backend.mutationCount == 0)
    }

    @Test(
        "setup transaction restores present and absent prior generations at every mutation failure",
        arguments: [
            SetupGeneration(
                openCodeKey: .value("old-open-code"),
                slateURL: .value("https://old.example.test/push"),
                configuration: Data("old-config".utf8)
            ),
            SetupGeneration(openCodeKey: .absent, slateURL: .absent, configuration: nil),
        ],
        [1, 2, 3]
    )
    func setupMutationFailureRestoresExactPriorGeneration(
        prior: SetupGeneration,
        failAtMutation: Int
    ) async throws {
        let backend = FailingSetupBackend(initial: prior, failAtMutation: failAtMutation)
        let runtime = setupRuntime(backend: backend) { _, _ in }

        await #expect(throws: CLIError.self) { try await runtime.run(.setup) }

        #expect(backend.generation == prior)
        #expect(backend.failureCount == 1)
    }

    @Test(
        "setup restores PTY echo on interrupt, terminate, hangup, and EOF",
        arguments: ["INT", "TERM", "HUP", "EOF"]
    )
    func setupRestoresEchoAcrossTerminalExitPaths(_ exitPath: String) throws {
        let binary = packageRoot().appendingPathComponent(".build/debug/slate-quota-collector")
        #expect(FileManager.default.isExecutableFile(atPath: binary.path))
        let script = #"""
        import os, pty, select, signal, subprocess, sys, termios, time
        binary, mode = sys.argv[1], sys.argv[2]
        master, slave = pty.openpty()
        child = subprocess.Popen([binary, "setup"], stdin=slave, stdout=slave, stderr=slave, close_fds=True)
        output = b""
        deadline = time.monotonic() + 3
        while b"API Key" not in output and time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], 0.05)
            if ready:
                output += os.read(master, 4096)
        if b"API Key" not in output:
            child.kill(); child.wait()
            raise SystemExit("prompt_missing")
        if mode == "EOF":
            os.write(master, b"\x04")
        else:
            os.kill(child.pid, getattr(signal, "SIG" + mode))
        child.wait(timeout=3)
        echo = bool(termios.tcgetattr(slave)[3] & termios.ECHO)
        os.close(master); os.close(slave)
        print("echo=1" if echo else "echo=0")
        raise SystemExit(0 if echo else 9)
        """#
        let process = Process()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        process.arguments = ["-c", script, binary.path, exitPath]
        process.standardOutput = output
        process.standardError = output
        try process.run()
        process.waitUntilExit()
        let text = String(
            decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self
        )
        #expect(process.terminationStatus == 0, Comment(rawValue: text))
        #expect(text.contains("echo=1"), Comment(rawValue: text))
    }

    @Test("install bootstraps menu bar and follows persisted collector setting")
    func installLoadsIndependentJobsFromSettings() async throws {
        let root = try TemporaryDirectory()
        let paths = InstallationPaths.fixture(root: root.url)
        try FileManager.default.createDirectory(
            at: paths.applicationSupportURL, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try SettingsStore(applicationSupportURL: paths.applicationSupportURL).save(
            .init(schemaVersion: 1, automaticCollectionEnabled: false)
        )
        let executable = root.url.appendingPathComponent("release-binary")
        try Data("binary".utf8).write(to: executable)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
        let launchctl = RecordingInstallLaunchctl()
        let runtime = CommandRuntime(paths: paths, launchctl: launchctl, executableURL: executable)

        try await runtime.run(.installLaunchAgent)

        let events = await launchctl.events
        #expect(events == [
            "enable:gui/\(getuid())/\(LaunchAgentInstaller.menuBarLabel)",
            "bootstrap:\(paths.menuBarPlistURL.path)",
            "disable:gui/\(getuid())/\(LaunchAgentInstaller.collectorLabel)",
            "bootout:gui/\(getuid())/\(LaunchAgentInstaller.collectorLabel)",
        ])
        #expect(FileManager.default.fileExists(atPath: paths.appExecutableURL.path))
        #expect(FileManager.default.fileExists(atPath: paths.stableExecutableURL.path))
    }

    @Test(
        "install rolls disk and loaded jobs back when any launchctl mutation fails",
        arguments: [1, 2, 3, 4]
    )
    func installRollbackAtEveryLaunchctlStep(_ failAtMutation: Int) async throws {
        let root = try TemporaryDirectory()
        let paths = InstallationPaths.fixture(root: root.url)
        try FileManager.default.createDirectory(
            at: paths.applicationSupportURL, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try SettingsStore(applicationSupportURL: paths.applicationSupportURL).save(
            .init(schemaVersion: 1, automaticCollectionEnabled: false)
        )
        let executable = try executableFixture(root: root.url, contents: "binary")
        let launchctl = TransactionalLaunchctl(failAtMutation: failAtMutation)
        let runtime = CommandRuntime(paths: paths, launchctl: launchctl, executableURL: executable)

        await #expect(throws: LaunchctlError.self) {
            try await runtime.run(.installLaunchAgent)
        }

        #expect(try AppBundleInstaller(paths: paths).captureGeneration()
            == AppBundleGeneration(bundleExecutable: nil, stableExecutable: nil))
        #expect(try LaunchAgentInstaller(paths: paths).captureGeneration()
            == LaunchAgentGeneration(menuBarPlist: nil, collectorPlist: nil))
        #expect(await launchctl.loadedServices.isEmpty)
    }

    @Test("failed upgrade restores the previous disk generation and both previously loaded jobs")
    func failedUpgradeRestoresLoadedPreviousGeneration() async throws {
        let root = try TemporaryDirectory()
        let paths = InstallationPaths.fixture(root: root.url)
        let oldExecutable = try executableFixture(
            root: root.url, name: "old-binary", contents: "old"
        )
        let newExecutable = try executableFixture(
            root: root.url, name: "new-binary", contents: "new"
        )
        _ = try AppBundleInstaller(paths: paths).install(executableURL: oldExecutable)
        _ = try LaunchAgentInstaller(paths: paths).installPlists()
        try FileManager.default.createDirectory(
            at: paths.applicationSupportURL, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try SettingsStore(applicationSupportURL: paths.applicationSupportURL).save(
            .init(schemaVersion: 1, automaticCollectionEnabled: true)
        )
        let previousApp = try AppBundleInstaller(paths: paths).captureGeneration()
        let previousAgents = try LaunchAgentInstaller(paths: paths).captureGeneration()
        let menuService = "gui/\(getuid())/\(LaunchAgentInstaller.menuBarLabel)"
        let collectorService = "gui/\(getuid())/\(LaunchAgentInstaller.collectorLabel)"
        let launchctl = TransactionalLaunchctl(
            failAtMutation: 4,
            initiallyLoaded: [menuService, collectorService]
        )
        let runtime = CommandRuntime(
            paths: paths, launchctl: launchctl, executableURL: newExecutable
        )

        await #expect(throws: LaunchctlError.self) {
            try await runtime.run(.installLaunchAgent)
        }

        #expect(try AppBundleInstaller(paths: paths).captureGeneration() == previousApp)
        #expect(try LaunchAgentInstaller(paths: paths).captureGeneration() == previousAgents)
        #expect(await launchctl.loadedServices == [menuService, collectorService])
    }

    @Test(
        "uninstall retains every artifact when either exact job cannot be stopped",
        arguments: [1, 2]
    )
    func uninstallStopFailureRetainsArtifacts(_ failAtMutation: Int) async throws {
        let root = try TemporaryDirectory()
        let paths = InstallationPaths.fixture(root: root.url)
        let executable = try executableFixture(root: root.url, contents: "binary")
        _ = try AppBundleInstaller(paths: paths).install(executableURL: executable)
        _ = try LaunchAgentInstaller(paths: paths).installPlists()
        let menuService = "gui/\(getuid())/\(LaunchAgentInstaller.menuBarLabel)"
        let collectorService = "gui/\(getuid())/\(LaunchAgentInstaller.collectorLabel)"
        let launchctl = TransactionalLaunchctl(
            failAtMutation: failAtMutation,
            initiallyLoaded: [menuService, collectorService]
        )
        let runtime = CommandRuntime(paths: paths, launchctl: launchctl, executableURL: executable)

        await #expect(throws: LaunchctlError.self) {
            try await runtime.run(.uninstallLaunchAgent)
        }

        #expect(FileManager.default.fileExists(atPath: paths.appBundleURL.path))
        #expect(FileManager.default.fileExists(atPath: paths.stableExecutableURL.path))
        #expect(FileManager.default.fileExists(atPath: paths.menuBarPlistURL.path))
        #expect(FileManager.default.fileExists(atPath: paths.collectorPlistURL.path))
    }

    private func packageRoot() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private func executableFixture(
        root: URL,
        name: String = "release-binary",
        contents: String
    ) throws -> URL {
        let url = root.appendingPathComponent(name)
        try Data(contents.utf8).write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
        return url
    }

    private func setupRuntime(
        backend: FailingSetupBackend,
        preflight: @escaping @Sendable (CollectorConfiguration, String) async throws -> Void
    ) -> CommandRuntime {
        CommandRuntime(
            executableURL: URL(fileURLWithPath: "/bin/true"),
            setupInput: {
                SetupValues(
                    openCodeKey: "new-open-code",
                    confirmedOpenCodeKey: "new-open-code",
                    slateURL: "https://new.example.test/api/v1/contents/quota/data",
                    confirmedSlateURL: "https://new.example.test/api/v1/contents/quota/data"
                )
            },
            codexLocator: { URL(fileURLWithPath: "/bin/true") },
            setupPreflight: preflight,
            setupPersistence: TransactionalSetupPersistence(backend: backend)
        )
    }
}

private enum InjectedSetupFailure: Error { case mutation }
private enum InjectedInstallFailure: Error { case mutation }

private final class FailingSetupBackend: SetupMutationBacking, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: SetupGeneration
    private let failAtMutation: Int?
    private var mutations = 0
    private var failures = 0

    init(initial: SetupGeneration, failAtMutation: Int?) {
        storage = initial
        self.failAtMutation = failAtMutation
    }

    var generation: SetupGeneration { withLock { storage } }
    var mutationCount: Int { withLock { mutations } }
    var failureCount: Int { withLock { failures } }

    func readSecret(service _: String, account: String) throws -> SetupSecretState {
        withLock { account == "opencode-go-api-key" ? storage.openCodeKey : storage.slateURL }
    }

    func writeSecret(_ value: String, service _: String, account: String) throws {
        try mutate {
            if account == "opencode-go-api-key" {
                storage = SetupGeneration(
                    openCodeKey: .value(value),
                    slateURL: storage.slateURL,
                    configuration: storage.configuration
                )
            } else {
                storage = SetupGeneration(
                    openCodeKey: storage.openCodeKey,
                    slateURL: .value(value),
                    configuration: storage.configuration
                )
            }
        }
    }

    func deleteSecret(service _: String, account: String) throws {
        try mutate {
            if account == "opencode-go-api-key" {
                storage = SetupGeneration(
                    openCodeKey: .absent,
                    slateURL: storage.slateURL,
                    configuration: storage.configuration
                )
            } else {
                storage = SetupGeneration(
                    openCodeKey: storage.openCodeKey,
                    slateURL: .absent,
                    configuration: storage.configuration
                )
            }
        }
    }

    func readConfiguration() throws -> Data? { withLock { storage.configuration } }

    func writeConfiguration(_ data: Data) throws {
        try mutate {
            storage = SetupGeneration(
                openCodeKey: storage.openCodeKey,
                slateURL: storage.slateURL,
                configuration: data
            )
        }
    }

    func deleteConfiguration() throws {
        try mutate {
            storage = SetupGeneration(
                openCodeKey: storage.openCodeKey,
                slateURL: storage.slateURL,
                configuration: nil
            )
        }
    }

    private func mutate(_ body: () -> Void) throws {
        try lock.withLock {
            mutations += 1
            if failures == 0, mutations == failAtMutation {
                failures += 1
                throw InjectedSetupFailure.mutation
            }
            body()
        }
    }

    private func withLock<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}

private actor CollectionLatch {
    private var started = false
    private var startedWaiters: [CheckedContinuation<Void, Never>] = []
    private var finishContinuation: CheckedContinuation<Void, Never>?

    func run() async {
        started = true
        let waiters = startedWaiters
        startedWaiters.removeAll()
        waiters.forEach { $0.resume() }
        await withCheckedContinuation { finishContinuation = $0 }
    }

    func waitUntilStarted() async {
        if started { return }
        await withCheckedContinuation { startedWaiters.append($0) }
    }

    func finish() {
        finishContinuation?.resume()
        finishContinuation = nil
    }
}

@MainActor
private final class QuitRecorder {
    var quitCount = 0
    var busyFeedbackCount = 0
}

private struct NoopSchedule: CollectionScheduleControlling {
    func status() async throws -> AutomaticCollectionStatus { .enabledLoaded }
    func pause() async throws {}
    func resume() async throws {}
}

private actor RecordingInstallLaunchctl: LaunchctlControlling {
    private(set) var events: [String] = []
    func disable(service: String) { events.append("disable:\(service)") }
    func enable(service: String) { events.append("enable:\(service)") }
    func bootstrap(plistURL: URL) { events.append("bootstrap:\(plistURL.path)") }
    func bootout(service: String) { events.append("bootout:\(service)") }
    func isLoaded(service _: String) -> Bool { false }
}

private actor TransactionalLaunchctl: LaunchctlControlling {
    private let failAtMutation: Int
    private var mutationCount = 0
    private var loaded: Set<String>

    init(failAtMutation: Int, initiallyLoaded: Set<String> = []) {
        self.failAtMutation = failAtMutation
        loaded = initiallyLoaded
    }

    var loadedServices: Set<String> { loaded }

    func disable(service _: String) throws { try mutate {} }
    func enable(service _: String) throws { try mutate {} }
    func bootstrap(plistURL: URL) throws {
        try mutate {
            loaded.insert("gui/\(getuid())/\(plistURL.deletingPathExtension().lastPathComponent)")
        }
    }
    func bootout(service: String) throws { try mutate { loaded.remove(service) } }
    func isLoaded(service: String) -> Bool { loaded.contains(service) }

    private func mutate(_ operation: () -> Void) throws {
        mutationCount += 1
        if mutationCount == failAtMutation { throw LaunchctlError.transport }
        operation()
    }
}

extension InstallationPaths {
    static func fixture(root: URL) -> Self {
        Self(
            homeDirectory: root.appendingPathComponent("home", isDirectory: true),
            applicationSupportURL: root.appendingPathComponent("Library/Application Support", isDirectory: true),
            launchAgentsURL: root.appendingPathComponent("Library/LaunchAgents", isDirectory: true),
            logsURL: root.appendingPathComponent("Library/Logs/SlateQuotaCollector", isDirectory: true)
        )
    }
}

private func fileMode(_ url: URL) throws -> Int {
    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    return try #require((attributes[.posixPermissions] as? NSNumber)?.intValue)
}
