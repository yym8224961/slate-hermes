import Foundation

struct OpenCodeGoCollectionReport: Sendable {
    let envelope: OpenCodeGoSlateEnvelope?
    let pushed: Bool
    let receipt: SlateIngestReceipt?
    let readbackVerified: Bool
    let publicErrorCodes: [String: String]
}

struct OpenCodeGoCollectorService: Sendable {
    typealias Now = @Sendable () -> Date

    private let openCodeGo: any OpenCodeGoUsageReading
    private let normalizer: QuotaNormalizer
    private let secrets: any SecretStoring
    private let snapshots: any SnapshotPersisting
    private let slate: any OpenCodeGoSlateIngesting
    private let openCodeKeyAccount: String
    private let slateURLAccount: String
    private let now: Now

    init(
        openCodeGo: any OpenCodeGoUsageReading,
        normalizer: QuotaNormalizer,
        secrets: any SecretStoring,
        snapshots: any SnapshotPersisting,
        slate: any OpenCodeGoSlateIngesting,
        openCodeKeyAccount: String,
        slateURLAccount: String,
        now: @escaping Now = Date.init
    ) {
        self.openCodeGo = openCodeGo
        self.normalizer = normalizer
        self.secrets = secrets
        self.snapshots = snapshots
        self.slate = slate
        self.openCodeKeyAccount = openCodeKeyAccount
        self.slateURLAccount = slateURLAccount
        self.now = now
    }

    func collect(mode: CollectionMode) async throws -> OpenCodeGoCollectionReport {
        var persisted: CollectorSnapshot
        do {
            persisted = try snapshots.loadSnapshot()
        } catch {
            return report(code: ["cache": cacheCode(error)])
        }

        let outcome: ProviderOutcome<OpenCodeGoDisplaySnapshot>
        do {
            let key = try secrets.read(account: openCodeKeyAccount)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !key.isEmpty else { throw OpenCodeGoSetupError.unconfigured }
            let raw = try await openCodeGo.read(apiKey: key)
            outcome = .success(normalizer.openCodeGo(raw, collectedAt: now()))
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as OpenCodeGoClientError {
            outcome = .failure(Self.failure(error))
        } catch {
            outcome = .failure(.unconfigured)
        }

        let generatedAt = now()
        let decision = decide(
            outcome: outcome,
            cached: persisted.lastGood.openCodeGo,
            state: persisted.runtimeState,
            now: generatedAt
        )
        persisted.lastGood.openCodeGo = decision.lastGood
        persisted.runtimeState = decision.runtimeState
        do {
            try snapshots.saveSnapshot(persisted)
        } catch {
            return report(code: ["cache": cacheCode(error)])
        }

        guard let display = decision.display else {
            return report(code: decision.runtimeState.lastErrorCodes)
        }
        let envelope = OpenCodeGoSlateEnvelope(data: OpenCodeGoDashboardData(
            schemaVersion: 1,
            generatedAt: generatedAt,
            opencodeGo: display
        ))
        guard mode == .pushOnce, decision.shouldPush else {
            return OpenCodeGoCollectionReport(
                envelope: envelope,
                pushed: false,
                receipt: nil,
                readbackVerified: false,
                publicErrorCodes: decision.runtimeState.lastErrorCodes
            )
        }

        let endpoint: URL
        do {
            let text = try secrets.read(account: slateURLAccount)
            guard let parsed = URL(string: text), parsed.absoluteString == text else {
                throw SlateEndpointError.invalidEndpoint
            }
            endpoint = parsed
        } catch {
            var codes = decision.runtimeState.lastErrorCodes
            codes["slate_opencode_go"] = slateCode(error, missingIsUnconfigured: true)
            return OpenCodeGoCollectionReport(
                envelope: envelope,
                pushed: false,
                receipt: nil,
                readbackVerified: false,
                publicErrorCodes: codes
            )
        }

        let receipt: SlateIngestReceipt
        do {
            receipt = sanitized(try await slate.push(envelope, capabilityURL: endpoint))
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            var codes = decision.runtimeState.lastErrorCodes
            codes["slate_opencode_go"] = slateCode(error)
            return OpenCodeGoCollectionReport(
                envelope: envelope,
                pushed: false,
                receipt: nil,
                readbackVerified: false,
                publicErrorCodes: codes
            )
        }

        do {
            let readback = try await slate.readCurrentOpenCodeGoData(capabilityURL: endpoint)
            guard readback == (try wireValue(envelope.data)) else {
                var codes = decision.runtimeState.lastErrorCodes
                codes["slate_opencode_go"] = "slate_readback_mismatch"
                return OpenCodeGoCollectionReport(
                    envelope: envelope,
                    pushed: true,
                    receipt: receipt,
                    readbackVerified: false,
                    publicErrorCodes: codes
                )
            }
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            var codes = decision.runtimeState.lastErrorCodes
            codes["slate_opencode_go"] = slateCode(error)
            return OpenCodeGoCollectionReport(
                envelope: envelope,
                pushed: true,
                receipt: receipt,
                readbackVerified: false,
                publicErrorCodes: codes
            )
        }

        persisted.runtimeState.lastPushAt = now()
        do {
            try snapshots.saveSnapshot(persisted)
        } catch {
            var codes = decision.runtimeState.lastErrorCodes
            codes["cache"] = cacheCode(error)
            return OpenCodeGoCollectionReport(
                envelope: envelope,
                pushed: true,
                receipt: receipt,
                readbackVerified: true,
                publicErrorCodes: codes
            )
        }
        return OpenCodeGoCollectionReport(
            envelope: envelope,
            pushed: true,
            receipt: receipt,
            readbackVerified: true,
            publicErrorCodes: decision.runtimeState.lastErrorCodes
        )
    }

    private func decide(
        outcome: ProviderOutcome<OpenCodeGoDisplaySnapshot>,
        cached: OpenCodeGoDisplaySnapshot?,
        state: CollectorRuntimeState,
        now: Date
    ) -> OpenCodeDecision {
        var runtime = state
        switch outcome {
        case let .success(value):
            runtime.openCodeGoFailures = 0
            runtime.providerStatuses["opencode_go"] = value.status
            runtime.lastErrorCodes.removeValue(forKey: "opencode_go")
            runtime.lastSuccessAt = now
            return OpenCodeDecision(
                display: value,
                lastGood: value,
                runtimeState: runtime,
                shouldPush: true
            )
        case let .failure(failure):
            runtime.openCodeGoFailures += 1
            runtime.lastErrorCodes["opencode_go"] = failure.publicCodeForOpenCodeGo
            guard let cached else {
                runtime.providerStatuses["opencode_go"] = failure == .unconfigured
                    ? .unconfigured : .unavailable
                return OpenCodeDecision(
                    display: nil,
                    lastGood: nil,
                    runtimeState: runtime,
                    shouldPush: false
                )
            }
            let stale = QuotaNormalizer.staleOpenCodeGo(from: cached, now: now)
            runtime.providerStatuses["opencode_go"] = .stale
            return OpenCodeDecision(
                display: stale,
                lastGood: cached,
                runtimeState: runtime,
                shouldPush: runtime.openCodeGoFailures >= 2
            )
        }
    }

    private func report(code: [String: String]) -> OpenCodeGoCollectionReport {
        OpenCodeGoCollectionReport(
            envelope: nil,
            pushed: false,
            receipt: nil,
            readbackVerified: false,
            publicErrorCodes: code
        )
    }

    private func wireValue(_ value: OpenCodeGoDashboardData) throws -> OpenCodeGoDashboardData {
        let bytes = try JSONEncoder.slate.encode(value)
        return try JSONDecoder.slate.decode(OpenCodeGoDashboardData.self, from: bytes)
    }

    private func sanitized(_ value: SlateIngestReceipt) -> SlateIngestReceipt {
        SlateIngestReceipt(
            id: "redacted",
            imageEtag: "redacted",
            manifestEtag: "redacted",
            renderedAt: value.renderedAt
        )
    }

    private func cacheCode(_ error: any Error) -> String {
        (error as? SnapshotCacheError)?.publicCode ?? "cache_io"
    }

    private func slateCode(_ error: any Error, missingIsUnconfigured: Bool = false) -> String {
        if missingIsUnconfigured, error is KeychainError || error is OpenCodeGoSetupError {
            return "slate_unconfigured"
        }
        if error is SlateEndpointError { return "slate_endpoint_invalid" }
        return (error as? SlateIngestError)?.publicCode ?? "slate_transport_unknown"
    }

    private static func failure(_ error: OpenCodeGoClientError) -> ProviderFailure {
        switch error {
        case .unauthorized: .unauthenticated
        case .subscriptionRequired: .subscriptionRequired
        case .rateLimited: .rateLimited
        case .server: .server
        case .timeout: .timeout
        case .transport: .transport(publicCode: "transport_error")
        case .invalidResponse: .invalidData
        case let .http(status): .transport(publicCode: "http_\(status)")
        }
    }
}

private struct OpenCodeDecision: Sendable {
    let display: OpenCodeGoDisplaySnapshot?
    let lastGood: OpenCodeGoDisplaySnapshot?
    let runtimeState: CollectorRuntimeState
    let shouldPush: Bool
}

private enum OpenCodeGoSetupError: Error { case unconfigured }

private extension ProviderFailure {
    var publicCodeForOpenCodeGo: String {
        switch self {
        case .timeout: "timeout"
        case .unauthenticated: "unauthenticated"
        case .unconfigured: "unconfigured"
        case .subscriptionRequired: "subscription_required"
        case .rateLimited: "rate_limited"
        case .server: "server"
        case .invalidData: "invalid_data"
        case let .transport(publicCode):
            PublicErrorCode.isValid(publicCode) ? publicCode : "transport"
        }
    }
}
