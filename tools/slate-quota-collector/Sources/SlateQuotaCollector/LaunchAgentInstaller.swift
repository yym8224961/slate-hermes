import Darwin
import Foundation

enum LaunchctlError: Error, Equatable, Sendable, CustomStringConvertible {
    case transport
    case rollback

    var publicCode: String {
        switch self {
        case .transport: "launchctl_transport"
        case .rollback: "launchctl_rollback"
        }
    }
    var description: String { "LaunchctlError(code: \(publicCode))" }
}

struct LaunchdJobGeneration: Equatable, Sendable {
    let loaded: Bool
    let disabledOverride: Bool
}

/// Installation needs a stronger contract than the interactive schedule
/// controller: both independent pieces of launchd state must be captured and
/// restored as one generation.
protocol InstallationLaunchctlControlling: LaunchctlControlling {
    func installationState(service: String) async throws -> LaunchdJobGeneration
}

struct SystemLaunchctlController: InstallationLaunchctlControlling, Sendable {
    private let executableURL: URL

    init(executableURL: URL = URL(fileURLWithPath: "/bin/launchctl")) {
        self.executableURL = executableURL
    }

    func disable(service: String) async throws {
        guard run(["disable", service]) == 0 || disabledOverride(for: service) == true else {
            throw LaunchctlError.transport
        }
    }

    func enable(service: String) async throws {
        guard run(["enable", service]) == 0 || disabledOverride(for: service) == false else {
            throw LaunchctlError.transport
        }
    }

    func bootstrap(plistURL: URL) async throws {
        let service = serviceForPlist(plistURL)
        let status = run(["bootstrap", "gui/\(getuid())", plistURL.path])
        if status != 0, loadedState(service: service) != true {
            throw LaunchctlError.transport
        }
    }

    func bootout(service: String) async throws {
        let status = run(["bootout", service])
        if status != 0, loadedState(service: service) != false {
            throw LaunchctlError.transport
        }
    }

    func isLoaded(service: String) async -> Bool {
        loadedState(service: service) ?? false
    }

    func installationState(service: String) async throws -> LaunchdJobGeneration {
        guard let disabled = disabledOverride(for: service),
              let loaded = loadedState(service: service) else {
            throw LaunchctlError.transport
        }
        return LaunchdJobGeneration(
            loaded: loaded,
            disabledOverride: disabled
        )
    }

    private func loadedState(service: String) -> Bool? {
        let status = run(["print", service])
        if status < 0 { return nil }
        return status == 0
    }

    private func serviceForPlist(_ url: URL) -> String {
        let label = url.deletingPathExtension().lastPathComponent
        return "gui/\(getuid())/\(label)"
    }

    private func disabledOverride(for service: String) -> Bool? {
        let parts = service.split(separator: "/", maxSplits: 2).map(String.init)
        guard parts.count == 3, parts[0] == "gui", Int(parts[1]) != nil else { return nil }
        let result = runCapture(["print-disabled", "gui/\(parts[1])"])
        guard result.status == 0 else { return nil }
        let quotedLabel = "\"\(parts[2])\""
        for line in result.output.split(separator: "\n") where line.contains(quotedLabel) {
            if line.contains("=> true") { return true }
            if line.contains("=> false") { return false }
        }
        return false
    }

    /// launchctl receives only fixed labels and local paths. Output is discarded
    /// so a system diagnostic can never become part of our public status/logs.
    private func run(_ arguments: [String]) -> Int32 {
        let process = Process()
        process.executableURL = executableURL
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do { try process.run() }
        catch { return -1 }
        process.waitUntilExit()
        return process.terminationStatus
    }

    private func runCapture(_ arguments: [String]) -> (status: Int32, output: String) {
        let process = Process()
        let output = Pipe()
        process.executableURL = executableURL
        process.arguments = arguments
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do { try process.run() }
        catch { return (-1, "") }
        process.waitUntilExit()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        return (process.terminationStatus, String(data: data, encoding: .utf8) ?? "")
    }
}

struct LaunchAgentPlists: Sendable {
    let menuBar: Data
    let collector: Data
}

struct LaunchAgentArtifacts: Sendable {
    let menuBarPlistURL: URL
    let collectorPlistURL: URL
}

struct LaunchAgentGeneration: Equatable, Sendable {
    let menuBarPlist: Data?
    let collectorPlist: Data?
}

struct LaunchAgentInstaller: Sendable {
    static let menuBarLabel = "com.yym8224961.slate-quota-menubar"
    static let collectorLabel = "com.yym8224961.slate-quota-collector"

    static let menuBarPlistTemplate = """
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
        <key>Label</key>
        <string>com.yym8224961.slate-quota-menubar</string>
        <key>ProgramArguments</key>
        <array>
            <string>__MENU_EXECUTABLE__</string>
            <string>--menu-bar</string>
        </array>
        <key>RunAtLoad</key>
        <true/>
        <key>ProcessType</key>
        <string>Interactive</string>
        <key>StandardOutPath</key>
        <string>__MENU_STDOUT__</string>
        <key>StandardErrorPath</key>
        <string>__MENU_STDERR__</string>
    </dict>
    </plist>
    """ + "\n"

    static let collectorPlistTemplate = """
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
        <key>Label</key>
        <string>com.yym8224961.slate-quota-collector</string>
        <key>ProgramArguments</key>
        <array>
            <string>__COLLECTOR_EXECUTABLE__</string>
            <string>collect</string>
            <string>--scheduled</string>
        </array>
        <key>RunAtLoad</key>
        <true/>
        <key>StartInterval</key>
        <integer>300</integer>
        <key>ProcessType</key>
        <string>Background</string>
        <key>StandardOutPath</key>
        <string>__COLLECTOR_STDOUT__</string>
        <key>StandardErrorPath</key>
        <string>__COLLECTOR_STDERR__</string>
    </dict>
    </plist>
    """ + "\n"

    let paths: InstallationPaths
    private let afterDirectoriesOpen: @Sendable () throws -> Void

    init(
        paths: InstallationPaths = .init(),
        afterDirectoriesOpen: @escaping @Sendable () throws -> Void = {}
    ) {
        self.paths = paths
        self.afterDirectoriesOpen = afterDirectoriesOpen
    }

    func renderPlists() throws -> LaunchAgentPlists {
        guard allRuntimePathsAreAbsolute else { throw InstallerError.invalidPath }
        let menu = try render(
            Self.menuBarPlistTemplate,
            replacements: [
                "__MENU_EXECUTABLE__": paths.appExecutableURL.path,
                "__MENU_STDOUT__": paths.menuBarStandardOutputURL.path,
                "__MENU_STDERR__": paths.menuBarStandardErrorURL.path,
            ]
        )
        let collector = try render(
            Self.collectorPlistTemplate,
            replacements: [
                "__COLLECTOR_EXECUTABLE__": paths.stableExecutableURL.path,
                "__COLLECTOR_STDOUT__": paths.collectorStandardOutputURL.path,
                "__COLLECTOR_STDERR__": paths.collectorStandardErrorURL.path,
            ]
        )
        return LaunchAgentPlists(menuBar: menu, collector: collector)
    }

    func installPlists() throws -> LaunchAgentArtifacts {
        let rendered = try renderPlists()
        let previous = try captureGeneration(rendered: rendered)
        guard let launchAgents = try openLaunchAgents(createMissing: true),
              let logs = try openLogs(createMissing: true) else {
            throw InstallerError.ioFailure
        }
        do {
            try afterDirectoriesOpen()
            try launchAgents.requirePublicIdentity()
            try logs.requirePublicIdentity()
            for log in [
                paths.menuBarStandardOutputURL, paths.menuBarStandardErrorURL,
                paths.collectorStandardOutputURL, paths.collectorStandardErrorURL,
            ] {
                try InstallerFileSystem.ensureOwnerOnlyLog(logs, name: log.lastPathComponent)
            }
            try InstallerFileSystem.atomicWrite(
                rendered.menuBar, to: launchAgents,
                name: paths.menuBarPlistURL.lastPathComponent,
                mode: S_IRUSR | S_IWUSR
            )
            try InstallerFileSystem.atomicWrite(
                rendered.collector, to: launchAgents,
                name: paths.collectorPlistURL.lastPathComponent,
                mode: S_IRUSR | S_IWUSR
            )
        } catch {
            try? restore(previous)
            throw error
        }
        return LaunchAgentArtifacts(
            menuBarPlistURL: paths.menuBarPlistURL,
            collectorPlistURL: paths.collectorPlistURL
        )
    }

    func removeGeneratedArtifacts() throws {
        let rendered = try renderPlists()
        let previousAgents = try captureGeneration(rendered: rendered)
        let appInstaller = AppBundleInstaller(paths: paths)
        let previousApp = try appInstaller.captureGeneration()
        do {
            try appInstaller.removeInstalledArtifacts()
            if let launchAgents = try openLaunchAgents(createMissing: false) {
                try InstallerFileSystem.unlinkRegularFile(
                    launchAgents, name: paths.menuBarPlistURL.lastPathComponent,
                    expected: rendered.menuBar
                )
                try InstallerFileSystem.unlinkRegularFile(
                    launchAgents, name: paths.collectorPlistURL.lastPathComponent,
                    expected: rendered.collector
                )
            }
        } catch {
            try? restore(previousAgents)
            try? appInstaller.restore(previousApp)
            throw error
        }
    }

    func captureGeneration() throws -> LaunchAgentGeneration {
        try captureGeneration(rendered: renderPlists())
    }

    func restore(_ generation: LaunchAgentGeneration) throws {
        guard let launchAgents = try openLaunchAgents(createMissing: true) else {
            throw InstallerError.ioFailure
        }
        let rendered = try renderPlists()
        try restore(
            generation.menuBarPlist, expected: rendered.menuBar,
            name: paths.menuBarPlistURL.lastPathComponent, in: launchAgents
        )
        try restore(
            generation.collectorPlist, expected: rendered.collector,
            name: paths.collectorPlistURL.lastPathComponent, in: launchAgents
        )
    }

    private func captureGeneration(rendered: LaunchAgentPlists) throws -> LaunchAgentGeneration {
        guard let launchAgents = try openLaunchAgents(createMissing: false) else {
            return LaunchAgentGeneration(menuBarPlist: nil, collectorPlist: nil)
        }
        return LaunchAgentGeneration(
            menuBarPlist: try captureGeneratedFile(
                in: launchAgents, name: paths.menuBarPlistURL.lastPathComponent,
                expected: rendered.menuBar
            ),
            collectorPlist: try captureGeneratedFile(
                in: launchAgents, name: paths.collectorPlistURL.lastPathComponent,
                expected: rendered.collector
            )
        )
    }

    private func captureGeneratedFile(
        in directory: InstallerDirectoryHandle, name: String, expected: Data
    ) throws -> Data? {
        guard try InstallerFileSystem.exists(directory, name: name) else { return nil }
        let data = try InstallerFileSystem.readRegularFile(directory, name: name)
        guard data == expected else { throw InstallerError.unsafeExistingItem }
        return data
    }

    private func restore(
        _ data: Data?, expected: Data, name: String,
        in directory: InstallerDirectoryHandle
    ) throws {
        if let data {
            try InstallerFileSystem.atomicWrite(
                data, to: directory, name: name, mode: S_IRUSR | S_IWUSR
            )
        } else {
            try InstallerFileSystem.unlinkRegularFile(
                directory, name: name, expected: expected
            )
        }
    }

    private var allRuntimePathsAreAbsolute: Bool {
        [
            paths.appExecutableURL, paths.stableExecutableURL,
            paths.menuBarStandardOutputURL, paths.menuBarStandardErrorURL,
            paths.collectorStandardOutputURL, paths.collectorStandardErrorURL,
        ].allSatisfy { $0.path.hasPrefix("/") }
    }

    private func render(_ template: String, replacements: [String: String]) throws -> Data {
        var output = template
        for (placeholder, value) in replacements {
            output = output.replacingOccurrences(of: placeholder, with: xmlEscaped(value))
        }
        guard !output.contains("__"), let data = output.data(using: .utf8) else {
            throw InstallerError.ioFailure
        }
        _ = try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
        return data
    }

    private func xmlEscaped(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&apos;")
    }

    private func openLaunchAgents(
        createMissing: Bool
    ) throws -> InstallerDirectoryHandle? {
        try InstallerFileSystem.openDirectory(
            paths.launchAgentsURL,
            allowedRoot: paths.launchAgentsURL.deletingLastPathComponent(),
            createMissing: createMissing, appOwnedLeaf: false
        )
    }

    private func openLogs(createMissing: Bool) throws -> InstallerDirectoryHandle? {
        try InstallerFileSystem.openDirectory(
            paths.logsURL,
            allowedRoot: paths.logsURL.deletingLastPathComponent(),
            createMissing: createMissing, appOwnedLeaf: true
        )
    }
}
