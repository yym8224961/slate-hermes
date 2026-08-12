import Darwin
import Foundation

enum SettingsStoreError: Error, Equatable, Sendable, CustomStringConvertible {
    case invalidSettings
    case invalidSchemaVersion
    case unsafePath
    case ioFailure

    var publicCode: String {
        switch self {
        case .invalidSettings: "settings_invalid"
        case .invalidSchemaVersion: "settings_schema"
        case .unsafePath: "settings_path"
        case .ioFailure: "settings_io"
        }
    }

    var description: String {
        "SettingsStoreError(code: \(publicCode))"
    }
}

struct CollectorSettings: Codable, Equatable, Sendable {
    let schemaVersion: Int
    let automaticCollectionEnabled: Bool

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case automaticCollectionEnabled = "automatic_collection_enabled"
    }

    static let enabled = Self(schemaVersion: 1, automaticCollectionEnabled: true)
}

protocol SettingsPersisting: Sendable {
    func load() throws -> CollectorSettings
    func save(_ value: CollectorSettings) throws
}

struct SettingsStore: SettingsPersisting, Sendable {
    typealias Rename = @Sendable (
        _ directoryDescriptor: Int32,
        _ sourceName: String,
        _ destinationName: String
    ) -> Int32
    typealias DirectorySync = @Sendable (_ directoryDescriptor: Int32) -> Int32
    typealias SettingsOpen = @Sendable (
        _ directoryDescriptor: Int32,
        _ name: String,
        _ flags: Int32
    ) -> Int32

    private static let settingsName = "settings.json"
    private static let maximumSettingsBytes = 4_096

    let applicationSupportURL: URL
    private let rename: Rename
    private let syncDirectory: DirectorySync
    private let openSettings: SettingsOpen

    init(
        applicationSupportURL: URL = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        )[0],
        rename: @escaping Rename = { directory, source, destination in
            renameat(directory, source, directory, destination)
        },
        syncDirectory: @escaping DirectorySync = { fsync($0) },
        openSettings: @escaping SettingsOpen = { openat($0, $1, $2) }
    ) {
        self.applicationSupportURL = applicationSupportURL
        self.rename = rename
        self.syncDirectory = syncDirectory
        self.openSettings = openSettings
    }

    var directoryURL: URL {
        SecureApplicationSupportDirectory.url(in: applicationSupportURL)
    }

    var settingsURL: URL {
        directoryURL.appendingPathComponent(Self.settingsName)
    }

    func load() throws -> CollectorSettings {
        let directory = try openDirectory()
        defer { _ = close(directory) }

        let descriptor = openSettings(
            directory,
            Self.settingsName,
            O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC
        )
        guard descriptor >= 0 else {
            if errno == ENOENT { return .enabled }
            throw SettingsStoreError.unsafePath
        }
        defer { _ = close(descriptor) }

        try validateOwnerOnlyRegularFile(descriptor, nonRegularError: .ioFailure)
        return try decodeStrict(readBounded(from: descriptor))
    }

    func save(_ value: CollectorSettings) throws {
        guard value.schemaVersion == 1 else {
            throw SettingsStoreError.invalidSchemaVersion
        }

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data: Data
        do {
            data = try encoder.encode(value)
        } catch {
            throw SettingsStoreError.invalidSettings
        }
        _ = try decodeStrict(data)

        let directory = try openDirectory()
        defer { _ = close(directory) }
        try atomicWrite(data, in: directory)
    }

    private func openDirectory() throws -> Int32 {
        do {
            return try SecureApplicationSupportDirectory.open(
                applicationSupportURL: applicationSupportURL,
                createIfMissing: true
            )
        } catch SecureApplicationSupportDirectory.Error.unsafePath {
            throw SettingsStoreError.unsafePath
        } catch {
            throw SettingsStoreError.ioFailure
        }
    }

    private func decodeStrict(_ data: Data) throws -> CollectorSettings {
        let object: Any
        do {
            object = try JSONSerialization.jsonObject(with: data)
        } catch {
            throw SettingsStoreError.invalidSettings
        }
        guard let dictionary = object as? [String: Any],
              Set(dictionary.keys) == ["schema_version", "automatic_collection_enabled"] else {
            throw SettingsStoreError.invalidSettings
        }

        let value: CollectorSettings
        do {
            value = try JSONDecoder().decode(CollectorSettings.self, from: data)
        } catch {
            throw SettingsStoreError.invalidSettings
        }
        guard value.schemaVersion == 1 else {
            throw SettingsStoreError.invalidSchemaVersion
        }
        return value
    }

    private func atomicWrite(_ data: Data, in directory: Int32) throws {
        try validateExistingSettingsEntry(in: directory)

        let temporaryName = ".settings-\(UUID().uuidString).tmp"
        defer { _ = unlinkat(directory, temporaryName, 0) }

        let descriptor = openat(
            directory,
            temporaryName,
            O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
            S_IRUSR | S_IWUSR
        )
        guard descriptor >= 0 else { throw SettingsStoreError.ioFailure }

        var descriptorIsOpen = true
        defer {
            if descriptorIsOpen { _ = close(descriptor) }
        }
        guard fchmod(descriptor, S_IRUSR | S_IWUSR) == 0 else {
            throw SettingsStoreError.ioFailure
        }
        try validateOwnerOnlyRegularFile(descriptor, nonRegularError: .unsafePath)
        guard writeAll(data, to: descriptor), fsync(descriptor) == 0 else {
            throw SettingsStoreError.ioFailure
        }
        let closeStatus = close(descriptor)
        descriptorIsOpen = false
        guard closeStatus == 0 else { throw SettingsStoreError.ioFailure }

        guard rename(directory, temporaryName, Self.settingsName) == 0 else {
            throw SettingsStoreError.ioFailure
        }
        // The new complete value is already visible if this durability barrier fails.
        guard syncDirectory(directory) == 0 else {
            throw SettingsStoreError.ioFailure
        }
    }

    private func validateExistingSettingsEntry(in directory: Int32) throws {
        var status = stat()
        guard fstatat(directory, Self.settingsName, &status, AT_SYMLINK_NOFOLLOW) == 0 else {
            if errno == ENOENT { return }
            throw SettingsStoreError.ioFailure
        }
        guard status.st_mode & S_IFMT == S_IFREG,
              status.st_uid == getuid(),
              status.st_mode & 0o777 == 0o600,
              status.st_nlink == 1 else {
            throw SettingsStoreError.unsafePath
        }
    }

    private func validateOwnerOnlyRegularFile(
        _ descriptor: Int32,
        nonRegularError: SettingsStoreError
    ) throws {
        var status = stat()
        guard fstat(descriptor, &status) == 0 else { throw SettingsStoreError.ioFailure }
        guard status.st_mode & S_IFMT == S_IFREG else { throw nonRegularError }
        guard status.st_uid == getuid(),
              status.st_mode & 0o777 == 0o600,
              status.st_nlink == 1 else {
            throw SettingsStoreError.unsafePath
        }
    }

    private func readBounded(from descriptor: Int32) throws -> Data {
        var result = Data()
        var buffer = [UInt8](repeating: 0, count: 1_024)
        while true {
            let count = buffer.withUnsafeMutableBytes { Darwin.read(descriptor, $0.baseAddress, $0.count) }
            if count < 0 {
                if errno == EINTR { continue }
                throw SettingsStoreError.ioFailure
            }
            if count == 0 { return result }
            guard result.count + count <= Self.maximumSettingsBytes else {
                throw SettingsStoreError.invalidSettings
            }
            result.append(contentsOf: buffer.prefix(count))
        }
    }

    private func writeAll(_ data: Data, to descriptor: Int32) -> Bool {
        data.withUnsafeBytes { rawBuffer in
            guard var cursor = rawBuffer.baseAddress else { return true }
            var remaining = rawBuffer.count
            while remaining > 0 {
                let count = Darwin.write(descriptor, cursor, remaining)
                if count < 0 {
                    if errno == EINTR { continue }
                    return false
                }
                guard count > 0 else { return false }
                cursor = cursor.advanced(by: count)
                remaining -= count
            }
            return true
        }
    }
}

enum SecureApplicationSupportDirectory {
    enum Error: Swift.Error {
        case unsafePath
        case ioFailure
    }

    private static let directoryName = "SlateQuotaCollector"

    static func url(in applicationSupportURL: URL) -> URL {
        applicationSupportURL.appendingPathComponent(directoryName, isDirectory: true)
    }

    static func open(applicationSupportURL: URL, createIfMissing: Bool) throws -> Int32 {
        let rootDescriptor = Darwin.open(
            applicationSupportURL.path,
            O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
        )
        guard rootDescriptor >= 0 else {
            throw errno == ELOOP || errno == ENOTDIR ? Error.unsafePath : Error.ioFailure
        }
        defer { _ = close(rootDescriptor) }

        var rootStatus = stat()
        guard fstat(rootDescriptor, &rootStatus) == 0 else { throw Error.ioFailure }
        guard rootStatus.st_mode & S_IFMT == S_IFDIR,
              rootStatus.st_uid == geteuid(),
              rootStatus.st_nlink >= 1 else {
            throw Error.unsafePath
        }

        if createIfMissing, mkdirat(rootDescriptor, directoryName, S_IRWXU) != 0, errno != EEXIST {
            throw Error.ioFailure
        }

        let descriptor = openat(
            rootDescriptor,
            directoryName,
            O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
        )
        guard descriptor >= 0 else {
            throw errno == ELOOP || errno == ENOTDIR ? Error.unsafePath : Error.ioFailure
        }

        var status = stat()
        guard fstat(descriptor, &status) == 0 else {
            _ = close(descriptor)
            throw Error.ioFailure
        }
        guard status.st_mode & S_IFMT == S_IFDIR,
              status.st_uid == getuid(),
              status.st_mode & 0o777 == 0o700,
              status.st_nlink >= 1 else {
            _ = close(descriptor)
            throw Error.unsafePath
        }
        return descriptor
    }
}
