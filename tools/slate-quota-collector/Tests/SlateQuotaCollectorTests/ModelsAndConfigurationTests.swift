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
        #expect(body["reset_radar"] != nil)
        #expect(body["task_activity"] != nil)
        #expect(body["quota"] != nil)
    }

    @Test func pureCodexEnvelopeOmitsOpenCodeWithoutDeletingCompatibilityData() throws {
        let generatedAt = Date(timeIntervalSince1970: 1_788_003_600)
        let data = SlateDashboardData(
            schemaVersion: 1,
            generatedAt: generatedAt,
            codex: .fixture(),
            opencodeGo: .fixture(),
            includesOpenCodeGo: false
        )

        let encoded = try JSONEncoder.slate.encode(SlateEnvelope(data: data))
        let json = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        let body = try #require(json["data"] as? [String: Any])
        #expect(body["opencode_go"] == nil)

        let decoded = try JSONDecoder.slate.decode(SlateEnvelope.self, from: encoded)
        #expect(decoded.data.includesOpenCodeGo == false)
        #expect(decoded.data.opencodeGo.status == .unavailable)
    }

    @Test func projectionMatchesUpstreamTwoWindowLabelsAndMessages() {
        let generatedAt = Date(timeIntervalSince1970: 1_788_003_600)
        var codex = CodexDisplaySnapshot.fixture()
        codex.resetCredits = 2
        let data = SlateDashboardData(
            schemaVersion: 1,
            generatedAt: generatedAt,
            codex: codex,
            opencodeGo: .fixture(),
            includesOpenCodeGo: false
        )

        #expect(data.quota.dualWindow)
        #expect(data.quota.singleWindow == false)
        #expect(data.quota.primary.name == "5 小时")
        #expect(data.quota.secondary.name == "7 天")
        #expect(data.quota.primary.usedText == "已用 19%")
        #expect(data.quota.primary.dualTwoDigits)
        #expect(data.quota.primary.singleTwoDigits == false)
        #expect(data.quota.secondary.dualTwoDigits)
        #expect(data.quota.message == "还能蹬，别急着坐下。")
        #expect(data.quota.creditsText == "重置额度 2")
        #expect(data.quota.creditsVisible)
        #expect(data.footer.updateText.hasPrefix("画面更新 "))
    }

    @Test func singleWindowProjectionHidesEverySecondaryNumberVariant() {
        let generatedAt = Date(timeIntervalSince1970: 1_788_003_600)
        let fixture = CodexDisplaySnapshot.fixture()
        let codex = CodexDisplaySnapshot(
            status: fixture.status,
            sourceCollectedAt: fixture.sourceCollectedAt,
            headerLeft: fixture.headerLeft,
            summaryLabel: fixture.summaryLabel,
            rolling: fixture.rolling,
            weekly: QuotaWindow(
                label: "本周",
                remainingPercent: 0,
                valueText: "未提供",
                resetAt: nil
            ),
            footerLeft: fixture.footerLeft,
            footerRight: fixture.footerRight
        )
        let data = SlateDashboardData(
            schemaVersion: 1,
            generatedAt: generatedAt,
            codex: codex,
            opencodeGo: .fixture(),
            includesOpenCodeGo: false
        )

        #expect(data.quota.singleWindow)
        #expect(data.quota.dualWindow == false)
        #expect(data.quota.secondary.dualOneDigit == false)
        #expect(data.quota.secondary.dualTwoDigits == false)
        #expect(data.quota.secondary.dualThreeDigits == false)
        #expect(data.quota.secondary.singleOneDigit == false)
        #expect(data.quota.secondary.singleTwoDigits == false)
        #expect(data.quota.secondary.singleThreeDigits == false)
    }

    @Test func shippedInitialDataDecodesAsPureCodexDashboard() throws {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let bytes = try Data(contentsOf: packageRoot.appendingPathComponent("templates/initial-data.json"))
        let decoded = try JSONDecoder.slate.decode(SlateEnvelope.self, from: bytes)

        #expect(decoded.data.includesOpenCodeGo == false)
        #expect(decoded.data.quota.singleWindow)
        #expect(decoded.data.quota.dualWindow == false)
        #expect(decoded.data.quota.primary.name == "7 天")
        #expect(decoded.data.quota.secondary.name.isEmpty)
        #expect(decoded.data.resetRadar.status == .activeWatch)
        #expect(decoded.data.taskActivity.rows.count == 3)
        #expect(decoded.data.footer.showUpdated)
    }

    @Test func openCodeGoEnvelopeUsesASeparateSchemaAndThreeQuotaWindows() throws {
        let generatedAt = Date(timeIntervalSince1970: 1_788_003_600)
        let data = OpenCodeGoDashboardData(
            schemaVersion: 1,
            generatedAt: generatedAt,
            opencodeGo: .fixture()
        )

        let encoded = try JSONEncoder.slate.encode(OpenCodeGoSlateEnvelope(data: data))
        let json = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        let body = try #require(json["data"] as? [String: Any])
        #expect(body["codex"] == nil)
        #expect(body["reset_radar"] == nil)
        #expect(body["task_activity"] == nil)
        #expect(body["opencode_go"] != nil)
        let quota = try #require(body["quota"] as? [String: Any])
        #expect((quota["primary"] as? [String: Any])?["name"] as? String == "5 小时")
        #expect((quota["weekly"] as? [String: Any])?["name"] as? String == "本周")
        #expect((quota["monthly"] as? [String: Any])?["name"] as? String == "本月")
    }

    @Test func shippedOpenCodeGoInitialDataDecodesAsIndependentDashboard() throws {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let bytes = try Data(contentsOf: packageRoot.appendingPathComponent(
            "templates/initial-opencode-go-data.json"
        ))
        let decoded = try JSONDecoder.slate.decode(OpenCodeGoSlateEnvelope.self, from: bytes)

        #expect(decoded.data.opencodeGo.status == .ok)
        #expect(decoded.data.quota.primary.name == "5 小时")
        #expect(decoded.data.quota.weekly.name == "本周")
        #expect(decoded.data.quota.monthly.name == "本月")
        #expect(decoded.data.footer.updateText.hasPrefix("画面更新 "))
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
