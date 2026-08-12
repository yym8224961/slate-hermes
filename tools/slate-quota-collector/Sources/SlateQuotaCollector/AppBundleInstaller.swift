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

    var installationMarkerURL: URL {
        appBundleURL.appendingPathComponent("Contents/Resources/.slate-quota-installation")
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

struct AppBundleGeneration: Equatable, Sendable {
    let bundleExecutable: Data?
    let stableExecutable: Data?
}

struct AppBundleInstaller: Sendable {
    static let installationMarker = "slate-quota-installation-v1\n"
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
    private let beforeBundlePublish: @Sendable () throws -> Void
    private let beforeStablePublish: @Sendable () throws -> Void
    private let beforeBundleQuarantine: @Sendable () throws -> Void

    init(
        paths: InstallationPaths = .init(),
        beforeBundlePublish: @escaping @Sendable () throws -> Void = {},
        beforeStablePublish: @escaping @Sendable () throws -> Void = {},
        beforeBundleQuarantine: @escaping @Sendable () throws -> Void = {}
    ) {
        self.paths = paths
        self.beforeBundlePublish = beforeBundlePublish
        self.beforeStablePublish = beforeStablePublish
        self.beforeBundleQuarantine = beforeBundleQuarantine
    }

    func install(executableURL: URL) throws -> AppBundleLayout {
        let source = executableURL.standardizedFileURL
        guard source.path.hasPrefix("/"), try isOwnerExecutableRegularFile(source) else {
            throw InstallerError.invalidPath
        }
        let data: Data
        do { data = try Data(contentsOf: source, options: .mappedIfSafe) }
        catch { throw InstallerError.ioFailure }
        _ = try captureGeneration()
        try publish(executableData: data)
        return layout
    }

    func captureGeneration() throws -> AppBundleGeneration {
        let bundle: Data?
        if itemExists(paths.appBundleURL) {
            try verifyGeneratedBundle(at: paths.appBundleURL)
            bundle = try Data(contentsOf: paths.appExecutableURL)
        } else {
            bundle = nil
        }
        let stable: Data?
        if itemExists(paths.stableExecutableURL) {
            guard try isOwnerRegularFile(paths.stableExecutableURL) else {
                throw InstallerError.unsafeExistingItem
            }
            stable = try Data(contentsOf: paths.stableExecutableURL)
        } else {
            stable = nil
        }
        return AppBundleGeneration(bundleExecutable: bundle, stableExecutable: stable)
    }

    func restore(_ generation: AppBundleGeneration) throws {
        if let data = generation.bundleExecutable {
            try publishBundle(executableData: data)
        } else if itemExists(paths.appBundleURL) {
            try removeVerifiedBundle(at: paths.appBundleURL)
        }
        if let data = generation.stableExecutable {
            try createAnchoredDirectory(
                paths.stableExecutableURL.deletingLastPathComponent(),
                root: paths.applicationSupportURL
            )
            try writeFile(data, to: paths.stableExecutableURL, mode: 0o700)
        } else if itemExists(paths.stableExecutableURL) {
            guard try isOwnerRegularFile(paths.stableExecutableURL) else {
                throw InstallerError.unsafeExistingItem
            }
            do { try FileManager.default.removeItem(at: paths.stableExecutableURL) }
            catch { throw InstallerError.ioFailure }
        }
    }

    func removeInstalledArtifacts() throws {
        let previous = try captureGeneration()
        if itemExists(paths.appBundleURL) {
            try verifyGeneratedBundle(at: paths.appBundleURL)
        }
        if itemExists(paths.stableExecutableURL) {
            guard try isOwnerRegularFile(paths.stableExecutableURL),
                  itemExists(paths.appExecutableURL),
                  try Data(contentsOf: paths.stableExecutableURL)
                    == Data(contentsOf: paths.appExecutableURL) else {
                throw InstallerError.unsafeExistingItem
            }
        }
        do {
            if itemExists(paths.appBundleURL) {
                try removeVerifiedBundle(at: paths.appBundleURL)
            }
            if itemExists(paths.stableExecutableURL) {
                do { try FileManager.default.removeItem(at: paths.stableExecutableURL) }
                catch { throw InstallerError.ioFailure }
            }
        } catch {
            try? restore(previous)
            throw error
        }
    }

    private var layout: AppBundleLayout {
        AppBundleLayout(
            bundleURL: paths.appBundleURL,
            bundleExecutableURL: paths.appExecutableURL,
            stableExecutableURL: paths.stableExecutableURL,
            infoPlistURL: paths.infoPlistURL
        )
    }

    private func publish(executableData: Data) throws {
        let previous = try captureGeneration()
        do {
            try publishBundle(executableData: executableData)
            try beforeStablePublish()
            try createAnchoredDirectory(
                paths.stableExecutableURL.deletingLastPathComponent(),
                root: paths.applicationSupportURL
            )
            try writeFile(executableData, to: paths.stableExecutableURL, mode: 0o700)
        } catch {
            try? restore(previous)
            throw error
        }
    }

    private func publishBundle(executableData: Data) throws {
        let applications = paths.appBundleURL.deletingLastPathComponent()
        try createAnchoredDirectory(applications, root: paths.homeDirectory)
        let applicationsDescriptor = open(
            applications.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
        )
        guard applicationsDescriptor >= 0 else { throw InstallerError.unsafeExistingItem }
        defer { _ = close(applicationsDescriptor) }
        var anchoredStatus = stat()
        guard fstat(applicationsDescriptor, &anchoredStatus) == 0 else {
            throw InstallerError.ioFailure
        }
        if itemExists(paths.appBundleURL) {
            try verifyGeneratedBundle(at: paths.appBundleURL)
        }
        let temporary = applications.appendingPathComponent(
            ".slate-quota-bundle-\(UUID().uuidString).tmp", isDirectory: true
        )
        let backup = applications.appendingPathComponent(
            ".slate-quota-bundle-\(UUID().uuidString).backup", isDirectory: true
        )
        defer {
            if itemExists(temporary) { try? removeVerifiedBundle(at: temporary) }
            if itemExists(backup) { try? removeVerifiedBundle(at: backup) }
        }
        let contents = temporary.appendingPathComponent("Contents", isDirectory: true)
        let macOS = contents.appendingPathComponent("MacOS", isDirectory: true)
        let resources = contents.appendingPathComponent("Resources", isDirectory: true)
        do {
            try FileManager.default.createDirectory(
                at: macOS, withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            try FileManager.default.createDirectory(
                at: resources, withIntermediateDirectories: false,
                attributes: [.posixPermissions: 0o700]
            )
            try writeFile(
                executableData,
                to: macOS.appendingPathComponent("slate-quota-collector"),
                mode: 0o700
            )
            guard let info = Self.infoPlistTemplate.data(using: .utf8),
                  let marker = Self.installationMarker.data(using: .utf8) else {
                throw InstallerError.ioFailure
            }
            _ = try PropertyListSerialization.propertyList(from: info, options: [], format: nil)
            try writeFile(info, to: contents.appendingPathComponent("Info.plist"), mode: 0o600)
            try writeFile(
                marker,
                to: resources.appendingPathComponent(".slate-quota-installation"),
                mode: 0o600
            )
            try verifyGeneratedBundle(at: temporary)
            try beforeBundlePublish()
            var currentStatus = stat()
            guard lstat(applications.path, &currentStatus) == 0,
                  currentStatus.st_mode & S_IFMT == S_IFDIR,
                  currentStatus.st_dev == anchoredStatus.st_dev,
                  currentStatus.st_ino == anchoredStatus.st_ino else {
                throw InstallerError.unsafeExistingItem
            }
            if itemExists(paths.appBundleURL) {
                guard renameat(
                    applicationsDescriptor, paths.appBundleURL.lastPathComponent,
                    applicationsDescriptor, backup.lastPathComponent
                ) == 0 else {
                    throw InstallerError.ioFailure
                }
            }
            guard renameat(
                applicationsDescriptor, temporary.lastPathComponent,
                applicationsDescriptor, paths.appBundleURL.lastPathComponent
            ) == 0 else {
                if itemExists(backup) {
                    _ = renameat(
                        applicationsDescriptor, backup.lastPathComponent,
                        applicationsDescriptor, paths.appBundleURL.lastPathComponent
                    )
                }
                throw InstallerError.ioFailure
            }
            if itemExists(backup) {
                try removeVerifiedBundle(at: backup)
            }
        } catch let error as InstallerError { throw error }
        catch { throw InstallerError.ioFailure }
    }

    @discardableResult
    private func verifyGeneratedBundle(at bundle: URL) throws -> (device: dev_t, inode: ino_t) {
        var status = stat()
        guard lstat(bundle.path, &status) == 0,
              status.st_mode & S_IFMT == S_IFDIR,
              status.st_uid == getuid() else {
            throw InstallerError.unsafeExistingItem
        }
        let expected = Set([
            "Contents", "Contents/Info.plist", "Contents/MacOS",
            "Contents/MacOS/slate-quota-collector", "Contents/Resources",
            "Contents/Resources/.slate-quota-installation",
        ])
        let actual: Set<String>
        do { actual = Set(try FileManager.default.subpathsOfDirectory(atPath: bundle.path)) }
        catch { throw InstallerError.ioFailure }
        guard actual == expected else { throw InstallerError.unsafeExistingItem }
        let info = bundle.appendingPathComponent("Contents/Info.plist")
        let executable = bundle.appendingPathComponent("Contents/MacOS/slate-quota-collector")
        let marker = bundle.appendingPathComponent("Contents/Resources/.slate-quota-installation")
        guard try isOwnerRegularFile(info),
              try isOwnerExecutableRegularFile(executable),
              try isOwnerRegularFile(marker),
              try String(contentsOf: marker, encoding: .utf8) == Self.installationMarker,
              try String(contentsOf: info, encoding: .utf8) == Self.infoPlistTemplate else {
            throw InstallerError.unsafeExistingItem
        }
        return (status.st_dev, status.st_ino)
    }

    private func removeVerifiedBundle(at bundle: URL) throws {
        let expected = try verifyGeneratedBundle(at: bundle)
        let parent = bundle.deletingLastPathComponent()
        let parentDescriptor = open(
            parent.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
        )
        guard parentDescriptor >= 0 else { throw InstallerError.unsafeExistingItem }
        defer { _ = close(parentDescriptor) }
        if bundle.standardizedFileURL == paths.appBundleURL.standardizedFileURL {
            try beforeBundleQuarantine()
        }
        let quarantineName = ".slate-quota-remove-\(UUID().uuidString).private"
        guard renameatx_np(
            parentDescriptor, bundle.lastPathComponent,
            parentDescriptor, quarantineName, UInt32(RENAME_EXCL)
        ) == 0 else {
            throw InstallerError.unsafeExistingItem
        }
        let quarantine = parent.appendingPathComponent(quarantineName, isDirectory: true)
        let isolated: (device: dev_t, inode: ino_t)
        do {
            isolated = try verifyGeneratedBundle(at: quarantine)
            guard isolated.device == expected.device, isolated.inode == expected.inode else {
                throw InstallerError.unsafeExistingItem
            }
        } catch {
            _ = renameatx_np(
                parentDescriptor, quarantineName,
                parentDescriptor, bundle.lastPathComponent, UInt32(RENAME_EXCL)
            )
            throw error
        }
        // Once exact deletion begins, any partial failure remains quarantined;
        // a partially removed bundle is never restored onto the public path.
        try removeIsolatedExactBundle(parentDescriptor: parentDescriptor, name: quarantineName)
    }

    private func removeIsolatedExactBundle(parentDescriptor: Int32, name: String) throws {
        let bundle = openat(parentDescriptor, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard bundle >= 0 else { throw InstallerError.unsafeExistingItem }
        defer { _ = close(bundle) }
        let contents = openat(bundle, "Contents", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard contents >= 0 else { throw InstallerError.unsafeExistingItem }
        defer { _ = close(contents) }
        let macOS = openat(contents, "MacOS", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard macOS >= 0 else { throw InstallerError.unsafeExistingItem }
        defer { _ = close(macOS) }
        let resources = openat(contents, "Resources", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard resources >= 0 else { throw InstallerError.unsafeExistingItem }
        defer { _ = close(resources) }
        guard unlinkat(macOS, "slate-quota-collector", 0) == 0,
              unlinkat(resources, ".slate-quota-installation", 0) == 0,
              unlinkat(contents, "Info.plist", 0) == 0,
              unlinkat(contents, "MacOS", AT_REMOVEDIR) == 0,
              unlinkat(contents, "Resources", AT_REMOVEDIR) == 0,
              unlinkat(bundle, "Contents", AT_REMOVEDIR) == 0,
              unlinkat(parentDescriptor, name, AT_REMOVEDIR) == 0 else {
            throw InstallerError.ioFailure
        }
    }

    private func itemExists(_ url: URL) -> Bool {
        var status = stat()
        return lstat(url.path, &status) == 0
    }

    private func isOwnerRegularFile(_ url: URL) throws -> Bool {
        var status = stat()
        guard lstat(url.path, &status) == 0 else { return false }
        return status.st_mode & S_IFMT == S_IFREG && status.st_uid == getuid()
    }

    private func isOwnerExecutableRegularFile(_ url: URL) throws -> Bool {
        var status = stat()
        guard lstat(url.path, &status) == 0 else { return false }
        return status.st_mode & S_IFMT == S_IFREG
            && status.st_uid == getuid()
            && access(url.path, R_OK | X_OK) == 0
    }

    private func ensureAllowedRoot(_ url: URL) throws {
        guard url.path.hasPrefix("/") else { throw InstallerError.invalidPath }
        var status = stat()
        if lstat(url.path, &status) == 0 {
            guard status.st_mode & S_IFMT == S_IFDIR, status.st_uid == getuid() else {
                throw InstallerError.unsafeExistingItem
            }
            return
        }
        guard errno == ENOENT else { throw InstallerError.ioFailure }
        do {
            try FileManager.default.createDirectory(
                at: url, withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
        } catch { throw InstallerError.ioFailure }
        guard lstat(url.path, &status) == 0,
              status.st_mode & S_IFMT == S_IFDIR,
              status.st_uid == getuid(),
              chmod(url.path, S_IRWXU) == 0 else {
            throw InstallerError.unsafeExistingItem
        }
    }

    private func createAnchoredDirectory(_ url: URL, root: URL) throws {
        let root = root.standardizedFileURL
        let target = url.standardizedFileURL
        guard target.path == root.path || target.path.hasPrefix(root.path + "/") else {
            throw InstallerError.invalidPath
        }
        try ensureAllowedRoot(root)
        let relative = target.path == root.path
            ? []
            : target.path.dropFirst(root.path.count + 1).split(separator: "/").map(String.init)
        var descriptor = open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw InstallerError.unsafeExistingItem }
        defer { if descriptor >= 0 { _ = close(descriptor) } }
        for component in relative {
            guard component != ".", component != "..", !component.isEmpty else {
                throw InstallerError.invalidPath
            }
            if mkdirat(descriptor, component, S_IRWXU) != 0, errno != EEXIST {
                throw InstallerError.ioFailure
            }
            let next = openat(
                descriptor, component,
                O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
            )
            guard next >= 0 else { throw InstallerError.unsafeExistingItem }
            var status = stat()
            guard fstat(next, &status) == 0,
                  status.st_mode & S_IFMT == S_IFDIR,
                  status.st_uid == getuid(),
                  fchmod(next, S_IRWXU) == 0 else {
                _ = close(next)
                throw InstallerError.unsafeExistingItem
            }
            _ = close(descriptor)
            descriptor = next
        }
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
