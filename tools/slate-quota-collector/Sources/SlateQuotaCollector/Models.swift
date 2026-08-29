import Foundation

enum ProviderStatus: String, Codable, Sendable {
    case ok, attention, critical, exhausted, stale
    case unauthenticated, unconfigured, unavailable
}

enum ProviderFailure: Error, Equatable, Sendable {
    case timeout, unauthenticated, unconfigured, subscriptionRequired
    case rateLimited, server, invalidData
    case transport(publicCode: String)
}

enum PublicErrorCode {
    static func isValid(_ value: String) -> Bool {
        guard !value.isEmpty, value.count <= 64 else { return false }
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789_")
        return value.unicodeScalars.allSatisfy(allowed.contains)
    }
}

struct QuotaWindow: Codable, Equatable, Sendable {
    let label: String
    let remainingPercent: Int
    let valueText: String
    let resetAt: Date?
}

struct CodexDisplaySnapshot: Codable, Equatable, Sendable {
    let status: ProviderStatus
    let sourceCollectedAt: Date
    let headerLeft: String
    let summaryLabel: String
    let rolling: QuotaWindow
    let weekly: QuotaWindow
    let footerLeft: String
    let footerRight: String
    var resetCredits: Int = 0
}

struct OpenCodeGoDisplaySnapshot: Codable, Equatable, Sendable {
    let status: ProviderStatus
    let sourceCollectedAt: Date
    let headerLeft: String
    let summaryLabel: String
    let rolling: QuotaWindow
    let weekly: QuotaWindow
    let monthly: QuotaWindow
    let footerLeft: String
    let footerRight: String
}

struct CodexQuotaPanelWindow: Codable, Equatable, Sendable {
    let name: String
    let remainingPercent: Int
    let remainingText: String
    let usedText: String
    let resetText: String
    let singleOneDigit: Bool
    let singleTwoDigits: Bool
    let singleThreeDigits: Bool
    let dualOneDigit: Bool
    let dualTwoDigits: Bool
    let dualThreeDigits: Bool
}

struct CodexQuotaPanel: Codable, Equatable, Sendable {
    let singleWindow: Bool
    let dualWindow: Bool
    let dateLabel: String
    let heading: String
    let primary: CodexQuotaPanelWindow
    let secondary: CodexQuotaPanelWindow
    let message: String
    let creditsVisible: Bool
    let creditsText: String
}

struct DashboardFooter: Codable, Equatable, Sendable {
    let showDivider: Bool
    let showHidden: Bool
    let showUpdated: Bool
    let hiddenText: String
    let updateText: String
}

struct SlateDashboardData: Codable, Equatable, Sendable {
    let schemaVersion: Int
    let generatedAt: Date
    let codex: CodexDisplaySnapshot
    let opencodeGo: OpenCodeGoDisplaySnapshot
    let quota: CodexQuotaPanel
    let resetRadar: ResetRadarDisplaySnapshot
    let taskActivity: CodexTaskActivityDisplaySnapshot
    let footer: DashboardFooter
    let includesOpenCodeGo: Bool

    enum CodingKeys: String, CodingKey {
        case schemaVersion, generatedAt, codex, quota, resetRadar, taskActivity, footer
        case opencodeGo = "opencode_go"
    }

    init(
        schemaVersion: Int,
        generatedAt: Date,
        codex: CodexDisplaySnapshot,
        opencodeGo: OpenCodeGoDisplaySnapshot,
        resetRadar: ResetRadarDisplaySnapshot = .unavailable,
        taskActivity: CodexTaskActivityDisplaySnapshot = .unavailable,
        includesOpenCodeGo: Bool = true
    ) {
        self.schemaVersion = schemaVersion
        self.generatedAt = generatedAt
        self.codex = codex
        self.opencodeGo = opencodeGo
        quota = CodexDashboardProjection.quota(from: codex, now: generatedAt)
        self.resetRadar = resetRadar
        self.taskActivity = taskActivity
        footer = CodexDashboardProjection.footer(
            now: generatedAt,
            hiddenTaskCount: taskActivity.hiddenCount
        )
        self.includesOpenCodeGo = includesOpenCodeGo
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
        generatedAt = try container.decode(Date.self, forKey: .generatedAt)
        codex = try container.decode(CodexDisplaySnapshot.self, forKey: .codex)
        opencodeGo = try container.decodeIfPresent(OpenCodeGoDisplaySnapshot.self, forKey: .opencodeGo)
            ?? .unavailable(at: generatedAt)
        quota = try container.decodeIfPresent(CodexQuotaPanel.self, forKey: .quota)
            ?? CodexDashboardProjection.quota(from: codex, now: generatedAt)
        resetRadar = try container.decodeIfPresent(ResetRadarDisplaySnapshot.self, forKey: .resetRadar)
            ?? .unavailable
        taskActivity = try container.decodeIfPresent(CodexTaskActivityDisplaySnapshot.self, forKey: .taskActivity)
            ?? .unavailable
        footer = try container.decodeIfPresent(DashboardFooter.self, forKey: .footer)
            ?? CodexDashboardProjection.footer(now: generatedAt, hiddenTaskCount: taskActivity.hiddenCount)
        includesOpenCodeGo = container.contains(.opencodeGo)
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schemaVersion, forKey: .schemaVersion)
        try container.encode(generatedAt, forKey: .generatedAt)
        try container.encode(codex, forKey: .codex)
        if includesOpenCodeGo {
            try container.encode(opencodeGo, forKey: .opencodeGo)
        }
        try container.encode(quota, forKey: .quota)
        try container.encode(resetRadar, forKey: .resetRadar)
        try container.encode(taskActivity, forKey: .taskActivity)
        try container.encode(footer, forKey: .footer)
    }
}

struct SlateEnvelope: Codable, Equatable, Sendable {
    let version: Int
    let data: SlateDashboardData

    init(data: SlateDashboardData) {
        version = 1
        self.data = data
    }
}

struct CodexRateLimitWindow: Codable, Equatable, Sendable {
    let usedPercent: Double
    let windowDurationMins: Int
    let resetsAt: TimeInterval?
}

struct CodexRateLimit: Codable, Equatable, Sendable {
    let limitId: String?
    let primary: CodexRateLimitWindow?
    let secondary: CodexRateLimitWindow?
    let credits: CodexCredits?
    let planType: String?

    init(
        limitId: String?,
        primary: CodexRateLimitWindow?,
        secondary: CodexRateLimitWindow?,
        credits: CodexCredits? = nil,
        planType: String? = nil
    ) {
        self.limitId = limitId
        self.primary = primary
        self.secondary = secondary
        self.credits = credits
        self.planType = planType
    }
}

struct CodexCredits: Codable, Equatable, Sendable {
    let unlimited: Bool
    let balance: Double?

    enum CodingKeys: String, CodingKey { case unlimited, balance }

    init(unlimited: Bool, balance: Double?) {
        self.unlimited = unlimited
        self.balance = balance
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        unlimited = try container.decode(Bool.self, forKey: .unlimited)
        guard container.contains(.balance), !(try container.decodeNil(forKey: .balance)) else {
            balance = nil
            return
        }
        if let value = try? container.decode(Double.self, forKey: .balance), value.isFinite {
            balance = value
            return
        }
        if let text = try? container.decode(String.self, forKey: .balance),
           let value = Double(text), value.isFinite {
            balance = value
            return
        }
        throw DecodingError.dataCorruptedError(forKey: .balance, in: container, debugDescription: "balance must be finite")
    }
}

struct CodexRateLimitsReadResult: Codable, Equatable, Sendable {
    let rateLimits: CodexRateLimit?
    let rateLimitsByLimitId: [String: CodexRateLimit]
    let credits: CodexCredits?
    let planType: String?
    var rateLimitResetCredits: CodexResetCredits? = nil

    var selectedCodexLimit: CodexRateLimit? {
        rateLimitsByLimitId["codex"] ?? (rateLimits?.limitId == "codex" ? rateLimits : nil)
    }

    var selectedCodexCredits: CodexCredits? {
        selectedCodexLimit?.credits ?? credits
    }

    var selectedCodexPlanType: String? {
        selectedCodexLimit?.planType ?? planType
    }

    var strictlyValidatedCodexLimit: CodexRateLimit? {
        guard let limit = selectedCodexLimit,
              let primary = limit.primary,
              primary.isStrictlyValid,
              limit.secondary.map(\.isStrictlyValid) ?? true,
              (rateLimitResetCredits?.availableCount ?? 0) >= 0 else {
            return nil
        }
        return limit
    }
}

struct CodexResetCredits: Codable, Equatable, Sendable {
    let availableCount: Int
}

private extension CodexRateLimitWindow {
    var isStrictlyValid: Bool {
        usedPercent.isFinite
            && usedPercent.rounded(.towardZero) == usedPercent
            && (0 ... 100).contains(usedPercent)
            && windowDurationMins > 0
            && resetsAt.map {
                $0.isFinite && $0.rounded(.towardZero) == $0
            } == true
    }
}

struct OpenCodeGoUsageResponse: Codable, Equatable, Sendable {
    let useBalance: Bool
    let rollingUsage: OpenCodeGoUsageWindow
    let weeklyUsage: OpenCodeGoUsageWindow
    let monthlyUsage: OpenCodeGoUsageWindow
}

struct OpenCodeGoUsageWindow: Codable, Equatable, Sendable {
    enum Status: String, Codable, Sendable { case ok, rateLimited = "rate-limited" }
    let status: Status
    let resetInSec: Double
    let usagePercent: Double
}

struct SlateIngestReceipt: Decodable, Equatable, Sendable {
    let id: String
    let imageEtag: String
    let manifestEtag: String
    let renderedAt: Date
}

struct SanitizedLastGood: Codable, Equatable, Sendable {
    let schemaVersion: Int
    var codex: CodexDisplaySnapshot?
    var openCodeGo: OpenCodeGoDisplaySnapshot?
}

struct CollectorRuntimeState: Codable, Equatable, Sendable {
    let schemaVersion: Int
    var codexFailures: Int
    var openCodeGoFailures: Int
    var simultaneousFailures: Int
    var lastSuccessAt: Date?
    var lastPushAt: Date?
    var providerStatuses: [String: ProviderStatus]
    var lastErrorCodes: [String: String]
}

struct CollectorSnapshot: Codable, Equatable, Sendable {
    let schemaVersion: Int
    var lastGood: SanitizedLastGood
    var runtimeState: CollectorRuntimeState
    var resetRadar: ResetRadarCache? = nil
    var taskActivity: CodexTaskActivityDisplaySnapshot? = nil

    static var empty: Self {
        Self(
            schemaVersion: 1,
            lastGood: SanitizedLastGood(schemaVersion: 1, codex: nil, openCodeGo: nil),
            runtimeState: CollectorRuntimeState(
                schemaVersion: 1,
                codexFailures: 0,
                openCodeGoFailures: 0,
                simultaneousFailures: 0,
                lastSuccessAt: nil,
                lastPushAt: nil,
                providerStatuses: [:],
                lastErrorCodes: [:]
            ),
            resetRadar: nil,
            taskActivity: nil
        )
    }
}

protocol CodexRateLimitReading: Sendable {
    func read() async throws -> CodexRateLimitsReadResult
}

protocol OpenCodeGoUsageReading: Sendable {
    func read(apiKey: String) async throws -> OpenCodeGoUsageResponse
}

protocol SecretStoring: Sendable {
    func read(account: String) throws -> String
    func write(_ value: String, account: String) throws
}

protocol SlateIngesting: Sendable {
    func push(_ envelope: SlateEnvelope, capabilityURL: URL) async throws -> SlateIngestReceipt
    func readCurrentData(capabilityURL: URL) async throws -> SlateDashboardData
}

protocol SnapshotPersisting: Sendable {
    func loadSnapshot() throws -> CollectorSnapshot
    func saveSnapshot(_ value: CollectorSnapshot) throws
}

extension JSONEncoder {
    static var slate: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }
}

extension JSONDecoder {
    static var slate: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}
