import Darwin
import Foundation

enum CollectorTerminationSignal: Equatable, Sendable {
    case term
    case kill
}

enum CollectorProcessOutcome: Equatable, Sendable {
    case exited(code: Int32)
    case signaled(signal: Int32)
    case timedOut(signal: CollectorTerminationSignal)
}

struct CollectorProcessResult: Equatable, Sendable {
    let pid: pid_t
    let outcome: CollectorProcessOutcome
    /// True only after waitpid returned this exact child PID. A signal result,
    /// Process.isRunning, or kill(pid, 0) is never used as proof of reaping.
    let reaped: Bool
}

enum CollectorProcessSupervisorError: Error, Equatable, Sendable, CustomStringConvertible {
    case invalidExecutable
    case spawnFailed
    case waitFailed

    var publicCode: String {
        switch self {
        case .invalidExecutable: "worker_executable"
        case .spawnFailed: "worker_spawn"
        case .waitFailed: "worker_wait"
        }
    }

    var description: String { "CollectorProcessSupervisorError(code: \(publicCode))" }
}

struct CollectorProcessSupervisor: Sendable {
    static let productionWallClockLimit: Duration = .seconds(45)
    static let productionTerminationGrace: Duration = .seconds(2)

    let wallClockLimit: Duration
    let terminationGrace: Duration
    private let pollInterval: Duration

    init(
        wallClockLimit: Duration = Self.productionWallClockLimit,
        terminationGrace: Duration = Self.productionTerminationGrace,
        pollInterval: Duration = .milliseconds(10)
    ) {
        self.wallClockLimit = wallClockLimit
        self.terminationGrace = terminationGrace
        self.pollInterval = pollInterval
    }

    /// The deadline starts only after posix_spawn has returned a child PID.
    /// The child is its own process-group leader so timeout signals also reach
    /// read-only helper descendants such as `codex app-server`.
    func run(
        executableURL: URL,
        arguments: [String],
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) async throws -> CollectorProcessResult {
        let executable = executableURL.standardizedFileURL
        guard executable.path.hasPrefix("/"), access(executable.path, X_OK) == 0 else {
            throw CollectorProcessSupervisorError.invalidExecutable
        }

        let child = try spawn(
            executable: executable.path,
            arguments: arguments,
            environment: environment
        )
        let deadline = ContinuousClock.now.advanced(by: wallClockLimit)

        while ContinuousClock.now < deadline {
            if try observeExitedWithoutReaping(pid: child) {
                return try finishExited(pid: child)
            }
            try await sleepUntilNextPoll(notAfter: deadline)
        }

        // Resolve an exit-at-deadline race before sending a signal. An unreaped
        // child retains its PID, so a zero WNOHANG result cannot target a reused PID.
        if try observeExitedWithoutReaping(pid: child) {
            return try finishExited(pid: child)
        }

        try signalProcessGroup(pid: child, signal: SIGTERM)
        let graceDeadline = ContinuousClock.now.advanced(by: terminationGrace)
        while ContinuousClock.now < graceDeadline {
            if try observeExitedWithoutReaping(pid: child) {
                return try finishTimedOut(pid: child, signal: .term)
            }
            try await sleepUntilNextPoll(notAfter: graceDeadline)
        }

        if try observeExitedWithoutReaping(pid: child) {
            return try finishTimedOut(pid: child, signal: .term)
        }

        try signalProcessGroup(pid: child, signal: SIGKILL)
        _ = try reapBlocking(pid: child)
        return CollectorProcessResult(
            pid: child, outcome: .timedOut(signal: .kill), reaped: true
        )
    }

    private func spawn(
        executable: String,
        arguments: [String],
        environment: [String: String]
    ) throws -> pid_t {
        var attributes: posix_spawnattr_t?
        guard posix_spawnattr_init(&attributes) == 0 else {
            throw CollectorProcessSupervisorError.spawnFailed
        }
        defer { posix_spawnattr_destroy(&attributes) }

        var defaultSignals = sigset_t()
        sigemptyset(&defaultSignals)
        sigaddset(&defaultSignals, SIGTERM)
        sigaddset(&defaultSignals, SIGINT)
        sigaddset(&defaultSignals, SIGHUP)
        var signalMask = sigset_t()
        sigemptyset(&signalMask)
        let flags = Int16(
            POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK
        )
        guard posix_spawnattr_setflags(&attributes, flags) == 0,
              posix_spawnattr_setpgroup(&attributes, 0) == 0,
              posix_spawnattr_setsigdefault(&attributes, &defaultSignals) == 0,
              posix_spawnattr_setsigmask(&attributes, &signalMask) == 0 else {
            throw CollectorProcessSupervisorError.spawnFailed
        }

        var child: pid_t = 0
        let argv = [executable] + arguments
        let env = environment.sorted(by: { $0.key < $1.key }).map { "\($0.key)=\($0.value)" }
        let spawnStatus = withCStringArray(argv) { argumentPointers in
            withCStringArray(env) { environmentPointers in
                posix_spawn(
                    &child,
                    executable,
                    nil,
                    &attributes,
                    argumentPointers,
                    environmentPointers
                )
            }
        }
        guard spawnStatus == 0, child > 0 else {
            throw CollectorProcessSupervisorError.spawnFailed
        }
        return child
    }

    private func withCStringArray<Result>(
        _ strings: [String],
        _ body: (UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>) -> Result
    ) -> Result {
        let storage = strings.map { strdup($0) }
        defer { storage.forEach { free($0) } }
        var pointers: [UnsafeMutablePointer<CChar>?] = storage
        pointers.append(nil)
        return pointers.withUnsafeMutableBufferPointer { buffer in
            body(buffer.baseAddress!)
        }
    }

    private func observeExitedWithoutReaping(pid: pid_t) throws -> Bool {
        var information = siginfo_t()
        while true {
            let value = waitid(P_PID, id_t(pid), &information, WEXITED | WNOHANG | WNOWAIT)
            if value == 0 { return information.si_pid == pid }
            if errno == EINTR { continue }
            throw CollectorProcessSupervisorError.waitFailed
        }
    }

    private func reapBlocking(pid: pid_t) throws -> Int32 {
        var status: Int32 = 0
        while true {
            let value = waitpid(pid, &status, 0)
            if value == pid { return status }
            if value < 0, errno == EINTR { continue }
            throw CollectorProcessSupervisorError.waitFailed
        }
    }

    private func signalProcessGroup(pid: pid_t, signal: Int32) throws {
        let groupStatus = Darwin.kill(-pid, signal)
        let groupError = errno
        guard groupStatus == 0 || groupError == ESRCH else {
            throw CollectorProcessSupervisorError.waitFailed
        }
        // Always address the owned child as well. Some macOS launch contexts
        // report a process-group signal as accepted before group membership is
        // observable. The unreaped child PID cannot have been reused.
        let childStatus = Darwin.kill(pid, signal)
        let childError = errno
        guard childStatus == 0 || childError == ESRCH else {
            throw CollectorProcessSupervisorError.waitFailed
        }
    }

    /// The leader is still an unreaped zombie when this runs, which pins both
    /// its PID and process-group identity and removes PID-reuse ambiguity.
    private func terminateRemainingProcessGroup(pid: pid_t) throws {
        let status = Darwin.kill(-pid, SIGKILL)
        let error = errno
        // EPERM here can mean the only group member is the already-dead zombie
        // leader. Any live production helper is same-UID and would be killable.
        if status == 0 || error == ESRCH || error == EPERM { return }
        throw CollectorProcessSupervisorError.waitFailed
    }

    private func finishExited(pid: pid_t) throws -> CollectorProcessResult {
        try terminateRemainingProcessGroup(pid: pid)
        return result(pid: pid, status: try reapBlocking(pid: pid))
    }

    private func finishTimedOut(
        pid: pid_t,
        signal: CollectorTerminationSignal
    ) throws -> CollectorProcessResult {
        try terminateRemainingProcessGroup(pid: pid)
        _ = try reapBlocking(pid: pid)
        return CollectorProcessResult(pid: pid, outcome: .timedOut(signal: signal), reaped: true)
    }

    private func sleepUntilNextPoll(notAfter deadline: ContinuousClock.Instant) async throws {
        let remaining = ContinuousClock.now.duration(to: deadline)
        guard remaining > .zero else { return }
        try await Task.sleep(for: min(pollInterval, remaining))
    }

    private func result(pid: pid_t, status: Int32) -> CollectorProcessResult {
        let signal = status & 0x7f
        if signal == 0 {
            return CollectorProcessResult(
                pid: pid,
                outcome: .exited(code: (status >> 8) & 0xff),
                reaped: true
            )
        }
        return CollectorProcessResult(pid: pid, outcome: .signaled(signal: signal), reaped: true)
    }
}
