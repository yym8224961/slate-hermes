import Foundation
import Testing
@testable import SlateQuotaCollector

@Suite("LaunchAgent installer", .serialized)
struct LaunchAgentInstallerTests {
    @Test("renders independent absolute menu bar and collector jobs")
    func rendersIndependentJobs() throws {
        let root = try TemporaryDirectory()
        let paths = InstallationPaths.fixture(root: root.url)
        let rendered = try LaunchAgentInstaller(paths: paths).renderPlists()

        let menu = try decode(rendered.menuBar)
        let collector = try decode(rendered.collector)
        #expect(menu["Label"] as? String == LaunchAgentInstaller.menuBarLabel)
        #expect(menu["RunAtLoad"] as? Bool == true)
        #expect(menu["StartInterval"] == nil)
        #expect(menu["KeepAlive"] == nil)
        #expect(menu["ProgramArguments"] as? [String] == [paths.appExecutableURL.path, "--menu-bar"])
        #expect(collector["Label"] as? String == LaunchAgentInstaller.collectorLabel)
        #expect(collector["RunAtLoad"] as? Bool == true)
        #expect(collector["StartInterval"] as? Int == 300)
        #expect(collector["ProgramArguments"] as? [String] == [
            paths.stableExecutableURL.path, "collect", "--scheduled",
        ])

        for value in [rendered.menuBar, rendered.collector] {
            let text = try #require(String(data: value, encoding: .utf8))
            #expect(text.contains("__") == false)
            #expect(text.localizedCaseInsensitiveContains("api_key") == false)
            #expect(text.localizedCaseInsensitiveContains("authorization") == false)
            #expect(text.contains("/api/v1/contents/") == false)
        }
    }

    @Test("installs owner-only plists and pre-created log files without secrets")
    func installsOwnerOnlyArtifacts() throws {
        let root = try TemporaryDirectory()
        let paths = InstallationPaths.fixture(root: root.url)
        let installer = LaunchAgentInstaller(paths: paths)

        let artifacts = try installer.installPlists()

        for url in [
            artifacts.menuBarPlistURL, artifacts.collectorPlistURL,
            paths.menuBarStandardOutputURL, paths.menuBarStandardErrorURL,
            paths.collectorStandardOutputURL, paths.collectorStandardErrorURL,
        ] {
            #expect(FileManager.default.fileExists(atPath: url.path))
            #expect(try fileMode(url) & 0o777 == 0o600)
        }
    }

    @Test("existing broad launch directories keep their modes")
    func preservesBroadDirectoryModes() throws {
        let root = try TemporaryDirectory()
        let paths = InstallationPaths.fixture(root: root.url)
        let library = paths.launchAgentsURL.deletingLastPathComponent()
        for directory in [library, paths.launchAgentsURL, paths.logsURL.deletingLastPathComponent()] {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o755], ofItemAtPath: directory.path
            )
        }

        _ = try LaunchAgentInstaller(paths: paths).installPlists()

        #expect(try fileMode(library) & 0o777 == 0o755)
        #expect(try fileMode(paths.launchAgentsURL) & 0o777 == 0o755)
        #expect(try fileMode(paths.logsURL.deletingLastPathComponent()) & 0o777 == 0o755)
        #expect(try fileMode(paths.logsURL) & 0o777 == 0o700)
    }

    @Test("held plist and log parents reject ancestor swaps without touching victims")
    func ancestorSwapsPreserveVictims() throws {
        let root = try TemporaryDirectory()
        let paths = InstallationPaths.fixture(root: root.url)
        try FileManager.default.createDirectory(
            at: paths.launchAgentsURL, withIntermediateDirectories: true
        )
        try FileManager.default.createDirectory(at: paths.logsURL, withIntermediateDirectories: true)
        let launchDisplaced = root.url.appendingPathComponent("launch-displaced")
        let logsDisplaced = root.url.appendingPathComponent("logs-displaced")
        let launchVictim = root.url.appendingPathComponent("launch-victim", isDirectory: true)
        let logsVictim = root.url.appendingPathComponent("logs-victim", isDirectory: true)
        try FileManager.default.createDirectory(at: launchVictim, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: logsVictim, withIntermediateDirectories: true)
        let launchSentinel = launchVictim.appendingPathComponent("sentinel")
        let logsSentinel = logsVictim.appendingPathComponent("sentinel")
        try Data("launch-keep".utf8).write(to: launchSentinel)
        try Data("logs-keep".utf8).write(to: logsSentinel)
        let installer = LaunchAgentInstaller(
            paths: paths,
            afterDirectoriesOpen: {
                try FileManager.default.moveItem(at: paths.launchAgentsURL, to: launchDisplaced)
                try FileManager.default.createSymbolicLink(
                    at: paths.launchAgentsURL, withDestinationURL: launchVictim
                )
                try FileManager.default.moveItem(at: paths.logsURL, to: logsDisplaced)
                try FileManager.default.createSymbolicLink(
                    at: paths.logsURL, withDestinationURL: logsVictim
                )
            }
        )

        #expect(throws: InstallerError.self) { try installer.installPlists() }

        #expect(try String(contentsOf: launchSentinel, encoding: .utf8) == "launch-keep")
        #expect(try String(contentsOf: logsSentinel, encoding: .utf8) == "logs-keep")
        #expect(try FileManager.default.contentsOfDirectory(atPath: launchVictim.path) == ["sentinel"])
        #expect(try FileManager.default.contentsOfDirectory(atPath: logsVictim.path) == ["sentinel"])
    }

    @Test("launch-agent installer rejects a substituted directory without changing its target")
    func launchAgentInstallerRejectsDirectorySymlink() throws {
        let root = try TemporaryDirectory()
        let paths = InstallationPaths.fixture(root: root.url)
        let target = root.url.appendingPathComponent("unrelated-launch-agents", isDirectory: true)
        try FileManager.default.createDirectory(at: paths.launchAgentsURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: target.path)
        try FileManager.default.createSymbolicLink(at: paths.launchAgentsURL, withDestinationURL: target)

        #expect(throws: InstallerError.self) {
            try LaunchAgentInstaller(paths: paths).installPlists()
        }
        #expect(try fileMode(target) & 0o777 == 0o755)
        #expect(try FileManager.default.contentsOfDirectory(atPath: target.path).isEmpty)
    }

    @Test("embedded launch-agent templates exactly match auditable resources")
    func embeddedTemplatesMatchResources() throws {
        let resources = packageRoot().appendingPathComponent("Resources", isDirectory: true)
        #expect(try String(
            contentsOf: resources.appendingPathComponent("com.yym8224961.slate-quota-menubar.plist.template"),
            encoding: .utf8
        ) == LaunchAgentInstaller.menuBarPlistTemplate)
        #expect(try String(
            contentsOf: resources.appendingPathComponent("com.yym8224961.slate-quota-collector.plist.template"),
            encoding: .utf8
        ) == LaunchAgentInstaller.collectorPlistTemplate)
    }

    @Test("launchctl enable fails closed when disabled-state query is indeterminate")
    func enableRejectsNilDisabledState() async throws {
        let root = try TemporaryDirectory()
        let launchctl = root.url.appendingPathComponent("launchctl-fixture")
        try "#!/bin/sh\nexit 1\n".write(to: launchctl, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700], ofItemAtPath: launchctl.path
        )
        let controller = SystemLaunchctlController(executableURL: launchctl)

        await #expect(throws: LaunchctlError.self) {
            try await controller.enable(service: "gui/\(getuid())/\(LaunchAgentInstaller.menuBarLabel)")
        }
    }

    @Test("launchd installation state fails closed when loaded-state transport cannot start")
    func installationStateRejectsNilLoadedState() async throws {
        let controller = SystemLaunchctlController(
            executableURL: URL(fileURLWithPath: "/definitely/missing/launchctl")
        )
        let service = "gui/\(getuid())/\(LaunchAgentInstaller.menuBarLabel)"

        await #expect(throws: LaunchctlError.self) {
            try await controller.installationState(service: service)
        }
        await #expect(throws: LaunchctlError.self) {
            try await controller.bootout(service: service)
        }
    }

    @Test("uninstall removes only generated runtime artifacts and preserves state")
    func uninstallPreservesConfigurationAndState() throws {
        let root = try TemporaryDirectory()
        let paths = InstallationPaths.fixture(root: root.url)
        let executable = root.url.appendingPathComponent("release-binary")
        try Data("binary".utf8).write(to: executable)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
        _ = try AppBundleInstaller(paths: paths).install(executableURL: executable)
        let artifacts = try LaunchAgentInstaller(paths: paths).installPlists()
        let stateDirectory = paths.collectorStateDirectoryURL
        try FileManager.default.createDirectory(at: stateDirectory, withIntermediateDirectories: true)
        for name in ["config.json", "settings.json", "snapshot-state.json"] {
            try Data(name.utf8).write(to: stateDirectory.appendingPathComponent(name))
        }

        try LaunchAgentInstaller(paths: paths).removeGeneratedArtifacts()

        #expect(FileManager.default.fileExists(atPath: paths.appBundleURL.path) == false)
        #expect(FileManager.default.fileExists(atPath: paths.stableExecutableURL.path) == false)
        #expect(FileManager.default.fileExists(atPath: artifacts.menuBarPlistURL.path) == false)
        #expect(FileManager.default.fileExists(atPath: artifacts.collectorPlistURL.path) == false)
        for name in ["config.json", "settings.json", "snapshot-state.json"] {
            #expect(FileManager.default.fileExists(atPath: stateDirectory.appendingPathComponent(name).path))
        }
    }

    private func decode(_ data: Data) throws -> [String: Any] {
        try #require(PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any])
    }

    private func packageRoot() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }
}

private func fileMode(_ url: URL) throws -> Int {
    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    return try #require((attributes[.posixPermissions] as? NSNumber)?.intValue)
}
