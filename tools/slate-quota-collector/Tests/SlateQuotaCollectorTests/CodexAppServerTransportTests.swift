import Darwin
import Foundation
import Testing
@testable import SlateQuotaCollector

@Suite(.serialized) struct CodexAppServerTransportTests {
    @Test func closedParentStandardDescriptorsDoNotClobberChildMappings() async throws {
        let root = try TemporaryDirectory()
        let harness = root.url.appendingPathComponent("transport-harness")
        try compileTransportHarness(output: harness)

        let closedDescriptorSets: [[Int32]] = [
            [STDIN_FILENO], [STDOUT_FILENO], [STDERR_FILENO],
            [STDIN_FILENO, STDOUT_FILENO],
            [STDIN_FILENO, STDERR_FILENO],
            [STDOUT_FILENO, STDERR_FILENO],
            [STDIN_FILENO, STDOUT_FILENO, STDERR_FILENO],
        ]
        for closedDescriptors in closedDescriptorSets {
            let descriptorList = closedDescriptors.map(String.init).joined(separator: "-")
            let fixture = root.url.appendingPathComponent("fd-\(descriptorList)")
            try FileManager.default.createDirectory(at: fixture, withIntermediateDirectories: false)
            let marker = fixture.appendingPathComponent("result.txt")
            let capturedInput = fixture.appendingPathComponent("input.txt")
            let childPID = fixture.appendingPathComponent("pid.txt")
            let executable = try makeExecutable(
                in: fixture,
                named: "fake-codex",
                script: """
                #!/bin/sh
                printf '%s\n' "$$" > '\(childPID.path)'
                : > '\(capturedInput.path)'
                count=0
                while [ "$count" -lt 3 ]; do
                    IFS= read -r line || exit 20
                    printf '%s\n' "$line" >> '\(capturedInput.path)'
                    count=$((count + 1))
                done
                printf '%s\n' 'warning' >&2 || exit 21
                printf '%s\n' '{"id":2,"result":{}}'
                while :; do sleep 1; done
                """
            )

            let outcome = try runHarness(
                harness,
                arguments: [descriptorList, executable.path, marker.path]
            )

            try #require(outcome == 0)
            #expect(try String(contentsOf: marker, encoding: .utf8) == "ok\n")
            #expect(try String(contentsOf: capturedInput, encoding: .utf8).split(separator: "\n").count == 3)
            try expectProcessWasReaped(childPID)
        }
    }

    @Test func launchFailureDoesNotLeakPipeDescriptors() async {
        let descriptors = DescriptorRecorder()
        let missingExecutable = URL(fileURLWithPath: "/private/tmp/slate-codex-does-not-exist")
        let transport = CodexAppServerProcessTransport(
            onSpawnAttempt: { descriptors.record($0) }
        )

        for _ in 0..<16 {
            await #expect(throws: CodexClientError.launchFailed) {
                try await transport.request(
                    executableURL: missingExecutable,
                    lines: Self.requestLines,
                    responseID: 2,
                    timeout: .seconds(1)
                )
            }
        }

        #expect(descriptors.allRecordedPipeIdentitiesWereReleased())
    }

    @Test func transportKeepsInputOpenUntilTargetResponseArrives() async throws {
        let closes = CloseRecorder()
        let root = try TemporaryDirectory()
        let pidFile = root.url.appendingPathComponent("pid.txt")
        let inputState = root.url.appendingPathComponent("input-state.txt")
        let executable = try makeExecutable(
            in: root.url,
            named: "stdin-sensitive-codex",
            script: """
            #!/usr/bin/python3
            import fcntl
            import os
            import sys
            import time

            with open(r"\(pidFile.path)", "w", encoding="utf-8") as output:
                output.write(f"{os.getpid()}\\n")
            received = b""
            while received.count(b"\\n") < 3:
                chunk = os.read(0, 4096)
                if not chunk:
                    sys.exit(20)
                received += chunk
            flags = fcntl.fcntl(0, fcntl.F_GETFL)
            fcntl.fcntl(0, fcntl.F_SETFL, flags | os.O_NONBLOCK)
            try:
                state = "closed" if os.read(0, 1) == b"" else "unexpected-data"
            except BlockingIOError:
                state = "open"
            with open(r"\(inputState.path)", "w", encoding="utf-8") as output:
                output.write(state + "\\n")
            if state != "open":
                sys.exit(21)
            print('{"id":2,"result":{"rateLimits":null,"rateLimitsByLimitId":{},"credits":null,"planType":null}}', flush=True)
            while True:
                time.sleep(1)
            """
        )
        let transport = CodexAppServerProcessTransport { closes.record() }

        let response = try await transport.request(
            executableURL: executable,
            lines: Self.requestLines,
            responseID: 2,
            timeout: .seconds(2)
        )

        #expect(try CodexRateLimitClient.decode(response).selectedCodexLimit == nil)
        #expect(try String(contentsOf: inputState, encoding: .utf8) == "open\n")
        let pidText = try String(contentsOf: pidFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        let pid = try #require(pid_t(pidText))
        #expect(kill(pid, 0) == -1)
        #expect(errno == ESRCH)
        #expect(closes.count == 1)
    }

    @Test func transportDrainsWarningsAndSelectsOnlyTargetResponse() async throws {
        let root = try TemporaryDirectory()
        let capturedInput = root.url.appendingPathComponent("stdin.jsonl")
        let capturedArguments = root.url.appendingPathComponent("arguments.txt")
        let pidFile = root.url.appendingPathComponent("pid.txt")
        let executable = try makeExecutable(
            in: root.url,
            named: "fake-codex",
            script: """
            #!/bin/sh
            printf '%s\n' "$$" > '\(pidFile.path)'
            printf '%s\n' "$@" > '\(capturedArguments.path)'
            : > '\(capturedInput.path)'
            count=0
            while [ "$count" -lt 3 ]; do
                IFS= read -r line || exit 20
                printf '%s\n' "$line" >> '\(capturedInput.path)'
                count=$((count + 1))
            done
            printf '%s\n' 'warning: model directory is private' >&2
            printf '%s\n' 'unrelated stdout' \
                '{"id":1,"result":{}}' \
                '{"method":"account/rateLimits/updated","params":{"private":"ignore"}}' \
                '{"id":2.5,"result":{"rateLimits":{"limitId":"codex"},"rateLimitsByLimitId":{},"credits":null,"planType":"wrong"}}' \
                '{"id":2,"result":{"rateLimits":{"limitId":"codex","primary":{"usedPercent":25,"windowDurationMins":300,"resetsAt":1900000000}},"rateLimitsByLimitId":{},"credits":null,"planType":"pro"}}'
            while :; do sleep 1; done
            """
        )
        let lines = Self.requestLines
        let transport = CodexAppServerProcessTransport()
        let startedAt = ContinuousClock.now

        let response = try await transport.request(
            executableURL: executable,
            lines: lines,
            responseID: 2,
            timeout: .seconds(5)
        )
        let elapsed = ContinuousClock.now - startedAt

        let decoded = try CodexRateLimitClient.decode(response)
        #expect(decoded.selectedCodexLimit?.primary?.usedPercent == 25)
        #expect(try String(contentsOf: capturedArguments, encoding: .utf8) == "app-server\n--stdio\n")
        #expect(try Data(contentsOf: capturedInput) == lines.reduce(into: Data(), { $0.append($1) }))
        let pidText = try String(contentsOf: pidFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        let pid = try #require(pid_t(pidText))
        let stillRunning = kill(pid, 0) == 0
        if stillRunning { _ = kill(pid, SIGKILL) }
        #expect(stillRunning == false)
        #expect(elapsed < .seconds(4))
    }

    @Test func exitedLeaderCannotLeaveAStderrHoldingDescendant() async throws {
        let root = try TemporaryDirectory()
        let descendantPIDFile = root.url.appendingPathComponent("descendant-pid.txt")
        let executable = try makeExecutable(
            in: root.url,
            named: "forking-codex",
            script: """
            #!/bin/sh
            count=0
            while [ "$count" -lt 3 ]; do
                IFS= read -r line || exit 20
                count=$((count + 1))
            done
            (trap '' TERM; sleep 5) &
            descendant=$!
            printf '%s\n' "$descendant" > '\(descendantPIDFile.path)'
            printf '%s\n' '{"id":2,"result":{"rateLimits":null,"rateLimitsByLimitId":{},"credits":null,"planType":null}}'
            exit 0
            """
        )
        let startedAt = ContinuousClock.now

        _ = try await CodexAppServerProcessTransport().request(
            executableURL: executable,
            lines: Self.requestLines,
            responseID: 2,
            timeout: .seconds(3)
        )

        #expect(ContinuousClock.now - startedAt < .seconds(3))
        try await expectProcessWasReapedEventually(descendantPIDFile)
    }

    @Test func timeoutEndsChildProcess() async throws {
        let closes = CloseRecorder()
        let root = try TemporaryDirectory()
        let pidFile = root.url.appendingPathComponent("pid.txt")
        let executable = try makeExecutable(
            in: root.url,
            named: "hanging-codex",
            script: """
            #!/bin/sh
            printf '%s\n' "$$" > '\(pidFile.path)'
            trap '' TERM
            while :; do sleep 1; done
            """
        )
        let transport = CodexAppServerProcessTransport { closes.record() }
        let startedAt = ContinuousClock.now

        await #expect(throws: CodexClientError.timeout) {
            try await transport.request(
                executableURL: executable,
                lines: Self.requestLines,
                responseID: 2,
                timeout: .seconds(3)
            )
        }

        let pidText = try String(contentsOf: pidFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        let pid = try #require(pid_t(pidText))
        #expect(kill(pid, 0) == -1)
        #expect(errno == ESRCH)
        #expect(closes.count == 1)
        #expect(ContinuousClock.now - startedAt < .seconds(8))
    }

    @Test func inputFailureClosesAndReapsChild() async throws {
        let closes = CloseRecorder()
        let fixtures = try (0..<4).map { index in
            let root = try TemporaryDirectory()
            let pidFile = root.url.appendingPathComponent("pid.txt")
            let executable = try makeExecutable(
                in: root.url,
                named: "closed-input-codex-\(index)",
                script: """
                #!/bin/sh
                printf '%s\n' "$$" > '\(pidFile.path)'
                IFS= read -r first || exit 20
                exec 0<&-
                exit 0
                """
            )
            return (executable, pidFile)
        }

        let results = await withTaskGroup(of: (URL, CodexClientError?).self) { group in
            for (executable, pidFile) in fixtures {
                group.addTask {
                    do {
                        _ = try await CodexAppServerProcessTransport { closes.record() }.request(
                            executableURL: executable,
                            lines: [Data("first\n".utf8), Data(repeating: 0x61, count: 1_048_576)],
                            responseID: 2,
                            timeout: .seconds(2)
                        )
                        return (pidFile, nil)
                    } catch let error as CodexClientError {
                        return (pidFile, error)
                    } catch {
                        return (pidFile, nil)
                    }
                }
            }
            return await group.reduce(into: []) { $0.append($1) }
        }

        for (pidFile, error) in results {
            #expect(error == .inputFailed)
            try expectProcessWasReaped(pidFile)
        }
        #expect(closes.count == fixtures.count)
    }

    @Test func invalidResponseClosesAndReapsChild() async throws {
        let closes = CloseRecorder()
        let root = try TemporaryDirectory()
        let pidFile = root.url.appendingPathComponent("pid.txt")
        let executable = try makeExecutable(
            in: root.url,
            named: "invalid-response-codex",
            script: """
            #!/bin/sh
            printf '%s\n' "$$" > '\(pidFile.path)'
            count=0
            while [ "$count" -lt 3 ]; do
                IFS= read -r line || exit 20
                count=$((count + 1))
            done
            printf '%s\n' '{"id":1,"result":{}}'
            exit 0
            """
        )
        let transport = CodexAppServerProcessTransport { closes.record() }

        await #expect(throws: CodexClientError.invalidResponse) {
            try await transport.request(
                executableURL: executable,
                lines: Self.requestLines,
                responseID: 2,
                timeout: .seconds(2)
            )
        }

        try expectProcessWasReaped(pidFile)
        #expect(closes.count == 1)
    }

    @Test func cancellationClosesAndReapsChild() async throws {
        let closes = CloseRecorder()
        let root = try TemporaryDirectory()
        let pidFile = root.url.appendingPathComponent("pid.txt")
        let readyFile = root.url.appendingPathComponent("ready.txt")
        let executable = try makeExecutable(
            in: root.url,
            named: "cancelled-codex",
            script: """
            #!/bin/sh
            printf '%s\n' "$$" > '\(pidFile.path)'
            count=0
            while [ "$count" -lt 3 ]; do
                IFS= read -r line || exit 20
                count=$((count + 1))
            done
            : > '\(readyFile.path)'
            while :; do sleep 1; done
            """
        )
        let transport = CodexAppServerProcessTransport { closes.record() }
        let request = Task {
            try await transport.request(
                executableURL: executable,
                lines: Self.requestLines,
                responseID: 2,
                timeout: .seconds(20)
            )
        }
        let becameReady = await waitForFile(readyFile, timeout: .seconds(2))
        if !becameReady {
            request.cancel()
            _ = try? await request.value
        }
        #expect(becameReady)

        request.cancel()
        await #expect(throws: CancellationError.self) {
            try await request.value
        }

        try expectProcessWasReaped(pidFile)
        #expect(closes.count == 1)
    }

    private static let requestLines = [
        Data("{\"method\":\"initialize\",\"id\":1}\n".utf8),
        Data("{\"method\":\"initialized\"}\n".utf8),
        Data("{\"method\":\"account/rateLimits/read\",\"id\":2}\n".utf8),
    ]

    private func makeExecutable(in directory: URL, named name: String, script: String) throws -> URL {
        let url = directory.appendingPathComponent(name)
        try Data(script.utf8).write(to: url, options: .withoutOverwriting)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
        return url
    }

    private func compileTransportHarness(output: URL) throws {
        let productionSource = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/SlateQuotaCollector/CodexAppServerTransport.swift")
        let harnessSource = output.appendingPathExtension("swift")
        let source = """
        import Darwin
        import Foundation

        enum CodexClientError: Error, Equatable, Sendable {
            case rpc(code: Int)
            case timeout
            case invalidResponse
            case launchFailed
            case inputFailed
        }

        @main struct TransportHarness {
            static func main() async {
                let arguments = CommandLine.arguments
                guard arguments.count == 4 else { exit(64) }
                let descriptors = arguments[1].split(separator: "-").compactMap { Int32($0) }
                guard !descriptors.isEmpty else { exit(64) }
                for descriptor in descriptors {
                    guard Darwin.close(descriptor) == 0 else { exit(67) }
                }
                do {
                    let response = try await CodexAppServerProcessTransport().request(
                        executableURL: URL(fileURLWithPath: arguments[2]),
                        lines: [
                            Data("{\\"method\\":\\"initialize\\",\\"id\\":1}\\n".utf8),
                            Data("{\\"method\\":\\"initialized\\"}\\n".utf8),
                            Data("{\\"method\\":\\"account/rateLimits/read\\",\\"id\\":2}\\n".utf8),
                        ],
                        responseID: 2,
                        timeout: .seconds(2)
                    )
                    guard String(decoding: response, as: UTF8.self).contains("\\"id\\":2") else {
                        exit(65)
                    }
                    try Data("ok\\n".utf8).write(to: URL(fileURLWithPath: arguments[3]))
                } catch {
                    try? Data("error\\n".utf8).write(to: URL(fileURLWithPath: arguments[3]))
                    exit(66)
                }
            }
        }
        """
        try source.write(to: harnessSource, atomically: true, encoding: .utf8)
        let process = Process()
        let errors = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        process.arguments = [
            "swiftc", "-parse-as-library", productionSource.path, harnessSource.path,
            "-o", output.path,
        ]
        process.standardError = errors
        try process.run()
        process.waitUntilExit()
        let errorText = String(decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        guard process.terminationStatus == 0 else {
            throw NSError(
                domain: "CodexAppServerTransportTests.compileTransportHarness",
                code: Int(process.terminationStatus),
                userInfo: [NSLocalizedDescriptionKey: errorText]
            )
        }
    }

    private func runHarness(
        _ executable: URL,
        arguments: [String]
    ) throws -> Int32 {
        var actions: posix_spawn_file_actions_t?
        guard posix_spawn_file_actions_init(&actions) == 0 else { throw HarnessError.failed }
        defer { posix_spawn_file_actions_destroy(&actions) }
        var pid: pid_t = 0
        let strings = [executable.path] + arguments
        let storage = strings.map { strdup($0) }
        defer { storage.forEach { free($0) } }
        var pointers: [UnsafeMutablePointer<CChar>?] = storage
        pointers.append(nil)
        let spawnStatus = pointers.withUnsafeMutableBufferPointer { buffer in
            posix_spawn(&pid, executable.path, &actions, nil, buffer.baseAddress!, environ)
        }
        guard spawnStatus == 0, pid > 0 else { throw HarnessError.failed }
        var status: Int32 = 0
        var waited: pid_t
        repeat { waited = waitpid(pid, &status, 0) } while waited < 0 && errno == EINTR
        guard waited == pid else { throw HarnessError.failed }
        return (status >> 8) & 0xff
    }

    private func expectProcessWasReaped(_ pidFile: URL) throws {
        let pidText = try String(contentsOf: pidFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        let pid = try #require(pid_t(pidText))
        #expect(kill(pid, 0) == -1)
        #expect(errno == ESRCH)
    }

    private func expectProcessWasReapedEventually(_ pidFile: URL) async throws {
        let pidText = try String(contentsOf: pidFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        let pid = try #require(pid_t(pidText))
        let deadline = ContinuousClock.now.advanced(by: .seconds(2))
        while kill(pid, 0) == 0, ContinuousClock.now < deadline {
            await Task.yield()
        }
        #expect(kill(pid, 0) == -1)
        #expect(errno == ESRCH)
    }

    private func waitForFile(_ url: URL, timeout: Duration) async -> Bool {
        let deadline = ContinuousClock.now.advanced(by: timeout)
        while !FileManager.default.fileExists(atPath: url.path), ContinuousClock.now < deadline {
            await Task.yield()
        }
        return FileManager.default.fileExists(atPath: url.path)
    }

}

private enum HarnessError: Error { case failed }

private final class CloseRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    var count: Int { lock.withLock { value } }
    func record() { lock.withLock { value += 1 } }
}

private final class DescriptorRecorder: @unchecked Sendable {
    private struct Identity: Equatable {
        let descriptor: Int32
        let device: dev_t
        let inode: ino_t
    }

    private let lock = NSLock()
    private var identities: [Identity] = []

    func record(_ descriptors: [Int32]) {
        lock.withLock {
            for descriptor in descriptors {
                var status = stat()
                guard fstat(descriptor, &status) == 0 else { continue }
                identities.append(.init(
                    descriptor: descriptor,
                    device: status.st_dev,
                    inode: status.st_ino
                ))
            }
        }
    }

    func allRecordedPipeIdentitiesWereReleased() -> Bool {
        lock.withLock {
            identities.allSatisfy { identity in
                var status = stat()
                guard fstat(identity.descriptor, &status) == 0 else { return errno == EBADF }
                return status.st_dev != identity.device || status.st_ino != identity.inode
            }
        }
    }
}
