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
    func request(
        executableURL: URL,
        lines: [Data],
        responseID: Int,
        timeout: Duration
    ) async throws -> Data {
        let process = Process()
        let standardInput = Pipe()
        let standardOutput = Pipe()
        let standardError = Pipe()
        process.executableURL = executableURL
        process.arguments = ["app-server", "--stdio"]
        process.standardInput = standardInput
        process.standardOutput = standardOutput
        process.standardError = standardError

        do {
            try process.run()
        } catch {
            throw CodexClientError.launchFailed
        }

        let errorDrain = Task {
            try? await Self.drain(standardError.fileHandleForReading)
        }

        do {
            for line in lines {
                try standardInput.fileHandleForWriting.write(contentsOf: line)
            }
            try standardInput.fileHandleForWriting.close()
        } catch {
            try? standardInput.fileHandleForWriting.close()
            await Self.stop(process)
            _ = await errorDrain.result
            throw CodexClientError.inputFailed
        }

        let timeoutState = TimeoutState()
        do {
            let response = try await withThrowingTaskGroup(of: Data.self) { group in
                group.addTask {
                    try await EventDrivenPipeReader(
                        from: standardOutput.fileHandleForReading,
                        responseID: responseID,
                        timeoutState: timeoutState
                    ).read()
                }
                group.addTask {
                    try await ContinuousClock().sleep(for: timeout)
                    timeoutState.markTimedOut()
                    await Self.stop(process)
                    throw CodexClientError.timeout
                }
                guard let first = try await group.next() else {
                    throw CodexClientError.invalidResponse
                }
                group.cancelAll()
                return first
            }
            await Self.stop(process)
            _ = await errorDrain.result
            return response
        } catch {
            await Self.stop(process)
            _ = await errorDrain.result
            if let clientError = error as? CodexClientError {
                throw clientError
            }
            throw CodexClientError.invalidResponse
        }
    }

    private static func drain(_ handle: FileHandle) async throws {
        try await EventDrivenPipeReader(from: handle).drain()
    }

    private static func stop(_ process: Process) async {
        guard process.isRunning else { return }
        process.terminate()
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(1))
        while process.isRunning, clock.now < deadline {
            try? await clock.sleep(for: .milliseconds(20))
        }
        if process.isRunning {
            _ = Darwin.kill(process.processIdentifier, SIGKILL)
        }
        process.waitUntilExit()
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
