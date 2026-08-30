import Foundation

struct QuotaNormalizer: Sendable {
    static let shanghai = Self(timeZone: TimeZone(identifier: "Asia/Shanghai")!)

    let timeZone: TimeZone

    func remaining(_ used: Double) -> Int {
        Int(floor(max(0, min(100, 100 - used))))
    }

    func codex(_ raw: CodexRateLimitsReadResult, collectedAt: Date) -> CodexDisplaySnapshot {
        let limit = raw.strictlyValidatedCodexLimit
        let rolling = codexWindow(limit?.primary)
        let weekly = codexWindow(limit?.secondary)
        let credible = [rolling, weekly].filter { $0.valueText != "未提供" }
        let minimum = credible.map(\.remainingPercent).min()

        return CodexDisplaySnapshot(
            status: minimum.map { Self.status(remaining: $0, serverLimited: false) } ?? .unavailable,
            sourceCollectedAt: collectedAt,
            headerLeft: "CODEX · \((raw.selectedCodexPlanType ?? "未提供").uppercased())",
            summaryLabel: minimum.map { Self.summary(remaining: $0, serverLimited: false) } ?? "无可信数据",
            rolling: rolling,
            weekly: weekly,
            footerLeft: weekly.resetAt.map { "周重置 \(dateText($0))" } ?? "周重置 --",
            footerRight: normalizeCredits(raw.selectedCodexCredits),
            resetCredits: limit == nil ? 0 : (raw.rateLimitResetCredits?.availableCount ?? 0)
        )
    }

    func openCodeGo(_ raw: OpenCodeGoUsageResponse, collectedAt: Date) -> OpenCodeGoDisplaySnapshot {
        let rolling = openCodeWindow(raw.rollingUsage, label: "5 小时", collectedAt: collectedAt)
        let weekly = openCodeWindow(raw.weeklyUsage, label: "本周", collectedAt: collectedAt)
        let monthly = openCodeWindow(raw.monthlyUsage, label: "本月", collectedAt: collectedAt)
        let windows = [rolling, weekly, monthly]
        let serverLimited = [raw.rollingUsage, raw.weeklyUsage, raw.monthlyUsage].contains { $0.status == .rateLimited }
        let minimum = windows.map(\.remainingPercent).min()!
        let nextReset = windows.compactMap(\.resetAt).min()

        return OpenCodeGoDisplaySnapshot(
            status: Self.status(remaining: minimum, serverLimited: serverLimited),
            sourceCollectedAt: collectedAt,
            headerLeft: "OPENCODE GO",
            summaryLabel: Self.summary(remaining: minimum, serverLimited: serverLimited),
            rolling: rolling,
            weekly: weekly,
            monthly: monthly,
            footerLeft: nextReset.map { "下次重置 \(dateText($0))" } ?? "下次重置 --",
            footerRight: "官方用量 API"
        )
    }

    static func staleCodex(from snapshot: CodexDisplaySnapshot, now: Date) -> CodexDisplaySnapshot {
        _ = now
        return CodexDisplaySnapshot(
            status: .stale,
            sourceCollectedAt: snapshot.sourceCollectedAt,
            headerLeft: "CODEX · 数据过期",
            summaryLabel: staleSummary(snapshot.rolling, snapshot.weekly),
            rolling: snapshot.rolling,
            weekly: snapshot.weekly,
            footerLeft: snapshot.footerLeft,
            footerRight: snapshot.footerRight,
            resetCredits: snapshot.resetCredits
        )
    }

    static func staleOpenCodeGo(from snapshot: OpenCodeGoDisplaySnapshot, now: Date) -> OpenCodeGoDisplaySnapshot {
        _ = now
        return OpenCodeGoDisplaySnapshot(
            status: .stale,
            sourceCollectedAt: snapshot.sourceCollectedAt,
            headerLeft: "OPENCODE GO · 数据过期",
            summaryLabel: staleSummary(snapshot.rolling, snapshot.weekly, snapshot.monthly),
            rolling: snapshot.rolling,
            weekly: snapshot.weekly,
            monthly: snapshot.monthly,
            footerLeft: snapshot.footerLeft,
            footerRight: snapshot.footerRight
        )
    }

    static func status(remaining: Int, serverLimited: Bool) -> ProviderStatus {
        if serverLimited || remaining == 0 { return .exhausted }
        if remaining <= 9 { return .critical }
        if remaining <= 20 { return .attention }
        return .ok
    }

    static func summary(remaining: Int, serverLimited: Bool) -> String {
        switch status(remaining: remaining, serverLimited: serverLimited) {
        case .exhausted: return "已耗尽"
        case .critical: return "紧急 · 剩余 \(remaining)%"
        case .attention: return "注意 · 剩余 \(remaining)%"
        default: return "最低剩余 \(remaining)%"
        }
    }

    static func summary(forUsedPercent used: Double, serverLimited: Bool) -> String {
        summary(remaining: Int(floor(max(0, min(100, 100 - used)))), serverLimited: serverLimited)
    }

    private func codexWindow(_ raw: CodexRateLimitWindow?) -> QuotaWindow {
        guard let raw, raw.windowDurationMins > 0 else {
            return QuotaWindow(label: "", remainingPercent: 0, valueText: "未提供", resetAt: nil)
        }
        let remaining = remaining(raw.usedPercent)
        let resetAt = raw.resetsAt.map(Date.init(timeIntervalSince1970:))
        return QuotaWindow(
            label: codexWindowLabel(raw.windowDurationMins),
            remainingPercent: remaining,
            valueText: "剩余 \(remaining)%",
            resetAt: resetAt
        )
    }

    private func codexWindowLabel(_ durationMinutes: Int) -> String {
        if durationMinutes.isMultiple(of: 24 * 60) {
            return "\(durationMinutes / (24 * 60)) 天"
        }
        if durationMinutes.isMultiple(of: 60) {
            return "\(durationMinutes / 60) 小时"
        }
        return "\(durationMinutes) 分钟"
    }

    private func openCodeWindow(_ raw: OpenCodeGoUsageWindow, label: String, collectedAt: Date) -> QuotaWindow {
        let remaining = remaining(raw.usagePercent)
        _ = collectedAt
        return QuotaWindow(label: label, remainingPercent: remaining, valueText: "剩余 \(remaining)%", resetAt: raw.resetAt)
    }

    private func dateText(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.timeZone = timeZone
        formatter.dateFormat = "MM-dd HH:mm"
        return formatter.string(from: date)
    }

    private static func staleSummary(_ windows: QuotaWindow...) -> String {
        guard let minimum = windows.filter({ $0.valueText != "未提供" }).map(\.remainingPercent).min() else {
            return "无可信数据"
        }
        return "最后可信 \(minimum)%"
    }
}

func normalizeCredits(_ credits: CodexCredits?) -> String {
    guard let credits else { return "Credits —" }
    if credits.unlimited { return "Credits 无限" }
    guard let balance = credits.balance else { return "Credits —" }
    return String(format: "Credits %.2f", locale: Locale(identifier: "en_US_POSIX"), balance)
}
