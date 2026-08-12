import Foundation
import Testing
@testable import SlateQuotaCollector

@Suite struct ModelsAndConfigurationTests {
    @Test func envelopeUsesSlateSnakeCaseKeys() throws {
        let data = SlateDashboardData.fixture(generatedAt: Date(timeIntervalSince1970: 0))
        let encoded = try JSONEncoder.slate.encode(SlateEnvelope(data: data))
        let json = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        #expect(json["version"] as? Int == 1)
        let body = try #require(json["data"] as? [String: Any])
        #expect(body["schema_version"] as? Int == 1)
        #expect(body["opencode_go"] != nil)
    }

    @Test func configurationRejectsSecretFields() throws {
        let bytes = Data(#"{"schemaVersion":1,"codexExecutablePath":"/usr/local/bin/codex","timezoneIdentifier":"Asia/Shanghai","opencodeGoApiKey":"secret"}"#.utf8)
        #expect(throws: ConfigurationError.self) {
            try CollectorConfiguration.decodeStrict(bytes)
        }
    }

    @Test func configurationRejectsValidButUnsupportedTimezone() throws {
        let bytes = Data(#"{"schemaVersion":1,"codexExecutablePath":"/usr/local/bin/codex","timezoneIdentifier":"UTC","codexTimeoutSeconds":20,"openCodeTimeoutSeconds":10,"slateTimeoutSeconds":15,"overallTimeoutSeconds":45,"logLevel":"info","keychainService":"com.yym8224961.slate-quota-collector","openCodeKeyAccount":"opencode-go-api-key","slateURLAccount":"slate-push-url"}"#.utf8)
        #expect(throws: ConfigurationError.self) {
            try CollectorConfiguration.decodeStrict(bytes)
        }
    }

    @Test func configurationStoreWritesOwnerOnlyFile() throws {
        let root = try TemporaryDirectory()
        let store = ConfigurationStore(applicationSupportURL: root.url)
        try store.save(.fixture)
        let mode = try store.fileMode(at: store.configurationURL)
        #expect(mode & 0o077 == 0)
    }
}
