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

    @Test("cancelling a supervisor still terminates and reaps its worker before returning")
    func cancellationOwnsWorkerUntilReaped() async throws {
        let root = try TemporaryDirectory()
        let started = root.url.appendingPathComponent("started")
        let pidFile = root.url.appendingPathComponent("pid")
        let lateMarker = root.url.appendingPathComponent("late-marker")
        let script = """
        trap '' TERM
        printf '%s' "$$" > '\(pidFile.path)'
        printf started > '\(started.path)'
        sleep 0.5
        printf late > '\(lateMarker.path)'
        """
        let supervisor = CollectorProcessSupervisor(
            wallClockLimit: .seconds(10), terminationGrace: .milliseconds(50)
        )
        let task = Task {
            try await supervisor.run(
                executableURL: URL(fileURLWithPath: "/bin/sh"), arguments: ["-c", script]
            )
        }
        try await waitForFile(started)
        let pidText = try String(contentsOf: pidFile, encoding: .utf8)
        let pid = try #require(pid_t(pidText))

        task.cancel()
        await #expect(throws: CancellationError.self) { try await task.value }

        #expect(kill(pid, 0) == -1)
        #expect(errno == ESRCH)
        try await Task.sleep(for: .milliseconds(650))
        #expect(FileManager.default.fileExists(atPath: lateMarker.path) == false)
    }

    @Test("a worker and its descendants die when their supervising parent is SIGKILLed")
    func parentCrashClosesAuthorizationLivenessChannel() async throws {
        let root = try TemporaryDirectory()
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let supervisorSource = packageRoot
            .appendingPathComponent("Sources/SlateQuotaCollector/CollectorProcessSupervisor.swift")
        let worker = root.url.appendingPathComponent("worker-fixture")
        let parent = root.url.appendingPathComponent("parent-fixture")
        try compileFixture(
            source: #"""
            import Darwin
            import Foundation

            @main enum WorkerFixture {
                static func main() throws {
                    try WorkerParentAuthorization.consume(expectedMode: "scheduled")
                    signal(SIGTERM, SIG_IGN)
                    let arguments = CommandLine.arguments
                    try String(getpid()).write(toFile: arguments[1], atomically: true, encoding: .utf8)
                    let command = #"trap '' TERM; printf '%s' $$ > "$SLATE_DESCENDANT_PID_FILE"; printf started > "$SLATE_STARTED_FILE"; sleep 0.5; printf late > "$SLATE_LATE_MARKER""#
                    let spawnArguments: [String] = ["/bin/sh", "-c", command]
                    let storage = spawnArguments.map { text in text.withCString { strdup($0) } }
                    defer { storage.forEach { free($0) } }
                    var pointers: [UnsafeMutablePointer<CChar>?] = storage
                    pointers.append(nil)
                    let environment: [String] = [
                        "PATH=/usr/bin:/bin",
                        "SLATE_DESCENDANT_PID_FILE=\(arguments[2])",
                        "SLATE_LATE_MARKER=\(arguments[3])",
                        "SLATE_STARTED_FILE=\(arguments[4])",
                    ]
                    let environmentStorage = environment.map { text in text.withCString { strdup($0) } }
                    defer { environmentStorage.forEach { free($0) } }
                    var environmentPointers: [UnsafeMutablePointer<CChar>?] = environmentStorage
                    environmentPointers.append(nil)
                    var child = pid_t()
                    let status = pointers.withUnsafeMutableBufferPointer { argumentBuffer in
                        environmentPointers.withUnsafeMutableBufferPointer { environmentBuffer in
                            posix_spawn(
                                &child, "/bin/sh", nil, nil, argumentBuffer.baseAddress!,
                                environmentBuffer.baseAddress!
                            )
                        }
                    }
                    guard status == 0 else { throw NSError(domain: "worker-spawn", code: Int(status)) }
                    while true { pause() }
                }
            }
            """#,
            productionSource: supervisorSource,
            output: worker
        )
        try compileFixture(
            source: """
            import Foundation

            @main enum ParentFixture {
                static func main() async throws {
                    let arguments = CommandLine.arguments
                    let supervisor = CollectorProcessSupervisor(
                        wallClockLimit: .seconds(10), terminationGrace: .milliseconds(50)
                    )
                    _ = try await supervisor.run(
                        executableURL: URL(fileURLWithPath: arguments[1]),
                        arguments: Array(arguments.dropFirst(2)),
                        inheritedWorkerMode: "scheduled"
                    )
                }
            }
            """,
            productionSource: supervisorSource,
            output: parent
        )

        let workerPIDFile = root.url.appendingPathComponent("worker-pid")
        let descendantPIDFile = root.url.appendingPathComponent("descendant-pid")
        let lateMarker = root.url.appendingPathComponent("late-marker")
        let started = root.url.appendingPathComponent("started")
        let parentProcess = Process()
        parentProcess.executableURL = parent
        parentProcess.arguments = [
            worker.path, workerPIDFile.path, descendantPIDFile.path, lateMarker.path, started.path,
        ]
        try parentProcess.run()
        try await waitForFile(started)
        let workerPID = try #require(pid_t(String(contentsOf: workerPIDFile, encoding: .utf8)))
        let descendantPID = try #require(pid_t(String(contentsOf: descendantPIDFile, encoding: .utf8)))

        #expect(kill(parentProcess.processIdentifier, SIGKILL) == 0)
        parentProcess.waitUntilExit()
        try await waitForProcessToDisappear(workerPID)
        try await waitForProcessToDisappear(descendantPID)
        try await Task.sleep(for: .milliseconds(650))

        #expect(kill(workerPID, 0) == -1)
        #expect(kill(descendantPID, 0) == -1)
        #expect(FileManager.default.fileExists(atPath: lateMarker.path) == false)
    }

    private func compileFixture(
        source: String,
        productionSource: URL,
        output: URL
    ) throws {
        let sourceURL = output.appendingPathExtension("swift")
        try source.write(to: sourceURL, atomically: true, encoding: .utf8)
        let process = Process()
        let errors = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        process.arguments = [
            "swiftc", "-parse-as-library", productionSource.path, sourceURL.path,
            "-framework", "Security", "-o", output.path,
        ]
        process.standardError = errors
        try process.run()
        process.waitUntilExit()
        let errorText = String(
            decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self
        )
        guard process.terminationStatus == 0 else {
            throw NSError(
                domain: "CollectorProcessSupervisorTests.compileFixture",
                code: Int(process.terminationStatus),
                userInfo: [NSLocalizedDescriptionKey: errorText]
            )
        }
    }

    private func waitForProcessToDisappear(_ pid: pid_t) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(2))
        while ContinuousClock.now < deadline {
            if kill(pid, 0) == -1, errno == ESRCH { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw NSError(domain: "CollectorProcessSupervisorTests.processStillAlive", code: Int(pid))
    }

    private func waitForFile(_ url: URL) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(2))
        while ContinuousClock.now < deadline {
            if FileManager.default.fileExists(atPath: url.path) { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw NSError(domain: "CollectorProcessSupervisorTests", code: 1)
    }

}
