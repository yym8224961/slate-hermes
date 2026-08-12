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

    var infoPlistURL: URL { appBundleURL.appendingPathComponent("Contents/Info.plist") }

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

/// Owns the exact directory inode used for installer mutations. All leaf work is
/// performed relative to this descriptor; the public path is used only for an
/// identity check before the first mutation.
final class InstallerDirectoryHandle: @unchecked Sendable {
    let descriptor: Int32
    let publicURL: URL
    private let device: dev_t
    private let inode: ino_t

    init(descriptor: Int32, publicURL: URL, status: stat) {
        self.descriptor = descriptor
        self.publicURL = publicURL
        device = status.st_dev
        inode = status.st_ino
    }

    deinit { _ = close(descriptor) }

    func requirePublicIdentity() throws {
        var current = stat()
        guard lstat(publicURL.path, &current) == 0,
              current.st_mode & S_IFMT == S_IFDIR,
              current.st_dev == device,
              current.st_ino == inode else {
            throw InstallerError.unsafeExistingItem
        }
    }
}

enum InstallerFileSystem {
    static func openDirectory(
        _ targetURL: URL,
        allowedRoot rootURL: URL,
        createMissing: Bool,
        appOwnedLeaf: Bool
    ) throws -> InstallerDirectoryHandle? {
        // macOS exposes trusted system aliases such as /var -> /private/var.
        // Resolve the longest existing prefix before opening descriptors, then
        // append only the missing fixed components. Foundation otherwise leaves
        // /var unresolved whenever the leaf does not exist yet.
        let targetPath = try canonicalPathPreservingResolvedAliases(targetURL)
        let rootPath = try canonicalPathPreservingResolvedAliases(rootURL)
        guard targetPath.hasPrefix("/"), rootPath.hasPrefix("/"),
              targetPath == rootPath || targetPath.hasPrefix(rootPath + "/") else {
            throw InstallerError.invalidPath
        }
        let targetComponents = targetPath.split(separator: "/").map(String.init)
        let rootComponents = rootPath.split(separator: "/").map(String.init)
        guard Array(targetComponents.prefix(rootComponents.count)) == rootComponents else {
            throw InstallerError.invalidPath
        }

        var descriptor = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw InstallerError.ioFailure }
        var finalStatus = stat()
        for (index, component) in targetComponents.enumerated() {
            guard component != ".", component != "..", !component.isEmpty else {
                _ = close(descriptor)
                throw InstallerError.invalidPath
            }
            var created = false
            var next = openat(
                descriptor, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
            )
            if next < 0, errno == ENOENT, createMissing {
                guard mkdirat(descriptor, component, S_IRWXU) == 0 || errno == EEXIST else {
                    _ = close(descriptor)
                    throw InstallerError.ioFailure
                }
                created = true
                next = openat(
                    descriptor, component,
                    O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
                )
            }
            if next < 0 {
                let missing = errno == ENOENT
                _ = close(descriptor)
                if missing, !createMissing { return nil }
                throw InstallerError.unsafeExistingItem
            }
            var status = stat()
            let insideAllowedRoot = index >= rootComponents.count - 1
            guard fstat(next, &status) == 0,
                  status.st_mode & S_IFMT == S_IFDIR,
                  (!insideAllowedRoot || status.st_uid == getuid()) else {
                _ = close(next)
                _ = close(descriptor)
                throw InstallerError.unsafeExistingItem
            }
            let isLeaf = index == targetComponents.count - 1
            if created || (isLeaf && appOwnedLeaf) {
                guard fchmod(next, S_IRWXU) == 0 else {
                    _ = close(next)
                    _ = close(descriptor)
                    throw InstallerError.ioFailure
                }
            }
            _ = close(descriptor)
            descriptor = next
            finalStatus = status
        }
        return InstallerDirectoryHandle(
            descriptor: descriptor,
            publicURL: URL(fileURLWithPath: targetPath, isDirectory: true),
            status: finalStatus
        )
    }

    static func exists(_ directory: InstallerDirectoryHandle, name: String) throws -> Bool {
        try validateName(name)
        var status = stat()
        if fstatat(directory.descriptor, name, &status, AT_SYMLINK_NOFOLLOW) == 0 { return true }
        if errno == ENOENT { return false }
        throw InstallerError.ioFailure
    }

    static func readRegularFile(
        _ directory: InstallerDirectoryHandle,
        name: String,
        executable: Bool = false
    ) throws -> Data {
        try readRegularFile(directory.descriptor, name: name, executable: executable)
    }

    static func readRegularFile(
        _ descriptor: Int32,
        name: String,
        executable: Bool = false
    ) throws -> Data {
        try validateName(name)
        let file = openat(descriptor, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard file >= 0 else { throw InstallerError.unsafeExistingItem }
        defer { _ = close(file) }
        var status = stat()
        guard fstat(file, &status) == 0,
              status.st_mode & S_IFMT == S_IFREG,
              status.st_uid == getuid(),
              status.st_nlink == 1,
              !executable || status.st_mode & (S_IXUSR | S_IXGRP | S_IXOTH) != 0 else {
            throw InstallerError.unsafeExistingItem
        }
        var output = Data()
        var buffer = [UInt8](repeating: 0, count: 16_384)
        while true {
            let count = Darwin.read(file, &buffer, buffer.count)
            if count == 0 { break }
            if count < 0 {
                if errno == EINTR { continue }
                throw InstallerError.ioFailure
            }
            output.append(buffer, count: count)
        }
        return output
    }

    static func atomicWrite(
        _ data: Data,
        to directory: InstallerDirectoryHandle,
        name: String,
        mode: mode_t
    ) throws {
        try validateName(name)
        let temporary = ".slate-install-\(UUID().uuidString).tmp"
        let file = openat(
            directory.descriptor, temporary,
            O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode
        )
        guard file >= 0 else { throw InstallerError.ioFailure }
        var fileOpen = true
        defer {
            if fileOpen { _ = close(file) }
            _ = unlinkat(directory.descriptor, temporary, 0)
        }
        do {
            try writeAll(data, descriptor: file)
            guard fchmod(file, mode) == 0, fsync(file) == 0 else {
                throw InstallerError.ioFailure
            }
            _ = close(file)
            fileOpen = false
            if try exists(directory, name: name) {
                _ = try readRegularFile(directory, name: name)
            }
            guard renameat(
                directory.descriptor, temporary, directory.descriptor, name
            ) == 0, fsync(directory.descriptor) == 0 else {
                throw InstallerError.ioFailure
            }
        } catch let error as InstallerError { throw error }
        catch { throw InstallerError.ioFailure }
    }

    static func ensureOwnerOnlyLog(
        _ directory: InstallerDirectoryHandle, name: String
    ) throws {
        try validateName(name)
        let file = openat(
            directory.descriptor, name,
            O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW | O_CLOEXEC,
            S_IRUSR | S_IWUSR
        )
        guard file >= 0 else { throw InstallerError.ioFailure }
        defer { _ = close(file) }
        var status = stat()
        guard fstat(file, &status) == 0,
              status.st_mode & S_IFMT == S_IFREG,
              status.st_uid == getuid(), status.st_nlink == 1,
              fchmod(file, S_IRUSR | S_IWUSR) == 0,
              fsync(file) == 0,
              fsync(directory.descriptor) == 0 else {
            throw InstallerError.unsafeExistingItem
        }
    }

    static func unlinkRegularFile(
        _ directory: InstallerDirectoryHandle,
        name: String,
        expected: Data? = nil
    ) throws {
        guard try exists(directory, name: name) else { return }
        let actual = try readRegularFile(directory, name: name)
        if let expected, actual != expected { throw InstallerError.unsafeExistingItem }
        guard unlinkat(directory.descriptor, name, 0) == 0,
              fsync(directory.descriptor) == 0 else {
            throw InstallerError.ioFailure
        }
    }

    static func openChildDirectory(_ descriptor: Int32, name: String) throws -> Int32 {
        try validateName(name)
        let child = openat(
            descriptor, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
        )
        guard child >= 0 else { throw InstallerError.unsafeExistingItem }
        var status = stat()
        guard fstat(child, &status) == 0,
              status.st_mode & S_IFMT == S_IFDIR,
              status.st_uid == getuid() else {
            _ = close(child)
            throw InstallerError.unsafeExistingItem
        }
        return child
    }

    static func names(in descriptor: Int32) throws -> Set<String> {
        let duplicate = dup(descriptor)
        guard duplicate >= 0, let stream = fdopendir(duplicate) else {
            if duplicate >= 0 { _ = close(duplicate) }
            throw InstallerError.ioFailure
        }
        defer { closedir(stream) }
        var result = Set<String>()
        while let entry = readdir(stream) {
            let name = withUnsafePointer(to: entry.pointee.d_name) { pointer in
                pointer.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) {
                    String(cString: $0)
                }
            }
            if name != ".", name != ".." { result.insert(name) }
        }
        return result
    }

    static func writeAll(_ data: Data, descriptor: Int32) throws {
        try data.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return }
            var offset = 0
            while offset < raw.count {
                let written = Darwin.write(descriptor, base.advanced(by: offset), raw.count - offset)
                if written < 0 {
                    if errno == EINTR { continue }
                    throw InstallerError.ioFailure
                }
                offset += written
            }
        }
    }

    static func validateName(_ name: String) throws {
        guard !name.isEmpty, name != ".", name != "..", !name.contains("/") else {
            throw InstallerError.invalidPath
        }
    }

    private static func canonicalPathPreservingResolvedAliases(_ input: URL) throws -> String {
        var probe = input.standardizedFileURL
        guard probe.path.hasPrefix("/") else { throw InstallerError.invalidPath }
        var missing: [String] = []
        while true {
            var status = stat()
            if lstat(probe.path, &status) == 0 { break }
            guard errno == ENOENT, probe.path != "/" else {
                throw InstallerError.unsafeExistingItem
            }
            missing.insert(probe.lastPathComponent, at: 0)
            probe.deleteLastPathComponent()
        }
        let resolvedPointer = probe.withUnsafeFileSystemRepresentation { path in
            path.flatMap { realpath($0, nil) }
        }
        guard let resolvedPointer else { throw InstallerError.unsafeExistingItem }
        defer { free(resolvedPointer) }
        // Do not wrap the realpath string in URL.standardizedFileURL: on macOS
        // Foundation rewrites `/private/var` back to the public `/var` symlink,
        // which a no-follow descriptor walker must correctly refuse.
        var result = String(cString: resolvedPointer)
        for component in missing {
            try validateName(component)
            if result != "/" { result += "/" }
            result += component
        }
        return result
    }
}

private struct BundleManifest {
    var temporaryDirectory = false
    var contentsDirectory = false
    var macOSDirectory = false
    var resourcesDirectory = false
    var executable = false
    var infoPlist = false
    var marker = false
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
    private let afterBundleConstructionStep: @Sendable (Int) throws -> Void
    private let afterStableDirectoryOpen: @Sendable () throws -> Void

    init(
        paths: InstallationPaths = .init(),
        beforeBundlePublish: @escaping @Sendable () throws -> Void = {},
        beforeStablePublish: @escaping @Sendable () throws -> Void = {},
        beforeBundleQuarantine: @escaping @Sendable () throws -> Void = {},
        afterBundleConstructionStep: @escaping @Sendable (Int) throws -> Void = { _ in },
        afterStableDirectoryOpen: @escaping @Sendable () throws -> Void = {}
    ) {
        self.paths = paths
        self.beforeBundlePublish = beforeBundlePublish
        self.beforeStablePublish = beforeStablePublish
        self.beforeBundleQuarantine = beforeBundleQuarantine
        self.afterBundleConstructionStep = afterBundleConstructionStep
        self.afterStableDirectoryOpen = afterStableDirectoryOpen
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
        let bundle = try captureBundleExecutable()
        let stable = try captureStableExecutable(matching: bundle)
        return AppBundleGeneration(bundleExecutable: bundle, stableExecutable: stable)
    }

    func restore(_ generation: AppBundleGeneration) throws {
        if let stable = generation.stableExecutable,
           stable != generation.bundleExecutable {
            throw InstallerError.unsafeExistingItem
        }
        if let bundle = generation.bundleExecutable {
            try publishBundle(executableData: bundle)
        } else {
            try removePublicBundleIfPresent()
        }
        let stableParent = try openStableParent(createMissing: generation.stableExecutable != nil)
        if let data = generation.stableExecutable, let stableParent {
            try InstallerFileSystem.atomicWrite(
                data, to: stableParent, name: paths.stableExecutableURL.lastPathComponent,
                mode: S_IRWXU
            )
        } else if let stableParent {
            try InstallerFileSystem.unlinkRegularFile(
                stableParent, name: paths.stableExecutableURL.lastPathComponent
            )
        }
    }

    func removeInstalledArtifacts() throws {
        let previous = try captureGeneration()
        let stableParent = try openStableParent(createMissing: false)
        do {
            try removePublicBundleIfPresent()
            if let stableParent, let stable = previous.stableExecutable {
                try InstallerFileSystem.unlinkRegularFile(
                    stableParent, name: paths.stableExecutableURL.lastPathComponent,
                    expected: stable
                )
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
            guard let stableParent = try openStableParent(createMissing: true) else {
                throw InstallerError.ioFailure
            }
            try afterStableDirectoryOpen()
            try stableParent.requirePublicIdentity()
            try beforeStablePublish()
            try InstallerFileSystem.atomicWrite(
                executableData, to: stableParent,
                name: paths.stableExecutableURL.lastPathComponent, mode: S_IRWXU
            )
        } catch {
            try? restore(previous)
            throw error
        }
    }

    private func publishBundle(executableData: Data) throws {
        guard let applications = try openApplications(createMissing: true) else {
            throw InstallerError.ioFailure
        }
        let bundleName = paths.appBundleURL.lastPathComponent
        let hadPrevious = try InstallerFileSystem.exists(applications, name: bundleName)
        if hadPrevious { _ = try verifyBundle(parent: applications, name: bundleName) }
        let token = UUID().uuidString
        let temporary = ".slate-quota-bundle-\(token).tmp"
        let backup = ".slate-quota-bundle-\(token).backup"
        var manifest = BundleManifest()
        var backupExists = false
        var newPublished = false
        do {
            guard mkdirat(applications.descriptor, temporary, S_IRWXU) == 0 else {
                throw InstallerError.ioFailure
            }
            manifest.temporaryDirectory = true
            try afterBundleConstructionStep(1)
            let temporaryFD = try InstallerFileSystem.openChildDirectory(
                applications.descriptor, name: temporary
            )
            defer { _ = close(temporaryFD) }
            guard mkdirat(temporaryFD, "Contents", S_IRWXU) == 0 else {
                throw InstallerError.ioFailure
            }
            manifest.contentsDirectory = true
            try afterBundleConstructionStep(2)
            let contents = try InstallerFileSystem.openChildDirectory(temporaryFD, name: "Contents")
            defer { _ = close(contents) }
            guard mkdirat(contents, "MacOS", S_IRWXU) == 0 else {
                throw InstallerError.ioFailure
            }
            manifest.macOSDirectory = true
            try afterBundleConstructionStep(3)
            guard mkdirat(contents, "Resources", S_IRWXU) == 0 else {
                throw InstallerError.ioFailure
            }
            manifest.resourcesDirectory = true
            try afterBundleConstructionStep(4)
            let macOS = try InstallerFileSystem.openChildDirectory(contents, name: "MacOS")
            defer { _ = close(macOS) }
            let resources = try InstallerFileSystem.openChildDirectory(contents, name: "Resources")
            defer { _ = close(resources) }
            try writeNewFile(
                executableData, descriptor: macOS, name: "slate-quota-collector", mode: S_IRWXU
            )
            manifest.executable = true
            try afterBundleConstructionStep(5)
            guard let info = Self.infoPlistTemplate.data(using: .utf8),
                  let marker = Self.installationMarker.data(using: .utf8) else {
                throw InstallerError.ioFailure
            }
            _ = try PropertyListSerialization.propertyList(from: info, options: [], format: nil)
            try writeNewFile(info, descriptor: contents, name: "Info.plist", mode: S_IRUSR | S_IWUSR)
            manifest.infoPlist = true
            try afterBundleConstructionStep(6)
            try writeNewFile(
                marker, descriptor: resources, name: ".slate-quota-installation",
                mode: S_IRUSR | S_IWUSR
            )
            manifest.marker = true
            try afterBundleConstructionStep(7)
            guard fsync(macOS) == 0, fsync(resources) == 0,
                  fsync(contents) == 0, fsync(temporaryFD) == 0 else {
                throw InstallerError.ioFailure
            }
            _ = try verifyBundle(parent: applications, name: temporary)
            try beforeBundlePublish()
            try applications.requirePublicIdentity()
            if hadPrevious {
                guard renameat(
                    applications.descriptor, bundleName,
                    applications.descriptor, backup
                ) == 0 else { throw InstallerError.ioFailure }
                backupExists = true
                try afterBundleConstructionStep(8)
            }
            guard renameat(
                applications.descriptor, temporary,
                applications.descriptor, bundleName
            ) == 0 else { throw InstallerError.ioFailure }
            manifest.temporaryDirectory = false
            newPublished = true
            guard fsync(applications.descriptor) == 0 else { throw InstallerError.ioFailure }
            if backupExists {
                try removeExactBundle(parent: applications, name: backup)
                backupExists = false
            }
        } catch {
            if newPublished, backupExists {
                try? removeExactBundle(parent: applications, name: bundleName)
                if renameat(
                    applications.descriptor, backup,
                    applications.descriptor, bundleName
                ) == 0 { backupExists = false }
            } else if backupExists {
                if renameat(
                    applications.descriptor, backup,
                    applications.descriptor, bundleName
                ) == 0 { backupExists = false }
            }
            if manifest.temporaryDirectory {
                try? removePartialBundle(
                    parent: applications, name: temporary, manifest: manifest
                )
            }
            if backupExists { try? removeExactBundle(parent: applications, name: backup) }
            throw error
        }
    }

    private func captureBundleExecutable() throws -> Data? {
        guard let applications = try openApplications(createMissing: false) else { return nil }
        let name = paths.appBundleURL.lastPathComponent
        guard try InstallerFileSystem.exists(applications, name: name) else { return nil }
        return try verifyBundle(parent: applications, name: name).executable
    }

    private func captureStableExecutable(matching bundle: Data?) throws -> Data? {
        guard let parent = try openStableParent(createMissing: false) else { return nil }
        let name = paths.stableExecutableURL.lastPathComponent
        guard try InstallerFileSystem.exists(parent, name: name) else { return nil }
        let stable = try InstallerFileSystem.readRegularFile(parent, name: name, executable: true)
        guard let bundle, stable == bundle else { throw InstallerError.unsafeExistingItem }
        return stable
    }

    private func verifyBundle(
        parent: InstallerDirectoryHandle, name: String
    ) throws -> (device: dev_t, inode: ino_t, executable: Data) {
        let bundle = try InstallerFileSystem.openChildDirectory(parent.descriptor, name: name)
        defer { _ = close(bundle) }
        var status = stat()
        guard fstat(bundle, &status) == 0,
              try InstallerFileSystem.names(in: bundle) == ["Contents"] else {
            throw InstallerError.unsafeExistingItem
        }
        let contents = try InstallerFileSystem.openChildDirectory(bundle, name: "Contents")
        defer { _ = close(contents) }
        guard try InstallerFileSystem.names(in: contents) == ["Info.plist", "MacOS", "Resources"] else {
            throw InstallerError.unsafeExistingItem
        }
        let macOS = try InstallerFileSystem.openChildDirectory(contents, name: "MacOS")
        defer { _ = close(macOS) }
        let resources = try InstallerFileSystem.openChildDirectory(contents, name: "Resources")
        defer { _ = close(resources) }
        guard try InstallerFileSystem.names(in: macOS) == ["slate-quota-collector"],
              try InstallerFileSystem.names(in: resources) == [".slate-quota-installation"] else {
            throw InstallerError.unsafeExistingItem
        }
        let executable = try InstallerFileSystem.readRegularFile(
            macOS, name: "slate-quota-collector", executable: true
        )
        let info = try InstallerFileSystem.readRegularFile(contents, name: "Info.plist")
        let marker = try InstallerFileSystem.readRegularFile(
            resources, name: ".slate-quota-installation"
        )
        guard info == Data(Self.infoPlistTemplate.utf8),
              marker == Data(Self.installationMarker.utf8) else {
            throw InstallerError.unsafeExistingItem
        }
        return (status.st_dev, status.st_ino, executable)
    }

    private func removePublicBundleIfPresent() throws {
        guard let applications = try openApplications(createMissing: false) else { return }
        let bundleName = paths.appBundleURL.lastPathComponent
        guard try InstallerFileSystem.exists(applications, name: bundleName) else { return }
        let expected = try verifyBundle(parent: applications, name: bundleName)
        try beforeBundleQuarantine()
        try applications.requirePublicIdentity()
        var current = stat()
        guard fstatat(
            applications.descriptor, bundleName, &current, AT_SYMLINK_NOFOLLOW
        ) == 0,
        current.st_dev == expected.device, current.st_ino == expected.inode else {
            throw InstallerError.unsafeExistingItem
        }
        let quarantine = ".slate-quota-remove-\(UUID().uuidString).private"
        guard renameatx_np(
            applications.descriptor, bundleName,
            applications.descriptor, quarantine, UInt32(RENAME_EXCL)
        ) == 0 else { throw InstallerError.unsafeExistingItem }
        do {
            let isolated = try verifyBundle(parent: applications, name: quarantine)
            guard isolated.device == expected.device, isolated.inode == expected.inode else {
                throw InstallerError.unsafeExistingItem
            }
            try removeExactBundle(parent: applications, name: quarantine)
        } catch {
            _ = renameatx_np(
                applications.descriptor, quarantine,
                applications.descriptor, bundleName, UInt32(RENAME_EXCL)
            )
            throw error
        }
    }

    private func removeExactBundle(
        parent: InstallerDirectoryHandle, name: String
    ) throws {
        _ = try verifyBundle(parent: parent, name: name)
        let bundle = try InstallerFileSystem.openChildDirectory(parent.descriptor, name: name)
        defer { _ = close(bundle) }
        let contents = try InstallerFileSystem.openChildDirectory(bundle, name: "Contents")
        defer { _ = close(contents) }
        let macOS = try InstallerFileSystem.openChildDirectory(contents, name: "MacOS")
        defer { _ = close(macOS) }
        let resources = try InstallerFileSystem.openChildDirectory(contents, name: "Resources")
        defer { _ = close(resources) }
        guard unlinkat(macOS, "slate-quota-collector", 0) == 0,
              unlinkat(resources, ".slate-quota-installation", 0) == 0,
              unlinkat(contents, "Info.plist", 0) == 0,
              unlinkat(contents, "MacOS", AT_REMOVEDIR) == 0,
              unlinkat(contents, "Resources", AT_REMOVEDIR) == 0,
              unlinkat(bundle, "Contents", AT_REMOVEDIR) == 0,
              unlinkat(parent.descriptor, name, AT_REMOVEDIR) == 0,
              fsync(parent.descriptor) == 0 else {
            throw InstallerError.ioFailure
        }
    }

    private func removePartialBundle(
        parent: InstallerDirectoryHandle, name: String, manifest: BundleManifest
    ) throws {
        guard manifest.temporaryDirectory else { return }
        let bundle = try InstallerFileSystem.openChildDirectory(parent.descriptor, name: name)
        defer { _ = close(bundle) }
        var contents: Int32 = -1
        var macOS: Int32 = -1
        var resources: Int32 = -1
        if manifest.contentsDirectory {
            contents = try InstallerFileSystem.openChildDirectory(bundle, name: "Contents")
        }
        defer { if contents >= 0 { _ = close(contents) } }
        if manifest.macOSDirectory {
            macOS = try InstallerFileSystem.openChildDirectory(contents, name: "MacOS")
        }
        defer { if macOS >= 0 { _ = close(macOS) } }
        if manifest.resourcesDirectory {
            resources = try InstallerFileSystem.openChildDirectory(contents, name: "Resources")
        }
        defer { if resources >= 0 { _ = close(resources) } }
        if manifest.executable { _ = unlinkat(macOS, "slate-quota-collector", 0) }
        if manifest.marker { _ = unlinkat(resources, ".slate-quota-installation", 0) }
        if manifest.infoPlist { _ = unlinkat(contents, "Info.plist", 0) }
        if manifest.macOSDirectory { _ = unlinkat(contents, "MacOS", AT_REMOVEDIR) }
        if manifest.resourcesDirectory { _ = unlinkat(contents, "Resources", AT_REMOVEDIR) }
        if manifest.contentsDirectory { _ = unlinkat(bundle, "Contents", AT_REMOVEDIR) }
        guard unlinkat(parent.descriptor, name, AT_REMOVEDIR) == 0,
              fsync(parent.descriptor) == 0 else {
            throw InstallerError.ioFailure
        }
    }

    private func writeNewFile(
        _ data: Data, descriptor: Int32, name: String, mode: mode_t
    ) throws {
        let file = openat(
            descriptor, name,
            O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode
        )
        guard file >= 0 else { throw InstallerError.ioFailure }
        defer { _ = close(file) }
        try InstallerFileSystem.writeAll(data, descriptor: file)
        guard fchmod(file, mode) == 0, fsync(file) == 0, fsync(descriptor) == 0 else {
            throw InstallerError.ioFailure
        }
    }

    private func openApplications(createMissing: Bool) throws -> InstallerDirectoryHandle? {
        try InstallerFileSystem.openDirectory(
            paths.appBundleURL.deletingLastPathComponent(),
            allowedRoot: paths.homeDirectory,
            createMissing: createMissing,
            appOwnedLeaf: false
        )
    }

    private func openStableParent(createMissing: Bool) throws -> InstallerDirectoryHandle? {
        try InstallerFileSystem.openDirectory(
            paths.stableExecutableURL.deletingLastPathComponent(),
            allowedRoot: paths.applicationSupportURL,
            createMissing: createMissing,
            appOwnedLeaf: true
        )
    }

    private func isOwnerExecutableRegularFile(_ url: URL) throws -> Bool {
        var status = stat()
        guard lstat(url.path, &status) == 0 else { return false }
        return status.st_mode & S_IFMT == S_IFREG
            && status.st_uid == getuid()
            && access(url.path, R_OK | X_OK) == 0
    }
}
