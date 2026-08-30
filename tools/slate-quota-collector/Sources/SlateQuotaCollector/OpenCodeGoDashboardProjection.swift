import Foundation

enum OpenCodeGoDashboardProjection {
    private static let timeZone = TimeZone(identifier: "Asia/Shanghai")!

    static func quota(
        from snapshot: OpenCodeGoDisplaySnapshot,
        now: Date
    ) -> OpenCodeGoQuotaPanel {
        OpenCodeGoQuotaPanel(
            dateLabel: dateLabel(now),
            heading: "OpenCode Go 额度",
            primary: window(snapshot.rolling, now: now),
            weekly: window(snapshot.weekly, now: now),
            monthly: window(snapshot.monthly, now: now)
        )
    }

    static func footer(
        from snapshot: OpenCodeGoDisplaySnapshot,
        now: Date
    ) -> OpenCodeGoDashboardFooter {
        OpenCodeGoDashboardFooter(
            balanceText: snapshot.footerRight,
            updateText: "画面更新 \(clockText(now))"
        )
    }

    private static func window(
        _ value: QuotaWindow,
        now: Date
    ) -> OpenCodeGoQuotaPanelWindow {
        let remaining = min(max(value.remainingPercent, 0), 100)
        let digits = String(remaining).count
        return OpenCodeGoQuotaPanelWindow(
            name: value.label,
            remainingPercent: remaining,
            remainingText: "\(remaining)",
            usedText: value.valueText == "未提供" ? "已用 --" : "已用 \(100 - remaining)%",
            resetText: resetText(value.resetAt, now: now),
            oneDigit: digits == 1,
            twoDigits: digits == 2,
            threeDigits: digits >= 3
        )
    }

    private static func resetText(_ resetAt: Date?, now: Date) -> String {
        guard let resetAt else { return "重置 --" }
        let seconds = max(0, Int(resetAt.timeIntervalSince(now)))
        let days = seconds / 86_400
        let hours = (seconds % 86_400) / 3_600
        let minutes = (seconds % 3_600) / 60
        if days > 0 { return "重置 \(days)天 \(hours)小时" }
        if hours > 0 { return "重置 \(hours)小时 \(minutes)分" }
        return "重置 \(minutes)分"
    }

    private static func dateLabel(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.timeZone = timeZone
        formatter.dateFormat = "M月d日 EEE"
        return formatter.string(from: date)
    }

    private static func clockText(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.timeZone = timeZone
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: date)
    }
}
