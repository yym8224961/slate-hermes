import Foundation
import Testing
@testable import SlateQuotaCollector

@Suite("Collector service")
struct CollectorServiceTests {
    private let now = Date(timeIntervalSince1970: 1_786_500_000)
    private let capabilityURL = URL(string: "https://slate.example/api/v1/contents/content-fixture/data")!

    @Test("reads providers concurrently, persists, pushes, verifies, then records last push")
    func readsProvidersConcurrentlyThenCachesAndPushes() async throws {
        let events = LockedEventRecorder()
        let snapshots = InMemorySnapshotStore(events: events)
        let slate = RecordingSlateIngest(events: events)
        let service = fixture(events: events, snapshots: snapshots, slate: slate)

        let report = try await service.collect(mode: .pushOnce)

        #expect(report.pushed)
        #expect(report.readbackVerified)
        #expect(report.receipt != nil)
        #expect(report.receipt?.id == "redacted")
        #expect(report.publicErrorCodes.isEmpty)
        #expect(events.providersOverlapped)
        #expect(events.happenedBefore("codex.start", "cache.snapshot"))
        #expect(events.happenedBefore("opencode.start", "cache.snapshot"))
        #expect(events.happenedBefore("codex.end", "cache.snapshot"))
        #expect(events.happenedBefore("opencode.end", "cache.snapshot"))
        #expect(events.suffix(from: "cache.snapshot") == [
            "cache.snapshot", "slate.push", "slate.readback", "cache.snapshot",
        ])
        #expect(try snapshots.loadSnapshot().runtimeState.lastPushAt == now)
    }

    @Test("dry run never reads Slate URL, pushes, reads back, or changes lastPushAt")
    func dryRunNeverReadsSlateURLOrPushes() async throws {
        let earlier = now.addingTimeInterval(-120)
        let snapshots = InMemorySnapshotStore(runtime: .fixture(lastPushAt: earlier))
        let secrets = RecordingSecretStore(values: ["opencode-go-api-key": "go-secret"])
        let slate = RecordingSlateIngest()
        let service = fixture(secrets: secrets, snapshots: snapshots, slate: slate)

        let report = try await service.collect(mode: .dryRun)

        #expect(report.envelope != nil)
        #expect(report.pushed == false)
        #expect(report.receipt == nil)
        #expect(report.readbackVerified == false)
        #expect(secrets.readAccounts.contains("slate-push-url") == false)
        #expect(await slate.pushCount == 0)
        #expect(await slate.readbackCount == 0)
        #expect(try snapshots.loadSnapshot().runtimeState.lastPushAt == earlier)
    }

    @Test("single provider failure uses stale cache and still pushes the successful provider")
    func singleProviderFailurePushesCombinedSnapshot() async throws {
        let cachedCodex = CodexDisplaySnapshot.fixture(collectedAt: now.addingTimeInterval(-60))
        let snapshots = InMemorySnapshotStore(lastGood: .init(schemaVersion: 1, codex: cachedCodex, openCodeGo: nil))
        let slate = RecordingSlateIngest()
        let service = fixture(
            codex: ClosureCodexReader { throw CodexClientError.timeout },
            snapshots: snapshots,
            slate: slate
        )

        let report = try await service.collect(mode: .pushOnce)

        #expect(report.pushed)
        #expect(report.readbackVerified)
        #expect(report.envelope?.data.codex.status == .stale)
        #expect(report.envelope?.data.opencodeGo.status == .ok)
        #expect(report.publicErrorCodes["codex"] == "timeout")
        let runtime = try snapshots.loadSnapshot().runtimeState
        #expect(runtime.codexFailures == 1)
        #expect(runtime.openCodeGoFailures == 0)
        #expect(runtime.simultaneousFailures == 0)
    }

    @Test("first dual failure holds the frame, second pushes stale, recovery resets simultaneous count")
    func dualFailureAndRecoveryStateMachine() async throws {
        let snapshots = InMemorySnapshotStore(
            lastGood: .init(
                schemaVersion: 1,
                codex: .fixture(collectedAt: now.addingTimeInterval(-60)),
                openCodeGo: .fixture(collectedAt: now.addingTimeInterval(-60))
            )
        )
        let codex = SequencedCodexReader([
            .failure(CodexClientError.timeout),
            .failure(CodexClientError.timeout),
            .success(.fixture),
        ])
        let openCode = SequencedOpenCodeReader([
            .failure(OpenCodeGoClientError.server),
            .failure(OpenCodeGoClientError.server),
            .failure(OpenCodeGoClientError.server),
        ])
        let slate = RecordingSlateIngest()
        let service = fixture(codex: codex, openCode: openCode, snapshots: snapshots, slate: slate)

        let first = try await service.collect(mode: .pushOnce)
        #expect(first.pushed == false)
        #expect(first.envelope == nil)
        #expect(try snapshots.loadSnapshot().runtimeState.simultaneousFailures == 1)

        let second = try await service.collect(mode: .pushOnce)
        #expect(second.pushed)
        #expect(second.envelope?.data.codex.status == .stale)
        #expect(second.envelope?.data.opencodeGo.status == .stale)
        #expect(try snapshots.loadSnapshot().runtimeState.simultaneousFailures == 2)

        let recovered = try await service.collect(mode: .pushOnce)
        #expect(recovered.pushed)
        #expect(recovered.envelope?.data.codex.status == .ok)
        #expect(recovered.envelope?.data.opencodeGo.status == .stale)
        let runtime = try snapshots.loadSnapshot().runtimeState
        #expect(runtime.simultaneousFailures == 0)
        #expect(runtime.codexFailures == 0)
        #expect(runtime.openCodeGoFailures == 3)
        #expect(await slate.pushCount == 2)
    }

    @Test("Slate transient POST failure retries once inside the overall collection")
    func slatePushRetriesOnce() async throws {
        let receipt = #"{"id":"content-fixture","image_etag":"image-2","manifest_etag":"manifest-2","rendered_at":"2026-08-12T08:30:00Z"}"#
        let dashboard = try JSONEncoder.slate.encode(SlateDashboardData(
            schemaVersion: 1,
            generatedAt: now,
            codex: QuotaNormalizer.shanghai.codex(.fixture, collectedAt: now),
            opencodeGo: QuotaNormalizer.shanghai.openCodeGo(.fixture, collectedAt: now)
        ))
        let transport = RecordingHTTPTransport(responses: [
            .success(.init(status: 500, body: Data())),
            .success(.init(status: 200, body: Data(receipt.utf8))),
            .success(.init(status: 200, body: dashboard)),
        ])
        let slate = SlateIngestClient(transport: transport, sleep: { _ in })
        let report = try await fixture(slate: slate).collect(mode: .pushOnce)

        #expect(report.pushed)
        #expect(report.readbackVerified)
        #expect(await transport.requests.count == 3)
    }

    @Test("readback mismatch does not mark verification or advance lastPushAt")
    func readbackMismatchDoesNotAdvanceLastPushAt() async throws {
        let earlier = now.addingTimeInterval(-300)
        let snapshots = InMemorySnapshotStore(runtime: .fixture(lastPushAt: earlier))
        let mismatched = SlateDashboardData.fixture(generatedAt: now.addingTimeInterval(1))
        let slate = RecordingSlateIngest(readbackOverride: mismatched)
        let report = try await fixture(snapshots: snapshots, slate: slate).collect(mode: .pushOnce)

        #expect(report.pushed)
        #expect(report.receipt != nil)
        #expect(report.readbackVerified == false)
        #expect(report.publicErrorCodes["slate"] == "slate_readback_mismatch")
        #expect(try snapshots.loadSnapshot().runtimeState.lastPushAt == earlier)
    }

    @Test("POST failure preserves last-good and never rereads providers")
    func pushFailurePreservesLastGoodWithoutProviderReread() async throws {
        let codex = CountingCodexReader(result: .success(.fixture))
        let openCode = CountingOpenCodeReader(result: .success(.fixture))
        let snapshots = InMemorySnapshotStore()
        let slate = RecordingSlateIngest(pushError: SlateIngestError.http(status: 401))
        let report = try await fixture(
            codex: codex,
            openCode: openCode,
            snapshots: snapshots,
            slate: slate
        ).collect(mode: .pushOnce)

        #expect(report.pushed == false)
        #expect(report.readbackVerified == false)
        #expect(report.publicErrorCodes["slate"] == "slate_http_401")
        #expect(await codex.readCount == 1)
        #expect(await openCode.readCount == 1)
        #expect(try snapshots.loadSnapshot().lastGood.codex != nil)
        #expect(try snapshots.loadSnapshot().lastGood.openCodeGo != nil)
    }

    @Test("cache failure prevents push and returns only a public cache code")
    func cacheFailurePreventsPush() async throws {
        let snapshots = InMemorySnapshotStore(saveError: SnapshotCacheError.ioFailure)
        let slate = RecordingSlateIngest()
        let report = try await fixture(snapshots: snapshots, slate: slate).collect(mode: .pushOnce)

        #expect(report.envelope == nil)
        #expect(report.pushed == false)
        #expect(report.publicErrorCodes == ["cache": "cache_io"])
        #expect(await slate.pushCount == 0)
    }

    @Test("cooperative collection deadline owns and cancels both providers")
    func collectionDeadlineCancelsOutstandingWork() async throws {
        let events = LockedEventRecorder()
        let codexCancellation = LockedCancellationProbe()
        let openCodeCancellation = LockedCancellationProbe()
        let clock = ManualDeadlineClock()
        let service = fixture(
            codex: HangingCodexReader(events: events, cancellation: codexCancellation),
            openCode: HangingOpenCodeReader(events: events, cancellation: openCodeCancellation),
            deadlineSleep: { duration in try await clock.sleep(for: duration) },
            collectionDeadline: .milliseconds(50)
        )

        let collection = Task { try await service.collect(mode: .pushOnce) }
        await waitUntil { events.contains("codex.start") && events.contains("opencode.start") }
        await waitUntil { await clock.isSleeping }
        await clock.advance()

        do {
            _ = try await collection.value
            Issue.record("expected cooperative collection deadline")
        } catch let error as CollectorError {
            #expect(error == .collectionDeadlineExceeded)
        } catch {
            Issue.record("unexpected error type: \(type(of: error))")
        }
        await waitUntil { codexCancellation.wasCancelled && openCodeCancellation.wasCancelled }
        #expect(codexCancellation.wasCancelled)
        #expect(openCodeCancellation.wasCancelled)
    }

    @Test("deadline while Slate URL read is suspended prevents push and later snapshot writes")
    func deadlineDuringSlateURLReadPreventsPush() async throws {
        let clock = ManualDeadlineClock()
        let published = LockedFlag()
        let secrets = BlockingSlateURLSecretStore(apiKey: "go-secret")
        let snapshots = InMemorySnapshotStore()
        let slate = RecordingSlateIngest()
        let service = fixture(
            secrets: secrets,
            snapshots: snapshots,
            slate: slate,
            deadlineSleep: { duration in try await clock.sleep(for: duration) },
            collectionDeadline: .milliseconds(50),
            onDeadlinePublished: { published.set() }
        )

        let collection = Task { try await service.collect(mode: .pushOnce) }
        await waitUntil { secrets.isReadingSlateURL }
        await waitUntil { await clock.isSleeping }
        await clock.advance()
        await waitUntil { published.value }
        secrets.releaseSlateURL()
        await expectCollectionDeadline(collection)

        #expect(await slate.pushCount == 0)
        #expect(snapshots.saveCount == 1)
        #expect(try snapshots.loadSnapshot().runtimeState.lastPushAt == nil)
    }

    @Test("deadline during the atomic cache stage permits no later Slate side effects")
    func deadlineDuringCacheStagePreventsPush() async throws {
        let clock = ManualDeadlineClock()
        let published = LockedFlag()
        let snapshots = BlockingSnapshotStore()
        let slate = RecordingSlateIngest()
        let service = fixture(
            snapshots: snapshots,
            slate: slate,
            deadlineSleep: { duration in try await clock.sleep(for: duration) },
            collectionDeadline: .milliseconds(50),
            onDeadlinePublished: { published.set() }
        )

        let collection = Task { try await service.collect(mode: .pushOnce) }
        await waitUntil { snapshots.saveStarted }
        await waitUntil { await clock.isSleeping }
        await clock.advance()
        await waitUntil { published.value }
        snapshots.releaseSave()
        await expectCollectionDeadline(collection)

        #expect(snapshots.saveCount == 1)
        #expect(await slate.pushCount == 0)
        #expect(await slate.readbackCount == 0)
        #expect(try snapshots.loadSnapshot().runtimeState.lastPushAt == nil)
    }

    @Test("deadline while push is suspended owns cancellation and prevents readback")
    func deadlineDuringPushPreventsReadback() async throws {
        let clock = ManualDeadlineClock()
        let slate = SuspendedSlateIngest(stage: .push)
        let snapshots = InMemorySnapshotStore()
        let service = fixture(
            snapshots: snapshots,
            slate: slate,
            deadlineSleep: { duration in try await clock.sleep(for: duration) },
            collectionDeadline: .milliseconds(50)
        )

        let collection = Task { try await service.collect(mode: .pushOnce) }
        await waitUntil { await slate.pushStarted }
        await waitUntil { await clock.isSleeping }
        await clock.advance()
        await expectCollectionDeadline(collection)

        #expect(await slate.pushCancelled)
        #expect(await slate.readbackCount == 0)
        #expect(snapshots.saveCount == 1)
        #expect(try snapshots.loadSnapshot().runtimeState.lastPushAt == nil)
    }

    @Test("deadline while readback is suspended prevents final runtime update")
    func deadlineDuringReadbackPreventsLastPushUpdate() async throws {
        let clock = ManualDeadlineClock()
        let slate = SuspendedSlateIngest(stage: .readback)
        let snapshots = InMemorySnapshotStore()
        let service = fixture(
            snapshots: snapshots,
            slate: slate,
            deadlineSleep: { duration in try await clock.sleep(for: duration) },
            collectionDeadline: .milliseconds(50)
        )

        let collection = Task { try await service.collect(mode: .pushOnce) }
        await waitUntil { await slate.readbackStarted }
        await waitUntil { await clock.isSleeping }
        await clock.advance()
        await expectCollectionDeadline(collection)

        #expect(await slate.readbackCancelled)
        #expect(snapshots.saveCount == 1)
        #expect(try snapshots.loadSnapshot().runtimeState.lastPushAt == nil)
    }

    @Test("work-first completion cancels and drains the deadline child")
    func workFirstCancelsDeadlineWithoutResidualTask() async throws {
        let deadline = CancellationObservedDeadline()
        let report = try await fixture(
            deadlineSleep: { duration in try await deadline.sleep(for: duration) }
        ).collect(mode: .dryRun)

        #expect(report.envelope != nil)
        #expect(await deadline.cancelled)
        #expect(await deadline.activeCount == 0)
    }

    @Test("report, envelope, and public codes contain no credential bytes")
    func reportContainsNoSecrets() async throws {
        let apiKey = "go-key-ULTRA-SECRET"
        let url = "https://slate.example/api/v1/contents/SECRET-CONTENT-ID/data"
        let secrets = RecordingSecretStore(values: [
            "opencode-go-api-key": apiKey,
            "slate-push-url": url,
        ])
        let slate = RecordingSlateIngest(receipt: .init(
            id: "SECRET-CONTENT-ID",
            imageEtag: apiKey,
            manifestEtag: url,
            renderedAt: now
        ))
        let report = try await fixture(secrets: secrets, slate: slate).collect(mode: .pushOnce)
        let envelopeBytes = try JSONEncoder.slate.encode(report.envelope)
        let codeBytes = try JSONEncoder().encode(report.publicErrorCodes)
        let reportText = String(reflecting: report)

        for secret in [apiKey, url, "SECRET-CONTENT-ID", "Authorization", "Bearer"] {
            #expect(envelopeBytes.range(of: Data(secret.utf8)) == nil)
            #expect(codeBytes.range(of: Data(secret.utf8)) == nil)
            #expect(reportText.contains(secret) == false)
        }
        #expect(report.receipt?.id == "redacted")
        #expect(report.receipt?.imageEtag == "redacted")
        #expect(report.receipt?.manifestEtag == "redacted")
    }

    @Test("a published deadline always wins before Slate POST receives a start permit")
    func deadlinePublicationLinearizesBeforePushStart() async throws {
        for _ in 0..<32 {
            let clock = ManualDeadlineClock()
            let hook = BlockingSideEffectHook(target: .slatePush)
            let published = LockedFlag()
            let slate = RecordingSlateIngest()
            let service = fixture(
                slate: slate,
                deadlineSleep: { duration in try await clock.sleep(for: duration) },
                collectionDeadline: .milliseconds(50),
                beforeSideEffect: { sideEffect in await hook.before(sideEffect) },
                onDeadlinePublished: { published.set() }
            )

            let collection = Task { try await service.collect(mode: .pushOnce) }
            await waitUntil { await hook.reached }
            await waitUntil { await clock.isSleeping }
            await clock.advance()
            await waitUntil { published.value }
            await hook.release()
            await expectCollectionDeadline(collection)

            #expect(await slate.pushCount == 0)
            #expect(await slate.readbackCount == 0)
        }
    }

    private func fixture(
        events: LockedEventRecorder? = nil,
        codex: any CodexRateLimitReading = ClosureCodexReader { .fixture },
        openCode: any OpenCodeGoUsageReading = ClosureOpenCodeReader { _ in .fixture },
        secrets: any SecretStoring = RecordingSecretStore(values: [
            "opencode-go-api-key": "go-secret",
            "slate-push-url": "https://slate.example/api/v1/contents/content-fixture/data",
        ]),
        snapshots: any SnapshotPersisting = InMemorySnapshotStore(),
        slate: any SlateIngesting = RecordingSlateIngest(),
        deadlineSleep: @escaping CollectorService.DeadlineSleep = { try await Task.sleep(for: $0) },
        collectionDeadline: Duration = .seconds(45),
        beforeSideEffect: @escaping CollectorService.BeforeSideEffect = { _ in },
        onDeadlinePublished: @escaping CollectorService.OnDeadlinePublished = {}
    ) -> CollectorService {
        let codexReader: any CodexRateLimitReading
        let openCodeReader: any OpenCodeGoUsageReading
        if let events {
            codexReader = EventCodexReader(base: codex, events: events)
            openCodeReader = EventOpenCodeReader(base: openCode, events: events)
        } else {
            codexReader = codex
            openCodeReader = openCode
        }
        return CollectorService(
            codex: codexReader,
            openCodeGo: openCodeReader,
            normalizer: .shanghai,
            secrets: secrets,
            snapshots: snapshots,
            failurePolicy: FailurePolicy(),
            slate: slate,
            openCodeKeyAccount: "opencode-go-api-key",
            slateURLAccount: "slate-push-url",
            now: { now },
            deadlineSleep: deadlineSleep,
            collectionDeadline: collectionDeadline,
            beforeSideEffect: beforeSideEffect,
            onDeadlinePublished: onDeadlinePublished
        )
    }

    private func waitUntil(
        _ predicate: @escaping @Sendable () async -> Bool,
        sourceLocation: SourceLocation = #_sourceLocation
    ) async {
        for _ in 0..<10_000 {
            if await predicate() { return }
            await Task.yield()
        }
        Issue.record("condition did not become true", sourceLocation: sourceLocation)
    }

    private func expectCollectionDeadline(
        _ collection: Task<CollectionReport, any Error>,
        sourceLocation: SourceLocation = #_sourceLocation
    ) async {
        do {
            _ = try await collection.value
            Issue.record("expected cooperative collection deadline", sourceLocation: sourceLocation)
        } catch let error as CollectorError {
            #expect(error == .collectionDeadlineExceeded, sourceLocation: sourceLocation)
        } catch {
            Issue.record("unexpected error type: \(type(of: error))", sourceLocation: sourceLocation)
        }
    }
}

private enum FixtureError: Error, Sendable { case failed }

private final class LockedEventRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String] = []
    private var activeProviders: Set<String> = []
    private var overlap = false

    func record(_ event: String) {
        lock.withLock {
            values.append(event)
            if event.hasSuffix(".start") {
                activeProviders.insert(String(event.split(separator: ".")[0]))
                if activeProviders.count == 2 { overlap = true }
            } else if event.hasSuffix(".end") {
                activeProviders.remove(String(event.split(separator: ".")[0]))
            }
        }
    }

    var providersOverlapped: Bool { lock.withLock { overlap } }
    func contains(_ event: String) -> Bool { lock.withLock { values.contains(event) } }
    func happenedBefore(_ first: String, _ second: String) -> Bool {
        lock.withLock {
            guard let lhs = values.firstIndex(of: first), let rhs = values.firstIndex(of: second) else { return false }
            return lhs < rhs
        }
    }
    func suffix(from event: String) -> [String] {
        lock.withLock {
            guard let index = values.firstIndex(of: event) else { return [] }
            return Array(values[index...])
        }
    }
}

private struct ClosureCodexReader: CodexRateLimitReading {
    let operation: @Sendable () async throws -> CodexRateLimitsReadResult
    init(_ operation: @escaping @Sendable () async throws -> CodexRateLimitsReadResult) { self.operation = operation }
    func read() async throws -> CodexRateLimitsReadResult { try await operation() }
}

private struct ClosureOpenCodeReader: OpenCodeGoUsageReading {
    let operation: @Sendable (String) async throws -> OpenCodeGoUsageResponse
    init(_ operation: @escaping @Sendable (String) async throws -> OpenCodeGoUsageResponse) { self.operation = operation }
    func read(apiKey: String) async throws -> OpenCodeGoUsageResponse { try await operation(apiKey) }
}

private struct EventCodexReader: CodexRateLimitReading {
    let base: any CodexRateLimitReading
    let events: LockedEventRecorder
    func read() async throws -> CodexRateLimitsReadResult {
        events.record("codex.start")
        while !events.contains("opencode.start") { await Task.yield() }
        let value = try await base.read()
        events.record("codex.end")
        return value
    }
}

private struct EventOpenCodeReader: OpenCodeGoUsageReading {
    let base: any OpenCodeGoUsageReading
    let events: LockedEventRecorder
    func read(apiKey: String) async throws -> OpenCodeGoUsageResponse {
        events.record("opencode.start")
        while !events.contains("codex.start") { await Task.yield() }
        let value = try await base.read(apiKey: apiKey)
        events.record("opencode.end")
        return value
    }
}

private actor SequencedCodexReader: CodexRateLimitReading {
    private var results: [Result<CodexRateLimitsReadResult, any Error & Sendable>]
    init(_ results: [Result<CodexRateLimitsReadResult, any Error & Sendable>]) { self.results = results }
    func read() async throws -> CodexRateLimitsReadResult { try results.removeFirst().get() }
}

private actor SequencedOpenCodeReader: OpenCodeGoUsageReading {
    private var results: [Result<OpenCodeGoUsageResponse, any Error & Sendable>]
    init(_ results: [Result<OpenCodeGoUsageResponse, any Error & Sendable>]) { self.results = results }
    func read(apiKey _: String) async throws -> OpenCodeGoUsageResponse { try results.removeFirst().get() }
}

private actor CountingCodexReader: CodexRateLimitReading {
    private let result: Result<CodexRateLimitsReadResult, any Error & Sendable>
    private(set) var readCount = 0
    init(result: Result<CodexRateLimitsReadResult, any Error & Sendable>) { self.result = result }
    func read() async throws -> CodexRateLimitsReadResult { readCount += 1; return try result.get() }
}

private actor CountingOpenCodeReader: OpenCodeGoUsageReading {
    private let result: Result<OpenCodeGoUsageResponse, any Error & Sendable>
    private(set) var readCount = 0
    init(result: Result<OpenCodeGoUsageResponse, any Error & Sendable>) { self.result = result }
    func read(apiKey _: String) async throws -> OpenCodeGoUsageResponse { readCount += 1; return try result.get() }
}

private final class RecordingSecretStore: SecretStoring, @unchecked Sendable {
    private let lock = NSLock()
    private let values: [String: String]
    private var accounts: [String] = []
    init(values: [String: String]) { self.values = values }
    var readAccounts: [String] { lock.withLock { accounts } }
    func read(account: String) throws -> String {
        try lock.withLock {
            accounts.append(account)
            guard let value = values[account] else { throw FixtureError.failed }
            return value
        }
    }
    func write(_: String, account _: String) throws {}
}

private final class BlockingSlateURLSecretStore: SecretStoring, @unchecked Sendable {
    private let condition = NSCondition()
    private let apiKey: String
    private var readingSlateURL = false
    private var released = false

    init(apiKey: String) { self.apiKey = apiKey }
    var isReadingSlateURL: Bool { condition.withLock { readingSlateURL } }

    func read(account: String) throws -> String {
        if account == "opencode-go-api-key" { return apiKey }
        condition.lock()
        readingSlateURL = true
        condition.broadcast()
        while !released { condition.wait() }
        condition.unlock()
        return "https://slate.example/api/v1/contents/content-fixture/data"
    }

    func releaseSlateURL() {
        condition.withLock {
            released = true
            condition.broadcast()
        }
    }

    func write(_: String, account _: String) throws {}
}

private final class InMemorySnapshotStore: SnapshotPersisting, @unchecked Sendable {
    private let lock = NSLock()
    private var snapshot: CollectorSnapshot
    private let events: LockedEventRecorder?
    private let saveError: (any Error)?
    private var saves = 0

    init(
        lastGood: SanitizedLastGood = .init(schemaVersion: 1, codex: nil, openCodeGo: nil),
        runtime: CollectorRuntimeState = .fixture(),
        events: LockedEventRecorder? = nil,
        saveError: (any Error)? = nil
    ) {
        snapshot = CollectorSnapshot(schemaVersion: 1, lastGood: lastGood, runtimeState: runtime)
        self.events = events
        self.saveError = saveError
    }

    func loadSnapshot() throws -> CollectorSnapshot { lock.withLock { snapshot } }
    var saveCount: Int { lock.withLock { saves } }
    func saveSnapshot(_ value: CollectorSnapshot) throws {
        if let saveError { throw saveError }
        lock.withLock {
            snapshot = value
            saves += 1
        }
        events?.record("cache.snapshot")
    }
}

private final class BlockingSnapshotStore: SnapshotPersisting, @unchecked Sendable {
    private let condition = NSCondition()
    private var snapshot = CollectorSnapshot.empty
    private var started = false
    private var released = false
    private var saves = 0

    var saveStarted: Bool { condition.withLock { started } }
    var saveCount: Int { condition.withLock { saves } }
    func loadSnapshot() throws -> CollectorSnapshot { condition.withLock { snapshot } }
    func saveSnapshot(_ value: CollectorSnapshot) throws {
        condition.lock()
        started = true
        condition.broadcast()
        while !released { condition.wait() }
        snapshot = value
        saves += 1
        condition.unlock()
    }
    func releaseSave() {
        condition.withLock {
            released = true
            condition.broadcast()
        }
    }
}

private actor RecordingSlateIngest: SlateIngesting {
    private let events: LockedEventRecorder?
    private let pushError: (any Error)?
    private let readbackOverride: SlateDashboardData?
    private let receipt: SlateIngestReceipt
    private var pushedEnvelope: SlateEnvelope?
    private(set) var pushCount = 0
    private(set) var readbackCount = 0

    init(
        events: LockedEventRecorder? = nil,
        pushError: (any Error)? = nil,
        readbackOverride: SlateDashboardData? = nil,
        receipt: SlateIngestReceipt = .fixture
    ) {
        self.events = events
        self.pushError = pushError
        self.readbackOverride = readbackOverride
        self.receipt = receipt
    }

    func push(_ envelope: SlateEnvelope, capabilityURL _: URL) async throws -> SlateIngestReceipt {
        pushCount += 1
        events?.record("slate.push")
        if let pushError { throw pushError }
        pushedEnvelope = envelope
        return receipt
    }

    func readCurrentData(capabilityURL _: URL) async throws -> SlateDashboardData {
        readbackCount += 1
        events?.record("slate.readback")
        if let readbackOverride { return readbackOverride }
        guard let data = pushedEnvelope?.data else { throw FixtureError.failed }
        return data
    }
}

private actor SuspendedSlateIngest: SlateIngesting {
    enum Stage { case push, readback }
    let stage: Stage
    private(set) var pushStarted = false
    private(set) var pushCancelled = false
    private(set) var readbackStarted = false
    private(set) var readbackCancelled = false
    private(set) var readbackCount = 0
    private var envelope: SlateEnvelope?

    init(stage: Stage) { self.stage = stage }

    func push(_ envelope: SlateEnvelope, capabilityURL _: URL) async throws -> SlateIngestReceipt {
        pushStarted = true
        self.envelope = envelope
        if stage == .push {
            do {
                try await Task.sleep(for: .seconds(60))
            } catch {
                pushCancelled = true
                throw error
            }
        }
        return .fixture
    }

    func readCurrentData(capabilityURL _: URL) async throws -> SlateDashboardData {
        readbackCount += 1
        readbackStarted = true
        if stage == .readback {
            do {
                try await Task.sleep(for: .seconds(60))
            } catch {
                readbackCancelled = true
                throw error
            }
        }
        guard let data = envelope?.data else { throw FixtureError.failed }
        return data
    }
}

private final class LockedCancellationProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    var wasCancelled: Bool { lock.withLock { value } }
    func markCancelled() { lock.withLock { value = true } }
}

private struct HangingCodexReader: CodexRateLimitReading {
    let events: LockedEventRecorder
    let cancellation: LockedCancellationProbe
    func read() async throws -> CodexRateLimitsReadResult {
        events.record("codex.start")
        return try await withTaskCancellationHandler {
            try await Task.sleep(for: .seconds(60))
            throw FixtureError.failed
        } onCancel: {
            cancellation.markCancelled()
        }
    }
}

private struct HangingOpenCodeReader: OpenCodeGoUsageReading {
    let events: LockedEventRecorder
    let cancellation: LockedCancellationProbe
    func read(apiKey _: String) async throws -> OpenCodeGoUsageResponse {
        events.record("opencode.start")
        return try await withTaskCancellationHandler {
            try await Task.sleep(for: .seconds(60))
            throw FixtureError.failed
        } onCancel: {
            cancellation.markCancelled()
        }
    }
}

private actor ManualDeadlineClock {
    private var continuation: CheckedContinuation<Void, any Error>?
    private(set) var isSleeping = false
    func sleep(for _: Duration) async throws {
        try Task.checkCancellation()
        try await withCheckedThrowingContinuation { continuation in
            isSleeping = true
            self.continuation = continuation
        }
    }
    func advance() {
        continuation?.resume()
        continuation = nil
        isSleeping = false
    }
}

private actor CancellationObservedDeadline {
    private(set) var activeCount = 0
    private(set) var cancelled = false

    func sleep(for _: Duration) async throws {
        activeCount += 1
        defer { activeCount -= 1 }
        do {
            try await Task.sleep(for: .seconds(60))
        } catch {
            cancelled = true
            throw error
        }
    }
}

private actor BlockingSideEffectHook {
    let target: CollectorSideEffect
    private(set) var reached = false
    private var continuation: CheckedContinuation<Void, Never>?

    init(target: CollectorSideEffect) { self.target = target }

    func before(_ sideEffect: CollectorSideEffect) async {
        guard sideEffect == target else { return }
        reached = true
        await withCheckedContinuation { continuation = $0 }
    }

    func release() {
        continuation?.resume()
        continuation = nil
    }
}

private final class LockedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var stored = false
    var value: Bool { lock.withLock { stored } }
    func set() { lock.withLock { stored = true } }
}

private extension CodexRateLimitsReadResult {
    static let fixture = Self(
        rateLimits: nil,
        rateLimitsByLimitId: [
            "codex": .init(
                limitId: "codex",
                primary: .init(usedPercent: 19, windowDurationMins: 300, resetsAt: nil),
                secondary: .init(usedPercent: 29, windowDurationMins: 10_080, resetsAt: nil)
            ),
        ],
        credits: .init(unlimited: false, balance: 128.5),
        planType: "prolite"
    )
}

private extension OpenCodeGoUsageResponse {
    static let fixture = Self(
        useBalance: false,
        rollingUsage: .init(status: .ok, resetInSec: 300, usagePercent: 19),
        weeklyUsage: .init(status: .ok, resetInSec: 600, usagePercent: 29),
        monthlyUsage: .init(status: .ok, resetInSec: 900, usagePercent: 25)
    )
}

private extension CodexDisplaySnapshot {
    static func fixture(collectedAt: Date) -> Self {
        let base = Self.fixture()
        return .init(
            status: base.status,
            sourceCollectedAt: collectedAt,
            headerLeft: base.headerLeft,
            summaryLabel: base.summaryLabel,
            rolling: base.rolling,
            weekly: base.weekly,
            footerLeft: base.footerLeft,
            footerRight: base.footerRight
        )
    }
}

private extension OpenCodeGoDisplaySnapshot {
    static func fixture(collectedAt: Date) -> Self {
        let base = Self.fixture()
        return .init(
            status: base.status,
            sourceCollectedAt: collectedAt,
            headerLeft: base.headerLeft,
            summaryLabel: base.summaryLabel,
            rolling: base.rolling,
            weekly: base.weekly,
            monthly: base.monthly,
            footerLeft: base.footerLeft,
            footerRight: base.footerRight
        )
    }
}

private extension CollectorRuntimeState {
    static func fixture(lastPushAt: Date? = nil) -> Self {
        Self(
            schemaVersion: 1,
            codexFailures: 0,
            openCodeGoFailures: 0,
            simultaneousFailures: 0,
            lastSuccessAt: nil,
            lastPushAt: lastPushAt,
            providerStatuses: [:],
            lastErrorCodes: [:]
        )
    }
}

private extension SlateIngestReceipt {
    static let fixture = Self(
        id: "content-fixture",
        imageEtag: "image-etag",
        manifestEtag: "manifest-etag",
        renderedAt: Date(timeIntervalSince1970: 1_786_500_000)
    )
}
