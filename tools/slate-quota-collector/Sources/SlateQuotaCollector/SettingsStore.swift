import Darwin
import Foundation

enum SettingsStoreError: Error, Equatable, Sendable, CustomStringConvertible {
    case invalidSettings
    case invalidSchemaVersion
    case ioFailure

    var publicCode: String {
        switch self {
        case .invalidSettings: "settings_invalid"
        case .invalidSchemaVersion: "settings_schema"
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
    typealias Rename = @Sendable (_ source: String, _ destination: String) -> Int32

    let applicationSupportURL: URL
    private let rename: Rename

    init(
        applicationSupportURL: URL = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        )[0],
        rename: @escaping Rename = { Darwin.rename($0, $1) }
    ) {
        self.applicationSupportURL = applicationSupportURL
        self.rename = rename
    }

    var directoryURL: URL {
        applicationSupportURL.appendingPathComponent("SlateQuotaCollector", isDirectory: true)
    }

    var settingsURL: URL {
        directoryURL.appendingPathComponent("settings.json")
    }

    func load() throws -> CollectorSettings {
        guard FileManager.default.fileExists(atPath: settingsURL.path) else {
            return .enabled
        }

        let data: Data
        do {
            data = try Data(contentsOf: settingsURL)
        } catch {
            throw SettingsStoreError.ioFailure
        }
        return try decodeStrict(data)
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
        try atomicWrite(data)
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

    private func atomicWrite(_ data: Data) throws {
        let fileManager = FileManager.default
        do {
            try fileManager.createDirectory(
                at: directoryURL,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            try fileManager.setAttributes(
                [.posixPermissions: 0o700],
                ofItemAtPath: directoryURL.path
            )
        } catch {
            throw SettingsStoreError.ioFailure
        }

        let temporaryURL = directoryURL.appendingPathComponent(".settings-\(UUID().uuidString).tmp")
        defer { try? fileManager.removeItem(at: temporaryURL) }

        let descriptor = open(
            temporaryURL.path,
            O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC,
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
        guard writeAll(data, to: descriptor) else { throw SettingsStoreError.ioFailure }
        guard fsync(descriptor) == 0 else { throw SettingsStoreError.ioFailure }
        let closeStatus = close(descriptor)
        descriptorIsOpen = false
        guard closeStatus == 0 else { throw SettingsStoreError.ioFailure }

        guard rename(temporaryURL.path, settingsURL.path) == 0 else {
            throw SettingsStoreError.ioFailure
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
