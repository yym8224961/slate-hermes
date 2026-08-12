import Foundation
import Security
import Testing
@testable import SlateQuotaCollector

@Suite struct SecretCacheAndLoggingTests {
    @Test func keychainRoundTripUsesGenericPasswordServiceAccountAndAfterFirstUnlock() throws {
        let backend = RecordingKeychainBackend()
        let store = KeychainStore(
            service: "com.yym8224961.slate-quota-collector",
            backend: backend
        )

        try store.write("go-test-secret", account: "opencode-go-api-key")

        #expect(try store.read(account: "opencode-go-api-key") == "go-test-secret")
        let query = try #require(backend.lastQuery)
        #expect((query[kSecClass as String] as? String) == (kSecClassGenericPassword as String))
        #expect(query[kSecAttrService as String] as? String == "com.yym8224961.slate-quota-collector")
        #expect(query[kSecAttrAccount as String] as? String == "opencode-go-api-key")
        #expect((backend.lastAttributes?[kSecAttrAccessible as String] as? String) == (kSecAttrAccessibleAfterFirstUnlock as String))
    }

    @Test func keychainUpdatesExistingItemBeforeAdding() throws {
        let backend = RecordingKeychainBackend()
        let store = KeychainStore(
            service: "com.yym8224961.slate-quota-collector",
            backend: backend
        )
        try store.write("first-test-secret", account: "opencode-go-api-key")

        try store.write("second-test-secret", account: "opencode-go-api-key")

        #expect(backend.updateCount == 2)
        #expect(backend.addCount == 1)
        #expect(try store.read(account: "opencode-go-api-key") == "second-test-secret")
    }

    @Test func keychainErrorsExposeOnlyOSStatus() throws {
        let backend = RecordingKeychainBackend(forcedReadStatus: errSecAuthFailed)
        let store = KeychainStore(
            service: "com.yym8224961.slate-quota-collector",
            backend: backend
        )

        do {
            _ = try store.read(account: "opencode-go-api-key")
            Issue.record("Expected a KeychainError")
        } catch let error as KeychainError {
            #expect(error.status == errSecAuthFailed)
            #expect(String(describing: error).contains("opencode-go-api-key") == false)
            #expect(String(describing: error).contains("go-test-secret") == false)
        }
    }

    @Test func cacheAndLogsNeverContainKnownSecretsAuthorizationURLContentIDOrRawBody() throws {
        let sink = StringLogSink()
        let capabilityURL = "https://slate.local/api/v1/contents/secret-id/data"
        let logger = RedactingLogger(
            sink: sink,
            secrets: ["go-test-secret", capabilityURL]
        )
        logger.error(
            code: "push_failed",
            detail: #"Authorization: Bearer go-test-secret at https://slate.local/api/v1/contents/secret-id/data body={"contentId":"secret-id","private":"raw-body-marker"}"#
        )

        let sinkBytes = Data(sink.output.utf8)
        for forbidden in [
            "go-test-secret", "Authorization", capabilityURL,
            "secret-id", "raw-body-marker",
        ] {
            #expect(sinkBytes.range(of: Data(forbidden.utf8)) == nil)
        }
        #expect(sink.output.contains("push_failed"))
    }

    @Test func cacheRejectsRawProviderKeysAtAnyDepth() throws {
        let fixtures = [
            Data(#"{"authorization":"Bearer secret","rateLimits":{}}"#.utf8),
            Data(#"{"schemaVersion":1,"codex":{"status":"ok","sourceCollectedAt":"1970-01-01T00:00:00Z","headerLeft":"CODEX","summaryLabel":"OK","rolling":{"label":"5h","remainingPercent":80,"valueText":"80%","resetAt":null,"token":"secret"},"weekly":{"label":"week","remainingPercent":70,"valueText":"70%","resetAt":null},"footerLeft":"left","footerRight":"right"},"openCodeGo":null}"#.utf8),
        ]

        for bytes in fixtures {
            #expect(throws: SnapshotCacheError.self) {
                try SanitizedLastGood.decodeStrict(bytes)
            }
        }
    }

    @Test func cacheRoundTripsStrictSanitizedSnapshotsAsOwnerOnlyAtomicFiles() throws {
        let root = try TemporaryDirectory()
        let cache = SanitizedSnapshotCache(applicationSupportURL: root.url)
        let lastGood = SanitizedLastGood(
            schemaVersion: 1,
            codex: .fixture(),
            openCodeGo: .fixture()
        )
        let runtime = CollectorRuntimeState(
            schemaVersion: 1,
            codexFailures: 1,
            openCodeGoFailures: 2,
            simultaneousFailures: 3,
            lastSuccessAt: Date(timeIntervalSince1970: 1_700_000_000),
            lastPushAt: Date(timeIntervalSince1970: 1_700_000_100),
            providerStatuses: ["codex": .attention, "opencode_go": .critical],
            lastErrorCodes: ["codex": "timeout", "opencode_go": "rate_limited"]
        )

        try cache.saveLastGood(lastGood)
        try cache.saveRuntimeState(runtime)

        #expect(try cache.loadLastGood() == lastGood)
        #expect(try cache.loadRuntimeState() == runtime)
        #expect(try fileMode(cache.lastGoodURL) & 0o077 == 0)
        #expect(try fileMode(cache.runtimeStateURL) & 0o077 == 0)

        let allBytes = try Data(contentsOf: cache.lastGoodURL) + Data(contentsOf: cache.runtimeStateURL)
        for forbidden in [
            "go-test-secret", "Authorization", "pushURL", "contentId",
            "rateLimits", "rollingUsage", "apiKey", "token",
        ] {
            #expect(allBytes.range(of: Data(forbidden.utf8)) == nil)
        }
    }

    @Test func cacheRejectsInvalidRuntimeProviderAndErrorCodesBeforeWriting() throws {
        let root = try TemporaryDirectory()
        let cache = SanitizedSnapshotCache(applicationSupportURL: root.url)
        let runtime = CollectorRuntimeState(
            schemaVersion: 1,
            codexFailures: 0,
            openCodeGoFailures: 0,
            simultaneousFailures: 0,
            lastSuccessAt: nil,
            lastPushAt: nil,
            providerStatuses: ["private-provider": .ok],
            lastErrorCodes: ["codex": "Bearer secret"]
        )

        #expect(throws: SnapshotCacheError.self) {
            try cache.saveRuntimeState(runtime)
        }
        #expect(FileManager.default.fileExists(atPath: cache.runtimeStateURL.path) == false)
    }

    @Test func corruptCacheReturnsOnlyPublicCacheCorruptCode() throws {
        let bodyMarker = "private-raw-body-marker"
        let invalid = Data(#"{"schemaVersion":1,"authorization":"private-raw-body-marker"}"#.utf8)

        do {
            _ = try SanitizedLastGood.decodeStrict(invalid)
            Issue.record("Expected corrupt cache rejection")
        } catch let error as SnapshotCacheError {
            #expect(error.publicCode == "cache_corrupt")
            #expect(String(describing: error).contains(bodyMarker) == false)
        }
    }

    private func fileMode(_ url: URL) throws -> Int {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        return try #require((attributes[.posixPermissions] as? NSNumber)?.intValue)
    }
}

private final class RecordingKeychainBackend: KeychainBackend, @unchecked Sendable {
    private var values: [String: Data] = [:]
    private let forcedReadStatus: OSStatus?
    private(set) var lastQuery: [String: Any]?
    private(set) var lastAttributes: [String: Any]?
    private(set) var updateCount = 0
    private(set) var addCount = 0

    init(forcedReadStatus: OSStatus? = nil) {
        self.forcedReadStatus = forcedReadStatus
    }

    func update(_ query: [CFString: Any], attributes: [CFString: Any]) -> OSStatus {
        updateCount += 1
        lastQuery = stringify(query)
        lastAttributes = stringify(attributes)
        guard let account = query[kSecAttrAccount] as? String,
              values[account] != nil else {
            return errSecItemNotFound
        }
        values[account] = attributes[kSecValueData] as? Data
        return errSecSuccess
    }

    func add(_ attributes: [CFString: Any]) -> OSStatus {
        addCount += 1
        lastAttributes = stringify(attributes)
        guard let account = attributes[kSecAttrAccount] as? String,
              let value = attributes[kSecValueData] as? Data else {
            return errSecParam
        }
        values[account] = value
        return errSecSuccess
    }

    func copyMatching(_ query: [CFString: Any]) -> (OSStatus, Data?) {
        lastQuery = stringify(query)
        if let forcedReadStatus { return (forcedReadStatus, nil) }
        guard let account = query[kSecAttrAccount] as? String,
              let value = values[account] else {
            return (errSecItemNotFound, nil)
        }
        return (errSecSuccess, value)
    }

    private func stringify(_ dictionary: [CFString: Any]) -> [String: Any] {
        Dictionary(uniqueKeysWithValues: dictionary.map { ($0 as String, $1) })
    }
}

private final class StringLogSink: RedactingLogSink, @unchecked Sendable {
    private(set) var output = ""

    func write(_ message: String) {
        output += message
        output += "\n"
    }
}
