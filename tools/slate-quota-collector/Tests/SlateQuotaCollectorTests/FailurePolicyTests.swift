import Foundation
import Testing
@testable import SlateQuotaCollector

@Suite struct FailurePolicyTests {
    private let now = Date(timeIntervalSince1970: 1_786_523_400)

    @Test func oneProviderFailureKeepsLastGoodAndMarksOnlyThatProviderStale() {
        let decision = FailurePolicy().decide(
            codex: .failure(.timeout),
            openCodeGo: .success(.freshGo),
            lastGood: .bothFresh,
            state: .clean,
            now: now
        )

        #expect(decision.shouldPush)
        #expect(decision.envelope?.data.codex.status == .stale)
        #expect(decision.envelope?.data.codex.rolling.remainingPercent == SanitizedLastGood.bothFresh.codex?.rolling.remainingPercent)
        #expect(decision.envelope?.data.codex.sourceCollectedAt == SanitizedLastGood.bothFresh.codex?.sourceCollectedAt)
        #expect(decision.envelope?.data.opencodeGo.status == .ok)
        #expect(decision.runtimeState.codexFailures == 1)
        #expect(decision.runtimeState.openCodeGoFailures == 0)
        #expect(decision.runtimeState.simultaneousFailures == 0)
    }

    @Test func firstSimultaneousFailureDoesNotPush() {
        let decision = FailurePolicy().decide(
            codex: .failure(.timeout),
            openCodeGo: .failure(.server),
            lastGood: .bothFresh,
            state: .clean,
            now: now
        )

        #expect(decision.shouldPush == false)
        #expect(decision.envelope == nil)
        #expect(decision.runtimeState.simultaneousFailures == 1)
    }

    @Test func secondSimultaneousFailurePushesStaleSnapshot() {
        let decision = FailurePolicy().decide(
            codex: .failure(.timeout),
            openCodeGo: .failure(.server),
            lastGood: .bothFresh,
            state: .oneSimultaneousFailure,
            now: now
        )

        #expect(decision.shouldPush)
        #expect(decision.envelope?.data.codex.status == .stale)
        #expect(decision.envelope?.data.opencodeGo.status == .stale)
        #expect(decision.envelope?.data.codex.rolling == SanitizedLastGood.bothFresh.codex?.rolling)
        #expect(decision.envelope?.data.opencodeGo.monthly == SanitizedLastGood.bothFresh.openCodeGo?.monthly)
    }

    @Test func noCacheUsesExplicitNoDataInsteadOfExhausted() {
        let decision = FailurePolicy().decide(
            codex: .failure(.unauthenticated),
            openCodeGo: .failure(.subscriptionRequired),
            lastGood: .empty,
            state: .oneSimultaneousFailure,
            now: now
        )

        #expect(decision.shouldPush)
        #expect(decision.envelope?.data.codex.headerLeft == "CODEX · 未登录")
        #expect(decision.envelope?.data.codex.summaryLabel == "无可信数据")
        #expect(decision.envelope?.data.codex.status == .unauthenticated)
        #expect(decision.envelope?.data.codex.rolling.valueText == "未提供")
        #expect(decision.envelope?.data.opencodeGo.headerLeft == "OPENCODE GO · 无 Go 订阅")
        #expect(decision.envelope?.data.opencodeGo.summaryLabel == "无可信数据")
        #expect(decision.envelope?.data.opencodeGo.status == .unavailable)
        #expect(decision.envelope?.data.opencodeGo.monthly.valueText == "未提供")
    }

    @Test func openCode401WithoutCacheIsExplicitlyUnconfigured() {
        let decision = FailurePolicy().decide(
            codex: .success(.freshCodex),
            openCodeGo: .failure(.unauthenticated),
            lastGood: .empty,
            state: .clean,
            now: now
        )

        #expect(decision.envelope?.data.opencodeGo.headerLeft == "OPENCODE GO · 未配置")
        #expect(decision.envelope?.data.opencodeGo.status == .unconfigured)
        #expect(decision.envelope?.data.opencodeGo.summaryLabel == "无可信数据")
    }

    @Test func openCode403WithoutCacheIsExplicitlySubscriptionRequired() {
        let decision = FailurePolicy().decide(
            codex: .success(.freshCodex),
            openCodeGo: .failure(.subscriptionRequired),
            lastGood: .empty,
            state: .clean,
            now: now
        )

        #expect(decision.envelope?.data.opencodeGo.headerLeft == "OPENCODE GO · 无 Go 订阅")
        #expect(decision.envelope?.data.opencodeGo.status == .unavailable)
        #expect(decision.envelope?.data.opencodeGo.summaryLabel != "已耗尽")
    }

    @Test func aRecoveredProviderRefreshesLastGoodAndClearsFailureCounters() {
        var state = CollectorRuntimeState.oneSimultaneousFailure
        state.codexFailures = 3
        state.openCodeGoFailures = 2
        let fresh = CodexDisplaySnapshot.fresh(sourceCollectedAt: now)

        let decision = FailurePolicy().decide(
            codex: .success(fresh),
            openCodeGo: .failure(.timeout),
            lastGood: .bothFresh,
            state: state,
            now: now
        )

        #expect(decision.shouldPush)
        #expect(decision.lastGood.codex == fresh)
        #expect(decision.runtimeState.codexFailures == 0)
        #expect(decision.runtimeState.openCodeGoFailures == 3)
        #expect(decision.runtimeState.simultaneousFailures == 0)
        #expect(decision.runtimeState.lastSuccessAt == now)
        #expect(decision.envelope?.data.codex.status == .ok)
        #expect(decision.envelope?.data.opencodeGo.status == .stale)
    }

    @Test func snapshotAgeUsesStrictGreaterThanTenMinuteBoundary() {
        #expect(FailurePolicy.isSnapshotExpired(now.addingTimeInterval(-599), now: now) == false)
        #expect(FailurePolicy.isSnapshotExpired(now.addingTimeInterval(-600), now: now) == false)
        #expect(FailurePolicy.isSnapshotExpired(now.addingTimeInterval(-601), now: now))
    }

    @Test func expiredCachedSnapshotRemainsStaleWhenRecomposed() {
        let cachedAt = now.addingTimeInterval(-601)
        let decision = FailurePolicy().decide(
            codex: .failure(.timeout),
            openCodeGo: .success(.freshGo),
            lastGood: .init(schemaVersion: 1, codex: .fresh(sourceCollectedAt: cachedAt), openCodeGo: nil),
            state: .clean,
            now: now
        )

        #expect(decision.envelope?.data.codex.status == .stale)
        #expect(decision.envelope?.data.codex.summaryLabel == "最后可信 71%")
        #expect(decision.envelope?.data.codex.sourceCollectedAt == cachedAt)
    }
}

private extension SanitizedLastGood {
    static let empty = Self(schemaVersion: 1, codex: nil, openCodeGo: nil)
    static let bothFresh = Self(schemaVersion: 1, codex: .freshCodex, openCodeGo: .freshGo)
}

private extension CollectorRuntimeState {
    static let clean = Self(
        schemaVersion: 1,
        codexFailures: 0,
        openCodeGoFailures: 0,
        simultaneousFailures: 0,
        lastSuccessAt: nil,
        lastPushAt: nil,
        providerStatuses: [:],
        lastErrorCodes: [:]
    )

    static let oneSimultaneousFailure: Self = {
        var state = clean
        state.simultaneousFailures = 1
        return state
    }()
}

private extension CodexDisplaySnapshot {
    static let freshCodex = fresh(sourceCollectedAt: Date(timeIntervalSince1970: 1_786_523_100))

    static func fresh(sourceCollectedAt: Date) -> Self {
        Self(
            status: .ok,
            sourceCollectedAt: sourceCollectedAt,
            headerLeft: "CODEX · PROLITE",
            summaryLabel: "最低剩余 71%",
            rolling: .init(label: "5 小时", remainingPercent: 81, valueText: "剩余 81%", resetAt: sourceCollectedAt.addingTimeInterval(1_800)),
            weekly: .init(label: "本周", remainingPercent: 71, valueText: "剩余 71%", resetAt: sourceCollectedAt.addingTimeInterval(3_600)),
            footerLeft: "周重置 08-12 17:30",
            footerRight: "Credits 128.50"
        )
    }
}

private extension OpenCodeGoDisplaySnapshot {
    static let freshGo = Self(
        status: .ok,
        sourceCollectedAt: Date(timeIntervalSince1970: 1_786_523_400),
        headerLeft: "OPENCODE GO",
        summaryLabel: "最低剩余 71%",
        rolling: .init(label: "5 小时", remainingPercent: 81, valueText: "剩余 81%", resetAt: Date(timeIntervalSince1970: 1_786_525_200)),
        weekly: .init(label: "本周", remainingPercent: 71, valueText: "剩余 71%", resetAt: Date(timeIntervalSince1970: 1_786_527_000)),
        monthly: .init(label: "本月", remainingPercent: 75, valueText: "剩余 75%", resetAt: Date(timeIntervalSince1970: 1_786_530_600)),
        footerLeft: "下次重置 08-12 17:00",
        footerRight: "余额接续 关闭"
    )
}
