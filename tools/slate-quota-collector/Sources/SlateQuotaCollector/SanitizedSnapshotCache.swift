import Darwin
import Foundation

enum SnapshotCacheError: Error, Equatable, Sendable, CustomStringConvertible {
    case cacheCorrupt
    case ioFailure

    var publicCode: String {
        switch self {
        case .cacheCorrupt: "cache_corrupt"
        case .ioFailure: "cache_io"
        }
    }

    var description: String {
        "SnapshotCacheError(code: \(publicCode))"
    }
}

struct SanitizedSnapshotCache: SnapshotPersisting, Sendable {
    typealias Rename = @Sendable (_ source: String, _ destination: String) -> Int32

    let applicationSupportURL: URL
    private let sensitiveValueValidator: SensitiveValueValidator
    private let rename: Rename

    init(
        applicationSupportURL: URL = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        )[0],
        sensitiveValues: [String],
        rename: @escaping Rename = { Darwin.rename($0, $1) }
    ) {
        self.applicationSupportURL = applicationSupportURL
        sensitiveValueValidator = SensitiveValueValidator(sensitiveValues: sensitiveValues)
        self.rename = rename
    }

    var directoryURL: URL {
        applicationSupportURL.appendingPathComponent("SlateQuotaCollector", isDirectory: true)
    }

    var snapshotURL: URL {
        directoryURL.appendingPathComponent("snapshot-state.json")
    }

    func loadSnapshot() throws -> CollectorSnapshot {
        guard FileManager.default.fileExists(atPath: snapshotURL.path) else {
            return .empty
        }
        let data: Data
        do {
            data = try Data(contentsOf: snapshotURL)
        } catch {
            throw SnapshotCacheError.ioFailure
        }
        try sensitiveValueValidator.validate(data)
        return try CollectorSnapshot.decodeStrict(data)
    }

    func saveSnapshot(_ value: CollectorSnapshot) throws {
        let data = try encode(value)
        _ = try CollectorSnapshot.decodeStrict(data)
        try sensitiveValueValidator.validate(data)
        try atomicWrite(data, to: snapshotURL)
    }

    private func encode<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        do {
            return try encoder.encode(value)
        } catch {
            throw SnapshotCacheError.cacheCorrupt
        }
    }

    private func atomicWrite(_ data: Data, to destination: URL) throws {
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
            throw SnapshotCacheError.ioFailure
        }

        let temporary = directoryURL.appendingPathComponent(".snapshot-\(UUID().uuidString).tmp")
        defer { try? fileManager.removeItem(at: temporary) }

        let descriptor = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else { throw SnapshotCacheError.ioFailure }
        guard fchmod(descriptor, S_IRUSR | S_IWUSR) == 0 else {
            _ = close(descriptor)
            throw SnapshotCacheError.ioFailure
        }

        var writeSucceeded = true
        data.withUnsafeBytes { rawBuffer in
            guard var cursor = rawBuffer.baseAddress else { return }
            var remaining = rawBuffer.count
            while remaining > 0 {
                let count = Darwin.write(descriptor, cursor, remaining)
                if count <= 0 {
                    writeSucceeded = false
                    return
                }
                remaining -= count
                cursor = cursor.advanced(by: count)
            }
        }
        let syncStatus = fsync(descriptor)
        let closeStatus = close(descriptor)
        guard writeSucceeded, syncStatus == 0, closeStatus == 0 else {
            throw SnapshotCacheError.ioFailure
        }
        guard rename(temporary.path, destination.path) == 0 else {
            throw SnapshotCacheError.ioFailure
        }
    }
}

private struct SensitiveValueValidator: Sendable {
    private let sensitiveValues: [String]

    init(sensitiveValues: [String]) {
        self.sensitiveValues = sensitiveValues.filter { !$0.isEmpty }
    }

    func validate(_ data: Data) throws {
        let object: Any
        do {
            object = try JSONSerialization.jsonObject(with: data)
        } catch {
            throw SnapshotCacheError.cacheCorrupt
        }
        guard containsSensitiveValue(in: object) == false else {
            throw SnapshotCacheError.cacheCorrupt
        }
    }

    private func containsSensitiveValue(in value: Any) -> Bool {
        if let text = value as? String {
            return text.localizedCaseInsensitiveContains("authorization")
                || sensitiveValues.contains(where: text.contains)
        }
        if let dictionary = value as? [String: Any] {
            return dictionary.values.contains(where: containsSensitiveValue)
        }
        if let array = value as? [Any] {
            return array.contains(where: containsSensitiveValue)
        }
        return false
    }
}

extension SanitizedLastGood {
    static func decodeStrict(_ data: Data) throws -> Self {
        let object = try StrictSnapshotSchema.object(from: data)
        try StrictSnapshotSchema.requireKeys(
            object,
            allowed: ["schemaVersion", "codex", "openCodeGo"],
            required: ["schemaVersion"]
        )
        if let codex = object["codex"], !(codex is NSNull) {
            try StrictSnapshotSchema.validateSnapshot(codex, includesMonthly: false)
        }
        if let openCodeGo = object["openCodeGo"], !(openCodeGo is NSNull) {
            try StrictSnapshotSchema.validateSnapshot(openCodeGo, includesMonthly: true)
        }

        let value: Self = try StrictSnapshotSchema.decode(Self.self, from: data)
        guard value.schemaVersion == 1 else { throw SnapshotCacheError.cacheCorrupt }
        return value
    }
}

extension CollectorRuntimeState {
    static func decodeStrict(_ data: Data) throws -> Self {
        let object = try StrictSnapshotSchema.object(from: data)
        try StrictSnapshotSchema.requireKeys(
            object,
            allowed: [
                "schemaVersion", "codexFailures", "openCodeGoFailures",
                "simultaneousFailures", "lastSuccessAt", "lastPushAt",
                "providerStatuses", "lastErrorCodes",
            ],
            required: [
                "schemaVersion", "codexFailures", "openCodeGoFailures",
                "simultaneousFailures", "providerStatuses", "lastErrorCodes",
            ]
        )

        let value: Self = try StrictSnapshotSchema.decode(Self.self, from: data)
        guard value.schemaVersion == 1,
              value.codexFailures >= 0,
              value.openCodeGoFailures >= 0,
              value.simultaneousFailures >= 0 else {
            throw SnapshotCacheError.cacheCorrupt
        }
        try StrictSnapshotSchema.validateProviderKeys(value.providerStatuses.keys)
        try StrictSnapshotSchema.validateProviderKeys(value.lastErrorCodes.keys)
        guard value.lastErrorCodes.values.allSatisfy(StrictSnapshotSchema.isPublicErrorCode) else {
            throw SnapshotCacheError.cacheCorrupt
        }
        return value
    }
}

extension CollectorSnapshot {
    static func decodeStrict(_ data: Data) throws -> Self {
        let object = try StrictSnapshotSchema.object(from: data)
        try StrictSnapshotSchema.requireKeys(
            object,
            allowed: ["schemaVersion", "lastGood", "runtimeState"],
            required: ["schemaVersion", "lastGood", "runtimeState"]
        )
        guard let lastGoodObject = object["lastGood"],
              let runtimeObject = object["runtimeState"] else {
            throw SnapshotCacheError.cacheCorrupt
        }
        let lastGoodData: Data
        let runtimeData: Data
        do {
            lastGoodData = try JSONSerialization.data(withJSONObject: lastGoodObject)
            runtimeData = try JSONSerialization.data(withJSONObject: runtimeObject)
        } catch {
            throw SnapshotCacheError.cacheCorrupt
        }
        _ = try SanitizedLastGood.decodeStrict(lastGoodData)
        _ = try CollectorRuntimeState.decodeStrict(runtimeData)

        let value: Self = try StrictSnapshotSchema.decode(Self.self, from: data)
        guard value.schemaVersion == 1 else { throw SnapshotCacheError.cacheCorrupt }
        return value
    }
}

private enum StrictSnapshotSchema {
    private static let forbiddenKeys = Set([
        "authorization", "apikey", "token", "pushurl", "contentid",
        "ratelimits", "rollingusage",
    ])
    private static let providerKeys = Set(["codex", "opencode_go"])

    static func object(from data: Data) throws -> [String: Any] {
        let raw: Any
        do {
            raw = try JSONSerialization.jsonObject(with: data)
        } catch {
            throw SnapshotCacheError.cacheCorrupt
        }
        guard let object = raw as? [String: Any] else {
            throw SnapshotCacheError.cacheCorrupt
        }
        try rejectForbiddenKeys(in: object)
        return object
    }

    static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        do {
            return try decoder.decode(type, from: data)
        } catch {
            throw SnapshotCacheError.cacheCorrupt
        }
    }

    static func requireKeys(
        _ object: [String: Any],
        allowed: Set<String>,
        required: Set<String>
    ) throws {
        let actual = Set(object.keys)
        guard actual.isSubset(of: allowed), required.isSubset(of: actual) else {
            throw SnapshotCacheError.cacheCorrupt
        }
    }

    static func validateSnapshot(_ raw: Any, includesMonthly: Bool) throws {
        guard let snapshot = raw as? [String: Any] else {
            throw SnapshotCacheError.cacheCorrupt
        }
        var keys = Set([
            "status", "sourceCollectedAt", "headerLeft", "summaryLabel",
            "rolling", "weekly", "footerLeft", "footerRight",
        ])
        if includesMonthly { keys.insert("monthly") }
        try requireKeys(snapshot, allowed: keys, required: keys)
        try validateWindow(snapshot["rolling"])
        try validateWindow(snapshot["weekly"])
        if includesMonthly { try validateWindow(snapshot["monthly"]) }
    }

    static func validateProviderKeys<S: Sequence>(_ keys: S) throws where S.Element == String {
        guard Set(keys).isSubset(of: providerKeys) else {
            throw SnapshotCacheError.cacheCorrupt
        }
    }

    static func isPublicErrorCode(_ value: String) -> Bool {
        guard !value.isEmpty, value.count <= 64 else { return false }
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789_")
        return value.unicodeScalars.allSatisfy(allowed.contains)
    }

    private static func validateWindow(_ raw: Any?) throws {
        guard let window = raw as? [String: Any] else {
            throw SnapshotCacheError.cacheCorrupt
        }
        try requireKeys(
            window,
            allowed: ["label", "remainingPercent", "valueText", "resetAt"],
            required: ["label", "remainingPercent", "valueText"]
        )
    }

    private static func rejectForbiddenKeys(in value: Any) throws {
        if let dictionary = value as? [String: Any] {
            for (key, nested) in dictionary {
                let normalizedKey = key.lowercased().filter { $0.isLetter || $0.isNumber }
                if forbiddenKeys.contains(normalizedKey) {
                    throw SnapshotCacheError.cacheCorrupt
                }
                try rejectForbiddenKeys(in: nested)
            }
        } else if let array = value as? [Any] {
            for nested in array {
                try rejectForbiddenKeys(in: nested)
            }
        }
    }
}
