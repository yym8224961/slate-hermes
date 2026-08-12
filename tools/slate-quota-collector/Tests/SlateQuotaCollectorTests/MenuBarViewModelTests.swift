import Foundation
import Testing
@testable import SlateQuotaCollector

@Suite("Menu bar presentation")
struct MenuBarViewModelTests {
    private let now = Date(timeIntervalSince1970: 1_754_987_440) // 2025-08-12 16:30 in Asia/Shanghai

    @Test("enabled presentation uses chart shape, checked toggle, and trusted percentages")
    func enabledPresentationUsesChartIconAndCheckedToggle() {
        let value = MenuBarViewModel().presentation(
            snapshot: .healthy(lastPushAt: now),
            schedule: .enabledLoaded,
            busy: nil,
            now: now
        )

        #expect(value.iconSystemName == "chart.bar.fill")
        #expect(value.automaticCollectionChecked)
        #expect(value.codexLine == "正常 · 剩余 91%")
        #expect(value.openCodeGoLine == "注意 · 剩余 18%")
        #expect(value.lastPushLine == "今天 16:30")
    }

    @Test("paused and error icons differ by shape rather than color")
    func pausedAndErrorIconsDoNotDependOnColor() {
        let viewModel = MenuBarViewModel()

        #expect(viewModel.presentation(
            snapshot: .healthy(lastPushAt: nil),
            schedule: .disabled,
            busy: nil,
            now: now
        ).iconSystemName == "pause.circle")
        #expect(viewModel.presentation(
            snapshot: .providerError,
            schedule: .enabledLoaded,
            busy: nil,
            now: now
        ).iconSystemName == "exclamationmark.triangle")
    }

    @Test("zero placeholder without trusted snapshot is never presented as exhausted")
    func untrustedZeroIsNotPresentedAsExhausted() {
        let value = MenuBarViewModel().presentation(
            snapshot: .noTrustedData,
            schedule: .enabledLoaded,
            busy: nil,
            now: now
        )

        #expect(value.codexLine == "无可信数据")
        #expect(value.openCodeGoLine == "无可信数据")
        #expect(value.codexLine.contains("耗尽") == false)
        #expect(value.openCodeGoLine.contains("耗尽") == false)
    }

    @Test("busy copy is explicit while status values remain visible")
    func busyPresentationIsExplicit() {
        let value = MenuBarViewModel().presentation(
            snapshot: .healthy(lastPushAt: nil),
            schedule: .enabledLoaded,
            busy: .collecting,
            now: now
        )

        #expect(value.busyLine == "正在采集")
        #expect(value.codexLine == "正常 · 剩余 91%")
    }

    @Test("status reader derives only display-safe state from sanitized cache")
    func statusReaderUsesSanitizedSnapshotBundle() throws {
        let persisted = CollectorSnapshot(
            schemaVersion: 1,
            lastGood: SanitizedLastGood(
                schemaVersion: 1,
                codex: .fixture(status: .ok, remaining: 91),
                openCodeGo: .fixture(status: .attention, remaining: 18)
            ),
            runtimeState: CollectorRuntimeState(
                schemaVersion: 1,
                codexFailures: 0,
                openCodeGoFailures: 1,
                simultaneousFailures: 0,
                lastSuccessAt: now.addingTimeInterval(-60),
                lastPushAt: now,
                providerStatuses: ["codex": .ok, "opencode_go": .attention],
                lastErrorCodes: ["opencode_go": "rate_limited"]
            )
        )
        let reader = SnapshotMenuBarStatusReader(snapshots: FixedSnapshotStore(snapshot: persisted))

        let value = try reader.readStatus()

        #expect(value.codexSummary == "正常 · 剩余 91%")
        #expect(value.openCodeGoSummary == "注意 · 剩余 18%")
        #expect(value.publicErrorCodes == ["opencode_go": "rate_limited"])
    }

    @Test("status reader ignores unavailable window sentinels before choosing remaining quota")
    func statusReaderIgnoresUnavailableWindowSentinels() throws {
        let persisted = CollectorSnapshot(
            schemaVersion: 1,
            lastGood: SanitizedLastGood(
                schemaVersion: 1,
                codex: .fixture(
                    status: .ok,
                    rolling: .unavailable(label: "5 小时"),
                    weekly: .trusted(label: "本周", remaining: 91)
                ),
                openCodeGo: .fixture(
                    status: .attention,
                    rolling: .unavailable(label: "5 小时"),
                    weekly: .trusted(label: "本周", remaining: 71),
                    monthly: .trusted(label: "本月", remaining: 75)
                )
            ),
            runtimeState: .fixture(
                statuses: ["codex": .ok, "opencode_go": .attention]
            )
        )
        let reader = SnapshotMenuBarStatusReader(snapshots: FixedSnapshotStore(snapshot: persisted))

        let value = try reader.readStatus()

        #expect(value.codexSummary == "正常 · 剩余 91%")
        #expect(value.openCodeGoSummary == "注意 · 剩余 71%")
    }

    @Test("status reader reports no trusted data when every provider window is unavailable")
    func statusReaderReportsNoDataWhenAllWindowsAreUnavailable() throws {
        let persisted = CollectorSnapshot(
            schemaVersion: 1,
            lastGood: SanitizedLastGood(
                schemaVersion: 1,
                codex: .fixture(
                    status: .ok,
                    rolling: .unavailable(label: "5 小时"),
                    weekly: .unavailable(label: "本周")
                ),
                openCodeGo: .fixture(
                    status: .ok,
                    rolling: .unavailable(label: "5 小时"),
                    weekly: .unavailable(label: "本周"),
                    monthly: .unavailable(label: "本月")
                )
            ),
            runtimeState: .fixture(statuses: ["codex": .ok, "opencode_go": .ok])
        )
        let reader = SnapshotMenuBarStatusReader(snapshots: FixedSnapshotStore(snapshot: persisted))

        let value = try reader.readStatus()

        #expect(value.codexSummary == "无可信数据")
        #expect(value.openCodeGoSummary == "无可信数据")
    }
}

private extension MenuBarStatusSnapshot {
    static func healthy(lastPushAt: Date?) -> Self {
        Self(
            codexSummary: "正常 · 剩余 91%",
            openCodeGoSummary: "注意 · 剩余 18%",
            lastSuccessAt: Date(timeIntervalSince1970: 1_754_990_140),
            lastPushAt: lastPushAt,
            publicErrorCodes: [:]
        )
    }

    static let providerError = Self(
        codexSummary: "数据过期 · 最后可信 91%",
        openCodeGoSummary: "注意 · 剩余 18%",
        lastSuccessAt: nil,
        lastPushAt: nil,
        publicErrorCodes: ["codex": "timeout"]
    )

    static let noTrustedData = Self(
        codexSummary: "无可信数据",
        openCodeGoSummary: "无可信数据",
        lastSuccessAt: nil,
        lastPushAt: nil,
        publicErrorCodes: ["codex": "unauthenticated", "opencode_go": "unconfigured"]
    )
}

private extension CodexDisplaySnapshot {
    static func fixture(status: ProviderStatus, remaining: Int) -> Self {
        Self(
            status: status,
            sourceCollectedAt: Date(timeIntervalSince1970: 1_754_990_140),
            headerLeft: "CODEX",
            summaryLabel: "最低剩余 \(remaining)%",
            rolling: .init(label: "5 小时", remainingPercent: remaining, valueText: "剩余 \(remaining)%", resetAt: nil),
            weekly: .init(label: "本周", remainingPercent: remaining, valueText: "剩余 \(remaining)%", resetAt: nil),
            footerLeft: "周重置 --",
            footerRight: "Credits —"
        )
    }

    static func fixture(
        status: ProviderStatus,
        rolling: QuotaWindow,
        weekly: QuotaWindow
    ) -> Self {
        Self(
            status: status,
            sourceCollectedAt: Date(timeIntervalSince1970: 1_754_990_140),
            headerLeft: "CODEX",
            summaryLabel: "菜单测试",
            rolling: rolling,
            weekly: weekly,
            footerLeft: "周重置 --",
            footerRight: "Credits —"
        )
    }
}

private extension OpenCodeGoDisplaySnapshot {
    static func fixture(status: ProviderStatus, remaining: Int) -> Self {
        Self(
            status: status,
            sourceCollectedAt: Date(timeIntervalSince1970: 1_754_990_140),
            headerLeft: "OPENCODE GO",
            summaryLabel: "最低剩余 \(remaining)%",
            rolling: .init(label: "5 小时", remainingPercent: remaining, valueText: "剩余 \(remaining)%", resetAt: nil),
            weekly: .init(label: "本周", remainingPercent: remaining, valueText: "剩余 \(remaining)%", resetAt: nil),
            monthly: .init(label: "本月", remainingPercent: remaining, valueText: "剩余 \(remaining)%", resetAt: nil),
            footerLeft: "下次重置 --",
            footerRight: "余额接续 关闭"
        )
    }

    static func fixture(
        status: ProviderStatus,
        rolling: QuotaWindow,
        weekly: QuotaWindow,
        monthly: QuotaWindow
    ) -> Self {
        Self(
            status: status,
            sourceCollectedAt: Date(timeIntervalSince1970: 1_754_990_140),
            headerLeft: "OPENCODE GO",
            summaryLabel: "菜单测试",
            rolling: rolling,
            weekly: weekly,
            monthly: monthly,
            footerLeft: "下次重置 --",
            footerRight: "余额接续 关闭"
        )
    }
}

private extension QuotaWindow {
    static func unavailable(label: String) -> Self {
        Self(label: label, remainingPercent: 0, valueText: "未提供", resetAt: nil)
    }

    static func trusted(label: String, remaining: Int) -> Self {
        Self(label: label, remainingPercent: remaining, valueText: "剩余 \(remaining)%", resetAt: nil)
    }
}

private extension CollectorRuntimeState {
    static func fixture(statuses: [String: ProviderStatus]) -> Self {
        Self(
            schemaVersion: 1,
            codexFailures: 0,
            openCodeGoFailures: 0,
            simultaneousFailures: 0,
            lastSuccessAt: nil,
            lastPushAt: nil,
            providerStatuses: statuses,
            lastErrorCodes: [:]
        )
    }
}

private struct FixedSnapshotStore: SnapshotPersisting {
    let snapshot: CollectorSnapshot

    func loadSnapshot() throws -> CollectorSnapshot { snapshot }
    func saveSnapshot(_: CollectorSnapshot) throws {}
}
