import Foundation

enum CollectionMode: Sendable {
    case dryRun
    case pushOnce
}

enum CollectorSideEffect: Equatable, Sendable {
    case snapshotLoad
    case openCodeCredentialRead
    case codexRead
    case openCodeRead
    case taskActivityRead
    case resetRadarRead
    case snapshotPublish
    case slateCredentialRead
    case slatePush
    case slateReadback
    case verifiedSnapshotPublish
}

struct CollectionReport: Sendable {
    let envelope: SlateEnvelope?
    let pushed: Bool
    let receipt: SlateIngestReceipt?
    let readbackVerified: Bool
    let publicErrorCodes: [String: String]
}

enum CollectorError: Error, Equatable, Sendable, CustomStringConvertible {
    case collectionDeadlineExceeded
    case cacheLoad(publicCode: String)
    case internalFailure

    var description: String {
        switch self {
        case .collectionDeadlineExceeded:
            "CollectorError(code: collection_deadline_exceeded)"
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
    typealias BeforeSideEffect = @Sendable (CollectorSideEffect) async -> Void
    typealias OnDeadlinePublished = @Sendable () -> Void

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
    private let collectionDeadline: Duration
    private let beforeSideEffect: BeforeSideEffect
    private let onDeadlinePublished: OnDeadlinePublished
    private let codexTaskActivity: (any CodexTaskActivityReading)?
    private let resetRadar: (any ResetRadarReading)?
    private let includeOpenCodeGo: Bool

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
        collectionDeadline: Duration = .seconds(45),
        beforeSideEffect: @escaping BeforeSideEffect = { _ in },
        onDeadlinePublished: @escaping OnDeadlinePublished = {},
        codexTaskActivity: (any CodexTaskActivityReading)? = nil,
        resetRadar: (any ResetRadarReading)? = nil,
        includeOpenCodeGo: Bool = true
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
        self.collectionDeadline = collectionDeadline
        self.beforeSideEffect = beforeSideEffect
        self.onDeadlinePublished = onDeadlinePublished
        self.codexTaskActivity = codexTaskActivity
        self.resetRadar = resetRadar
        self.includeOpenCodeGo = includeOpenCodeGo
    }

    /// Owns both the collection and deadline tasks until they have terminated.
    /// Production dependencies are cancellation-cooperative and independently
    /// bounded to 20/10/15 seconds, so cancellation cannot leave side effects
    /// running after this method returns.
    func collect(mode: CollectionMode) async throws -> CollectionReport {
        let deadlineGate = CollectorDeadlineGate()
        let result = await withTaskGroup(
            of: CollectorTaskResult.self,
            returning: CollectorTaskResult.self
        ) { group in
            group.addTask {
                do {
                    return .workSucceeded(try await collectWithoutDeadline(
                        mode: mode,
                        deadlineGate: deadlineGate
                    ))
                } catch let error as CollectorError {
                    return .workFailed(error)
                } catch is CancellationError {
                    if deadlineGate.isExpired { return .cancelled }
                    return Task.isCancelled ? .cancelled : .workFailed(.internalFailure)
                } catch {
                    return .workFailed(.internalFailure)
                }
            }
            group.addTask {
                do {
                    try await deadlineSleep(collectionDeadline)
                    try Task.checkCancellation()
                    deadlineGate.expire()
                    onDeadlinePublished()
                    return .deadline
                } catch is CancellationError {
                    return .cancelled
                } catch {
                    deadlineGate.expire()
                    onDeadlinePublished()
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
        deadlineGate: CollectorDeadlineGate
    ) async throws -> CollectionReport {
        try deadlineGate.checkActive()
        let persistedSnapshot: CollectorSnapshot
        do {
            await beforeSideEffect(.snapshotLoad)
            persistedSnapshot = try deadlineGate.performSynchronousIfActive {
                try snapshots.loadSnapshot()
            }
        } catch {
            if error is CancellationError { throw error }
            throw CollectorError.cacheLoad(publicCode: Self.cachePublicCode(error))
        }
        try deadlineGate.checkActive()

        let credential: Result<String, ProviderFailure>
        if includeOpenCodeGo {
            do {
                await beforeSideEffect(.openCodeCredentialRead)
                let value = try deadlineGate.performSynchronousIfActive {
                    try secrets.read(account: openCodeKeyAccount)
                }
                credential = value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ? .failure(.unconfigured)
                    : .success(value)
            } catch {
                if error is CancellationError { throw error }
                credential = .failure(.unconfigured)
            }
        } else {
            credential = .failure(.unconfigured)
        }
        try deadlineGate.checkActive()

        let observationNow = now()
        async let codexRaw = readCodex(deadlineGate: deadlineGate)
        async let openCodeRaw = includeOpenCodeGo
            ? readOpenCodeGo(credential: credential, deadlineGate: deadlineGate)
            : ProviderOutcome<OpenCodeGoUsageResponse>.failure(.unconfigured)
        async let taskActivityResult = readTaskActivity(
            cached: persistedSnapshot.taskActivity,
            now: observationNow,
            deadlineGate: deadlineGate
        )
        async let radarResult = readResetRadar(
            cache: persistedSnapshot.resetRadar ?? .empty,
            now: observationNow,
            deadlineGate: deadlineGate
        )
        let (rawCodex, rawOpenCode, taskActivity, radar) = try await (
            codexRaw, openCodeRaw, taskActivityResult, radarResult
        )
        try deadlineGate.checkActive()

        let collectedAt = now()
        let decision = failurePolicy.decide(
            codex: normalizeCodex(rawCodex, collectedAt: collectedAt),
            openCodeGo: normalizeOpenCodeGo(rawOpenCode, collectedAt: collectedAt),
            lastGood: persistedSnapshot.lastGood,
            state: persistedSnapshot.runtimeState,
            now: collectedAt,
            resetRadar: radar.display,
            taskActivity: taskActivity.snapshot,
            resetRadarErrorCode: radar.publicErrorCode,
            taskActivityErrorCode: taskActivity.publicErrorCode,
            includeOpenCodeGo: includeOpenCodeGo
        )

        do {
            await beforeSideEffect(.snapshotPublish)
            try deadlineGate.performSynchronousIfActive {
                try snapshots.saveSnapshot(CollectorSnapshot(
                    schemaVersion: 1,
                    lastGood: decision.lastGood,
                    runtimeState: decision.runtimeState,
                    resetRadar: resetRadar == nil ? persistedSnapshot.resetRadar : radar.cache,
                    taskActivity: codexTaskActivity == nil ? persistedSnapshot.taskActivity : taskActivity.snapshot
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
        try deadlineGate.checkActive()

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
            await beforeSideEffect(.slateCredentialRead)
            let value = try deadlineGate.performSynchronousIfActive {
                try secrets.read(account: slateURLAccount)
            }
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
        try deadlineGate.checkActive()

        let rawReceipt: SlateIngestReceipt
        do {
            await beforeSideEffect(.slatePush)
            rawReceipt = try await deadlineGate.performAsyncIfActive {
                try await slate.push(envelope, capabilityURL: capabilityURL)
            }
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
        try deadlineGate.checkActive()
        let receipt = Self.sanitizedReceipt(rawReceipt)

        let readback: SlateDashboardData
        do {
            await beforeSideEffect(.slateReadback)
            readback = try await deadlineGate.performAsyncIfActive {
                try await slate.readCurrentData(capabilityURL: capabilityURL)
            }
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
        try deadlineGate.checkActive()

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
            await beforeSideEffect(.verifiedSnapshotPublish)
            try deadlineGate.performSynchronousIfActive {
                try snapshots.saveSnapshot(CollectorSnapshot(
                    schemaVersion: 1,
                    lastGood: decision.lastGood,
                    runtimeState: verifiedState,
                    resetRadar: resetRadar == nil ? persistedSnapshot.resetRadar : radar.cache,
                    taskActivity: codexTaskActivity == nil ? persistedSnapshot.taskActivity : taskActivity.snapshot
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
        try deadlineGate.checkActive()

        return CollectionReport(
            envelope: envelope,
            pushed: true,
            receipt: receipt,
            readbackVerified: true,
            publicErrorCodes: providerCodes
        )
    }

    private func readTaskActivity(
        cached: CodexTaskActivityDisplaySnapshot?,
        now: Date,
        deadlineGate: CollectorDeadlineGate
    ) async throws -> TaskActivityCollectionResult {
        guard let codexTaskActivity else {
            return TaskActivityCollectionResult(
                snapshot: cached ?? .unavailable,
                publicErrorCode: nil
            )
        }
        do {
            await beforeSideEffect(.taskActivityRead)
            let value = try await deadlineGate.performAsyncIfActive {
                try await codexTaskActivity.read(now: now)
            }
            return TaskActivityCollectionResult(snapshot: value, publicErrorCode: nil)
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as CodexClientError {
            return TaskActivityCollectionResult(
                snapshot: cached?.markedStale() ?? .unavailable,
                publicErrorCode: Self.codexTaskPublicCode(error)
            )
        } catch {
            return TaskActivityCollectionResult(
                snapshot: cached?.markedStale() ?? .unavailable,
                publicErrorCode: "task_activity_unavailable"
            )
        }
    }

    private func readResetRadar(
        cache: ResetRadarCache,
        now: Date,
        deadlineGate: CollectorDeadlineGate
    ) async throws -> ResetRadarResolution {
        guard let resetRadar else {
            return ResetRadarStateMachine.resolve(cache: cache, fetch: nil, now: now)
        }
        let fetch: ResetRadarFetchResult?
        if ResetRadarStateMachine.shouldFetch(cache: cache, now: now) {
            await beforeSideEffect(.resetRadarRead)
            fetch = try await deadlineGate.performAsyncIfActive {
                await resetRadar.read()
            }
        } else {
            fetch = nil
        }
        return ResetRadarStateMachine.resolve(cache: cache, fetch: fetch, now: now)
    }

    private func readCodex(
        deadlineGate: CollectorDeadlineGate
    ) async throws -> ProviderOutcome<CodexRateLimitsReadResult> {
        do {
            await beforeSideEffect(.codexRead)
            return .success(try await deadlineGate.performAsyncIfActive {
                try await codex.read()
            })
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
        credential: Result<String, ProviderFailure>,
        deadlineGate: CollectorDeadlineGate
    ) async throws -> ProviderOutcome<OpenCodeGoUsageResponse> {
        let apiKey: String
        switch credential {
        case let .success(value): apiKey = value
        case let .failure(failure): return .failure(failure)
        }

        do {
            await beforeSideEffect(.openCodeRead)
            return .success(try await deadlineGate.performAsyncIfActive {
                try await openCodeGo.read(apiKey: apiKey)
            })
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

    private static func codexTaskPublicCode(_ error: CodexClientError) -> String {
        switch error {
        case .timeout: "timeout"
        case .rpc: "unauthenticated"
        case .invalidResponse: "invalid_data"
        case .launchFailed: "launch_failed"
        case .inputFailed: "input_failed"
        }
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
            imageEtag: "redacted",
            manifestEtag: "redacted",
            renderedAt: receipt.renderedAt
        )
    }
}

private struct TaskActivityCollectionResult: Sendable {
    let snapshot: CodexTaskActivityDisplaySnapshot
    let publicErrorCode: String?
}

private enum CollectorTaskResult: Sendable {
    case workSucceeded(CollectionReport)
    case workFailed(CollectorError)
    case deadline
    case cancelled

    func get() throws -> CollectionReport {
        switch self {
        case let .workSucceeded(report): return report
        case let .workFailed(error): throw error
        case .deadline: throw CollectorError.collectionDeadlineExceeded
        case .cancelled: throw CancellationError()
        }
    }
}

private struct CollectorStagePermit: Hashable, Sendable {
    let id: UInt64
}

private final class CollectorDeadlineGate: @unchecked Sendable {
    private let lock = NSLock()
    private var expired = false
    private var nextPermitID: UInt64 = 0
    private var activePermits: Set<CollectorStagePermit> = []

    func expire() {
        lock.withLock { expired = true }
    }

    func checkActive() throws {
        try Task.checkCancellation()
        guard lock.withLock({ !expired }) else { throw CancellationError() }
    }

    var isExpired: Bool { lock.withLock { expired } }

    func performSynchronousIfActive<T>(_ operation: () throws -> T) throws -> T {
        let permit = try beginStage()
        do {
            let value = try operation()
            try finishStage(permit, requireActive: true)
            return value
        } catch {
            try? finishStage(permit, requireActive: false)
            throw error
        }
    }

    func performAsyncIfActive<T: Sendable>(
        _ operation: @Sendable () async throws -> T
    ) async throws -> T {
        let permit = try beginStage()
        do {
            let value = try await operation()
            try finishStage(permit, requireActive: true)
            return value
        } catch {
            try? finishStage(permit, requireActive: false)
            throw error
        }
    }

    private func beginStage() throws -> CollectorStagePermit {
        try Task.checkCancellation()
        return try lock.withLock {
            guard !expired, !Task.isCancelled else { throw CancellationError() }
            nextPermitID &+= 1
            let permit = CollectorStagePermit(id: nextPermitID)
            activePermits.insert(permit)
            return permit
        }
    }

    private func finishStage(
        _ permit: CollectorStagePermit,
        requireActive: Bool
    ) throws {
        let remainsActive = lock.withLock {
            guard activePermits.remove(permit) != nil else { return false }
            return !expired
        }
        guard !requireActive || (remainsActive && !Task.isCancelled) else {
            throw CancellationError()
        }
    }
}
