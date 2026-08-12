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
                    try await Self.readTarget(
                        from: standardOutput.fileHandleForReading,
                        responseID: responseID,
                        timeoutState: timeoutState
                    )
                }
                group.addTask {
                    try await ContinuousClock().sleep(for: timeout)
                    await timeoutState.markTimedOut()
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

    private static func readTarget(
        from handle: FileHandle,
        responseID: Int,
        timeoutState: TimeoutState
    ) async throws -> Data {
        var line = Data()
        do {
            for try await byte in handle.bytes {
                if byte == 0x0A {
                    if isTarget(line, responseID: responseID) {
                        return line
                    }
                    line.removeAll(keepingCapacity: true)
                } else {
                    line.append(byte)
                }
            }
            if isTarget(line, responseID: responseID) {
                return line
            }
        } catch {
            if await timeoutState.didTimeOut {
                throw CodexClientError.timeout
            }
            throw CodexClientError.invalidResponse
        }
        if await timeoutState.didTimeOut {
            throw CodexClientError.timeout
        }
        throw CodexClientError.invalidResponse
    }

    private static func isTarget(_ data: Data, responseID: Int) -> Bool {
        guard !data.isEmpty else { return false }
        return (try? JSONDecoder().decode(TargetEnvelope.self, from: data).id) == responseID
    }

    private static func drain(_ handle: FileHandle) async throws {
        for try await _ in handle.bytes {}
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

    private struct TargetEnvelope: Decodable {
        let id: Int
    }
}

private actor TimeoutState {
    private(set) var didTimeOut = false

    func markTimedOut() {
        didTimeOut = true
    }
}
