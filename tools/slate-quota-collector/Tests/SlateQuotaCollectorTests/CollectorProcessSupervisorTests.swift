import Darwin
import Foundation
import Testing
@testable import SlateQuotaCollector

@Suite("Collector process supervisor", .serialized)
struct CollectorProcessSupervisorTests {
    @Test("production hard limit covers Codex and Slate verification with a two-second grace")
    func productionDurationsAreExact() {
        #expect(CollectorProcessSupervisor.productionWallClockLimit == .seconds(180))
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

    @Test("authorization survives when socketpair initially allocates fixed descriptor 198")
    func authorizationRelocatesFixedDescriptorCollision() throws {
        let root = try TemporaryDirectory()
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let supervisorSource = packageRoot
            .appendingPathComponent("Sources/SlateQuotaCollector/CollectorProcessSupervisor.swift")
        let worker = root.url.appendingPathComponent("fixed-fd-worker")
        let parent = root.url.appendingPathComponent("fixed-fd-parent")
        let marker = root.url.appendingPathComponent("authorized")
        try compileFixture(
            source: """
            import Foundation

            @main enum FixedFDWorker {
                static func main() throws {
                    try WorkerParentAuthorization.consume(expectedMode: "scheduled")
                    try "authorized".write(
                        toFile: CommandLine.arguments[1], atomically: true, encoding: .utf8
                    )
                }
            }
            """,
            productionSource: supervisorSource,
            output: worker
        )
        try compileFixture(
            source: """
            import Darwin
            import Foundation

            @main enum FixedFDParent {
                static func main() async throws {
                    let seed = open("/dev/null", O_RDONLY | O_CLOEXEC)
                    guard seed >= 0 else { throw NSError(domain: "open", code: Int(errno)) }
                    defer { _ = close(seed) }
                    for descriptor in 3...197 {
                        guard dup2(seed, Int32(descriptor)) == descriptor,
                              fcntl(Int32(descriptor), F_SETFD, FD_CLOEXEC) == 0 else {
                            throw NSError(domain: "dup2", code: Int(errno))
                        }
                    }
                    _ = close(198)
                    _ = close(199)
                    let supervisor = CollectorProcessSupervisor(
                        wallClockLimit: .seconds(2), terminationGrace: .milliseconds(50)
                    )
                    let result = try await supervisor.run(
                        executableURL: URL(fileURLWithPath: CommandLine.arguments[1]),
                        arguments: [CommandLine.arguments[2]],
                        inheritedWorkerMode: "scheduled"
                    )
                    guard result.outcome == .exited(code: 0), result.reaped else {
                        throw NSError(domain: "worker-result", code: 1)
                    }
                }
            }
            """,
            productionSource: supervisorSource,
            output: parent
        )

        let process = Process()
        process.executableURL = parent
        process.arguments = [worker.path, marker.path]
        try process.run()
        process.waitUntilExit()

        #expect(process.terminationStatus == 0)
        #expect(try String(contentsOf: marker, encoding: .utf8) == "authorized")
    }

    @Test("authorization rejects a worker that is not its process-group leader")
    func authorizationRequiresWorkerOwnedProcessGroup() throws {
        let root = try TemporaryDirectory()
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let supervisorSource = packageRoot
            .appendingPathComponent("Sources/SlateQuotaCollector/CollectorProcessSupervisor.swift")
        let worker = root.url.appendingPathComponent("inherited-group-worker")
        let marker = root.url.appendingPathComponent("authorization-result")
        try compileFixture(
            source: """
            import Foundation

            @main enum InheritedGroupWorker {
                static func main() throws {
                    let result: String
                    do {
                        try WorkerParentAuthorization.consume(expectedMode: "scheduled")
                        result = "accepted"
                    } catch {
                        result = "rejected"
                    }
                    try result.write(
                        toFile: CommandLine.arguments[1], atomically: true, encoding: .utf8
                    )
                }
            }
            """,
            productionSource: supervisorSource,
            output: worker
        )

        let status = try spawnInheritedGroupAuthorizedWorker(worker: worker, marker: marker)

        #expect(status & 0x7f == 0)
        #expect((status >> 8) & 0xff == 0)
        #expect(try String(contentsOf: marker, encoding: .utf8) == "rejected")
    }

    @Test(
        "every post-spawn failure independently terminates the group and exactly reaps the child",
        arguments: SupervisorInjectedFailure.allCases
    )
    func postSpawnFailuresCannotEscapeOwnership(
        failure: SupervisorInjectedFailure
    ) async throws {
        let root = try TemporaryDirectory()
        let started = root.url.appendingPathComponent("started")
        let termMarker = root.url.appendingPathComponent("term-observed")
        let lateMarker = root.url.appendingPathComponent("late-marker")
        let observation = SpawnedProcessObservation()
        let syscalls = FaultInjectingCollectorProcessSyscalls(
            failure: failure,
            readyFile: started
        )
        let liveLeader = """
        trap "printf term > '\(termMarker.path)'; trap '' TERM; sleep 0.4; printf late > '\(lateMarker.path)'" TERM
        printf started > '\(started.path)'
        while :; do :; done
        """
        let supervisor = CollectorProcessSupervisor(
            wallClockLimit: .milliseconds(80),
            terminationGrace: .milliseconds(80),
            syscalls: syscalls,
            didSpawn: { observation.record(pid: $0) },
            beforeAuthorizationPublish: {
                guard failure == .authorizationPublish else { return }
                try waitSynchronouslyForFile(started)
                throw SupervisorInjectedError.failure
            },
            beforeSleep: {
                guard failure == .sleep else { return }
                try waitSynchronouslyForFile(started)
                throw SupervisorInjectedError.failure
            }
        )

        do {
            _ = try await supervisor.run(
                executableURL: URL(fileURLWithPath: "/bin/sh"),
                arguments: ["-c", liveLeader],
                inheritedWorkerMode: failure == .authorizationPublish ? "scheduled" : nil
            )
            Issue.record("injected post-spawn failure unexpectedly succeeded")
        } catch {
            // The injected error is expected. Assertions below prove the catch
            // path did not return until the exact owned PID was gone and reaped.
        }

        let pid = try #require(observation.pid)
        #expect(kill(pid, 0) == -1)
        #expect(errno == ESRCH)
        var status: Int32 = 0
        #expect(waitpid(pid, &status, WNOHANG) == -1)
        #expect(errno == ECHILD)
        if failure != .waitPID {
            #expect(FileManager.default.fileExists(atPath: termMarker.path))
        }
        try await Task.sleep(for: .milliseconds(500))
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

    private func spawnInheritedGroupAuthorizedWorker(worker: URL, marker: URL) throws -> Int32 {
        var descriptors: [Int32] = [0, 0]
        guard socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0 else {
            throw NSError(domain: "socketpair", code: Int(errno))
        }
        defer { _ = close(descriptors[1]) }
        guard fcntl(descriptors[0], F_SETFD, FD_CLOEXEC) == 0,
              fcntl(descriptors[1], F_SETFD, FD_CLOEXEC) == 0 else {
            _ = close(descriptors[0])
            throw NSError(domain: "fcntl", code: Int(errno))
        }
        var actions: posix_spawn_file_actions_t?
        guard posix_spawn_file_actions_init(&actions) == 0 else {
            _ = close(descriptors[0])
            throw NSError(domain: "spawn-actions", code: 1)
        }
        defer { posix_spawn_file_actions_destroy(&actions) }
        guard posix_spawn_file_actions_adddup2(
            &actions, descriptors[0], CollectorProcessSupervisor.workerAuthorizationDescriptor
        ) == 0,
        posix_spawn_file_actions_addclose(&actions, descriptors[0]) == 0 else {
            _ = close(descriptors[0])
            throw NSError(domain: "spawn-actions", code: 2)
        }

        let arguments = [worker.path, marker.path]
        let argumentStorage = arguments.map { strdup($0) }
        defer { argumentStorage.forEach { free($0) } }
        var argumentPointers: [UnsafeMutablePointer<CChar>?] = argumentStorage
        argumentPointers.append(nil)
        let environment = ["PATH=/usr/bin:/bin"]
        let environmentStorage = environment.map { text in text.withCString { strdup($0) } }
        defer { environmentStorage.forEach { free($0) } }
        var environmentPointers: [UnsafeMutablePointer<CChar>?] = environmentStorage
        environmentPointers.append(nil)
        var child = pid_t()
        let spawnStatus = argumentPointers.withUnsafeMutableBufferPointer { argumentBuffer in
            environmentPointers.withUnsafeMutableBufferPointer { environmentBuffer in
                posix_spawn(
                    &child, worker.path, &actions, nil, argumentBuffer.baseAddress!,
                    environmentBuffer.baseAddress!
                )
            }
        }
        _ = close(descriptors[0])
        guard spawnStatus == 0 else {
            throw NSError(domain: "posix-spawn", code: Int(spawnStatus))
        }
        let frame = Data("SLATE_WORKER_V1 scheduled \(String(repeating: "a", count: 64))\n".utf8)
        let writeStatus = frame.withUnsafeBytes { bytes in
            Darwin.write(descriptors[1], bytes.baseAddress!, bytes.count)
        }
        guard writeStatus == frame.count else {
            _ = kill(child, SIGKILL)
            var ignored: Int32 = 0
            _ = waitpid(child, &ignored, 0)
            throw NSError(domain: "write", code: Int(errno))
        }
        var status: Int32 = 0
        guard waitpid(child, &status, 0) == child else {
            throw NSError(domain: "waitpid", code: Int(errno))
        }
        return status
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

enum SupervisorInjectedFailure: String, CaseIterable, Sendable {
    case waitID
    case timeoutGroupSignal
    case timeoutChildSignal
    case timeoutKillGroupSignal
    case finishGroupSignal
    case waitPID
    case authorizationPublish
    case sleep
}

private enum SupervisorInjectedError: Error { case failure }

private final class SpawnedProcessObservation: @unchecked Sendable {
    private let lock = NSLock()
    private var storedPID: pid_t?

    var pid: pid_t? { lock.withLock { storedPID } }

    func record(pid: pid_t) {
        lock.withLock { storedPID = pid }
    }
}

private final class FaultInjectingCollectorProcessSyscalls:
    CollectorProcessSystemCalling, @unchecked Sendable
{
    private let lock = NSLock()
    private let failure: SupervisorInjectedFailure
    private let readyFile: URL

    init(failure: SupervisorInjectedFailure, readyFile: URL) {
        self.failure = failure
        self.readyFile = readyFile
    }

    func waitID(pid: pid_t, information: inout siginfo_t) -> Int32 {
        if failure == .finishGroupSignal || failure == .waitPID {
            try? waitSynchronouslyForFile(readyFile)
            information = siginfo_t()
            information.si_pid = pid
            return 0
        }
        if trip(.waitID) {
            try? waitSynchronouslyForFile(readyFile)
            errno = EIO
            return -1
        }
        return waitid(P_PID, id_t(pid), &information, WEXITED | WNOHANG | WNOWAIT)
    }

    func waitPID(pid: pid_t, status: inout Int32) -> pid_t {
        if trip(.waitPID) {
            errno = EIO
            return -1
        }
        return Darwin.waitpid(pid, &status, 0)
    }

    func sendSignal(target: pid_t, signal: Int32) -> Int32 {
        if signal == SIGTERM, target < 0, trip(.timeoutGroupSignal) {
            errno = EPERM
            return -1
        }
        if signal == SIGTERM, target > 0, trip(.timeoutChildSignal) {
            errno = EPERM
            return -1
        }
        if signal == SIGKILL, target < 0, trip(.timeoutKillGroupSignal) {
            errno = EPERM
            return -1
        }
        if signal == SIGKILL, target < 0, trip(.finishGroupSignal) {
            errno = EIO
            return -1
        }
        return Darwin.kill(target, signal)
    }

    private func trip(_ candidate: SupervisorInjectedFailure) -> Bool {
        lock.withLock { failure == candidate }
    }
}

private func waitSynchronouslyForFile(_ url: URL) throws {
    let deadline = ContinuousClock.now.advanced(by: .seconds(2))
    while ContinuousClock.now < deadline {
        if FileManager.default.fileExists(atPath: url.path) { return }
        var request = timespec(tv_sec: 0, tv_nsec: 10_000_000)
        _ = nanosleep(&request, nil)
    }
    throw SupervisorInjectedError.failure
}
