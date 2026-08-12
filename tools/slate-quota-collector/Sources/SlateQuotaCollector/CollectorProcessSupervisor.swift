import Darwin
import Foundation
import Security

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

enum WorkerAuthorizationError: Error, Equatable, Sendable { case invalid }

protocol CollectorProcessSystemCalling: Sendable {
    func waitID(pid: pid_t, information: inout siginfo_t) -> Int32
    func waitPID(pid: pid_t, status: inout Int32) -> pid_t
    func sendSignal(target: pid_t, signal: Int32) -> Int32
}

struct DarwinCollectorProcessSyscalls: CollectorProcessSystemCalling {
    func waitID(pid: pid_t, information: inout siginfo_t) -> Int32 {
        waitid(P_PID, id_t(pid), &information, WEXITED | WNOHANG | WNOWAIT)
    }

    func waitPID(pid: pid_t, status: inout Int32) -> pid_t {
        Darwin.waitpid(pid, &status, 0)
    }

    func sendSignal(target: pid_t, signal: Int32) -> Int32 {
        Darwin.kill(target, signal)
    }
}

/// Owns one successfully spawned child until the supervisor has proof that the
/// exact PID was reaped. Its failure cleanup deliberately bypasses injected
/// operational syscalls: fault injection and a failing normal syscall path must
/// never be able to disable the last-resort ownership boundary.
private final class SpawnedCollectorProcessOwnership {
    private let pid: pid_t
    private let terminationGrace: Duration
    private let pollInterval: Duration
    private var isOwned = true

    init(pid: pid_t, terminationGrace: Duration, pollInterval: Duration) {
        self.pid = pid
        self.terminationGrace = terminationGrace
        self.pollInterval = pollInterval
    }

    func release(_ result: CollectorProcessResult) -> CollectorProcessResult {
        precondition(result.pid == pid && result.reaped)
        isOwned = false
        return result
    }

    func cleanupIfStillOwned() {
        guard isOwned else { return }

        bestEffortSignal(target: -pid, signal: SIGTERM)
        bestEffortSignal(target: pid, signal: SIGTERM)
        waitThroughGraceOrExit()

        // Address the exact child before the group. The still-unreaped child
        // pins both its PID and its process-group identity against reuse.
        bestEffortSignal(target: pid, signal: SIGKILL)
        bestEffortSignal(target: -pid, signal: SIGKILL)
        exactBestEffortReap()
    }

    private func waitThroughGraceOrExit() {
        let deadline = ContinuousClock.now.advanced(by: terminationGrace)
        while ContinuousClock.now < deadline {
            var information = siginfo_t()
            let value = waitid(P_PID, id_t(pid), &information, WEXITED | WNOHANG | WNOWAIT)
            if value == 0, information.si_pid == pid { return }
            if value < 0, errno != EINTR { break }
            sleepUntilNextPoll(notAfter: deadline)
        }
    }

    private func bestEffortSignal(target: pid_t, signal: Int32) {
        while Darwin.kill(target, signal) != 0, errno == EINTR {}
    }

    private func exactBestEffortReap() {
        var status: Int32 = 0
        while true {
            let value = Darwin.waitpid(pid, &status, 0)
            if value == pid {
                isOwned = false
                return
            }
            if value < 0, errno == EINTR { continue }
            // There is no safe alternate identity to reap. ECHILD can only
            // mean an external SIGCHLD policy stole ownership; all kill/group
            // cleanup attempts above have still completed before returning.
            return
        }
    }

    private func sleepUntilNextPoll(notAfter deadline: ContinuousClock.Instant) {
        let remaining = ContinuousClock.now.duration(to: deadline)
        guard remaining > .zero else { return }
        let duration = min(pollInterval, remaining)
        let components = duration.components
        var request = timespec(
            tv_sec: Int(components.seconds),
            tv_nsec: Int(components.attoseconds / 1_000_000_000)
        )
        var remainingRequest = timespec()
        while nanosleep(&request, &remainingRequest) != 0, errno == EINTR {
            request = remainingRequest
        }
    }
}

struct CollectorProcessSupervisor: Sendable {
    static let workerAuthorizationDescriptor: Int32 = 198
    static let productionWallClockLimit: Duration = .seconds(45)
    static let productionTerminationGrace: Duration = .seconds(2)

    let wallClockLimit: Duration
    let terminationGrace: Duration
    private let pollInterval: Duration
    private let syscalls: any CollectorProcessSystemCalling
    private let didSpawn: @Sendable (pid_t) -> Void
    private let beforeAuthorizationPublish: @Sendable () throws -> Void
    private let beforeSleep: @Sendable () throws -> Void

    init(
        wallClockLimit: Duration = Self.productionWallClockLimit,
        terminationGrace: Duration = Self.productionTerminationGrace,
        pollInterval: Duration = .milliseconds(10),
        syscalls: any CollectorProcessSystemCalling = DarwinCollectorProcessSyscalls(),
        didSpawn: @escaping @Sendable (pid_t) -> Void = { _ in },
        beforeAuthorizationPublish: @escaping @Sendable () throws -> Void = {},
        beforeSleep: @escaping @Sendable () throws -> Void = {}
    ) {
        self.wallClockLimit = wallClockLimit
        self.terminationGrace = terminationGrace
        self.pollInterval = pollInterval
        self.syscalls = syscalls
        self.didSpawn = didSpawn
        self.beforeAuthorizationPublish = beforeAuthorizationPublish
        self.beforeSleep = beforeSleep
    }

    /// The deadline starts only after posix_spawn has returned a child PID.
    /// The child is its own process-group leader so timeout signals also reach
    /// read-only helper descendants such as `codex app-server`.
    func run(
        executableURL: URL,
        arguments: [String],
        environment: [String: String] = ProcessInfo.processInfo.environment,
        inheritedWorkerMode: String? = nil
    ) async throws -> CollectorProcessResult {
        let executable = executableURL.standardizedFileURL
        guard executable.path.hasPrefix("/"), access(executable.path, X_OK) == 0 else {
            throw CollectorProcessSupervisorError.invalidExecutable
        }

        let authorization = try inheritedWorkerMode.map { try WorkerAuthorizationSocket(mode: $0) }
        defer { withExtendedLifetime(authorization) {} }
        let child = try spawn(
            executable: executable.path,
            arguments: arguments,
            environment: environment,
            authorizationReadDescriptor: authorization?.childDescriptor
        )
        let ownership = SpawnedCollectorProcessOwnership(
            pid: child,
            terminationGrace: terminationGrace,
            pollInterval: pollInterval
        )
        defer { ownership.cleanupIfStillOwned() }
        didSpawn(child)
        try beforeAuthorizationPublish()
        try authorization?.publishAndCloseChildEnd()
        let deadline = ContinuousClock.now.advanced(by: wallClockLimit)

        while ContinuousClock.now < deadline {
            if Task.isCancelled {
                throw CancellationError()
            }
            if try observeExitedWithoutReaping(pid: child) {
                return ownership.release(try finishExited(pid: child))
            }
            try sleepUntilNextPoll(notAfter: deadline)
        }

        // Resolve an exit-at-deadline race before sending a signal. An unreaped
        // child retains its PID, so a zero WNOHANG result cannot target a reused PID.
        if try observeExitedWithoutReaping(pid: child) {
            return ownership.release(try finishExited(pid: child))
        }

        try signalProcessGroup(pid: child, signal: SIGTERM)
        let graceDeadline = ContinuousClock.now.advanced(by: terminationGrace)
        while ContinuousClock.now < graceDeadline {
            if try observeExitedWithoutReaping(pid: child) {
                return ownership.release(try finishTimedOut(pid: child, signal: .term))
            }
            try sleepUntilNextPoll(notAfter: graceDeadline)
        }

        if try observeExitedWithoutReaping(pid: child) {
            return ownership.release(try finishTimedOut(pid: child, signal: .term))
        }

        try signalProcessGroup(pid: child, signal: SIGKILL)
        _ = try reapBlocking(pid: child)
        return ownership.release(
            CollectorProcessResult(
                pid: child, outcome: .timedOut(signal: .kill), reaped: true
            )
        )
    }

    private func spawn(
        executable: String,
        arguments: [String],
        environment: [String: String],
        authorizationReadDescriptor: Int32?
    ) throws -> pid_t {
        var attributes: posix_spawnattr_t?
        guard posix_spawnattr_init(&attributes) == 0 else {
            throw CollectorProcessSupervisorError.spawnFailed
        }
        defer { posix_spawnattr_destroy(&attributes) }
        var fileActions: posix_spawn_file_actions_t?
        guard posix_spawn_file_actions_init(&fileActions) == 0 else {
            throw CollectorProcessSupervisorError.spawnFailed
        }
        defer { posix_spawn_file_actions_destroy(&fileActions) }
        if let descriptor = authorizationReadDescriptor,
           descriptor != Self.workerAuthorizationDescriptor {
            guard posix_spawn_file_actions_adddup2(
                &fileActions, descriptor, Self.workerAuthorizationDescriptor
            ) == 0,
            posix_spawn_file_actions_addclose(&fileActions, descriptor) == 0 else {
                throw CollectorProcessSupervisorError.spawnFailed
            }
        }

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
                    &fileActions,
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
            let value = syscalls.waitID(pid: pid, information: &information)
            if value == 0 { return information.si_pid == pid }
            if errno == EINTR { continue }
            throw CollectorProcessSupervisorError.waitFailed
        }
    }

    private func reapBlocking(pid: pid_t) throws -> Int32 {
        var status: Int32 = 0
        while true {
            let value = syscalls.waitPID(pid: pid, status: &status)
            if value == pid { return status }
            if value < 0, errno == EINTR { continue }
            throw CollectorProcessSupervisorError.waitFailed
        }
    }

    private func signalProcessGroup(pid: pid_t, signal: Int32) throws {
        let groupStatus = syscalls.sendSignal(target: -pid, signal: signal)
        let groupError = errno
        guard groupStatus == 0 || groupError == ESRCH else {
            throw CollectorProcessSupervisorError.waitFailed
        }
        // Always address the owned child as well. Some macOS launch contexts
        // report a process-group signal as accepted before group membership is
        // observable. The unreaped child PID cannot have been reused.
        let childStatus = syscalls.sendSignal(target: pid, signal: signal)
        let childError = errno
        guard childStatus == 0 || childError == ESRCH else {
            throw CollectorProcessSupervisorError.waitFailed
        }
    }

    /// The leader is still an unreaped zombie when this runs, which pins both
    /// its PID and process-group identity and removes PID-reuse ambiguity.
    private func terminateRemainingProcessGroup(pid: pid_t) throws {
        let status = syscalls.sendSignal(target: -pid, signal: SIGKILL)
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

    private func sleepUntilNextPoll(notAfter deadline: ContinuousClock.Instant) throws {
        try beforeSleep()
        let remaining = ContinuousClock.now.duration(to: deadline)
        guard remaining > .zero else { return }
        let duration = min(pollInterval, remaining)
        let components = duration.components
        var request = timespec(
            tv_sec: Int(components.seconds),
            tv_nsec: Int(components.attoseconds / 1_000_000_000)
        )
        var remainingRequest = timespec()
        while nanosleep(&request, &remainingRequest) != 0, errno == EINTR {
            request = remainingRequest
        }
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

private final class WorkerAuthorizationSocket: @unchecked Sendable {
    let childDescriptor: Int32
    private let parentDescriptor: Int32
    private let frame: Data
    private var childOpen = true
    private var parentOpen = true

    init(mode: String) throws {
        var descriptors: [Int32] = [0, 0]
        guard socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0 else {
            throw CollectorProcessSupervisorError.spawnFailed
        }
        var authorizationDescriptor = descriptors[0]
        let livenessDescriptor = descriptors[1]
        if authorizationDescriptor == CollectorProcessSupervisor.workerAuthorizationDescriptor {
            let relocated = fcntl(
                authorizationDescriptor,
                F_DUPFD_CLOEXEC,
                CollectorProcessSupervisor.workerAuthorizationDescriptor + 1
            )
            guard relocated >= 0 else {
                _ = close(authorizationDescriptor)
                _ = close(livenessDescriptor)
                throw CollectorProcessSupervisorError.spawnFailed
            }
            _ = close(authorizationDescriptor)
            authorizationDescriptor = relocated
        }
        childDescriptor = authorizationDescriptor
        parentDescriptor = livenessDescriptor
        guard fcntl(childDescriptor, F_SETFD, FD_CLOEXEC) == 0,
              fcntl(parentDescriptor, F_SETFD, FD_CLOEXEC) == 0 else {
            _ = close(childDescriptor)
            _ = close(parentDescriptor)
            throw CollectorProcessSupervisorError.spawnFailed
        }
        var noSigPipe: Int32 = 1
        guard setsockopt(
            parentDescriptor, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe,
            socklen_t(MemoryLayout<Int32>.size)
        ) == 0 else {
            _ = close(childDescriptor)
            _ = close(parentDescriptor)
            throw CollectorProcessSupervisorError.spawnFailed
        }
        var nonce = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, nonce.count, &nonce) == errSecSuccess else {
            _ = close(childDescriptor)
            _ = close(parentDescriptor)
            throw CollectorProcessSupervisorError.spawnFailed
        }
        let nonceText = nonce.map { String(format: "%02x", $0) }.joined()
        frame = Data("SLATE_WORKER_V1 \(mode) \(nonceText)\n".utf8)
    }

    func publishAndCloseChildEnd() throws {
        var written = 0
        try frame.withUnsafeBytes { raw in
            while written < raw.count {
                let count = Darwin.write(
                    parentDescriptor,
                    raw.baseAddress!.advanced(by: written),
                    raw.count - written
                )
                if count < 0, errno == EINTR { continue }
                guard count > 0 else { throw CollectorProcessSupervisorError.spawnFailed }
                written += count
            }
        }
        closeChildEnd()
    }

    private func closeChildEnd() {
        guard childOpen else { return }
        _ = close(childDescriptor)
        childOpen = false
    }

    private func closeBoth() {
        closeChildEnd()
        if parentOpen {
            _ = close(parentDescriptor)
            parentOpen = false
        }
    }

    deinit { closeBoth() }
}

enum WorkerParentAuthorization {
    private static let maximumFrameBytes = 128

    static func consume(expectedMode: String) throws {
        let descriptor = CollectorProcessSupervisor.workerAuthorizationDescriptor
        guard getpgrp() == getpid() else {
            throw WorkerAuthorizationError.invalid
        }
        var status = stat()
        guard fstat(descriptor, &status) == 0,
              status.st_mode & S_IFMT == S_IFSOCK,
              status.st_uid == getuid() else {
            throw WorkerAuthorizationError.invalid
        }
        var peerUID = uid_t()
        var peerGID = gid_t()
        guard getpeereid(descriptor, &peerUID, &peerGID) == 0,
              peerUID == getuid() else {
            throw WorkerAuthorizationError.invalid
        }
        var peerPID = pid_t()
        var peerPIDSize = socklen_t(MemoryLayout<pid_t>.size)
        guard getsockopt(
            descriptor, SOL_LOCAL, LOCAL_PEERPID, &peerPID, &peerPIDSize
        ) == 0,
        peerPID == getppid() else {
            throw WorkerAuthorizationError.invalid
        }

        let deadline = ContinuousClock.now.advanced(by: .seconds(1))
        var bytes: [UInt8] = []
        while bytes.last != UInt8(ascii: "\n"), bytes.count <= maximumFrameBytes {
            let remaining = ContinuousClock.now.duration(to: deadline)
            guard remaining > .zero else { throw WorkerAuthorizationError.invalid }
            var pollDescriptor = pollfd(fd: descriptor, events: Int16(POLLIN), revents: 0)
            let pollResult = poll(&pollDescriptor, 1, 50)
            if pollResult < 0, errno == EINTR { continue }
            guard pollResult == 1,
                  pollDescriptor.revents & Int16(POLLIN) != 0 else {
                continue
            }
            var byte: UInt8 = 0
            let count = Darwin.read(descriptor, &byte, 1)
            if count < 0, errno == EINTR { continue }
            guard count == 1 else { throw WorkerAuthorizationError.invalid }
            bytes.append(byte)
        }
        guard bytes.count <= maximumFrameBytes,
              let frame = String(bytes: bytes, encoding: .utf8),
              frame.last == "\n" else {
            throw WorkerAuthorizationError.invalid
        }
        let parts = frame.dropLast().split(separator: " ", omittingEmptySubsequences: false)
        guard parts.count == 3,
              parts[0] == "SLATE_WORKER_V1",
              parts[1] == expectedMode,
              parts[2].count == 64,
              parts[2].allSatisfy({ $0.isHexDigit && !$0.isUppercase }) else {
            throw WorkerAuthorizationError.invalid
        }
        guard fcntl(descriptor, F_SETFD, FD_CLOEXEC) == 0 else {
            throw WorkerAuthorizationError.invalid
        }
        try startParentLivenessMonitor(descriptor: descriptor)
    }

    private static func startParentLivenessMonitor(descriptor: Int32) throws {
        guard let context = UnsafeMutableRawPointer(bitPattern: Int(descriptor)) else {
            throw WorkerAuthorizationError.invalid
        }
        var thread: pthread_t?
        let result = pthread_create(&thread, nil, parentLivenessMonitor, context)
        guard result == 0, let thread else {
            throw WorkerAuthorizationError.invalid
        }
        pthread_detach(thread)
    }
}

@_cdecl("slateQuotaParentLivenessMonitor")
private func parentLivenessMonitor(
    _ raw: UnsafeMutableRawPointer
) -> UnsafeMutableRawPointer? {
    let descriptor = Int32(Int(bitPattern: raw))
    var byte: UInt8 = 0
    while true {
        let count = Darwin.read(descriptor, &byte, 1)
        if count > 0 { continue }
        if count < 0, errno == EINTR { continue }
        _ = Darwin.kill(-getpgrp(), SIGKILL)
        _exit(137)
    }
}
