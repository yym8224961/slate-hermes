import Darwin
import Foundation

enum LaunchctlError: Error, Equatable, Sendable, CustomStringConvertible {
    case transport

    var publicCode: String { "launchctl_transport" }
    var description: String { "LaunchctlError(code: \(publicCode))" }
}

struct SystemLaunchctlController: LaunchctlControlling, Sendable {
    private let executableURL = URL(fileURLWithPath: "/bin/launchctl")

    func disable(service: String) async throws {
        guard run(["disable", service]) == 0 || disabledOverride(for: service) == true else {
            throw LaunchctlError.transport
        }
    }

    func enable(service: String) async throws {
        guard run(["enable", service]) == 0 || disabledOverride(for: service) != true else {
            throw LaunchctlError.transport
        }
    }

    func bootstrap(plistURL: URL) async throws {
        let service = serviceForPlist(plistURL)
        let status = run(["bootstrap", "gui/\(getuid())", plistURL.path])
        if status != 0, await !isLoaded(service: service) {
            throw LaunchctlError.transport
        }
    }

    func bootout(service: String) async throws {
        let status = run(["bootout", service])
        if status != 0, await isLoaded(service: service) {
            throw LaunchctlError.transport
        }
    }

    func isLoaded(service: String) async -> Bool {
        run(["print", service]) == 0
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

    init(paths: InstallationPaths = .init()) {
        self.paths = paths
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
        try createOwnerDirectory(paths.launchAgentsURL)
        try createOwnerDirectory(paths.logsURL)
        for log in [
            paths.menuBarStandardOutputURL, paths.menuBarStandardErrorURL,
            paths.collectorStandardOutputURL, paths.collectorStandardErrorURL,
        ] {
            try ensureOwnerOnlyLog(at: log)
        }
        try atomicWrite(rendered.menuBar, to: paths.menuBarPlistURL)
        try atomicWrite(rendered.collector, to: paths.collectorPlistURL)
        return LaunchAgentArtifacts(
            menuBarPlistURL: paths.menuBarPlistURL,
            collectorPlistURL: paths.collectorPlistURL
        )
    }

    func removeGeneratedArtifacts() throws {
        for url in [paths.menuBarPlistURL, paths.collectorPlistURL, paths.stableExecutableURL] {
            try removeExactGeneratedItem(at: url, allowDirectory: false)
        }
        try removeExactGeneratedItem(at: paths.appBundleURL, allowDirectory: true)
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

    private func createOwnerDirectory(_ url: URL) throws {
        var status = stat()
        if lstat(url.path, &status) == 0 {
            guard status.st_mode & S_IFMT == S_IFDIR, status.st_uid == getuid() else {
                throw InstallerError.unsafeExistingItem
            }
        } else if errno != ENOENT {
            throw InstallerError.ioFailure
        }
        do {
            try FileManager.default.createDirectory(
                at: url, withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
        } catch { throw InstallerError.ioFailure }
        status = stat()
        guard lstat(url.path, &status) == 0,
              status.st_mode & S_IFMT == S_IFDIR,
              status.st_uid == getuid() else {
            throw InstallerError.unsafeExistingItem
        }
        guard chmod(url.path, S_IRWXU) == 0 else { throw InstallerError.ioFailure }
    }

    private func ensureOwnerOnlyLog(at url: URL) throws {
        let descriptor = open(url.path, O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW | O_CLOEXEC, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else { throw InstallerError.ioFailure }
        defer { _ = close(descriptor) }
        var status = stat()
        guard fstat(descriptor, &status) == 0,
              status.st_mode & S_IFMT == S_IFREG,
              status.st_uid == getuid(),
              fchmod(descriptor, S_IRUSR | S_IWUSR) == 0 else {
            throw InstallerError.unsafeExistingItem
        }
    }

    private func atomicWrite(_ data: Data, to destination: URL) throws {
        let directory = destination.deletingLastPathComponent()
        let temporary = directory.appendingPathComponent(".launch-agent-\(UUID().uuidString).tmp")
        defer { try? FileManager.default.removeItem(at: temporary) }
        do {
            try data.write(to: temporary, options: .withoutOverwriting)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporary.path)
            if FileManager.default.fileExists(atPath: destination.path) {
                var status = stat()
                guard lstat(destination.path, &status) == 0,
                      status.st_mode & S_IFMT == S_IFREG,
                      status.st_uid == getuid() else {
                    throw InstallerError.unsafeExistingItem
                }
                _ = try FileManager.default.replaceItemAt(destination, withItemAt: temporary)
            } else {
                try FileManager.default.moveItem(at: temporary, to: destination)
            }
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
        } catch let error as InstallerError { throw error }
        catch { throw InstallerError.ioFailure }
    }

    private func removeExactGeneratedItem(at url: URL, allowDirectory: Bool) throws {
        var status = stat()
        guard lstat(url.path, &status) == 0 else {
            if errno == ENOENT { return }
            throw InstallerError.ioFailure
        }
        let kind = status.st_mode & S_IFMT
        guard status.st_uid == getuid(),
              kind == S_IFREG || kind == S_IFLNK || (allowDirectory && kind == S_IFDIR) else {
            throw InstallerError.unsafeExistingItem
        }
        do { try FileManager.default.removeItem(at: url) }
        catch { throw InstallerError.ioFailure }
    }
}
