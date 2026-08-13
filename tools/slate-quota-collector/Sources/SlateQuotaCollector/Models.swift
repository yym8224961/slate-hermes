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

struct SlateDashboardData: Codable, Equatable, Sendable {
    let schemaVersion: Int
    let generatedAt: Date
    let codex: CodexDisplaySnapshot
    let opencodeGo: OpenCodeGoDisplaySnapshot

    enum CodingKeys: String, CodingKey {
        case schemaVersion, generatedAt, codex
        case opencodeGo = "opencode_go"
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

    var selectedCodexLimit: CodexRateLimit? {
        rateLimitsByLimitId["codex"] ?? (rateLimits?.limitId == "codex" ? rateLimits : nil)
    }

    var selectedCodexCredits: CodexCredits? {
        selectedCodexLimit?.credits ?? credits
    }

    var selectedCodexPlanType: String? {
        selectedCodexLimit?.planType ?? planType
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
            )
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
