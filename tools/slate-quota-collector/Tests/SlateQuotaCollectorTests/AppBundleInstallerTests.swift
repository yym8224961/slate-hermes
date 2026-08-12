import Foundation
import Security
import Testing
@testable import SlateQuotaCollector

@Suite("App bundle installer", .serialized)
struct AppBundleInstallerTests {
    @Test("secure directory walking accepts the trusted macOS var alias")
    func acceptsTrustedVarAliasWithoutFollowingIt() throws {
        let privateRoot = try TemporaryDirectory()
        let publicPath = privateRoot.url.path.replacingOccurrences(
            of: "/private/var/", with: "/var/"
        )
        let publicRoot = URL(fileURLWithPath: publicPath, isDirectory: true)
        let paths = InstallationPaths.fixture(root: publicRoot)
        let executable = try executableFixture(root: privateRoot.url, contents: "binary")

        _ = try AppBundleInstaller(paths: paths).install(executableURL: executable)

        #expect(FileManager.default.fileExists(atPath: paths.appExecutableURL.path))
        #expect(FileManager.default.fileExists(atPath: paths.stableExecutableURL.path))
    }

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

    @Test("installer never adopts an arbitrary owner stable binary")
    func refusesUnrecognizedStableBinary() throws {
        let root = try TemporaryDirectory()
        let paths = InstallationPaths.fixture(root: root.url)
        let source = try executableFixture(root: root.url, contents: "new-binary")
        try FileManager.default.createDirectory(
            at: paths.stableExecutableURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data("keep-stable".utf8).write(to: paths.stableExecutableURL)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700], ofItemAtPath: paths.stableExecutableURL.path
        )

        #expect(throws: InstallerError.self) {
            try AppBundleInstaller(paths: paths).install(executableURL: source)
        }

        #expect(try String(contentsOf: paths.stableExecutableURL, encoding: .utf8) == "keep-stable")
        #expect(FileManager.default.fileExists(atPath: paths.appBundleURL.path) == false)
    }

    @Test(
        "every failed private bundle construction step leaves no temporary generation",
        arguments: Array(1...8)
    )
    func bundleConstructionFailureLeavesNoResidue(_ failingStep: Int) throws {
        let root = try TemporaryDirectory()
        let paths = InstallationPaths.fixture(root: root.url)
        let oldSource = try executableFixture(
            root: root.url, name: "old-binary", contents: "old-binary"
        )
        let source = try executableFixture(
            root: root.url, name: "new-binary", contents: "new-binary"
        )
        _ = try AppBundleInstaller(paths: paths).install(executableURL: oldSource)
        let previous = try AppBundleInstaller(paths: paths).captureGeneration()
        let installer = AppBundleInstaller(
            paths: paths,
            afterBundleConstructionStep: { step in
                if step == failingStep { throw InjectedInstallFailure.mutation }
            }
        )

        #expect(throws: InjectedInstallFailure.self) {
            try installer.install(executableURL: source)
        }

        let applications = paths.appBundleURL.deletingLastPathComponent()
        let names = (try? FileManager.default.contentsOfDirectory(atPath: applications.path)) ?? []
        #expect(names.filter { $0.hasPrefix(".slate-quota-bundle-") }.isEmpty)
        #expect(try AppBundleInstaller(paths: paths).captureGeneration() == previous)
    }

    @Test("existing broad roots keep their modes while app-owned leaves are owner-only")
    func preservesExistingBroadDirectoryModes() throws {
        let root = try TemporaryDirectory()
        let paths = InstallationPaths.fixture(root: root.url)
        let applications = paths.appBundleURL.deletingLastPathComponent()
        for directory in [paths.homeDirectory, applications, paths.applicationSupportURL] {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o755], ofItemAtPath: directory.path
            )
        }
        let source = try executableFixture(root: root.url, contents: "new-binary")

        _ = try AppBundleInstaller(paths: paths).install(executableURL: source)

        #expect(try fileMode(paths.homeDirectory) & 0o777 == 0o755)
        #expect(try fileMode(applications) & 0o777 == 0o755)
        #expect(try fileMode(paths.applicationSupportURL) & 0o777 == 0o755)
        #expect(try fileMode(paths.collectorStateDirectoryURL) & 0o777 == 0o700)
        #expect(try fileMode(paths.stableExecutableURL.deletingLastPathComponent()) & 0o777 == 0o700)
    }

    @Test("held stable parent rejects an ancestor swap and never writes through its replacement")
    func stableAncestorSwapPreservesVictim() throws {
        let root = try TemporaryDirectory()
        let paths = InstallationPaths.fixture(root: root.url)
        let source = try executableFixture(root: root.url, contents: "new-binary")
        try FileManager.default.createDirectory(
            at: paths.applicationSupportURL, withIntermediateDirectories: true
        )
        let displaced = root.url.appendingPathComponent("displaced-application-support")
        let victim = root.url.appendingPathComponent("stable-victim", isDirectory: true)
        let sentinel = victim.appendingPathComponent("sentinel")
        try FileManager.default.createDirectory(at: victim, withIntermediateDirectories: true)
        try Data("keep".utf8).write(to: sentinel)
        let installer = AppBundleInstaller(
            paths: paths,
            afterStableDirectoryOpen: {
                try FileManager.default.moveItem(at: paths.applicationSupportURL, to: displaced)
                try FileManager.default.createSymbolicLink(
                    at: paths.applicationSupportURL, withDestinationURL: victim
                )
            }
        )

        #expect(throws: InstallerError.self) {
            try installer.install(executableURL: source)
        }

        #expect(try String(contentsOf: sentinel, encoding: .utf8) == "keep")
        #expect(FileManager.default.fileExists(
            atPath: victim.appendingPathComponent("SlateQuotaCollector/bin/slate-quota-collector").path
        ) == false)
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

    @Test(
        "stable executable CAS never overwrites a leaf successor",
        arguments: [InstallerLeafPublishPhase.beforeQuarantine, .beforePublish]
    )
    func stableExecutableSuccessorWinsCAS(_ phase: InstallerLeafPublishPhase) throws {
        let root = try TemporaryDirectory()
        let paths = InstallationPaths.fixture(root: root.url)
        let oldSource = try executableFixture(root: root.url, name: "old", contents: "old-binary")
        let newSource = try executableFixture(root: root.url, name: "new", contents: "new-binary")
        _ = try AppBundleInstaller(paths: paths).install(executableURL: oldSource)
        let successor = paths.stableExecutableURL.deletingLastPathComponent()
            .appendingPathComponent("stable-successor")
        try Data("successor-binary".utf8).write(to: successor)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: successor.path)
        let successorInode = try fileInode(successor)
        let race = LeafRaceHook(
            targetName: paths.stableExecutableURL.lastPathComponent,
            phase: phase
        ) {
            guard rename(successor.path, paths.stableExecutableURL.path) == 0 else {
                throw InjectedInstallFailure.mutation
            }
        }
        let installer = AppBundleInstaller(paths: paths, beforeLeafPublish: race.call)

        #expect(throws: InstallerError.self) { try installer.install(executableURL: newSource) }

        #expect(try Data(contentsOf: paths.stableExecutableURL) == Data("successor-binary".utf8))
        #expect(try fileInode(paths.stableExecutableURL) == successorInode)
        let names = try FileManager.default.contentsOfDirectory(
            atPath: paths.stableExecutableURL.deletingLastPathComponent().path
        )
        #expect(names.allSatisfy {
            !$0.hasPrefix(".slate-install-") && !$0.hasPrefix(".slate-quota-leaf-")
        })
    }

    @Test("stable CAS restores its quarantined expected leaf when publication aborts")
    func stableCASAbortRestoresExpectedLeafWithoutResidue() throws {
        let root = try TemporaryDirectory()
        let paths = InstallationPaths.fixture(root: root.url)
        let oldSource = try executableFixture(root: root.url, name: "old", contents: "old-binary")
        let newSource = try executableFixture(root: root.url, name: "new", contents: "new-binary")
        _ = try AppBundleInstaller(paths: paths).install(executableURL: oldSource)
        let previous = try AppBundleInstaller(paths: paths).captureGeneration()
        let installer = AppBundleInstaller(paths: paths, beforeLeafPublish: { name, phase in
            if name == paths.stableExecutableURL.lastPathComponent, phase == .beforePublish {
                throw InjectedInstallFailure.mutation
            }
        })

        #expect(throws: InstallerError.self) { try installer.install(executableURL: newSource) }

        #expect(try AppBundleInstaller(paths: paths).captureGeneration() == previous)
        let names = try FileManager.default.contentsOfDirectory(
            atPath: paths.stableExecutableURL.deletingLastPathComponent().path
        )
        #expect(names.allSatisfy {
            !$0.hasPrefix(".slate-install-") && !$0.hasPrefix(".slate-quota-leaf-")
        })
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
            openCodeKey: .item(secretSnapshot("old-open-code", label: "old-key")),
            slateURL: .item(secretSnapshot("https://old.example.test/push", label: "old-url")),
            configuration: .file(data: Data("old-config".utf8), mode: 0o640)
        )
        let backend = FailingSetupBackend(initial: prior, failAtMutation: nil)
        let runtime = setupRuntime(backend: backend) { _, _ in
            throw CLIError.setupPreflight("opencode_unauthorized")
        }

        await #expect(throws: CLIError.self) { try await runtime.run(.setup) }
        #expect(backend.generation == prior)
        #expect(backend.mutationCount == 0)
    }

    @Test("system setup backend accepts only one canonical tool-owned Keychain item")
    func systemSetupBackendCanonicalSecurityGeneration() throws {
        let root = try TemporaryDirectory()
        let service = KeychainStore.requiredService
        let account = "opencode-go-api-key"
        let canonical: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecValueData: Data("old-value".utf8),
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlock,
            kSecAttrSynchronizable: false,
            kSecAttrCreationDate: Date(timeIntervalSince1970: 1),
            kSecAttrModificationDate: Date(timeIntervalSince1970: 2),
        ]
        let security = RecordingSetupSecurityBackend(copyResult: [canonical])
        let backend = SystemSetupMutationBackend(
            applicationSupportURL: root.url,
            security: security,
            expectedAccessGroup: nil
        )

        let state = try backend.readSecret(service: service, account: account)
        try backend.restoreSecret(state, service: service, account: account)

        let query = try #require(security.copyQueries.first)
        #expect(query[kSecMatchLimit] as? String == kSecMatchLimitAll as String)
        #expect((query[kSecAttrSynchronizable] as? String) == kSecAttrSynchronizableAny as String)
        let restored = try #require(security.addedItems.last)
        #expect(restored[kSecClass] as? String == kSecClassGenericPassword as String)
        #expect(restored[kSecAttrService] as? String == service)
        #expect(restored[kSecAttrAccount] as? String == account)
        #expect(restored[kSecValueData] as? Data == Data("old-value".utf8))
        #expect(restored[kSecAttrAccessible] as? String == kSecAttrAccessibleAfterFirstUnlock as String)
        #expect((restored[kSecAttrSynchronizable] as? NSNumber)?.boolValue == false)
        #expect(restored[kSecAttrCreationDate] == nil)
        #expect(restored[kSecAttrModificationDate] == nil)

        let absentSecurity = RecordingSetupSecurityBackend()
        let absentBackend = SystemSetupMutationBackend(
            applicationSupportURL: root.url,
            security: absentSecurity,
            expectedAccessGroup: nil
        )
        #expect(try absentBackend.readSecret(service: service, account: account) == .absent)
        #expect(absentSecurity.updateCalls == 0)
        #expect(absentSecurity.addedItems.isEmpty)
        #expect(absentSecurity.deleteQueries.isEmpty)
    }

    @Test("system setup backend rejects multiple or custom Keychain generations without mutation")
    func systemSetupBackendRejectsNonToolOwnedItems() throws {
        let root = try TemporaryDirectory()
        let service = KeychainStore.requiredService
        let account = "opencode-go-api-key"
        let canonical: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecValueData: Data("old-value".utf8),
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlock,
            kSecAttrSynchronizable: false,
        ]
        let customItems: [[CFString: Any]] = [
            canonical.merging([kSecAttrAccessControl: "custom-acl"]) { _, new in new },
            canonical.merging([kSecAttrAccess: "custom-access"]) { _, new in new },
            canonical.merging([kSecAttrDescription: "custom-description"]) { _, new in new },
            canonical.merging([kSecAttrAccessGroup: "custom.group"]) { _, new in new },
            canonical.merging([kSecAttrSynchronizable: true]) { _, new in new },
        ]
        let generations = [[canonical, canonical]] + customItems.map { [$0] }

        for generation in generations {
            let security = RecordingSetupSecurityBackend(copyResult: generation)
            let backend = SystemSetupMutationBackend(
                applicationSupportURL: root.url,
                security: security,
                expectedAccessGroup: nil
            )
            do {
                _ = try backend.readSecret(service: service, account: account)
                Issue.record("expected setup_existing_item")
            } catch let error as CLIError {
                #expect(error == .setupExistingItem)
            }
            #expect(security.updateCalls == 0)
            #expect(security.addedItems.isEmpty)
            #expect(security.deleteQueries.isEmpty)
        }
    }

    @Test("production setup backend restores exact Keychain dictionary and configuration bytes and mode")
    func systemSetupBackendRollsBackExactProductionGeneration() throws {
        let root = try TemporaryDirectory()
        let applicationSupport = root.url.appendingPathComponent("Application Support")
        try FileManager.default.createDirectory(at: applicationSupport, withIntermediateDirectories: true)
        let configurationURL = ConfigurationStore(
            applicationSupportURL: applicationSupport
        ).configurationURL
        try FileManager.default.createDirectory(
            at: configurationURL.deletingLastPathComponent(), withIntermediateDirectories: true
        )
        let oldConfiguration = Data("raw-old-configuration".utf8)
        try oldConfiguration.write(to: configurationURL)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o640], ofItemAtPath: configurationURL.path
        )
        let service = KeychainStore.requiredService
        let firstAccount = "opencode-go-api-key"
        let secondAccount = "slate-push-url"
        let security = RecordingSetupSecurityBackend(
            resultsByAccount: [
                firstAccount: [.canonical(service: service, account: firstAccount, value: "old-key")],
                secondAccount: [.canonical(service: service, account: secondAccount, value: "old-url")],
            ],
            failUpdateAt: 2
        )
        let backend = SystemSetupMutationBackend(
            applicationSupportURL: applicationSupport,
            security: security,
            expectedAccessGroup: nil
        )
        let oldConfigurationState = try backend.readConfiguration()
        try backend.writeConfiguration(Data("forward-configuration".utf8))
        #expect(try fileMode(configurationURL) & 0o777 == 0o600)
        try backend.restoreConfiguration(oldConfigurationState)
        #expect(try Data(contentsOf: configurationURL) == oldConfiguration)
        #expect(try fileMode(configurationURL) & 0o777 == 0o640)
        let persistence = TransactionalSetupPersistence(backend: backend)
        let configuration = CollectorConfiguration(
            schemaVersion: 1,
            codexExecutablePath: "/bin/true",
            timezoneIdentifier: "Asia/Shanghai",
            codexTimeoutSeconds: 20,
            openCodeTimeoutSeconds: 10,
            slateTimeoutSeconds: 15,
            overallTimeoutSeconds: 45,
            logLevel: "info",
            keychainService: service,
            openCodeKeyAccount: firstAccount,
            slateURLAccount: secondAccount
        )

        #expect(throws: (any Error).self) {
            try persistence.commit(
                configuration: configuration,
                openCodeKey: "new-key",
                slateURL: "https://new.example.test/api/v1/contents/quota/data"
            )
        }

        #expect(try Data(contentsOf: configurationURL) == oldConfiguration)
        #expect(try fileMode(configurationURL) & 0o777 == 0o640)
        #expect(security.addedItems.count == 2)
        #expect(security.addedItems.map { $0[kSecValueData] as? Data } == [
            Data("old-key".utf8), Data("old-url".utf8),
        ])
    }

    @Test(
        "setup transaction restores present and absent prior generations at every mutation failure",
        arguments: [
            SetupGeneration(
                openCodeKey: .item(secretSnapshot("old-open-code", label: "old-key")),
                slateURL: .item(secretSnapshot("https://old.example.test/push", label: "old-url")),
                configuration: .file(data: Data("old-config".utf8), mode: 0o640)
            ),
            SetupGeneration(openCodeKey: .absent, slateURL: .absent, configuration: .absent),
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
        "setup rollback attempts every component after a rollback failure",
        arguments: [1, 2, 3]
    )
    func setupRollbackFailureStillAttemptsLaterComponents(_ failAtRollback: Int) async throws {
        let prior = SetupGeneration(
            openCodeKey: .item(secretSnapshot("old-key", label: "label-key")),
            slateURL: .item(secretSnapshot("old-url", label: "label-url")),
            configuration: .file(data: Data("old-config".utf8), mode: 0o640)
        )
        let backend = FailingSetupBackend(
            initial: prior,
            failAtMutation: 2,
            failAtRollback: failAtRollback
        )
        let runtime = setupRuntime(backend: backend) { _, _ in }

        do {
            try await runtime.run(.setup)
            Issue.record("expected setup rollback failure")
        } catch let error as CLIError {
            #expect(error == .setupRollback)
        }

        #expect(backend.rollbackAttempts == [1, 2, 3])
        #expect(backend.rollbackSuccesses == Set([1, 2, 3]).subtracting([failAtRollback]))
        for component in Set([1, 2, 3]).subtracting([failAtRollback]) {
            #expect(backend.component(component) == priorComponent(prior, component))
        }
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

    @Test("install replaces disabled unloaded jobs with the exact desired launchd generation")
    func installReplacesDisabledUnloadedGeneration() async throws {
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
        let menuService = "gui/\(getuid())/\(LaunchAgentInstaller.menuBarLabel)"
        let collectorService = "gui/\(getuid())/\(LaunchAgentInstaller.collectorLabel)"
        let prior = LaunchdJobGeneration(loaded: false, disabledOverride: true)
        let launchctl = TransactionalLaunchctl(
            initial: [menuService: prior, collectorService: prior]
        )
        let runtime = CommandRuntime(paths: paths, launchctl: launchctl, executableURL: executable)

        try await runtime.run(.installLaunchAgent)

        #expect(await launchctl.generation(service: menuService)
            == LaunchdJobGeneration(loaded: true, disabledOverride: false))
        #expect(await launchctl.generation(service: collectorService)
            == LaunchdJobGeneration(loaded: false, disabledOverride: true))
    }

    @Test("successful upgrade deliberately stops both old loaded jobs before bootstrapping new jobs")
    func successfulLoadedUpgradeReplacesLiveGeneration() async throws {
        let root = try TemporaryDirectory()
        let paths = InstallationPaths.fixture(root: root.url)
        let oldExecutable = try executableFixture(root: root.url, name: "old", contents: "old")
        let newExecutable = try executableFixture(root: root.url, name: "new", contents: "new")
        _ = try AppBundleInstaller(paths: paths).install(executableURL: oldExecutable)
        _ = try LaunchAgentInstaller(paths: paths).installPlists()
        try FileManager.default.createDirectory(
            at: paths.applicationSupportURL, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try SettingsStore(applicationSupportURL: paths.applicationSupportURL).save(
            .init(schemaVersion: 1, automaticCollectionEnabled: true)
        )
        let menuService = "gui/\(getuid())/\(LaunchAgentInstaller.menuBarLabel)"
        let collectorService = "gui/\(getuid())/\(LaunchAgentInstaller.collectorLabel)"
        let loaded = LaunchdJobGeneration(loaded: true, disabledOverride: false)
        let launchctl = TransactionalLaunchctl(
            initial: [menuService: loaded, collectorService: loaded]
        )
        let runtime = CommandRuntime(paths: paths, launchctl: launchctl, executableURL: newExecutable)

        try await runtime.run(.installLaunchAgent)

        let events = await launchctl.events
        #expect(events.prefix(2) == ["bootout:\(collectorService)", "bootout:\(menuService)"])
        #expect(events.firstIndex(of: "bootstrap:\(menuService)")
            .map { $0 > 1 } == true)
        #expect(events.firstIndex(of: "bootstrap:\(collectorService)")
            .map { $0 > 1 } == true)
        let installedApp = try AppBundleInstaller(paths: paths).captureGeneration()
        #expect(installedApp.bundleExecutable == Data("new".utf8))
        #expect(installedApp.stableExecutable == Data("new".utf8))
        #expect(await launchctl.generation(service: menuService) == loaded)
        #expect(await launchctl.generation(service: collectorService) == loaded)
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

        let absentApp = try AppBundleInstaller(paths: paths).captureGeneration()
        #expect(absentApp.bundleExecutable == nil)
        #expect(absentApp.stableExecutable == nil)
        #expect(absentApp.stableLeaf == .absent)
        #expect(try LaunchAgentInstaller(paths: paths).captureGeneration()
            == LaunchAgentGeneration(menuBarPlist: nil, collectorPlist: nil))
        #expect(await launchctl.loadedServices.isEmpty)
    }

    @Test(
        "every loaded upgrade launchctl failure restores the previous disk and live generation",
        arguments: [1, 2, 3, 4, 5, 6]
    )
    func failedUpgradeRestoresLoadedPreviousGeneration(_ failAtMutation: Int) async throws {
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
            failAtMutation: failAtMutation,
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

    @Test("failed upgrade restores disabled-but-loaded jobs exactly")
    func failedUpgradeRestoresDisabledLoadedGeneration() async throws {
        let root = try TemporaryDirectory()
        let paths = InstallationPaths.fixture(root: root.url)
        let oldExecutable = try executableFixture(root: root.url, name: "old", contents: "old")
        let newExecutable = try executableFixture(root: root.url, name: "new", contents: "new")
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
        let disabledLoaded = LaunchdJobGeneration(loaded: true, disabledOverride: true)
        let launchctl = TransactionalLaunchctl(
            failAtMutation: 4,
            initial: [menuService: disabledLoaded, collectorService: disabledLoaded]
        )
        let runtime = CommandRuntime(paths: paths, launchctl: launchctl, executableURL: newExecutable)

        await #expect(throws: LaunchctlError.self) {
            try await runtime.run(.installLaunchAgent)
        }

        #expect(try AppBundleInstaller(paths: paths).captureGeneration() == previousApp)
        #expect(try LaunchAgentInstaller(paths: paths).captureGeneration() == previousAgents)
        #expect(await launchctl.generation(service: menuService) == disabledLoaded)
        #expect(await launchctl.generation(service: collectorService) == disabledLoaded)
    }

    @Test(
        "install rollback attempts both jobs after a rollback launchctl failure",
        arguments: [1, 2, 3, 4, 5, 6, 7]
    )
    func installRollbackFailureStillAttemptsEveryLaunchdRestore(_ failAtRollback: Int) async throws {
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
        let menuService = "gui/\(getuid())/\(LaunchAgentInstaller.menuBarLabel)"
        let collectorService = "gui/\(getuid())/\(LaunchAgentInstaller.collectorLabel)"
        let prior: [String: LaunchdJobGeneration] = [
            menuService: .init(loaded: true, disabledOverride: true),
            collectorService: .init(loaded: false, disabledOverride: false),
        ]
        let launchctl = TransactionalLaunchctl(
            failAtMutation: 3,
            failAtRollback: failAtRollback,
            initial: prior
        )
        let runtime = CommandRuntime(paths: paths, launchctl: launchctl, executableURL: executable)

        do {
            try await runtime.run(.installLaunchAgent)
            Issue.record("expected launchd rollback failure")
        } catch let error as LaunchctlError {
            #expect(error == .rollback)
        }

        #expect(await launchctl.rollbackAttempts >= 7)
        #expect(await launchctl.rollbackTouchedServices == [menuService, collectorService])
        #expect(await launchctl.allGenerations == prior)
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

    @Test("second uninstall bootout failure restores both exact launchd generations")
    func secondUninstallStopFailureRestoresBothJobs() async throws {
        let root = try TemporaryDirectory()
        let paths = InstallationPaths.fixture(root: root.url)
        let executable = try executableFixture(root: root.url, contents: "binary")
        _ = try AppBundleInstaller(paths: paths).install(executableURL: executable)
        _ = try LaunchAgentInstaller(paths: paths).installPlists()
        let menuService = "gui/\(getuid())/\(LaunchAgentInstaller.menuBarLabel)"
        let collectorService = "gui/\(getuid())/\(LaunchAgentInstaller.collectorLabel)"
        let prior: [String: LaunchdJobGeneration] = [
            menuService: .init(loaded: true, disabledOverride: false),
            collectorService: .init(loaded: true, disabledOverride: true),
        ]
        let launchctl = TransactionalLaunchctl(failAtMutation: 2, initial: prior)
        let runtime = CommandRuntime(paths: paths, launchctl: launchctl, executableURL: executable)

        await #expect(throws: LaunchctlError.self) {
            try await runtime.run(.uninstallLaunchAgent)
        }

        #expect(await launchctl.allGenerations == prior)
        #expect(FileManager.default.fileExists(atPath: paths.appBundleURL.path))
        #expect(FileManager.default.fileExists(atPath: paths.stableExecutableURL.path))
        #expect(FileManager.default.fileExists(atPath: paths.menuBarPlistURL.path))
        #expect(FileManager.default.fileExists(atPath: paths.collectorPlistURL.path))
    }

    @Test("uninstall state-verification transport failure restores both jobs and retains disk")
    func uninstallVerificationFailureRestoresExactGeneration() async throws {
        let root = try TemporaryDirectory()
        let paths = InstallationPaths.fixture(root: root.url)
        let executable = try executableFixture(root: root.url, contents: "binary")
        _ = try AppBundleInstaller(paths: paths).install(executableURL: executable)
        _ = try LaunchAgentInstaller(paths: paths).installPlists()
        let menuService = "gui/\(getuid())/\(LaunchAgentInstaller.menuBarLabel)"
        let collectorService = "gui/\(getuid())/\(LaunchAgentInstaller.collectorLabel)"
        let prior: [String: LaunchdJobGeneration] = [
            menuService: .init(loaded: true, disabledOverride: false),
            collectorService: .init(loaded: true, disabledOverride: true),
        ]
        let launchctl = TransactionalLaunchctl(
            failAtStateQuery: 3,
            initial: prior
        )
        let runtime = CommandRuntime(paths: paths, launchctl: launchctl, executableURL: executable)

        await #expect(throws: LaunchctlError.self) {
            try await runtime.run(.uninstallLaunchAgent)
        }

        #expect(await launchctl.allGenerations == prior)
        #expect(FileManager.default.fileExists(atPath: paths.appBundleURL.path))
        #expect(FileManager.default.fileExists(atPath: paths.stableExecutableURL.path))
        #expect(FileManager.default.fileExists(atPath: paths.menuBarPlistURL.path))
        #expect(FileManager.default.fileExists(atPath: paths.collectorPlistURL.path))
    }

    @Test("uninstall rejects disabled-override divergence before deleting artifacts")
    func uninstallDisabledOverrideDivergenceRestoresExactGeneration() async throws {
        let root = try TemporaryDirectory()
        let paths = InstallationPaths.fixture(root: root.url)
        let executable = try executableFixture(root: root.url, contents: "binary")
        _ = try AppBundleInstaller(paths: paths).install(executableURL: executable)
        _ = try LaunchAgentInstaller(paths: paths).installPlists()
        let menuService = "gui/\(getuid())/\(LaunchAgentInstaller.menuBarLabel)"
        let collectorService = "gui/\(getuid())/\(LaunchAgentInstaller.collectorLabel)"
        let prior: [String: LaunchdJobGeneration] = [
            menuService: .init(loaded: true, disabledOverride: false),
            collectorService: .init(loaded: true, disabledOverride: true),
        ]
        let launchctl = TransactionalLaunchctl(
            flipDisabledAtStateQuery: 3,
            initial: prior
        )
        let runtime = CommandRuntime(paths: paths, launchctl: launchctl, executableURL: executable)

        await #expect(throws: LaunchctlError.self) {
            try await runtime.run(.uninstallLaunchAgent)
        }

        #expect(await launchctl.allGenerations == prior)
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

    private func priorComponent(_ generation: SetupGeneration, _ component: Int) -> String {
        switch component {
        case 1: String(describing: generation.openCodeKey)
        case 2: String(describing: generation.slateURL)
        default: String(describing: generation.configuration)
        }
    }

}

private func secretSnapshot(_ value: String, label: String) -> SetupSecretAttributes {
    SetupSecretAttributes(
        data: Data(value.utf8),
        accessible: kSecAttrAccessibleWhenUnlocked as String,
        accessGroup: "fixture.group",
        synchronizable: false,
        generic: Data("generic".utf8),
        label: label,
        comment: "fixture-comment"
    )
}

private final class RecordingSetupSecurityBackend: SetupSecurityItemBacking, @unchecked Sendable {
    private let lock = NSLock()
    private var fallbackResult: [[CFString: Any]]
    private var resultsByAccount: [String: [[CFString: Any]]]
    private let failUpdateAt: Int?
    private var updateOrdinal = 0
    private(set) var copyQueries: [[CFString: Any]] = []
    private(set) var addedItems: [[CFString: Any]] = []
    private(set) var deleteQueries: [[CFString: Any]] = []
    private(set) var updateCalls = 0

    init(
        copyResult: [[CFString: Any]] = [],
        resultsByAccount: [String: [[CFString: Any]]] = [:],
        failUpdateAt: Int? = nil
    ) {
        fallbackResult = copyResult
        self.resultsByAccount = resultsByAccount
        self.failUpdateAt = failUpdateAt
    }

    func copyMatching(_ query: [CFString: Any]) -> (OSStatus, Any?) {
        lock.withLock {
            copyQueries.append(query)
            let account = query[kSecAttrAccount] as? String ?? ""
            let result = resultsByAccount[account] ?? fallbackResult
            return result.isEmpty ? (errSecItemNotFound, nil) : (errSecSuccess, result)
        }
    }

    func update(_ query: [CFString: Any], attributes: [CFString: Any]) -> OSStatus {
        lock.withLock {
            updateCalls += 1
            updateOrdinal += 1
            if updateOrdinal == failUpdateAt { return errSecInteractionNotAllowed }
            return errSecSuccess
        }
    }

    func add(_ item: [CFString: Any]) -> OSStatus {
        lock.withLock {
            addedItems.append(item)
            return errSecSuccess
        }
    }

    func delete(_ query: [CFString: Any]) -> OSStatus {
        lock.withLock {
            deleteQueries.append(query)
            return errSecSuccess
        }
    }
}

private extension Dictionary where Key == CFString, Value == Any {
    static func canonical(service: String, account: String, value: String) -> Self {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecValueData: Data(value.utf8),
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlock,
            kSecAttrSynchronizable: false,
        ]
    }
}

private enum InjectedSetupFailure: Error { case mutation }
private enum InjectedInstallFailure: Error { case mutation }

private final class FailingSetupBackend: SetupMutationBacking, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: SetupGeneration
    private let failAtMutation: Int?
    private let failAtRollback: Int?
    private var mutations = 0
    private var failures = 0
    private var rollbackPhase = false
    private var rollbackOrdinal = 0
    private var rollbackAttemptStorage: [Int] = []
    private var rollbackSuccessStorage: Set<Int> = []

    init(initial: SetupGeneration, failAtMutation: Int?, failAtRollback: Int? = nil) {
        storage = initial
        self.failAtMutation = failAtMutation
        self.failAtRollback = failAtRollback
    }

    var generation: SetupGeneration { withLock { storage } }
    var mutationCount: Int { withLock { mutations } }
    var failureCount: Int { withLock { failures } }
    var rollbackAttempts: [Int] { withLock { rollbackAttemptStorage } }
    var rollbackSuccesses: Set<Int> { withLock { rollbackSuccessStorage } }

    func readSecret(service _: String, account: String) throws -> SetupSecretState {
        withLock { account == "opencode-go-api-key" ? storage.openCodeKey : storage.slateURL }
    }

    func writeSecretValue(_ value: String, service _: String, account: String) throws {
        try mutate {
            if account == "opencode-go-api-key" {
                storage = SetupGeneration(
                    openCodeKey: .item(Self.forwardSecret(value)),
                    slateURL: storage.slateURL,
                    configuration: storage.configuration
                )
            } else {
                storage = SetupGeneration(
                    openCodeKey: storage.openCodeKey,
                    slateURL: .item(Self.forwardSecret(value)),
                    configuration: storage.configuration
                )
            }
        }
    }

    func restoreSecret(_ state: SetupSecretState, service _: String, account: String) throws {
        try rollback(component: account == "opencode-go-api-key" ? 1 : 2) {
            if account == "opencode-go-api-key" {
                storage = SetupGeneration(
                    openCodeKey: state,
                    slateURL: storage.slateURL,
                    configuration: storage.configuration
                )
            } else {
                storage = SetupGeneration(
                    openCodeKey: storage.openCodeKey,
                    slateURL: state,
                    configuration: storage.configuration
                )
            }
        }
    }

    func readConfiguration() throws -> SetupConfigurationState { withLock { storage.configuration } }

    func writeConfiguration(_ data: Data) throws {
        try mutate {
            storage = SetupGeneration(
                openCodeKey: storage.openCodeKey,
                slateURL: storage.slateURL,
                configuration: .file(data: data, mode: 0o600)
            )
        }
    }

    func restoreConfiguration(_ state: SetupConfigurationState) throws {
        try rollback(component: 3) {
            storage = SetupGeneration(
                openCodeKey: storage.openCodeKey,
                slateURL: storage.slateURL,
                configuration: state
            )
        }
    }

    private func mutate(_ body: () -> Void) throws {
        try lock.withLock {
            mutations += 1
            if failures == 0, mutations == failAtMutation {
                failures += 1
                rollbackPhase = true
                throw InjectedSetupFailure.mutation
            }
            body()
        }
    }

    func component(_ ordinal: Int) -> String {
        withLock {
            switch ordinal {
            case 1: String(describing: storage.openCodeKey)
            case 2: String(describing: storage.slateURL)
            default: String(describing: storage.configuration)
            }
        }
    }

    private func rollback(component: Int, _ body: () -> Void) throws {
        try lock.withLock {
            rollbackPhase = true
            rollbackOrdinal += 1
            rollbackAttemptStorage.append(component)
            if rollbackOrdinal == failAtRollback { throw InjectedSetupFailure.mutation }
            body()
            rollbackSuccessStorage.insert(component)
        }
    }

    private static func forwardSecret(_ value: String) -> SetupSecretAttributes {
        SetupSecretAttributes(
            data: Data(value.utf8), accessible: nil, accessGroup: nil,
            synchronizable: nil, generic: nil, label: nil, comment: nil
        )
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

private actor RecordingInstallLaunchctl: InstallationLaunchctlControlling {
    private(set) var events: [String] = []
    private var generations: [String: LaunchdJobGeneration] = [:]

    func disable(service: String) {
        events.append("disable:\(service)")
        let old = state(service)
        generations[service] = .init(loaded: old.loaded, disabledOverride: true)
    }
    func enable(service: String) {
        events.append("enable:\(service)")
        let old = state(service)
        generations[service] = .init(loaded: old.loaded, disabledOverride: false)
    }
    func bootstrap(plistURL: URL) {
        events.append("bootstrap:\(plistURL.path)")
        let service = "gui/\(getuid())/\(plistURL.deletingPathExtension().lastPathComponent)"
        let old = state(service)
        generations[service] = .init(loaded: true, disabledOverride: old.disabledOverride)
    }
    func bootout(service: String) {
        events.append("bootout:\(service)")
        let old = state(service)
        generations[service] = .init(loaded: false, disabledOverride: old.disabledOverride)
    }
    func isLoaded(service: String) -> Bool { state(service).loaded }
    func installationState(service: String) -> LaunchdJobGeneration { state(service) }

    private func state(_ service: String) -> LaunchdJobGeneration {
        generations[service] ?? .init(loaded: false, disabledOverride: false)
    }
}

private actor TransactionalLaunchctl: InstallationLaunchctlControlling {
    private let failAtMutation: Int?
    private let failAtRollback: Int?
    private let failAtStateQuery: Int?
    private let flipDisabledAtStateQuery: Int?
    private var mutationCount = 0
    private var stateQueryCount = 0
    private var generations: [String: LaunchdJobGeneration]
    private(set) var events: [String] = []
    private var rollbackPhase = false
    private(set) var rollbackAttempts = 0
    private var rollbackServices: Set<String> = []

    init(
        failAtMutation: Int? = nil,
        failAtRollback: Int? = nil,
        failAtStateQuery: Int? = nil,
        flipDisabledAtStateQuery: Int? = nil,
        initiallyLoaded: Set<String> = [],
        initial: [String: LaunchdJobGeneration] = [:]
    ) {
        self.failAtMutation = failAtMutation
        self.failAtRollback = failAtRollback
        self.failAtStateQuery = failAtStateQuery
        self.flipDisabledAtStateQuery = flipDisabledAtStateQuery
        generations = initial
        for service in initiallyLoaded {
            generations[service] = .init(loaded: true, disabledOverride: false)
        }
    }

    var loadedServices: Set<String> {
        Set(generations.compactMap { $0.value.loaded ? $0.key : nil })
    }
    var allGenerations: [String: LaunchdJobGeneration] { generations }
    var rollbackTouchedServices: Set<String> { rollbackServices }

    func disable(service: String) throws {
        try mutate(service: service) {
            events.append("disable:\(service)")
            let old = current(service)
            generations[service] = .init(loaded: old.loaded, disabledOverride: true)
        }
    }
    func enable(service: String) throws {
        try mutate(service: service) {
            events.append("enable:\(service)")
            let old = current(service)
            generations[service] = .init(loaded: old.loaded, disabledOverride: false)
        }
    }
    func bootstrap(plistURL: URL) throws {
        let service = "gui/\(getuid())/\(plistURL.deletingPathExtension().lastPathComponent)"
        try mutate(service: service) {
            events.append("bootstrap:\(service)")
            let old = current(service)
            generations[service] = .init(loaded: true, disabledOverride: old.disabledOverride)
        }
    }
    func bootout(service: String) throws {
        try mutate(service: service) {
            events.append("bootout:\(service)")
            let old = current(service)
            generations[service] = .init(loaded: false, disabledOverride: old.disabledOverride)
        }
    }
    func isLoaded(service: String) -> Bool { current(service).loaded }
    func installationState(service: String) throws -> LaunchdJobGeneration {
        stateQueryCount += 1
        if stateQueryCount == failAtStateQuery { throw LaunchctlError.transport }
        if stateQueryCount == flipDisabledAtStateQuery {
            let old = current(service)
            generations[service] = .init(
                loaded: old.loaded,
                disabledOverride: !old.disabledOverride
            )
        }
        return current(service)
    }
    func generation(service: String) -> LaunchdJobGeneration { current(service) }

    private func mutate(service: String, _ operation: () -> Void) throws {
        mutationCount += 1
        if rollbackPhase {
            rollbackAttempts += 1
            rollbackServices.insert(service)
            if rollbackAttempts == failAtRollback { throw LaunchctlError.transport }
        } else if mutationCount == failAtMutation {
            rollbackPhase = true
            throw LaunchctlError.transport
        }
        operation()
    }

    private func current(_ service: String) -> LaunchdJobGeneration {
        generations[service] ?? .init(loaded: false, disabledOverride: false)
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

private func fileInode(_ url: URL) throws -> ino_t {
    var status = stat()
    guard lstat(url.path, &status) == 0 else { throw InjectedInstallFailure.mutation }
    return status.st_ino
}

private final class LeafRaceHook: @unchecked Sendable {
    let targetName: String
    let phase: InstallerLeafPublishPhase
    let operation: () throws -> Void
    private let lock = NSLock()
    private var fired = false

    init(targetName: String, phase: InstallerLeafPublishPhase, operation: @escaping () throws -> Void) {
        self.targetName = targetName
        self.phase = phase
        self.operation = operation
    }

    func call(name: String, phase: InstallerLeafPublishPhase) throws {
        try lock.withLock {
            guard !fired, name == targetName, phase == self.phase else { return }
            fired = true
            try operation()
        }
    }
}
