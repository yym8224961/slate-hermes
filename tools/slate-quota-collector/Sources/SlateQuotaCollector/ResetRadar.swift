import Foundation

enum ResetRadarKind: String, Codable, Equatable, Sendable {
    case regular
    case resetCredit = "reset_credit"
}

struct ResetRadarConfirmation: Codable, Equatable, Sendable {
    let kind: ResetRadarKind
    let announcedAt: Date
}

struct ResetRadarWatch: Codable, Equatable, Sendable {
    let resetChancePercent: Int?
    let forecastWindow: String
    let observedAt: Date
    let expiresAt: Date
}

struct ResetRadarSemanticState: Codable, Equatable, Sendable {
    var latestReset: ResetRadarConfirmation?
    var activeWatch: ResetRadarWatch?

    static let empty = Self(latestReset: nil, activeWatch: nil)
}

struct ResetRadarParsedStatus: Equatable, Sendable {
    let semantic: ResetRadarSemanticState
    let explicitNoWatch: Bool
    let hasInvalidCapability: Bool

    var hasUsableCapability: Bool {
        explicitNoWatch || semantic.latestReset != nil || semantic.activeWatch != nil
    }
}

enum ResetRadarDisplayStatus: String, Codable, Equatable, Sendable {
    case unavailable
    case noActiveWatch = "no_active_watch"
    case activeWatch = "active_watch"
    case confirmedRegular = "confirmed_regular"
    case confirmedCredit = "confirmed_credit"
}

struct ResetRadarDisplaySnapshot: Codable, Equatable, Sendable {
    let status: ResetRadarDisplayStatus
    let title: String
    let headline: String
    let shortLabel: String
    let detail: String
    let signalPercent: Int
    let resetChancePercent: Int?
    let stale: Bool
    let sourceObservedAt: Date?
    var statusText: String = "雷达信号丢失"
    var showProbability: Bool = false
    var probabilityText: String = ""
    var showNarrowGauge: Bool = false
    var showWideGauge: Bool = true

    static let unavailable = Self(
        status: .unavailable,
        title: "非官方重置雷达",
        headline: "雷达信号丢失",
        shortLabel: "雷达 --",
        detail: "公开信号暂不可用",
        signalPercent: 0,
        resetChancePercent: nil,
        stale: false,
        sourceObservedAt: nil
    )
}

struct ResetRadarCache: Codable, Equatable, Sendable {
    var semantic: ResetRadarSemanticState
    var noWatchFreshUntil: Date?
    var nextFetchAt: Date?
    var latestRequestFailed: Bool

    static let empty = Self(
        semantic: .empty,
        noWatchFreshUntil: nil,
        nextFetchAt: nil,
        latestRequestFailed: false
    )

    func validate() throws {
        if let confirmation = semantic.latestReset,
           confirmation.announcedAt.timeIntervalSince1970.isFinite == false {
            throw SnapshotCacheError.cacheCorrupt
        }
        if let watch = semantic.activeWatch {
            guard !watch.forecastWindow.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  watch.resetChancePercent.map({ (0 ... 100).contains($0) }) ?? true,
                  watch.observedAt < watch.expiresAt else {
                throw SnapshotCacheError.cacheCorrupt
            }
        }
        for date in [noWatchFreshUntil, nextFetchAt].compactMap({ $0 })
            where date.timeIntervalSince1970.isFinite == false {
            throw SnapshotCacheError.cacheCorrupt
        }
    }
}

enum ResetRadarFetchReason: String, Codable, Equatable, Sendable {
    case network
    case rateLimited = "rate_limited"
    case upstreamUnavailable = "upstream_unavailable"
    case invalidResponse = "invalid_response"
    case responseTooLarge = "response_too_large"
}

enum ResetRadarFetchResult: Equatable, Sendable {
    case modified(ResetRadarParsedStatus)
    case notModified
    case failed(reason: ResetRadarFetchReason, retryAfterSeconds: Int?)
}

protocol ResetRadarReading: Sendable {
    func read() async -> ResetRadarFetchResult
}

struct ResetRadarResolution: Equatable, Sendable {
    let cache: ResetRadarCache
    let display: ResetRadarDisplaySnapshot
    let publicErrorCode: String?
}

enum ResetRadarStateMachine {
    static let pollInterval: TimeInterval = 60 * 60
    private static let noWatchFreshness: TimeInterval = 2 * 60 * 60
    private static let confirmationFreshness: TimeInterval = 24 * 60 * 60

    static func shouldFetch(cache: ResetRadarCache, now: Date) -> Bool {
        guard let nextFetchAt = cache.nextFetchAt else { return true }
        return now >= nextFetchAt
    }

    static func resolve(
        cache initialCache: ResetRadarCache,
        fetch: ResetRadarFetchResult?,
        now: Date
    ) -> ResetRadarResolution {
        var cache = initialCache
        var publicErrorCode: String?

        switch fetch {
        case let .modified(parsed):
            cache.semantic = parsed.semantic
            cache.noWatchFreshUntil = parsed.explicitNoWatch
                ? now.addingTimeInterval(noWatchFreshness)
                : nil
            cache.nextFetchAt = now.addingTimeInterval(pollInterval)
            cache.latestRequestFailed = false
            if parsed.hasInvalidCapability { publicErrorCode = ResetRadarFetchReason.invalidResponse.rawValue }
        case .notModified:
            if cache.noWatchFreshUntil != nil {
                cache.noWatchFreshUntil = now.addingTimeInterval(noWatchFreshness)
            }
            cache.nextFetchAt = now.addingTimeInterval(pollInterval)
            cache.latestRequestFailed = false
        case let .failed(reason, retryAfterSeconds):
            let retry = max(pollInterval, TimeInterval(max(retryAfterSeconds ?? 0, 0)))
            cache.nextFetchAt = now.addingTimeInterval(retry)
            cache.latestRequestFailed = true
            publicErrorCode = reason.rawValue
        case nil:
            break
        }

        return ResetRadarResolution(
            cache: cache,
            display: display(cache: cache, now: now),
            publicErrorCode: publicErrorCode
        )
    }

    private static func display(cache: ResetRadarCache, now: Date) -> ResetRadarDisplaySnapshot {
        let confirmation = cache.semantic.latestReset.flatMap { value -> ResetRadarConfirmation? in
            let age = now.timeIntervalSince(value.announcedAt)
            return age >= 0 && age < confirmationFreshness ? value : nil
        }
        let watch = cache.semantic.activeWatch.flatMap { value -> ResetRadarWatch? in
            value.observedAt <= now && now < value.expiresAt ? value : nil
        }

        if let watch,
           confirmation.map({ watch.observedAt > $0.announcedAt }) ?? true {
            let percent = watch.resetChancePercent
            return ResetRadarDisplaySnapshot(
                status: .activeWatch,
                title: "非官方重置雷达",
                headline: "活跃预测",
                shortLabel: percent.map { "雷达 \($0)%" } ?? "雷达 预测",
                detail: watch.forecastWindow,
                signalPercent: percent ?? 0,
                resetChancePercent: percent,
                stale: cache.latestRequestFailed,
                sourceObservedAt: watch.observedAt,
                statusText: watch.forecastWindow,
                showProbability: percent != nil,
                probabilityText: percent.map { "\($0)%" } ?? "",
                showNarrowGauge: percent != nil,
                showWideGauge: percent == nil
            )
        }

        if let confirmation {
            let status: ResetRadarDisplayStatus = confirmation.kind == .regular
                ? .confirmedRegular
                : .confirmedCredit
            return ResetRadarDisplaySnapshot(
                status: status,
                title: "非官方重置雷达",
                headline: confirmation.kind == .regular ? "普通重置已确认" : "重置额度已确认",
                shortLabel: confirmation.kind == .regular ? "雷达 已重置" : "雷达 +额度",
                detail: "公开确认 · 24 小时内有效",
                signalPercent: 100,
                resetChancePercent: nil,
                stale: cache.latestRequestFailed,
                sourceObservedAt: confirmation.announcedAt,
                statusText: confirmation.kind == .regular ? "普通重置已确认" : "重置额度已确认"
            )
        }

        if let freshUntil = cache.noWatchFreshUntil, now <= freshUntil {
            return ResetRadarDisplaySnapshot(
                status: .noActiveWatch,
                title: "非官方重置雷达",
                headline: "暂无活跃预测",
                shortLabel: "雷达 无预测",
                detail: "最近检查未发现有效预测",
                signalPercent: 0,
                resetChancePercent: nil,
                stale: false,
                sourceObservedAt: freshUntil.addingTimeInterval(-noWatchFreshness),
                statusText: "暂无活跃预测"
            )
        }

        return .unavailable
    }
}

enum ResetRadarParseError: Error, Equatable, Sendable {
    case invalidJSON
    case invalidEnvelope
}

enum ResetRadarParser {
    static func parse(_ data: Data) throws -> ResetRadarParsedStatus {
        let root: Any
        do { root = try JSONSerialization.jsonObject(with: data) }
        catch { throw ResetRadarParseError.invalidJSON }
        guard let object = root as? [String: Any],
              let payload = object["data"] as? [String: Any],
              payload.keys.contains("latest_reset"),
              payload.keys.contains("active_watch") else {
            throw ResetRadarParseError.invalidEnvelope
        }

        let latestValue = payload["latest_reset"]!
        let watchValue = payload["active_watch"]!
        let latestReset = parseConfirmation(latestValue)
        let activeWatch = parseWatch(watchValue)
        let latestIsNull = latestValue is NSNull
        let watchIsNull = watchValue is NSNull

        return ResetRadarParsedStatus(
            semantic: ResetRadarSemanticState(
                latestReset: latestReset,
                activeWatch: activeWatch
            ),
            explicitNoWatch: watchIsNull,
            hasInvalidCapability: (!latestIsNull && latestReset == nil)
                || (!watchIsNull && activeWatch == nil)
        )
    }

    private static func parseConfirmation(_ raw: Any) -> ResetRadarConfirmation? {
        guard !(raw is NSNull), let object = raw as? [String: Any],
              let resetType = object["reset_type"] as? String,
              let announcedText = object["announced_at"] as? String,
              let announcedAt = parseDate(announcedText) else { return nil }
        let kind: ResetRadarKind
        switch resetType {
        case "regular": kind = .regular
        case "banked": kind = .resetCredit
        default: return nil
        }
        return ResetRadarConfirmation(kind: kind, announcedAt: announcedAt)
    }

    private static func parseWatch(_ raw: Any) -> ResetRadarWatch? {
        guard !(raw is NSNull), let object = raw as? [String: Any],
              let level = object["level"] as? String,
              level == "elevated" || level == "strong",
              let forecast = (object["forecast_window"] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines),
              !forecast.isEmpty,
              let observedText = object["observed_at"] as? String,
              let expiresText = object["expires_at"] as? String,
              let observedAt = parseDate(observedText),
              let expiresAt = parseDate(expiresText),
              observedAt < expiresAt,
              object.keys.contains("reset_chance_percent") else { return nil }

        let chance: Int?
        if object["reset_chance_percent"] is NSNull {
            chance = nil
        } else if let number = object["reset_chance_percent"] as? NSNumber,
                  CFGetTypeID(number) != CFBooleanGetTypeID(),
                  CFNumberIsFloatType(number) == false,
                  (0 ... 100).contains(number.intValue) {
            chance = number.intValue
        } else {
            return nil
        }

        return ResetRadarWatch(
            resetChancePercent: chance,
            forecastWindow: forecast,
            observedAt: observedAt,
            expiresAt: expiresAt
        )
    }

    private static func parseDate(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        let ordinary = ISO8601DateFormatter()
        ordinary.formatOptions = [.withInternetDateTime]
        return ordinary.date(from: value)
    }
}
