import Darwin
import Foundation
import Testing
@testable import SlateQuotaCollector

@Suite("Collector process supervisor", .serialized)
struct CollectorProcessSupervisorTests {
    @Test("production hard limit is exactly forty-five seconds with a two-second grace")
    func productionDurationsAreExact() {
        #expect(CollectorProcessSupervisor.productionWallClockLimit == .seconds(45))
        #expect(CollectorProcessSupervisor.productionTerminationGrace == .seconds(2))
    }

    @Test("normal worker exit is reaped")
    func normalExitIsReaped() async throws {
        let supervisor = CollectorProcessSupervisor(wallClockLimit: .seconds(1), terminationGrace: .milliseconds(100))
        let result = try await supervisor.run(executableURL: URL(fileURLWithPath: "/bin/sh"), arguments: ["-c", "exit 7"])

        #expect(result.outcome == .exited(code: 7))
        #expect(result.reaped)
        #expect(kill(result.pid, 0) == -1)
        #expect(errno == ESRCH)
    }

    @Test("cooperative worker receives TERM and is reaped")
    func termStopsWorker() async throws {
        let supervisor = CollectorProcessSupervisor(wallClockLimit: .milliseconds(100), terminationGrace: .milliseconds(500))
        let result = try await supervisor.run(
            executableURL: URL(fileURLWithPath: "/bin/sleep"),
            arguments: ["10"]
        )

        #expect(result.outcome == .timedOut(signal: .term))
        #expect(result.reaped)
        #expect(kill(result.pid, 0) == -1)
        #expect(errno == ESRCH)
    }

    @Test("uncooperative worker is killed, reaped, and cannot write a late marker")
    func killStopsLateSideEffects() async throws {
        let root = try TemporaryDirectory()
        let marker = root.url.appendingPathComponent("late-marker")
        let supervisor = CollectorProcessSupervisor(wallClockLimit: .milliseconds(100), terminationGrace: .milliseconds(75))
        let script = "trap '' TERM; sleep 0.4; printf late > '\(marker.path)'"

        let started = ContinuousClock.now
        let result = try await supervisor.run(
            executableURL: URL(fileURLWithPath: "/bin/sh"), arguments: ["-c", script]
        )
        let elapsed = started.duration(to: .now)

        #expect(result.outcome == .timedOut(signal: .kill))
        #expect(result.reaped)
        #expect(elapsed >= .milliseconds(100))
        #expect(elapsed < .seconds(1))
        try await Task.sleep(for: .milliseconds(500))
        #expect(FileManager.default.fileExists(atPath: marker.path) == false)
        #expect(kill(result.pid, 0) == -1)
        #expect(errno == ESRCH)
    }

    @Test("a TERM-cooperative worker cannot leave an uncooperative helper behind")
    func cooperativeLeaderCannotLeakHelper() async throws {
        let root = try TemporaryDirectory()
        let marker = root.url.appendingPathComponent("helper-late-marker")
        let script = """
        (trap '' TERM; sleep 0.4; printf late > '\(marker.path)') &
        trap 'exit 0' TERM
        while :; do :; done
        """
        let supervisor = CollectorProcessSupervisor(
            wallClockLimit: .milliseconds(100), terminationGrace: .milliseconds(300)
        )

        let result = try await supervisor.run(
            executableURL: URL(fileURLWithPath: "/bin/sh"), arguments: ["-c", script]
        )

        #expect(result.outcome == .timedOut(signal: .term))
        #expect(result.reaped)
        try await Task.sleep(for: .milliseconds(500))
        #expect(FileManager.default.fileExists(atPath: marker.path) == false)
    }

    @Test("a killed lock owner is recovered by the next worker")
    func killedWorkerLockIsRecovered() async throws {
        let root = try TemporaryDirectory()
        let supervisor = CollectorProcessSupervisor(wallClockLimit: .milliseconds(120), terminationGrace: .milliseconds(60))
        let lockDirectory = root.url.appendingPathComponent("SlateQuotaCollector", isDirectory: true)
        let lock = lockDirectory.appendingPathComponent("run.lock")
        let script = """
        mkdir -m 700 '\(lockDirectory.path)' || exit 8
        printf '{"pid":%s,"started_at":"2026-08-12T00:00:00Z"}' "$$" > '\(lock.path)' || exit 8
        chmod 600 '\(lock.path)' || exit 8
        trap '' TERM
        while :; do :; done
        """

        let result = try await supervisor.run(
            executableURL: URL(fileURLWithPath: "/bin/sh"), arguments: ["-c", script]
        )
        #expect(result.outcome == .timedOut(signal: .kill))
        #expect(result.reaped)
        #expect(try RunLock.readPID(at: root.url) == result.pid)

        let acquired = try RunLock.acquire(at: root.url)
        let next = try #require(acquired)
        try next.release()
        #expect(FileManager.default.fileExists(atPath: RunLock.url(in: root.url).path) == false)
    }

    @Test("spawn failure does not start the hard-limit clock as a worker")
    func spawnFailureIsClosed() async throws {
        let supervisor = CollectorProcessSupervisor(wallClockLimit: .milliseconds(50), terminationGrace: .milliseconds(20))
        await #expect(throws: CollectorProcessSupervisorError.self) {
            try await supervisor.run(
                executableURL: URL(fileURLWithPath: "/definitely/missing/slate-worker"), arguments: []
            )
        }
    }

}
