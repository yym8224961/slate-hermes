import Foundation

enum ConfigurationError: Error, Equatable, Sendable {
    case invalidTopLevel
    case unexpectedField(String)
    case invalidSchemaVersion
    case invalidTimezone
    case invalidTimeouts
    case invalidConfiguration
}

struct CollectorConfiguration: Codable, Equatable, Sendable {
    let schemaVersion: Int
    let codexExecutablePath: String
    let timezoneIdentifier: String
    let codexTimeoutSeconds: Int
    let openCodeTimeoutSeconds: Int
    let slateTimeoutSeconds: Int
    let overallTimeoutSeconds: Int
    let logLevel: String
    let keychainService: String
    let openCodeKeyAccount: String
    let slateURLAccount: String

    static func decodeStrict(_ data: Data) throws -> Self {
        let object: Any
        do {
            object = try JSONSerialization.jsonObject(with: data)
        } catch {
            throw ConfigurationError.invalidTopLevel
        }
        guard let values = object as? [String: Any] else {
            throw ConfigurationError.invalidTopLevel
        }
        let allowed = Set([
            "schemaVersion", "codexExecutablePath", "timezoneIdentifier",
            "codexTimeoutSeconds", "openCodeTimeoutSeconds", "slateTimeoutSeconds",
            "overallTimeoutSeconds", "logLevel", "keychainService", "openCodeKeyAccount",
            "slateURLAccount",
        ])
        if let field = values.keys.first(where: { !allowed.contains($0) }) {
            throw ConfigurationError.unexpectedField(field)
        }
        let configuration: Self
        do {
            configuration = try JSONDecoder().decode(Self.self, from: data)
        } catch {
            throw ConfigurationError.invalidConfiguration
        }
        guard configuration.schemaVersion == 1 else { throw ConfigurationError.invalidSchemaVersion }
        guard configuration.timezoneIdentifier == "Asia/Shanghai",
              TimeZone(identifier: configuration.timezoneIdentifier) != nil else {
            throw ConfigurationError.invalidTimezone
        }
        guard configuration.codexTimeoutSeconds == 20,
              configuration.openCodeTimeoutSeconds == 10,
              configuration.slateTimeoutSeconds == 15,
              configuration.overallTimeoutSeconds == 45 else {
            throw ConfigurationError.invalidTimeouts
        }
        return configuration
    }
}

struct ConfigurationStore: Sendable {
    let applicationSupportURL: URL

    init(applicationSupportURL: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]) {
        self.applicationSupportURL = applicationSupportURL
    }

    var configurationURL: URL {
        applicationSupportURL.appendingPathComponent("SlateQuotaCollector", isDirectory: true).appendingPathComponent("config.json")
    }

    func save(_ configuration: CollectorConfiguration) throws {
        let directory = configurationURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let temporaryURL = directory.appendingPathComponent("config-\(UUID().uuidString).tmp")
        let data = try JSONEncoder().encode(configuration)
        try data.write(to: temporaryURL, options: .withoutOverwriting)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporaryURL.path)
        if FileManager.default.fileExists(atPath: configurationURL.path) {
            _ = try FileManager.default.replaceItemAt(configurationURL, withItemAt: temporaryURL)
        } else {
            try FileManager.default.moveItem(at: temporaryURL, to: configurationURL)
        }
    }

    func fileMode(at url: URL) throws -> Int {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard let value = attributes[.posixPermissions] as? NSNumber else {
            throw ConfigurationError.invalidConfiguration
        }
        return value.intValue
    }
}
