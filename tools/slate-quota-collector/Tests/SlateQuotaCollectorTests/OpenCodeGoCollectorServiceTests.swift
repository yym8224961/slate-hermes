import Foundation
import Testing
@testable import SlateQuotaCollector

@Suite("Independent OpenCode Go collector")
struct OpenCodeGoCollectorServiceTests {
    private let now = Date(timeIntervalSince1970: 1_788_003_600)

    @Test("success preserves Codex state, pushes the second endpoint, and verifies exact readback")
    func successPreservesCodexAndVerifiesReadback() async throws {
        let codex = CodexDisplaySnapshot(
            status: .ok,
            sourceCollectedAt: now.addingTimeInterval(-30),
            headerLeft: "CODEX",
            summaryLabel: "最低剩余 68%",
            rolling: .init(label: "7 天", remainingPercent: 68, valueText: "剩余 68%", resetAt: now),
            weekly: .init(label: "", remainingPercent: 0, valueText: "未提供", resetAt: nil),
            footerLeft: "",
            footerRight: ""
        )
        let snapshots = OpenCodeSnapshotStore(initial: CollectorSnapshot(
            schemaVersion: 1,
            lastGood: .init(schemaVersion: 1, codex: codex, openCodeGo: nil),
            runtimeState: .init(
                schemaVersion: 1,
                codexFailures: 0,
                openCodeGoFailures: 0,
                simultaneousFailures: 0,
                lastSuccessAt: now.addingTimeInterval(-30),
                lastPushAt: now.addingTimeInterval(-30),
                providerStatuses: ["codex": .ok],
                lastErrorCodes: [:]
            )
        ))
        let secrets = OpenCodeSecretStore(values: [
            "opencode-go-api-key": "go-secret",
            "slate-opencode-go-push-url": "https://slate.example/api/v1/contents/opencode/data",
        ])
        let slate = RecordingOpenCodeSlate()
        let service = makeService(secrets: secrets, snapshots: snapshots, slate: slate)

        let report = try await service.collect(mode: .pushOnce)

        #expect(report.pushed)
        #expect(report.readbackVerified)
        #expect(report.publicErrorCodes.isEmpty)
        #expect(report.envelope?.data.quota.primary.name == "5 小时")
        #expect(report.envelope?.data.quota.weekly.name == "本周")
        #expect(report.envelope?.data.quota.monthly.name == "本月")
        #expect(secrets.readAccounts == ["opencode-go-api-key", "slate-opencode-go-push-url"])
        #expect(await slate.pushCount == 1)
        #expect(await slate.readbackCount == 1)
        let saved = try snapshots.loadSnapshot()
        #expect(saved.lastGood.codex == codex)
        #expect(saved.lastGood.openCodeGo?.status == .ok)
        #expect(saved.runtimeState.providerStatuses["codex"] == .ok)
        #expect(saved.runtimeState.providerStatuses["opencode_go"] == .ok)
        #expect(saved.runtimeState.lastPushAt == now)
    }

    @Test("dry run never reads the second Slate endpoint or pushes")
    func dryRunSkipsSlateCredentialAndNetwork() async throws {
        let secrets = OpenCodeSecretStore(values: ["opencode-go-api-key": "go-secret"])
        let slate = RecordingOpenCodeSlate()

        let report = try await makeService(secrets: secrets, slate: slate).collect(mode: .dryRun)

        #expect(report.envelope != nil)
        #expect(report.pushed == false)
        #expect(report.readbackVerified == false)
        #expect(secrets.readAccounts == ["opencode-go-api-key"])
        #expect(await slate.pushCount == 0)
        #expect(await slate.readbackCount == 0)
    }

    @Test("readback mismatch is public and does not advance last push")
    func mismatchDoesNotAdvanceLastPush() async throws {
        let earlier = now.addingTimeInterval(-300)
        var initial = CollectorSnapshot.empty
        initial.runtimeState.lastPushAt = earlier
        let snapshots = OpenCodeSnapshotStore(initial: initial)
        let slate = RecordingOpenCodeSlate(mismatchReadback: true)

        let report = try await makeService(snapshots: snapshots, slate: slate)
            .collect(mode: .pushOnce)

        #expect(report.pushed)
        #expect(report.readbackVerified == false)
        #expect(report.publicErrorCodes["slate_opencode_go"] == "slate_readback_mismatch")
        #expect(try snapshots.loadSnapshot().runtimeState.lastPushAt == earlier)
    }

    private func makeService(
        secrets: OpenCodeSecretStore = OpenCodeSecretStore(values: [
            "opencode-go-api-key": "go-secret",
            "slate-opencode-go-push-url": "https://slate.example/api/v1/contents/opencode/data",
        ]),
        snapshots: OpenCodeSnapshotStore = OpenCodeSnapshotStore(initial: .empty),
        slate: RecordingOpenCodeSlate = RecordingOpenCodeSlate()
    ) -> OpenCodeGoCollectorService {
        OpenCodeGoCollectorService(
            openCodeGo: FixedOpenCodeReader(),
            normalizer: .shanghai,
            secrets: secrets,
            snapshots: snapshots,
            slate: slate,
            openCodeKeyAccount: "opencode-go-api-key",
            slateURLAccount: "slate-opencode-go-push-url",
            now: { now }
        )
    }
}

private struct FixedOpenCodeReader: OpenCodeGoUsageReading {
    func read(apiKey _: String) async throws -> OpenCodeGoUsageResponse {
        .init(
            rollingUsage: .init(status: .ok, resetAt: Date(timeIntervalSince1970: 1_788_007_200), usagePercent: 14),
            weeklyUsage: .init(status: .ok, resetAt: Date(timeIntervalSince1970: 1_788_090_000), usagePercent: 26),
            monthlyUsage: .init(status: .ok, resetAt: Date(timeIntervalSince1970: 1_788_608_400), usagePercent: 38)
        )
    }
}

private final class OpenCodeSecretStore: SecretStoring, @unchecked Sendable {
    private let values: [String: String]
    private let lock = NSLock()
    private var accounts: [String] = []

    init(values: [String: String]) { self.values = values }
    var readAccounts: [String] { lock.withLock { accounts } }

    func read(account: String) throws -> String {
        try lock.withLock {
            accounts.append(account)
            guard let value = values[account] else { throw OpenCodeFixtureError.missing }
            return value
        }
    }

    func write(_: String, account _: String) throws {}
}

private final class OpenCodeSnapshotStore: SnapshotPersisting, @unchecked Sendable {
    private let lock = NSLock()
    private var snapshot: CollectorSnapshot

    init(initial: CollectorSnapshot) { snapshot = initial }
    func loadSnapshot() throws -> CollectorSnapshot { lock.withLock { snapshot } }
    func saveSnapshot(_ value: CollectorSnapshot) throws { lock.withLock { snapshot = value } }
}

private actor RecordingOpenCodeSlate: OpenCodeGoSlateIngesting {
    private let mismatchReadback: Bool
    private var pushed: OpenCodeGoSlateEnvelope?
    private(set) var pushCount = 0
    private(set) var readbackCount = 0

    init(mismatchReadback: Bool = false) { self.mismatchReadback = mismatchReadback }

    func push(
        _ envelope: OpenCodeGoSlateEnvelope,
        capabilityURL _: URL
    ) async throws -> SlateIngestReceipt {
        pushCount += 1
        pushed = envelope
        return .init(
            id: "fixture",
            imageEtag: "fixture",
            manifestEtag: "fixture",
            renderedAt: envelope.data.generatedAt
        )
    }

    func readCurrentOpenCodeGoData(capabilityURL _: URL) async throws -> OpenCodeGoDashboardData {
        readbackCount += 1
        guard let data = pushed?.data else { throw OpenCodeFixtureError.missing }
        if !mismatchReadback { return data }
        return OpenCodeGoDashboardData(
            schemaVersion: data.schemaVersion,
            generatedAt: data.generatedAt.addingTimeInterval(1),
            opencodeGo: data.opencodeGo
        )
    }
}

private enum OpenCodeFixtureError: Error { case missing }
