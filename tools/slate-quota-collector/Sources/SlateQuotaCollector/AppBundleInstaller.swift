import Darwin
import Foundation

enum InstallerError: Error, Equatable, Sendable, CustomStringConvertible {
    case invalidPath
    case unsafeExistingItem
    case ioFailure

    var publicCode: String {
        switch self {
        case .invalidPath: "install_path"
        case .unsafeExistingItem: "install_unsafe_item"
        case .ioFailure: "install_io"
        }
    }

    var description: String { "InstallerError(code: \(publicCode))" }
}

struct InstallationPaths: Sendable {
    let homeDirectory: URL
    let applicationSupportURL: URL
    let launchAgentsURL: URL
    let logsURL: URL

    init(
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
        applicationSupportURL: URL = FileManager.default.urls(
            for: .applicationSupportDirectory, in: .userDomainMask
        )[0],
        launchAgentsURL: URL? = nil,
        logsURL: URL? = nil
    ) {
        self.homeDirectory = homeDirectory.standardizedFileURL
        self.applicationSupportURL = applicationSupportURL.standardizedFileURL
        self.launchAgentsURL = (launchAgentsURL
            ?? homeDirectory.appendingPathComponent("Library/LaunchAgents", isDirectory: true))
            .standardizedFileURL
        self.logsURL = (logsURL
            ?? homeDirectory.appendingPathComponent("Library/Logs/SlateQuotaCollector", isDirectory: true))
            .standardizedFileURL
    }

    var appBundleURL: URL {
        homeDirectory.appendingPathComponent("Applications/Slate 额度监控.app", isDirectory: true)
    }

    var appExecutableURL: URL {
        appBundleURL.appendingPathComponent("Contents/MacOS/slate-quota-collector")
    }

    var infoPlistURL: URL {
        appBundleURL.appendingPathComponent("Contents/Info.plist")
    }

    var collectorStateDirectoryURL: URL {
        applicationSupportURL.appendingPathComponent("SlateQuotaCollector", isDirectory: true)
    }

    var stableExecutableURL: URL {
        collectorStateDirectoryURL.appendingPathComponent("bin/slate-quota-collector")
    }

    var menuBarPlistURL: URL {
        launchAgentsURL.appendingPathComponent("com.yym8224961.slate-quota-menubar.plist")
    }

    var collectorPlistURL: URL {
        launchAgentsURL.appendingPathComponent("com.yym8224961.slate-quota-collector.plist")
    }

    var menuBarStandardOutputURL: URL { logsURL.appendingPathComponent("menubar.out.log") }
    var menuBarStandardErrorURL: URL { logsURL.appendingPathComponent("menubar.err.log") }
    var collectorStandardOutputURL: URL { logsURL.appendingPathComponent("collector.out.log") }
    var collectorStandardErrorURL: URL { logsURL.appendingPathComponent("collector.err.log") }
}

struct AppBundleLayout: Sendable {
    let bundleURL: URL
    let bundleExecutableURL: URL
    let stableExecutableURL: URL
    let infoPlistURL: URL
}

struct AppBundleInstaller: Sendable {
    static let infoPlistTemplate = """
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
        <key>CFBundlePackageType</key>
        <string>APPL</string>
        <key>CFBundleIdentifier</key>
        <string>com.yym8224961.slate-quota-menubar</string>
        <key>CFBundleName</key>
        <string>Slate 额度监控</string>
        <key>CFBundleExecutable</key>
        <string>slate-quota-collector</string>
        <key>LSUIElement</key>
        <true/>
        <key>LSMinimumSystemVersion</key>
        <string>13.0</string>
    </dict>
    </plist>
    """ + "\n"

    let paths: InstallationPaths

    init(paths: InstallationPaths = .init()) {
        self.paths = paths
    }

    func install(executableURL: URL) throws -> AppBundleLayout {
        let source = executableURL.standardizedFileURL
        guard source.path.hasPrefix("/"), try isOwnerExecutableRegularFile(source) else {
            throw InstallerError.invalidPath
        }

        let contents = paths.appBundleURL.appendingPathComponent("Contents", isDirectory: true)
        let macOS = contents.appendingPathComponent("MacOS", isDirectory: true)
        let bin = paths.stableExecutableURL.deletingLastPathComponent()
        try createOwnerDirectory(paths.appBundleURL.deletingLastPathComponent())
        try createOwnerDirectory(paths.appBundleURL)
        try createOwnerDirectory(contents)
        try createOwnerDirectory(macOS)
        try createOwnerDirectory(paths.collectorStateDirectoryURL)
        try createOwnerDirectory(bin)

        try installFile(from: source, to: paths.appExecutableURL, mode: 0o700)
        try installFile(from: source, to: paths.stableExecutableURL, mode: 0o700)
        guard let info = Self.infoPlistTemplate.data(using: .utf8) else {
            throw InstallerError.ioFailure
        }
        _ = try PropertyListSerialization.propertyList(from: info, options: [], format: nil)
        try writeFile(info, to: paths.infoPlistURL, mode: 0o600)

        return AppBundleLayout(
            bundleURL: paths.appBundleURL,
            bundleExecutableURL: paths.appExecutableURL,
            stableExecutableURL: paths.stableExecutableURL,
            infoPlistURL: paths.infoPlistURL
        )
    }

    private func isOwnerExecutableRegularFile(_ url: URL) throws -> Bool {
        var status = stat()
        guard lstat(url.path, &status) == 0 else { return false }
        return status.st_mode & S_IFMT == S_IFREG
            && status.st_uid == getuid()
            && access(url.path, R_OK | X_OK) == 0
    }

    private func createOwnerDirectory(_ url: URL) throws {
        guard url.path.hasPrefix("/") else { throw InstallerError.invalidPath }
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
        } catch {
            throw InstallerError.ioFailure
        }
        status = stat()
        guard lstat(url.path, &status) == 0,
              status.st_mode & S_IFMT == S_IFDIR,
              status.st_uid == getuid() else {
            throw InstallerError.unsafeExistingItem
        }
        guard chmod(url.path, S_IRWXU) == 0 else { throw InstallerError.ioFailure }
    }

    private func installFile(from source: URL, to destination: URL, mode: Int) throws {
        let data: Data
        do { data = try Data(contentsOf: source, options: .mappedIfSafe) }
        catch { throw InstallerError.ioFailure }
        try writeFile(data, to: destination, mode: mode)
    }

    private func writeFile(_ data: Data, to destination: URL, mode: Int) throws {
        guard destination.path.hasPrefix("/") else { throw InstallerError.invalidPath }
        let temporary = destination.deletingLastPathComponent()
            .appendingPathComponent(".install-\(UUID().uuidString).tmp")
        defer { try? FileManager.default.removeItem(at: temporary) }
        do {
            try data.write(to: temporary, options: .withoutOverwriting)
            try FileManager.default.setAttributes([.posixPermissions: mode], ofItemAtPath: temporary.path)
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
            try FileManager.default.setAttributes([.posixPermissions: mode], ofItemAtPath: destination.path)
        } catch let error as InstallerError {
            throw error
        } catch {
            throw InstallerError.ioFailure
        }
    }
}
