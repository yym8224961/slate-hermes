import Foundation

struct MenuBarPresentation: Equatable, Sendable {
    let iconSystemName: String
    let automaticCollectionChecked: Bool
    let automaticCollectionTitle: String
    let codexLine: String
    let openCodeGoLine: String
    let lastPushLine: String
    let busyLine: String?
}

enum MenuBarBusyState: Equatable, Sendable {
    case switching
    case closing
    case opening
    case collecting

    var displayText: String {
        switch self {
        case .switching: "正在切换"
        case .closing: "正在关闭"
        case .opening: "正在开启"
        case .collecting: "正在采集"
        }
    }
}

struct MenuBarStatusSnapshot: Equatable, Sendable {
    let codexSummary: String
    let openCodeGoSummary: String
    let lastSuccessAt: Date?
    let lastPushAt: Date?
    let publicErrorCodes: [String: String]

    static let unavailable = Self(
        codexSummary: "无可信数据",
        openCodeGoSummary: "无可信数据",
        lastSuccessAt: nil,
        lastPushAt: nil,
        publicErrorCodes: ["cache": "cache_unavailable"]
    )
}

protocol MenuBarStatusReading: Sendable {
    func readStatus() throws -> MenuBarStatusSnapshot
}

struct SnapshotMenuBarStatusReader: MenuBarStatusReading, Sendable {
    private let snapshots: any SnapshotPersisting

    init(snapshots: any SnapshotPersisting) {
        self.snapshots = snapshots
    }

    func readStatus() throws -> MenuBarStatusSnapshot {
        let snapshot = try snapshots.loadSnapshot()
        return MenuBarStatusSnapshot(
            codexSummary: Self.codexSummary(
                snapshot: snapshot.lastGood.codex,
                status: snapshot.runtimeState.providerStatuses["codex"]
            ),
            openCodeGoSummary: Self.openCodeGoSummary(
                snapshot: snapshot.lastGood.openCodeGo,
                status: snapshot.runtimeState.providerStatuses["opencode_go"]
            ),
            lastSuccessAt: snapshot.runtimeState.lastSuccessAt,
            lastPushAt: snapshot.runtimeState.lastPushAt,
            publicErrorCodes: snapshot.runtimeState.lastErrorCodes
        )
    }

    private static func codexSummary(
        snapshot: CodexDisplaySnapshot?,
        status: ProviderStatus?
    ) -> String {
        guard let snapshot,
              let remaining = trustedRemaining(in: [snapshot.rolling, snapshot.weekly]) else {
            return "无可信数据"
        }
        return providerSummary(status: status ?? snapshot.status, remaining: remaining)
    }

    private static func openCodeGoSummary(
        snapshot: OpenCodeGoDisplaySnapshot?,
        status: ProviderStatus?
    ) -> String {
        guard let snapshot,
              let remaining = trustedRemaining(in: [
                  snapshot.rolling, snapshot.weekly, snapshot.monthly,
              ]) else {
            return "无可信数据"
        }
        return providerSummary(status: status ?? snapshot.status, remaining: remaining)
    }

    private static func trustedRemaining(in windows: [QuotaWindow]) -> Int? {
        windows
            .filter { $0.valueText != "未提供" }
            .map(\.remainingPercent)
            .min()
    }

    private static func providerSummary(status: ProviderStatus, remaining: Int) -> String {
        let percent = min(max(remaining, 0), 100)
        switch status {
        case .ok: return "正常 · 剩余 \(percent)%"
        case .attention: return "注意 · 剩余 \(percent)%"
        case .critical: return "紧急 · 剩余 \(percent)%"
        case .exhausted: return "已耗尽 · 剩余 \(percent)%"
        case .stale: return "数据过期 · 最后可信 \(percent)%"
        case .unauthenticated, .unconfigured, .unavailable: return "无可信数据"
        }
    }
}

struct MenuBarViewModel: Sendable {
    func presentation(
        snapshot: MenuBarStatusSnapshot,
        schedule: AutomaticCollectionStatus,
        busy: MenuBarBusyState?,
        now: Date = Date()
    ) -> MenuBarPresentation {
        let enabled = Self.isEnabled(schedule)
        let icon: String
        if !enabled {
            icon = "pause.circle"
        } else if !snapshot.publicErrorCodes.isEmpty {
            icon = "exclamationmark.triangle"
        } else {
            icon = "chart.bar.fill"
        }

        return MenuBarPresentation(
            iconSystemName: icon,
            automaticCollectionChecked: enabled,
            automaticCollectionTitle: "每 5 分钟自动采集",
            codexLine: Self.safeProviderSummary(snapshot.codexSummary),
            openCodeGoLine: Self.safeProviderSummary(snapshot.openCodeGoSummary),
            lastPushLine: Self.dateText(snapshot.lastPushAt, now: now),
            busyLine: busy?.displayText
        )
    }

    static func isEnabled(_ schedule: AutomaticCollectionStatus) -> Bool {
        switch schedule {
        case .enabledLoaded, .enabledNotLoaded: true
        case .disabled, .transitioning: false
        }
    }

    static func safeProviderSummary(_ value: String) -> String {
        if value == "无可信数据" { return value }

        let prefixes = [
            "正常 · 剩余 ", "注意 · 剩余 ", "紧急 · 剩余 ",
            "已耗尽 · 剩余 ", "数据过期 · 最后可信 ",
        ]
        for prefix in prefixes where value.hasPrefix(prefix) {
            let suffix = value.dropFirst(prefix.count)
            guard suffix.hasSuffix("%"),
                  let percent = Int(suffix.dropLast()),
                  (0 ... 100).contains(percent) else {
                return "无可信数据"
            }
            return "\(prefix)\(percent)%"
        }
        return "无可信数据"
    }

    static func safePublicCode(_ value: String) -> String {
        guard !value.isEmpty, value.count <= 64 else { return "internal_failure" }
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789_")
        guard value.unicodeScalars.allSatisfy(allowed.contains) else {
            return "internal_failure"
        }
        return value
    }

    static func dateText(_ value: Date?, now: Date = Date()) -> String {
        guard let value else { return "尚未推送" }
        let calendar = shanghaiCalendar
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.timeZone = calendar.timeZone
        if calendar.isDate(value, inSameDayAs: now) {
            formatter.dateFormat = "'今天' HH:mm"
        } else {
            formatter.dateFormat = "MM-dd HH:mm"
        }
        return formatter.string(from: value)
    }

    private static var shanghaiCalendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Shanghai")!
        return calendar
    }
}
