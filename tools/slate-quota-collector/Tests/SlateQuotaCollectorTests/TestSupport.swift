import Foundation
@testable import SlateQuotaCollector

struct TemporaryDirectory {
    let url: URL

    init() throws {
        url = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }
}

extension QuotaWindow {
    static let fixture = Self(label: "5 小时", remainingPercent: 81, valueText: "剩余 81%", resetAt: nil)
}

extension CodexDisplaySnapshot {
    static func fixture() -> Self {
        Self(
            status: .ok,
            sourceCollectedAt: Date(timeIntervalSince1970: 0),
            headerLeft: "CODEX · PROLITE",
            summaryLabel: "最低剩余 81%",
            rolling: .fixture,
            weekly: .init(label: "本周", remainingPercent: 71, valueText: "剩余 71%", resetAt: nil),
            footerLeft: "周重置 --",
            footerRight: "Credits 128.50"
        )
    }
}

extension OpenCodeGoDisplaySnapshot {
    static func fixture() -> Self {
        Self(
            status: .ok,
            sourceCollectedAt: Date(timeIntervalSince1970: 0),
            headerLeft: "OPENCODE GO",
            summaryLabel: "最低剩余 71%",
            rolling: .fixture,
            weekly: .init(label: "本周", remainingPercent: 71, valueText: "剩余 71%", resetAt: nil),
            monthly: .init(label: "本月", remainingPercent: 75, valueText: "剩余 75%", resetAt: nil),
            footerLeft: "下次重置 --",
            footerRight: "余额接续 关闭"
        )
    }
}

extension SlateDashboardData {
    static func fixture(generatedAt: Date) -> Self {
        Self(schemaVersion: 1, generatedAt: generatedAt, codex: .fixture(), opencodeGo: .fixture())
    }
}

extension CollectorConfiguration {
    static let fixture = Self(
        schemaVersion: 1,
        codexExecutablePath: "/usr/local/bin/codex",
        timezoneIdentifier: "Asia/Shanghai",
        codexTimeoutSeconds: 20,
        openCodeTimeoutSeconds: 10,
        slateTimeoutSeconds: 15,
        overallTimeoutSeconds: 45,
        logLevel: "info",
        keychainService: "com.yym8224961.slate-quota-collector",
        openCodeKeyAccount: "opencode-go-api-key",
        slateURLAccount: "slate-push-url"
    )
}
