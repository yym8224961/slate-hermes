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

    var description: String {
        switch self {
        case .overallTimeout:
            "CollectorError(code: overall_timeout)"
        case let .cacheLoad(publicCode):
            "CollectorError(code: \(publicCode))"
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

    /// Races the collection against an unstructured deadline. The loser is
    /// cancelled, but is deliberately not awaited: a misbehaving transport
    /// therefore cannot extend the externally observable hard deadline.
    func collect(mode: CollectionMode) async throws -> CollectionReport {
        let workTask = Task { try await collectWithoutDeadline(mode: mode) }
        let deadlineTask = Task<CollectionReport, any Error> {
            try await deadlineSleep(overallTimeout)
            try Task.checkCancellation()
            throw CollectorError.overallTimeout
        }

        return try await withTaskCancellationHandler {
            do {
                let report = try await withCheckedThrowingContinuation {
                    (continuation: CheckedContinuation<CollectionReport, any Error>) in
                    let race = CollectorRace(continuation)
                    Task {
                        do {
                            if race.resolve(.success(try await workTask.value)) {
                                deadlineTask.cancel()
                            }
                        } catch {
                            if race.resolve(.failure(error)) {
                                deadlineTask.cancel()
                            }
                        }
                    }
                    Task {
                        do {
                            if race.resolve(.success(try await deadlineTask.value)) {
                                workTask.cancel()
                            }
                        } catch {
                            if race.resolve(.failure(error)) {
                                workTask.cancel()
                            }
                        }
                    }
                }
                workTask.cancel()
                deadlineTask.cancel()
                return report
            } catch {
                workTask.cancel()
                deadlineTask.cancel()
                throw error
            }
        } onCancel: {
            workTask.cancel()
            deadlineTask.cancel()
        }
    }

    private func collectWithoutDeadline(mode: CollectionMode) async throws -> CollectionReport {
        let lastGood: SanitizedLastGood
        let runtimeState: CollectorRuntimeState
        do {
            lastGood = try snapshots.loadLastGood()
            runtimeState = try snapshots.loadRuntimeState()
        } catch {
            throw CollectorError.cacheLoad(publicCode: Self.cachePublicCode(error))
        }

        let credential: Result<String, ProviderFailure>
        do {
            let value = try secrets.read(account: openCodeKeyAccount)
            credential = value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? .failure(.unconfigured)
                : .success(value)
        } catch {
            credential = .failure(.unconfigured)
        }

        async let codexRaw = readCodex()
        async let openCodeRaw = readOpenCodeGo(credential: credential)
        let (rawCodex, rawOpenCode) = try await (codexRaw, openCodeRaw)
        try Task.checkCancellation()

        let collectedAt = now()
        let decision = failurePolicy.decide(
            codex: normalizeCodex(rawCodex, collectedAt: collectedAt),
            openCodeGo: normalizeOpenCodeGo(rawOpenCode, collectedAt: collectedAt),
            lastGood: lastGood,
            state: runtimeState,
            now: collectedAt
        )

        do {
            try snapshots.saveLastGood(decision.lastGood)
            try snapshots.saveRuntimeState(decision.runtimeState)
        } catch {
            return CollectionReport(
                envelope: nil,
                pushed: false,
                receipt: nil,
                readbackVerified: false,
                publicErrorCodes: ["cache": Self.cachePublicCode(error)]
            )
        }

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
            return report(
                envelope: envelope,
                pushed: false,
                receipt: nil,
                verified: false,
                providerCodes: providerCodes,
                slateCode: Self.slatePublicCode(error, missingIsUnconfigured: true)
            )
        }

        let rawReceipt: SlateIngestReceipt
        do {
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
        let receipt = Self.sanitizedReceipt(rawReceipt)

        let readback: SlateDashboardData
        do {
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
            try snapshots.saveRuntimeState(verifiedState)
        } catch {
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

private final class CollectorRace<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Value, any Error>?

    init(_ continuation: CheckedContinuation<Value, any Error>) {
        self.continuation = continuation
    }

    @discardableResult
    func resolve(_ result: Result<Value, any Error>) -> Bool {
        let continuation = lock.withLock {
            defer { self.continuation = nil }
            return self.continuation
        }
        continuation?.resume(with: result)
        return continuation != nil
    }
}
