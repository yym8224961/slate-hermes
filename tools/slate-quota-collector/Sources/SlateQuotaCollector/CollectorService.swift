import Foundation

enum CollectionMode: Sendable {
    case dryRun
    case pushOnce
}

struct CollectionReport: Sendable {
    let envelope: SlateEnvelope?
    let pushed: Bool
    let receipt: SlateIngestReceipt?
    let readbackVerified: Bool
    let publicErrorCodes: [String: String]
}

enum CollectorError: Error, Equatable, Sendable, CustomStringConvertible {
    case overallTimeout
    case cacheLoad(publicCode: String)
    case internalFailure

    var description: String {
        switch self {
        case .overallTimeout:
            "CollectorError(code: overall_timeout)"
        case let .cacheLoad(publicCode):
            "CollectorError(code: \(publicCode))"
        case .internalFailure:
            "CollectorError(code: internal_failure)"
        }
    }
}

struct CollectorService: Sendable {
    typealias Now = @Sendable () -> Date
    typealias DeadlineSleep = @Sendable (Duration) async throws -> Void

    private let codex: any CodexRateLimitReading
    private let openCodeGo: any OpenCodeGoUsageReading
    private let normalizer: QuotaNormalizer
    private let secrets: any SecretStoring
    private let snapshots: any SnapshotPersisting
    private let failurePolicy: FailurePolicy
    private let slate: any SlateIngesting
    private let openCodeKeyAccount: String
    private let slateURLAccount: String
    private let now: Now
    private let deadlineSleep: DeadlineSleep
    private let overallTimeout: Duration

    init(
        codex: any CodexRateLimitReading,
        openCodeGo: any OpenCodeGoUsageReading,
        normalizer: QuotaNormalizer,
        secrets: any SecretStoring,
        snapshots: any SnapshotPersisting,
        failurePolicy: FailurePolicy,
        slate: any SlateIngesting,
        openCodeKeyAccount: String,
        slateURLAccount: String,
        now: @escaping Now = Date.init,
        deadlineSleep: @escaping DeadlineSleep = { try await Task.sleep(for: $0) },
        overallTimeout: Duration = .seconds(45)
    ) {
        self.codex = codex
        self.openCodeGo = openCodeGo
        self.normalizer = normalizer
        self.secrets = secrets
        self.snapshots = snapshots
        self.failurePolicy = failurePolicy
        self.slate = slate
        self.openCodeKeyAccount = openCodeKeyAccount
        self.slateURLAccount = slateURLAccount
        self.now = now
        self.deadlineSleep = deadlineSleep
        self.overallTimeout = overallTimeout
    }

    /// Owns both the collection and deadline tasks until they have terminated.
    /// Production dependencies are cancellation-cooperative and independently
    /// bounded to 20/10/15 seconds, so cancellation cannot leave side effects
    /// running after this method returns.
    func collect(mode: CollectionMode) async throws -> CollectionReport {
        let deadlineToken = CollectorDeadlineToken()
        let result = await withTaskGroup(
            of: CollectorRaceResult.self,
            returning: CollectorRaceResult.self
        ) { group in
            group.addTask {
                do {
                    return .workSucceeded(try await collectWithoutDeadline(
                        mode: mode,
                        deadlineToken: deadlineToken
                    ))
                } catch let error as CollectorError {
                    return .workFailed(error)
                } catch is CancellationError {
                    return .cancelled
                } catch {
                    return .workFailed(.internalFailure)
                }
            }
            group.addTask {
                do {
                    try await deadlineSleep(overallTimeout)
                    try Task.checkCancellation()
                    deadlineToken.expire()
                    return .deadline
                } catch is CancellationError {
                    return .cancelled
                } catch {
                    deadlineToken.expire()
                    return .deadline
                }
            }

            var first = await group.next() ?? .cancelled
            if case .cancelled = first {
                first = await group.next() ?? .cancelled
            }
            group.cancelAll()
            while await group.next() != nil {}
            return first
        }

        return try result.get()
    }

    private func collectWithoutDeadline(
        mode: CollectionMode,
        deadlineToken: CollectorDeadlineToken
    ) async throws -> CollectionReport {
        try deadlineToken.checkActive()
        let persistedSnapshot: CollectorSnapshot
        do {
            persistedSnapshot = try snapshots.loadSnapshot()
        } catch {
            throw CollectorError.cacheLoad(publicCode: Self.cachePublicCode(error))
        }
        try deadlineToken.checkActive()

        let credential: Result<String, ProviderFailure>
        do {
            let value = try secrets.read(account: openCodeKeyAccount)
            credential = value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? .failure(.unconfigured)
                : .success(value)
        } catch {
            credential = .failure(.unconfigured)
        }
        try deadlineToken.checkActive()

        async let codexRaw = readCodex()
        async let openCodeRaw = readOpenCodeGo(credential: credential)
        let (rawCodex, rawOpenCode) = try await (codexRaw, openCodeRaw)
        try deadlineToken.checkActive()

        let collectedAt = now()
        let decision = failurePolicy.decide(
            codex: normalizeCodex(rawCodex, collectedAt: collectedAt),
            openCodeGo: normalizeOpenCodeGo(rawOpenCode, collectedAt: collectedAt),
            lastGood: persistedSnapshot.lastGood,
            state: persistedSnapshot.runtimeState,
            now: collectedAt
        )

        do {
            try deadlineToken.performIfActive {
                try snapshots.saveSnapshot(CollectorSnapshot(
                    schemaVersion: 1,
                    lastGood: decision.lastGood,
                    runtimeState: decision.runtimeState
                ))
            }
        } catch {
            if error is CancellationError { throw error }
            return CollectionReport(
                envelope: nil,
                pushed: false,
                receipt: nil,
                readbackVerified: false,
                publicErrorCodes: ["cache": Self.cachePublicCode(error)]
            )
        }
        try deadlineToken.checkActive()

        let providerCodes = decision.runtimeState.lastErrorCodes
        guard mode == .pushOnce, decision.shouldPush, let envelope = decision.envelope else {
            return CollectionReport(
                envelope: decision.envelope,
                pushed: false,
                receipt: nil,
                readbackVerified: false,
                publicErrorCodes: providerCodes
            )
        }

        let capabilityURL: URL
        do {
            let value = try secrets.read(account: slateURLAccount)
            guard let parsed = URL(string: value), parsed.absoluteString == value else {
                throw SlateEndpointError.invalidEndpoint
            }
            capabilityURL = parsed
        } catch {
            if error is CancellationError { throw error }
            return report(
                envelope: envelope,
                pushed: false,
                receipt: nil,
                verified: false,
                providerCodes: providerCodes,
                slateCode: Self.slatePublicCode(error, missingIsUnconfigured: true)
            )
        }
        try deadlineToken.checkActive()

        let rawReceipt: SlateIngestReceipt
        do {
            try deadlineToken.checkActive()
            rawReceipt = try await slate.push(envelope, capabilityURL: capabilityURL)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            return report(
                envelope: envelope,
                pushed: false,
                receipt: nil,
                verified: false,
                providerCodes: providerCodes,
                slateCode: Self.slatePublicCode(error)
            )
        }
        try deadlineToken.checkActive()
        let receipt = Self.sanitizedReceipt(rawReceipt)

        let readback: SlateDashboardData
        do {
            try deadlineToken.checkActive()
            readback = try await slate.readCurrentData(capabilityURL: capabilityURL)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            return report(
                envelope: envelope,
                pushed: true,
                receipt: receipt,
                verified: false,
                providerCodes: providerCodes,
                slateCode: Self.slatePublicCode(error)
            )
        }
        try deadlineToken.checkActive()

        guard readback == envelope.data else {
            return report(
                envelope: envelope,
                pushed: true,
                receipt: receipt,
                verified: false,
                providerCodes: providerCodes,
                slateCode: "slate_readback_mismatch"
            )
        }

        var verifiedState = decision.runtimeState
        verifiedState.lastPushAt = now()
        do {
            try deadlineToken.performIfActive {
                try snapshots.saveSnapshot(CollectorSnapshot(
                    schemaVersion: 1,
                    lastGood: decision.lastGood,
                    runtimeState: verifiedState
                ))
            }
        } catch {
            if error is CancellationError { throw error }
            var codes = providerCodes
            codes["cache"] = Self.cachePublicCode(error)
            return CollectionReport(
                envelope: envelope,
                pushed: true,
                receipt: receipt,
                readbackVerified: true,
                publicErrorCodes: codes
            )
        }
        try deadlineToken.checkActive()

        return CollectionReport(
            envelope: envelope,
            pushed: true,
            receipt: receipt,
            readbackVerified: true,
            publicErrorCodes: providerCodes
        )
    }

    private func readCodex() async throws -> ProviderOutcome<CodexRateLimitsReadResult> {
        do {
            return .success(try await codex.read())
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as CodexClientError {
            let failure: ProviderFailure = switch error {
            case .timeout: .timeout
            case .rpc: .unauthenticated
            case .invalidResponse: .invalidData
            case .launchFailed: .transport(publicCode: "launch_failed")
            case .inputFailed: .transport(publicCode: "input_failed")
            }
            return .failure(failure)
        } catch is DecodingError {
            return .failure(.invalidData)
        } catch {
            return .failure(.transport(publicCode: "transport"))
        }
    }

    private func readOpenCodeGo(
        credential: Result<String, ProviderFailure>
    ) async throws -> ProviderOutcome<OpenCodeGoUsageResponse> {
        let apiKey: String
        switch credential {
        case let .success(value): apiKey = value
        case let .failure(failure): return .failure(failure)
        }

        do {
            return .success(try await openCodeGo.read(apiKey: apiKey))
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as OpenCodeGoClientError {
            let failure: ProviderFailure = switch error {
            case .unauthorized: .unconfigured
            case .subscriptionRequired: .subscriptionRequired
            case .rateLimited: .rateLimited
            case .server: .server
            case .timeout: .timeout
            case .transport: .transport(publicCode: "transport_error")
            case let .http(status): .transport(publicCode: "http_\(status)")
            }
            return .failure(failure)
        } catch is DecodingError {
            return .failure(.invalidData)
        } catch {
            return .failure(.transport(publicCode: "transport"))
        }
    }

    private func normalizeCodex(
        _ outcome: ProviderOutcome<CodexRateLimitsReadResult>,
        collectedAt: Date
    ) -> ProviderOutcome<CodexDisplaySnapshot> {
        switch outcome {
        case let .success(value): .success(normalizer.codex(value, collectedAt: collectedAt))
        case let .failure(failure): .failure(failure)
        }
    }

    private func normalizeOpenCodeGo(
        _ outcome: ProviderOutcome<OpenCodeGoUsageResponse>,
        collectedAt: Date
    ) -> ProviderOutcome<OpenCodeGoDisplaySnapshot> {
        switch outcome {
        case let .success(value): .success(normalizer.openCodeGo(value, collectedAt: collectedAt))
        case let .failure(failure): .failure(failure)
        }
    }

    private func report(
        envelope: SlateEnvelope,
        pushed: Bool,
        receipt: SlateIngestReceipt?,
        verified: Bool,
        providerCodes: [String: String],
        slateCode: String
    ) -> CollectionReport {
        var codes = providerCodes
        codes["slate"] = slateCode
        return CollectionReport(
            envelope: envelope,
            pushed: pushed,
            receipt: receipt,
            readbackVerified: verified,
            publicErrorCodes: codes
        )
    }

    private static func cachePublicCode(_ error: any Error) -> String {
        (error as? SnapshotCacheError)?.publicCode ?? "cache_io"
    }

    private static func slatePublicCode(
        _ error: any Error,
        missingIsUnconfigured: Bool = false
    ) -> String {
        if let error = error as? SlateIngestError { return error.publicCode }
        if let error = error as? SlateEndpointError { return error.publicCode }
        return missingIsUnconfigured ? "slate_unconfigured" : "slate_transport_unknown"
    }

    private static func sanitizedReceipt(_ receipt: SlateIngestReceipt) -> SlateIngestReceipt {
        SlateIngestReceipt(
            id: "redacted",
            imageEtag: receipt.imageEtag,
            manifestEtag: receipt.manifestEtag,
            renderedAt: receipt.renderedAt
        )
    }
}

private enum CollectorRaceResult: Sendable {
    case workSucceeded(CollectionReport)
    case workFailed(CollectorError)
    case deadline
    case cancelled

    func get() throws -> CollectionReport {
        switch self {
        case let .workSucceeded(report): return report
        case let .workFailed(error): throw error
        case .deadline: throw CollectorError.overallTimeout
        case .cancelled: throw CancellationError()
        }
    }
}

private final class CollectorDeadlineToken: @unchecked Sendable {
    private let stateLock = NSLock()
    private let sideEffectLock = NSLock()
    private var expired = false

    func expire() {
        stateLock.withLock { expired = true }
    }

    func checkActive() throws {
        try Task.checkCancellation()
        guard stateLock.withLock({ !expired }) else { throw CancellationError() }
    }

    func performIfActive<T>(_ operation: () throws -> T) throws -> T {
        try Task.checkCancellation()
        return try sideEffectLock.withLock {
            guard stateLock.withLock({ !expired }), !Task.isCancelled else {
                throw CancellationError()
            }
            return try operation()
        }
    }
}
