import Foundation

enum ProviderOutcome<Value: Sendable>: Sendable {
    case success(Value)
    case failure(ProviderFailure)
}

struct CollectionDecision: Sendable {
    let envelope: SlateEnvelope?
    let shouldPush: Bool
    let lastGood: SanitizedLastGood
    let runtimeState: CollectorRuntimeState
}

struct FailurePolicy: Sendable {
    static let maximumSnapshotAge: TimeInterval = 600

    func decide(
        codex: ProviderOutcome<CodexDisplaySnapshot>,
        openCodeGo: ProviderOutcome<OpenCodeGoDisplaySnapshot>,
        lastGood: SanitizedLastGood,
        state: CollectorRuntimeState,
        now: Date,
        resetRadar: ResetRadarDisplaySnapshot = .unavailable,
        taskActivity: CodexTaskActivityDisplaySnapshot = .unavailable,
        resetRadarErrorCode: String? = nil,
        taskActivityErrorCode: String? = nil,
        includeOpenCodeGo: Bool = true
    ) -> CollectionDecision {
        var updatedLastGood = lastGood
        var updatedState = state

        let codexSucceeded = codex.isSuccess
        let openCodeGoSucceeded = includeOpenCodeGo && openCodeGo.isSuccess

        let codexDisplay = displayCodex(
            outcome: codex,
            cached: lastGood.codex,
            now: now,
            update: &updatedLastGood,
            state: &updatedState
        )
        let openCodeGoDisplay: OpenCodeGoDisplaySnapshot
        if includeOpenCodeGo {
            openCodeGoDisplay = displayOpenCodeGo(
                outcome: openCodeGo,
                cached: lastGood.openCodeGo,
                now: now,
                update: &updatedLastGood,
                state: &updatedState
            )
        } else {
            openCodeGoDisplay = .unavailable(at: now)
            updatedState.openCodeGoFailures = 0
            updatedState.providerStatuses.removeValue(forKey: "opencode_go")
            updatedState.lastErrorCodes.removeValue(forKey: "opencode_go")
        }

        updatedState.providerStatuses["reset_radar"] = resetRadar.stale
            ? .stale
            : (resetRadar.status == .unavailable ? .unavailable : .ok)
        updatedState.providerStatuses["task_activity"] = taskActivity.stale
            ? .stale
            : (taskActivity.availability == .unavailable ? .unavailable : .ok)
        Self.updateErrorCode(
            resetRadarErrorCode,
            key: "reset_radar",
            state: &updatedState
        )
        Self.updateErrorCode(
            taskActivityErrorCode,
            key: "task_activity",
            state: &updatedState
        )

        if codexSucceeded || openCodeGoSucceeded {
            updatedState.simultaneousFailures = 0
            updatedState.lastSuccessAt = now
        } else {
            updatedState.simultaneousFailures += 1
        }

        let shouldPush = codexSucceeded || openCodeGoSucceeded || updatedState.simultaneousFailures >= 2
        let envelope = shouldPush ? SlateEnvelope(data: .init(
            schemaVersion: 1,
            generatedAt: now,
            codex: codexDisplay,
            opencodeGo: openCodeGoDisplay,
            resetRadar: resetRadar,
            taskActivity: taskActivity,
            includesOpenCodeGo: includeOpenCodeGo
        )) : nil

        return CollectionDecision(
            envelope: envelope,
            shouldPush: shouldPush,
            lastGood: updatedLastGood,
            runtimeState: updatedState
        )
    }

    private static func updateErrorCode(
        _ code: String?,
        key: String,
        state: inout CollectorRuntimeState
    ) {
        if let code, PublicErrorCode.isValid(code) {
            state.lastErrorCodes[key] = code
        } else {
            state.lastErrorCodes.removeValue(forKey: key)
        }
    }

    private func displayCodex(
        outcome: ProviderOutcome<CodexDisplaySnapshot>,
        cached: CodexDisplaySnapshot?,
        now: Date,
        update lastGood: inout SanitizedLastGood,
        state: inout CollectorRuntimeState
    ) -> CodexDisplaySnapshot {
        switch outcome {
        case let .success(snapshot):
            lastGood.codex = snapshot
            state.codexFailures = 0
            state.providerStatuses["codex"] = Self.isSnapshotExpired(snapshot.sourceCollectedAt, now: now) ? .stale : snapshot.status
            state.lastErrorCodes.removeValue(forKey: "codex")
            return Self.isSnapshotExpired(snapshot.sourceCollectedAt, now: now)
                ? QuotaNormalizer.staleCodex(from: snapshot, now: now)
                : snapshot
        case let .failure(failure):
            state.codexFailures += 1
            state.lastErrorCodes["codex"] = failure.publicCode
            let snapshot = cached.map { QuotaNormalizer.staleCodex(from: $0, now: now) }
                ?? noDataCodex(for: failure, now: now)
            state.providerStatuses["codex"] = snapshot.status
            return snapshot
        }
    }

    private func displayOpenCodeGo(
        outcome: ProviderOutcome<OpenCodeGoDisplaySnapshot>,
        cached: OpenCodeGoDisplaySnapshot?,
        now: Date,
        update lastGood: inout SanitizedLastGood,
        state: inout CollectorRuntimeState
    ) -> OpenCodeGoDisplaySnapshot {
        switch outcome {
        case let .success(snapshot):
            lastGood.openCodeGo = snapshot
            state.openCodeGoFailures = 0
            state.providerStatuses["opencode_go"] = Self.isSnapshotExpired(snapshot.sourceCollectedAt, now: now) ? .stale : snapshot.status
            state.lastErrorCodes.removeValue(forKey: "opencode_go")
            return Self.isSnapshotExpired(snapshot.sourceCollectedAt, now: now)
                ? QuotaNormalizer.staleOpenCodeGo(from: snapshot, now: now)
                : snapshot
        case let .failure(failure):
            state.openCodeGoFailures += 1
            state.lastErrorCodes["opencode_go"] = failure.publicCode
            let snapshot = cached.map { QuotaNormalizer.staleOpenCodeGo(from: $0, now: now) }
                ?? noDataOpenCodeGo(for: failure, now: now)
            state.providerStatuses["opencode_go"] = snapshot.status
            return snapshot
        }
    }

    static func isSnapshotExpired(_ sourceCollectedAt: Date, now: Date) -> Bool {
        now.timeIntervalSince(sourceCollectedAt) > Self.maximumSnapshotAge
    }

    private func noDataCodex(for failure: ProviderFailure, now: Date) -> CodexDisplaySnapshot {
        let isUnauthenticated = failure == .unauthenticated
        return CodexDisplaySnapshot(
            status: isUnauthenticated ? .unauthenticated : .unavailable,
            sourceCollectedAt: now,
            headerLeft: isUnauthenticated ? "CODEX · 未登录" : "CODEX · 无法获取",
            summaryLabel: "无可信数据",
            rolling: unavailableWindow(label: "5 小时"),
            weekly: unavailableWindow(label: "本周"),
            footerLeft: "周重置 --",
            footerRight: "Credits —"
        )
    }

    private func noDataOpenCodeGo(for failure: ProviderFailure, now: Date) -> OpenCodeGoDisplaySnapshot {
        let headerAndStatus: (String, ProviderStatus)
        switch failure {
        case .unauthenticated, .unconfigured:
            headerAndStatus = ("OPENCODE GO · 未配置", .unconfigured)
        case .subscriptionRequired:
            headerAndStatus = ("OPENCODE GO · 无 Go 订阅", .unavailable)
        default:
            headerAndStatus = ("OPENCODE GO · 无法获取", .unavailable)
        }
        return OpenCodeGoDisplaySnapshot(
            status: headerAndStatus.1,
            sourceCollectedAt: now,
            headerLeft: headerAndStatus.0,
            summaryLabel: "无可信数据",
            rolling: unavailableWindow(label: "5 小时"),
            weekly: unavailableWindow(label: "本周"),
            monthly: unavailableWindow(label: "本月"),
            footerLeft: "下次重置 --",
            footerRight: "余额接续 未提供"
        )
    }

    private func unavailableWindow(label: String) -> QuotaWindow {
        QuotaWindow(label: label, remainingPercent: 0, valueText: "未提供", resetAt: nil)
    }
}

private extension ProviderOutcome {
    var isSuccess: Bool {
        if case .success = self { return true }
        return false
    }
}

private extension ProviderFailure {
    var publicCode: String {
        switch self {
        case .timeout: return "timeout"
        case .unauthenticated: return "unauthenticated"
        case .unconfigured: return "unconfigured"
        case .subscriptionRequired: return "subscription_required"
        case .rateLimited: return "rate_limited"
        case .server: return "server"
        case .invalidData: return "invalid_data"
        case let .transport(publicCode):
            let permitted = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789_")
            if !publicCode.isEmpty, publicCode.count <= 64,
               publicCode.unicodeScalars.allSatisfy(permitted.contains) {
                return publicCode
            }
            return "transport"
        }
    }
}
