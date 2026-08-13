import Foundation
import Testing
@testable import SlateQuotaCollector

@Suite struct QuotaNormalizerTests {
    @Test func codexIdentifiesWindowsByDurationAndIgnoresSpark() {
        let raw = CodexRateLimitsReadResult.fixture(
            planType: "prolite",
            codexWindows: [.init(usedPercent: 9, windowDurationMins: 10_080, resetsAt: 1_787_090_794)],
            extraLimits: ["codex_bengalfox": .fixture(usedPercent: 99, duration: 300)]
        )

        let value = QuotaNormalizer.shanghai.codex(raw, collectedAt: .fixtureNow)

        #expect(value.rolling.valueText == "未提供")
        #expect(value.rolling.remainingPercent == 0)
        #expect(value.weekly.remainingPercent == 91)
        #expect(value.headerLeft == "CODEX · PROLITE")
        #expect(value.status == .ok)
        #expect(value.summaryLabel == "最低剩余 91%")
    }

    @Test(arguments: [(79.0, "最低剩余 21%"), (80.0, "注意 · 剩余 20%"), (90.0, "注意 · 剩余 10%"), (91.0, "紧急 · 剩余 9%"), (99.0, "紧急 · 剩余 1%"), (100.0, "已耗尽")])
    func remainingThresholds(used: Double, summary: String) {
        #expect(QuotaNormalizer.summary(forUsedPercent: used, serverLimited: false) == summary)
    }

    @Test func openCodeUsesReceiveTimeForAllThreeResets() {
        let raw = OpenCodeGoUsageResponse.fixture(rollingReset: 3600, weeklyReset: 7200, monthlyReset: 10_800)
        let value = QuotaNormalizer.shanghai.openCodeGo(raw, collectedAt: .fixtureNow)

        #expect(value.rolling.resetAt == .fixtureNow.addingTimeInterval(3600))
        #expect(value.weekly.resetAt == .fixtureNow.addingTimeInterval(7200))
        #expect(value.monthly.resetAt == .fixtureNow.addingTimeInterval(10_800))
        #expect(value.footerLeft == "下次重置 08-12 17:30")
    }

    @Test func openCodeRendersShanghaiResetAcrossMidnight() {
        let value = QuotaNormalizer.shanghai.openCodeGo(
            .fixture(rollingReset: 5_400, weeklyReset: 7_200, monthlyReset: 10_800),
            collectedAt: .shanghaiAugust12At2330
        )

        #expect(value.rolling.resetAt == .shanghaiAugust12At2330.addingTimeInterval(5_400))
        #expect(value.footerLeft == "下次重置 08-13 01:00")
    }

    @Test func openCodeRendersShanghaiResetAcrossMonthBoundary() {
        let value = QuotaNormalizer.shanghai.openCodeGo(
            .fixture(rollingReset: 5_400, weeklyReset: 7_200, monthlyReset: 10_800),
            collectedAt: .shanghaiJanuary31At2330
        )

        #expect(value.rolling.resetAt == .shanghaiJanuary31At2330.addingTimeInterval(5_400))
        #expect(value.footerLeft == "下次重置 02-01 01:00")
    }

    @Test func serverLimitedWinsOverNonzeroRoundedRemaining() {
        #expect(QuotaNormalizer.summary(forUsedPercent: 99.1, serverLimited: true) == "已耗尽")
    }

    @Test func creditsAndBalanceLabelsAreNormalized() {
        #expect(normalizeCredits(.init(unlimited: true, balance: nil)) == "Credits 无限")
        #expect(normalizeCredits(.init(unlimited: false, balance: 128.5)) == "Credits 128.50")
        #expect(normalizeCredits(nil) == "Credits —")
        #expect(normalizeUseBalance(true) == "余额接续 开启")
        #expect(normalizeUseBalance(false) == "余额接续 关闭")
    }

    @Test func codexUsesCreditsAndPlanFromSelectedCurrentLimit() {
        let raw = CodexRateLimitsReadResult(
            rateLimits: nil,
            rateLimitsByLimitId: [
                "codex": CodexRateLimit(
                    limitId: "codex",
                    primary: .init(usedPercent: 19, windowDurationMins: 300, resetsAt: nil),
                    secondary: .init(usedPercent: 29, windowDurationMins: 10_080, resetsAt: nil),
                    credits: .init(unlimited: false, balance: 88.5),
                    planType: "business"
                ),
            ],
            credits: .init(unlimited: false, balance: 1),
            planType: "legacy"
        )

        let value = QuotaNormalizer.shanghai.codex(raw, collectedAt: .fixtureNow)

        #expect(value.headerLeft == "CODEX · BUSINESS")
        #expect(value.footerRight == "Credits 88.50")
        #expect(value.rolling.remainingPercent == 81)
        #expect(value.weekly.remainingPercent == 71)
    }

    @Test func missingCodexWindowsAreUnavailableRatherThanExhausted() {
        let value = QuotaNormalizer.shanghai.codex(.fixture(planType: nil, codexWindows: []), collectedAt: .fixtureNow)

        #expect(value.status == .unavailable)
        #expect(value.summaryLabel == "无可信数据")
        #expect(value.rolling.valueText == "未提供")
        #expect(value.weekly.valueText == "未提供")
    }

    @Test func staleSnapshotsPreserveValuesAndOriginalCollectionTime() {
        let codex = QuotaNormalizer.staleCodex(from: .fixture(), now: .fixtureNow)
        let openCode = QuotaNormalizer.staleOpenCodeGo(from: .fixture(), now: .fixtureNow)

        #expect(codex.status == .stale)
        #expect(codex.sourceCollectedAt == Date(timeIntervalSince1970: 0))
        #expect(codex.headerLeft == "CODEX · 数据过期")
        #expect(codex.summaryLabel == "最后可信 71%")
        #expect(openCode.status == .stale)
        #expect(openCode.sourceCollectedAt == Date(timeIntervalSince1970: 0))
        #expect(openCode.headerLeft == "OPENCODE GO · 数据过期")
        #expect(openCode.summaryLabel == "最后可信 71%")
    }
}

private extension Date {
    static let fixtureNow = Date(timeIntervalSince1970: 1_786_523_400) // 2026-08-12 16:30 Asia/Shanghai
    static let shanghaiAugust12At2330 = Date(timeIntervalSince1970: 1_786_548_600) // 2026-08-12 23:30 Asia/Shanghai
    static let shanghaiJanuary31At2330 = Date(timeIntervalSince1970: 1_769_873_400) // 2026-01-31 23:30 Asia/Shanghai
}

private extension CodexRateLimitsReadResult {
    static func fixture(
        planType: String?,
        codexWindows: [CodexRateLimitWindow],
        extraLimits: [String: CodexRateLimit] = [:]
    ) -> Self {
        let codex = CodexRateLimit(
            limitId: "codex",
            primary: codexWindows.first,
            secondary: codexWindows.dropFirst().first
        )
        return Self(rateLimits: nil, rateLimitsByLimitId: ["codex": codex].merging(extraLimits) { current, _ in current }, credits: nil, planType: planType)
    }
}

private extension CodexRateLimit {
    static func fixture(usedPercent: Double, duration: Int) -> Self {
        Self(limitId: nil, primary: .init(usedPercent: usedPercent, windowDurationMins: duration, resetsAt: nil), secondary: nil)
    }
}

private extension OpenCodeGoUsageResponse {
    static func fixture(rollingReset: Double, weeklyReset: Double, monthlyReset: Double) -> Self {
        Self(
            useBalance: false,
            rollingUsage: .init(status: .ok, resetInSec: rollingReset, usagePercent: 19),
            weeklyUsage: .init(status: .ok, resetInSec: weeklyReset, usagePercent: 29),
            monthlyUsage: .init(status: .ok, resetInSec: monthlyReset, usagePercent: 39)
        )
    }
}
