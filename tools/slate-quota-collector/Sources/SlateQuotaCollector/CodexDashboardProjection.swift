import Foundation

enum CodexDashboardProjection {
    private static let shanghai = TimeZone(identifier: "Asia/Shanghai")!

    static func quota(from snapshot: CodexDisplaySnapshot, now: Date) -> CodexQuotaPanel {
        var windows: [QuotaWindow] = []
        if snapshot.rolling.valueText != "未提供" { windows.append(snapshot.rolling) }
        if snapshot.weekly.valueText != "未提供" { windows.append(snapshot.weekly) }
        if windows.isEmpty {
            windows = [QuotaWindow(label: "Codex", remainingPercent: 0, valueText: "未提供", resetAt: nil)]
        }
        if windows.count > 2 { windows = Array(windows.prefix(2)) }

        let singleWindow = windows.count == 1
        let primary = panelWindow(windows[0], now: now, singleMode: singleWindow, visible: true)
        let secondary = windows.count == 2
            ? panelWindow(windows[1], now: now, singleMode: false, visible: true)
            : panelWindow(
                QuotaWindow(label: "", remainingPercent: 0, valueText: "未提供", resetAt: nil),
                now: now,
                singleMode: false,
                visible: false
            )
        let lowestRemaining = windows.map(\.remainingPercent).min() ?? 0
        let date = dateLabel(now)

        return CodexQuotaPanel(
            singleWindow: singleWindow,
            dualWindow: windows.count == 2,
            dateLabel: snapshot.status == .stale ? "数据旧  \(date)" : date,
            heading: "\(windowName(windows[0].label))额度",
            primary: primary,
            secondary: secondary,
            message: quotaMessage(lowestRemaining),
            creditsVisible: snapshot.resetCredits > 0,
            creditsText: snapshot.resetCredits > 0 ? "重置额度 \(snapshot.resetCredits)" : ""
        )
    }

    static func footer(now: Date, hiddenTaskCount: Int) -> DashboardFooter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.timeZone = shanghai
        formatter.dateFormat = "HH:mm"
        return DashboardFooter(
            showDivider: true,
            showHidden: hiddenTaskCount > 0,
            showUpdated: true,
            hiddenText: hiddenTaskCount > 0 ? "另有 \(hiddenTaskCount) 项" : "",
            updateText: "画面更新 \(formatter.string(from: now))"
        )
    }

    private static func panelWindow(
        _ window: QuotaWindow,
        now: Date,
        singleMode: Bool,
        visible: Bool
    ) -> CodexQuotaPanelWindow {
        let remaining = max(0, min(100, window.remainingPercent))
        let digits = String(remaining).count
        return CodexQuotaPanelWindow(
            name: windowName(window.label),
            remainingPercent: remaining,
            remainingText: String(remaining),
            usedText: "已用 \(100 - remaining)%",
            resetText: resetLabel(window.resetAt, now: now),
            singleOneDigit: visible && singleMode && digits == 1,
            singleTwoDigits: visible && singleMode && digits == 2,
            singleThreeDigits: visible && singleMode && digits >= 3,
            dualOneDigit: visible && !singleMode && digits == 1,
            dualTwoDigits: visible && !singleMode && digits == 2,
            dualThreeDigits: visible && !singleMode && digits >= 3
        )
    }

    private static func windowName(_ label: String) -> String {
        switch label {
        case "本周": "7 天"
        default: label
        }
    }

    private static func resetLabel(_ resetAt: Date?, now: Date) -> String {
        guard let resetAt else { return "重置 --" }
        let seconds = max(0, resetAt.timeIntervalSince(now))
        let totalMinutes = Int(ceil(seconds / 60))
        let days = totalMinutes / 1_440
        let hours = totalMinutes % 1_440 / 60
        let minutes = totalMinutes % 60
        var parts: [String] = []
        if days > 0 { parts.append("\(days)天") }
        if days > 0 || hours > 0 { parts.append("\(hours)小时") }
        parts.append("\(minutes)分")
        return "重置 \(parts.joined(separator: " "))"
    }

    private static func dateLabel(_ date: Date) -> String {
        let calendar = Calendar(identifier: .gregorian)
        var configured = calendar
        configured.timeZone = shanghai
        let parts = configured.dateComponents([.month, .day, .weekday], from: date)
        let weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]
        let weekday = parts.weekday.flatMap { weekdays.indices.contains($0 - 1) ? weekdays[$0 - 1] : nil } ?? "周几"
        return "\(parts.month ?? 0)月\(parts.day ?? 0)日 \(weekday)"
    }

    private static func quotaMessage(_ remaining: Int) -> String {
        switch remaining {
        case 81 ... 100: "站起来蹬！"
        case 51 ... 80: "还能蹬，别急着坐下。"
        case 31 ... 50: "悠着点蹬，链条开始响了。"
        case 11 ... 30: "省着点，车快散架了。"
        default: "就等Tibo重置了。"
        }
    }
}

extension OpenCodeGoDisplaySnapshot {
    static func unavailable(at date: Date) -> Self {
        let unavailable = QuotaWindow(label: "", remainingPercent: 0, valueText: "未提供", resetAt: nil)
        return Self(
            status: .unavailable,
            sourceCollectedAt: date,
            headerLeft: "",
            summaryLabel: "",
            rolling: unavailable,
            weekly: unavailable,
            monthly: unavailable,
            footerLeft: "",
            footerRight: ""
        )
    }
}
