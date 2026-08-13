import Darwin
import Foundation

protocol CodexAppServerTransport: Sendable {
    func request(
        executableURL: URL,
        lines: [Data],
        responseID: Int,
        timeout: Duration
    ) async throws -> Data
}

struct CodexAppServerProcessTransport: CodexAppServerTransport, Sendable {
    private let onInputClose: @Sendable () -> Void
    private let onSpawnAttempt: @Sendable ([Int32]) -> Void

    init(
        onInputClose: @escaping @Sendable () -> Void = {},
        onSpawnAttempt: @escaping @Sendable ([Int32]) -> Void = { _ in }
    ) {
        self.onInputClose = onInputClose
        self.onSpawnAttempt = onSpawnAttempt
    }

    func request(
        executableURL: URL,
        lines: [Data],
        responseID: Int,
        timeout: Duration
    ) async throws -> Data {
        let standardInput = try Self.makePipe()
        let standardOutput = try Self.makePipe()
        let standardError = try Self.makePipe()
        let parentDescriptors = [
            standardInput.write.fileDescriptor,
            standardOutput.read.fileDescriptor,
            standardError.read.fileDescriptor,
        ]
        onSpawnAttempt(parentDescriptors + [
            standardInput.read.fileDescriptor,
            standardOutput.write.fileDescriptor,
            standardError.write.fileDescriptor,
        ])
        let process = try Self.spawn(
            executableURL: executableURL,
            standardInput: standardInput,
            standardOutput: standardOutput,
            standardError: standardError
        )
        try? standardInput.read.close()
        try? standardOutput.write.close()
        try? standardError.write.close()

        let input = ProcessInput(standardInput.write, onClose: onInputClose)

        let errorDrain = Task {
            try? await Self.drain(standardError.read)
        }

        do {
            for line in lines {
                try input.write(line)
            }
        } catch {
            input.close()
            guard await process.stop() else {
                Self.closeReaders(standardOutput, standardError, drain: errorDrain)
                throw CodexClientError.invalidResponse
            }
            Self.closeReaders(standardOutput, standardError, drain: errorDrain)
            throw CodexClientError.inputFailed
        }

        let timeoutState = TimeoutState()
        do {
            let response = try await withThrowingTaskGroup(of: Data.self) { group in
                group.addTask {
                    try await EventDrivenPipeReader(
                        from: standardOutput.read,
                        responseID: responseID,
                        timeoutState: timeoutState
                    ).read()
                }
                group.addTask {
                    try await ContinuousClock().sleep(for: timeout)
                    timeoutState.markTimedOut()
                    input.close()
                    guard await process.stop() else {
                        throw CodexClientError.invalidResponse
                    }
                    throw CodexClientError.timeout
                }
                guard let first = try await group.next() else {
                    throw CodexClientError.invalidResponse
                }
                group.cancelAll()
                return first
            }
            input.close()
            guard await process.stop() else {
                throw CodexClientError.invalidResponse
            }
            Self.closeReaders(standardOutput, standardError, drain: errorDrain)
            return response
        } catch {
            input.close()
            let stopped = await process.stop()
            Self.closeReaders(standardOutput, standardError, drain: errorDrain)
            guard stopped else {
                throw CodexClientError.invalidResponse
            }
            if let clientError = error as? CodexClientError {
                throw clientError
            }
            if error is CancellationError {
                throw CancellationError()
            }
            throw CodexClientError.invalidResponse
        }
    }

    private static func drain(_ handle: FileHandle) async throws {
        try await EventDrivenPipeReader(from: handle).drain()
    }

    private static func closeReaders(
        _ standardOutput: CodexPipe,
        _ standardError: CodexPipe,
        drain: Task<Void?, Never>
    ) {
        drain.cancel()
        try? standardOutput.read.close()
        try? standardError.read.close()
    }

    private static func makePipe() throws -> CodexPipe {
        var descriptors: [Int32] = [-1, -1]
        guard Darwin.pipe(&descriptors) == 0 else { throw CodexClientError.launchFailed }
        var ownsDescriptors = true
        defer {
            if ownsDescriptors {
                descriptors.filter { $0 >= 0 }.forEach { _ = Darwin.close($0) }
            }
        }
        for index in descriptors.indices where descriptors[index] < STDERR_FILENO + 1 {
            let original = descriptors[index]
            let relocated = Darwin.fcntl(original, F_DUPFD_CLOEXEC, STDERR_FILENO + 1)
            guard relocated >= STDERR_FILENO + 1 else { throw CodexClientError.launchFailed }
            _ = Darwin.close(original)
            descriptors[index] = relocated
        }
        for descriptor in descriptors {
            let flags = Darwin.fcntl(descriptor, F_GETFD)
            guard flags >= 0,
                  Darwin.fcntl(descriptor, F_SETFD, flags | FD_CLOEXEC) == 0 else {
                throw CodexClientError.launchFailed
            }
        }
        ownsDescriptors = false
        return CodexPipe(
            read: FileHandle(fileDescriptor: descriptors[0], closeOnDealloc: true),
            write: FileHandle(fileDescriptor: descriptors[1], closeOnDealloc: true)
        )
    }

    private static func spawn(
        executableURL: URL,
        standardInput: CodexPipe,
        standardOutput: CodexPipe,
        standardError: CodexPipe
    ) throws -> CodexSpawnedProcess {
        var attributes: posix_spawnattr_t?
        guard posix_spawnattr_init(&attributes) == 0 else { throw CodexClientError.launchFailed }
        defer { posix_spawnattr_destroy(&attributes) }
        var actions: posix_spawn_file_actions_t?
        guard posix_spawn_file_actions_init(&actions) == 0 else { throw CodexClientError.launchFailed }
        defer { posix_spawn_file_actions_destroy(&actions) }

        let mappings: [(Int32, Int32)] = [
            (standardInput.read.fileDescriptor, STDIN_FILENO),
            (standardOutput.write.fileDescriptor, STDOUT_FILENO),
            (standardError.write.fileDescriptor, STDERR_FILENO),
        ]
        for (source, destination) in mappings {
            guard source == destination || (
                posix_spawn_file_actions_adddup2(&actions, source, destination) == 0 &&
                posix_spawn_file_actions_addclose(&actions, source) == 0
            ) else {
                throw CodexClientError.launchFailed
            }
        }
        let parentDescriptors = [
            standardInput.write.fileDescriptor,
            standardOutput.read.fileDescriptor,
            standardError.read.fileDescriptor,
        ]
        for descriptor in parentDescriptors {
            guard posix_spawn_file_actions_addclose(&actions, descriptor) == 0 else {
                throw CodexClientError.launchFailed
            }
        }

        var defaultSignals = sigset_t()
        sigemptyset(&defaultSignals)
        sigaddset(&defaultSignals, SIGTERM)
        sigaddset(&defaultSignals, SIGINT)
        sigaddset(&defaultSignals, SIGHUP)
        var signalMask = sigset_t()
        sigemptyset(&signalMask)
        let flags = Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK)
        guard posix_spawnattr_setflags(&attributes, flags) == 0,
              posix_spawnattr_setpgroup(&attributes, 0) == 0,
              posix_spawnattr_setsigdefault(&attributes, &defaultSignals) == 0,
              posix_spawnattr_setsigmask(&attributes, &signalMask) == 0 else {
            throw CodexClientError.launchFailed
        }

        let executable = executableURL.path
        let argv = [executable, "app-server", "--stdio"]
        var child: pid_t = 0
        let status = withCStringArray(argv) { pointers in
            posix_spawn(&child, executable, &actions, &attributes, pointers, environ)
        }
        guard status == 0, child > 0 else { throw CodexClientError.launchFailed }
        return CodexSpawnedProcess(pid: child)
    }

    private static func withCStringArray<Result>(
        _ strings: [String],
        _ body: (UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>) -> Result
    ) -> Result {
        let storage = strings.map { strdup($0) }
        defer { storage.forEach { free($0) } }
        var pointers: [UnsafeMutablePointer<CChar>?] = storage
        pointers.append(nil)
        return pointers.withUnsafeMutableBufferPointer { body($0.baseAddress!) }
    }
}

private struct CodexPipe {
    let read: FileHandle
    let write: FileHandle
}

private final class CodexSpawnedProcess: @unchecked Sendable {
    private let pid: pid_t
    private let lock = NSLock()
    private var reaped = false

    init(pid: pid_t) { self.pid = pid }

    func stop() async -> Bool {
        if lock.withLock({ reaped }) { return true }
        guard signalGroup(SIGTERM) else { return false }
        let clock = ContinuousClock()
        let termDeadline = clock.now.advanced(by: .seconds(1))
        while !didExitWithoutReaping(), clock.now < termDeadline {
            try? await clock.sleep(for: .milliseconds(20))
        }
        guard signalGroup(SIGKILL) else { return false }
        let killDeadline = clock.now.advanced(by: .seconds(1))
        while !didExitWithoutReaping(), clock.now < killDeadline {
            try? await clock.sleep(for: .milliseconds(20))
        }
        guard didExitWithoutReaping() else { return false }
        guard signalGroup(SIGKILL) else { return false }
        var status: Int32 = 0
        while true {
            let value = Darwin.waitpid(pid, &status, 0)
            if value == pid {
                lock.withLock { reaped = true }
                return true
            }
            if value < 0, errno == EINTR { continue }
            return lock.withLock { reaped }
        }
    }

    private func didExitWithoutReaping() -> Bool {
        if lock.withLock({ reaped }) { return true }
        var information = siginfo_t()
        while true {
            let value = waitid(P_PID, id_t(pid), &information, WEXITED | WNOHANG | WNOWAIT)
            if value == 0 { return information.si_pid == pid }
            if errno == EINTR { continue }
            return false
        }
    }

    private func signalGroup(_ signal: Int32) -> Bool {
        let groupStatus = Darwin.kill(-pid, signal)
        let groupError = errno
        // EPERM can mean the only remaining member is the already-dead,
        // unreaped leader. Any live same-user helper would make the group
        // signal succeed; the owned leader is addressed separately below.
        guard groupStatus == 0 || groupError == ESRCH || groupError == EPERM else { return false }
        let childStatus = Darwin.kill(pid, signal)
        let childError = errno
        return childStatus == 0 || childError == ESRCH
    }
}

private final class ProcessInput: @unchecked Sendable {
    private let handle: FileHandle
    private let lock = NSLock()
    private var isClosed = false
    private let onClose: @Sendable () -> Void

    init(_ handle: FileHandle, onClose: @escaping @Sendable () -> Void) {
        self.handle = handle
        self.onClose = onClose
        _ = Darwin.fcntl(handle.fileDescriptor, F_SETNOSIGPIPE, 1)
    }

    func write(_ data: Data) throws {
        try lock.withLock {
            guard !isClosed else { throw CodexClientError.inputFailed }
            try handle.write(contentsOf: data)
        }
    }

    func close() {
        let didClose = lock.withLock {
            guard !isClosed else { return false }
            isClosed = true
            try? handle.close()
            return true
        }
        if didClose { onClose() }
    }
}

private final class EventDrivenPipeReader: @unchecked Sendable {
    private enum Mode {
        case drain
        case target(responseID: Int, timeoutState: TimeoutState)
    }

    private struct TargetEnvelope: Decodable {
        let id: Int
    }

    private let handle: FileHandle
    private let mode: Mode
    private let lock = NSLock()
    private var buffer = Data()
    private var continuation: CheckedContinuation<Data, any Error>?
    private var isFinished = false
    private var isCancelled = false

    init(from handle: FileHandle) {
        self.handle = handle
        mode = .drain
    }

    init(from handle: FileHandle, responseID: Int, timeoutState: TimeoutState) {
        self.handle = handle
        mode = .target(responseID: responseID, timeoutState: timeoutState)
    }

    func read() async throws -> Data {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                lock.lock()
                if isCancelled || Task.isCancelled {
                    isFinished = true
                    lock.unlock()
                    continuation.resume(throwing: CancellationError())
                    return
                }
                self.continuation = continuation
                handle.readabilityHandler = { [weak self] readableHandle in
                    self?.consume(readableHandle.availableData)
                }
                lock.unlock()
            }
        } onCancel: {
            cancel()
        }
    }

    func drain() async throws {
        _ = try await read()
    }

    private func consume(_ data: Data) {
        lock.lock()
        guard !isFinished else {
            lock.unlock()
            return
        }

        if data.isEmpty {
            let result = endOfFileResult()
            finishLocked(with: result)
            return
        }

        guard case let .target(responseID, _) = mode else {
            lock.unlock()
            return
        }
        buffer.append(data)
        while let newline = buffer.firstIndex(of: 0x0A) {
            let line = Data(buffer[..<newline])
            buffer.removeSubrange(...newline)
            if Self.isTarget(line, responseID: responseID) {
                finishLocked(with: .success(line))
                return
            }
        }
        lock.unlock()
    }

    private func endOfFileResult() -> Result<Data, any Error> {
        switch mode {
        case .drain:
            return .success(Data())
        case let .target(responseID, timeoutState):
            if Self.isTarget(buffer, responseID: responseID) {
                return .success(buffer)
            }
            if timeoutState.didTimeOut {
                return .failure(CodexClientError.timeout)
            }
            return .failure(CodexClientError.invalidResponse)
        }
    }

    private func cancel() {
        lock.lock()
        isCancelled = true
        guard !isFinished, continuation != nil else {
            lock.unlock()
            return
        }
        finishLocked(with: .failure(CancellationError()))
    }

    private func finishLocked(with result: Result<Data, any Error>) {
        isFinished = true
        handle.readabilityHandler = nil
        let continuation = continuation
        self.continuation = nil
        lock.unlock()
        continuation?.resume(with: result)
    }

    private static func isTarget(_ data: Data, responseID: Int) -> Bool {
        guard !data.isEmpty else { return false }
        return (try? JSONDecoder().decode(TargetEnvelope.self, from: data).id) == responseID
    }
}

private final class TimeoutState: @unchecked Sendable {
    private let lock = NSLock()
    private var timedOut = false

    var didTimeOut: Bool {
        lock.withLock { timedOut }
    }

    func markTimedOut() {
        lock.withLock { timedOut = true }
    }
}
