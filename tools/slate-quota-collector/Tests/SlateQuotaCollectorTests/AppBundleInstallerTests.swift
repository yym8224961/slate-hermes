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

    private func packageRoot() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }
}

private actor RecordingInstallLaunchctl: LaunchctlControlling {
    private(set) var events: [String] = []
    func disable(service: String) { events.append("disable:\(service)") }
    func enable(service: String) { events.append("enable:\(service)") }
    func bootstrap(plistURL: URL) { events.append("bootstrap:\(plistURL.path)") }
    func bootout(service: String) { events.append("bootout:\(service)") }
    func isLoaded(service _: String) -> Bool { false }
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
